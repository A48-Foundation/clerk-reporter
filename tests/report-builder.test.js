// Mock discord.js EmbedBuilder
jest.mock('discord.js', () => {
  class MockEmbedBuilder {
    constructor() {
      this.data = { title: null, color: null, fields: [], description: null };
    }
    setTitle(t) { this.data.title = t; return this; }
    setColor(c) { this.data.color = c; return this; }
    setDescription(d) { this.data.description = d; return this; }
    addFields(...args) {
      const fields = args.flat();
      this.data.fields.push(...fields);
      return this;
    }
    setURL(u) { this.data.url = u; return this; }
    setTimestamp() { return this; }
  }
  return { EmbedBuilder: MockEmbedBuilder };
});

const ReportBuilder = require('../report-builder');

describe('ReportBuilder', () => {
  let builder;

  beforeEach(() => {
    builder = new ReportBuilder();
  });

  // ── buildPairingEmbed (merged with opponent) ────────────────────────

  describe('buildPairingEmbed', () => {
    test('pairing + opponent produces compact embed', () => {
      const pairing = {
        roundTitle: 'Round 4 of Policy',
        startTime: '5:30 PST',
        room: 'NSDA Section 18',
        side: 'AFF',
        teamCode: 'Interlake OC',
        aff: { teamCode: 'Interlake OC' },
        neg: { teamCode: 'Coppell PK' },
      };
      const opponent = {
        schoolName: 'Coppell',
        teamCode: 'PK',
        caselistUrl: 'https://opencaselist.com/hspolicy25/Coppell/CoPk',
        side: 'Neg',
        argumentSummary: '2NR - Politics (3)',
      };

      const embed = builder.buildPairingEmbed(pairing, opponent);

      expect(embed.data.title).toBe('📋 Round 4 of Policy');
      expect(embed.data.color).toBe(0xf5a623);

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Matchup'].value).toContain('**Interlake OC**');
      expect(fieldMap['Matchup'].value).toContain('Coppell PK');
      expect(fieldMap['Room'].value).toBe('NSDA Section 18');
      expect(fieldMap['Start'].value).toBe('5:30 PST');

      // Opponent info is a field with 🐟
      const oppField = embed.data.fields.find(f => f.name.includes('🐟'));
      expect(oppField).toBeDefined();
      expect(oppField.name).toContain('Coppell PK');
      expect(oppField.name).toContain('Wiki');
      expect(oppField.value).toBe('2NR - Politics (3)');
    });

    test('pairing without opponent shows basic fields', () => {
      const pairing = {
        roundTitle: 'Round 1',
        startTime: '3:00 PM',
        room: 'Room 5',
        side: 'NEG',
        teamCode: 'Team A',
        aff: { teamCode: 'Team B' },
        neg: { teamCode: 'Team A' },
      };

      const embed = builder.buildPairingEmbed(pairing, null);

      expect(embed.data.fields).toHaveLength(3); // Matchup, Room, Start
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Matchup'].value).toContain('**Team A**');
    });

    test('null room and start produce N/A', () => {
      const pairing = {
        roundTitle: 'R2',
        room: null,
        startTime: null,
        side: 'FLIP',
        teamCode: 'X',
        aff: { teamCode: 'X' },
        neg: { teamCode: 'Y' },
      };

      const embed = builder.buildPairingEmbed(pairing);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Room'].value).toBe('N/A');
      expect(fieldMap['Start'].value).toBe('N/A');
    });

    test('null input does not throw', () => {
      expect(() => builder.buildPairingEmbed(null)).not.toThrow();
      expect(() => builder.buildPairingEmbed(undefined)).not.toThrow();
    });

    test('null input produces sensible defaults', () => {
      const embed = builder.buildPairingEmbed(null);
      expect(embed.data.title).toBe('📋 Unknown Round');
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Room'].value).toBe('N/A');
      expect(fieldMap['Start'].value).toBe('N/A');
    });
  });

  // ── buildJudgeEmbed ────────────────────────────────────────────────

  describe('buildJudgeEmbed', () => {
    test('full judge data produces correct embed', () => {
      const judge = {
        name: 'Jenny Liu',
        paradigmSummary: 'Policy judge, prefers tech over truth.',
        paradigmUrl: 'https://tabroom.com/paradigm?id=123',
        notionNotes: '**1.** Good judge for K debates',
        notionUrl: 'https://notion.so/abc',
      };

      const embed = builder.buildJudgeEmbed(judge);

      expect(embed.data.title).toBe('⚖️ Jenny Liu');
      expect(embed.data.color).toBe(0x2f80ed);

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Paradigm Summary'].value).toBe(
        'Policy judge, prefers tech over truth.',
      );
      expect(fieldMap['Paradigm Link'].value).toContain('[View Paradigm]');
      expect(fieldMap['Notion Notes'].value).toContain('[View Notes]');
    });

    test('judge with no paradigm or notion shows minimal embed', () => {
      const judge = { name: 'Some Judge' };
      const embed = builder.buildJudgeEmbed(judge);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Paradigm Summary'].value).toBe('Not found');
      expect(fieldMap['Paradigm Link'].value).toBe('N/A');
      expect(fieldMap['Notion Notes']).toBeUndefined();
    });

    test('paradigm > 1000 chars gets truncated', () => {
      const judge = { name: 'Verbose', paradigmSummary: 'A'.repeat(1500) };
      const embed = builder.buildJudgeEmbed(judge);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Paradigm Summary'].value.length).toBe(1000);
      expect(fieldMap['Paradigm Summary'].value).toMatch(/\.\.\.$/);
    });

    test('paradigm exactly 1000 chars is not truncated', () => {
      const exact = 'B'.repeat(1000);
      const judge = { name: 'Exact', paradigmSummary: exact };
      const embed = builder.buildJudgeEmbed(judge);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Paradigm Summary'].value).toBe(exact);
    });

    test('null input does not throw', () => {
      expect(() => builder.buildJudgeEmbed(null)).not.toThrow();
    });
  });

  // ── buildFullReport ────────────────────────────────────────────────

  describe('buildFullReport', () => {
    test('full report with pairing + opponent + 2 judges returns 3 embeds', () => {
      const pairing = {
        roundTitle: 'Round 1',
        side: 'AFF',
        teamCode: 'Team A',
        aff: { teamCode: 'Team A' },
        neg: { teamCode: 'Team B' },
      };
      const opponent = { schoolName: 'School B', teamCode: 'B1', argumentSummary: 'test' };
      const judges = [{ name: 'Judge Alpha' }, { name: 'Judge Beta' }];

      const embeds = builder.buildFullReport(pairing, opponent, judges);

      // 1 merged pairing+opponent + 2 judges = 3
      expect(embeds).toHaveLength(3);
      expect(embeds[0].data.title).toBe('📋 Round 1');
      expect(embeds[1].data.title).toBe('⚖️ Judge Alpha');
      expect(embeds[2].data.title).toBe('⚖️ Judge Beta');
    });

    test('only pairing data returns 1 embed', () => {
      const pairing = { roundTitle: 'Round 2', teamCode: 'X', aff: {}, neg: {} };
      const embeds = builder.buildFullReport(pairing, null, null);
      expect(embeds).toHaveLength(1);
      expect(embeds[0].data.title).toBe('📋 Round 2');
    });

    test('11 judges are capped at 10 total embeds', () => {
      const pairing = { roundTitle: 'Round 3', teamCode: 'Y', aff: {}, neg: {} };
      const opponent = { schoolName: 'School X', teamCode: 'XX' };
      const judges = Array.from({ length: 11 }, (_, i) => ({ name: `Judge ${i + 1}` }));

      const embeds = builder.buildFullReport(pairing, opponent, judges);

      // 1 merged + 9 judges = 10
      expect(embeds).toHaveLength(10);
      expect(embeds[0].data.title).toBe('📋 Round 3');
      expect(embeds[9].data.title).toBe('⚖️ Judge 9');
    });

    test('all null returns empty array', () => {
      expect(builder.buildFullReport(null, null, null)).toEqual([]);
    });

    test('empty judges array returns pairing only', () => {
      const pairing = { roundTitle: 'R1', teamCode: 'A', aff: {}, neg: {} };
      const embeds = builder.buildFullReport(pairing, null, []);
      expect(embeds).toHaveLength(1);
    });
  });
});
