const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');

process.env.DISCORD_TOKEN = process.env.E2E_DISCORD_TOKEN || '';
process.env.TABROOM_EMAIL = process.env.E2E_TABROOM_EMAIL || '';
process.env.TABROOM_PASSWORD = process.env.E2E_TABROOM_PASSWORD || '';
process.env.NOTION_TOKEN = process.env.E2E_NOTION_TOKEN || '';
process.env.JUDGE_DATABASE_ID = process.env.E2E_JUDGE_DATABASE_ID || '';
process.env.OPENAI_API_KEY = '';

const { Events } = require('discord.js');
const Bot = require('../bot');
const EmailMonitor = require('../email-monitor');
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

function liveUpdate({
  team,
  opponent,
  round,
  side,
  room,
  judges,
  start = '1:30 CDT',
  event = 'CX',
}) {
  const aff = side === 'NEG' ? opponent : team;
  const neg = side === 'NEG' ? team : opponent;
  return {
    subject: `[TAB] ${team} Round ${round} ${event}`,
    body: [
      `Round ${round} of Policy`,
      `Start: ${start}`,
      '',
      `Room: ${room}`,
      '',
      `Side: ${side}`,
      '',
      'Competitors',
      '',
      `AFF ${aff}`,
      '',
      `NEG ${neg}`,
      '',
      'Judging',
      '',
      ...judges.flatMap((judge, index) => index === 0 ? [judge] : ['', judge]),
      '',
      '-----------------------------',
      'You received this email because you registered for an account on https://www.tabroom.com',
    ].join('\n'),
  };
}

function flipUpdate({ team, opponent, room, judges }) {
  return {
    subject: `[TAB] ${team} Doubles CX`,
    body: [
      'Doubles of Policy',
      'Start: 3:30 CDT',
      '',
      `Room: ${room}`,
      '',
      'Competitors',
      '',
      'FLIP FOR SIDES:',
      '',
      team,
      '',
      opponent,
      '',
      'Judging',
      '',
      ...judges.flatMap((judge, index) => index === 0 ? [judge] : ['', judge]),
    ].join('\n'),
  };
}

const assignmentEmail = {
  subject: '[TAB] Interlake Round Assignments',
  body: [
    'Full assignments for Interlake',
    '',
    'Policy Open Round 44 Start 2:30 PM',
    '',
    'ENTRIES',
    'Interlake AA',
    '         AFF vs Assign Opponent AO',
    '        Judges: Assignment One     Room 401',
    'Interlake BB',
    '         NEG vs Assign Opponent BO',
    '        Judges: Assignment Two, Assignment Three     Room 402',
    '',
    '-----------------------------',
  ].join('\n'),
};

const malformedEmail = {
  subject: '[TAB] Interlake MF Round 46 CX',
  body: [
    'PAIRING DATA (nonstandard export)',
    'Interlake MF debates Odd Format OF at 4:00 PM in Room 406.',
    'Interlake MF is affirmative. Adjudicator: Fallback Judge.',
  ].join('\n'),
};

