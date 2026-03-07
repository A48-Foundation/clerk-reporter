const https = require('https');
const cheerio = require('cheerio');

class TabroomScraper {
  /**
   * Fetch HTML from a URL.
   */
  static fetch(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return TabroomScraper.fetch(res.headers.location).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Parse a Tabroom pairings round URL and extract tourn_id and round_id.
   * Accepts URLs like:
   *   https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=36452&round_id=1503711
   */
  static parseRoundUrl(url) {
    const parsed = new URL(url);
    return {
      tournId: parsed.searchParams.get('tourn_id'),
      roundId: parsed.searchParams.get('round_id'),
    };
  }

  /**
   * Extract the tournament postings index URL from a round URL.
   */
  static getPostingsIndexUrl(tournId) {
    return `https://www.tabroom.com/index/tourn/postings/index.mhtml?tourn_id=${tournId}`;
  }

  /**
   * Get all available round links for a tournament's event.
   * Returns array of { roundId, label, url }
   */
  static async getRounds(tournId) {
    const indexUrl = this.getPostingsIndexUrl(tournId);
    const html = await this.fetch(indexUrl);
    const $ = cheerio.load(html);
    const rounds = [];

    $('a[href*="round.mhtml"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http')
        ? href
        : `https://www.tabroom.com${href.startsWith('/') ? '' : '/'}${href}`;

      try {
        const parsed = new URL(fullUrl.replace(/&amp;/g, '&'));
        const roundId = parsed.searchParams.get('round_id');
        const label = $(el).text().trim();
        if (roundId) {
          rounds.push({ roundId, label, url: parsed.toString() });
        }
      } catch (_) { /* skip malformed URLs */ }
    });

    return rounds;
  }

  /**
   * Scrape pairings from a specific round page.
   * Returns array of pairing objects:
   *   { room, aff, neg, judges: [{ name, judgeId }] }
   */
  static async scrapePairings(tournId, roundId) {
    const url = `https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=${tournId}&round_id=${roundId}`;
    const html = await this.fetch(url);
    const $ = cheerio.load(html);

    const pairings = [];

    // Find the main pairings table — it has header row with Room/Aff/Neg/Judging
    const rows = $('tr.smallish');

    rows.each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      // Room (first cell)
      const room = $(cells[0]).text().trim() || 'TBD';

      // Aff (second cell)
      const aff = $(cells[1]).find('a').first().text().trim() ||
                  $(cells[1]).text().trim();

      // Neg (third cell)
      const neg = $(cells[2]).find('a').first().text().trim() ||
                  $(cells[2]).text().trim();

      // Judges (fourth+ cells with judge links)
      const judges = [];
      // Judge links have href containing "judge.mhtml" or "judge_id"
      $(row).find('a[href*="judge"]').each((_, judgeEl) => {
        const judgeName = $(judgeEl).text().trim();
        const judgeHref = $(judgeEl).attr('href') || '';
        const judgeIdMatch = judgeHref.match(/judge_id=(\d+)/);
        if (judgeName) {
          judges.push({
            name: judgeName,
            judgeId: judgeIdMatch ? judgeIdMatch[1] : null,
          });
        }
      });

      if (aff || neg) {
        pairings.push({ room, aff, neg, judges });
      }
    });

    return pairings;
  }

  /**
   * Find pairings for a specific team entry code (e.g. "Okemos AT").
   * Returns the pairing object if found, null otherwise.
   */
  static findTeamPairing(pairings, teamCode) {
    const code = teamCode.toLowerCase().trim();
    return pairings.find(p =>
      p.aff.toLowerCase().includes(code) ||
      p.neg.toLowerCase().includes(code)
    ) || null;
  }

  /**
   * Get the round title/label from the page.
   */
  static async getRoundTitle(tournId, roundId) {
    const url = `https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=${tournId}&round_id=${roundId}`;
    const html = await this.fetch(url);
    const $ = cheerio.load(html);
    // The round title is in an h4 tag
    return $('h4').first().text().trim() || `Round ${roundId}`;
  }
}

module.exports = TabroomScraper;
