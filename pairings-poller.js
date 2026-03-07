const TabroomScraper = require('./tabroom-scraper');
const TournamentStore = require('./tournament-store');
const NotionService = require('./notion-service');
const { EmbedBuilder } = require('discord.js');

const POLL_INTERVAL_MS = 2 * 60 * 1000; // Check every 2 minutes

class PairingsPoller {
  constructor(discordClient) {
    this.discord = discordClient;
    this.store = new TournamentStore();
    this.notion = new NotionService();
    this.interval = null;
  }

  /**
   * Start polling for new pairings.
   */
  start() {
    console.log(`🔄 Pairings poller started (every ${POLL_INTERVAL_MS / 1000}s)`);
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    // Also run once immediately after a short delay (let cache load)
    setTimeout(() => this.poll(), 5000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Poll all tracked tournaments for new rounds.
   */
  async poll() {
    const tournaments = this.store.getAllTournaments();
    if (tournaments.length === 0) return;

    for (const tourn of tournaments) {
      try {
        await this.checkTournament(tourn);
      } catch (err) {
        console.error(`Error polling tournament ${tourn.tournId}:`, err.message);
      }
    }
  }

  /**
   * Check a single tournament for new rounds.
   */
  async checkTournament(tourn) {
    // Get all available rounds
    const rounds = await TabroomScraper.getRounds(tourn.tournId);

    for (const round of rounds) {
      // Skip rounds we've already processed
      if (this.store.isRoundSeen(tourn.tournId, round.roundId)) continue;

      console.log(`📋 New round detected: ${round.label} (tournament ${tourn.tournId})`);

      // Scrape pairings for this round
      const pairings = await TabroomScraper.scrapePairings(tourn.tournId, round.roundId);

      if (pairings.length === 0) continue; // Round page exists but no pairings yet

      // Get round title
      const roundTitle = await TabroomScraper.getRoundTitle(tourn.tournId, round.roundId);

      // For each tracked team, find their pairing and send judge info
      for (const team of tourn.teams) {
        const pairing = TabroomScraper.findTeamPairing(pairings, team.code);
        if (!pairing) continue;

        await this.sendPairingInfo(team, pairing, roundTitle, tourn.tournId, round.roundId);
      }

      // Mark this round as processed
      this.store.markRoundSeen(tourn.tournId, round.roundId);
    }
  }

  /**
   * Send judge information for a pairing to the team's Discord channel.
   */
  async sendPairingInfo(team, pairing, roundTitle, tournId, roundId) {
    try {
      const channel = await this.discord.channels.fetch(team.channelId);
      if (!channel) {
        console.error(`Channel ${team.channelId} not found`);
        return;
      }

      // Build the pairing summary embed
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

      // Look up each judge in Notion and build judge embeds
      for (const judge of pairing.judges) {
        // Notion search uses the judge name (which comes as "Last, First" from Tabroom)
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
          // Judge not found in Notion — still show the name
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

      // Discord max 10 embeds per message
      await channel.send({ embeds: embeds.slice(0, 10) });
      console.log(`✅ Sent pairing info for ${team.code} in ${roundTitle}`);
    } catch (err) {
      console.error(`Failed to send pairing for ${team.code}:`, err.message);
    }
  }

  /**
   * Expose the store for use by Discord commands.
   */
  getStore() {
    return this.store;
  }
}

module.exports = PairingsPoller;