const scenarios = [
  {
    key: 'cache-hit',
    email: liveUpdate({
      team: 'Interlake CH',
      opponent: 'Cache Academy CH',
      round: 41,
      side: 'AFF',
      room: '401A',
      judges: ['Cached Judge'],
    }),
    reports: [{
      title: 'R41: Aff v. Cache Academy CH (Neg)',
      room: '401A',
      opponent: 'Cache Academy CH',
      caselist: true,
      judges: [{ name: 'Cached Judge', paradigm: true, comments: true }],
    }],
  },
  {
    key: 'duplicate-cache-hit',
    duplicateOf: 'cache-hit',
  },
  {
    key: 'cached-miss-normalized-route',
    email: liveUpdate({
      team: 'Interlake NM',
      opponent: 'No Data ND',
      round: 42,
      side: 'NEG',
      room: '402A',
      judges: ['Missing Judge', 'Second Judge'],
    }),
    reports: [{
      title: 'R42: Neg v. No Data ND (Aff)',
      room: '402A',
      opponent: 'No Data ND',
      caselist: false,
      judges: [
        { name: 'Missing Judge', paradigm: false, comments: false },
        { name: 'Second Judge', paradigm: true, comments: false },
      ],
    }],
  },
  {
    key: 'full-names-initials-route-live-fallback',
    email: liveUpdate({
      team: 'Interlake Shreshth Seth & Aanya Chetan',
      opponent: 'Live Academy Alice Alpha & Bob Beta',
      round: 43,
      side: 'AFF',
      room: '403A',
      judges: ['Live Fallback Judge'],
    }),
    reports: [{
      title: 'R43: Aff v. Live Academy Alice Alpha & Bob Beta (Neg)',
      room: '403A',
      opponent: 'Live Academy Alice Alpha & Bob Beta',
      caselist: true,
      judges: [{ name: 'Live Fallback Judge', paradigm: true, comments: true }],
    }],
  },
  {
    key: 'multi-team-assignments',
    email: assignmentEmail,
    reports: [
      {
        title: 'R44: Aff v. Assign Opponent AO (Neg)',
        room: '401',
        opponent: 'Assign Opponent AO',
        caselist: true,
        judges: [{ name: 'Assignment One', paradigm: true, comments: false }],
      },
      {
        title: 'R44: Neg v. Assign Opponent BO (Aff)',
        room: '402',
        opponent: 'Assign Opponent BO',
        caselist: true,
        judges: [
          { name: 'Assignment Two', paradigm: true, comments: false },
          { name: 'Assignment Three', paradigm: false, comments: false },
        ],
      },
    ],
  },
  {
    key: 'flip',
    email: flipUpdate({
      team: 'Interlake FL',
      opponent: 'Flip Opponent FO',
      room: '405A',
      judges: ['Flip Judge'],
    }),
    reports: [{
      title: 'Doubles of Policy: FLIP v. Flip Opponent FO (FLIP)',
      room: '405A',
      opponent: 'Flip Opponent FO',
      caselist: true,
      judges: [{ name: 'Flip Judge', paradigm: true, comments: false }],
    }],
  },
  {
    key: 'malformed-rejected',
    email: malformedEmail,
  },
  {
    key: 'failed-route',
    email: liveUpdate({
      team: 'Interlake RT',
      opponent: 'Retry Opponent RO',
      round: 47,
      side: 'AFF',
      room: '407A',
      judges: ['Retry Judge'],
    }),
  },
  {
    key: 'failed-route-retry',
    duplicateOf: 'failed-route',
    reports: [{
      title: 'R47: Aff v. Retry Opponent RO (Neg)',
      room: '407A',
      opponent: 'Retry Opponent RO',
      caselist: true,
      judges: [{ name: 'Retry Judge', paradigm: true, comments: false }],
    }],
  },
  {
    key: 'live-external-contract',
    email: liveUpdate({
      team: 'Interlake LC',
      opponent: 'Coppell PK',
      round: 48,
      side: 'AFF',
      room: '408A',
      judges: ['Tom Mickelson'],
    }),
    reports: [{
      title: 'R48: Aff v. Coppell PK (Neg)',
      room: '408A',
      opponent: 'Coppell PK',
      caselist: true,
      liveCaselist: true,
      judges: [{
        name: 'Tom Mickelson',
        paradigm: true,
        liveParadigm: true,
        comments: true,
        liveNotion: true,
      }],
    }],
  },
];

const byKey = new Map(scenarios.map(scenario => [scenario.key, scenario]));
for (const scenario of scenarios) {
  if (scenario.duplicateOf) scenario.email = byKey.get(scenario.duplicateOf).email;
}
const expectedReports = scenarios.flatMap(scenario => scenario.reports || []);
const liveCoachJudgesUrl =
  'https://www.tabroom.com/index/tourn/judges.mhtml?category_id=109213&tourn_id=40918';

function plusAddress(email, tag) {
  const at = email.lastIndexOf('@');
  if (at <= 0) throw new Error('E2E_GMAIL_EMAIL must be a valid email address');
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

function fieldValue(embed, name) {
  return (embed.fields || []).find(field => field.name === name)?.value;
}

function syntheticLookup(teamCode, side) {
  const slug = teamCode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    schoolName: teamCode,
    teamCode: '',
    teamSlug: slug,
    caselistUrl: `https://opencaselist.com/hspolicy26/e2e/${slug}/${side === 'A' ? 'Aff' : 'Neg'}`,
    rounds: [{
      tournament: 'E2E Tournament',
      round: 'Test',
      report: side === 'A' ? '1AC was test affirmative' : '2NR was test negative',
    }],
  };
}

