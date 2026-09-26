const { Client, GatewayIntentBits, EmbedBuilder, Events, Options,
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
const TournamentCache = require('./tournament-cache');

class ClerkKentBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      // Memory: the bot only reacts to live mentions and never reads history,
      // so keep almost nothing resident. Disable message/reaction/presence
      // caches and hard-cap the rest, then sweep periodically.
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        ReactionManager: 0,
        GuildMemberManager: { maxSize: 0, keepOverLimit: (m) => m.id === this.client.user.id },
        UserManager: { maxSize: 0, keepOverLimit: (u) => u.id === this.client.user.id },
        PresenceManager: 0,
        ThreadManager: 0,
      }),
      sweepers: {
        ...Options.DefaultSweeperSettings,
        messages: { interval: 3600, lifetime: 1800 },
        users: { interval: 3600, filter: () => (u) => u.id !== this.client.user.id },
      },
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
    this.cache = new TournamentCache();
    // channelId → { roundTitle, judges: [{ name, philosophy, paradigmUrl }] }
    // Populated by the last pairing report so `judge summary` can regenerate.
    this._lastReportJudges = new Map();
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
      if (/\w+=/.test(text)) {
        await this._handleChannelOverride(message, text);
        return;
      }
    }

    // Check if the bot is mentioned
    if (!message.mentions.has(this.client.user)) return;

    // Strip the mention to extract the command
    const content = message.content
      .replace(/<@[!&]?\d+>/g, '')  // remove user and role mentions
      .trim();

    console.log(`[handleMessage] Raw: "${message.content}"`);
    console.log(`[handleMessage] Parsed content: "${content}"`);

    if (!content) {
      await message.reply({ embeds: [this.buildHelpEmbed()] });
      return;
    }

    // Check for tournament management commands
    const lowerContent = content.toLowerCase();

    // Fuzzy match for "initiate pairings reports" — allow typos, missing words, URL anywhere
    const tabroomUrlMatch = content.match(/https?:\/\/(?:www\.)?tabroom\.com\S+/i);

    // Coach reports — must be checked before judge lookup fallthrough
    if (/report\s*coaches/i.test(content)) {
      const url = tabroomUrlMatch ? tabroomUrlMatch[0] : '';
      await this.handleReportCoaches(message, url);
      return;
    }

    if (/\binit\w*\s+pair/i.test(lowerContent) || /\bpairings?\s+reports?\b/i.test(lowerContent)) {
      const url = tabroomUrlMatch ? tabroomUrlMatch[0] : '';
      await this.handleInitiatePairings(message, url);
      return;
    }

    // Pre-cache opponent caselist data / judge paradigms for a tournament.
    // Must be checked before the judge-lookup fallthrough.
    if (/^cache\s+opp/i.test(lowerContent)) {
      const url = tabroomUrlMatch ? tabroomUrlMatch[0] : '';
      await this.handleCacheOpponents(message, url);
      return;
    }

    if (/^cache\s+parad/i.test(lowerContent)) {
      const url = tabroomUrlMatch ? tabroomUrlMatch[0] : '';
      await this.handleCacheParadigms(message, url);
      return;
    }

    if (lowerContent === 'stop pairings' || lowerContent === 'cancel') {
      await this.handleStopPairings(message);
      return;
    }

    if (lowerContent === 'end') {
      await this.handleEnd(message);
      return;
    }

    if (/^judge\s+summ/i.test(lowerContent)) {
      await this.handleJudgeSummary(message);
      return;
    }

    if (lowerContent.startsWith('add entry ')) {
      await this.handleAddEntry(message, content.slice('add entry '.length).trim());
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

    if (lowerContent === 'poll test' || lowerContent === 'health' || lowerContent === 'alive') {
      await this.handlePollTest(message);
      return;
    }

    if (lowerContent === 'stop coaches') {
      this.store.clearCoaches();
      await message.reply('✅ Coach reports stopped.');
      return;
    }

    if (lowerContent.startsWith('set coaches channel')) {
      const coachData = this.store.getCoaches();
      if (!coachData) {
        await message.reply('⚠️ No coach reports active. Use `@Clerk Kent report coaches <url>` first.');
        return;
      }

      // Check for a #channel mention or channel name argument
      const channelMention = message.mentions.channels.first();
      const arg = content.replace(/^set\s+coaches\s+channel\s*/i, '').trim();

      let targetChannel = null;
      if (channelMention) {
        targetChannel = channelMention;
      } else if (arg) {
        // Find channel by name (case-insensitive)
        targetChannel = message.guild.channels.cache.find(
          ch => ch.name.toLowerCase() === arg.toLowerCase() && ch.isTextBased()
        );
      } else {
        targetChannel = message.channel;
      }

      if (!targetChannel) {
        await message.reply(`⚠️ Could not find a channel named **${arg}**. Try a #mention or exact name.`);
        return;
      }

      coachData.channelId = targetChannel.id;
      this.store.setCoaches(coachData);
      await message.reply(`✅ Coach reports will now be sent to <#${targetChannel.id}>.`);
      return;
    }

    if (lowerContent.startsWith('set hq channel')) {
      const channelMention = message.mentions.channels.first();
      const arg = content.replace(/^set\s+hq\s+channel\s*/i, '').trim();

      let targetChannel = null;
      if (channelMention) {
        targetChannel = channelMention;
      } else if (arg) {
        targetChannel = message.guild.channels.cache.find(
          ch => ch.name.toLowerCase() === arg.toLowerCase() && ch.isTextBased()
        );
      } else {
        targetChannel = message.channel;
      }

      if (!targetChannel) {
        await message.reply(`⚠️ Could not find a channel named **${arg}**.`);
        return;
      }

      this.store.settings.hqChannelId = targetChannel.id;
      this.store.save();
      await message.reply(`📺 All reports will also be mirrored to <#${targetChannel.id}>.`);
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

    // Set school names: "set schools Dartmouth, Interlake"
    if (/^set\s+schools?\s+/i.test(lowerContent)) {
      const raw = content.replace(/^set\s+schools?\s+/i, '').trim();
      if (raw) {
        const names = raw.split(/,\s*/).map(s => s.trim()).filter(Boolean);
        this.store.setSchoolNames(names);
        await message.reply(`✅ Tracked schools set to: **${names.join(', ')}**`);
      } else {
        const current = this.store.getSchoolNames().join(', ');
        await message.reply(`ℹ️ Current schools: **${current}**\nUsage: \`@Clerk Kent set schools School1, School2\``);
      }
      return;
    }

    // Set season year: "set season 26" — the single knob that rolls every
    // caselist slug over to the new season (hspolicy26 / ndtceda26, etc.)
    if (/^set\s+season\s+/i.test(lowerContent)) {
      const raw = content.replace(/^set\s+season\s+/i, '').trim();
      if (raw) {
        const year = this.store.setSeasonYear(raw);
        await message.reply(
          `✅ Season set to **20${year}** — caselist is now **${this.store.getCaselistSlug()}**.`
        );
      } else {
        await message.reply(
          `ℹ️ Current season: **20${this.store.getSeasonYear()}** (caselist: **${this.store.getCaselistSlug()}**)\nUsage: \`@Clerk Kent set season 26\``
        );
      }
      return;
    }

    // Set caselist: "set caselist ndtceda26" or "set caselist hspolicy26"
    if (/^set\s+caselist\s+/i.test(lowerContent)) {
      const slug = content.replace(/^set\s+caselist\s+/i, '').trim();
      if (slug) {
        this.store.setCaselistSlug(slug);
        await message.reply(`✅ Caselist set to **${slug}**`);
      } else {
        await message.reply(`ℹ️ Current caselist: **${this.store.getCaselistSlug()}**\nUsage: \`@Clerk Kent set caselist ndtceda26\``);
      }
      return;
    }

    // Default: show help for unrecognized commands
    console.log(`[handleMessage] Unrecognized command: "${content}"`);
    await message.reply({ embeds: [this.buildHelpEmbed()] });
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

      // Auto-detect school tier (HS first, then college)
      const tierMatch = this.store.matchSchoolTier(result.entries);

      if (!tierMatch) {
        const allSchools = this.store.getSchoolTiers()
          .flatMap(t => t.schools).join(', ');
        await message.reply(
          `⚠️ No teams matching tracked schools (${allSchools}) found in entries.\n` +
          `You can manually add entries with \`@Clerk Kent add entry <team_code> #channel\`.`
        );
        return;
      }

      const ourEntries = tierMatch.entries;
      const detectedCaselist = tierMatch.tier.caselist;
      const detectedLabel = tierMatch.tier.label;

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
          `📑 Detected caselist: **${detectedLabel}** (\`${detectedCaselist}\`)\n\n` +
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
        caselistSlug: detectedCaselist,
        caselistLabel: detectedLabel,
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

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${session.tournamentName} — Channel Mapping`)
      .setDescription(
        lines.join('\n') + '\n\n' +
        `📑 Detected caselist: **${session.caselistLabel || 'HS Policy'}** (\`${session.caselistSlug || this.store.getCaselistSlug()}\`)\n\n` +
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
        const teamSuffixes = this.channelMapper.candidateSuffixes(team);
        if (teamSuffixes.some(s => s.toLowerCase() === suffix.toLowerCase())) {
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

      const caselistSlug = session.caselistSlug || this.store.getCaselistSlug();
      const caselistLabel = session.caselistLabel || 'HS Policy';

      // Build channelMappings as { teamCode: channelId }
      const channelMappings = {};
      for (const [team, info] of Object.entries(session.mapping)) {
        if (info.channelId) {
          channelMappings[team] = info.channelId;
        }
      }

      // Store caselist choice persistently and in the active session
      this.store.setCaselistSlug(caselistSlug);
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
              `📑 Caselist: **${caselistLabel}** (\`${caselistSlug}\`)\n` +
              `📧 Email monitor started — pairing reports will be sent automatically.\n` +
              `Use \`@Clerk Kent stop pairings\` to stop.`
            )
            .setColor(0x2ecc71)
        ],
        components: [this._buildPipelineButtons()],
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
    } else if (interaction.customId === 'pairings_restart') {
      const session = this.store.getActiveSession();
      if (!session) {
        await interaction.reply({ content: '⚠️ No active session to restart.', ephemeral: true });
        return;
      }

      // Stop existing email monitor
      if (this.emailMonitor) {
        this.emailMonitor.stop();
        this.emailMonitor = null;
      }

      // Clear processed emails and reported pairings so the monitor starts fresh
      session.processedEmailUids = [];
      session.reportedPairings = [];
      session.emailMonitorActive = true;
      this.store.save();

      // Restart email monitor with same session
      this.emailMonitor = new EmailMonitor({
        email: process.env.IMAP_EMAIL,
        password: process.env.IMAP_PASSWORD,
      });

      this.emailMonitor.on('pairing', (eventData) => this.handlePairingEvent(eventData));
      this.emailMonitor.on('error', (err) => console.error('[EmailMonitor] Error:', err.message));
      this.emailMonitor.on('connected', () => console.log('📧 Email monitor reconnected (restarted)'));
      this.emailMonitor.start();

      const teamList = Object.entries(session.channelMappings)
        .map(([team, chId]) => `• **${team}** → <#${chId}>`)
        .join('\n');

      const caselistSlug = this.store.getCaselistSlug();

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🔄 Pipeline Restarted — Tournament ${session.tournId}`)
            .setDescription(
              `${teamList}\n\n` +
              `📑 Caselist: \`${caselistSlug}\`\n` +
              `📧 Email monitor restarted with same channel mappings.\n` +
              `Processed email history cleared — new emails will be picked up.\n` +
              `Use \`@Clerk Kent stop pairings\` to stop.`
            )
            .setColor(0x2ecc71)
            .setTimestamp()
        ],
        components: [this._buildPipelineButtons()],
      });
    } else if (interaction.customId === 'hq_mirror') {
      await this._handleHqMirrorButton(interaction);
    } else if (interaction.customId === 'hq_stop') {
      delete this.store.settings.hqChannelId;
      this.store.save();
      await interaction.update({
        content: '✅ HQ mirroring stopped.',
        embeds: interaction.message.embeds,
        components: [this._buildPipelineButtons()],
      });
    }
  }

  /**
   * Build the standard button row for the pipeline active card.
   */
  _buildPipelineButtons() {
    const hqActive = !!this.store.settings.hqChannelId;
    const buttons = [
      new ButtonBuilder()
        .setCustomId('pairings_restart')
        .setLabel('🔄 Restart Pipeline')
        .setStyle(ButtonStyle.Secondary),
    ];
    if (hqActive) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId('hq_stop')
          .setLabel('📺 Stop HQ Mirror')
          .setStyle(ButtonStyle.Danger)
      );
    } else {
      buttons.push(
        new ButtonBuilder()
          .setCustomId('hq_mirror')
          .setLabel('📺 Mirror to HQ')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    return new ActionRowBuilder().addComponents(buttons);
  }

  /**
   * Handle the "Mirror to HQ" button — finds tournament-hq channel or prompts.
   */
  async _handleHqMirrorButton(interaction) {
    const guild = interaction.guild;
    // Try to find a channel named tournament-hq
    const hqChannel = guild.channels.cache.find(
      ch => ch.name.toLowerCase() === 'tournament-hq' && ch.isTextBased()
    );

    if (hqChannel) {
      this.store.settings.hqChannelId = hqChannel.id;
      this.store.save();
      await interaction.update({
        embeds: interaction.message.embeds,
        components: [this._buildPipelineButtons()],
      });
      await interaction.followUp({
        content: `📺 All reports (pairings + coaches) will now also be sent to <#${hqChannel.id}>.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: '⚠️ No channel named **tournament-hq** found. Create one or use `@Clerk Kent set hq channel <name>` to pick a different channel.',
        ephemeral: true,
      });
    }
  }

  /**
   * Mirror embeds to the HQ channel if configured.
   */
  async _mirrorToHQ(embeds) {
    const hqChannelId = this.store.settings.hqChannelId;
    if (!hqChannelId) return;
    try {
      const hqChannel = await this.client.channels.fetch(hqChannelId);
      if (hqChannel) {
        await hqChannel.send({ embeds: embeds.slice(0, 10) });
      }
    } catch (err) {
      console.error('[HQ Mirror] Failed to send:', err.message);
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
    await message.reply('✅ Pairings pipeline stopped and session cleared.');
  }

  /**
   * Handle: @Clerk Kent end
   * Stops the session (like `stop pairings`) AND wipes all primed tournament
   * caches + in-memory service caches to reclaim disk and heap between events.
   */
  async handleEnd(message) {
    if (this._pendingSession) this._pendingSession = null;
    if (this.emailMonitor) {
      this.emailMonitor.stop();
      this.emailMonitor = null;
    }
    this.store.clearActiveSession();

    let removed = 0;
    try { removed = this.cache.clearAll(); } catch (_) { /* ignore */ }
    try { this.caselistService.clearCache(); } catch (_) { /* ignore */ }
    this._lastReportJudges = new Map();

    await message.reply(
      `✅ Session ended. Stopped the pairings pipeline and cleared **${removed}** cache file(s) ` +
      '(opponents + judges) plus in-memory data.'
    );
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

      // Check if this is a coach assignment email before completeness check
      // Coach emails may not pass _isCompletePairing if body parsing is partial
      const coachData = this.store.getCoaches();
      if (coachData && parsed && parsed.teamCode) {
        const subjectName = parsed.teamCode.toLowerCase();
        const matchedCoach = coachData.coaches.find(
          c => subjectName.startsWith(c.name.toLowerCase()) ||
               subjectName.includes(c.name.toLowerCase())
        );
        if (matchedCoach) {
          console.log(`[handlePairingEvent] Coach email detected: ${matchedCoach.name} (subject: "${parsed.teamCode}")`);
          await this._processCoachPairing(matchedCoach, parsed, coachData.channelId);
          if (this.emailMonitor) this.emailMonitor.enterSlowMode();
          return;
        }
      }

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

      const schoolNames = this.store.getSchoolNames()
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

          const pairingData = {
            ourTeamCode: entry.teamCode,
            opponentCode: entry.opponent,
            opponentSide,
            side: entry.side,
            room: entry.room,
            judges: entry.judges || [],
            roundTitle: parsed.roundTitle,
            startTime: parsed.startTime,
            roundNumber: null,
          };

          await this._processSinglePairing(pairingData, session);
        }
      } else {
        // Format A: single live update pairing
        const affCode = parsed.aff?.teamCode || '';
        const negCode = parsed.neg?.teamCode || '';
        const subjectCode = parsed.teamCode || '';
        const matchesOurSchool = (code) =>
          !!code && schoolNames.some(s => code.toLowerCase().startsWith(s));
        const affIsOurs = matchesOurSchool(affCode);
        const negIsOurs = matchesOurSchool(negCode);
        const subjectIsOurs = matchesOurSchool(subjectCode);

        let ourTeamCode, opponentCode, opponentSide, side;
        const isFlip = parsed.side === 'FLIP';
        if (affIsOurs && !negIsOurs) {
          ourTeamCode = affCode;
          opponentCode = negCode;
          opponentSide = isFlip ? null : 'N';
          side = isFlip ? 'FLIP' : 'AFF';
        } else if (negIsOurs && !affIsOurs) {
          ourTeamCode = negCode;
          opponentCode = affCode;
          opponentSide = isFlip ? null : 'A';
          side = isFlip ? 'FLIP' : 'NEG';
        } else if (subjectIsOurs) {
          // The body's competitor lines didn't cleanly identify us — this happens
          // when the plain-text body parses partially and the LLM fallback mangles
          // the team codes. The email subject is the reliable identity (the
          // notification is addressed to our team), so route on it and derive the
          // opponent/side from whatever body data is available.
          ourTeamCode = subjectCode;
          const parsedSide = (parsed.side || '').toUpperCase();
          if (parsedSide === 'AFF') {
            opponentCode = negCode; opponentSide = 'N'; side = 'AFF';
          } else if (parsedSide === 'NEG') {
            opponentCode = affCode; opponentSide = 'A'; side = 'NEG';
          } else if (parsedSide === 'FLIP') {
            opponentCode = negCode || affCode; opponentSide = null; side = 'FLIP';
          } else {
            // Unknown side — the opponent is whichever competitor isn't our school.
            opponentCode = (affCode && !affIsOurs) ? affCode : (!negIsOurs ? negCode : '');
            opponentSide = null; side = null;
          }
          // Never scout ourselves: if the derived opponent is our own school
          // (e.g. a hallucinated code), drop it so we still post judge/room info.
          if (matchesOurSchool(opponentCode)) opponentCode = '';
          console.log(`[handlePairingEvent] Routing on subject identity: "${ourTeamCode}" (opponent: "${opponentCode || 'unknown'}", side: ${side || 'unknown'})`);
        } else {
          // Not our team — check if this is a coach assignment email
          const coachData = this.store.getCoaches();
          if (coachData && parsed.teamCode) {
            const subjectName = parsed.teamCode.toLowerCase();
            console.log(`[handlePairingEvent] Checking coach match: subject="${subjectName}", coaches=[${coachData.coaches.map(c => c.name).join(', ')}]`);
            const matchedCoach = coachData.coaches.find(
              c => subjectName.startsWith(c.name.toLowerCase()) ||
                   subjectName.includes(c.name.toLowerCase())
            );
            if (matchedCoach) {
              console.log(`[handlePairingEvent] Matched coach: ${matchedCoach.name}`);
              await this._processCoachPairing(matchedCoach, parsed, coachData.channelId);
              if (this.emailMonitor) this.emailMonitor.enterSlowMode();
              return;
            }
            console.log(`[handlePairingEvent] No coach match found`);
          }
          return;
        }

        const pairingData = {
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
        };

        await this._processSinglePairing(pairingData, session);
      }

      // Switch to slow polling now that a round is in progress
      if (this.emailMonitor) this.emailMonitor.enterSlowMode();
    } catch (err) {
      console.error('[handlePairingEvent] Error:', err);
    }
  }

  /**
   * Resolve the Discord channel id for a team code from the active session's
   * channelMappings, tolerant of team-code spelling differences between setup
   * (entries page) and the pairing email:
   *   1. exact key match
   *   2. normalized match (case-insensitive, collapsed whitespace)
   *   3. suffix match (same debater initials, e.g. full names ↔ short code)
   * Returns the channelId string, or null if nothing matches.
   */
  _resolveChannelId(session, teamCode) {
    const mappings = (session && session.channelMappings) || {};
    if (!teamCode) return null;
    if (mappings[teamCode]) return mappings[teamCode];

    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const target = norm(teamCode);
    for (const [key, id] of Object.entries(mappings)) {
      if (norm(key) === target) return id;
    }

    const mapper = this.channelMapper || new ChannelMapper(null);
    const wanted = new Set(
      mapper.candidateSuffixes(teamCode).map((c) => c.toLowerCase())
    );
    if (wanted.size > 0) {
      for (const [key, id] of Object.entries(mappings)) {
        const keySuffixes = mapper
          .candidateSuffixes(key)
          .map((c) => c.toLowerCase());
        if (keySuffixes.some((c) => wanted.has(c))) return id;
      }
    }
    return null;
  }

  /**
   * Process a single team's pairing: look up opponent, judges, send report.
   */
  async _processSinglePairing(pairing, session) {
    const { ourTeamCode, opponentCode, opponentSide, side, room, judges,
            roundTitle, startTime, roundNumber, aff, neg } = pairing;

    // Deduplicate: skip if we already sent a report for this team+round
    const dedupKey = `${ourTeamCode}::${roundTitle || ''}::${roundNumber || ''}`.toLowerCase();
    if (this.store.isPairingReported(dedupKey)) {
      console.log(`[Pairing] Skipping duplicate report for ${ourTeamCode} in ${roundTitle || 'Round ' + roundNumber}`);
      return;
    }
    this.store.markPairingReported(dedupKey);

    // Find the channel for our team
    const channelId = this._resolveChannelId(session, ourTeamCode);
    if (!channelId) {
      console.warn(`[Pairing] No channel mapped for ${ourTeamCode}`);
      return;
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) return;

    await channel.sendTyping();

    const caselistSlug = this.store.getCaselistForTeam(ourTeamCode);

    // Look up opponent on caselist using entry names from Tabroom
    let opponentData = null;
    let argumentSummary = '_No caselist data found._';
    if (opponentCode) {
      const opponentEntryNames = this.store.getEntryNamesForTeam(opponentCode);
      if (opponentEntryNames) {
        console.log(`[Pairing] Opponent ${opponentCode} entry names: "${opponentEntryNames}"`);
      }

      if (opponentSide) {
        // Known side: single lookup
        const caselistResult = await this._lookupOpponentCached(session, opponentCode, opponentSide, opponentEntryNames, caselistSlug);
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
            side: opponentSide === 'A' ? 'Aff' : 'Neg',
            argumentSummary,
          };
        }
      } else {
        // FLIP: look up both aff and neg sides
        const [affResult, negResult] = await Promise.all([
          this._lookupOpponentCached(session, opponentCode, 'A', opponentEntryNames, caselistSlug),
          this._lookupOpponentCached(session, opponentCode, 'N', opponentEntryNames, caselistSlug),
        ]);

        const downloadUrlFn = (path) => this.caselistService.getDownloadUrl(path);
        let affSummary = '_No caselist data found._';
        let negSummary = '_No caselist data found._';
        let affUrl = null;
        let negUrl = null;
        let schoolName = opponentCode;
        let teamCode = '';

        if (affResult && affResult.rounds.length > 0) {
          affSummary = this.llmService.summarizeWithFallback(affResult.rounds, 'A', downloadUrlFn);
          affUrl = affResult.caselistUrl;
          schoolName = affResult.schoolName;
          teamCode = affResult.teamCode;
        }
        if (negResult && negResult.rounds.length > 0) {
          const negContext = { ourAff: this.store.getOurAff() };
          negSummary = this.llmService.summarizeWithFallback(negResult.rounds, 'N', downloadUrlFn, negContext);
          negUrl = negResult.caselistUrl;
          if (!teamCode) {
            schoolName = negResult.schoolName;
            teamCode = negResult.teamCode;
          }
        }

        opponentData = {
          schoolName,
          teamCode,
          side: 'FLIP',
          affCaselistUrl: affUrl,
          negCaselistUrl: negUrl,
          affArgumentSummary: affSummary,
          negArgumentSummary: negSummary,
        };
      }
    }

    // Build pairing data for the embed
    const pairingEmbed = {
      roundTitle: roundTitle || `Round ${roundNumber || '?'}`,
      startTime,
      room,
      side,
      teamCode: ourTeamCode,
      aff: aff || { teamCode: side === 'NEG' ? opponentCode : ourTeamCode },
      neg: neg || { teamCode: side === 'NEG' ? ourTeamCode : opponentCode },
    };

    // Phase 1: Send pairing + opponent info immediately
    const initialEmbeds = this.reportBuilder.buildFullReport(pairingEmbed, opponentData, []);

    // Add placeholder judge embeds with "Loading..." while paradigms are fetched
    const validJudges = judges.filter(j => {
      const n = j.name;
      return n && n.length >= 3 && !/^-+$/.test(n) && !/^(thanks|sent from|cheers)/i.test(n);
    });
    // Deduplicate judges by name (Tabroom emails sometimes list the same judge twice)
    const seenNames = new Set();
    const uniqueJudges = validJudges.filter(j => {
      const key = j.name.toLowerCase().trim();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
    for (const judge of uniqueJudges) {
      initialEmbeds.push(this.reportBuilder.buildJudgeEmbed({
        name: judge.name,
      }));
    }

    let sentMessage = null;
    if (initialEmbeds.length > 0) {
      sentMessage = await channel.send({ embeds: initialEmbeds.slice(0, 10) });
      console.log(`📨 Sent initial report for ${ourTeamCode} (${roundTitle || 'Round ' + (roundNumber || '?')})`);
    }

    // Phase 2: Fetch judge paradigm links + Notion notes in parallel, then edit
    // the message. AI paradigm summaries are intentionally NOT generated here
    // (they're slow + pull in the LLM); run `@Clerk Kent judge summary` on demand.
    if (sentMessage && uniqueJudges.length > 0) {
      const judgePromises = uniqueJudges.map(async (judge) => {
        const judgeName = judge.name;
        let paradigmUrl = null;
        let school = null;
        let philosophy = null;

        try {
          const paradigm = await this._fetchParadigmCached(session, judgeName);
          if (paradigm) {
            paradigmUrl = paradigm.paradigmUrl;
            school = paradigm.school;
            philosophy = paradigm.philosophy || null;
          }
        } catch (err) {
          console.error(`[Pairing] Failed to fetch paradigm for ${judgeName}:`, err.message);
        }

        let notionNotes = null;
        let notionUrl = null;
        try {
          const notionResults = await this.notion.searchJudge(judgeName);
          if (notionResults.length > 0) {
            const j = notionResults[0];
            notionUrl = j.url || null;
            if (j.comments && j.comments.length > 0) {
              notionNotes = j.comments.map((c, i) => `**${i + 1}.** ${c}`).join('\n');
              if (notionNotes.length > 500) notionNotes = notionNotes.slice(0, 497) + '...';
            }
          }
        } catch (err) {
          console.error(`[Pairing] Failed to fetch Notion data for ${judgeName}:`, err.message);
        }

        return {
          name: judgeName,
          paradigmUrl, school, philosophy, notionNotes, notionUrl,
        };
      });

      const judgeEmbedData = await Promise.all(judgePromises);

      // Remember this round's judges (name + philosophy) for this channel so a
      // later `@Clerk Kent judge summary` can generate AI summaries on demand.
      this._rememberReportJudges(channel.id, roundTitle || `Round ${roundNumber || '?'}`, judgeEmbedData);

      // Rebuild full embeds with completed judge data and edit the message
      const finalEmbeds = this.reportBuilder.buildFullReport(pairingEmbed, opponentData, judgeEmbedData);
      try {
        await sentMessage.edit({ embeds: finalEmbeds.slice(0, 10) });
        console.log(`✅ Updated report with paradigms for ${ourTeamCode}`);
        await this._mirrorToHQ(finalEmbeds);
      } catch (err) {
        console.error(`[Pairing] Failed to edit message with paradigms:`, err.message);
      }
    } else if (initialEmbeds.length > 0) {
      // No judges — mirror the initial embeds
      await this._mirrorToHQ(initialEmbeds);
    }
  }

  /**
   * Look up an opponent's caselist data, preferring the primed tournament
   * cache when one exists for the active session's tournament.
   *
   * Returns `undefined`/live-result semantics from CaselistService, except a
   * cached entry (including a cached "not found", stored as `null`) short-circuits
   * the live call. Teams not present in the cache fall back to a live lookup.
   */
  async _lookupOpponentCached(session, opponentCode, side, entryNames, caselistSlug) {
    const tournId = session && session.tournId;
    if (tournId && this.cache.hasOpponents(tournId)) {
      const cached = this.cache.getOpponent(tournId, opponentCode, side);
      if (cached !== undefined) {
        console.log(`[Cache] Opponent ${opponentCode} (${side}) served from cache`);
        return cached;
      }
      console.log(`[Cache] Opponent ${opponentCode} (${side}) not primed — fetching live`);
    }
    return this.caselistService.lookupOpponent(opponentCode, side, entryNames, caselistSlug);
  }

  /**
   * Fetch a judge's paradigm, preferring the primed tournament cache when one
   * exists for the active session's tournament. Judges not present in the cache
   * fall back to a live Tabroom fetch.
   */
  async _fetchParadigmCached(session, judgeName) {
    const tournId = session && session.tournId;
    if (tournId && this.cache.hasParadigms(tournId)) {
      const cached = this.cache.getParadigm(tournId, judgeName);
      if (cached !== undefined) {
        console.log(`[Cache] Paradigm for "${judgeName}" served from cache`);
        return cached;
      }
      console.log(`[Cache] Paradigm for "${judgeName}" not primed — fetching live`);
    }
    return this.paradigmService.fetchParadigmByName(judgeName);
  }

  /**
   * Record the judges shown in the most recent pairing report for a channel,
   * keeping only what's needed to build an AI summary later. Overwrites the
   * previous entry (bounded memory — one report per channel).
   */
  _rememberReportJudges(channelId, roundTitle, judgeEmbedData) {
    const judges = (judgeEmbedData || [])
      .filter(j => j && j.name)
      .map(j => ({
        name: j.name,
        philosophy: j.philosophy || null,
        paradigmUrl: j.paradigmUrl || null,
        notionNotes: j.notionNotes || null,
        notionUrl: j.notionUrl || null,
      }));
    if (judges.length === 0) {
      this._lastReportJudges.delete(channelId);
      return;
    }
    this._lastReportJudges.set(channelId, { roundTitle, judges });
  }

  /**
   * Handle: @Clerk Kent judge summary
   * Generates an AI paradigm summary for each judge listed in the last pairing
   * report posted in this channel, keeping the paradigm link + Notion report.
   */
  async handleJudgeSummary(message) {
    const entry = this._lastReportJudges.get(message.channel.id);
    if (!entry || entry.judges.length === 0) {
      await message.reply('_No recent pairing report in this channel to summarize. I only remember the most recent round per channel._');
      return;
    }

    const withText = entry.judges.filter(j => j.philosophy && j.philosophy.trim());
    const progress = await message.reply(
      withText.length > 0
        ? `⏳ Summarizing ${withText.length} paradigm(s) for **${entry.roundTitle}**…`
        : `⏳ Building judge cards for **${entry.roundTitle}**…`
    );

    const embeds = await Promise.all(entry.judges.map(async (j) => {
      let summary;
      if (j.philosophy && j.philosophy.trim()) {
        summary = '_Could not summarize paradigm._';
        try {
          summary = await this.llmService.summarizeParadigm(j.philosophy);
        } catch (err) {
          console.error(`[judge summary] Failed for ${j.name}:`, err.message);
        }
      } else {
        summary = '_No paradigm text available._';
      }
      const truncated = summary.length > 4000 ? summary.slice(0, 3997) + '...' : summary;
      return new EmbedBuilder()
        .setTitle(`⚖️ ${j.name}`)
        .setColor(0x2f80ed)
        .setDescription(truncated);
    }));

    try {
      await progress.edit({ content: `⚖️ AI paradigm summaries — **${entry.roundTitle}**`, embeds: embeds.slice(0, 10) });
    } catch (err) {
      console.error('[judge summary] Failed to edit reply:', err.message);
      await message.channel.send({ embeds: embeds.slice(0, 10) });
    }
  }

  /**
   * Run an async mapper over items with bounded concurrency, invoking an
   * optional progress callback after each item settles.
   */
  async _mapWithConcurrency(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let index = 0;
    let done = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
      while (index < items.length) {
        const current = index++;
        try {
          results[current] = await fn(items[current], current);
        } catch (err) {
          results[current] = null;
        }
        done++;
        if (onProgress) await onProgress(done, items.length);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Scrape a Tabroom judges-list page (authenticated layout) and return
   * [{ firstName, lastName, institution }].
   */
  /**
   * Add an explicit `downloadUrl` to every round that has an open-source doc,
   * so the cached data is self-contained (no need to re-derive at report time).
   */
  _enrichRoundsWithDownloadUrls(result) {
    if (!result || !Array.isArray(result.rounds)) return result;
    for (const round of result.rounds) {
      if (round && round.opensource) {
        round.downloadUrl = this.caselistService.getDownloadUrl(round.opensource);
      }
    }
    return result;
  }

  /**
   * Scrape a Tabroom judges-list page and return one entry per judge:
   *   { firstName, lastName, institution, judgePersonId, judgeId, recordUrl }
   *
   * Columns are mapped from the header row because layouts vary (some pages
   * include a "Middle" column, shifting Last/Institution to the right).
   */
  async _scrapeJudgesList(url) {
    const cheerio = require('cheerio');
    this.paradigmService.loggedIn = false;
    const html = await this.paradigmService.fetchPage(url);
    const $ = cheerio.load(html);

    const headers = [];
    $('#judgelist tr').first().find('th').each((i, el) => {
      headers[i] = $(el).text().trim().toLowerCase();
    });
    const colOf = (label, fallback) => {
      const idx = headers.indexOf(label);
      return idx >= 0 ? idx : fallback;
    };
    const firstCol = colOf('first', 1);
    const lastCol = colOf('last', 3);
    const instCol = colOf('institution', 4);

    const judges = [];
    const seen = new Set();
    $('#judgelist tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length === 0) return; // header row (th only)

      const firstName = cells[firstCol] ? $(cells[firstCol]).text().trim() : '';
      const lastName = cells[lastCol] ? $(cells[lastCol]).text().trim() : '';
      if (!firstName || !lastName) return;

      const instCell = cells[instCol];
      const institution = instCell
        ? ($(instCell).attr('data-text') || $(instCell).text().trim())
        : '';

      const paradigmHref = $(row).find('a[href*="judge_person_id"]').first().attr('href') || '';
      const pidMatch = paradigmHref.match(/judge_person_id=(\d+)/);

      const recordHref = $(row).find('a[href*="postings/judge.mhtml"]').first().attr('href') || '';
      const recordUrl = recordHref
        ? (recordHref.startsWith('http')
            ? recordHref
            : `https://www.tabroom.com${recordHref.startsWith('/') ? '' : '/'}${recordHref}`).replace(/&amp;/g, '&')
        : null;
      const jidMatch = recordHref.match(/judge_id=(\d+)/);

      const key = `${firstName} ${lastName}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      judges.push({
        firstName,
        lastName,
        institution,
        judgePersonId: pidMatch ? pidMatch[1] : null,
        judgeId: jidMatch ? jidMatch[1] : null,
        recordUrl,
      });
    });
    return judges;
  }

  /**
   * Fetch a judge's cross-tournament judging history from their Tabroom record
   * page. Returns an array of { tournament, date, event, round, aff, neg, vote,
   * result }, most-recent first, capped at `limit`.
   */
  async _fetchJudgeHistory(recordUrl, limit = 25) {
    if (!recordUrl) return [];
    const cheerio = require('cheerio');
    let html;
    try {
      html = await this.paradigmService.fetchPage(recordUrl);
    } catch (err) {
      console.warn('[Cache] Judge history fetch failed:', err.message);
      return [];
    }
    const $ = cheerio.load(html);

    // The cross-tournament record table is the one whose header includes "Vote".
    let target = null;
    $('table').each((_, t) => {
      if (target) return;
      const hdr = $(t).find('tr').first().find('th')
        .map((i, e) => $(e).text().trim().toLowerCase()).get();
      if (hdr.includes('vote')) target = { el: t, hdr };
    });
    if (!target) return [];

    const idx = (label) => target.hdr.indexOf(label);
    const iTourn = idx('tournament'), iDate = idx('date'), iEv = idx('ev'),
          iRd = idx('rd'), iAff = idx('aff'), iNeg = idx('neg'),
          iVote = idx('vote'), iResult = idx('result');

    const history = [];
    $(target.el).find('tr').each((_, r) => {
      const cells = $(r).find('td');
      if (cells.length === 0) return; // header
      const cell = (i) => (i >= 0 && cells[i]) ? $(cells[i]).text().replace(/\s+/g, ' ').trim() : '';
      const tournament = cell(iTourn);
      if (!tournament) return;
      const rawDate = cell(iDate);
      const dateMatch = rawDate.match(/\d{4}-\d{2}-\d{2}/);
      history.push({
        tournament,
        date: dateMatch ? dateMatch[0] : rawDate,
        event: cell(iEv),
        round: cell(iRd),
        aff: cell(iAff),
        neg: cell(iNeg),
        vote: cell(iVote),
        result: cell(iResult),
      });
    });
    return history.slice(0, limit);
  }

  /**
   * Handle: @Clerk Kent cache opponents <tabroom_entries_url>
   * Pre-fetches OpenCaselist data for every entry in the tournament so live
   * pairing reports read from disk instead of hitting OpenCaselist.
   */
  async handleCacheOpponents(message, url) {
    if (!url) {
      await message.reply(
        '**Usage:** `@Clerk Kent cache opponents <tabroom_entries_url>`\n' +
        '**Example:** `@Clerk Kent cache opponents https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=36452&event_id=372080`'
      );
      return;
    }

    let progressMsg;
    try {
      await message.channel.sendTyping();

      const parsed = TabroomScraper.parseUrl(url);
      const tournId = parsed.tournId;
      let eventId = parsed.eventId;
      if (!tournId) {
        await message.reply('⚠️ Could not extract a tournament ID from that URL.');
        return;
      }

      let result = await TabroomScraper.scrapeEntries(tournId, eventId);

      // Resolve the event if only a tourn_id was given
      if (!eventId && result.events.length > 0) {
        const policyEvents = result.events.filter(e => /policy|cx/i.test(e.name));
        if (policyEvents.length === 1) {
          eventId = policyEvents[0].eventId;
          result = await TabroomScraper.scrapeEntries(tournId, eventId);
        } else {
          const eventList = result.events.map((e, i) => `**${i + 1}.** ${e.name}`).join('\n');
          await message.reply(
            `📋 **${result.tournamentName}** has multiple events:\n\n${eventList}\n\n` +
            'Re-run with a specific event URL (include the `event_id` parameter).'
          );
          return;
        }
      }

      if (!result.entries || result.entries.length === 0) {
        await message.reply('⚠️ No entries found for this event.');
        return;
      }

      // Determine the caselist for this tournament (from our tracked tier, else default)
      const tierMatch = this.store.matchSchoolTier(result.entries);
      const caselistSlug = tierMatch ? tierMatch.tier.caselist : this.store.getCaselistSlug();

      progressMsg = await message.reply(
        `⏳ Caching opponents for **${result.tournamentName}** — 0/${result.entries.length} teams…`
      );

      const teams = {};
      let withData = 0;
      await this._mapWithConcurrency(result.entries, 4, async (entry) => {
        const [aff, neg] = await Promise.all([
          this.caselistService.lookupOpponent(entry.code, 'A', entry.entry, caselistSlug),
          this.caselistService.lookupOpponent(entry.code, 'N', entry.entry, caselistSlug),
        ]);
        this._enrichRoundsWithDownloadUrls(aff);
        this._enrichRoundsWithDownloadUrls(neg);
        teams[entry.code.toLowerCase()] = { A: aff || null, N: neg || null };
        if ((aff && aff.rounds && aff.rounds.length) || (neg && neg.rounds && neg.rounds.length)) {
          withData++;
        }
      }, async (done, total) => {
        if (done === total || done % 10 === 0) {
          try {
            await progressMsg.edit(
              `⏳ Caching opponents for **${result.tournamentName}** — ${done}/${total} teams…`
            );
          } catch (_) { /* ignore edit races */ }
        }
      });

      this.cache.saveOpponents(tournId, {
        tournamentName: result.tournamentName,
        eventId,
        caselistSlug,
      }, teams);

      await progressMsg.edit(
        `✅ Cached opponents for **${result.tournamentName}** (\`tourn_id=${tournId}\`).\n` +
        `📦 ${result.entries.length} teams stored — ${withData} with caselist data.\n` +
        'Live reports for this tournament will now read from this cache.'
      );
    } catch (err) {
      console.error('[handleCacheOpponents] Error:', err);
      const msg = `⚠️ Failed to cache opponents: ${err.message}`;
      if (progressMsg) { try { await progressMsg.edit(msg); return; } catch (_) {} }
      await message.reply(msg);
    }
  }

  /**
   * Handle: @Clerk Kent cache paradigms <tabroom_judges_url>
   * Pre-fetches judge paradigms for the tournament so live pairing reports read
   * from disk instead of scraping Tabroom.
   */
  async handleCacheParadigms(message, url) {
    if (!url || !url.includes('judges.mhtml')) {
      await message.reply(
        '**Usage:** `@Clerk Kent cache paradigms <tabroom_judges_url>`\n' +
        '**Example:** `@Clerk Kent cache paradigms https://www.tabroom.com/index/tourn/judges.mhtml?category_id=85045&tourn_id=32045`'
      );
      return;
    }

    let progressMsg;
    try {
      await message.channel.sendTyping();

      const tournId = TabroomScraper.parseUrl(url).tournId;
      if (!tournId) {
        await message.reply('⚠️ Could not extract a tournament ID from that judges URL.');
        return;
      }

      const judgeList = await this._scrapeJudgesList(url);
      if (judgeList.length === 0) {
        await message.reply('⚠️ No judges found on that page. Make sure it\'s a Tabroom judges list URL.');
        return;
      }

      progressMsg = await message.reply(
        `⏳ Caching paradigms — 0/${judgeList.length} judges…`
      );

      const judges = {};
      let withParadigm = 0;
      let withHistory = 0;
      await this._mapWithConcurrency(judgeList, 3, async (j) => {
        const fullName = `${j.firstName} ${j.lastName}`;

        let paradigm = null;
        try {
          paradigm = j.judgePersonId
            ? await this.paradigmService.fetchParadigm(j.judgePersonId)
            : await this.paradigmService.fetchParadigmByName(fullName);
        } catch (err) {
          console.warn(`[handleCacheParadigms] Paradigm failed for ${fullName}:`, err.message);
        }

        const history = await this._fetchJudgeHistory(j.recordUrl);

        judges[TournamentCache.normalizeName(fullName)] = {
          name: fullName,
          firstName: j.firstName,
          lastName: j.lastName,
          school: (paradigm && paradigm.school) || j.institution || null,
          philosophy: (paradigm && paradigm.philosophy) || null,
          paradigmUrl: (paradigm && paradigm.paradigmUrl) ||
            (j.judgePersonId ? `https://www.tabroom.com/index/paradigm.mhtml?judge_person_id=${j.judgePersonId}` : null),
          judgePersonId: j.judgePersonId,
          judgeId: j.judgeId,
          historyUrl: j.recordUrl,
          history,
        };

        if (paradigm && paradigm.philosophy) withParadigm++;
        if (history.length) withHistory++;
      }, async (done, total) => {
        if (done === total || done % 10 === 0) {
          try {
            await progressMsg.edit(`⏳ Caching judges — ${done}/${total} (paradigm + history)…`);
          } catch (_) { /* ignore edit races */ }
        }
      });

      this.cache.saveParadigms(tournId, judges);

      await progressMsg.edit(
        `✅ Cached judges (\`tourn_id=${tournId}\`).\n` +
        `📦 ${judgeList.length} judges stored — ${withParadigm} with a paradigm, ${withHistory} with judging history.\n` +
        'Live reports for this tournament will now read from this cache.'
      );
    } catch (err) {
      console.error('[handleCacheParadigms] Error:', err);
      const msg = `⚠️ Failed to cache paradigms: ${err.message}`;
      if (progressMsg) { try { await progressMsg.edit(msg); return; } catch (_) {} }
      await message.reply(msg);
    }
  }

  /**
   * Send a simplified coach report — only coach name, start time, room, and competitors.
   * No paradigm/wiki/caselist lookups.
   */
  async _processCoachPairing(coach, parsed, channelId) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        console.error(`[CoachPairing] Could not find channel ${channelId}`);
        return;
      }

      const roundLabel = parsed.roundTitle || `Round ${parsed.roundNumber || '?'}`;
      const affCode = parsed.aff?.teamCode || 'TBD';
      const negCode = parsed.neg?.teamCode || 'TBD';
      const affNames = (parsed.aff?.names || []).join(', ');
      const negNames = (parsed.neg?.names || []).join(', ');

      let competitorText = '';
      if (parsed.side === 'FLIP') {
        competitorText = `**${affCode}**${affNames ? ` — ${affNames}` : ''}\nvs\n**${negCode}**${negNames ? ` — ${negNames}` : ''}`;
      } else {
        competitorText =
          `🟢 AFF: **${affCode}**${affNames ? ` — ${affNames}` : ''}\n` +
          `🔴 NEG: **${negCode}**${negNames ? ` — ${negNames}` : ''}`;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🧑‍🏫 ${coach.name} — ${roundLabel}`)
        .setColor(0x9b59b6)
        .addFields(
          { name: '⏰ Start', value: parsed.startTime || 'TBD', inline: true },
          { name: '📍 Room', value: parsed.room || 'TBD', inline: true },
          { name: 'Competitors', value: competitorText, inline: false }
        )
        .setFooter({ text: `Coach report • ${coach.institution}` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      await this._mirrorToHQ([embed]);
      console.log(`✅ Sent coach report for ${coach.name} — ${roundLabel}`);
    } catch (err) {
      console.error(`[CoachPairing] Error sending report for ${coach.name}:`, err);
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
  /**
   * Handle: @Clerk Kent report coaches <judges_page_url>
   * Scrapes the judges page, finds coaches from our schools, stores them,
   * and sets up monitoring for their judging assignment emails.
   */
  async handleReportCoaches(message, url) {
    if (!url || !url.includes('judges.mhtml')) {
      await message.reply(
        '**Usage:** `@Clerk Kent report coaches <tabroom_judges_url>`\n' +
        '**Example:** `@Clerk Kent report coaches https://www.tabroom.com/index/tourn/judges.mhtml?category_id=96220&tourn_id=36156`'
      );
      return;
    }

    try {
      await message.channel.sendTyping();

      // Force fresh login then fetch judges page
      const cheerio = require('cheerio');
      this.paradigmService.loggedIn = false;
      const html = await this.paradigmService.fetchPage(url);
      console.log(`[handleReportCoaches] Fetched page, length=${html.length}, has #judgelist=${html.includes('judgelist')}`);
      const $ = cheerio.load(html);
      const allJudges = [];

      // Debug: log table structure
      const tableEl = $('#judgelist');
      console.log(`[handleReportCoaches] #judgelist found: ${tableEl.length}`);
      console.log(`[handleReportCoaches] #judgelist children: ${tableEl.children().map((i,el) => el.tagName).get().join(', ')}`);
      const allRows = $('#judgelist tr');
      console.log(`[handleReportCoaches] Total tr count: ${allRows.length}`);
      if (allRows.length > 0) {
        const firstRow = allRows.first();
        const firstCells = firstRow.find('td, th');
        console.log(`[handleReportCoaches] First row cells: ${firstCells.length}, tags: ${firstCells.map((i,el) => el.tagName).get().join(',')}`);
        console.log(`[handleReportCoaches] First row HTML (200ch): ${firstRow.html().substring(0, 200)}`);
      }

      // Parse all rows with td cells
      // Authenticated view has columns: Paradigm(0), First(1), Last(2), Institution(3), Location(4), Rounds(5), Record(6)
      $('#judgelist tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 4) return;

        const firstName = $(cells[1]).text().trim();
        const lastName = $(cells[2]).text().trim();
        const institution = $(cells[3]).attr('data-text') || $(cells[3]).text().trim();

        if (firstName && lastName) {
          allJudges.push({ firstName, lastName, institution });
        }
      });

      console.log(`[handleReportCoaches] Found ${allJudges.length} total judges on page`);

      if (allJudges.length === 0) {
        await message.reply(`⚠️ No judges found on that page. (Page length: ${html.length}, has judgelist table: ${html.includes('judgelist')})`);
        return;
      }

      // Filter to judges from our tracked schools
      const schoolNames = this.store.getSchoolNames().map(s => s.toLowerCase());
      const ourCoaches = allJudges.filter(j =>
        schoolNames.some(s => j.institution.toLowerCase().includes(s))
      );

      if (ourCoaches.length === 0) {
        const schools = this.store.getSchoolNames().join(', ');
        await message.reply(
          `⚠️ No judges found from tracked schools (${schools}).\n` +
          `Use \`@Clerk Kent set schools School1, School2\` to update.`
        );
        return;
      }

      // Store coaches with channel assignment
      const coachData = {
        channelId: message.channel.id,
        coaches: ourCoaches.map(c => ({
          name: `${c.firstName} ${c.lastName}`,
          institution: c.institution,
        })),
      };
      this.store.setCoaches(coachData);

      const coachList = coachData.coaches
        .map(c => `• **${c.name}** (${c.institution})`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setTitle('🧑‍🏫 Coach Reports Activated')
        .setColor(0x9b59b6)
        .setDescription(
          `Found **${coachData.coaches.length}** coach(es) from your schools:\n\n` +
          `${coachList}\n\n` +
          `Reports will be sent to <#${message.channel.id}> when a coach's judging assignment email arrives.\n` +
          `Use \`@Clerk Kent stop coaches\` to stop.`
        )
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('[handleReportCoaches] Error:', err);
      await message.reply(`⚠️ Failed to scrape judges page: ${err.message}`);
    }
  }

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

      // Fetch Notion notes and Tabroom paradigm in parallel
      const [judges, paradigm] = await Promise.all([
        this.notion.searchJudge(judgeName),
        this.paradigmService.fetchParadigmByName(judgeName).catch(err => {
          console.warn(`[JudgeLookup] Paradigm fetch failed for "${judgeName}":`, err.message);
          return null;
        }),
      ]);

      // Summarize paradigm if available
      let paradigmSummary = null;
      let paradigmUrl = null;
      if (paradigm) {
        paradigmUrl = paradigm.paradigmUrl || null;
        if (paradigm.philosophy) {
          paradigmSummary = await this.llmService.summarizeParadigm(paradigm.philosophy);
        }
      }

      if (judges.length === 0 && !paradigmSummary) {
        await message.reply(
          `🔍 No judges found matching **"${judgeName}"**. Try a different spelling or partial name.`
        );
        return;
      }

      const embeds = judges.map(judge => this.buildJudgeEmbed(judge, { paradigmSummary, paradigmUrl }));

      // If no Notion results but we have a paradigm, build a standalone embed
      if (judges.length === 0 && paradigmSummary) {
        embeds.push(this.buildJudgeEmbed({ name: judgeName, comments: [] }, { paradigmSummary, paradigmUrl }));
      }

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
  buildJudgeEmbed(judge, paradigmData = {}) {
    const { paradigmSummary, paradigmUrl } = paradigmData;

    const embed = new EmbedBuilder()
      .setTitle(`⚖️ ${judge.name}`)
      .setColor(0x2F80ED)
      .setTimestamp();

    // Email
    if (judge.email) {
      embed.addFields({ name: '📧 Email', value: judge.email, inline: true });
    }

    // Tabroom link
    if (judge.tabroom) {
      embed.addFields({
        name: '🔗 Tabroom',
        value: `[View Profile](${judge.tabroom})`,
        inline: false,
      });
    }

    // AI Paradigm Summary
    if (paradigmSummary) {
      const truncatedSummary = paradigmSummary.length > 1000
        ? paradigmSummary.slice(0, 997) + '...'
        : paradigmSummary;
      embed.addFields({
        name: '🧠 Paradigm Summary',
        value: truncatedSummary,
        inline: false,
      });
    }

    if (paradigmUrl) {
      embed.addFields({
        name: '📄 Paradigm Link',
        value: `[View Paradigm](${paradigmUrl})`,
        inline: true,
      });
    }

    // Comments / Notes
    if (judge.comments && judge.comments.length > 0) {
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
  /**
   * Handle: @Clerk Kent poll test / health / alive
   * Runs a live diagnostic: checks Discord, email monitor, Tabroom connectivity,
   * and Notion cache, then replies with a status embed.
   */
  async handlePollTest(message) {
    await message.channel.sendTyping();
    const start = Date.now();
    const checks = [];

    // 1. Discord — if we got here, it's working
    checks.push({ name: '🟢 Discord', value: 'Connected', ok: true });

    // 2. Email monitor
    const session = this.store.getActiveSession();
    if (this.emailMonitor) {
      const connected = this.emailMonitor._imap && this.emailMonitor._inboxOpen;
      const lastPoll = this.emailMonitor._lastSuccessfulPoll;
      const ago = lastPoll ? `${Math.round((Date.now() - lastPoll) / 1000)}s ago` : 'never';
      checks.push({
        name: connected ? '🟢 Email Monitor' : '🟡 Email Monitor',
        value: connected ? `INBOX open · last poll ${ago}` : `Reconnecting · last poll ${ago}`,
        ok: connected,
      });
    } else if (session && session.emailMonitorActive) {
      checks.push({ name: '🔴 Email Monitor', value: 'Session active but monitor not running', ok: false });
    } else {
      checks.push({ name: '⚪ Email Monitor', value: 'Not active (no pairings session)', ok: true });
    }

    // 3. Tabroom connectivity — try fetching the postings index for a tracked tournament
    const tournaments = this.store.getAllTournaments();
    const tournIds = Object.keys(this.store.tournaments);
    const testTournId = session?.tournId || (tournIds.length > 0 ? tournIds[0] : null);
    if (testTournId) {
      try {
        const rounds = await TabroomScraper.getRounds(testTournId);
        checks.push({
          name: '🟢 Tabroom',
          value: `Reachable · ${rounds.length} round(s) found for tournament ${testTournId}`,
          ok: true,
        });
      } catch (err) {
        checks.push({ name: '🔴 Tabroom', value: `Unreachable: ${err.message}`, ok: false });
      }
    } else {
      checks.push({ name: '⚪ Tabroom', value: 'No tournament to test (none tracked)', ok: true });
    }

    // 4. Notion cache
    try {
      await this.notion.refreshCache();
      checks.push({
        name: '🟢 Notion',
        value: `${this.notion.judgeCache.length} judges cached`,
        ok: true,
      });
    } catch (err) {
      checks.push({ name: '🔴 Notion', value: `Error: ${err.message}`, ok: false });
    }

    // 5. Uptime
    const uptimeSec = process.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = days > 0 ? `${days}d ${hours}h ${mins}m` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    const allOk = checks.every(c => c.ok);
    const elapsed = Date.now() - start;

    const embed = new EmbedBuilder()
      .setTitle(allOk ? '💓 I\'m alive! All systems operational.' : '⚠️ I\'m alive, but some systems need attention.')
      .setColor(allOk ? 0x2ecc71 : 0xf39c12)
      .setDescription(`Uptime: **${uptimeStr}** · Diagnostic took ${elapsed}ms`)
      .setTimestamp();

    for (const check of checks) {
      embed.addFields({ name: check.name, value: check.value, inline: true });
    }

    await message.reply({ embeds: [embed] });
  }

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
        '**Pre-caching (prime data before/during a tournament):**\n' +
        '`@Clerk Kent cache opponents <entries_url>` — Pre-fetch caselist data for all entries\n' +
        '`@Clerk Kent cache paradigms <judges_url>` — Pre-fetch judge paradigms\n\n' +
        '**Settings:**\n' +
        '`@Clerk Kent set schools School1, School2` — Set tracked school names\n' +
        '`@Clerk Kent set season 26` — Roll all caselist slugs to the 20XX season\n' +
        '`@Clerk Kent set caselist ndtceda26` — Override the caselist slug directly\n' +
        '`@Clerk Kent our aff is [name]` — Set your aff for neg scouting\n\n' +
        '**Tournament Tracking:**\n' +
        '`@Clerk Kent track <tabroom_url> <team_code>` — Register a team to track\n' +
        '`@Clerk Kent report <code>` — Get latest pairings & judge info for a team\n' +
        '`@Clerk Kent report coaches <judges_url>` — Track coaches from your schools\n' +
        '`@Clerk Kent set coaches channel <name>` — Send coach reports to a channel\n' +
        '`@Clerk Kent set hq channel <name>` — Mirror all reports to a channel\n' +
        '`@Clerk Kent stop coaches` — Stop coach reports\n' +
        '`@Clerk Kent untrack <team_code>` — Stop tracking a team\n' +
        '`@Clerk Kent tournaments` — Show tracked tournaments\n' +
        '`@Clerk Kent poll test` — Run a health check on all systems\n\n' +
        '**Examples:**\n' +
        '`@Clerk Kent Smith` — Judge lookup\n' +
        '`@Clerk Kent set schools Dartmouth`\n' +
        '`@Clerk Kent report coaches https://www.tabroom.com/index/tourn/judges.mhtml?category_id=96220&tourn_id=36156`\n' +
        '`@Clerk Kent initiate pairings reports https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=36452&event_id=372080`'
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
 