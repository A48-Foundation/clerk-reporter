/**
 * Parses Tabroom pairing notification emails.
 *
 * Supports TWO distinct email formats:
 *
 * FORMAT A — "Live Update" (one pairing per email)
 *   Subject: [TAB] Interlake OC Round 3 CX-T
 *   Body: Round title, Start/Room/Side fields, Competitors (AFF/NEG), Judging section
 *
 * FORMAT B — "Round Assignments" (full school assignments, may contain multiple entries)
 *   Subject: [TAB] Cuttlefish independent Round Assignments
 *   Body: "Full assignments for {school}", round line like "Policy V Quarters Start 9:00",
 *         ENTRIES section with team blocks (FLIP/AFF/NEG vs opponent, Judges:, Room inline)
 */
class EmailParser {
  /**
   * Parse a [TAB] subject line into structured fields.
   * Format A: "[TAB] <teamCode> Round <N> <event>"
   * Format B: "[TAB] <school> Round Assignments"
   * @returns {{ teamCode: string|null, roundNumber: number|null, event: string|null,
   *             format: 'liveUpdate'|'assignments'|null, school: string|null } | null}
   */
  static parseSubject(subject) {
    if (!subject || typeof subject !== 'string') return null;

    // Format B: "[TAB] School Round Assignments"
    const assignMatch = subject.match(/^\[TAB\]\s+(.+?)\s+Round\s+Assignments$/i);
    if (assignMatch) {
      return {
        teamCode: null,
        roundNumber: null,
        event: null,
        format: 'assignments',
        school: assignMatch[1].trim(),
      };
    }

    // Format A: "[TAB] TeamCode Round N Event"
    const liveMatch = subject.match(/^\[TAB\]\s+(.+?)\s+Round\s+(\d+)\s+(.+)$/i);
    if (liveMatch) {
      return {
        teamCode: liveMatch[1].trim(),
        roundNumber: parseInt(liveMatch[2], 10),
        event: liveMatch[3].trim(),
        format: 'liveUpdate',
        school: null,
      };
    }

    return null;
  }

  /**
   * Detect the body format and route to the appropriate parser.
   */
  static parseBody(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') {
      return emptyLiveUpdateResult();
    }

    // Detect Format B by "ENTRIES" section or "Full assignments for" header
    if (/^ENTRIES$/m.test(bodyText) || /^Full assignments for /mi.test(bodyText)) {
      return this._parseAssignmentsBody(bodyText);
    }

