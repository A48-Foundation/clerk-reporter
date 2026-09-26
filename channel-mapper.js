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
   * Build the ordered list of channel-suffix candidates for a team code.
   *
   * Tabroom sometimes gives a short code ("Interlake WY") and sometimes the
   * full debater names ("Interlake Julia Ye & Aaron Wang"). For the latter we
   * derive the two debaters' last-name initials in both orders, since Tabroom's
   * partner ordering isn't guaranteed to match the channel name (WY vs YW).
   * Returns uppercase candidates with duplicates removed, order preserved.
   */
  candidateSuffixes(teamCode) {
    if (!teamCode || typeof teamCode !== 'string') return [];
    const candidates = [];
    const parts = teamCode.trim().split(/\s+/);

    // 1. Short-code style: the last space-separated token (e.g. "WY").
    if (parts.length >= 2) candidates.push(parts[parts.length - 1]);

    // 2. Partnership full names: "<School> First Last & First Last".
    //    Use the last word on each side of the "&" as each debater's last name.
    if (teamCode.includes('&')) {
      const lastNames = teamCode
        .split('&')
        .map((side) => side.trim().split(/\s+/).pop())
        .filter(Boolean);
      if (lastNames.length === 2) {
        const [a, b] = lastNames.map((n) => n[0].toUpperCase());
        candidates.push(a + b, b + a);
      }
    }

    return [...new Set(candidates.map((c) => c.toUpperCase()).filter(Boolean))];
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
      const candidates = this.candidateSuffixes(code);
      if (candidates.length === 0) {
        mapping[code] = { channelId: null, channelName: null, confidence: 'unmatched' };
        continue;
      }
      let channel = null;
      for (const suffix of candidates) {
        channel = await this.findChannel(suffix);
        if (channel) break;
      }
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
          const suffixes = this.candidateSuffixes(team);
          if (suffixes.some((s) => s.toLowerCase() === overrideSuffix.toLowerCase())) {
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
