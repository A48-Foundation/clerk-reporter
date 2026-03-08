const { EmbedBuilder } = require('discord.js');

class ChannelMapper {
  constructor(discordClient) {
    this.client = discordClient;
  }

  /**
   * Extract the letter suffix (last space-separated word) from a team code.
   * e.g. "Interlake CG" → "CG", "Cuttlefish AB" → "AB"
   */
  extractTeamSuffix(teamCode) {
    if (!teamCode || typeof teamCode !== 'string') return null;
    const parts = teamCode.trim().split(/\s+/);
    if (parts.length < 2) return null;
    return parts[parts.length - 1];
  }

  /**
   * Search all guilds the bot is in for a channel named `{suffix}-tournaments`
   * (case-insensitive).
   */
  async findChannel(suffix) {
    if (!suffix) return null;
    const target = `${suffix.toLowerCase()}-tournaments`;
    for (const [, guild] of this.client.guilds.cache) {
      const channels = await guild.channels.fetch();
      const channel = channels.find(
        (c) => c && c.name && c.name.toLowerCase() === target
      );
      if (channel) return channel;
    }
    return null;
  }

  /**
   * Auto-map an array of team codes to Discord channels.
   * Returns { "Interlake CG": { channelId, channelName, confidence }, ... }
   */
  async autoMap(teamCodes) {
    const mapping = {};
    if (!Array.isArray(teamCodes)) return mapping;

    for (const code of teamCodes) {
      const suffix = this.extractTeamSuffix(code);
      if (!suffix) {
        mapping[code] = { channelId: null, channelName: null, confidence: 'unmatched' };
        continue;
      }
      const channel = await this.findChannel(suffix);
      if (channel) {
        mapping[code] = {
          channelId: channel.id,
          channelName: channel.name,
          confidence: 'auto',
        };
      } else {
        mapping[code] = { channelId: null, channelName: null, confidence: 'unmatched' };
      }
    }
    return mapping;
  }

  /**
   * Send an embed showing the proposed mapping and wait for user confirmation
   * or overrides. Returns the final mapping.
   */
  async confirmMapping(channel, mappings) {
    const lines = Object.entries(mappings).map(([team, info]) => {
      if (info.confidence === 'auto') {
        return `✅ **${team}** → #${info.channelName}`;
      }
      return `❌ **${team}** → _unmatched_`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Channel Mapping Confirmation')
      .setDescription(
        lines.join('\n') +
          '\n\n' +
          'React ✅ to confirm, or type overrides like `OC=#some-channel`.\n' +
          'You have 60 seconds to respond.'
      )
      .setColor(0x5865f2);

    const message = await channel.send({ embeds: [embed] });
    await message.react('✅');

    const confirmed = { ...mappings };

    // Race: wait for either a ✅ reaction or a text override message
    const reactionFilter = (reaction, user) =>
      reaction.emoji.name === '✅' && !user.bot;
    const messageFilter = (msg) => !msg.author.bot;

    const reactionPromise = message
      .awaitReactions({ filter: reactionFilter, max: 1, time: 60_000 })
      .then((collected) => ({ type: 'reaction', collected }));

    const messagePromise = channel
      .awaitMessages({ filter: messageFilter, max: 1, time: 60_000 })
      .then((collected) => ({ type: 'message', collected }));

    const result = await Promise.race([reactionPromise, messagePromise]);

    if (result.type === 'message' && result.collected.size > 0) {
      const response = result.collected.first().content;
      // Parse overrides in the form SUFFIX=#channel-name (possibly multiple)
      const overridePattern = /(\w+)=(?:#?)([\w-]+)/g;
      let match;
      while ((match = overridePattern.exec(response)) !== null) {
        const [, overrideSuffix, channelRef] = match;
        // Find the team code whose suffix matches the override key
        for (const team of Object.keys(confirmed)) {
          const suffix = this.extractTeamSuffix(team);
          if (suffix && suffix.toLowerCase() === overrideSuffix.toLowerCase()) {
            // Look up the referenced channel by name across all guilds
            for (const [, guild] of this.client.guilds.cache) {
              const found = guild.channels.cache.find(
                (c) => c.name.toLowerCase() === channelRef.toLowerCase()
              );
              if (found) {
                confirmed[team] = {
                  channelId: found.id,
                  channelName: found.name,
                  confidence: 'manual',
                };
                break;
              }
            }
          }
        }
      }
    }
    // If reaction or timeout, return mapping as-is (already confirmed or best-effort)

    return confirmed;
  }
}

module.exports = ChannelMapper;
