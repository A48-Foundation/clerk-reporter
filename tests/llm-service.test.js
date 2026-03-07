jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'Mocked LLM summary' } }],
        }),
      },
    },
  }));
});

const LlmService = require('../llm-service');

describe('LlmService', () => {
  let originalApiKey;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  describe('basicFrequencyAnalysis', () => {
    let service;

    beforeEach(() => {
      service = new LlmService();
    });

    test('returns fallback message for empty rounds array', () => {
      const result = service.basicFrequencyAnalysis([], 'A');
      expect(result).toBe('_No round reports available for analysis._');
    });

    test('returns fallback message when rounds have no report text', () => {
      const rounds = [{ tournament: 'Stanford', round: 'R1', report: '' }];
      const result = service.basicFrequencyAnalysis(rounds, 'A');
      expect(result).toBe('_No round reports available for analysis._');
    });

    test('produces 1AC frequency analysis for aff side', () => {
      const rounds = [
        { tournament: 'Stanford', round: 'R1', report: '1AC: hegemony advantage with economy impact' },
        { tournament: 'Berkeley', round: 'R2', report: '1AC: hegemony with prolif advantage' },
        { tournament: 'Greenhill', round: 'R3', report: '1AC: warming advantage plan to reduce emissions' },
      ];
      const result = service.basicFrequencyAnalysis(rounds, 'A');
      expect(result).toContain('**1AC Frequency Analysis**');
      expect(result).toMatch(/• \*\*heg/);
      expect(result).toContain('Most common');
    });

    test('produces 2NR frequency analysis for neg side', () => {
      const rounds = [
        { tournament: 'Stanford', round: 'R1', report: '2NR: went for the politics DA' },
        { tournament: 'Berkeley', round: 'R2', report: '2NR: collapsed to capitalism K' },
        { tournament: 'Greenhill', round: 'R3', report: '2NR: went for politics disad and states cp' },
      ];
      const result = service.basicFrequencyAnalysis(rounds, 'N');
      expect(result).toContain('**2NR Frequency Analysis**');
      expect(result).toMatch(/• \*\*politics/);
      expect(result).toContain('Most common');
    });

    test('detects topicality and framework keywords', () => {
      const rounds = [
        { tournament: 'TOC', round: 'R1', report: 'Neg ran topicality and framework against the aff' },
      ];
      const result = service.basicFrequencyAnalysis(rounds, 'N');
      expect(result).toContain('topicality');
      expect(result).toContain('framework');
    });
  });

  describe('_truncateParadigm', () => {
    let service;

    beforeEach(() => {
      service = new LlmService();
      expect(service.enabled).toBe(false);
    });

    test('returns short text as-is', () => {
      const text = 'I evaluate debates based on the flow.';
      expect(service._truncateParadigm(text)).toBe(text);
    });

    test('truncates text longer than 500 characters', () => {
      const longText = 'A'.repeat(600);
      const result = service._truncateParadigm(longText);
      expect(result).toHaveLength(500);
      expect(result).toMatch(/\.\.\.$/);
    });

    test('returns fallback for empty string', () => {
      expect(service._truncateParadigm('')).toBe('_No paradigm text available._');
    });

    test('returns fallback for null', () => {
      expect(service._truncateParadigm(null)).toBe('_No paradigm text available._');
    });
  });

  describe('summarizeWithFallback', () => {
    test('falls back to basicFrequencyAnalysis when no API key', async () => {
      const service = new LlmService();
      expect(service.enabled).toBe(false);

      const rounds = [
        { tournament: 'Stanford', round: 'R1', report: '1AC: hegemony advantage' },
      ];
      const result = await service.summarizeWithFallback(rounds, 'A');
      expect(result).toContain('**1AC Frequency Analysis**');
      expect(result).toMatch(/heg/);
    });
  });
});
