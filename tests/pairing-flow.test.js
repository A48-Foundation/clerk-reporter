// End-to-end test of the email → Discord pairing pipeline.
//
// Drives the real EmailParser and the real Bot.handlePairingEvent /
// _processSinglePairing logic, stubbing only the external edges (Discord
// client, Notion, caselist, LLM, IMAP). This guards the whole chain that has
// repeatedly regressed: parsing full-name team codes, resolving the channel,
// dedup-only-after-send, and restoring the email monitor on startup.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || 'test-token';
process.env.JUDGE_DATABASE_ID = process.env.JUDGE_DATABASE_ID || 'test-db';

// Prevent any real IMAP connection: replace EmailMonitor with a mock class.
jest.mock('../email-monitor', () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    enterSlowMode: jest.fn(),
  }))
);

const EmailMonitor = require('../email-monitor');
const EmailParser = require('../email-parser');
const Bot = require('../bot');

const ROUND3_BODY = `Round 3 of Policy
Start: 1:30 CDT

Room: NSDA Campus Section 13

Side: AFF

Competitors

AFF Interlake Shreshth Seth & Aanya Chetan

NEG Lowell Benjamin Chan & Paxson Yee Smith

Judging

Miriam Mokhemar

-----------------------------

You received this email because you registered for an account on https://www.tabroom.com
`;

function parseRound3() {
  return EmailParser.parse({
    subject: '[TAB] Interlake Shreshth Seth & Aanya Chetan Round 3 CX',
    from: 'Mid America Cup <x@www.tabroom.com>',
    body: ROUND3_BODY,
  });
}

const activeBots = [];

function makeBot({ channelMappings = {}, schoolNames = ['Interlake'] } = {}) {
  const bot = new Bot();
  activeBots.push(bot);

  const session = {
    tournId: 'T1',
    tournamentUrl: 'https://www.tabroom.com/x',
    channelMappings,
    processedEmailUids: [],
    reportedPairings: [],
    emailMonitorActive: true,
  };

  // Back the real store methods with an in-memory session (so dedup /
  // processed-uid logic runs for real) and neutralise disk + config lookups.
  bot.store.activeSession = session;
  bot.store.save = () => {};
  bot.store.getSchoolNames = () => schoolNames;
  bot.store.getCaselistForTeam = () => 'hspolicy26';
  bot.store.getEntryNamesForTeam = () => null;
  bot.store.getCoaches = () => null;

  // Stub external network edges.
  bot.notion.searchJudge = jest.fn(async () => []);
  bot._fetchParadigmCached = jest.fn(async () => null);
  bot._lookupOpponentCached = jest.fn(async () => null);
  bot._mirrorToHQ = jest.fn(async () => {});

  // Fake Discord channel + client.
  const sentMessage = { edit: jest.fn(async () => {}) };
  const channel = {
    send: jest.fn(async () => sentMessage),
    sendTyping: jest.fn(async () => {}),
  };
  const fetchedIds = [];
  bot.client.channels = {
    fetch: jest.fn(async (id) => {
      fetchedIds.push(id);
      return channel;
    }),
  };

  return { bot, session, channel, sentMessage, fetchedIds };
}

afterEach(async () => {
  while (activeBots.length) {
    const bot = activeBots.pop();
    try { await bot.client.destroy(); } catch (_) { /* not logged in */ }
  }
  EmailMonitor.mockClear();
});

describe('pairing pipeline — parse → route → send', () => {
  test('a full-name team email is parsed completely', () => {
    const parsed = parseRound3();
    expect(parsed.aff.teamCode).toBe('Interlake Shreshth Seth & Aanya Chetan');
    expect(parsed.neg.teamCode).toBe('Lowell Benjamin Chan & Paxson Yee Smith');
    expect(parsed.side).toBe('AFF');
    expect(parsed.judges.map(j => j.name)).toContain('Miriam Mokhemar');
    expect(EmailParser._isCompletePairing(parsed)).toBe(true);
  });

  test('sends a report to the exactly-mapped channel', async () => {
    const { bot, channel, fetchedIds } = makeBot({
      channelMappings: { 'Interlake Shreshth Seth & Aanya Chetan': 'CH_INT' },
    });

    await bot.handlePairingEvent({ uid: 1, parsed: parseRound3() });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(fetchedIds).toContain('CH_INT');
    const payload = channel.send.mock.calls[0][0];
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds.length).toBeGreaterThan(0);
  });

  test('resolves the channel by debater-initial suffix when the mapping key differs', async () => {
    // Setup used a short code; the email uses full names.
    const { bot, channel, fetchedIds } = makeBot({
      channelMappings: { 'Interlake SC': 'CH_SC' },
    });

    await bot.handlePairingEvent({ uid: 1, parsed: parseRound3() });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(fetchedIds).toContain('CH_SC');
  });

  test('does not resend the same team+round (dedup)', async () => {
    const { bot, channel } = makeBot({
      channelMappings: { 'Interlake Shreshth Seth & Aanya Chetan': 'CH_INT' },
    });

    await bot.handlePairingEvent({ uid: 1, parsed: parseRound3() });
    await bot.handlePairingEvent({ uid: 2, parsed: parseRound3() }); // new email, same round

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('a failed send stays retriable (not marked reported)', async () => {
    const { bot, session, channel } = makeBot({ channelMappings: {} }); // no channel → cannot send

    await bot.handlePairingEvent({ uid: 1, parsed: parseRound3() });
    expect(channel.send).not.toHaveBeenCalled();
    expect(session.reportedPairings).toHaveLength(0);

    // Operator fixes the mapping; a re-delivered email now sends.
    session.channelMappings['Interlake Shreshth Seth & Aanya Chetan'] = 'CH_INT';
    await bot.handlePairingEvent({ uid: 2, parsed: parseRound3() });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(session.reportedPairings).toHaveLength(1);
  });

  test('ignores an email when there is no active session', async () => {
    const { bot, channel } = makeBot({
      channelMappings: { 'Interlake Shreshth Seth & Aanya Chetan': 'CH_INT' },
    });
    bot.store.activeSession = null;

    await bot.handlePairingEvent({ uid: 1, parsed: parseRound3() });
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('email monitor restore on startup', () => {
  test('starts the monitor when a session is active', () => {
    const { bot } = makeBot();
    EmailMonitor.mockClear();

    bot._restoreEmailMonitor();

    expect(EmailMonitor).toHaveBeenCalledTimes(1);
    const instance = EmailMonitor.mock.results[0].value;
    expect(instance.start).toHaveBeenCalledTimes(1);
  });

  test('does nothing without an active session', () => {
    const { bot } = makeBot();
    bot.store.activeSession = null;
    EmailMonitor.mockClear();

    bot._restoreEmailMonitor();

    expect(EmailMonitor).not.toHaveBeenCalled();
  });
});
