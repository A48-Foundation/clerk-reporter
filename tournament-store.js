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
  }

  load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        // New format: { tournaments: {...}, activeSession: {...} }
        if (raw.tournaments && typeof raw.tournaments === 'object' && !Array.isArray(raw.tournaments)) {
          return { tournaments: raw.tournaments, activeSession: raw.activeSession || null };
        }
        // Legacy format: tournaments stored at root level
        return { tournaments: raw, activeSession: null };
      }
    } catch (err) {
      console.error('Failed to load tournaments.json:', err.message);
    }
    return { tournaments: {}, activeSession: null };
  }

  save() {
    const data = { tournaments: this.tournaments, activeSession: this.activeSession };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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
  setActiveSession(tournId, tournamentUrl, channelMappings) {
    this.activeSession = {
      tournId,
      tournamentUrl,
      channelMappings,
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
}

module.exports = TournamentStore;