function syntheticParadigm(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    name,
    school: 'E2E',
    philosophy: 'Synthetic paradigm content for deterministic branch coverage.',
    paradigmUrl: `https://www.tabroom.com/index/paradigm.mhtml?judge_person_id=e2e-${slug}`,
  };
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

function assertReport(message, expected) {
  const embeds = message.embeds.map(embed => embed.toJSON());
  const pairing = embeds[0];
  assert.strictEqual(pairing.title, expected.title);
  assert.strictEqual(fieldValue(pairing, 'Room'), expected.room);

  assert(pairing.title.includes(expected.opponent), `${expected.title}/${expected.room}: missing opponent`);
  const hasCaselistLink = /https:\/\/opencaselist\.com\//i.test(pairing.url || '');
  assert.strictEqual(
    hasCaselistLink,
    expected.caselist,
    `${expected.title}/${expected.room}: unexpected caselist-link state`,
  );
  if (expected.liveCaselist) {
    assert(
      /https:\/\/opencaselist\.com\/hspolicy26\/Coppell\//i.test(pairing.url || ''),
      'Live OpenCaselist contract did not produce the configured Coppell URL',
    );
  }
  assert(/^Interlake\b/.test(fieldValue(pairing, 'Team')));

  for (const expectedJudge of expected.judges) {
    const judge = embeds.find(embed => embed.title === `⚖️ ${expectedJudge.name}`);
    assert(judge, `${expected.title}/${expected.room}: missing judge ${expectedJudge.name}`);
    const paradigm = fieldValue(judge, 'Paradigm Link');
    assert.strictEqual(
      paradigm !== 'N/A',
      expectedJudge.paradigm,
      `${expectedJudge.name}: unexpected paradigm-link state`,
    );
    if (expectedJudge.liveParadigm) {
      assert(/https:\/\/www\.tabroom\.com\/index\/paradigm\.mhtml/i.test(paradigm));
    }
    const comments = fieldValue(judge, '**Comments**');
    assert.strictEqual(
      !!comments,
      expectedJudge.comments,
      `${expectedJudge.name}: unexpected Notion-comments state`,
    );
  }
}

