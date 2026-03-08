═══════════════════════════════════════════════════════════════════════════════
QUICK REFERENCE: PAIRINGS PIPELINE DATA FLOW
═══════════════════════════════════════════════════════════════════════════════

USER COMMAND:
  @Clerk Kent initiate pairings reports https://tabroom.com/...

PHASE 1: SESSION SETUP (bot.js lines 143-255)
  1. Parse URL → tournId, eventId
  2. Scrape Tabroom entries → filter to our school
  3. Auto-map teams to Discord channels
  4. Store _pendingSession (in-memory)
  5. Show confirmation embed with buttons

PHASE 2: CONFIRMATION (bot.js lines 330-381)
  1. User clicks "✅ Confirm & Start"
  2. Convert _pendingSession → activeSession
  3. Save to tournaments.json
  4. Start EmailMonitor

PHASE 3: EMAIL MONITORING
  EmailMonitor watches inbox for pairings emails
  When email arrives: 
    → emit 'pairing' event
    → handlePairingEvent() called

PHASE 4: PAIRING EVENT PROCESSING (bot.js lines 459-560)
  1. Parse email (regex first, LLM fallback)
  2. Validate email not already processed
  3. Route by format (A=single, B=assignments)
  4. Filter to our school teams
  5. For each of our teams: call _processSinglePairing()

PHASE 5: SINGLE PAIRING PROCESSOR (bot.js lines 565-668)
  For each team:
    1. Find Discord channel from channelMappings
    2. Look up opponent caselist → argumentSummary
    3. Look up judges → paradigm + Notion notes
    4. Build embeds (pairing + judges)
    5. Send to Discord channel

═══════════════════════════════════════════════════════════════════════════════
KEY DATA STRUCTURES AT A GLANCE
═══════════════════════════════════════════════════════════════════════════════

_pendingSession (in-memory, transient):
  tournId, tournamentUrl, tournamentName, mapping, allEntries, channelId, userId

activeSession (persistent, tournaments.json):
  tournId, tournamentUrl, channelMappings, allEntries, emailMonitorActive,
  processedEmailUids, startedAt

channelMappings (lookup table):
  "Team Code" → "channel_id"

allEntries (lookup table):
  [{ code: "Team Code", entry: "Person1 & Person2" }, ...]

Pairing object (internal):
  ourTeamCode, opponentCode, opponentSide, side, room, judges, roundTitle,
  startTime, roundNumber, aff, neg

opponentData (built during processing):
  schoolName, teamCode, caselistUrl, side, argumentSummary

judgeEmbedData (array of judges):
  [{ name, paradigmSummary, paradigmUrl, school, notionNotes, notionUrl }, ...]

═══════════════════════════════════════════════════════════════════════════════
CRITICAL FILE LOCATIONS & LINE NUMBERS
═══════════════════════════════════════════════════════════════════════════════

bot.js:
  - handleInitiatePairings() ..................... line 143-261
  - _handleChannelOverride() ..................... line 266-324
  - handleButtonInteraction() ................... line 329-394
  - handlePairingEvent() ......................... line 459-560
  - _processSinglePairing() ...................... line 565-668
  - _restoreEmailMonitor() ....................... line 1043-1058

tournament-store.js:
  - setActiveSession() ........................... line 158-169
  - getActiveSession() ........................... line 171-173
  - getChannelForTeam() .......................... line 197-200
  - getEntryNamesForTeam() ....................... line 214-220
  - addProcessedEmailUid() ....................... line 180-186
  - isEmailProcessed() ........................... line 188-190

channel-mapper.js:
  - autoMap() .................................... line 39-61
  - extractTeamSuffix() .......................... line 12-17
  - findChannel() ................................ line 23-33

report-builder.js:
  - buildPairingEmbed() .......................... line 4-56
  - buildJudgeEmbed() ............................ line 58-95
  - buildFullReport() ............................ line 97-112

═══════════════════════════════════════════════════════════════════════════════
CHANNEL MAPPING ALGORITHM
═══════════════════════════════════════════════════════════════════════════════

INPUT: Team codes like ["Interlake CG", "Cuttlefish LZ"]

AUTO-MAP PROCESS:
  1. Extract suffix (last word): "Interlake CG" → "CG"
  2. Search all Discord guilds for channel: "cg-tournaments"
  3. If found: confidence="auto", store channelId
  4. If not found: confidence="unmatched", channelId=null

OVERRIDE FORMAT:
  User types: "CG=#helpful-channel LZ=#other-channel"
  Pattern: /(\w+)=(?:#?)([\w-]+)/g
  Sets confidence="manual" for overridden channels

CONVERSION TO ACTIVE SESSION (line 340-345):
  Only channels with channelId!=null are stored in activeSession.channelMappings
  Unmatched teams not sent reports

═══════════════════════════════════════════════════════════════════════════════
OPPONENT LOOKUP FLOW
═══════════════════════════════════════════════════════════════════════════════

Email says: "Opponent School AB"
         ↓
Look in allEntries for code="Opponent School AB"
         ↓
Get entry names: "Person1 & Person2"
         ↓
caselist.lookupOpponent(code, side, entryNames)
         ↓
Get case files (rounds)
         ↓
LLM summarizes with ourAff context
         ↓
Build argumentSummary in report embed

═══════════════════════════════════════════════════════════════════════════════
JUDGE LOOKUP FLOW (3 SOURCES)
═══════════════════════════════════════════════════════════════════════════════

Email says: "Judge Name"
         ↓
         ├─ paradigmService.fetchParadigmByName()
         │  Returns: paradigmUrl, philosophy, school
         │  LLM summarizes philosophy
         │
         ├─ notion.searchJudge()
         │  Returns: url, comments, email, tabroom
         │  Extract comments (max 500 chars)
         │
         └─ Combine into judgeEmbedData
            Returns: name, paradigmSummary, paradigmUrl, school,
                     notionNotes, notionUrl
         ↓
buildJudgeEmbed() creates Discord embed

═══════════════════════════════════════════════════════════════════════════════
EMAIL FORMAT DETECTION
═══════════════════════════════════════════════════════════════════════════════

FORMAT A — Single Live Update:
  Subject: [TAB] TeamCode Round 3 CX-T
  Body: One pairing with AFF/NEG competitors
  Action: Extract one pairing, call _processSinglePairing() once

FORMAT B — Round Assignments:
  Subject: [TAB] School Round Assignments
  Body: ENTRIES section with multiple team blocks
  Action: Loop through entries, call _processSinglePairing() for each

═══════════════════════════════════════════════════════════════════════════════
FOR ADDING "ALL-TEAM REPORT" FEATURE
═══════════════════════════════════════════════════════════════════════════════

APPROACH 1 — Command-driven:
  @Clerk Kent all-team report [round_number]
  → Query all teams' latest pairings
  → Aggregate into single message or multi-message report
  → Send to specified channel or broadcast

APPROACH 2 — Email-driven:
  Existing FORMAT B already processes all teams!
  → Detect Format B, don't send individual reports
  → Collect all in memory, send one consolidated report
  → Send to special #all-team-report channel

REUSABLE PARTS:
  • _processSinglePairing() logic (extract for opponent/judge lookups)
  • reportBuilder methods (already embed-agnostic)
  • caselist/Notion/paradigm services (already do lookups)

NEW CODE NEEDED:
  • Collector function: aggregate all team pairings from one email
  • New embed format: show all teams in single/multiple embeds
  • Option to send to channel or DM
  • Potentially: new command handler for on-demand all-team reports

═══════════════════════════════════════════════════════════════════════════════
