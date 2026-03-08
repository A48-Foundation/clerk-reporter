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
   *   1AC - PNT (6 occurrences)
   *   1AC - Science Diplomacy (3 occurrences)
   *   Most Recent: PNT
   *
   * @param {Array} rounds - caselist round objects with { report, tournament, round }
   * @param {'A'|'N'} side
   * @returns {string}
   */
  summarizeArguments(rounds, side) {
    const reportsWithText = rounds.filter(r => r.report && r.report.trim());
    if (reportsWithText.length === 0) {
      return '_No round reports available._';
    }

    const label = side === 'A' ? '1AC' : '2NR';
    const counts = new Map();
    let mostRecent = null;

    for (const round of reportsWithText) {
      const text = round.report;
      let arg = null;

      if (side === 'A') {
        // Extract 1AC argument: look for "1ac X", "1AC X", "ran X", "We ran X"
        const match = text.match(/1ac\s+(?:was\s+)?(.+?)(?:\s*[;,]|$)/i)
          || text.match(/(?:we\s+)?ran\s+(.+?)(?:\s*[;,]|$)/i)
          || text.match(/^(.+?)(?:\s*[;,])/i);
        if (match) arg = match[1].trim();
      } else {
        // Extract 2NR argument: look for "2nr X", "2nr was X"
        const match = text.match(/2nr\s+(?:was\s+)?(.+?)(?:\s*[;,.]|$)/i);
        if (match) arg = match[1].trim();
      }

      if (arg) {
        // Normalize: lowercase for counting, but keep original for display
        const key = arg.toLowerCase().replace(/^(?:the\s+)/, '');
        if (!counts.has(key)) counts.set(key, { display: arg, count: 0 });
        counts.get(key).count++;
        mostRecent = arg;
      }
    }

    if (counts.size === 0) {
      return `_Could not extract ${label} arguments from ${reportsWithText.length} report(s)._`;
    }

    const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
    const lines = sorted.map(({ display, count }) =>
      `${label} - ${display} (${count} occurrence${count > 1 ? 's' : ''})`
    );
    lines.push(`Most Recent: ${mostRecent}`);

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
      'You are a debate assistant. Summarize the following judge paradigm in 3-5 sentences.',
      'Focus on: their overall judging philosophy, preferences regarding speed/delivery,',
      'stance on kritiks (K) vs policy arguments, and any strong biases or auto-rejects.',
      'Be direct and useful for a debater prepping for a round.',
    ].join(' ');

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: philosophyText },
        ],
        temperature: 0.3,
        max_tokens: 300,
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
   * @returns {string}
   */
  summarizeWithFallback(rounds, side) {
    return this.summarizeArguments(rounds, side);
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
