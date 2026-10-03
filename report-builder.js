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
      reportTeamCode,
    } = pairingData || {};

    const {
      schoolName,
      teamCode: oppCode,
      caselistUrl,
      argumentSummary,
      // FLIP fields
      affCaselistUrl,
      negCaselistUrl,
      affArgumentSummary,
      negArgumentSummary,
      dataSource,
    } = opponentData || {};

    const formatTeam = (code) => {
      if (!code) return 'N/A';
      return code === teamCode ? `**${code}**` : code;
    };

    // Shorten round title: "Round 6 of Policy - Open" → "R6"
    let shortTitle = roundTitle;
    const roundMatch = roundTitle.match(/round\s+(\d+)/i);
    if (roundMatch) shortTitle = `R${roundMatch[1]}`;

    const opponentName = schoolName && oppCode ? `${schoolName} ${oppCode}` : (aff.teamCode === teamCode ? neg.teamCode : aff.teamCode) || 'TBD';
    const opponentSide = side === 'AFF' || side === 'Aff' ? 'Neg' : side === 'NEG' || side === 'Neg' ? 'Aff' : 'FLIP';
    const normalizedSide = String(side || 'FLIP').toUpperCase();
    const ourSide = normalizedSide === 'AFF' ? 'Aff' : normalizedSide === 'NEG' ? 'Neg' : 'FLIP';
    const title = pairingData
      ? `${shortTitle}: ${ourSide} v. ${opponentName} (${opponentSide})`
      : shortTitle;
    const titleUrl = caselistUrl || affCaselistUrl || negCaselistUrl;

    const fields = [
      { name: 'Room', value: room || 'N/A', inline: true },
      { name: 'Start', value: startTime || 'N/A', inline: true },
    ];

    if (opponentData && opponentData.side === 'FLIP') {
      fields.push({
        name: 'Their Aff Arguments',
        value: affArgumentSummary || '_No data_',
        inline: false,
      });
      fields.push({
        name: 'Their Neg Arguments',
        value: negArgumentSummary || '_No data_',
        inline: false,
      });
    } else if (argumentSummary) {
      fields.push({
        name: 'Opponent Arguments',
        value: argumentSummary,
        inline: false,
      });
    }
    if (opponentData && dataSource) {
      fields.push({
        name: 'Opponent Data Source',
        value: dataSource,
        inline: true,
      });
    }
    if (reportTeamCode || teamCode) {
      fields.push({
        name: 'Team',
        value: reportTeamCode || teamCode,
        inline: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xf5a623)
      .addFields(fields);
    if (titleUrl) embed.setURL(titleUrl);
    return embed;
  }

  buildJudgeEmbed(judgeData) {
    const {
      name = 'Unknown Judge',
      paradigmUrl,
      notionNotes,
      paradigmSource,
    } = judgeData || {};

    const fields = [
      {
        name: 'Paradigm Link',
        value: paradigmUrl ? `[View Paradigm](${paradigmUrl})` : 'N/A',
        inline: true,
      },
    ];

    if (notionNotes) {
      fields.push({
        name: '**Comments**',
        value: notionNotes,
        inline: false,
      });
    }
    if (paradigmSource) {
      fields.push({
        name: 'Paradigm Source',
        value: paradigmSource,
        inline: true,
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