async function main() {
  const runId = `clerk-e2e-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}`;
  const recipient = plusAddress(process.env.E2E_GMAIL_EMAIL, runId);
  const targetChannelId = process.env.E2E_DISCORD_CHANNEL_ID;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerk-e2e-cache-'));
  const sentMessages = [];
  const receivedUids = new Set();
  const processingErrors = [];
  const serviceCalls = { caselist: [], paradigm: [], notion: [] };
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

    const tournamentId = `e2e-${runId}`;
    bot.store.activeSession = {
      tournId: tournamentId,
      tournamentUrl: 'https://example.invalid/e2e',
      channelMappings: {
        'Interlake CH': targetChannelId,
        '  interlake   nm  ': targetChannelId,
        'Interlake SC': targetChannelId,
        'Interlake AA': targetChannelId,
        'Interlake BB': targetChannelId,
        'Interlake FL': targetChannelId,
        'Interlake MF': targetChannelId,
        'Interlake LC': targetChannelId,
      },
      processedEmailUids: [],
      reportedPairings: [],
      emailMonitorActive: false,
    };
    bot.store.save = () => {};
    bot.store.getCaselistForTeam = () => 'hspolicy26';
    bot.store.getEntryNamesForTeam = () => null;
    bot._mirrorToHQ = async () => {};

    const liveJudges = await bot._scrapeJudgesList(liveCoachJudgesUrl);
    const coachCandidate = liveJudges.find(judge => judge.institution);
    assert(coachCandidate, 'Live Tabroom judges page did not provide a coach candidate');
    const coachName = `${coachCandidate.firstName} ${coachCandidate.lastName}`;
    let coachData = null;
    bot.store.getSchoolNames = () => ['Interlake', coachCandidate.institution];
    bot.store.setCoaches = data => { coachData = data; };
    bot.store.getCoaches = () => coachData;

    await bot.handleReportCoaches({
      channel: targetChannel,
      reply: payload => targetChannel.send(payload),
    }, liveCoachJudgesUrl);
    assert(
      coachData?.coaches.some(coach => coach.name === coachName),
      `report coaches did not activate live judge ${coachName}`,
    );

    const coachScenario = {
      key: 'coach-assignment',
      email: liveUpdate({
        team: coachName,
        opponent: 'Coach Opponent CO',
        round: 48,
        side: 'AFF',
        room: '408A',
        judges: [coachName],
      }),
    };
    const runScenarios = [...scenarios, coachScenario];

    bot.cache = new TournamentCache(cacheDir);
    bot.cache.saveOpponents(tournamentId, { tournamentName: 'E2E' }, {
      'cache academy ch': { N: syntheticLookup('Cache Academy CH', 'N') },
      'no data nd': { A: null },
    });
    bot.cache.saveParadigms(tournamentId, {
      [TournamentCache.normalizeName('Cached Judge')]: syntheticParadigm('Cached Judge'),
      [TournamentCache.normalizeName('Missing Judge')]: null,
      [TournamentCache.normalizeName('Assignment Two')]: syntheticParadigm('Assignment Two'),
    }, { tournamentName: 'E2E' });

    const liveCaselistLookup = bot.caselistService.lookupOpponent.bind(bot.caselistService);
    bot.caselistService.lookupOpponent = async (teamCode, side, entryNames, caselistSlug) => {
      serviceCalls.caselist.push(teamCode);
      if (teamCode === 'Coppell PK') {
        return liveCaselistLookup(teamCode, side, entryNames, caselistSlug);
      }
      return syntheticLookup(teamCode, side);
    };

    const liveParadigmLookup = bot.paradigmService.fetchParadigmByName.bind(bot.paradigmService);
    bot.paradigmService.fetchParadigmByName = async name => {
      serviceCalls.paradigm.push(name);
      if (name === 'Tom Mickelson') return liveParadigmLookup(name);
      if (['Assignment Three'].includes(name)) return null;
      return syntheticParadigm(name);
    };

    const liveNotionLookup = bot.notion.searchJudge.bind(bot.notion);
    bot.notion.searchJudge = async name => {
      serviceCalls.notion.push(name);
      if (name === 'Tom Mickelson') return liveNotionLookup(name);
      if (['Cached Judge', 'Live Fallback Judge'].includes(name)) {
        return [{
          name,
          url: `https://www.notion.so/e2e-${name.toLowerCase().replace(/\s+/g, '-')}`,
          comments: [`E2E note for ${name}`],
        }];
      }
      return [];
    };

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

    for (const scenario of runScenarios) {
      await retry(`sending ${scenario.key}`, () =>
        transporter.sendMail({
          from: process.env.E2E_GMAIL_EMAIL,
          to: recipient,
          subject: scenario.email.subject,
          text: scenario.email.body,
          headers: {
            'X-Clerk-E2E-Run': runId,
            'X-Clerk-E2E-Scenario': scenario.key,
          },
        }),
      );
      console.log(`[E2E] Sent ${scenario.key}: ${scenario.email.subject}`);
    }
    transporter.close();

    let retryDeliveries = 0;
    monitor = new EmailMonitor({
      email: process.env.E2E_GMAIL_EMAIL,
      password: process.env.E2E_GMAIL_APP_PASSWORD,
      searchCriteria: [['TO', recipient]],
      markSeen: false,
      allowE2E: true,
      pollInterval: 3000,
      maxReconnectDelay: 10000,
    });

    let processing = Promise.resolve();
    monitor.on('pairing', eventData => {
      if (receivedUids.has(eventData.uid)) return;
      receivedUids.add(eventData.uid);
      processing = processing
        .then(async () => {
          const isRetry = eventData.raw.subject === scenarios.find(s => s.key === 'failed-route').email.subject;
          const isMalformed = eventData.raw.subject === malformedEmail.subject;
          if (isRetry) retryDeliveries++;
          try {
            await bot.handlePairingEvent(eventData);
          } catch (error) {
            const expectedFailure = isMalformed || (isRetry && retryDeliveries === 1);
            if (!expectedFailure) throw error;
          }
          if (isRetry && retryDeliveries === 1) {
            assert.strictEqual(
              bot.store.activeSession.reportedPairings.some(key => key.includes('interlake rt')),
              false,
              'Failed route was incorrectly marked reported',
            );
            assert.strictEqual(
              bot.store.activeSession.processedEmailUids.includes(eventData.uid),
              false,
              'Failed route was incorrectly marked processed',
            );
            bot.store.activeSession.channelMappings['Interlake RT'] = targetChannelId;
          }
          if (isMalformed) {
            assert.strictEqual(
              bot.store.activeSession.processedEmailUids.includes(eventData.uid),
              false,
              'Malformed email was incorrectly marked processed',
            );
          }
        })
        .catch(error => processingErrors.push(error));
    });
    monitor.on('error', error => processingErrors.push(error));
    monitor.start();

    await waitFor(
      () => receivedUids.size === runScenarios.length &&
        sentMessages.length === expectedReports.length + 2,
      240000,
      `${runScenarios.length} Gmail messages, ${expectedReports.length} pairing reports, ` +
        'and coach activation/report output',
    );
    await processing;
    if (processingErrors.length) throw processingErrors[0];

    const delivered = [];
    for (const message of sentMessages) {
      delivered.push(await targetChannel.messages.fetch(message.id));
    }
    assert.strictEqual(delivered.length, expectedReports.length + 2);

    const activation = delivered.find(message =>
      message.embeds[0]?.toJSON().title === '🧑‍🏫 Coach Reports Activated');
    assert(activation, 'report coaches command did not produce an activation embed');
    const coachReport = delivered.find(message =>
      message.embeds[0]?.toJSON().title?.startsWith(`🧑‍🏫 ${coachName} —`));
    assert(coachReport, `Gmail assignment did not produce a coach report for ${coachName}`);
    const coachEmbed = coachReport.embeds[0].toJSON();
    assert.strictEqual(fieldValue(coachEmbed, '📍 Room'), '408A');
    assert.strictEqual(fieldValue(coachEmbed, '⏰ Start'), '1:30 CDT');

    const unmatched = delivered.filter(message => message !== activation && message !== coachReport);
    for (const expected of expectedReports) {
      const index = unmatched.findIndex(message => {
        const pairing = message.embeds[0]?.toJSON();
        return pairing?.title === expected.title && fieldValue(pairing, 'Room') === expected.room;
      });
      assert(index >= 0, `${expected.title}/${expected.room}: no Discord report matched`);
      const [message] = unmatched.splice(index, 1);
      assertReport(message, expected);
      console.log(`[E2E] Verified Discord output: ${expected.title}/${expected.room}`);
    }

    assert(!serviceCalls.caselist.includes('Cache Academy CH'), 'Opponent cache hit called live service');
    assert(!serviceCalls.caselist.includes('No Data ND'), 'Cached opponent miss called live service');
    assert(serviceCalls.caselist.includes('Live Academy Alice Alpha & Bob Beta'));
    assert(serviceCalls.caselist.includes('Coppell PK'));
    assert(!serviceCalls.paradigm.includes('Cached Judge'), 'Paradigm cache hit called live service');
    assert(!serviceCalls.paradigm.includes('Missing Judge'), 'Cached paradigm miss called live service');
    assert(!serviceCalls.paradigm.includes('Assignment Two'), 'Multi-judge cache hit called live service');
    assert(serviceCalls.paradigm.includes('Live Fallback Judge'));
    assert(serviceCalls.paradigm.includes('Tom Mickelson'));
    assert(serviceCalls.notion.includes('Tom Mickelson'));

    console.log(
      `[E2E] PASS: ${scenarios.length} emails exercised ${expectedReports.length} reports across all matrix branches`,
      ` plus report coaches activation and Gmail-to-Discord coach delivery for ${coachName}`,
    );
  } finally {
    if (monitor) monitor.stop();
    for (const message of sentMessages) {
      try {
        await message.delete();
      } catch (error) {
        console.warn(`[E2E] Could not delete Discord fixture message ${message.id}: ${error.message}`);
      }
    }
    if (bot) bot.client.destroy();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[E2E] FAIL:', error);
  process.exitCode = 1;
});
