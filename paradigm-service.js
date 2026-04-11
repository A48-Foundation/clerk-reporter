const fetch = require('node-fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.tabroom.com';
const LOGIN_URL = `${BASE_URL}/user/login/login.mhtml`;
const LOGIN_POST_URL = `${BASE_URL}/user/login/login_save.mhtml`;
const PARADIGM_SEARCH_URL = `${BASE_URL}/index/paradigm.mhtml`;
const HTTP_TIMEOUT_MS = 30 * 1000; // 30s timeout for all HTTP requests

class ParadigmService {
  constructor() {
    this.email = process.env.TABROOM_EMAIL;
    this.password = process.env.TABROOM_PASSWORD;
    this.cookies = '';
    this.loggedIn = false;
    this._loginTime = 0;
  }

  static LOGIN_TTL = 30 * 60 * 1000; // re-login after 30 minutes

  /**
   * Perform an HTTP request with cookie handling and manual redirect control.
   * Returns { status, headers, body, location }.
   */
  async _fetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      redirect: 'manual',
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        ...(options.headers || {}),
        ...(this.cookies ? { Cookie: this.cookies } : {}),
      },
    });

    // Collect Set-Cookie headers and merge into stored cookies
    const setCookies = res.headers.raw()['set-cookie'];
    if (setCookies) {
      const incoming = setCookies.map(c => c.split(';')[0]);
      const existing = this.cookies ? this.cookies.split('; ').filter(Boolean) : [];
      const map = {};
      for (const pair of existing) {
        const [key] = pair.split('=');
        map[key] = pair;
      }
      for (const pair of incoming) {
        const [key] = pair.split('=');
        map[key] = pair;
      }
      this.cookies = Object.values(map).join('; ');
    }

    const body = await res.text();
    const location = res.headers.get('location') || null;
    return { status: res.status, headers: res.headers, body, location };
  }

  /**
   * Follow redirects manually, accumulating cookies along the way.
   * Returns the final { status, body, finalUrl }.
   */
  async _fetchFollowRedirects(url, options = {}, maxRedirects = 10) {
    let currentUrl = url;
    for (let i = 0; i < maxRedirects; i++) {
      const res = await this._fetch(currentUrl, options);
      if (res.status >= 300 && res.status < 400 && res.location) {
        currentUrl = res.location.startsWith('http')
          ? res.location
          : new URL(res.location, currentUrl).toString();
        // After a redirect, switch to GET with no body
        options = {};
        continue;
      }
      return { status: res.status, body: res.body, finalUrl: currentUrl };
    }
    throw new Error('Too many redirects');
  }

  /**
   * Authenticate with Tabroom and store session cookies.
   */
  async login() {
    if (!this.email || !this.password) {
      throw new Error('TABROOM_EMAIL and TABROOM_PASSWORD must be set in environment');
    }

    // GET the login page to extract hidden salt/sha fields
    const loginPage = await this._fetchFollowRedirects(LOGIN_URL);
    const $ = cheerio.load(loginPage.body);

    const form = $('form[name="login"]').length ? $('form[name="login"]') : $('form').first();
    const salt = form.find('input[name="salt"]').val() || '';
    const sha = form.find('input[name="sha"]').val() || '';

    // POST login credentials
    const params = new URLSearchParams();
    params.append('username', this.email);
    params.append('password', this.password);
    if (salt) params.append('salt', salt);
    if (sha) params.append('sha', sha);

    const loginRes = await this._fetchFollowRedirects(LOGIN_POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    // A successful login typically redirects to the user home page
    if (loginRes.body.includes('Sign Out') || loginRes.body.includes('Logout') ||
        loginRes.body.includes('/user/home')) {
      this.loggedIn = true;
      this._loginTime = Date.now();
      console.log('[ParadigmService] Tabroom login successful');
      return true;
    }

    throw new Error('Tabroom login failed — check credentials');
  }

  /**
   * Fetch any Tabroom page using the ParadigmService's authenticated session.
   * Ensures login, follows redirects, returns HTML body.
   */
  async fetchPage(url) {
    const sessionExpired = this.loggedIn && (Date.now() - this._loginTime > ParadigmService.LOGIN_TTL);
    if (!this.loggedIn || sessionExpired) {
      this.loggedIn = false;
      await this.login();
    }
    const res = await this._fetchFollowRedirects(url);
    return res.body;
  }

  /**
   * Search Tabroom paradigms by first/last name.
   * Returns an array of { name, judgePersonId, paradigmUrl }.
   */
  async searchJudge(firstName, lastName) {
    // Ensure we're authenticated (Tabroom requires login for paradigm search)
    const sessionExpired = this.loggedIn && (Date.now() - this._loginTime > ParadigmService.LOGIN_TTL);
    if (!this.loggedIn || sessionExpired) {
      if (sessionExpired) console.log('[ParadigmService] Session expired — re-authenticating');
      this.loggedIn = false;
      try { await this.login(); } catch (e) { console.warn('[ParadigmService] Login failed:', e.message); }
    }

    const url = `${PARADIGM_SEARCH_URL}?search_first=${encodeURIComponent(firstName)}&search_last=${encodeURIComponent(lastName)}`;

    const result = await this._searchJudgeRequest(url);

    // If we got the login page back, force re-login and retry once
    if (result._gotLoginPage && this.loggedIn) {
      console.log(`[ParadigmService] Session stale for ${firstName} ${lastName} — forcing re-login`);
      this.loggedIn = false;
      try { await this.login(); } catch (e) { console.warn('[ParadigmService] Re-login failed:', e.message); return []; }
      return (await this._searchJudgeRequest(url)).results;
    }

    return result.results;
  }

  /**
   * Internal: perform the paradigm search request and parse results.
   * Returns { results: [...], _gotLoginPage: boolean }
   */
  async _searchJudgeRequest(url) {
    // Don't follow redirects automatically — a single result redirects to the paradigm page
    const initial = await this._fetch(url);

    // Detect login page — Tabroom returns 200 with "Please login to view paradigms"
    if (initial.body && /Please login to view paradigms/i.test(initial.body)) {
      return { results: [], _gotLoginPage: true };
    }

    // Single-result redirect: Tabroom sends a 302 to the paradigm page
    if (initial.status >= 300 && initial.status < 400 && initial.location) {
      const redirectUrl = initial.location.startsWith('http')
        ? initial.location
        : new URL(initial.location, url).toString();

      // Check if redirect is to login page
      if (/login/i.test(redirectUrl)) {
        return { results: [], _gotLoginPage: true };
      }

      const parsed = new URL(redirectUrl);
      const judgePersonId = parsed.searchParams.get('judge_person_id');

      // Fetch the paradigm page to get the name
      const pageRes = await this._fetchFollowRedirects(redirectUrl);
      const info = this._parseParadigmPage(pageRes.body);

      return { results: [{
        name: info.name || 'Unknown',
        judgePersonId: judgePersonId || null,
        paradigmUrl: redirectUrl,
      }], _gotLoginPage: false };
    }

    // Multi-result page: parse the list of judge links
    const body = initial.status >= 300 ? (await this._fetchFollowRedirects(url)).body : initial.body;
    const $ = cheerio.load(body);
    const results = [];

    $('a[href*="judge_person_id"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const name = $(el).text().trim();
      if (!name) return;

      const fullHref = href.startsWith('http')
        ? href
        : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`.replace(/&amp;/g, '&');

      let judgePersonId = null;
      try {
        const parsed = new URL(fullHref);
        judgePersonId = parsed.searchParams.get('judge_person_id');
      } catch (_) {
        const match = href.match(/judge_person_id=(\d+)/);
        if (match) judgePersonId = match[1];
      }

      if (judgePersonId) {
        results.push({
          name,
          judgePersonId,
          paradigmUrl: `${PARADIGM_SEARCH_URL}?judge_person_id=${judgePersonId}`,
        });
      }
    });

    return { results, _gotLoginPage: false };
  }

  /**
   * Fetch the full paradigm for a given judge_person_id.
   * Returns { name, school, philosophy, paradigmUrl }.
   */
  async fetchParadigm(judgePersonId) {
    const url = `${PARADIGM_SEARCH_URL}?judge_person_id=${judgePersonId}`;
    const res = await this._fetchFollowRedirects(url);
    const info = this._parseParadigmPage(res.body);
    return { ...info, paradigmUrl: url };
  }

  /**
   * Convenience method: search by a full name string.
   * Accepts "Last, First" or "First Last" formats.
   * Returns the first matching paradigm or null.
   */
  async fetchParadigmByName(fullName) {
    let firstName, lastName;

    if (fullName.includes(',')) {
      const parts = fullName.split(',').map(s => s.trim());
      lastName = parts[0];
      firstName = parts[1] || '';
    } else {
      const parts = fullName.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    const results = await this.searchJudge(firstName, lastName);
    if (results.length === 0) return null;

    // If we already have a judgePersonId, fetch the full paradigm
    if (results[0].judgePersonId) {
      return this.fetchParadigm(results[0].judgePersonId);
    }

    return {
      name: results[0].name,
      school: null,
      philosophy: null,
      paradigmUrl: results[0].paradigmUrl,
    };
  }

  /**
   * Parse a Tabroom paradigm page and extract judge info.
   * Returns { name, school, philosophy }.
   */
  _parseParadigmPage(html) {
    const $ = cheerio.load(html);

    // Name: first non-empty h2–h5 heading on the page
    let name = null;
    for (const tag of ['h2', 'h3', 'h4', 'h5']) {
      const text = $(tag).first().text().trim();
      if (text) {
        name = text;
        break;
      }
    }

    // School / affiliation: element whose class contains affil, school, or institution
    let school = null;
    const affilSelectors = [
      '[class*="affil"]',
      '[class*="school"]',
      '[class*="institution"]',
    ];
    for (const sel of affilSelectors) {
      const text = $(sel).first().text().trim();
      if (text) {
        school = text;
        break;
      }
    }

    // Philosophy text: element whose class contains paradigm, philosophy, or ltborderbottom
    let philosophy = null;
    const philoSelectors = [
      '[class*="paradigm"]',
      '[class*="philosophy"]',
      '[class*="ltborderbottom"]',
    ];
    for (const sel of philoSelectors) {
      const el = $(sel).first();
      if (el.length) {
        // Collect all text, preserving paragraph breaks
        const parts = [];
        el.find('p, div, br').each((_, child) => {
          const t = $(child).text().trim();
          if (t) parts.push(t);
        });
        philosophy = parts.length > 0 ? parts.join('\n\n') : el.text().trim();
        if (philosophy) break;
      }
    }

    return { name, school, philosophy };
  }
}

module.exports = ParadigmService;