    // Default: Format A
    return this._parseLiveUpdateBody(bodyText);
  }

  // ─── FORMAT A: Live Update ─────────────────────────────────────────

  static _parseLiveUpdateBody(bodyText) {
    const lines = bodyText.split(/\r?\n/);
    const result = emptyLiveUpdateResult();

    let section = 'header';
    let currentSide = null;
    let currentJudge = null;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '') continue;

      if (/^competitors$/i.test(trimmed)) {
        section = 'competitors';
        currentSide = null;
        continue;
      }
      if (/^judging$/i.test(trimmed)) {
        section = 'judging';
        flushJudge(result, currentJudge);
        currentJudge = null;
        continue;
      }

      if (section === 'header') {
        parseLiveUpdateHeaderLine(trimmed, result);
      } else if (section === 'competitors') {
        const sideMatch = trimmed.match(/^(AFF|NEG)\s+(.+)$/i);
        if (sideMatch) {
          currentSide = sideMatch[1].toUpperCase() === 'AFF' ? 'aff' : 'neg';
          result.competitors[currentSide].teamCode = sideMatch[2].trim();
        } else if (currentSide) {
          // Any non-AFF/NEG line in the Competitors section is debater names
          result.competitors[currentSide].names.push(...parseNames(trimmed));
        }
      } else if (section === 'judging') {
        // A line that looks like pronouns (e.g. "He/Him", "she/her") → attach to current judge
        if (currentJudge && isPronounLine(trimmed)) {
          currentJudge.pronouns = trimmed;
          flushJudge(result, currentJudge);
          currentJudge = null;
        } else {
          flushJudge(result, currentJudge);
          currentJudge = { name: trimmed, pronouns: null };
        }
      }
    }

    flushJudge(result, currentJudge);
    return result;
  }

  // ─── FORMAT B: Round Assignments ───────────────────────────────────

  /**
   * Parse a "Round Assignments" email body.
   * Returns an object with `entries` array — one per team block.
   * @returns {{ format: 'assignments', roundTitle, startTime, entries: Array }}
   */
  static _parseAssignmentsBody(bodyText) {
    const lines = bodyText.split(/\r?\n/);
    const result = {
      format: 'assignments',
      school: null,
      roundTitle: null,
      startTime: null,
      entries: [],
    };

    let inEntries = false;
    let currentEntry = null;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '') continue;

      // Stop at the footer separator
      if (/^-{5,}/.test(trimmed)) break;

      // Header: "Full assignments for School"
      const fullAssignMatch = trimmed.match(/^Full assignments for\s+(.+)$/i);
      if (fullAssignMatch) {
        result.school = fullAssignMatch[1].trim();
        continue;
      }

      // Round info line: "Policy V Quarters Start 9:00"
      const roundLineMatch = trimmed.match(/^(.+?)\s+Start\s+(.+)$/i);
      if (roundLineMatch && !inEntries) {
        result.roundTitle = roundLineMatch[1].trim();
        result.startTime = roundLineMatch[2].trim();
        continue;
      }

      // ENTRIES section header
      if (/^ENTRIES$/i.test(trimmed)) {
        inEntries = true;
        continue;
      }

      if (!inEntries) continue;

      // Non-indented line in ENTRIES = new team code
      if (!isIndented(raw) && trimmed) {
        if (currentEntry) result.entries.push(currentEntry);
        currentEntry = {
          teamCode: trimmed,
          opponent: null,
          side: null,
          judges: [],
          room: null,
        };
        continue;
      }

      // Indented lines belong to the current entry
      if (isIndented(raw) && currentEntry) {
        // "FLIP vs Opponent" or "AFF vs Opponent" or "NEG vs Opponent"
        const vsMatch = trimmed.match(/^(FLIP|AFF|NEG)\s+vs\s+(.+)$/i);
        if (vsMatch) {
          currentEntry.side = vsMatch[1].toUpperCase();
          currentEntry.opponent = vsMatch[2].trim();
          continue;
        }

        // "Judges: Name1, Name2, Name3     Room RoomName Counter N Letter N"
        const judgeRoomMatch = trimmed.match(/^Judges?:\s*(.+?)(?:\s{2,}Room\s+(.+?))?(?:\s+Counter\s+.+)?(?:\s+Letter\s+.+)?$/i);
        if (judgeRoomMatch) {
          const judgeStr = judgeRoomMatch[1].trim();
          currentEntry.judges = judgeStr
            .split(/,\s*/)
            .map(n => n.trim())
            .filter(Boolean)
            .map(name => ({ name, pronouns: null }));
          if (judgeRoomMatch[2]) {
            currentEntry.room = judgeRoomMatch[2].trim();
          }
          continue;
        }
      }
    }

    // Flush final entry
    if (currentEntry) result.entries.push(currentEntry);

    return result;
  }

  // ─── Top-level helpers ────────────────────────────────────────────

  /**
   * Returns true if the email is from Tabroom (any email from @www.tabroom.com or [TAB] subject).
   */
  static isTabroomEmail(email) {
    if (!email || typeof email !== 'object') return false;
    if (email.subject && /^\[TAB\]/i.test(email.subject.trim())) return true;
    if (email.from && /@www\.tabroom\.com/i.test(email.from)) return true;
    return false;
  }

  /**
   * Returns true if the email contains actual pairing/assignment data
   * (as opposed to check-in notices, logistics emails, etc.).
   *
   * A pairing email MUST contain evidence of: a matchup (opponent), judge(s), and round info.
   * We check both subject and body for structural signals.
   */
  static isPairingEmail(email) {
    if (!email || typeof email !== 'object') return false;
    if (!this.isTabroomEmail(email)) return false;

    const subject = (email.subject || '').trim();
    const body = (email.body || '').trim();

    // Negative signals in subject — these are never pairing emails
    if (/check-?in|registration|payment|schedule|reminder|waitlist|confirmed|receipt/i.test(subject)) return false;

    // Strong negative signals in body — if the body is DOMINATED by logistics content
    // and lacks pairing structure, reject it
    const negBodySignals = [
      /online check-?in/i, /check-?in is now open/i, /payment information/i,
      /registration process/i, /unpaid balance/i, /please double check/i,
    ].filter(re => re.test(body)).length;

    // Positive structural signals that indicate pairing data
    let posSignals = 0;
    if (/^Competitors$/mi.test(body)) posSignals++;
    if (/^ENTRIES$/mi.test(body)) posSignals++;
    if (/^Judging$/mi.test(body)) posSignals++;
    if (/Judges?:\s*\w/i.test(body)) posSignals++;
    if (/\b(AFF|NEG)\s+\w/i.test(body)) posSignals++;
    if (/\bvs\s+\w/i.test(body)) posSignals++;
    if (/^Side:\s*(AFF|NEG|FLIP)/mi.test(body)) posSignals++;
    if (/^Room:\s*\w/mi.test(body)) posSignals++;

    // If dominated by negative signals and no positive signals, reject
    if (negBodySignals >= 2 && posSignals === 0) return false;

    // Subject-based strong positive: "[TAB] Team Round N Event" (numeric round)
    if (/^\[TAB\].+Round\s+\d+\s+/i.test(subject)) return posSignals >= 1 || true;

    // Subject-based moderate positive: "[TAB] School Round Assignments"
    // Requires body confirmation
    if (/^\[TAB\].+Round\s+Assignments$/i.test(subject)) return posSignals >= 2;

    // Body-only detection — need strong structural signals
    return posSignals >= 2;
  }

  /**
   * Full parse: combines subject + body into a unified result.
   *
   * For Format A (live update): returns a single pairing object.
   * For Format B (assignments): returns an object with `entries` array,
   *   each entry representing one team's pairing.
   *
   * @param {{ subject?: string, from?: string, body?: string }} email
   * @returns {object|null}
   */
  static parse(email) {
    if (!email || typeof email !== 'object') return null;

    const subjectData = this.parseSubject(email.subject);
    const bodyData = this.parseBody(email.body);

    // Format B: assignments
    if (bodyData.format === 'assignments' || (subjectData && subjectData.format === 'assignments')) {
      return {
        format: 'assignments',
        school: subjectData?.school || bodyData.school || null,
        roundTitle: bodyData.roundTitle || null,
        startTime: bodyData.startTime || null,
        entries: bodyData.entries || [],
      };
    }

    // Format A: live update (default)
    const sub = subjectData || { teamCode: null, roundNumber: null, event: null };
    return {
      format: 'liveUpdate',
      teamCode: sub.teamCode,
      roundNumber: sub.roundNumber,
      event: sub.event,
      roundTitle: bodyData.roundTitle,
      startTime: bodyData.startTime,
      room: bodyData.room,
      side: bodyData.side,
      aff: bodyData.competitors.aff,
      neg: bodyData.competitors.neg,
      judges: bodyData.judges,
    };
  }
}

