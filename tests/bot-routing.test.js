// Ensure the Bot constructor doesn't bail on missing credentials.
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || 'test-token';
process.env.JUDGE_DATABASE_ID = process.env.JUDGE_DATABASE_ID || 'test-db';

const Bot = require('../bot');
const TabroomScraper = require('../tabroom-scraper');

describe('Bot._resolveChannelId', () => {
  let bot;
  const session = {
    channelMappings: {
      'Interlake Julia Ye & Aaron Wang': 'CH_WY',
      'Interlake Krishiv Goswami & Oliver Chen': 'CH_GC',
    },
  };

  beforeEach(() => {
    bot = new Bot();
  });

  test('exact key match resolves', () => {
    expect(bot._resolveChannelId(session, 'Interlake Julia Ye & Aaron Wang')).toBe('CH_WY');
  });

  test('case-insensitive match resolves', () => {
    expect(bot._resolveChannelId(session, 'interlake julia ye & aaron wang')).toBe('CH_WY');
  });

  test('collapsed-whitespace match resolves', () => {
    expect(bot._resolveChannelId(session, 'Interlake  Julia Ye  &  Aaron Wang')).toBe('CH_WY');
  });

  test('short-code suffix (WY) match resolves', () => {
    expect(bot._resolveChannelId(session, 'Interlake WY')).toBe('CH_WY');
  });

  test('reversed-initials suffix (YW) match resolves', () => {
    expect(bot._resolveChannelId(session, 'Interlake YW')).toBe('CH_WY');
  });

  test('a different partnership resolves to its own channel', () => {
    expect(bot._resolveChannelId(session, 'Interlake Krishiv Goswami & Oliver Chen')).toBe('CH_GC');
  });

  test('unknown team returns null', () => {
    expect(bot._resolveChannelId(session, 'Interlake Nobody Here')).toBeNull();
  });

  test('missing team code returns null', () => {
    expect(bot._resolveChannelId(session, '')).toBeNull();
    expect(bot._resolveChannelId(session, null)).toBeNull();
  });

  test('empty session mappings returns null', () => {
    expect(bot._resolveChannelId({}, 'Interlake WY')).toBeNull();
    expect(bot._resolveChannelId(null, 'Interlake WY')).toBeNull();
  });
});

describe('Bot.handleMessage judge lookup routing', () => {
  test('treats otherwise unrecognized text as a judge name', async () => {
    const bot = new Bot();
    bot.handleJudgeLookup = jest.fn().mockResolvedValue();
    const message = {
      author: { bot: false },
      content: '<@123> neo cai',
      mentions: { has: jest.fn().mockReturnValue(true) },
      reply: jest.fn(),
    };

    await bot.handleMessage(message);

    expect(bot.handleJudgeLookup).toHaveBeenCalledWith(message, 'neo cai');
    expect(message.reply).not.toHaveBeenCalled();
  });

  test('routes report with a Tabroom entries URL to automated setup', async () => {
    const bot = new Bot();
    bot.handleInitiatePairings = jest.fn().mockResolvedValue();
    bot.handleReport = jest.fn().mockResolvedValue();
    const url = 'https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=1&event_id=2';
    const message = {
      author: { bot: false },
      content: `<@123> report ${url}`,
      mentions: { has: jest.fn().mockReturnValue(true) },
      reply: jest.fn(),
    };

    await bot.handleMessage(message);

    expect(bot.handleInitiatePairings).toHaveBeenCalledWith(message, url);
    expect(bot.handleReport).not.toHaveBeenCalled();
  });

  test('keeps report with a team code routed to manual tracking', async () => {
    const bot = new Bot();
    bot.handleInitiatePairings = jest.fn().mockResolvedValue();
    bot.handleReport = jest.fn().mockResolvedValue();
    const message = {
      author: { bot: false },
      content: '<@123> report SW',
      mentions: { has: jest.fn().mockReturnValue(true) },
      reply: jest.fn(),
    };

    await bot.handleMessage(message);

    expect(bot.handleReport).toHaveBeenCalledWith(message, 'SW');
    expect(bot.handleInitiatePairings).not.toHaveBeenCalled();
  });
});

describe('Bot automatic session caching', () => {
  test('primes opponents and the resolved selected-event judge pool', async () => {
    const bot = new Bot();
    bot._primeOpponentCache = jest.fn().mockResolvedValue({ teamCount: 12, withData: 8 });
    bot._primeParadigmCache = jest.fn().mockResolvedValue({ judgeCount: 20, withParadigm: 15 });
    const resolver = jest.spyOn(TabroomScraper, 'findJudgesUrl')
      .mockResolvedValue('https://www.tabroom.com/index/tourn/judges.mhtml?category_id=9&tourn_id=1');
    const session = {
      tournId: '1',
      eventId: '2',
      tournamentName: 'Test Invitational',
      allEntries: [{ code: 'School AB', entry: 'A & B' }],
    };

    const status = await bot._primeSessionCaches(session, 'hspolicy26');

    expect(bot._primeOpponentCache).toHaveBeenCalledWith(expect.objectContaining({
      tournId: '1',
      eventId: '2',
      entries: session.allEntries,
      caselistSlug: 'hspolicy26',
    }));
    expect(bot._primeParadigmCache).toHaveBeenCalledWith(expect.objectContaining({
      tournId: '1',
      judgesUrl: expect.stringContaining('category_id=9'),
    }));
    expect(status).toEqual([
      '💾 Opponent cache ready: 12 teams (8 with data).',
      '💾 Judge cache ready: 20 judges (15 with paradigms).',
    ]);
    resolver.mockRestore();
  });
});
