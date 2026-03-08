const { EmbedBuilder } = require('discord.js');

class ReportBuilder {
  buildPairingEmbed(pairingData) {
    const {
      roundTitle = 'Unknown Round',
      startTime,
      room,
      side,
      aff = {},
      neg = {},
      teamCode,
    } = pairingData || {};

    const formatTeam = (code, isSide) => {
      if (!code) return 'N/A';
      return code === teamCode ? `**🟢 ${code}**` : code;
    };

    return new EmbedBuilder()
      .setTitle(`📋 ${roundTitle}`)
      .setColor(0xf5a623)
      .addFields(
        { name: 'Aff', value: formatTeam(aff.teamCode, 'aff'), inline: true },
        { name: 'Neg', value: formatTeam(neg.teamCode, 'neg'), inline: true },
        { name: 'Room', value: room || 'N/A', inline: true },
        { name: 'Start Time', value: startTime || 'N/A', inline: true },
        { name: 'Our Side', value: side || 'N/A', inline: false },
      );
  }

  buildOpponentEmbed(opponentData) {
    const {
      schoolName = 'Unknown',
      teamCode = 'N/A',
      caselistUrl,
      side,
      argumentSummary,
      docInfo,
    } = opponentData || {};

    const fields = [
      { name: 'Side', value: side || 'N/A', inline: true },
      {
        name: 'Caselist',
        value: caselistUrl ? `[OpenCaselist](${caselistUrl})` : 'Not found',
        inline: true,
      },
      {
        name: 'Argument Summary',
        value: argumentSummary || 'Not found',
        inline: false,
      },
    ];

    if (docInfo) {
      if (side === 'Aff') {
        // Opponent is AFF — show their most recent aff doc
        const docLine = docInfo.downloadUrl
          ? `[Download](${docInfo.downloadUrl}) — ${docInfo.tournament} R${docInfo.round}`
          : `${docInfo.tournament} R${docInfo.round} (no open source)`;
        fields.push({
          name: '📄 Most Recent Aff Open Source',
          value: docLine,
          inline: false,
        });
      } else if (side === 'Neg') {
        // Opponent is NEG — show their most recent neg vs our aff
        let docLine = `${docInfo.tournament} R${docInfo.round}`;
        if (docInfo.strategy) docLine += ` — 2NR: ${docInfo.strategy}`;
        if (docInfo.downloadUrl) docLine += `\n[Download](${docInfo.downloadUrl})`;
        else docLine += '\n(no open source)';
        fields.push({
          name: '📄 Most Recent Neg vs Our Aff',
          value: docLine,
          inline: false,
        });
      }
    }

    return new EmbedBuilder()
      .setTitle(`🔍 Opponent: ${schoolName} ${teamCode}`)
      .setColor(0xe74c3c)
      .addFields(fields);
  }

  buildJudgeEmbed(judgeData) {
    const {
      name = 'Unknown Judge',
      paradigmSummary,
      paradigmUrl,
      school,
      notionNotes,
      notionUrl,
      tabroomUrl,
    } = judgeData || {};

    const truncatedParadigm =
      paradigmSummary && paradigmSummary.length > 1000
        ? paradigmSummary.slice(0, 997) + '...'
        : paradigmSummary;

    const fields = [
      { name: 'School', value: school || 'N/A', inline: true },
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

    fields.push({
      name: 'Tabroom Link',
      value: tabroomUrl ? `[View on Tabroom](${tabroomUrl})` : 'N/A',
      inline: true,
    });

    return new EmbedBuilder()
      .setTitle(`⚖️ ${name}`)
      .setColor(0x2f80ed)
      .addFields(fields);
  }

  buildFullReport(pairing, opponent, judges) {
    const embeds = [];

    if (pairing) {
      embeds.push(this.buildPairingEmbed(pairing));
    }

    if (opponent) {
      embeds.push(this.buildOpponentEmbed(opponent));
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
