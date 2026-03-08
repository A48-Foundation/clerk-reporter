const { Client, GatewayIntentBits, EmbedBuilder, Events,
        ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
    this._pendingSession = null; // holds state between initiate and confirm button
    this.caselistService = new CaselistService();
    this.paradigmService = new ParadigmService();
    this.llmService = new LlmService();
    this.reportBuilder = new ReportBuilder();
    this._roundBatches = {};       // { roundKey: { rows: [], timer, firstSeen } }
    this._allTeamChannelId = this.store.getAllTeamChannelId(); // persisted across restarts
    this._watchFilters = [];       // extra watch filters: [{ type: 'team'|'judge', value: '...' }]
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.once(Events.ClientReady, (readyClient) => {
      console.log(`✅ Clerk Kent is online as ${readyClient.user.tag}`);
      readyClient.user.setActivity('for @Clerk Kent [judge]', { type: 2 }); // "Listening to"
      this.channelMapper = new ChannelMapper(this.client);
      this._restoreEmailMonitor();
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      await this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      await this.handleButtonInteraction(interaction);
    });
  }

  /**
   * Handle incoming messages. Responds when the bot is mentioned.
   */
  async handleMessage(message) {
    // Channel override — no mention needed, just a message in the same channel
    if (this._pendingSession && !message.mentions.has(this.client.user)) {
      const text = message.content.trim();
      // Detect all-team channel override: "all-team=#channel-name"
      const allTeamMatch = text.match(/^all[- ]?team\s*=\s*(?:<#(\d+)>|#?([\w-]+))$/i);
      if (allTeamMatch) {
        const chId = allTeamMatch[1]; // Discord mention format
        const chName = allTeamMatch[2]; // plain text format
        let channelId = chId || null;
        if (!channelId && chName) {
          for (const [, guild] of this.client.guilds.cache) {
            const channels = await guild.channels.fetch();
            const found = channels.find(c => c && c.name && c.name.toLowerCase() === chName.toLowerCase());
            if (found) { channelId = found.id; break; }
          }
        }
        if (channelId) {
          this._allTeamChannelId = channelId;
          this.store.setAllTeamChannelId(channelId);
          await this._updateSetupMessage();
          try { await message.delete(); } catch {}
        } else {
          await message.reply(`⚠️ Channel **${chName}** not found.`);
        }
        return;
      }
      if (/\w+=/.test(text)) {
        await this._handleChannelOverride(message, text);
        return;
      }
    }

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

    // Fuzzy match for "initiate pairings reports" — allow typos, missing words, URL anywhere
    const tabroomUrlMatch = content.match(/https?:\/\/(?:www\.)?tabroom\.com\S+/i);
    if (/\binit\w*\s+pair/i.test(lowerContent) || /\bpairings?\s+reports?\b/i.test(lowerContent)) {
      const url = tabroomUrlMatch ? tabroomUrlMatch[0] : '';
      await this.handleInitiatePairings(message, url);
      return;
    }

    if (lowerContent === 'stop pairings' || lowerContent === 'cancel') {
      await this.handleStopPairings(message);
      return;
    }

    if (lowerContent.startsWith('add entry ')) {
      await this.handleAddEntry(message, content.slice('add entry '.length).trim());
      return;
    }

    if (/^all[- ]?team\s+(report|channel)/i.test(lowerContent)) {
      await this.handleSetAllTeamChannel(message, message.content);
      return;
    }

    if (/^watch\s+/i.test(lowerContent)) {
      await this.handleWatch(message, content.slice('watch '.length).trim());
      return;
    }

    if (lowerContent === 'unwatch all') {
      this._watchFilters = [];
      await message.reply('✅ Cleared all watch filters.');
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

    // Set our aff name: "our aff is PNT" or "our aff is Science Diplomacy"
    if (/^our\s+aff\s+is\s+/i.test(lowerContent)) {
      const affName = content.replace(/^our\s+aff\s+is\s+/i, '').trim();
      if (affName) {
        this.store.setOurAff(affName);
        await message.reply(`✅ Our aff set to **${affName}**. This persists across sessions.`);
      } else {
        await message.reply(`ℹ️ Current aff: **${this.store.getOurAff()}**\nUsage: \`@Clerk Kent our aff is [name]\``);
      }
      return;
    }

    // Default: judge lookup
    await this.handleJudgeLookup(message, content);
  }

  // ─── PAIRINGS PIPELINE COMMANDS ─────────────────────────────────

  /**
   * Handle: @Clerk Kent initiate pairings reports <tabroom_entries_url>
   * Scrapes tournament entries, maps teams to channels, shows confirmation buttons.
   */
  async handleInitiatePairings(message, url) {
    if (!url) {
      await message.reply(
        '**Usage:** `@Clerk Kent initiate pairings reports <tabroom_entries_url>`\n' +
        '**Example:** `@Clerk Kent initiate pairings reports https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=36452&event_id=372080`\n\n' +
        'Provide a link to the tournament entries page (with `event_id` for a specific event, or just `tourn_id` to pick an event).'
      );
      return;
    }

    try {
      await message.channel.sendTyping();

      // Parse URL for tourn_id and optional event_id
      const parsed = TabroomScraper.parseUrl(url);
      const tournId = parsed.tournId;
      let eventId = parsed.eventId;

      if (!tournId) {
        await message.reply('⚠️ Could not extract tournament ID from that URL. Make sure it\'s a valid Tabroom URL.');
        return;
      }

      // Scrape entries
      let result = await TabroomScraper.scrapeEntries(tournId, eventId);

      // If no eventId, show event picker
      if (!eventId && result.events.length > 0) {
        // Auto-select policy events if there's only one, otherwise show list
        const policyEvents = result.events.filter(e =>
          /policy|cx/i.test(e.name)
        );

        if (policyEvents.length === 1) {
          eventId = policyEvents[0].eventId;
          result = await TabroomScraper.scrapeEntries(tournId, eventId);
        } else {
          const eventList = result.events.map((e, i) => `**${i + 1}.** ${e.name}`).join('\n');
          await message.reply(
            `📋 **${result.tournamentName}** has multiple events:\n\n${eventList}\n\n` +
            `Please re-run with a specific event URL (include \`event_id\` parameter).`
          );
          return;
        }
      }

      if (result.entries.length === 0) {
        await message.reply('⚠️ No entries found for this event.');
        return;
      }

      // Filter for our school's teams
      const schoolNames = (process.env.SCHOOL_NAMES || 'Interlake,Cuttlefish')
        .split(',')
        .map(s => s.trim().toLowerCase());

      const ourEntries = result.entries.filter(e =>
        schoolNames.some(s => e.code.toLowerCase().startsWith(s))
      );

      if (ourEntries.length === 0) {
        await message.reply(
          `⚠️ No teams matching school names (${schoolNames.join(', ')}) found in entries.\n` +
          `You can manually add entries with \`@Clerk Kent add entry <team_code> #channel\`.`
        );
        return;
      }

      // Auto-map teams to Discord channels
      const teamCodes = ourEntries.map(e => e.code);
      const mapping = await this.channelMapper.autoMap(teamCodes);

      // Build confirmation embed with buttons
      const lines = Object.entries(mapping).map(([team, info]) => {
        if (info.confidence === 'auto') {
          return `✅ **${team}** → #${info.channelName}`;
        }
        return `❌ **${team}** → _unmatched_`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`📋 ${result.tournamentName} — Channel Mapping`)
        .setDescription(
          lines.join('\n') + '\n\n' +
          '📊 All-team report: type `all-team=#channel-name` to set\n\n' +
          'Type overrides like `OC=#some-channel` or click **Confirm & Start** when ready.'
        )
        .setColor(0x5865f2);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('pairings_confirm')
          .setLabel('✅ Confirm & Start')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('pairings_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      const setupMessage = await message.reply({ embeds: [embed], components: [row] });

      // Store pending session for the button handler + override handler
      // allEntries stores all teams from the tournament for opponent name lookups
      this._pendingSession = {
        tournId,
        tournamentUrl: url,
        tournamentName: result.tournamentName,
        mapping,
        allEntries: result.entries,
        channelId: message.channel.id,
        userId: message.author.id,
        setupMessage,
      };

    } catch (err) {
      console.error('Error in initiate pairings command:', err);
      await message.reply('⚠️ Something went wrong while setting up pairings. Check the URL and try again.');
    }
  }

  /**
   * Rebuild the setup embed from current pending session state and edit the original message.
   */
  async _updateSetupMessage() {
    const session = this._pendingSession;
    if (!session?.setupMessage) return;

    const lines = Object.entries(session.mapping).map(([team, info]) => {
      if (info.confidence === 'manual') return `🔧 **${team}** → #${info.channelName}`;
      if (info.confidence === 'auto') return `✅ **${team}** → #${info.channelName}`;
      return `❌ **${team}** → _unmatched_`;
    });

    const allTeamLine = this._allTeamChannelId
      ? `📊 All-team report → <#${this._allTeamChannelId}>`
      : '📊 All-team report: type `all-team=#channel-name` to set';

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${session.tournamentName} — Channel Mapping`)
      .setDescription(
        lines.join('\n') + '\n\n' +
        allTeamLine + '\n\n' +
        'Type overrides like `OC=#some-channel` or click **Confirm & Start** when ready.'
      )
      .setColor(0x5865f2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pairings_confirm')
        .setLabel('✅ Confirm & Start')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('pairings_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    try {
      await session.setupMessage.edit({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('[Setup] Failed to edit setup message:', err.message);
    }
  }

  /**
   * Handle channel override messages like "CG=#helpful-things" while a pending session exists.
   */
  async _handleChannelOverride(message, content) {
    const overridePattern = /(\w+)=(?:#?)([\w-]+)/g;
    let match;
    let anyApplied = false;
    const results = [];

    while ((match = overridePattern.exec(content)) !== null) {
      const [, suffix, channelRef] = match;
      let matched = false;

      for (const team of Object.keys(this._pendingSession.mapping)) {
        const teamSuffix = this.channelMapper.extractTeamSuffix(team);
        if (teamSuffix && teamSuffix.toLowerCase() === suffix.toLowerCase()) {
          // Search all guilds for the channel
          let found = null;
          for (const [, guild] of this.client.guilds.cache) {
            const channels = await guild.channels.fetch();
            found = channels.find(c => c && c.name && c.name.toLowerCase() === channelRef.toLowerCase());
            if (found) break;
          }
          if (found) {
            this._pendingSession.mapping[team] = {
              channelId: found.id,
              channelName: found.name,
              confidence: 'manual',
            };
            results.push(`✅ **${team}** → #${found.name}`);
            anyApplied = true;
            matched = true;
          } else {
            results.push(`⚠️ Channel **${channelRef}** not found for **${team}**`);
            matched = true;
          }
          break;
        }
      }

      if (!matched) {
        results.push(`⚠️ No team found with suffix **${suffix}**`);
      }
    }

    if (results.length > 0 && anyApplied) {
      await this._updateSetupMessage();
      try { await message.delete(); } catch {}
    } else if (results.length > 0) {
      await message.reply(results.join('\n'));
    } else {
      await message.reply('⚠️ Could not parse any overrides. Use format: `CG=#channel-name`');
    }
  }

  /**
   * Handle Discord button interactions.
   */
  async handleButtonInteraction(interaction) {
    if (interaction.customId === 'pairings_confirm') {
      if (!this._pendingSession) {
        await interaction.reply({ content: '⚠️ No pending session to confirm.', ephemeral: true });
        return;
      }

      const session = this._pendingSession;
      this._pendingSession = null;

      // Build channelMappings as { teamCode: channelId }
      const channelMappings = {};
      for (const [team, info] of Object.entries(session.mapping)) {
        if (info.channelId) {
          channelMappings[team] = info.channelId;
        }
      }

      // Store the active session (including allEntries for opponent name lookups)
      this.store.setActiveSession(session.tournId, session.tournamentUrl, channelMappings, session.allEntries);

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
      this.emailMonitor.on('connected', () => console.log('📧 Email monitor connected'));
      this.emailMonitor.start();

      const teamList = Object.entries(channelMappings)
        .map(([team, chId]) => `• **${team}** → <#${chId}>`)
        .join('\n');

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle(`✅ ${session.tournamentName} — Pairings Pipeline Active`)
            .setDescription(
              `${teamList}\n\n` +
              `📧 Email monitor started — pairing reports will be sent automatically.\n` +
              `Use \`@Clerk Kent stop pairings\` to stop.`
            )
            .setColor(0x2ecc71)
        ],
        components: [],
      });
    } else if (interaction.customId === 'pairings_cancel') {
      this._pendingSession = null;
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Pairings Pipeline Cancelled')
            .setDescription('Setup cancelled. Run the command again to restart.')
            .setColor(0xe74c3c)
        ],
        components: [],
      });
    }
  }

  /**
   * Handle: @Clerk Kent stop pairings
   * Stops the email monitor and clears the active session.
   */
  async handleStopPairings(message) {
    if (this._pendingSession) {
      this._pendingSession = null;
    }
    if (this.emailMonitor) {
      this.emailMonitor.stop();
      this.emailMonitor = null;
    }
    this.store.clearActiveSession();
    this._allTeamChannelId = null;
    this.store.setAllTeamChannelId(null);
    this._watchFilters = [];
    this._roundBatches = {};
    await message.reply('✅ Pairings pipeline stopped and session cleared.');
  }

  /**
   * Handle: @Clerk Kent add entry <team_code> #channel
   * Manually adds a team entry to the active session's channel mappings.
   */
  async handleAddEntry(message, args) {
    const session = this.store.getActiveSession();
    if (!session) {
      await message.reply('⚠️ No active pairings session. Use `initiate pairings reports` first.');
      return;
    }

    // Parse: team code and optional #channel mention
    const channelMention = args.match(/<#(\d+)>/);
    let teamCode, channelId;

    if (channelMention) {
      teamCode = args.replace(/<#\d+>/, '').trim();
      channelId = channelMention[1];
    } else {
      // Try "TeamCode #channel-name" format
      const parts = args.split(/\s+#/);
      teamCode = parts[0].trim();
      if (parts[1]) {
        const channelName = parts[1].trim();
        for (const [, guild] of this.client.guilds.cache) {
          const channels = await guild.channels.fetch();
          const found = channels.find(c => c && c.name && c.name.toLowerCase() === channelName.toLowerCase());
          if (found) { channelId = found.id; break; }
        }
      }
    }

    if (!teamCode) {
      await message.reply('**Usage:** `@Clerk Kent add entry Interlake CG #cg-tournaments`');
      return;
    }

    // Default to current channel if no channel specified
    if (!channelId) {
      channelId = message.channel.id;
    }

    this.store.updateChannelMapping(teamCode, channelId);
    await message.reply(`✅ Added **${teamCode}** → <#${channelId}> to pairings tracking.`);
  }

  /**
   * Handle: @Clerk Kent all-team report #channel
   * Sets the channel for the compact all-team round summary.
   */
  async handleSetAllTeamChannel(message, content) {
    const channelMention = content.match(/<#(\d+)>/);
    let channelId;

    if (channelMention) {
      channelId = channelMention[1];
    } else {
      const nameMatch = content.match(/#([\w-]+)/);
      if (nameMatch) {
        for (const [, guild] of this.client.guilds.cache) {
          const channels = await guild.channels.fetch();
          const found = channels.find(c => c && c.name && c.name.toLowerCase() === nameMatch[1].toLowerCase());
          if (found) { channelId = found.id; break; }
        }
      }
    }

    if (!channelId) {
      channelId = message.channel.id;
    }

    this._allTeamChannelId = channelId;
    this.store.setAllTeamChannelId(channelId);
    await message.reply(`✅ All-team report will be posted to <#${channelId}>.`);
  }

  /**
   * Handle: @Clerk Kent watch team <name> or @Clerk Kent watch judge <name>
   * Adds a manual watch filter — pairings involving these will appear in the all-team report.
   */
  async handleWatch(message, args) {
    const typeMatch = args.match(/^(team|judge)\s+(.+)$/i);
    if (!typeMatch) {
      await message.reply('**Usage:** `@Clerk Kent watch team North Hollywood LZ` or `@Clerk Kent watch judge Smith`');
      return;
    }
    const type = typeMatch[1].toLowerCase();
    const value = typeMatch[2].trim();
    this._watchFilters.push({ type, value });
    await message.reply(`✅ Watching ${type}: **${value}** — will include in all-team report.`);
  }

  /**
   * Handle an incoming pairing event from the EmailMonitor.
   * Uses parseWithFallback (regex first, then LLM) and validates required fields.
   * Routes each team's pairing to _processSinglePairing().
   */
  async handlePairingEvent(eventData) {
    try {
      const { uid, raw } = eventData;
      let { parsed } = eventData;

      console.log(`[handlePairingEvent] Received email UID ${uid}`);

      const session = this.store.getActiveSession();
      if (!session) {
        console.log('[handlePairingEvent] No active session — ignoring');
        return;
      }

      // Check if already processed
      if (this.store.isEmailProcessed(uid)) {
        console.log(`[handlePairingEvent] Email UID ${uid} already processed — skipping`);
        return;
      }
      this.store.addProcessedEmailUid(uid);

      // If the initial regex parse was incomplete, try LLM fallback
      if (!parsed || !EmailParser._isCompletePairing(parsed)) {
        console.log(`[handlePairingEvent] Initial parse incomplete, trying LLM fallback...`);
        if (raw) {
          parsed = await EmailParser.parseWithFallback(raw, this.llmService);
        }
        if (!parsed) {
          console.log(`[handlePairingEvent] Email ${uid} skipped — incomplete pairing data`);
          return;
        }
      }

      console.log(`[handlePairingEvent] Parsed format: ${parsed.format}, round: ${parsed.roundTitle}`);

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
          // Not our team — check watch filters for all-team report
          this._checkWatchFilters(parsed);
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

    // Look up opponent on caselist using entry names from Tabroom
    let opponentData = null;
    let argumentSummary = '_No caselist data found._';
    if (opponentCode) {
      const opponentEntryNames = this.store.getEntryNamesForTeam(opponentCode);
      if (opponentEntryNames) {
        console.log(`[Pairing] Opponent ${opponentCode} entry names: "${opponentEntryNames}"`);
      }

      const caselistResult = opponentSide
        ? await this.caselistService.lookupOpponent(opponentCode, opponentSide, opponentEntryNames)
        : null;
      if (caselistResult && caselistResult.rounds.length > 0) {
        const downloadUrlFn = (path) => this.caselistService.getDownloadUrl(path);
        const negContext = opponentSide === 'N' ? { ourAff: this.store.getOurAff() } : null;
        argumentSummary = this.llmService.summarizeWithFallback(caselistResult.rounds, opponentSide, downloadUrlFn, negContext);

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
      // Skip obviously invalid judge names (email signature artifacts, etc.)
      if (!judgeName || judgeName.length < 3 || /^-+$/.test(judgeName) || /^(thanks|sent from|cheers)/i.test(judgeName)) continue;

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

    // Collect row for the all-team report
    this._addToRoundBatch(pairing, opponentData, judgeEmbedData);
  }

  // ─── ALL-TEAM ROUND REPORT ─────────────────────────────────────

  /**
   * Add a pairing row to the current round batch.
   * Pairings for the same round within 10 minutes are grouped together.
   */
  _addToRoundBatch(pairing, opponentData, judgeEmbedData) {
    if (!this._allTeamChannelId) {
      console.log('[AllTeamReport] Skipped — no all-team channel set');
      return;
    }

    const { ourTeamCode, opponentCode, side, room, judges, roundTitle, roundNumber } = pairing;
    const roundKey = (roundTitle || `Round ${roundNumber || '?'}`).replace(/\s+/g, '_').toLowerCase();
    const now = Date.now();

    if (!this._roundBatches[roundKey]) {
      this._roundBatches[roundKey] = { rows: [], firstSeen: now, timer: null };
    }

    const batch = this._roundBatches[roundKey];

    // Extract compact argument summary (just the argument names, no links)
    let argBrief = '—';
    if (opponentData?.argumentSummary && opponentData.argumentSummary !== '_No caselist data found._') {
      const argLines = opponentData.argumentSummary.split('\n')
        .filter(l => l.startsWith('1AC') || l.startsWith('2NR'))
        .map(l => l.replace(/\s*-\s*\[Docs\]\([^)]*\)/g, '').trim());
      if (argLines.length > 0) argBrief = argLines.join(', ');
    }

    const judgeNames = judgeEmbedData.map(j => j.name).join(', ') || '—';

    batch.rows.push({
      team: ourTeamCode,
      side: side || 'FLIP',
      opponent: opponentData?.teamCode
        ? `${opponentData.schoolName || ''} ${opponentData.teamCode}`.trim()
        : (opponentCode || 'TBD'),
      room: room || '—',
      args: argBrief,
      judges: judgeNames,
    });

    // Reset the flush timer — flush 30s after the last pairing arrives
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => this._flushRoundBatch(roundKey), 30000);

    // Hard cap: if 3 minutes since first pairing, flush now
    if (now - batch.firstSeen >= 180000) {
      clearTimeout(batch.timer);
      this._flushRoundBatch(roundKey);
    }
  }

  /**
   * Check if a pairing matches any manual watch filters.
   */
  _matchesWatchFilter(pairingData) {
    if (this._watchFilters.length === 0) return false;
    const { opponentCode, judges } = pairingData;
    return this._watchFilters.some(f => {
      if (f.type === 'team') {
        return opponentCode && opponentCode.toLowerCase().includes(f.value.toLowerCase());
      }
      if (f.type === 'judge') {
        return judges && judges.some(j =>
          j.name && j.name.toLowerCase().includes(f.value.toLowerCase())
        );
      }
      return false;
    });
  }

  /**
   * Flush a round batch — send the all-team summary embed.
   */
  async _flushRoundBatch(roundKey) {
    const batch = this._roundBatches[roundKey];
    if (!batch || batch.rows.length === 0) return;
    delete this._roundBatches[roundKey];

    try {
      const channel = await this.client.channels.fetch(this._allTeamChannelId);
      if (!channel) return;

      const embed = this.reportBuilder.buildAllTeamEmbed(roundKey, batch.rows);
      await channel.send({ embeds: [embed] });
      console.log(`✅ Sent all-team report for ${roundKey} (${batch.rows.length} pairings)`);
    } catch (err) {
      console.error(`[AllTeamReport] Error flushing ${roundKey}:`, err.message);
    }
  }

  /**
   * Check if a non-our-team pairing matches watch filters and add to batch.
   */
  _checkWatchFilters(parsed) {
    if (!this._allTeamChannelId || this._watchFilters.length === 0) return;

    const affCode = parsed.aff?.teamCode || '';
    const negCode = parsed.neg?.teamCode || '';
    const judgeNames = (parsed.judges || []).map(j => j.name);
    const roundTitle = parsed.roundTitle || `Round ${parsed.roundNumber || '?'}`;
    const roundKey = roundTitle.replace(/\s+/g, '_').toLowerCase();

    const matched = this._watchFilters.some(f => {
      if (f.type === 'team') {
        return affCode.toLowerCase().includes(f.value.toLowerCase()) ||
               negCode.toLowerCase().includes(f.value.toLowerCase());
      }
      if (f.type === 'judge') {
        return judgeNames.some(n => n && n.toLowerCase().includes(f.value.toLowerCase()));
      }
      return false;
    });

    if (!matched) return;

    const now = Date.now();
    if (!this._roundBatches[roundKey]) {
      this._roundBatches[roundKey] = { rows: [], firstSeen: now, timer: null };
    }

    const batch = this._roundBatches[roundKey];
    batch.rows.push({
      team: affCode || 'TBD',
      side: 'AFF',
      opponent: negCode || 'TBD',
      room: parsed.room || '—',
      args: '—',
      judges: judgeNames.join(', ') || '—',
      watched: true,
    });

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => this._flushRoundBatch(roundKey), 30000);
    if (now - batch.firstSeen >= 180000) {
      clearTimeout(batch.timer);
      this._flushRoundBatch(roundKey);
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
        '**Automated Pairings Pipeline:**\n' +
        '`@Clerk Kent initiate pairings reports <entries_url>` — Start auto reports via email\n' +
        '`@Clerk Kent add entry <team_code> #channel` — Manually add a team to track\n' +
        '`@Clerk Kent stop pairings` — Stop the automated pipeline\n\n' +
        '**Tournament Tracking:**\n' +
        '`@Clerk Kent track <tabroom_url> <team_code>` — Register a team to track\n' +
        '`@Clerk Kent report <code>` — Get latest pairings & judge info for a team\n' +
        '`@Clerk Kent untrack <team_code>` — Stop tracking a team\n' +
        '`@Clerk Kent tournaments` — Show tracked tournaments\n\n' +
        '**Examples:**\n' +
        '`@Clerk Kent Smith` — Judge lookup\n' +
        '`@Clerk Kent initiate pairings reports https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=36452&event_id=372080`\n' +
        '`@Clerk Kent add entry Interlake CG #cg-tournaments`'
      );
  }

  /**
   * Start the bot.
   */
  async start() {
    await this.client.login(process.env.DISCORD_TOKEN);
  }

  /**
   * Restore the email monitor if there's a persisted active session.
   */
  _restoreEmailMonitor() {
    const session = this.store.getActiveSession();
    if (!session || !session.emailMonitorActive) return;

    console.log(`[Restore] Found active session for tournament ${session.tournId} — restarting email monitor`);

    this.emailMonitor = new EmailMonitor({
      email: process.env.IMAP_EMAIL,
      password: process.env.IMAP_PASSWORD,
    });

    this.emailMonitor.on('pairing', (eventData) => this.handlePairingEvent(eventData));
    this.emailMonitor.on('error', (err) => console.error('[EmailMonitor] Error:', err.message));
    this.emailMonitor.on('connected', () => console.log('📧 Email monitor reconnected (restored from session)'));
    this.emailMonitor.start();
  }
}

module.exports = ClerkKentBot;
 