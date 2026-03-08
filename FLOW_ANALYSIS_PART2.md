═══════════════════════════════════════════════════════════════════════════════
6. REPORT BUILDER: report-builder.js (COMPLETE FILE)
═══════════════════════════════════════════════════════════════════════════════

FILE: report-builder.js (lines 1-117)

COMPLETE CODE:

     1  const { EmbedBuilder } = require('discord.js');
     2  
     3  class ReportBuilder {
     4    buildPairingEmbed(pairingData, opponentData) {
     5      const {
     6        roundTitle = 'Unknown Round',
     7        startTime,
     8        room,
     9        side,
    10        aff = {},
    11        neg = {},
    12        teamCode,
    13      } = pairingData || {};
    14  
    15      const {
    16        schoolName,
    17        teamCode: oppCode,
    18        caselistUrl,
    19        argumentSummary,
    20      } = opponentData || {};
    21  
    22      const formatTeam = (code) => {
    23        if (!code) return 'N/A';
    24        return code === teamCode ? \**\**\ : code;
    25      };
    26  
    27      // Shorten round title: "Round 6 of Policy - Open" → "R6"
    28      let shortTitle = roundTitle;
    29      const roundMatch = roundTitle.match(/round\s+(\d+)/i);
    30      if (roundMatch) shortTitle = \R\\;
    31  
    32      const opponentName = schoolName && oppCode 
    33        ? \\ \\ 
    33      : (aff.teamCode === teamCode ? neg.teamCode : aff.teamCode) 
    33      || 'TBD';
    34      const opponentSide = side === 'AFF' || side === 'Aff' ? 'Neg' 
    34        : side === 'NEG' || side === 'Neg' ? 'Aff' 
    34        : 'FLIP';
    35      // Our side label
    36      const ourSide = side || 'FLIP';
    37  
    38      const fields = [
    39        { name: 'Room', value: room || 'N/A', inline: true },
    40        { name: 'Start', value: startTime || 'N/A', inline: true },
    41      ];
    42  
    43      if (argumentSummary) {
    44        const oppDisplay = caselistUrl ? \[\](\)\ : opponentName;
    45        fields.push({
    46          name: \🐟 \ v. \ (\)\,
    47          value: \\\n\\,
    48          inline: false,
    49        });
    50      }
    51  
    52      return new EmbedBuilder()
    53        .setTitle(\📋 \\)
    54        .setColor(0xf5a623)
    55        .addFields(fields);
    56    }
    57  
    58    buildJudgeEmbed(judgeData) {
    59      const {
    60        name = 'Unknown Judge',
    61        paradigmSummary,
    62        paradigmUrl,
    63        notionNotes,
    64        notionUrl,
    65      } = judgeData || {};
    66  
    67      const truncatedParadigm =
    68        paradigmSummary && paradigmSummary.length > 1000
    69          ? paradigmSummary.slice(0, 997) + '...'
    70          : paradigmSummary;
    71  
    72      const fields = [
    73        {
    74          name: 'Paradigm Summary',
    75          value: truncatedParadigm || 'Not found',
    76          inline: false,
    76        },
    77        {
    78          name: 'Paradigm Link',
    79          value: paradigmUrl ? \[View Paradigm](\)\ : 'N/A',
    80          inline: true,
    81        },
    82      ];
    83  
    84      if (notionNotes) {
    85        fields.push({
    86          name: '**Comments**',
    87          value: notionNotes,
    88          inline: false,
    88        });
    89      }
    90  
    91      return new EmbedBuilder()
    92        .setTitle(\⚖️ \\)
    93        .setColor(0x2f80ed)
    93        .addFields(fields);
    95    }
    96  
    97    buildFullReport(pairing, opponent, judges) {
    98      const embeds = [];
    99  
   100      if (pairing) {
   101        embeds.push(this.buildPairingEmbed(pairing, opponent));
   102      }
   103  
   104      if (Array.isArray(judges)) {
   105        for (const judge of judges) {
   105          if (embeds.length >= 10) break;  // Discord embed limit
   107          embeds.push(this.buildJudgeEmbed(judge));
   108        }
   109      }
   110  
   111      return embeds;
   112    }
   112  }
   113  
   114  module.exports = ReportBuilder;
   115  