// ── Private utility functions ──────────────────────────────────────────

function emptyLiveUpdateResult() {
  return {
    roundTitle: null, startTime: null, room: null, side: null,
    competitors: { aff: { teamCode: null, names: [] }, neg: { teamCode: null, names: [] } },
    judges: [],
  };
}

function parseLiveUpdateHeaderLine(trimmed, result) {
  const startMatch = trimmed.match(/^Start:\s*(.+)$/i);
  if (startMatch) { result.startTime = startMatch[1].trim(); return; }

  const roomMatch = trimmed.match(/^Room:\s*(.+)$/i);
  if (roomMatch) { result.room = roomMatch[1].trim(); return; }

  const sideMatch = trimmed.match(/^Side:\s*(.+)$/i);
  if (sideMatch) { result.side = sideMatch[1].trim(); return; }

  if (result.roundTitle === null) { result.roundTitle = trimmed; }
}

function isIndented(line) {
  return /^[ \t]+\S/.test(line);
}

/**
 * Detect if a line is a pronoun annotation (e.g. "He/Him", "she/her", "they/them").
 */
function isPronounLine(trimmed) {
  return /^[a-z]+\/[a-z]+$/i.test(trimmed) || /^(he|she|they|ze|xe)\b/i.test(trimmed);
}

function parseNames(line) {
  const names = [];
  const pairRegex = /([A-Za-z\s'-]+?)\s*:\s*([\w/]+)/g;
  let match;
  while ((match = pairRegex.exec(line)) !== null) {
    names.push({ name: match[1].trim(), pronouns: match[2].trim() });
  }
  if (names.length === 0 && line.trim()) {
    line.trim().split(/\s{2,}/).forEach((n) => {
      if (n.trim()) names.push({ name: n.trim(), pronouns: null });
    });
  }
  return names;
}

function flushJudge(result, judge) {
  if (judge) result.judges.push(judge);
}

module.exports = EmailParser;
