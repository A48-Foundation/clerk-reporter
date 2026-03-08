const OpenAI = require('openai');

class LlmService {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
      this.enabled = true;
    } else {
      console.warn('[LlmService] No OPENAI_API_KEY found — falling back to non-LLM summaries.');
      this.client = null;
      this.enabled = false;
    }
    this.model = 'gpt-4o-mini';
  }

  /**
   * Summarize a team's arguments from OpenCaselist round reports.
   * Uses simple frequency counting — no LLM needed.
   *
   * For Aff side: extracts what the 1AC was from each round's report.
   * For Neg side: extracts what the 2NR was from each round's report.
   *
   * Output format:
   *   1AC - PNT (6 occurrences) - [Docs](link)
   *   1AC - Science Diplomacy (3 occurrences)
   *   Most Recent: PNT - Tournament Name, Round 4
   *
   * @param {Array} rounds - caselist round objects with { report, tournament, round, opensource }
   * @param {'A'|'N'} side
   * @param {Function} [getDownloadUrl] - optional fn(opensourcePath) → URL string
   * @param {Object} [negContext] - for neg side: { ourAff } to find relevant doc link
   * @returns {string}
   */
  summarizeArguments(rounds, side, getDownloadUrl, negContext) {
    const reportsWithText = rounds.filter(r => r.report && r.report.trim());
    if (reportsWithText.length === 0) {
      return '_No round reports available._';
    }

    const label = side === 'A' ? '1AC' : '2NR';
    const counts = new Map(); // key → { display, count, latestDoc }
    let mostRecent = null;
    let mostRecentRound = null;

    for (const round of reportsWithText) {
      const text = round.report;
      let arg = null;

      if (side === 'A') {
        const match = text.match(/1ac\s+(?:was\s+)?(.+?)(?:\s*[;,]|$)/i)
          || text.match(/(?:we\s+)?ran\s+(.+?)(?:\s*[;,]|$)/i)
          || text.match(/^(.+?)(?:\s*[;,])/i);
        if (match) arg = match[1].trim();
      } else {
        const match = text.match(/2nr\s+(?:was\s+)?(.+?)(?:\s*[;,.]|$)/i);
        if (match) arg = match[1].trim();
      }

      if (arg) {
        const key = arg.toLowerCase().replace(/^(?:the\s+)/, '');
        if (!counts.has(key)) counts.set(key, { display: arg, count: 0, latestDoc: null });
        const entry = counts.get(key);
        entry.count++;
        // For aff side, track per-argument doc links
        if (side === 'A' && round.opensource && getDownloadUrl) {
          entry.latestDoc = getDownloadUrl(round.opensource);
        }
        mostRecent = arg;
        mostRecentRound = round;
      }
    }

    if (counts.size === 0) {
      return `_Could not extract ${label} arguments from ${reportsWithText.length} report(s)._`;
    }

    const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
    const lines = sorted.map(({ display, count, latestDoc }) => {
      let line = `${label} - ${display} (${count})`;
      if (latestDoc) line += ` - [Docs](${latestDoc})`;
      return line;
    });

    let recentLine = `Most Recent: ${mostRecent}`;
    if (mostRecentRound) {
      const parts = [];
      if (mostRecentRound.tournament) parts.push(mostRecentRound.tournament);
      if (mostRecentRound.round) parts.push(`Round ${mostRecentRound.round}`);
      if (parts.length > 0) recentLine += ` - ${parts.join(', ')}`;
    }
    lines.push(recentLine);

    // For neg side, append a single doc link for the most relevant round
    if (side === 'N' && getDownloadUrl && negContext) {
      const docRound = this._findNegDocRound(reportsWithText, negContext.ourAff, sorted[0]?.display);
      if (docRound && docRound.opensource) {
        const url = getDownloadUrl(docRound.opensource);
        const acMatch = docRound.report.match(/1ac\s+(?:was\s+)?(.+?)(?:\s*[;,]|$)/i);
        const acName = acMatch ? acMatch[1].trim() : 'unknown';
        lines.push(`📄 [Open Source](${url}) — neg vs ${acName}, ${docRound.tournament} R${docRound.round}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Find the best neg round to link open source for:
   * 1. Most recent neg vs ourAff with an open source doc
   * 2. Fallback: most recent neg where 2NR matches the most common 2NR, with an open source doc
   */
  _findNegDocRound(rounds, ourAff, mostCommon2NR) {
    if (!ourAff && !mostCommon2NR) return null;

    // Strategy 1: most recent neg vs our aff with open source
    if (ourAff) {
      const affLower = ourAff.toLowerCase();
      const affAbbrev = affLower.split(/\s+/).map(w => w.slice(0, 3)).join(' ');
      const vsAff = [...rounds].reverse().find(r => {
        if (!r.opensource || !r.report) return false;
        const report = r.report.toLowerCase();
        if (report.includes(affLower)) return true;
        if (report.includes(affAbbrev)) return true;
        const acMatch = report.match(/1ac\s+(?:was\s+)?(.+?)(?:\s*[;,]|$)/i);
        if (acMatch) {
          const ac = acMatch[1].trim().toLowerCase();
          if (ac.includes(affLower) || affLower.includes(ac)) return true;
        }
        return false;
      });
      if (vsAff) return vsAff;
    }

    // Strategy 2: most recent neg where 2NR is the most common, with open source
    if (mostCommon2NR) {
      const common = mostCommon2NR.toLowerCase();
      const fallback = [...rounds].reverse().find(r => {
        if (!r.opensource || !r.report) return false;
        const nrMatch = r.report.match(/2nr\s+(?:was\s+)?(.+?)(?:\s*[;,.]|$)/i);
        if (nrMatch && nrMatch[1].trim().toLowerCase() === common) return true;
        return false;
      });
      if (fallback) return fallback;
    }

    return null;
  }

  /**
   * Summarize a judge paradigm from Tabroom.
   * @param {string} philosophyText - Full paradigm text
   * @returns {Promise<string>} 3-5 sentence summary
   */
  async summarizeParadigm(philosophyText) {
    if (!this.enabled) {
      return this._truncateParadigm(philosophyText);
    }

    if (!philosophyText || !philosophyText.trim()) {
      return '_No paradigm text available._';
    }

    const systemPrompt = [
      'Summarize this judge paradigm as concise bullet points. No transition words, no filler.',
      'Only include bullets that the paradigm clearly supports. Use this checklist:',
      '• Neg Ks — good/bad for kritiks on the neg? Will they vote on the alt? Framework preferences?',
      '• T v K Affs — stance on topicality/framework against critical/non-traditional affs? Do they think affs must defend the resolution/a plan? Topical version of the aff opinions go here.',
      '• T v Policy — how do they evaluate topicality against policy affs? Appeals to limits, precision, etc.',
      '• CPs — preferences on counterplans? Types they like/dislike? Conditionality views?',
      '• DAs — any preferences on disadvantages? Link quality, uniqueness, turns case?',
      '• Theory — if they say specific args are bad/good (e.g. consult/conditioning/delay CPs, international fiat, 50 state fiat, condo), state exactly which and their opinion. If they say reject-the-arg-not-the-team or reject-the-team, state it.',
      '• Speed — do they dislike speed or have a cap?',
      '• Experience — years judging, coaching background, debate style they competed in',
      '• Non-policy background — if they did LD, PF, parli, speech, or another activity instead of policy, state it',
      '• Speaker points — if they mention a speaker point range, scale, or criteria, state it',
      '• Strong indicators — any auto-rejects, hard preferences, or dealbreakers',
      'Skip any category with no clear signal. Max 11 bullets. Format: "• Topic: detail"',
    ].join('\n');

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: philosophyText },
        ],
        temperature: 0.15,
        max_tokens: 250,
      });

      return response.choices[0]?.message?.content?.trim() || this._truncateParadigm(philosophyText);
    } catch (err) {
      console.error(`[LlmService] summarizeParadigm failed: ${err.message}`);
      return this._truncateParadigm(philosophyText);
    }
  }

  /**
   * Wrapper — uses the simple frequency analysis (no LLM needed for arguments).
   * @param {Array} rounds
   * @param {'A'|'N'} side
   * @param {Function} [getDownloadUrl] - optional fn(opensourcePath) → URL string
   * @param {Object} [negContext] - for neg side: { ourAff }
   * @returns {string}
   */
  summarizeWithFallback(rounds, side, getDownloadUrl, negContext) {
    return this.summarizeArguments(rounds, side, getDownloadUrl, negContext);
  }

  /**
   * Simple paradigm fallback — return a truncated version if no LLM is available.
   * @param {string} text
   * @returns {string}
   */
  _truncateParadigm(text) {
    if (!text || !text.trim()) return '_No paradigm text available._';
    const trimmed = text.trim();
    if (trimmed.length <= 500) return trimmed;
    return trimmed.substring(0, 497) + '...';
  }
}

module.exports = LlmService;