METHODS SUMMARY:

buildPairingEmbed(pairingData, opponentData)
  ─────────────────────────────────────────
  
  INPUT pairingData:
    roundTitle: "Round 6 of Policy - Open"  (gets shortened to "R6")
    startTime: "10:30 AM"
    room: "104"
    side: "AFF" (our side)
    aff: { teamCode: "Interlake CG" }
    neg: { teamCode: "Opponent AB" }
    teamCode: "Interlake CG" (our team)
  
  INPUT opponentData:
    schoolName: "Opponent School"
    teamCode: "AB"  (opponent's suffix)
    caselistUrl: "https://caselist.com/..."
    argumentSummary: "Their case strategy: focuses on..."
  
  OUTPUT: Single Discord EmbedBuilder
    Title: "📋 R6" (shortened round number)
    Color: Orange (0xf5a623)
    Fields:
      - Room: "104"
      - Start: "10:30 AM"
      - "🐟 AFF v. Opponent School AB (Neg)": [Caselist link] + argument summary

buildJudgeEmbed(judgeData)
  ────────────────────────
  
  INPUT judgeData:
    name: "Judge Name"
    paradigmSummary: "LLM-summarized paradigm (max 1000 chars, truncate to 997)"
    paradigmUrl: "https://paradigm.com/..."
    notionNotes: "Team's notes about judge (max 500 chars as set in _processSinglePairing)"
    notionUrl: "https://notion.so/..."
  
  OUTPUT: Single Discord EmbedBuilder
    Title: "⚖️ Judge Name"
    Color: Blue (0x2f80ed)
    Fields:
      - Paradigm Summary: [Truncated to 1000 chars]
      - Paradigm Link: [Link to paradigm]
      - Comments: [Notion notes if present]
    URL: Notion link if available

buildFullReport(pairing, opponent, judges)
  ────────────────────────────────────────
  
  INPUT:
    pairing: Single pairingData object (or null)
    opponent: Single opponentData object (or null)
    judges: Array of judgeData objects
  
  PROCESS:
    1. Initialize embeds array
    2. IF pairing exists: add pairing embed (always first)
    3. FOR each judge in judges array:
         IF embeds.length >= 10: stop (Discord API max 10 embeds per message)
         Add judge embed
    4. Return embeds array
  
  OUTPUT: Array of Discord EmbedBuilder objects
    - embeds[0]: Pairing embed
    - embeds[1..n]: Judge embeds (max 10 total)
  
  EXAMPLE:
    buildFullReport() called with:
      pairing: { roundTitle: "Round 3", side: "AFF", room: "104", ... }
      opponent: { schoolName: "Opponent", argumentSummary: "...", ... }
      judges: [
        { name: "Judge1", paradigmSummary: "...", notionNotes: "...", ... },
        { name: "Judge2", paradigmSummary: "...", notionNotes: "...", ... },
        { name: "Judge3", paradigmSummary: "...", notionNotes: "...", ... }
      ]
    
    Returns array:
      [
        EmbedBuilder (pairing),
        EmbedBuilder (Judge1),
        EmbedBuilder (Judge2),
        EmbedBuilder (Judge3)
      ]
    
    These are sent to Discord as: channel.send({ embeds: [...] })

═══════════════════════════════════════════════════════════════════════════════
7. TOURNAMENT STORE: tournament-store.js (FULL FILE WITH FIELDS)
═══════════════════════════════════════════════════════════════════════════════

FILE: tournament-store.js (lines 1-224)

INITIALIZATION (lines 18-42):
  constructor() {
    const data = this.load()  # Reads tournaments.json
    this.tournaments = data.tournaments
    this.activeSession = data.activeSession
    this.settings = data.settings
  }

PERSISTENT STORAGE FORMAT (tournaments.json):
  {
    "tournaments": {
      "36452": {                         # tournId as key
        "tournId": "36452",
        "teams": [
          { "code": "Interlake CG", "channelId": "123456" },
          { "code": "Interlake AC", "channelId": "789012" }
        ],
        "seenRounds": [
          "round_id_1",
          "round_id_2"
        ]
      },
      "36453": { ... }
    },
    "activeSession": {
      "tournId": "36452",
      "tournamentUrl": "https://tabroom.com/...",
      "channelMappings": {
        "Interlake CG": "123456",
        "Interlake AC": "789012"
      },
      "allEntries": [
        { "code": "Interlake CG", "entry": "Chen & Griffiths" },
        { "code": "Opponent AB", "entry": "Smith & Jones" },
        ...
      ],
      "emailMonitorActive": true,
      "processedEmailUids": [
        "email_uid_1",
        "email_uid_2"
      ],
      "startedAt": "2024-01-15T10:30:00Z"
    },
    "settings": {
      "ourAff": "PNT"                   # Stores our aff name globally
    }
  }

KEY METHODS FOR PAIRINGS FEATURE:

setActiveSession(tournId, tournamentUrl, channelMappings, allEntries)
  └─ Called when "Confirm & Start" button clicked (bot.js line 348)
  └─ Stores all data to tournaments.json

getActiveSession()
  └─ Returns active session or null
  └─ Used by handlePairingEvent to check if pairings active (bot.js line 466)

isEmailProcessed(uid)
  └─ Returns true if email UID already processed
  └─ Used for deduplication (bot.js line 473)

addProcessedEmailUid(uid)
  └─ Marks email as processed, saves to file
  └─ Called when email is received (bot.js line 477)

getChannelForTeam(teamCode)
  └─ Returns channelId for team from active session
  └─ Used to find channel for pairing (bot.js line 570)

getEntryNamesForTeam(teamCode)
  └─ Returns Tabroom entry names (e.g., "Person1 & Person2")
  └─ Used to look up opponent caselist (bot.js line 585)
  └─ Critical for caselist service to find opponent's cases

clearActiveSession()
  └─ Wipes active session when user runs "stop pairings"

═══════════════════════════════════════════════════════════════════════════════
8. CHANNEL MAPPING DATA FLOW
═══════════════════════════════════════════════════════════════════════════════

THREE REPRESENTATIONS OF CHANNEL MAPPINGS:

REPRESENTATION 1 — _pendingSession.mapping (in-memory, before confirmation)
  {
    "Interlake CG": {
      channelId: "123456",
      channelName: "cg-tournaments",
      confidence: "auto"
    }
  }
  └─ Contains full metadata (channelName, confidence)
  └─ Some teams may have channelId=null if unmatched
  └─ Used for user confirmation embed and overrides

REPRESENTATION 2 — activeSession.channelMappings (stored, simplified)
  {
    "Interlake CG": "123456",
    "Interlake AC": "789012"
  }
  └─ Simplified: team code → channelId only
  └─ Persisted to tournaments.json
  └─ Used at runtime to look up channels for pairings
  └─ Only includes teams with valid channelId (no null entries)

CONVERSION (bot.js lines 340-345):
  Build channelMappings from _pendingSession.mapping:
    for [team, info] in session.mapping:
      if info.channelId:
        channelMappings[team] = info.channelId

LOOKUP (bot.js line 570):
  channelId = session.channelMappings[ourTeamCode]
  └─ Returns channelId (string) or undefined

═══════════════════════════════════════════════════════════════════════════════
9. DATA FLOW FOR OPPONENT LOOKUP
═══════════════════════════════════════════════════════════════════════════════

When processing a pairing for "Interlake CG" vs "Opponent School AB":

INPUT FROM EMAIL:
  opponentCode: "Opponent School AB"  (or just "AB" depending on email format)

STEP 1 → Store lookup (bot.js line 585)
  entryNames = store.getEntryNamesForTeam("Opponent School AB")
  
  How store finds this:
    activeSession.allEntries is array of:
      { code: "Opponent School AB", entry: "Person1 & Person2" }
    
    getEntryNamesForTeam("Opponent School AB"):
      Find entry where code.toLowerCase() === "opponent school ab".toLowerCase()
      Return entry.entry  # "Person1 & Person2"

STEP 2 → Caselist lookup (bot.js line 590-592)
  caselistResult = caselistService.lookupOpponent(
    "Opponent School AB",
    "N"           # opponentSide (we're AFF, they're NEG)
    "Person1 & Person2"  # Entry names
  )
  
  How caselist service works:
    1. Search for team by code ("AB") and entry names ("Person1 & Person2")
    2. Query caselist website
    3. Return rounds (case files) if found

STEP 3 → Argument summarization (bot.js line 596)
  argumentSummary = llmService.summarizeWithFallback(
    caselistResult.rounds,
    "N",  # Opponent side
    downloadUrlFn,
    { ourAff: "PNT" }  # Our aff name (for context when analyzing NEG)
  )
  
  How LLM service works:
    1. Downloads each case file
    2. Uses LLM to read and summarize
    3. For NEG opponent, includes analysis vs our aff strategy

STEP 4 → Report includes summary (report-builder.js lines 43-50)
  IF argumentSummary:
    Add field to pairing embed:
      name: "🐟 AFF v. Opponent School AB (Neg)"
      value: "[Caselist link]\n" + argumentSummary

═══════════════════════════════════════════════════════════════════════════════
10. KEY INSIGHTS FOR ALL-TEAM REPORT FEATURE
═══════════════════════════════════════════════════════════════════════════════

WHAT WOULD AN "ALL-TEAM REPORT" NEED:

1. AGGREGATE DATA
   └─ Collect pairings for ALL our teams in a single email/event
   └─ Not just one team at a time

2. TRIGGER POINT
   Current: Each email triggers report for one team
   New: Could be:
     a) A special command: "@Clerk Kent all-team report" (query latest round)
     b) A special email format: "[TAB] All-Team Round Assignments"
     c) Periodic: "@Clerk Kent all-team report every 30 minutes"

