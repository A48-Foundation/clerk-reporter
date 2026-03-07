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
   * @param {Array<{tournament: string, side: string, round: string, opponent: string, judge: string, report: string}>} rounds
   * @param {'A'|'N'} side - 'A' for aff (1AC analysis), 'N' for neg (2NR analysis)
   * @returns {Promise<string>} Discord-embed-friendly summary
   */
  async summarizeArguments(rounds, side) {
    if (!this.enabled) {
      return this.basicFrequencyAnalysis(rounds, side);
    }

    const label = side === 'A' ? '1AC' : '2NR';
    const focusDescription = side === 'A'
      ? '1AC arguments and advantage/plan areas the team has read on the affirmative'
      : '2NR strategies and negative arguments the team has collapsed to in the 2NR';

    const reportsBlock = rounds
      .filter(r => r.report)
      .map(r => `Tournament: ${r.tournament} | Round: ${r.round} | Opponent: ${r.opponent} | Judge: ${r.judge}\nReport: ${r.report}`)
      .join('\n---\n');

    if (!reportsBlock) {
      return `_No round reports available to analyze._`;
    }

    const systemPrompt = [
      'You are a debate research assistant. Analyze the following round reports and provide a concise summary of the team\'s arguments.',
      `Focus on ${focusDescription}.`,
      'Format your response for a Discord embed field using **bold** for argument names and bullet points (•).',
      `List each distinct ${label} argument/topic with its frequency count.`,
      `Highlight which ${label} was most recently read and which is most frequently read.`,
      'Be concise — no more than 15 lines.',
    ].join(' ');

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: reportsBlock },
        ],
        temperature: 0.3,
        max_tokens: 600,
      });

      return response.choices[0]?.message?.content?.trim() || this.basicFrequencyAnalysis(rounds, side);
    } catch (err) {
      console.error(`[LlmService] summarizeArguments failed: ${err.message}`);
      return this.basicFrequencyAnalysis(rounds, side);
    }
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
   * Wrapper that always returns a result — uses LLM if available, otherwise basic analysis.
   * @param {Array} rounds
   * @param {'A'|'N'} side
   * @returns {Promise<string>}
   */
  async summarizeWithFallback(rounds, side) {
    try {
      if (this.enabled) {
        return await this.summarizeArguments(rounds, side);
      }
    } catch (err) {
      console.error(`[LlmService] summarizeWithFallback LLM path failed: ${err.message}`);
    }
    return this.basicFrequencyAnalysis(rounds, side);
  }

  /**
   * Non-LLM fallback: extract argument names from report text via pattern matching and count them.
   * @param {Array<{tournament: string, side: string, round: string, opponent: string, judge: string, report: string}>} rounds
   * @param {'A'|'N'} side
   * @returns {string}
   */
  basicFrequencyAnalysis(rounds, side) {
    const reportsWithText = rounds.filter(r => r.report && r.report.trim());
    if (reportsWithText.length === 0) {
      return '_No round reports available for analysis._';
    }

    const label = side === 'A' ? '1AC' : '2NR';
    const counts = new Map();
    let mostRecent = null;

    // Common debate argument patterns to look for in reports
    const argPatterns = side === 'A'
      ? [
          // Aff-side patterns: plan texts, advantages, affirmatives
          /\b1ac\s*[-–:]?\s*(.+?)(?:\.|,|;|\n|$)/gi,
          /\baff(?:irmative)?\s*[-–:]?\s*(.+?)(?:\.|,|;|\n|$)/gi,
          /\badvantage\s*\d*\s*[-–:]?\s*(.+?)(?:\.|,|;|\n|$)/gi,
          /\bplan\s*[-–:]?\s*(.+?)(?:\.|,|;|\n|$)/gi,
          /\bread\s+(.+?)(?:\s+aff|\.|,|;|\n|$)/gi,
        ]
      : [
          // Neg-side patterns: 2NR strategies, off-case, DAs, CPs, Ks
          /\b2nr\s*[-–:]?\s*(.+?)(?:\.|,|;|\n|$)/gi,
          /\bwent\s+for\s+(?:the\s+)?(.+?)(?:\.|,|;|\n|$)/gi,
          /\bcollapsed\s+(?:to|on)\s+(?:the\s+)?(.+?)(?:\.|,|;|\n|$)/gi,
          /\bneg\s+strat(?:egy)?\s*[-–:]?\s*(.+?)(?:\.|,|;|\n|$)/gi,
        ];

    // Keyword-based extraction for common argument types (word-boundary matched)
    const keywordEntries = [
      'heg', 'hegemony', 'econ', 'economy', 'warming', 'climate', 'prolif', 'proliferation',
      'politics', 'ptx', 'states cp', 'states counterplan', 'consult', 'condition',
      'capitalism', 'neolib', 'neoliberalism', 'security', 'securitization', 'biopower',
      'foucault', 'afropessimism', 'settler colonialism', 'dedev', 'degrowth', 'spark',
      'wipeout', 'topicality', 'framework', 'case turns', 'disad', 'counterplan',
      'kritik', 'impact turn',
    ];

    for (const round of reportsWithText) {
      const text = round.report.toLowerCase();
      const foundInRound = new Set();

      // Pattern-based extraction
      for (const pattern of argPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const arg = match[1].trim().substring(0, 60);
          if (arg.length > 1) {
            foundInRound.add(arg);
          }
        }
      }

      // Keyword-based extraction (word-boundary matched to avoid false positives)
      for (const kw of keywordEntries) {
        const kwRegex = new RegExp(`\\b${kw}\\b`, 'i');
        if (kwRegex.test(text)) {
          foundInRound.add(kw);
        }
      }

      for (const arg of foundInRound) {
        counts.set(arg, (counts.get(arg) || 0) + 1);
        mostRecent = { arg, tournament: round.tournament, round: round.round };
      }
    }

    if (counts.size === 0) {
      return `_Could not extract specific ${label} arguments from ${reportsWithText.length} report(s). Reports may lack structured data._`;
    }

    // Sort by frequency descending
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topArg = sorted[0];

    const lines = [`**${label} Frequency Analysis** (${reportsWithText.length} round(s))\n`];
    for (const [arg, count] of sorted.slice(0, 10)) {
      lines.push(`• **${arg}** — ${count}x`);
    }

    lines.push('');
    lines.push(`📌 Most common: **${topArg[0]}** (${topArg[1]}x)`);
    if (mostRecent) {
      lines.push(`🕐 Most recent: **${mostRecent.arg}** (${mostRecent.tournament}, ${mostRecent.round})`);
    }

    return lines.join('\n');
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
