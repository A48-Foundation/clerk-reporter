process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || 'test-token';
process.env.JUDGE_DATABASE_ID = process.env.JUDGE_DATABASE_ID || 'test-db';

jest.mock('../email-monitor', () => {
  const { EventEmitter } = require('events');
  return class MockEmailMonitor extends EventEmitter {
    static instances = [];
    constructor() {
      super();
      this.start = jest.fn();
      this.stop = jest.fn();
      this.enterSlowMode = jest.fn();
      MockEmailMonitor.instances.push(this);
    }
  };
});

const Bot = require('../bot');
const ChannelMapper = require('../channel-mapper');
const EmailMonitor = require('../email-monitor');
const TabroomScraper = require('../tabroom-scraper');

function mentionedMessage(content, channel, reply) {
  return {
    author: { id: 'USER', bot: false },
    content: `<@123> ${content}`,
    channel,
    mentions: { has: jest.fn().mockReturnValue(true) },
    reply,
  };
}

describe('report command E2E flows', () => {
  let bot;
  let channel;
  let sentMessage;

  beforeEach(() => {
    EmailMonitor.instances.length = 0;
    sentMessage = { edit: jest.fn().mockResolvedValue() };
    channel = {
      id: 'CHANNEL',
      name: 'st-tournaments',
      isTextBased: () => true,
      sendTyping: jest.fn().mockResolvedValue(),
      send: jest.fn().mockResolvedValue(sentMessage),
    };
    bot = new Bot();
    bot.channelMapper = new ChannelMapper(bot.client);
    bot.store.save = jest.fn();
    bot.client.channels.fetch = jest.fn().mockResolvedValue(channel);
    bot._mirrorToHQ = jest.fn().mockResolvedValue();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try { await bot.client.destroy(); } catch (_) { /* not logged in */ }
  });

  test('report entries command confirms monitoring and delivers a pairing report', async () => {
    const url = 'https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=40450&event_id=384733';
    jest.spyOn(TabroomScraper, 'scrapeEntries').mockResolvedValue({
      tournamentName: 'Test Invitational',
      events: [],
      entries: [
        { school: 'Ducks Independent', entry: 'Shen & Tran', code: 'Ducks Independent ST' },
      ],
    });
    bot.channelMapper.autoMap = jest.fn().mockResolvedValue({
      'Ducks Independent ST': {
        channelId: channel.id,
        channelName: channel.name,
        confidence: 'auto',
      },
    });
    bot._primeSessionCaches = jest.fn().mockResolvedValue([
      '💾 Opponent cache ready: 1 teams (1 with data).',
      '💾 Judge cache ready: 1 judges (1 with paradigms).',
    ]);
    bot._lookupOpponentCached = jest.fn().mockResolvedValue(null);
    bot._fetchParadigmCached = jest.fn().mockResolvedValue(null);
    bot.notion.searchJudge = jest.fn().mockResolvedValue([]);

    const setupMessage = { edit: jest.fn().mockResolvedValue() };
    const message = mentionedMessage(`report ${url}`, channel, jest.fn().mockResolvedValue(setupMessage));
    await bot.handleMessage(message);

    expect(bot._pendingSession.mapping['Ducks Independent ST'].channelName).toBe('st-tournaments');

    const interaction = {
      customId: 'pairings_confirm',
      update: jest.fn().mockResolvedValue(),
      editReply: jest.fn().mockResolvedValue(),
    };
    await bot.handleButtonInteraction(interaction);

    expect(EmailMonitor.instances).toHaveLength(1);
    expect(EmailMonitor.instances[0].start).toHaveBeenCalled();

    const pairingListener = EmailMonitor.instances[0].listeners('pairing')[0];
    await pairingListener({
      uid: 1,
      parsed: {
        format: 'liveUpdate',
        teamCode: 'Ducks Independent ST',
        roundNumber: 1,
        roundTitle: 'Round 1 of Open Policy',
        startTime: '8:00 AM',
        room: '101',
        side: 'AFF',
        aff: { teamCode: 'Ducks Independent ST', names: ['Shen', 'Tran'] },
        neg: { teamCode: 'Opponent AB', names: [] },
        judges: [{ name: 'Test Judge', pronouns: null }],
      },
    });

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));
  });

  test('report coaches command stores a coach and delivers their assignment report', async () => {
    bot.store.activeSession = {
      tournId: '40450',
      channelMappings: {},
      processedEmailUids: [],
      reportedPairings: [],
      emailMonitorActive: true,
    };
    bot.store.setSchoolNames(['Ducks Independent']);
    bot.paradigmService.fetchPage = jest.fn().mockResolvedValue(`
      <table id="judgelist">
        <tr><th>Paradigm</th><th>First</th><th>Last</th><th>Institution</th></tr>
        <tr>
          <td></td><td>Jamie</td><td>Coach</td>
          <td data-text="Ducks Independent">Ducks Independent</td>
        </tr>
      </table>
    `);
    const url = 'https://www.tabroom.com/index/tourn/judges.mhtml?category_id=107987&tourn_id=40450';
    const message = mentionedMessage(`report coaches ${url}`, channel, jest.fn().mockResolvedValue());

    await bot.handleMessage(message);

    expect(bot.store.getCoaches()).toEqual({
      channelId: channel.id,
      coaches: [{ name: 'Jamie Coach', institution: 'Ducks Independent' }],
    });

    await bot.handlePairingEvent({
      uid: 2,
      parsed: {
        format: 'liveUpdate',
        teamCode: 'Jamie Coach',
        roundNumber: 2,
        roundTitle: 'Round 2 of Open Policy',
        startTime: '10:00 AM',
        room: '202',
        side: 'AFF',
        aff: { teamCode: 'School AA', names: [] },
        neg: { teamCode: 'School BB', names: [] },
        judges: [{ name: 'Jamie Coach', pronouns: null }],
      },
    });

    const coachPayload = channel.send.mock.calls
      .map(call => call[0])
      .find(payload => payload.embeds?.[0]?.data?.title?.startsWith('🧑‍🏫 Jamie Coach'));
    expect(coachPayload).toBeDefined();
    expect(coachPayload.embeds[0].data.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '📍 Room', value: '202' }),
    ]));
  });
});
