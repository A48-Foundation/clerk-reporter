const assert = require('assert');
const nodemailer = require('nodemailer');

process.env.DISCORD_TOKEN = process.env.E2E_DISCORD_TOKEN || '';
process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || 'e2e-not-used';
process.env.JUDGE_DATABASE_ID = process.env.JUDGE_DATABASE_ID || 'e2e-not-used';
process.env.OPENAI_API_KEY = '';

const { Events } = require('discord.js');
const Bot = require('../bot');
const EmailMonitor = require('../email-monitor');
const {
  formatA_stanford,
  formatA_flip,
  formatB_multipleEntries,
} = require('../tests/fixtures/emails');

const required = [
  'E2E_GMAIL_EMAIL',
  'E2E_GMAIL_APP_PASSWORD',
  'E2E_DISCORD_TOKEN',
  'E2E_DISCORD_CHANNEL_ID',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const FULL_NAMES = {
  input: {
    subject: '[TAB] Interlake Shreshth Seth & Aanya Chetan Round 3 CX',
    body: [
      'Round 3 of Policy',
      'Start: 1:30 CDT',
      '',
      'Room: NSDA Campus Section 13',
      '',
      'Side: AFF',
      '',
      'Competitors',
      '',
      'AFF Interlake Shreshth Seth & Aanya Chetan',
      '',
      'NEG Lowell Benjamin Chan & Paxson Yee Smith',
      '',
      'Judging',
      '',
      'Miriam Mokhemar',
      '',
      '-----------------------------',
      'You received this email because you registered for an account on https://www.tabroom.com',
    ].join('\n'),
  },
};

const CASES = [
  {
    name: 'live update with short codes',
    email: formatA_stanford.input,
    expected: {
      title: '📋 R4',
      room: 'NSDA Campus Section 18',
      opponent: 'Arizona Chandler Independent LS',
      judges: ['Evan Alexis'],
    },
  },
  {
    name: 'live update with full debater names',
    email: FULL_NAMES.input,
    expected: {
      title: '📋 R3',
      room: 'NSDA Campus Section 13',
      opponent: 'Lowell Benjamin Chan & Paxson Yee Smith',
      judges: ['Miriam Mokhemar'],
    },
  },
  {
    name: 'round assignments entry 1',
    email: formatB_multipleEntries.input,
    expected: { title: '📋 R3', room: '101', opponent: 'Coppell PK', judges: ['Bob Jones'] },
  },
  {
    name: 'round assignments entry 2',
    email: null,
    expected: {
      title: '📋 R3',
      room: '205',
      opponent: 'Montgomery Bell MB',
      judges: ['Alice Chen', 'David Lee'],
    },
  },
  {
    name: 'FLIP pairing',
    email: formatA_flip.input,
    expected: {
      title: '📋 Doubles of Policy - TOC',
      room: 'NSDA Campus Section 6',
      opponent: 'Peninsula BB',
      judges: ['Evan Alexis', 'Eli Hatton', 'Jayden Sampat'],
    },
  },
];

const EMAILS = CASES.filter(testCase => testCase.email).map(testCase => testCase.email);

function plusAddress(email, tag) {
  const at = email.lastIndexOf('@');
  if (at <= 0) throw new Error('E2E_GMAIL_EMAIL must be a valid email address');
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

function fieldValue(embed, name) {
  return embed.fields.find(field => field.name === name)?.value;
}

async function waitFor(condition, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function retry(label, operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = attempt * 3000;
      console.warn(`[E2E] ${label} failed (${error.code || error.message}); retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function main() {
  const runId = `clerk-e2e-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}`;
  const recipient = plusAddress(process.env.E2E_GMAIL_EMAIL, runId);
  const targetChannelId = process.env.E2E_DISCORD_CHANNEL_ID;
  const sentMessages = [];
  const receivedUids = new Set();
  const processingErrors = [];
  let monitor;
  let bot;

  try {
    bot = new Bot();
    await bot.client.login(process.env.E2E_DISCORD_TOKEN);
    if (!bot.client.isReady()) {
      await new Promise(resolve => bot.client.once(Events.ClientReady, resolve));
    }

    const targetChannel = await bot.client.channels.fetch(targetChannelId);
    assert(targetChannel?.isTextBased(), `Discord channel ${targetChannelId} is not text-based`);

    const originalSend = targetChannel.send.bind(targetChannel);
    targetChannel.send = async payload => {
      const message = await originalSend(payload);
      sentMessages.push(message);
      return message;
    };
    const originalFetch = bot.client.channels.fetch.bind(bot.client.channels);
    bot.client.channels.fetch = async id =>
      String(id) === String(targetChannelId) ? targetChannel : originalFetch(id);

    bot.store.activeSession = {
      tournId: `e2e-${runId}`,
      tournamentUrl: 'https://example.invalid/e2e',
      channelMappings: {
        'Interlake OC': targetChannelId,
        'Interlake Shreshth Seth & Aanya Chetan': targetChannelId,
        'Interlake CG': targetChannelId,
        'Interlake SW': targetChannelId,
      },
      processedEmailUids: [],
      reportedPairings: [],
      emailMonitorActive: false,
    };
    bot.store.save = () => {};
    bot.store.getSchoolNames = () => ['Interlake'];
    bot.store.getCaselistForTeam = () => 'hspolicy26';
    bot.store.getEntryNamesForTeam = () => null;
    bot.store.getCoaches = () => null;
    bot._lookupOpponentCached = async () => ({ rounds: [] });
    bot._fetchParadigmCached = async () => null;
    bot.notion.searchJudge = async () => [];
    bot._mirrorToHQ = async () => {};

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.E2E_GMAIL_EMAIL,
        pass: process.env.E2E_GMAIL_APP_PASSWORD,
      },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
    });
    await retry('SMTP verification', () => transporter.verify());

    for (const email of EMAILS) {
      await retry(`sending ${email.subject}`, () =>
        transporter.sendMail({
          from: process.env.E2E_GMAIL_EMAIL,
          to: recipient,
          subject: email.subject,
          text: email.body,
          headers: { 'X-Clerk-E2E-Run': runId },
        }),
      );
      console.log(`[E2E] Sent: ${email.subject}`);
    }
    transporter.close();

    monitor = new EmailMonitor({
      email: process.env.E2E_GMAIL_EMAIL,
      password: process.env.E2E_GMAIL_APP_PASSWORD,
      searchCriteria: [['TO', recipient]],
      markSeen: false,
      pollInterval: 3000,
      maxReconnectDelay: 10000,
    });

    let processing = Promise.resolve();
    monitor.on('pairing', eventData => {
      if (receivedUids.has(eventData.uid)) return;
      receivedUids.add(eventData.uid);
      processing = processing
        .then(() => bot.handlePairingEvent(eventData))
        .catch(error => processingErrors.push(error));
    });
    monitor.on('error', error => processingErrors.push(error));
    monitor.start();

    await waitFor(
      () => receivedUids.size === EMAILS.length && sentMessages.length === CASES.length,
      180000,
      `${EMAILS.length} Gmail messages and ${CASES.length} Discord reports`,
    );
    await processing;
    if (processingErrors.length) throw processingErrors[0];

    const delivered = [];
    for (const message of sentMessages) {
      delivered.push(await targetChannel.messages.fetch(message.id));
    }
    assert.strictEqual(delivered.length, CASES.length);

    for (const testCase of CASES) {
      const match = delivered.find(message => {
        const pairing = message.embeds[0]?.toJSON();
        return pairing?.title === testCase.expected.title &&
          fieldValue(pairing, 'Room') === testCase.expected.room;
      });
      assert(match, `${testCase.name}: no Discord message matched title/room`);
      const embeds = match.embeds.map(embed => embed.toJSON());
      const pairingFields = embeds[0].fields || [];
      assert(
        pairingFields.some(field => field.name.includes(testCase.expected.opponent)),
        `${testCase.name}: pairing embed did not identify opponent ${testCase.expected.opponent}`,
      );
      for (const judge of testCase.expected.judges) {
        assert(
          embeds.some(embed => embed.title === `⚖️ ${judge}`),
          `${testCase.name}: missing judge embed for ${judge}`,
        );
      }
      console.log(`[E2E] Verified Discord output: ${testCase.name}`);
    }

    console.log(`[E2E] PASS: ${EMAILS.length} emails produced ${CASES.length} verified Discord reports`);
  } finally {
    if (monitor) monitor.stop();
    if (bot) bot.client.destroy();
  }
}

main().catch(error => {
  console.error('[E2E] FAIL:', error);
  process.exitCode = 1;
});
