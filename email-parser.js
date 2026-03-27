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

    // Format A (elim): "[TAB] TeamCode ElimName Event"
    const elimMatch = subject.match(/^\[TAB\]\s+(.+?)\s+(Doubles|Octas|Quarters|Semis|Finals|Triples|Round\s+of\s+\d+)\s+(.+)$/i);
    if (elimMatch) {
      return {
        teamCode: elimMatch[1].trim(),
        roundNumber: null,
        event: elimMatch[3].trim(),
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

    // Strip forwarded message headers (Gmail "---------- Forwarded message ---------" blocks)
    let cleaned = bodyText.replace(
      /^-{5,}\s*Forwarded message\s*-{5,}\s*\n(?:(?:From|Date|Subject|To|Cc):.*\n)*/mi,
      ''
    ).trim();

    // Also strip quoted reply headers ("> " prefixed lines at the start, "On ... wrote:" lines)
    cleaned = cleaned.replace(/^On .+ wrote:\s*\n/mi, '').trim();

    // Detect Format B by "ENTRIES" section or "Full assignments for" header
    if (/^ENTRIES$/m.test(cleaned) || /^Full assignments for /mi.test(cleaned)) {
      return this._parseAssignmentsBody(cleaned);
    }

    // Default: Format A
    return this._parseLiveUpdateBody(cleaned);
  }

  // ─── FORMAT A: Live Update ─────────────────────────────────────────

  static _parseLiveUpdateBody(bodyText) {
    const lines = bodyText.split(/\r?\n/);
    const result = emptyLiveUpdateResult();

    let section = 'header';
    let currentSide = null;
    let currentJudge = null;
    let flipMode = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '') continue;

      // Stop parsing at footer separators or Tabroom footer boilerplate
      if (/^-{2,}$/.test(trimmed)) break;
      if (/^You received this email/i.test(trimmed)) break;
      if (/^To stop them/i.test(trimmed)) break;
      if (/^thanks[!.,]?\s/i.test(trimmed) || /^sent from/i.test(trimmed)) break;

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
        // Detect "FLIP FOR SIDES:" or "FLIP FOR SIDES"
        if (/^FLIP\s+(?:FOR\s+)?SIDES:?$/i.test(trimmed)) {
          result.side = 'FLIP';
          flipMode = true;
          currentSide = null;
          continue;
        }

        const sideMatch = trimmed.match(/^(AFF|NEG)\s+(.+)$/i);
        if (sideMatch) {
          currentSide = sideMatch[1].toUpperCase() === 'AFF' ? 'aff' : 'neg';
          result.competitors[currentSide].teamCode = sideMatch[2].trim();
        } else if (flipMode) {
          // In flip mode, lines with "Name : pronoun" patterns are debater names;
          // other lines are team codes (first → aff, second → neg)
          if (looksLikeNameLine(trimmed)) {
            if (currentSide) {
              result.competitors[currentSide].names.push(...parseNames(trimmed));
            }
          } else {
            if (!currentSide) {
              currentSide = 'aff';
            } else if (currentSide === 'aff') {
              currentSide = 'neg';
            }
            result.competitors[currentSide].teamCode = trimmed;
          }
        } else if (currentSide) {
          result.competitors[currentSide].names.push(...parseNames(trimmed));
        }
      } else if (section === 'judging') {
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
    const subject = (email.subject || '').trim();
    // Match [TAB] anywhere in subject (handles Fwd:, Re: prefixes)
    if (/\[TAB\]/i.test(subject)) return true;
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
    if (/FLIP\s+(?:FOR\s+)?SIDES/i.test(body)) posSignals++;

    // If dominated by negative signals and no positive signals, reject
    if (negBodySignals >= 2 && posSignals === 0) return false;

    // Subject-based strong positive: "[TAB] Team Round N Event" or elim round name
    if (/\[TAB\].+(?:Round\s+\d+|Doubles|Octas|Quarters|Semis|Finals|Triples)\s+/i.test(subject)) return posSignals >= 1 || true;

    // Subject-based moderate positive: "[TAB] School Round Assignments"
    // Requires body confirmation
    if (/\[TAB\].+Round\s+Assignments$/i.test(subject)) return posSignals >= 2;

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

  /**
   * Try regex parse first; if result is incomplete (missing required fields),
   * fall back to LLM extraction. Returns null if the email is not a valid pairing.
   *
   * Required fields for a valid pairing:
   *   - At least one team code (our team or opponent)
   *   - At least one judge
   *   - A start time
   *
   * @param {{ subject?: string, from?: string, body?: string }} email
   * @param {object} [llmService] - LlmService instance for fallback
   * @returns {Promise<object|null>}
   */
  static async parseWithFallback(email, llmService) {
    if (!email || typeof email !== 'object') return null;

    // Try regex parse first
    const regexResult = this.parse(email);

    if (regexResult && this._isCompletePairing(regexResult)) {
      return regexResult;
    }

    // Regex parse incomplete — try LLM fallback if available
    if (llmService && llmService.enabled) {
      try {
        const llmResult = await this._llmParse(email, llmService);
        if (llmResult && this._isCompletePairing(llmResult)) {
          return llmResult;
        }
      } catch (err) {
        console.error('[EmailParser] LLM fallback failed:', err.message);
      }
    }

    // If regex had a partial result, still return it if it has SOME data
    if (regexResult && this._hasAnyPairingData(regexResult)) {
      return regexResult;
    }

    return null;
  }

  /**
   * Check if a parsed result has all required fields for a complete pairing.
   */
  static _isCompletePairing(parsed) {
    if (!parsed) return false;

    if (parsed.format === 'assignments') {
      return (parsed.entries || []).some(e =>
        e.teamCode && e.opponent && e.judges.length > 0
      );
    }

    // Format A
    const hasTeams = !!(parsed.aff?.teamCode || parsed.neg?.teamCode);
    const hasJudges = (parsed.judges || []).length > 0;
    const hasStartTime = !!parsed.startTime;
    return hasTeams && hasJudges && hasStartTime;
  }

  /**
   * Check if a parsed result has any meaningful pairing data at all.
   */
  static _hasAnyPairingData(parsed) {
    if (!parsed) return false;
    if (parsed.format === 'assignments') {
      return (parsed.entries || []).length > 0;
    }
    return !!(parsed.aff?.teamCode || parsed.neg?.teamCode || (parsed.judges || []).length > 0);
  }

  /**
   * Use the LLM to extract pairing data from an unstructured email body.
   */
  static async _llmParse(email, llmService) {
    const body = (email.body || '').trim();
    if (!body) return null;

    const systemPrompt = [
      'You are a parser for debate tournament pairing emails.',
      'Extract the following fields from the email text and return ONLY valid JSON:',
      '{',
      '  "format": "liveUpdate",',
      '  "roundTitle": "string or null",',
      '  "startTime": "string or null",',
      '  "room": "string or null",',
      '  "side": "AFF" or "NEG" or "FLIP" or null,',
      '  "aff": { "teamCode": "string or null", "names": [] },',
      '  "neg": { "teamCode": "string or null", "names": [] },',
      '  "judges": [{ "name": "string", "pronouns": null }]',
      '}',
      '',
      'Team codes look like "School Name XX" where XX is a letter code.',
      'If side is not specified, set it to null.',
      'If there are multiple entries, use format "assignments" with an "entries" array.',
      'Return ONLY the JSON object, no markdown, no explanation.',
    ].join('\n');

    const subject = email.subject || '';
    const userContent = `Subject: ${subject}\n\nBody:\n${body}`;

    const response = await llmService.client.chat.completions.create({
      model: llmService.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      max_tokens: 800,
    });

    const text = (response.choices[0]?.message?.content || '').trim();

    // Extract JSON from the response (handle possible markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const data = JSON.parse(jsonMatch[0]);
      // Normalize the LLM output to match our expected structure
      if (data.format === 'assignments' && Array.isArray(data.entries)) {
        return {
          format: 'assignments',
          school: data.school || null,
          roundTitle: data.roundTitle || null,
          startTime: data.startTime || null,
          entries: data.entries.map(e => ({
            teamCode: e.teamCode || null,
            opponent: e.opponent || null,
            side: e.side || null,
            judges: (e.judges || []).map(j => typeof j === 'string' ? { name: j, pronouns: null } : j),
            room: e.room || null,
          })),
        };
      }

      return {
        format: 'liveUpdate',
        teamCode: data.teamCode || null,
        roundNumber: data.roundNumber || null,
        event: data.event || null,
        roundTitle: data.roundTitle || null,
        startTime: data.startTime || null,
        room: data.room || null,
        side: data.side || null,
        aff: data.aff || { teamCode: null, names: [] },
        neg: data.neg || { teamCode: null, names: [] },
        judges: (data.judges || []).map(j => typeof j === 'string' ? { name: j, pronouns: null } : j),
      };
    } catch (err) {
      console.error('[EmailParser] LLM returned invalid JSON:', text.substring(0, 200));
      return null;
    }
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
 * Detect if a line looks like debater names (has "Name : pronoun" patterns).
 * Used to distinguish team codes from debater names in FLIP mode.
 */
function looksLikeNameLine(line) {
  return /\w\s*:\s*\w+\/\w+/.test(line);
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
