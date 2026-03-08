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

  describe('summarizeArguments', () => {
    let service;

    beforeEach(() => {
      service = new LlmService();
    });

    test('returns fallback message for empty rounds array', () => {
      const result = service.summarizeArguments([], 'A');
      expect(result).toContain('No round reports available');
    });

    test('returns fallback message when rounds have no report text', () => {
      const rounds = [{ tournament: 'Stanford', round: 'R1', report: '' }];
      const result = service.summarizeArguments(rounds, 'A');
      expect(result).toContain('No round reports available');
    });

    test('extracts 1AC arguments for aff side', () => {
      const rounds = [
        { tournament: 'Stanford', round: '1', report: '1ac PNT; 2nr PTX' },
        { tournament: 'Berkeley', round: '2', report: '1ac PNT; 2nr putin' },
        { tournament: 'Greenhill', round: '3', report: 'We ran sci dip; 2nr was sec K' },
      ];
      const result = service.summarizeArguments(rounds, 'A');
      expect(result).toContain('1AC - PNT (2 occurrences)');
      expect(result).toContain('1AC - sci dip (1 occurrence)');
      expect(result).toContain('Most Recent: sci dip - Greenhill, Round 3');
    });

    test('extracts 2NR arguments for neg side', () => {
      const rounds = [
        { tournament: 'Stanford', round: '1', report: '1ac DSM; 2nr WWF cp' },
        { tournament: 'Berkeley', round: '2', report: '1ac PNT; 2nr was china soft' },
        { tournament: 'TOC', round: '3', report: '1ac land trusts; 2nr was T' },
      ];
      const result = service.summarizeArguments(rounds, 'N');
      expect(result).toContain('2NR - WWF cp (1 occurrence)');
      expect(result).toContain('2NR - china soft (1 occurrence)');
      expect(result).toContain('2NR - T (1 occurrence)');
      expect(result).toContain('Most Recent: T - TOC, Round 3');
    });

    test('handles "They ran" format', () => {
      const rounds = [
        { tournament: 'TOC', round: 'R1', report: 'They ran native land trusts; 2nr was T' },
      ];
      const result = service.summarizeArguments(rounds, 'N');
      expect(result).toContain('2NR - T');
    });

    test('deduplicates same arguments (case-insensitive)', () => {
      const rounds = [
        { tournament: 'T1', round: '1', report: '1ac PNT' },
        { tournament: 'T2', round: '2', report: '1ac pnt' },
      ];
      const result = service.summarizeArguments(rounds, 'A');
      expect(result).toContain('2 occurrences');
    });

    test('includes inline doc links when getDownloadUrl is provided', () => {
      const rounds = [
        { tournament: 'Stanford', round: '1', report: '1ac PNT; 2nr PTX', opensource: 'path/to/doc1.docx' },
        { tournament: 'Berkeley', round: '2', report: '1ac PNT; 2nr T' },
        { tournament: 'Greenhill', round: '3', report: '1ac sci dip; 2nr was K', opensource: 'path/to/doc3.docx' },
      ];
      const mockUrl = (path) => `https://dl.example.com/${path}`;
      const result = service.summarizeArguments(rounds, 'A', mockUrl);
      expect(result).toContain('1AC - PNT (2 occurrences) - [Docs](https://dl.example.com/path/to/doc1.docx)');
      expect(result).toContain('1AC - sci dip (1 occurrence) - [Docs](https://dl.example.com/path/to/doc3.docx)');
      expect(result).toContain('Most Recent: sci dip - Greenhill, Round 3');
    });

    test('omits doc link when no opensource field', () => {
      const rounds = [
        { tournament: 'Stanford', round: '1', report: '1ac PNT' },
      ];
      const mockUrl = (path) => `https://dl.example.com/${path}`;
      const result = service.summarizeArguments(rounds, 'A', mockUrl);
      expect(result).not.toContain('[Docs]');
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
    test('uses summarizeArguments (no LLM needed)', () => {
      const service = new LlmService();

      const rounds = [
        { tournament: 'Stanford', round: 'R1', report: '1ac PNT; 2nr PTX' },
      ];
      const result = service.summarizeWithFallback(rounds, 'A');
      expect(result).toContain('1AC - PNT');
      expect(result).toContain('Most Recent');
    });
  });
});
