const fetch = require('node-fetch');
const Fuse = require('fuse.js');

const BASE_URL = 'https://api.opencaselist.com/v1';
const DEFAULT_CASELIST = process.env.CASELIST_SLUG || 'hspolicy25';

class CaselistService {
  constructor() {
    this.email = process.env.TABROOM_EMAIL;
    this.password = process.env.TABROOM_PASSWORD;
    this.cookie = null;
    // Cache: { [caselistSlug]: { schools: [...], teamsBySchool: { [slug]: [...] } } }
    this._cache = {};
  }

  async login() {
    try {
      const res = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.email, password: this.password }),
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

  async _get(path) {
    if (!this.cookie) await this.login();
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
   * Returns the school slug or null.
   */
  async findSchool(caselistSlug, schoolName) {
    try {
      if (!this._cache[caselistSlug]) this._cache[caselistSlug] = {};
      if (!this._cache[caselistSlug].schools) {
        this._cache[caselistSlug].schools = await this._get(`/caselists/${caselistSlug}/schools`);
      }
      const schools = this._cache[caselistSlug].schools;
      if (!Array.isArray(schools) || schools.length === 0) return null;

      const exact = schools.find(
        s => s.displayName && s.displayName.toLowerCase() === schoolName.toLowerCase(),
      );
      if (exact) return exact.name;

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
   * Get all teams for a school (cached).
   */
  async _getTeams(caselistSlug, schoolSlug) {
    if (!this._cache[caselistSlug]) this._cache[caselistSlug] = {};
    if (!this._cache[caselistSlug].teamsBySchool) this._cache[caselistSlug].teamsBySchool = {};
    if (!this._cache[caselistSlug].teamsBySchool[schoolSlug]) {
      this._cache[caselistSlug].teamsBySchool[schoolSlug] = await this._get(
        `/caselists/${caselistSlug}/schools/${encodeURIComponent(schoolSlug)}/teams`,
      );
    }
    return this._cache[caselistSlug].teamsBySchool[schoolSlug] || [];
  }

  /**
   * Find a team on the caselist by matching debater last names from Tabroom entry.
   *
   * The Tabroom entry field has names like "Levine & Zhang" or "Chen & Olteanu".
   * The caselist team slug is first 2 letters of each last name, e.g. "LeZh".
   * We match by comparing debater last names from both sources.
   *
   * @param {string} caselistSlug
   * @param {string} schoolSlug
   * @param {string} entryNames  Tabroom entry field, e.g. "Levine & Zhang"
   * @param {string} teamSuffix  Tabroom team code suffix, e.g. "LZ" (fallback)
   * @returns {object|null} The matching team object from the API
   */
  async findTeamByEntry(caselistSlug, schoolSlug, entryNames, teamSuffix) {
    try {
      const teams = await this._getTeams(caselistSlug, schoolSlug);
      if (!Array.isArray(teams) || teams.length === 0) return null;

      // Parse last names from Tabroom entry field
      // Formats: "Levine & Zhang", "Chen & Olteanu", "Doe and Smith"
      const entryLastNames = this._parseEntryNames(entryNames);

      if (entryLastNames.length > 0) {
        // Strategy 1: match by debater last names
        const match = teams.find(t => {
          const caselistNames = [t.debater1_last, t.debater2_last]
            .filter(Boolean)
            .map(n => n.toLowerCase());
          return entryLastNames.every(name =>
            caselistNames.some(cn => cn === name || cn.startsWith(name) || name.startsWith(cn))
          );
        });
        if (match) return match;

        // Strategy 2: match by caselist team slug derived from last names
        // e.g. "Levine" + "Zhang" → slug starts with "Le" and contains "Zh"
        if (entryLastNames.length >= 2) {
          const prefix1 = entryLastNames[0].slice(0, 2);
          const prefix2 = entryLastNames[1].slice(0, 2);
          const derivedSlug = (prefix1.charAt(0).toUpperCase() + prefix1.charAt(1) +
                               prefix2.charAt(0).toUpperCase() + prefix2.charAt(1)).toLowerCase();
          const slugMatch = teams.find(t =>
            t.name && t.name.toLowerCase() === derivedSlug
          );
          if (slugMatch) return slugMatch;
        }
      }

      // Strategy 3: fallback — match by Tabroom suffix (e.g. "LZ")
      if (teamSuffix) {
        const suffix = teamSuffix.toUpperCase();
        const suffixMatch = teams.find(t => {
          const name = (t.display_name || t.name || '').toUpperCase();
          return name.endsWith(` ${suffix}`) || name === suffix;
        });
        if (suffixMatch) return suffixMatch;

        // Also try matching initials: LZ → debater1_last starts with L, debater2_last starts with Z
        if (suffix.length >= 2) {
          const initial1 = suffix[0].toLowerCase();
          const initial2 = suffix[suffix.length - 1].toLowerCase();
          const initialMatch = teams.find(t => {
            const l1 = (t.debater1_last || '')[0]?.toLowerCase();
            const l2 = (t.debater2_last || '')[0]?.toLowerCase();
            return (l1 === initial1 && l2 === initial2) ||
                   (l1 === initial2 && l2 === initial1);
          });
          if (initialMatch) return initialMatch;
        }
      }

      return null;
    } catch (err) {
      console.warn('[CaselistService] findTeamByEntry failed:', err.message);
      return null;
    }
  }

  /**
   * Parse last names from a Tabroom entry field.
   * "Levine & Zhang" → ["levine", "zhang"]
   * "Chen & Olteanu" → ["chen", "olteanu"]
   */
  _parseEntryNames(entryField) {
    if (!entryField) return [];
    return entryField
      .split(/\s*[&,]\s*|\s+and\s+/i)
      .map(n => n.trim().toLowerCase())
      .filter(Boolean);
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
   * Build the public OpenCaselist wiki URL for a team, optionally with side.
   */
  getWikiUrl(caselistSlug, schoolSlug, teamSlug, side) {
    let url = `https://opencaselist.com/${caselistSlug}/${schoolSlug}/${teamSlug}`;
    if (side === 'A') url += '/Aff';
    else if (side === 'N') url += '/Neg';
    return url;
  }

  /**
   * Build a download URL for an open source document.
   * @param {string} opensourcePath - e.g. "hspolicy25/NorthHollywood/LeZh/NorthHollywood-LeZh-Aff-...-Round-1.docx"
   * @returns {string}
   */
  getDownloadUrl(opensourcePath) {
    return `https://api.opencaselist.com/v1/download?path=${encodeURIComponent(opensourcePath)}`;
  }

  /**
   * Find the most recent aff round with an open source document.
   * @param {Array} rounds - aff rounds from getTeamRounds
   * @returns {{ round, tournament, report, opensource, downloadUrl } | null}
   */
  getLatestAffDoc(rounds) {
    const withDocs = rounds.filter(r => r.opensource);
    if (withDocs.length === 0) return null;
    const latest = withDocs[withDocs.length - 1];
    return {
      round: latest.round,
      tournament: latest.tournament,
      report: latest.report,
      opensource: latest.opensource,
      downloadUrl: this.getDownloadUrl(latest.opensource),
    };
  }

  /**
   * Find the most recent neg round where the 1AC matches a given aff name.
   * Uses fuzzy matching on the report text.
   *
   * @param {Array} rounds - neg rounds from getTeamRounds
   * @param {string} affName - e.g. "PNT", "Science Diplomacy", "sci dip"
   * @returns {{ round, tournament, report, strategy, opensource, downloadUrl } | null}
   */
  getNegVsAff(rounds, affName) {
    if (!affName || rounds.length === 0) return null;

    const affLower = affName.toLowerCase();
    // Build fuzzy variants: "science diplomacy" → also match "sci dip"
    const affWords = affLower.split(/\s+/);
    const affAbbrev = affWords.map(w => w.slice(0, 3)).join(' ');

    const matches = rounds.filter(r => {
      if (!r.report) return false;
      const report = r.report.toLowerCase();
      // Direct match
      if (report.includes(affLower)) return true;
      // Abbreviation match (e.g. "pnt" matches "pnt")
      if (report.includes(affAbbrev)) return true;
      // Check if 1ac field mentions it
      const acMatch = report.match(/1ac\s+(?:was\s+)?(.+?)(?:\s*[;,]|$)/i);
      if (acMatch) {
        const acText = acMatch[1].toLowerCase().trim();
        if (acText.includes(affLower) || affLower.includes(acText)) return true;
        if (acText.includes(affAbbrev) || affAbbrev.includes(acText)) return true;
      }
      // "They ran X" pattern
      const ranMatch = report.match(/(?:they\s+)?ran\s+(.+?)(?:\s*[;,]|$)/i);
      if (ranMatch) {
        const ranText = ranMatch[1].toLowerCase().trim();
        if (ranText.includes(affLower) || affLower.includes(ranText)) return true;
      }
      return false;
    });

    if (matches.length === 0) return null;

    const latest = matches[matches.length - 1];
    // Extract the 2NR strategy
    const stratMatch = latest.report.match(/2nr\s+(?:was\s+)?(.+?)(?:\s*[;,.]|$)/i);
    const strategy = stratMatch ? stratMatch[1].trim() : null;

    return {
      round: latest.round,
      tournament: latest.tournament,
      report: latest.report,
      strategy,
      opensource: latest.opensource || null,
      downloadUrl: latest.opensource ? this.getDownloadUrl(latest.opensource) : null,
    };
  }

  /**
   * Main entry point — resolve an opponent's caselist data.
   *
   * Uses the Tabroom entry names (e.g. "Levine & Zhang") to find the correct
   * caselist team, since Tabroom codes (e.g. "LZ") don't match caselist slugs
   * (e.g. "LeZh") directly.
   *
   * @param {string} teamCode       Full Tabroom team code (e.g. "North Hollywood LZ")
   * @param {string} side           Opponent's side: 'A' (Aff) or 'N' (Neg)
   * @param {string} [entryNames]   Tabroom entry names (e.g. "Levine & Zhang")
   * @param {string} [caselistSlug] Defaults to hspolicy25
   * @returns {{ schoolName, teamCode, teamSlug, caselistUrl, rounds } | null}
   */
  async lookupOpponent(teamCode, side, entryNames, caselistSlug = DEFAULT_CASELIST) {
    try {
      const parts = teamCode.trim().split(/\s+/);
      if (parts.length < 2) {
        console.warn('[CaselistService] Team code must contain school name + team suffix');
        return null;
      }
      const teamSuffix = parts.pop();
      const schoolName = parts.join(' ');

      if (!this.cookie) await this.login();

      const schoolSlug = await this.findSchool(caselistSlug, schoolName);
      if (!schoolSlug) {
        console.warn(`[CaselistService] Could not find school "${schoolName}" on ${caselistSlug}`);
        return null;
      }

      const team = await this.findTeamByEntry(caselistSlug, schoolSlug, entryNames, teamSuffix);
      if (!team) {
        console.warn(`[CaselistService] Could not find team "${teamSuffix}" (entry: "${entryNames}") under "${schoolSlug}"`);
        return null;
      }

      const teamSlug = team.name;
      const rounds = side ? await this.getTeamRounds(caselistSlug, schoolSlug, teamSlug, side) : [];
      const caselistUrl = this.getWikiUrl(caselistSlug, schoolSlug, teamSlug, side);

      return {
        schoolName,
        teamCode: teamSuffix,
        teamSlug,
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
