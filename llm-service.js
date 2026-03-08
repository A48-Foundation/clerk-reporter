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
   * @returns {string}
   */
  summarizeArguments(rounds, side, getDownloadUrl) {
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
        // Track the most recent open source doc for this argument
        if (round.opensource && getDownloadUrl) {
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
      let line = `${label} - ${display} (${count} occurrence${count > 1 ? 's' : ''})`;
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

    return lines.join('\n');
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
      '• K stance — good/bad for kritiks? Will they vote on framework?',
      '• T stance — how do they evaluate topicality? Good for T vs critical affs?',
      '• CP/DA — any strong preferences on counterplans or disadvantages?',
      '• Speed — do they dislike speed or have a cap?',
      '• Experience — years judging, coaching background, debate style they competed in',
      '• Strong indicators — any auto-rejects, hard preferences, or dealbreakers',
      'Skip any category with no clear signal. Max 6 bullets. Format: "• Topic: detail"',
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
   * @returns {string}
   */
  summarizeWithFallback(rounds, side, getDownloadUrl) {
    return this.summarizeArguments(rounds, side, getDownloadUrl);
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
