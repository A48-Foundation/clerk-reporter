const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const NotionService = require('./notion-service');
const TournamentStore = require('./tournament-store');
const TabroomScraper = require('./tabroom-scraper');
const EmailMonitor = require('./email-monitor');
const EmailParser = require('./email-parser');
const ChannelMapper = require('./channel-mapper');
const CaselistService = require('./caselist-service');
const ParadigmService = require('./paradigm-service');
const LlmService = require('./llm-service');
const ReportBuilder = require('./report-builder');

class ClerkKentBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.notion = new NotionService();
    this.store = new TournamentStore();
    this.emailMonitor = null;
    this.channelMapper = null; // initialized after client is ready
    this.caselistService = new CaselistService();
    this.paradigmService = new ParadigmService();
    this.llmService = new LlmService();
    this.reportBuilder = new ReportBuilder();
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.once(Events.ClientReady, (readyClient) => {
      console.log(`✅ Clerk Kent is online as ${readyClient.user.tag}`);
      readyClient.user.setActivity('for @Clerk Kent [judge]', { type: 2 }); // "Listening to"
      this.channelMapper = new ChannelMapper(this.client);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      await this.handleMessage(message);
    });
  }

  /**
   * Handle incoming messages. Responds when the bot is mentioned.
   */
  async handleMessage(message) {
    // Check if the bot is mentioned
    if (!message.mentions.has(this.client.user)) return;

    // Strip the mention to extract the command
    const content = message.content
      .replace(/<@!?\d+>/g, '')  // remove mentions
      .trim();

    if (!content) {
      await message.reply({ embeds: [this.buildHelpEmbed()] });
      return;
    }

    // Check for tournament management commands
    const lowerContent = content.toLowerCase();

    if (lowerContent.startsWith('initiate pairings reports ')) {
      await this.handleInitiatePairings(message, content.slice('initiate pairings reports '.length).trim());
      return;
    }

    if (lowerContent === 'stop pairings') {
      await this.handleStopPairings(message);
      return;
    }

    if (lowerContent.startsWith('track ')) {
      await this.handleTrack(message, content.slice(6).trim());
      return;
    }

    if (lowerContent.startsWith('untrack ')) {
      await this.handleUntrack(message, content.slice(8).trim());
      return;
    }

    if (lowerContent === 'tournaments' || lowerContent === 'status') {
      await this.handleStatus(message);
      return;
    }

    if (lowerContent.startsWith('report ')) {
      await this.handleReport(message, content.slice(7).trim());
      return;
    }

    // Default: judge lookup
    await this.handleJudgeLookup(message, content);
  }

  // ─── PAIRINGS PIPELINE COMMANDS ─────────────────────────────────

  /**
   * Handle: @Clerk Kent initiate pairings reports <tabroom_url>
   * Scrapes initial pairings, maps teams to channels, starts email monitor.
   */
  async handleInitiatePairings(message, url) {
    if (!url) {
      await message.reply(
        '**Usage:** `@Clerk Kent initiate pairings reports <tabroom_pairings_url>`\n' +
        '**Example:** `@Clerk Kent initiate pairings reports https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=36452&round_id=1503711`'
      );
      return;
    }

    try {
      await message.channel.sendTyping();

      // Parse tournament ID from URL
      let tournId, roundId;
      if (url.includes('round_id')) {
        const parsed = TabroomScraper.parseRoundUrl(url);
        tournId = parsed.tournId;
        roundId = parsed.roundId;
      } else {
        const parsed = new URL(url);
        tournId = parsed.searchParams.get('tourn_id');
      }

      if (!tournId) {
        await message.reply('⚠️ Could not extract tournament ID from that URL. Make sure it\'s a valid Tabroom URL.');
        return;
      }

      // Scrape current pairings
      if (!roundId) {
        const rounds = await TabroomScraper.getRounds(tournId);
        if (rounds.length === 0) {
          await message.reply('⚠️ No rounds found for this tournament.');
          return;
        }
        roundId = rounds[rounds.length - 1].roundId;
      }

      const pairings = await TabroomScraper.scrapePairings(tournId, roundId);
      if (pairings.length === 0) {
        await message.reply('⚠️ No pairings found for this round yet.');
        return;
      }

      // Filter for our school's teams
      const schoolNames = (process.env.SCHOOL_NAMES || 'Interlake,Cuttlefish')
        .split(',')
        .map(s => s.trim().toLowerCase());

      const ourTeamCodes = [];
      for (const p of pairings) {
        for (const code of [p.aff, p.neg]) {
          if (code && schoolNames.some(s => code.toLowerCase().startsWith(s))) {
            ourTeamCodes.push(code);
          }
        }
      }

      if (ourTeamCodes.length === 0) {
        await message.reply(`⚠️ No teams matching school names (${schoolNames.join(', ')}) found in pairings.`);
        return;
      }

      // Auto-map teams to Discord channels and confirm
      const mapping = await this.channelMapper.autoMap(ourTeamCodes);
      const confirmed = await this.channelMapper.confirmMapping(message.channel, mapping);

      // Build channelMappings as { teamCode: channelId }
      const channelMappings = {};
      for (const [team, info] of Object.entries(confirmed)) {
        if (info.channelId) {
          channelMappings[team] = info.channelId;
        }
      }

      // Store the active session
      this.store.setActiveSession(tournId, url, channelMappings);

      // Start email monitor
      if (this.emailMonitor) {
        this.emailMonitor.stop();
      }

      this.emailMonitor = new EmailMonitor({
        email: process.env.IMAP_EMAIL,
        password: process.env.IMAP_PASSWORD,
      });

      this.emailMonitor.on('pairing', (eventData) => this.handlePairingEvent(eventData));
      this.emailMonitor.on('error', (err) => console.error('[EmailMonitor] Error:', err.message));
      this.emailMonitor.start();

      const teamList = Object.entries(channelMappings)
        .map(([team, chId]) => `• **${team}** → <#${chId}>`)
        .join('\n');

      await message.reply(
        `✅ **Pairings pipeline activated** for tournament **${tournId}**!\n\n` +
        `${teamList}\n\n` +
        `📧 Email monitor started — pairing reports will be sent automatically.\n` +
        `Use \`@Clerk Kent stop pairings\` to stop.`
      );
    } catch (err) {
      console.error('Error in initiate pairings command:', err);
      await message.reply('⚠️ Something went wrong while setting up pairings. Check the URL and try again.');
    }
  }

  /**
   * Handle: @Clerk Kent stop pairings
   * Stops the email monitor and clears the active session.
   */
  async handleStopPairings(message) {
    if (this.emailMonitor) {
      this.emailMonitor.stop();
      this.emailMonitor = null;
    }
    this.store.clearActiveSession();
    await message.reply('✅ Pairings pipeline stopped. Email monitor deactivated and session cleared.');
  }

  /**
   * Handle an incoming pairing event from the EmailMonitor.
   * Supports both Format A (liveUpdate) and Format B (assignments).
   * Routes each team's pairing to _processSinglePairing().
   */
  async handlePairingEvent(eventData) {
    try {
      const { parsed, uid } = eventData;
      if (!parsed) return;

      const session = this.store.getActiveSession();
      if (!session) return;

      // Check if already processed
      if (this.store.isEmailProcessed(uid)) return;
      this.store.addProcessedEmailUid(uid);

      const schoolNames = (process.env.SCHOOL_NAMES || 'Interlake,Cuttlefish')
        .split(',')
        .map(s => s.trim().toLowerCase());

      if (parsed.format === 'assignments') {
        // Format B: process each entry in the assignments email
        for (const entry of (parsed.entries || [])) {
          const isOurs = schoolNames.some(s => entry.teamCode.toLowerCase().startsWith(s));
          if (!isOurs) continue;

          // For FLIP, side is unknown; for AFF/NEG it's set
          let opponentSide = null;
          if (entry.side === 'AFF') opponentSide = 'N';
          else if (entry.side === 'NEG') opponentSide = 'A';
          // FLIP = unknown, we'll skip caselist side filtering

          await this._processSinglePairing({
            ourTeamCode: entry.teamCode,
            opponentCode: entry.opponent,
            opponentSide,
            side: entry.side,
            room: entry.room,
            judges: entry.judges || [],
            roundTitle: parsed.roundTitle,
            startTime: parsed.startTime,
            roundNumber: null,
          }, session);
        }
      } else {
        // Format A: single live update pairing
        const affCode = parsed.aff?.teamCode || '';
        const negCode = parsed.neg?.teamCode || '';
        const affIsOurs = schoolNames.some(s => affCode.toLowerCase().startsWith(s));
        const negIsOurs = schoolNames.some(s => negCode.toLowerCase().startsWith(s));

        let ourTeamCode, opponentCode, opponentSide, side;
        if (affIsOurs) {
          ourTeamCode = affCode;
          opponentCode = negCode;
          opponentSide = 'N';
          side = 'AFF';
        } else if (negIsOurs) {
          ourTeamCode = negCode;
          opponentCode = affCode;
          opponentSide = 'A';
          side = 'NEG';
        } else {
          return;
        }

        await this._processSinglePairing({
          ourTeamCode,
          opponentCode,
          opponentSide,
          side,
          room: parsed.room,
          judges: parsed.judges || [],
          roundTitle: parsed.roundTitle,
          startTime: parsed.startTime,
          roundNumber: parsed.roundNumber,
          aff: parsed.aff,
          neg: parsed.neg,
        }, session);
      }
    } catch (err) {
      console.error('[handlePairingEvent] Error:', err);
    }
  }

  /**
   * Process a single team's pairing: look up opponent, judges, send report.
   */
  async _processSinglePairing(pairing, session) {
    const { ourTeamCode, opponentCode, opponentSide, side, room, judges,
            roundTitle, startTime, roundNumber, aff, neg } = pairing;

    // Find the channel for our team
    const channelId = session.channelMappings[ourTeamCode];
    if (!channelId) {
      console.warn(`[Pairing] No channel mapped for ${ourTeamCode}`);
      return;
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) return;

    await channel.sendTyping();

    // Look up opponent on caselist
    let opponentData = null;
    let argumentSummary = '_No caselist data found._';
    if (opponentCode) {
      const caselistResult = opponentSide
        ? await this.caselistService.lookupOpponent(opponentCode, opponentSide)
        : null;
      if (caselistResult && caselistResult.rounds.length > 0) {
        argumentSummary = await this.llmService.summarizeWithFallback(caselistResult.rounds, opponentSide);
        opponentData = {
          schoolName: caselistResult.schoolName,
          teamCode: caselistResult.teamCode,
          caselistUrl: caselistResult.caselistUrl,
          side: opponentSide === 'A' ? 'Aff' : 'Neg',
          argumentSummary,
        };
      } else {
        opponentData = {
          schoolName: opponentCode,
          teamCode: '',
          caselistUrl: null,
          side: opponentSide ? (opponentSide === 'A' ? 'Aff' : 'Neg') : 'FLIP',
          argumentSummary: opponentSide ? argumentSummary : '_Side unknown (FLIP) — caselist lookup skipped._',
        };
      }
    }

    // Look up judges
    const judgeEmbedData = [];
    for (const judge of judges) {
      const judgeName = judge.name;
      let paradigmSummary = null;
      let paradigmUrl = null;
      let school = null;

      const paradigm = await this.paradigmService.fetchParadigmByName(judgeName);
      if (paradigm) {
        paradigmUrl = paradigm.paradigmUrl;
        school = paradigm.school;
        if (paradigm.philosophy) {
          paradigmSummary = await this.llmService.summarizeParadigm(paradigm.philosophy);
        }
      }

      let notionNotes = null;
      let notionUrl = null;
      const notionResults = await this.notion.searchJudge(judgeName);
      if (notionResults.length > 0) {
        const j = notionResults[0];
        notionUrl = j.url || null;
        if (j.comments && j.comments.length > 0) {
          notionNotes = j.comments.map((c, i) => `**${i + 1}.** ${c}`).join('\n');
          if (notionNotes.length > 500) notionNotes = notionNotes.slice(0, 497) + '...';
        }
      }

      judgeEmbedData.push({ name: judgeName, paradigmSummary, paradigmUrl, school, notionNotes, notionUrl });
    }

    // Build pairing data for the embed
    const pairingEmbed = {
      roundTitle: roundTitle || `Round ${roundNumber || '?'}`,
      startTime,
      room,
      side,
      teamCode: ourTeamCode,
      aff: aff || { teamCode: side === 'AFF' ? ourTeamCode : opponentCode },
      neg: neg || { teamCode: side === 'NEG' ? ourTeamCode : opponentCode },
    };

    const embeds = this.reportBuilder.buildFullReport(pairingEmbed, opponentData, judgeEmbedData);

    if (embeds.length > 0) {
      await channel.send({ embeds: embeds.slice(0, 10) });
      console.log(`✅ Sent pairings report for ${ourTeamCode} (${roundTitle || 'Round ' + (roundNumber || '?')})`);
    }
  }

  // ─── TOURNAMENT TRACKING COMMANDS ──────────────────────────────

  /**
   * Handle: @Clerk Kent track <tabroom_url> <team_code>
   * Registers a team to track at a tournament, sending updates to the current channel.
   */
  async handleTrack(message, args) {
    // Parse: URL then team code
    const parts = args.split(/\s+/);
    const url = parts[0];
    const teamCode = parts.slice(1).join(' ');

    if (!url || !teamCode) {
      await message.reply(
        '**Usage:** `@Clerk Kent track <tabroom_pairings_url> <team_code>`\n\n' +
        '**Example:**\n' +
        '`@Clerk Kent track https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=36452&round_id=1503711 Okemos AT`'
      );
      return;
    }

    try {
      let tournId;

      // Try parsing as a round URL first
      if (url.includes('round_id')) {
        const parsed = TabroomScraper.parseRoundUrl(url);
        tournId = parsed.tournId;
      } else {
        // Try extracting tourn_id from any Tabroom URL
        const parsed = new URL(url);
        tournId = parsed.searchParams.get('tourn_id');
      }

      if (!tournId) {
        await message.reply('⚠️ Could not extract tournament ID from that URL. Make sure it\'s a valid Tabroom URL.');
        return;
      }

      this.store.addTeam(tournId, teamCode, message.channel.id);

      await message.reply(
        `✅ Now tracking **${teamCode}** at tournament **${tournId}**.\n` +
        `Use \`@Clerk Kent report ${teamCode.split(' ').pop()}\` to get pairings & judge info.`
      );
    } catch (err) {
      console.error('Error in track command:', err);
      await message.reply('⚠️ Invalid URL. Please provide a valid Tabroom pairings URL.');
    }
  }

  /**
   * Handle: @Clerk Kent untrack <team_code>
   * Or: @Clerk Kent untrack <tourn_id> <team_code>
   */
  async handleUntrack(message, args) {
    const parts = args.split(/\s+/);

    if (parts.length === 1) {
      const teamCode = parts[0];
      const tournaments = this.store.getAllTournaments();
      let removed = false;
      for (const tourn of tournaments) {
        if (this.store.removeTeam(tourn.tournId, teamCode)) {
          removed = true;
        }
      }
      if (removed) {
        await message.reply(`✅ Removed **${teamCode}** from tracking.`);
      } else {
        await message.reply(`⚠️ **${teamCode}** is not being tracked.`);
      }
    } else {
      const tournId = parts[0];
      const teamCode = parts.slice(1).join(' ');
      if (this.store.removeTeam(tournId, teamCode)) {
        await message.reply(`✅ Removed **${teamCode}** from tournament **${tournId}**.`);
      } else {
        await message.reply(`⚠️ **${teamCode}** is not being tracked for tournament **${tournId}**.`);
      }
    }
  }

  /**
   * Handle: @Clerk Kent tournaments / @Clerk Kent status
   * Show all currently tracked tournaments and teams.
   */
  async handleStatus(message) {
    const tournaments = this.store.getAllTournaments();

    if (tournaments.length === 0) {
      await message.reply('📭 No tournaments are currently being tracked.\n\nUse `@Clerk Kent track <tabroom_url> <team_code>` to start tracking.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 Tracked Tournaments')
      .setColor(0xF5A623)
      .setTimestamp();

    for (const tourn of tournaments) {
      const teamList = tourn.teams
        .map(t => `• **${t.code}** → <#${t.channelId}>`)
        .join('\n');
      const roundCount = tourn.seenRounds.length;
      embed.addFields({
        name: `Tournament ${tourn.tournId}`,
        value: `${teamList}\n_Rounds processed: ${roundCount}_`,
        inline: false,
      });
    }

    await message.reply({ embeds: [embed] });
  }

  /**
   * Handle: @Clerk Kent report <short_code>
   * e.g. @Clerk Kent report SW
   * Finds the tracked team whose code contains the short code,
   * checks the latest round, and sends judge info to this channel.
   */
  async handleReport(message, shortCode) {
    if (!shortCode) {
      await message.reply('**Usage:** `@Clerk Kent report <team_code>`\n**Example:** `@Clerk Kent report SW`');
      return;
    }

    try {
      await message.channel.sendTyping();

      // Find the tracked team matching the short code
      const tournaments = this.store.getAllTournaments();
      let matchedTeam = null;
      let matchedTourn = null;

      for (const tourn of tournaments) {
        const team = tourn.teams.find(t =>
          t.code.toLowerCase().includes(shortCode.toLowerCase())
        );
        if (team) {
          matchedTeam = team;
          matchedTourn = tourn;
          break;
        }
      }

      if (!matchedTeam) {
        await message.reply(
          `⚠️ No tracked team matches **"${shortCode}"**.\n` +
          `Use \`@Clerk Kent track <tabroom_url> <team_code>\` to register a team first.`
        );
        return;
      }

      // Get all rounds and find the latest one
      const rounds = await TabroomScraper.getRounds(matchedTourn.tournId);

      if (rounds.length === 0) {
        await message.reply('📭 No rounds found for this tournament yet.');
        return;
      }

      // Use the last round in the list (most recent)
      const latestRound = rounds[rounds.length - 1];

      // Scrape pairings for the latest round
      const pairings = await TabroomScraper.scrapePairings(matchedTourn.tournId, latestRound.roundId);
      const roundTitle = await TabroomScraper.getRoundTitle(matchedTourn.tournId, latestRound.roundId);

      if (pairings.length === 0) {
        await message.reply(`📭 No pairings found for **${roundTitle}** yet.`);
        return;
      }

      // Find the team's pairing
      const pairing = TabroomScraper.findTeamPairing(pairings, matchedTeam.code);

      if (!pairing) {
        await message.reply(`⚠️ **${matchedTeam.code}** not found in **${roundTitle}** pairings.`);
        return;
      }

      // Build and send the pairing + judge embeds
      await this.sendPairingReport(message.channel, matchedTeam, pairing, roundTitle, matchedTourn.tournId, latestRound.roundId);
    } catch (err) {
      console.error('Error in report command:', err);
      await message.reply('⚠️ Something went wrong while fetching pairings. Try again later.');
    }
  }

  /**
   * Send pairing + judge info embeds to a channel.
   */
  async sendPairingReport(channel, team, pairing, roundTitle, tournId, roundId) {
    const summaryEmbed = new EmbedBuilder()
      .setTitle(`📋 ${roundTitle}`)
      .setColor(0xF5A623)
      .setDescription(`**${team.code}** has been paired!`)
      .addFields(
        { name: 'Aff', value: pairing.aff || 'TBD', inline: true },
        { name: 'Neg', value: pairing.neg || 'TBD', inline: true },
        { name: 'Room', value: pairing.room || 'TBD', inline: true },
      )
      .setURL(`https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=${tournId}&round_id=${roundId}`)
      .setTimestamp();

    const embeds = [summaryEmbed];

    for (const judge of pairing.judges) {
      const judgeResults = await this.notion.searchJudge(judge.name);

      if (judgeResults.length > 0) {
        const j = judgeResults[0];
        const judgeEmbed = new EmbedBuilder()
          .setTitle(`⚖️ ${j.name}`)
          .setColor(0x2F80ED);

        judgeEmbed.addFields({ name: '📧 Email', value: j.email, inline: true });

        if (j.tabroom) {
          judgeEmbed.addFields({
            name: '🔗 Tabroom',
            value: `[View Profile](${j.tabroom})`,
            inline: false,
          });
        }

        if (j.comments.length > 0) {
          const commentsText = j.comments
            .map((c, i) => `**${i + 1}.** ${c}`)
            .join('\n\n');
          const truncated = commentsText.length > 1000
            ? commentsText.slice(0, 997) + '...'
            : commentsText;
          judgeEmbed.addFields({
            name: '📝 Notes',
            value: truncated,
            inline: false,
          });
        }

        if (j.url) judgeEmbed.setURL(j.url);
        embeds.push(judgeEmbed);
      } else {
        const unknownEmbed = new EmbedBuilder()
          .setTitle(`⚖️ ${judge.name}`)
          .setColor(0x95A5A6)
          .setDescription('No notes found in the judge database.');

        if (judge.judgeId) {
          unknownEmbed.addFields({
            name: '🔗 Tabroom',
            value: `[View Profile](https://www.tabroom.com/index/tourn/postings/judge.mhtml?judge_id=${judge.judgeId}&tourn_id=${tournId})`,
            inline: false,
          });
        }
        embeds.push(unknownEmbed);
      }
    }

    await channel.send({ embeds: embeds.slice(0, 10) });
    console.log(`✅ Sent report for ${team.code} in ${roundTitle}`);
  }

  // ─── JUDGE LOOKUP ──────────────────────────────────────────────

  async handleJudgeLookup(message, judgeName) {
    try {
      await message.channel.sendTyping();

      console.log(`[DEBUG] Raw message: "${message.content}"`);
      console.log(`[DEBUG] Extracted judge name: "${judgeName}"`);

      const judges = await this.notion.searchJudge(judgeName);

      if (judges.length === 0) {
        await message.reply(
          `🔍 No judges found matching **"${judgeName}"**. Try a different spelling or partial name.`
        );
        return;
      }

      const embeds = judges.map(judge => this.buildJudgeEmbed(judge));
      await message.reply({ embeds });
    } catch (err) {
      console.error('Error handling judge search:', err);
      await message.reply(
        '⚠️ Something went wrong while searching. Please try again later.'
      );
    }
  }

  /**
   * Build a rich embed for a judge.
   */
  buildJudgeEmbed(judge) {
    const embed = new EmbedBuilder()
      .setTitle(`⚖️ ${judge.name}`)
      .setColor(0x2F80ED)
      .setTimestamp();

    // Email
    embed.addFields({ name: '📧 Email', value: judge.email, inline: true });

    // Tabroom link
    if (judge.tabroom) {
      embed.addFields({
        name: '🔗 Tabroom',
        value: `[View Profile](${judge.tabroom})`,
        inline: false,
      });
    }

    // Comments / Notes
    if (judge.comments.length > 0) {
      const commentsText = judge.comments
        .map((c, i) => `**${i + 1}.** ${c}`)
        .join('\n\n');
      // Discord embed field value max is 1024 chars
      const truncated = commentsText.length > 1000
        ? commentsText.slice(0, 997) + '...'
        : commentsText;
      embed.addFields({
        name: '📝 Notes',
        value: truncated,
        inline: false,
      });
    }

    // Link to Notion page
    if (judge.url) {
      embed.setURL(judge.url);
    }

    return embed;
  }

  /**
   * Build a help embed when the bot is mentioned without a judge name.
   */
  buildHelpEmbed() {
    return new EmbedBuilder()
      .setTitle('⚖️ Clerk Kent — Judge Lookup & Pairings Bot')
      .setColor(0x2F80ED)
      .setDescription(
        '**Judge Lookup:**\n' +
        '`@Clerk Kent [Judge Name]` — Look up a judge\n\n' +
        '**Tournament Tracking:**\n' +
        '`@Clerk Kent track <tabroom_url> <team_code>` — Register a team to track\n' +
        '`@Clerk Kent report <code>` — Get latest pairings & judge info for a team\n' +
        '`@Clerk Kent untrack <team_code>` — Stop tracking a team\n' +
        '`@Clerk Kent tournaments` — Show tracked tournaments\n\n' +
        '**Automated Pairings Pipeline:**\n' +
        '`@Clerk Kent initiate pairings reports <tabroom_url>` — Start auto reports via email\n' +
        '`@Clerk Kent stop pairings` — Stop the automated pipeline\n\n' +
        '**Examples:**\n' +
        '`@Clerk Kent Smith` — Judge lookup\n' +
        '`@Clerk Kent track https://www.tabroom.com/...?tourn_id=36452&round_id=123 Interlake SW`\n' +
        '`@Clerk Kent report SW` — Get judge info for Interlake SW\'s latest round\n' +
        '`@Clerk Kent initiate pairings reports https://www.tabroom.com/...?tourn_id=36452&round_id=123`'
      );
  }

  /**
   * Start the bot.
   */
  async start() {
    await this.client.login(process.env.DISCORD_TOKEN);
  }
}

module.exports = ClerkKentBot;
 