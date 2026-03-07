const { Client } = require('@notionhq/client');
const Fuse = require('fuse.js');

const CACHE_TTL_MS = 10 * 60 * 1000; // Refresh cache every 10 minutes

class NotionService {
  constructor() {
    this.notion = new Client({ auth: process.env.NOTION_TOKEN });
    this.judgeDatabaseId = process.env.JUDGE_DATABASE_ID;

    // Cache: array of { id, name } for all judges
    this.judgeCache = [];
    this.cacheTimestamp = 0;
    this.fuse = null;
  }

  /**
   * Load all judge pages from Notion (handles pagination).
   * Builds a Fuse.js index for fuzzy searching.
   */
  async refreshCache() {
    const now = Date.now();
    if (this.judgeCache.length > 0 && now - this.cacheTimestamp < CACHE_TTL_MS) {
      return; // Cache is still fresh
    }

    console.log('🔄 Refreshing judge cache from Notion...');
    const allPages = [];
    let cursor = undefined;

    do {
      const response = await this.notion.databases.query({
        database_id: this.judgeDatabaseId,
        page_size: 100,
        start_cursor: cursor,
      });
      allPages.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    this.judgeCache = allPages.map(page => ({
      id: page.id,
      name: page.properties['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown',
      page, // keep the full page for later data extraction
    }));

    this.fuse = new Fuse(this.judgeCache, {
      keys: ['name'],
      threshold: 0.4,      // 0 = exact, 1 = match anything; 0.4 is a good balance
      distance: 100,
      includeScore: true,
    });

    this.cacheTimestamp = now;
    console.log(`✅ Cached ${this.judgeCache.length} judges`);
  }

  /**
   * Search for judges by name with fuzzy matching.
   * Handles "Last, First" format by flipping to "First Last".
   * Returns an array of judge objects.
   */
  async searchJudge(name) {
    await this.refreshCache();

    // If input is "Last, First" format, flip to "First Last"
    const normalizedName = name.includes(',')
      ? name.split(',').map(s => s.trim()).reverse().join(' ')
      : name;

    // Fuzzy search against the cache — return only the best match
    let results = this.fuse.search(normalizedName, { limit: 1 });

    // If no fuzzy results and we flipped the name, try original input too
    if (results.length === 0 && normalizedName !== name) {
      results = this.fuse.search(name, { limit: 1 });
    }

    if (results.length === 0) return [];

    const judge = await this.extractJudgeData(results[0].item.page);
    return [judge];
  }

  /**
   * Extract all relevant data from a judge page.
   */
  async extractJudgeData(page) {
    const props = page.properties;

    // Name
    const name = props['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown';

    // Win% (rollup → number, stored as decimal e.g. 0.75 = 75%)
    const winRateRaw = props['Win%']?.rollup?.number;
    const winRate = winRateRaw != null ? `${Math.round(winRateRaw * 100)}%` : 'N/A';

    // Email
    const email = props['Email']?.email || 'N/A';

    // Tags
    const tags = props['Tags']?.multi_select?.map(t => t.name) || [];

    // Tabroom URL
    const tabroom = props['Tabroom']?.url || null;

    // Prefs
    const prefs = props['Prefs']?.number != null ? props['Prefs'].number : 'N/A';

    // Page comments (notes on the judge)
    const comments = await this.getPageComments(page.id);

    // Notion page URL
    const url = page.url;

    return { name, winRate, email, tags, tabroom, prefs, comments, url };
  }

  /**
   * Fetch all comments on a Notion page.
   */
  async getPageComments(pageId) {
    try {
      const response = await this.notion.comments.list({ block_id: pageId });
      return response.results.map(c =>
        c.rich_text.map(t => t.plain_text).join('')
      ).filter(text => text.length > 0);
    } catch (err) {
      console.error(`Failed to fetch comments for page ${pageId}:`, err.message);
      return [];
    }
  }
}

module.exports = NotionService;
