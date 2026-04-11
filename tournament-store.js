const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tournaments.json');

/**
 * Manages tournament tracking configurations.
 * Each tournament has:
 *   - tournId: Tabroom tournament ID
 *   - teams: [{ code, channelId }]  — team entry codes + their Discord channels
 *   - seenRounds: [roundId, ...]      — rounds already processed (avoid duplicates)
 *
 * Also manages an optional activeSession for the email-triggered pairings feature:
 *   - tournId, tournamentUrl, channelMappings, emailMonitorActive,
 *     processedEmailUids, startedAt
 */
class TournamentStore {
  constructor() {
    const data = this.load();
    this.tournaments = data.tournaments;
    this.activeSession = data.activeSession;
    this.settings = data.settings;
  }

  load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        if (raw.tournaments && typeof raw.tournaments === 'object' && !Array.isArray(raw.tournaments)) {
          return {
            tournaments: raw.tournaments,
            activeSession: raw.activeSession || null,
            settings: raw.settings || { ourAff: 'PNT' },
          };
        }
        return { tournaments: raw, activeSession: null, settings: { ourAff: 'PNT' } };
      }
    } catch (err) {
      console.error('Failed to load tournaments.json:', err.message);
    }
    return { tournaments: {}, activeSession: null, settings: { ourAff: 'PNT' } };
  }

  save() {
    const data = { tournaments: this.tournaments, activeSession: this.activeSession, settings: this.settings };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  getOurAff() {
    return this.settings.ourAff || 'PNT';
  }

  setOurAff(affName) {
    this.settings.ourAff = affName;
    this.save();
  }

  getSchoolNames() {
    // Flattened list of all school names across tiers
    return this.getSchoolTiers().flatMap(t => t.schools);
  }

  setSchoolNames(names) {
    // Legacy setter — puts all names in the first (HS) tier
    const tiers = this.getSchoolTiers();
    tiers[0].schools = names;
    this.settings.schoolTiers = tiers;
    this.save();
  }

  getSchoolTiers() {
    return this.settings.schoolTiers || [
      { schools: ['Interlake', 'Cuttlefish', 'Cuttlefish Independent'], caselist: 'hspolicy25', label: 'HS Policy' },
      { schools: ['Dartmouth'], caselist: 'ndtceda25', label: 'College NDT/CEDA' },
    ];
  }

  setSchoolTiers(tiers) {
    this.settings.schoolTiers = tiers;
    this.save();
  }

  getCaselistSlug() {
    return this.settings.caselistSlug || process.env.CASELIST_SLUG || 'hspolicy25';
  }

  setCaselistSlug(slug) {
    this.settings.caselistSlug = slug;
    this.save();
  }

  /**
   * Match a list of entry codes against school tiers.
   * Returns { tier, entries } for the first matching tier, or null.
   */
  matchSchoolTier(entries) {
    for (const tier of this.getSchoolTiers()) {
      const lowerSchools = tier.schools.map(s => s.toLowerCase());
      const matched = entries.filter(e =>
        lowerSchools.some(s => e.code.toLowerCase().startsWith(s))
      );
      if (matched.length > 0) {
        return { tier, entries: matched };
      }
    }
    return null;
  }

  /**
   * Find which caselist slug applies for a given team code.
   */
  getCaselistForTeam(teamCode) {
    const lower = teamCode.toLowerCase();
    for (const tier of this.getSchoolTiers()) {
      if (tier.schools.some(s => lower.startsWith(s.toLowerCase()))) {
        return tier.caselist;
      }
    }
    return this.getCaselistSlug();
  }

  /**
   * Add or update a tournament tracking configuration.
   * @param {string} tournId - Tabroom tournament ID
   * @param {string} teamCode - Team entry code (e.g. "Okemos AT")
   * @param {string} channelId - Discord channel ID to send updates to
   */
  addTeam(tournId, teamCode, channelId) {
    if (!this.tournaments[tournId]) {
      this.tournaments[tournId] = {
        tournId,
        teams: [],
        seenRounds: [],
      };
    }

    const tourn = this.tournaments[tournId];
    // Check if this team+channel combo already exists
    const existing = tourn.teams.find(
      t => t.code.toLowerCase() === teamCode.toLowerCase() && t.channelId === channelId
    );

    if (!existing) {
      tourn.teams.push({ code: teamCode, channelId });
    }

    this.save();
  }

  /**
   * Remove a team from a tournament.
   */
  removeTeam(tournId, teamCode) {
    if (!this.tournaments[tournId]) return false;

    const tourn = this.tournaments[tournId];
    const before = tourn.teams.length;
    tourn.teams = tourn.teams.filter(
      t => t.code.toLowerCase() !== teamCode.toLowerCase()
    );

    if (tourn.teams.length === 0) {
      delete this.tournaments[tournId];
    }

    this.save();
    return tourn.teams.length < before;
  }

  /**
   * Mark a round as seen for a tournament.
   */
  markRoundSeen(tournId, roundId) {
    if (!this.tournaments[tournId]) return;
    if (!this.tournaments[tournId].seenRounds.includes(roundId)) {
      this.tournaments[tournId].seenRounds.push(roundId);
      this.save();
    }
  }

  /**
   * Check if a round has been seen.
   */
  isRoundSeen(tournId, roundId) {
    return this.tournaments[tournId]?.seenRounds?.includes(roundId) || false;
  }

  /**
   * Get all active tournaments.
   */
  getAllTournaments() {
    return Object.values(this.tournaments);
  }

  /**
   * Get a specific tournament.
   */
  getTournament(tournId) {
    return this.tournaments[tournId] || null;
  }

  /**
   * Remove an entire tournament.
   */
  removeTournament(tournId) {
    if (this.tournaments[tournId]) {
      delete this.tournaments[tournId];
      this.save();
      return true;
    }
    return false;
  }

  // ── Active Session (email-triggered pairings) ──

  /**
   * Store an active pairings session.
   * @param {string} tournId - Tournament ID
   * @param {string} tournamentUrl - Full Tabroom URL
   * @param {Object} channelMappings - { teamCode: channelId, ... }
   */
  setActiveSession(tournId, tournamentUrl, channelMappings, allEntries) {
    this.activeSession = {
      tournId,
      tournamentUrl,
      channelMappings,
      allEntries: allEntries || [],
      emailMonitorActive: true,
      processedEmailUids: [],
      startedAt: new Date().toISOString(),
    };
    this.save();
  }

  getActiveSession() {
    return this.activeSession || null;
  }

  clearActiveSession() {
    this.activeSession = null;
    this.save();
  }

  addProcessedEmailUid(uid) {
    if (!this.activeSession) return;
    if (!this.activeSession.processedEmailUids.includes(uid)) {
      this.activeSession.processedEmailUids.push(uid);
      this.save();
    }
  }

  isEmailProcessed(uid) {
    return this.activeSession?.processedEmailUids?.includes(uid) || false;
  }

  /**
   * Look up the Discord channel for a team code in the active session.
   * @param {string} teamCode
   * @returns {string|null} channelId or null
   */
  getChannelForTeam(teamCode) {
    if (!this.activeSession?.channelMappings) return null;
    return this.activeSession.channelMappings[teamCode] ?? null;
  }

  updateChannelMapping(teamCode, channelId) {
    if (!this.activeSession) return;
    this.activeSession.channelMappings[teamCode] = channelId;
    this.save();
  }

  /**
   * Look up the Tabroom entry names for a team code in the active session.
   * E.g. "North Hollywood LZ" → "Levine & Zhang"
   * @param {string} teamCode
   * @returns {string|null}
   */
  getEntryNamesForTeam(teamCode) {
    if (!this.activeSession?.allEntries) return null;
    const entry = this.activeSession.allEntries.find(
      e => e.code.toLowerCase() === teamCode.toLowerCase()
    );
    return entry ? entry.entry : null;
  }
  /**
   * Track which team+round pairings have already been reported to avoid duplicates
   * (e.g. when Tabroom sends both a live update and a round assignments email).
   */
  isPairingReported(dedupKey) {
    return this.activeSession?.reportedPairings?.includes(dedupKey) || false;
  }

  markPairingReported(dedupKey) {
    if (!this.activeSession) return;
    if (!this.activeSession.reportedPairings) this.activeSession.reportedPairings = [];
    if (!this.activeSession.reportedPairings.includes(dedupKey)) {
      this.activeSession.reportedPairings.push(dedupKey);
      this.save();
    }
  }

  // ── Coach Tracking ──

  getCoaches() {
    return this.settings.coaches || null;
  }

  setCoaches(coaches) {
    this.settings.coaches = coaches;
    this.save();
  }

  clearCoaches() {
    delete this.settings.coaches;
    this.save();
  }
}

module.exports = TournamentStore;
