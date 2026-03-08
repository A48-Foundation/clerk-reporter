const https = require('https');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.tabroom.com';

class TabroomScraper {
  // Shared authenticated cookies (set via login())
  static _cookies = '';
  static _loggedIn = false;

  /**
   * Authenticate with Tabroom. Required for entries pages.
   */
  static async login() {
    if (this._loggedIn) return;

    const email = process.env.TABROOM_EMAIL;
    const password = process.env.TABROOM_PASSWORD;
    if (!email || !password) throw new Error('TABROOM_EMAIL and TABROOM_PASSWORD required');

    // GET login page for hidden fields
    const loginPage = await fetch(`${BASE_URL}/user/login/login.mhtml`, { redirect: 'manual' });
    this._mergeCookies(loginPage);

    const html = await loginPage.text();
    const $ = cheerio.load(html);
    const salt = $('input[name=salt]').val() || '';
    const sha = $('input[name=sha]').val() || '';

    const params = new URLSearchParams();
    params.append('username', email);
    params.append('password', password);
    if (salt) params.append('salt', salt);
    if (sha) params.append('sha', sha);

    const loginRes = await fetch(`${BASE_URL}/user/login/login_save.mhtml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: this._cookies },
      body: params.toString(),
      redirect: 'manual',
    });
    this._mergeCookies(loginRes);

    // Follow redirect
    const loc = loginRes.headers.get('location');
    if (loc) {
      const redir = loc.startsWith('http') ? loc : `${BASE_URL}${loc}`;
      const r = await fetch(redir, { headers: { Cookie: this._cookies }, redirect: 'manual' });
      this._mergeCookies(r);
    }

    this._loggedIn = true;
  }

  static _mergeCookies(res) {
    const incoming = (res.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]);
    const map = {};
    for (const c of this._cookies.split('; ').filter(Boolean)) { const [k] = c.split('='); map[k] = c; }
    for (const c of incoming) { const [k] = c.split('='); map[k] = c; }
    this._cookies = Object.values(map).join('; ');
  }

  /**
   * Authenticated GET — uses stored cookies from login().
   */
  static async authenticatedFetch(url) {
    if (!this._loggedIn) await this.login();
    const res = await fetch(url, { headers: { Cookie: this._cookies }, redirect: 'follow' });
    this._mergeCookies(res);
    return res.text();
  }

  /**
   * Fetch HTML from a URL (unauthenticated — for public pages).
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

  // ─── URL parsing ───────────────────────────────────────────────

  /**
   * Parse a Tabroom URL and extract tourn_id, event_id, round_id.
   * Works with entries, pairings, and fields URLs.
   */
  static parseUrl(url) {
    const parsed = new URL(url);
    return {
      tournId: parsed.searchParams.get('tourn_id'),
      eventId: parsed.searchParams.get('event_id'),
      roundId: parsed.searchParams.get('round_id'),
    };
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

  // ─── Entries scraping ──────────────────────────────────────────

  /**
   * Scrape tournament entries from a Tabroom fields/entries page.
   * Requires authentication.
   *
   * If eventId is provided, scrapes that specific event.
   * If only tournId, scrapes the fields index to find events, then lets the caller pick.
   *
   * @param {string} tournId
   * @param {string} [eventId]
   * @returns {{ tournamentName: string, events: Array, entries: Array<{school, location, entry, code}> }}
   */
  static async scrapeEntries(tournId, eventId) {
    if (!eventId) {
      // Scrape the fields index to get available events
      const html = await this.authenticatedFetch(
        `${BASE_URL}/index/tourn/fields/entry.mhtml?tourn_id=${tournId}`
      );
      const $ = cheerio.load(html);
      const tournamentName = $('h2').first().text().trim() || `Tournament ${tournId}`;

      const events = [];
      $('a[href*="event_id"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        try {
          const full = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          const parsed = new URL(full.replace(/&amp;/g, '&'));
          const evId = parsed.searchParams.get('event_id');
          if (evId && text) events.push({ eventId: evId, name: text, url: parsed.toString() });
        } catch (_) {}
      });

      return { tournamentName, events, entries: [] };
    }

    // Scrape specific event entries
    const html = await this.authenticatedFetch(
      `${BASE_URL}/index/tourn/fields.mhtml?tourn_id=${tournId}&event_id=${eventId}`
    );
    const $ = cheerio.load(html);
    const tournamentName = $('h2').first().text().trim() || `Tournament ${tournId}`;

    const entries = [];
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      const school = $(cells[0]).text().trim();
      const location = $(cells[1]).text().trim();
      const entry = $(cells[2]).text().trim();
      const code = $(cells[3]).text().trim();

      if (school && code && code !== 'Code') {
        entries.push({ school, location, entry, code });
      }
    });

    return { tournamentName, events: [], entries };
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
