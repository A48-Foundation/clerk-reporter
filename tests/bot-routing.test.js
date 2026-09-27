// Ensure the Bot constructor doesn't bail on missing credentials.
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || 'test-token';
process.env.JUDGE_DATABASE_ID = process.env.JUDGE_DATABASE_ID || 'test-db';

const Bot = require('../bot');

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
});
