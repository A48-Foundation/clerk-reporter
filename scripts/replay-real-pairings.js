const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DISCORD_TOKEN = process.env.E2E_DISCORD_TOKEN || '';
process.env.TABROOM_EMAIL = process.env.E2E_TABROOM_EMAIL || '';
process.env.TABROOM_PASSWORD = process.env.E2E_TABROOM_PASSWORD || '';
process.env.NOTION_TOKEN = process.env.E2E_NOTION_TOKEN || '';
process.env.JUDGE_DATABASE_ID = process.env.E2E_JUDGE_DATABASE_ID || '';
process.env.OPENAI_API_KEY = '';

const { Events } = require('discord.js');
const Bot = require('../bot');
const EmailMonitor = require('../email-monitor');
const TabroomScraper = require('../tabroom-scraper');
const TournamentCache = require('../tournament-cache');

const required = [
  'E2E_GMAIL_EMAIL',
  'E2E_GMAIL_APP_PASSWORD',
  'E2E_DISCORD_TOKEN',
  'E2E_DISCORD_CHANNEL_ID',
  'E2E_TABROOM_EMAIL',
  'E2E_TABROOM_PASSWORD',
  'E2E_NOTION_TOKEN',
  'E2E_JUDGE_DATABASE_ID',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const sender = process.env.REPLAY_FROM || 'midamericacup_1790512207@www.tabroom.com';
const subject = process.env.REPLAY_SUBJECT || 'Round 5 CX';
const expectedRoundFiveParadigms = new Map([
  ['Hunter Harwood', '10849'],
  ['Tyler Zabolio', '229681'],
  ['Stephen Pipkin', '8501'],
]);

async function main() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerk-real-replay-'));
  const targetChannelId = process.env.E2E_DISCORD_CHANNEL_ID;
  const sentMessages = [];
  const processedUids = [];
  let bot;
  let monitor;

  try {
    bot = new Bot();
    await bot.client.login(process.env.E2E_DISCORD_TOKEN);
    if (!bot.client.isReady()) {
      await new Promise(resolve => bot.client.once(Events.ClientReady, resolve));
    }

    const targetChannel = await bot.client.channels.fetch(targetChannelId);
    assert(targetChannel?.isTextBased(), `Discord channel ${targetChannelId} is not text-based`);

    const judgesUrl = await TabroomScraper.findJudgesUrl('40918', '389097');
    assert(
      judgesUrl?.includes('judges.mhtml') && judgesUrl.includes('category_id='),
      `Could not resolve the Mid America Cup selected-event judges page: ${judgesUrl}`,
    );
    console.log(`[REPLAY] Resolved selected-event judges page: ${judgesUrl}`);

    const originalSend = targetChannel.send.bind(targetChannel);
    targetChannel.send = async payload => {
      const message = await originalSend(payload);
      sentMessages.push(message);
      return message;
    };
    const originalFetch = bot.client.channels.fetch.bind(bot.client.channels);
    bot.client.channels.fetch = async id =>
      String(id) === String(targetChannelId) ? targetChannel : originalFetch(id);

    const session = {
      tournId: `real-replay-${Date.now()}`,
      tournamentUrl: 'https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=40918&event_id=389097',
      channelMappings: {},
      processedEmailUids: [],
      reportedPairings: [],
      emailMonitorActive: false,
    };
    bot.store.activeSession = session;
    bot.store.save = () => {};
    bot.store.getSchoolNames = () => ['Interlake'];
    bot.store.getCaselistForTeam = () => 'hspolicy26';
    bot.store.getEntryNamesForTeam = () => null;
    bot.store.getCoaches = () => null;
    bot._mirrorToHQ = async () => {};
    bot.cache = new TournamentCache(cacheDir);

    monitor = new EmailMonitor({
      email: process.env.E2E_GMAIL_EMAIL,
      password: process.env.E2E_GMAIL_APP_PASSWORD,
      searchCriteria: [
        ['FROM', sender],
        ['SUBJECT', subject],
      ],
      markSeen: false,
      maxReconnectDelay: 10000,
    });

    monitor.on('pairing', async eventData => {
      const teamCode = eventData.parsed?.teamCode;
      assert(teamCode?.toLowerCase().startsWith('interlake'), `Unexpected replay team: ${teamCode}`);
      session.channelMappings[teamCode] = targetChannelId;
      await bot.handlePairingEvent(eventData);
      processedUids.push(eventData.uid);
    });

    const pollComplete = new Promise((resolve, reject) => {
      monitor._startPolling = () => {
        monitor.poll().then(resolve, reject);
      };
      monitor.on('error', reject);
    });

    monitor.start();
    await Promise.race([
      pollComplete,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out replaying real pairing emails')), 180000),
      ),
    ]);

    assert(processedUids.length > 0, `No messages matched sender="${sender}" subject="${subject}"`);
    assert.strictEqual(
      sentMessages.length,
      processedUids.length,
      'Each matching real email must produce exactly one Discord report',
    );

    const foundParadigms = new Map();
    for (const message of sentMessages) {
      const delivered = await targetChannel.messages.fetch({ message: message.id, force: true });
      const embeds = delivered.embeds.map(embed => embed.toJSON());
      const pairing = embeds[0];
      assert(pairing?.title, `Message ${message.id} has no pairing embed`);
      const room = (pairing.fields || []).find(field => field.name === 'Room')?.value;
      const start = (pairing.fields || []).find(field => field.name === 'Start')?.value;
      assert(room && room !== 'N/A', `${pairing.title}: missing room`);
      assert(start && start !== 'N/A', `${pairing.title}: missing start time`);
      assert(
        (pairing.fields || []).some(field => field.name.startsWith('🐟 ')),
        `${pairing.title}: missing opponent field`,
      );
      assert(
        embeds.slice(1).some(embed => embed.title?.startsWith('⚖️ ')),
        `${pairing.title}: missing judge embed`,
      );
      for (const judgeEmbed of embeds.slice(1).filter(embed => embed.title?.startsWith('⚖️ '))) {
        const judgeName = judgeEmbed.title.slice('⚖️ '.length);
        const paradigmLink = (judgeEmbed.fields || [])
          .find(field => field.name === 'Paradigm Link')?.value;
        foundParadigms.set(judgeName, paradigmLink);
      }
      console.log(`[REPLAY] Verified ${pairing.title}: room=${room}, start=${start}`);
    }

    if (sender === 'midamericacup_1790512207@www.tabroom.com' && subject === 'Round 5 CX') {
      for (const [judgeName, personId] of expectedRoundFiveParadigms) {
        const link = foundParadigms.get(judgeName);
        assert(
          link?.includes(`judge_person_id=${personId}`),
          `${judgeName}: expected Tabroom paradigm ${personId}, received ${link || 'no judge embed'}`,
        );
        console.log(`[REPLAY] Verified paradigm link for ${judgeName}: judge_person_id=${personId}`);
      }
    }

    console.log(
      `[REPLAY] PASS: ${processedUids.length} real Mid America Cup emails produced ` +
      `${sentMessages.length} verified test-channel reports; Gmail flags were unchanged`,
    );
  } finally {
    if (monitor) monitor.stop();
    if (bot) bot.client.destroy();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[REPLAY] FAIL:', error);
  process.exitCode = 1;
});
