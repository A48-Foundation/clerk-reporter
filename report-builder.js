const { EmbedBuilder } = require('discord.js');

class ReportBuilder {
  buildPairingEmbed(pairingData, opponentData) {
    const {
      roundTitle = 'Unknown Round',
      startTime,
      room,
      side,
      aff = {},
      neg = {},
      teamCode,
    } = pairingData || {};

    const {
      schoolName,
      teamCode: oppCode,
      caselistUrl,
      argumentSummary,
    } = opponentData || {};

    const formatTeam = (code) => {
      if (!code) return 'N/A';
      return code === teamCode ? `**${code}**` : code;
    };

    const opponentName = schoolName && oppCode ? `${schoolName} ${oppCode}` : (aff.teamCode === teamCode ? neg.teamCode : aff.teamCode) || 'TBD';
    const opponentSide = side === 'AFF' || side === 'Aff' ? 'Neg' : side === 'NEG' || side === 'Neg' ? 'Aff' : 'FLIP';
    const caselistLink = caselistUrl ? ` — [Wiki](${caselistUrl})` : '';

    const fields = [
      { name: 'Matchup', value: `${formatTeam(aff.teamCode)} (Aff) vs ${formatTeam(neg.teamCode)} (Neg)`, inline: false },
      { name: 'Room', value: room || 'N/A', inline: true },
      { name: 'Start', value: startTime || 'N/A', inline: true },
    ];

    if (argumentSummary) {
      fields.push({
        name: `🐟 ${opponentName} (${opponentSide})${caselistLink}`,
        value: argumentSummary,
        inline: false,
      });
    }

    return new EmbedBuilder()
      .setTitle(`📋 ${roundTitle}`)
      .setColor(0xf5a623)
      .addFields(fields);
  }

  buildJudgeEmbed(judgeData) {
    const {
      name = 'Unknown Judge',
      paradigmSummary,
      paradigmUrl,
      notionNotes,
      notionUrl,
    } = judgeData || {};

    const truncatedParadigm =
      paradigmSummary && paradigmSummary.length > 1000
        ? paradigmSummary.slice(0, 997) + '...'
        : paradigmSummary;

    const fields = [
      {
        name: 'Paradigm Summary',
        value: truncatedParadigm || 'Not found',
        inline: false,
      },
      {
        name: 'Paradigm Link',
        value: paradigmUrl ? `[View Paradigm](${paradigmUrl})` : 'N/A',
        inline: true,
      },
    ];

    if (notionNotes || notionUrl) {
      fields.push({
        name: 'Notion Notes',
        value: notionUrl
          ? `[View Notes](${notionUrl})\n${notionNotes || ''}`
          : notionNotes || 'N/A',
        inline: false,
      });
    }

    return new EmbedBuilder()
      .setTitle(`⚖️ ${name}`)
      .setColor(0x2f80ed)
      .addFields(fields);
  }

  buildFullReport(pairing, opponent, judges) {
    const embeds = [];

    if (pairing) {
      embeds.push(this.buildPairingEmbed(pairing, opponent));
    }

    if (Array.isArray(judges)) {
      for (const judge of judges) {
        if (embeds.length >= 10) break;
        embeds.push(this.buildJudgeEmbed(judge));
      }
    }

    return embeds;
  }
}

module.exports = ReportBuilder;
