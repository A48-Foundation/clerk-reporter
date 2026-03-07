const fetch = require('node-fetch');
const Fuse = require('fuse.js');

const BASE_URL = 'https://api.opencaselist.com/v1';
const DEFAULT_CASELIST = 'hspolicy25';

class CaselistService {
  constructor() {
    this.email = process.env.TABROOM_EMAIL;
    this.password = process.env.TABROOM_PASSWORD;
    this.cookie = null;
  }

  /**
   * Authenticate with the OpenCaselist API and store the session cookie.
   */
  async login() {
    try {
      const res = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.email, password: this.password }),
        redirect: 'manual',
      });

      const setCookie = res.headers.raw()['set-cookie'];
      if (setCookie) {
        const match = setCookie
          .map(c => c.match(/caselist_token=([^;]+)/))
          .find(Boolean);
        if (match) {
          this.cookie = `caselist_token=${match[1]}`;
        }
      }

      if (!this.cookie) {
        console.warn('[CaselistService] Login did not return a caselist_token cookie');
      }
    } catch (err) {
      console.warn('[CaselistService] Login failed:', err.message);
    }
  }

  /**
   * Internal helper — makes an authenticated GET request.
   */
  async _get(path) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;

    const res = await fetch(`${BASE_URL}${path}`, { headers });
    if (!res.ok) {
      throw new Error(`GET ${path} returned ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fuzzy-search the schools list for the best match to `schoolName`.
   * Returns the school slug (URL-encoded `name` field) or null.
   */
  async findSchool(caselistSlug, schoolName) {
    try {
      const schools = await this._get(`/caselists/${caselistSlug}/schools`);
      if (!Array.isArray(schools) || schools.length === 0) return null;

      // Try exact case-insensitive match on displayName first
      const exact = schools.find(
        s => s.displayName && s.displayName.toLowerCase() === schoolName.toLowerCase(),
      );
      if (exact) return exact.name;

      // Fall back to fuzzy matching
      const fuse = new Fuse(schools, {
        keys: ['displayName', 'name'],
        threshold: 0.4,
      });
      const results = fuse.search(schoolName);
      if (results.length > 0) return results[0].item.name;

      return null;
    } catch (err) {
      console.warn('[CaselistService] findSchool failed:', err.message);
      return null;
    }
  }

  /**
   * Find a team whose name ends with the given suffix code (e.g. "AW").
   * Returns the team slug or null.
   */
  async findTeam(caselistSlug, schoolSlug, teamCode) {
    try {
      const teams = await this._get(
        `/caselists/${caselistSlug}/schools/${encodeURIComponent(schoolSlug)}/teams`,
      );
      if (!Array.isArray(teams) || teams.length === 0) return null;

      const suffix = teamCode.toUpperCase();
      const match = teams.find(t => {
        const name = (t.display_name || t.name || '').toUpperCase();
        return name.endsWith(` ${suffix}`) || name === suffix;
      });

      return match ? match.name : null;
    } catch (err) {
      console.warn('[CaselistService] findTeam failed:', err.message);
      return null;
    }
  }

  /**
   * Fetch rounds for a team filtered by side ('A' for Aff, 'N' for Neg).
   */
  async getTeamRounds(caselistSlug, schoolSlug, teamSlug, side) {
    try {
      const rounds = await this._get(
        `/caselists/${caselistSlug}/schools/${encodeURIComponent(schoolSlug)}/teams/${encodeURIComponent(teamSlug)}/rounds?side=${side}`,
      );
      return Array.isArray(rounds) ? rounds : [];
    } catch (err) {
      console.warn('[CaselistService] getTeamRounds failed:', err.message);
      return [];
    }
  }

  /**
   * Build the public OpenCaselist wiki URL for a team.
   */
  getWikiUrl(caselistSlug, schoolSlug, teamSlug) {
    return `https://opencaselist.com/${encodeURIComponent(caselistSlug)}/${encodeURIComponent(schoolSlug)}/${encodeURIComponent(teamSlug)}`;
  }

  /**
   * Main entry point — parse a Tabroom-style team code (e.g. "Isidore Newman AW"),
   * resolve it on the caselist, and return round data for the OPPOSITE side so the
   * user can see what arguments that opponent has run.
   *
   * @param {string} teamCode  Full team identifier from Tabroom (e.g. "Isidore Newman AW")
   * @param {string} side      The side the opponent is on: 'A' (Aff) or 'N' (Neg).
   *                           We fetch rounds for THIS side (the opponent's rounds on that side).
   * @param {string} [caselistSlug]  Caselist to search. Defaults to hspolicy25.
   * @returns {{ schoolName, teamCode, caselistUrl, rounds } | null}
   */
  async lookupOpponent(teamCode, side, caselistSlug = DEFAULT_CASELIST) {
    try {
      // Parse: everything except the last token is the school name
      const parts = teamCode.trim().split(/\s+/);
      if (parts.length < 2) {
        console.warn('[CaselistService] Team code must contain school name + team suffix');
        return null;
      }
      const teamSuffix = parts.pop();
      const schoolName = parts.join(' ');

      // Ensure we're logged in
      if (!this.cookie) await this.login();

      const schoolSlug = await this.findSchool(caselistSlug, schoolName);
      if (!schoolSlug) {
        console.warn(`[CaselistService] Could not find school "${schoolName}" on ${caselistSlug}`);
        return null;
      }

      const teamSlug = await this.findTeam(caselistSlug, schoolSlug, teamSuffix);
      if (!teamSlug) {
        console.warn(`[CaselistService] Could not find team "${teamSuffix}" under "${schoolSlug}"`);
        return null;
      }

      const rounds = await this.getTeamRounds(caselistSlug, schoolSlug, teamSlug, side);
      const caselistUrl = this.getWikiUrl(caselistSlug, schoolSlug, teamSlug);

      return {
        schoolName,
        teamCode: teamSuffix,
        caselistUrl,
        rounds,
      };
    } catch (err) {
      console.warn('[CaselistService] lookupOpponent failed:', err.message);
      return null;
    }
  }
}

module.exports = CaselistService;