3. DATA COLLECTION
   For each of our teams:
     - Get pairings (opponent, room, judges, side)
     - Look up opponent caselist → argumentSummary
     - Look up judges → paradigm + Notion notes
   Compile all into single embed/message

4. STORAGE NEEDED
   Might need to track:
     - Last time all-team report was sent (avoid duplicates)
     - Which round is the "current" one (for @all-team report command)
     - Whether to auto-send or require command

5. EXISTING CODE REUSE
   - _processSinglePairing() already does 80% of work per team
   - Could loop through all teams and call helper function
   - reportBuilder already creates embeds efficiently
   - Caselist/Notion/Paradigm services already handle lookups

6. CHANNEL FOR SENDING
   Options:
     a) Single consolidated channel (new #all-team-reports channel)
     b) Same channel where user initiated pairings
     c) Separate channel per team, but triggered together
     d) Let user specify: "@Clerk Kent all-team report #consolidated-channel"

7. FORMAT IDEAS
   a) One big embed per team (current format)
   b) Table format: rows for each team, columns for opponent/judges/side
   c) Sections: "PAIRINGS", "JUDGES", "CASELIST SUMMARIES"
   d) Multiple messages: one per team, sent rapidly in sequence

═══════════════════════════════════════════════════════════════════════════════
END OF ANALYSIS
═══════════════════════════════════════════════════════════════════════════════
