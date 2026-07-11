const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_DIR = path.join(__dirname, 'cache');

/**
 * Normalize a judge name into a stable lookup key that is order- and
 * format-insensitive. "First Last", "Last First", and "Last, First" all
 * produce the same key by lowercasing and sorting the name tokens.
 *
 *   "Miriam Mokhemar"   → "miriam mokhemar"
 *   "Mokhemar, Miriam"  → "miriam mokhemar"
 */
function normalizeName(name) {
  if (!name) return '';
  let n = String(name);
  if (n.includes(',')) {
    const [last, first] = n.split(',', 2);
    n = `${first} ${last}`;
  }
  return n
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Per-tournament cache for opponent caselist data and judge paradigms.
 *
 * Lets the bot pre-fetch ("prime") data for a tournament before/during it,
 * so live pairing reports read from disk instead of hitting OpenCaselist /
 * Tabroom on the critical path.
 *
 * Cache files live in `cache/` and are keyed by Tabroom tourn_id:
 *   cache/opponents-<tournId>.json
 *   cache/paradigms-<tournId>.json
 *
 * Lookup semantics (important):
 *   - `undefined`  → no cache entry for this key ⇒ caller should fall back to live
 *   - `null`       → cached, but no data was found when primed ⇒ respect the cache
 *   - object       → cached data
 */
class TournamentCache {
  constructor(cacheDir = DEFAULT_CACHE_DIR) {
    this.cacheDir = cacheDir;
    this._mem = {}; // in-memory copy keyed by "<kind>:<tournId>"
    try {
      if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch (err) {
      console.warn('[TournamentCache] Could not create cache dir:', err.message);
    }
  }

  _file(kind, tournId) {
    return path.join(this.cacheDir, `${kind}-${tournId}.json`);
  }

  _read(kind, tournId) {
    if (!tournId) return null;
    const memKey = `${kind}:${tournId}`;
    if (memKey in this._mem) return this._mem[memKey];
    try {
      const file = this._file(kind, tournId);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        this._mem[memKey] = data;
        return data;
      }
    } catch (err) {
      console.warn(`[TournamentCache] Failed to read ${kind} cache for ${tournId}:`, err.message);
    }
    this._mem[memKey] = null;
    return null;
  }

  _write(kind, tournId, data) {
    this._mem[`${kind}:${tournId}`] = data;
    fs.writeFileSync(this._file(kind, tournId), JSON.stringify(data, null, 2));
  }

  // ── Opponents (OpenCaselist lookups) ──────────────────────────────

  hasOpponents(tournId) {
    return !!this._read('opponents', tournId);
  }

  /**
   * @param {string} tournId
   * @param {object} meta       e.g. { tournamentName, eventId, caselistSlug }
   * @param {object} teams      { "<lowercased code>": { A: <lookupResult|null>, N: <lookupResult|null> } }
   */
  saveOpponents(tournId, meta, teams) {
    this._write('opponents', tournId, {
      tournId,
      ...meta,
      createdAt: new Date().toISOString(),
      teams: teams || {},
    });
  }

  /**
   * @returns {object|null|undefined} lookup result, `null` (cached miss), or
   *   `undefined` (no cache / not primed for this team).
   */
  getOpponent(tournId, teamCode, side) {
    const cache = this._read('opponents', tournId);
    if (!cache || !cache.teams) return undefined;
    const team = cache.teams[String(teamCode).toLowerCase()];
    if (!team) return undefined;
    return side in team ? team[side] : undefined;
  }

  getOpponentMeta(tournId) {
    const cache = this._read('opponents', tournId);
    if (!cache) return null;
    return {
      tournamentName: cache.tournamentName,
      createdAt: cache.createdAt,
      teamCount: Object.keys(cache.teams || {}).length,
    };
  }

  // ── Paradigms (Tabroom judge paradigms) ───────────────────────────

  hasParadigms(tournId) {
    return !!this._read('paradigms', tournId);
  }

  /**
   * @param {string} tournId
   * @param {object} judges  { "<normalized name>": <paradigm|null> }
   * @param {object} [meta]  e.g. { tournamentName }
   */
  saveParadigms(tournId, judges, meta = {}) {
    this._write('paradigms', tournId, {
      tournId,
      ...meta,
      createdAt: new Date().toISOString(),
      judges: judges || {},
    });
  }

  /**
   * @returns {object|null|undefined} paradigm, `null` (cached miss), or
   *   `undefined` (no cache / this judge not primed).
   */
  getParadigm(tournId, judgeName) {
    const cache = this._read('paradigms', tournId);
    if (!cache || !cache.judges) return undefined;
    const key = normalizeName(judgeName);
    return key in cache.judges ? cache.judges[key] : undefined;
  }

  getParadigmMeta(tournId) {
    const cache = this._read('paradigms', tournId);
    if (!cache) return null;
    return {
      tournamentName: cache.tournamentName,
      createdAt: cache.createdAt,
      judgeCount: Object.keys(cache.judges || {}).length,
    };
  }
}

TournamentCache.normalizeName = normalizeName;

module.exports = TournamentCache;
