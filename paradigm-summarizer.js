/**
 * paradigm-summarizer.js — Standalone judge paradigm summarizer
 *
 * Summarizes Tabroom judge paradigm text into concise bullet points
 * using OpenAI. Designed for policy debate scouting.
 *
 * Usage:
 *   const ParadigmSummarizer = require('./paradigm-summarizer');
 *   const summarizer = new ParadigmSummarizer(process.env.OPENAI_API_KEY);
 *   const bullets = await summarizer.summarize(paradigmText);
 *
 * Combined with paradigm-service.js for full fetch + summarize:
 *   const ParadigmService = require('./paradigm-service');
 *   const ps = new ParadigmService();
 *   const judge = await ps.fetchParadigmByName('Miriam Mokhemar');
 *   const summary = await summarizer.summarize(judge.philosophy);
 */

const OpenAI = require('openai');

const SYSTEM_PROMPT = [
  'Summarize this judge paradigm as concise bullet points. No transition words, no filler.',
  'Only include bullets that the paradigm clearly supports. Use this checklist:',
  '• Neg Ks — good/bad for kritiks on the neg? Will they vote on the alt? Framework preferences?',
  '• T v K Affs — stance on topicality/framework against critical/non-traditional affs? Do they think affs must defend the resolution/a plan? Topical version of the aff opinions go here. Do they think fairness is an impact or that clash is better than fairness?',
  '• T v Policy — how do they evaluate topicality against policy affs? Appeals to limits, precision, etc.',
  '• CPs — preferences on counterplans? Types they like/dislike? Conditionality views? Preferences on process counterplans? Views on counterplan competition (e.g. textual vs functional)?',
  '• DAs — any preferences on disadvantages? Link quality, uniqueness, turns case?',
  '• Theory — if they say specific args are bad/good (e.g. consult/conditioning/delay CPs, international fiat, 50 state fiat, condo), state exactly which and their opinion. If they say reject-the-arg-not-the-team or reject-the-team, state it.',
  '• Speed — do they dislike speed or have a cap?',
  '• Experience — years judging, coaching background, debate style they competed in',
  '• Non-policy background — if they did LD, PF, parli, speech, or another activity instead of policy, state it',
  '• Speaker points — if they mention a speaker point range, scale, or criteria, state it',
  '• Strong indicators — any auto-rejects, hard preferences, or dealbreakers',
  '• Slop/Tricks — any opinions on slop, tricks, wipe-out arguments, death-good arguments, or cheap shots? State their preference or tolerance',
  'Skip any category with no clear signal. Max 12 bullets. Format: "• Topic: detail"',
].join('\n');

class ParadigmSummarizer {
  /**
   * @param {string} apiKey - OpenAI API key
   * @param {Object} [options]
   * @param {string} [options.model='gpt-4o-mini'] - OpenAI model to use
   * @param {number} [options.temperature=0.15] - LLM temperature
   * @param {number} [options.maxTokens=250] - Max response tokens
   */
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('OpenAI API key is required');
    this.client = new OpenAI({ apiKey });
    this.model = options.model || 'gpt-4o-mini';
    this.temperature = options.temperature ?? 0.15;
    this.maxTokens = options.maxTokens || 250;
  }

  /**
   * Summarize a judge paradigm into concise bullet points.
   *
   * @param {string} philosophyText - Full paradigm text from Tabroom
   * @returns {Promise<string>} Bullet-point summary
   *
   * Example output:
   *   • Neg Ks: Hard for neg to win that aff shouldn't weigh the plan if framework is answered well
   *   • T v K Affs: Aff doesn't need to solve like the plan; neg should justify their model of debate
   *   • T v Policy: Persuaded by negative appeals to limits; fairness is an impact
   *   • CPs: Non-topical CPs acceptable; prefer well-researched mechanisms; 2 condo good, 3 okay
   *   • Theory: Reject the argument not the team; consult/delay CPs, intl fiat, 50 state fiat bad
   *   • Speed: Clarity > speed
   *   • Experience: Former policy debater at University of Georgia ('20), Syracuse Law ('23)
   */
  async summarize(philosophyText) {
    if (!philosophyText || !philosophyText.trim()) {
      return '_No paradigm text available._';
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: philosophyText },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      });

      return response.choices[0]?.message?.content?.trim() || this._truncate(philosophyText);
    } catch (err) {
      console.error(`[ParadigmSummarizer] Failed: ${err.message}`);
      return this._truncate(philosophyText);
    }
  }

  /**
   * Fallback: truncate raw paradigm text.
   */
  _truncate(text) {
    if (!text || !text.trim()) return '_No paradigm text available._';
    const trimmed = text.trim();
    if (trimmed.length <= 500) return trimmed;
    return trimmed.substring(0, 497) + '...';
  }
}

module.exports = ParadigmSummarizer;
