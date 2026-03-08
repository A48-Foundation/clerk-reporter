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

  // ── buildPairingEmbed ──────────────────────────────────────────────

  describe('buildPairingEmbed', () => {
    test('standard pairing data produces correct embed', () => {
      const pairing = {
        roundTitle: 'Round 4 of Policy',
        startTime: '5:30 PST',
        room: 'NSDA Section 18',
        side: 'AFF',
        teamCode: 'Interlake OC',
        aff: { teamCode: 'Interlake OC' },
        neg: { teamCode: 'Coppell PK' },
      };

      const embed = builder.buildPairingEmbed(pairing);

      expect(embed.data.title).toBe('📋 Round 4 of Policy');
      expect(embed.data.color).toBe(0xf5a623);

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      // Our team (Interlake OC) should be bold green
      expect(fieldMap['Aff'].value).toBe('**Interlake OC**');
      expect(fieldMap['Neg'].value).toBe('Coppell PK');
      expect(fieldMap['Room'].value).toBe('NSDA Section 18');
      expect(fieldMap['Start Time'].value).toBe('5:30 PST');
      expect(fieldMap['Our Side'].value).toBe('AFF');
    });

    test('FLIP side and null room produce correct fallbacks', () => {
      const pairing = {
        roundTitle: 'Policy V Quarters',
        room: null,
        side: 'FLIP',
        teamCode: 'Cuttlefish WS',
        aff: { teamCode: 'Cuttlefish WS' },
        neg: { teamCode: 'Reagan FP' },
      };

      const embed = builder.buildPairingEmbed(pairing);

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Room'].value).toBe('N/A');
      expect(fieldMap['Our Side'].value).toBe('FLIP');
      // Our team on aff side should still be highlighted
      expect(fieldMap['Aff'].value).toBe('**Cuttlefish WS**');
      expect(fieldMap['Neg'].value).toBe('Reagan FP');
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
      expect(fieldMap['Aff'].value).toBe('N/A');
      expect(fieldMap['Neg'].value).toBe('N/A');
      expect(fieldMap['Room'].value).toBe('N/A');
      expect(fieldMap['Start Time'].value).toBe('N/A');
      expect(fieldMap['Our Side'].value).toBe('N/A');
    });
  });

  // ── buildOpponentEmbed ─────────────────────────────────────────────

  describe('buildOpponentEmbed', () => {
    test('full opponent data produces correct embed', () => {
      const opponent = {
        schoolName: 'Coppell',
        teamCode: 'PK',
        caselistUrl:
          'https://opencaselist.com/hspolicy25/Coppell/CoppellPK',
        side: 'Neg',
        argumentSummary: '**2NR Analysis**\n• Politics — 3x',
      };

      const embed = builder.buildOpponentEmbed(opponent);

      expect(embed.data.title).toBe('🐟 Opponent: Coppell PK');
      expect(embed.data.color).toBe(0xe74c3c);

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Side'].value).toBe('Neg');
      expect(fieldMap['Caselist'].value).toContain('[OpenCaselist]');
      expect(fieldMap['Caselist'].value).toContain(
        'https://opencaselist.com/hspolicy25/Coppell/CoppellPK',
      );
      expect(fieldMap['Argument Summary'].value).toBe(
        '**2NR Analysis**\n• Politics — 3x',
      );
    });

    test('no caselist URL shows Not found', () => {
      const opponent = {
        schoolName: 'Unknown School',
        teamCode: 'AB',
        side: 'Aff',
      };

      const embed = builder.buildOpponentEmbed(opponent);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Caselist'].value).toBe('Not found');
    });

    test('null input does not throw', () => {
      expect(() => builder.buildOpponentEmbed(null)).not.toThrow();
      expect(() => builder.buildOpponentEmbed(undefined)).not.toThrow();
    });

    test('null input produces sensible defaults', () => {
      const embed = builder.buildOpponentEmbed(null);

      expect(embed.data.title).toBe('🐟 Opponent: Unknown N/A');

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Side'].value).toBe('N/A');
      expect(fieldMap['Caselist'].value).toBe('Not found');
      expect(fieldMap['Argument Summary'].value).toBe('Not found');
    });

    test('argument summary with doc links renders correctly', () => {
      const opponent = {
        schoolName: 'Coppell',
        teamCode: 'PK',
        caselistUrl: 'https://opencaselist.com/hspolicy25/Coppell/CoPk',
        side: 'Aff',
        argumentSummary: '1AC - PNT (3) - [Docs](https://example.com/dl)\nMost Recent: PNT - Stanford, Round 4',
      };
      const embed = builder.buildOpponentEmbed(opponent);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );
      expect(fieldMap['Argument Summary'].value).toContain('[Docs]');
      expect(fieldMap['Argument Summary'].value).toContain('Stanford, Round 4');
      // Only 3 fields: Side, Caselist, Argument Summary
      expect(embed.data.fields).toHaveLength(3);
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
      expect(fieldMap['Paradigm Link'].value).toContain(
        '[View Paradigm]',
      );
      expect(fieldMap['Paradigm Link'].value).toContain(
        'https://tabroom.com/paradigm?id=123',
      );
      expect(fieldMap['Notion Notes'].value).toContain(
        '[View Notes](https://notion.so/abc)',
      );
      expect(fieldMap['Notion Notes'].value).toContain(
        '**1.** Good judge for K debates',
      );
      expect(fieldMap['School']).toBeUndefined();
      expect(fieldMap['Tabroom Link']).toBeUndefined();
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
      const longParadigm = 'A'.repeat(1500);
      const judge = {
        name: 'Verbose Judge',
        paradigmSummary: longParadigm,
      };

      const embed = builder.buildJudgeEmbed(judge);

      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Paradigm Summary'].value.length).toBe(1000);
      expect(fieldMap['Paradigm Summary'].value).toMatch(/\.\.\.$/);
    });

    test('paradigm exactly 1000 chars is not truncated', () => {
      const exactParadigm = 'B'.repeat(1000);
      const judge = {
        name: 'Exact Judge',
        paradigmSummary: exactParadigm,
      };

      const embed = builder.buildJudgeEmbed(judge);
      const fieldMap = Object.fromEntries(
        embed.data.fields.map((f) => [f.name, f]),
      );

      expect(fieldMap['Paradigm Summary'].value).toBe(exactParadigm);
    });

    test('null input does not throw', () => {
      expect(() => builder.buildJudgeEmbed(null)).not.toThrow();
      expect(() => builder.buildJudgeEmbed(undefined)).not.toThrow();
    });
  });

  // ── buildFullReport ────────────────────────────────────────────────

  describe('buildFullReport', () => {
    test('full report with pairing + opponent + 2 judges returns 4 embeds', () => {
      const pairing = {
        roundTitle: 'Round 1',
        side: 'AFF',
        teamCode: 'Team A',
        aff: { teamCode: 'Team A' },
        neg: { teamCode: 'Team B' },
      };
      const opponent = { schoolName: 'School B', teamCode: 'B1' };
      const judges = [
        { name: 'Judge Alpha' },
        { name: 'Judge Beta' },
      ];

      const embeds = builder.buildFullReport(pairing, opponent, judges);

      expect(embeds).toHaveLength(4);
      expect(embeds[0].data.title).toBe('📋 Round 1');
      expect(embeds[1].data.title).toBe('🐟 Opponent: School B B1');
      expect(embeds[2].data.title).toBe('⚖️ Judge Alpha');
      expect(embeds[3].data.title).toBe('⚖️ Judge Beta');
    });

    test('only pairing data returns array of 1 embed', () => {
      const pairing = {
        roundTitle: 'Round 2',
        teamCode: 'X',
        aff: {},
        neg: {},
      };

      const embeds = builder.buildFullReport(pairing, null, null);

      expect(embeds).toHaveLength(1);
      expect(embeds[0].data.title).toBe('📋 Round 2');
    });

    test('11 judges are capped at 10 total embeds', () => {
      const pairing = {
        roundTitle: 'Round 3',
        teamCode: 'Y',
        aff: {},
        neg: {},
      };
      const opponent = { schoolName: 'School X', teamCode: 'XX' };
      const judges = Array.from({ length: 11 }, (_, i) => ({
        name: `Judge ${i + 1}`,
      }));

      const embeds = builder.buildFullReport(pairing, opponent, judges);

      // 1 pairing + 1 opponent + 8 judges = 10
      expect(embeds).toHaveLength(10);
      expect(embeds[0].data.title).toBe('📋 Round 3');
      expect(embeds[1].data.title).toBe('🐟 Opponent: School X XX');
      // Last included judge should be Judge 8
      expect(embeds[9].data.title).toBe('⚖️ Judge 8');
    });

    test('all null returns empty array', () => {
      const embeds = builder.buildFullReport(null, null, null);
      expect(embeds).toEqual([]);
    });

    test('empty judges array returns pairing + opponent only', () => {
      const pairing = { roundTitle: 'R1', teamCode: 'A', aff: {}, neg: {} };
      const opponent = { schoolName: 'S', teamCode: 'T' };

      const embeds = builder.buildFullReport(pairing, opponent, []);
      expect(embeds).toHaveLength(2);
    });
  });
});
