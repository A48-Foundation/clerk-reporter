═══════════════════════════════════════════════════════════════════════════════
CLERK-REPORTER: COMPLETE FLOW ANALYSIS FOR ALL-TEAM REPORT FEATURE
═══════════════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════════════
1. SESSION SETUP FLOW & _pendingSession STRUCTURE
═══════════════════════════════════════════════════════════════════════════════

FILE: bot.js, lines 143-261

_pendingSession is a transient object stored between "initiate pairings" and
button confirmation. It bridges the gap between user interaction and session
activation.

STRUCTURE:
  _pendingSession = {
    tournId: "36452",                   # Tabroom tournament ID (string)
    tournamentUrl: "https://...",       # Full tournament URL provided by user
    tournamentName: "Name Cup",         # Human-readable tournament name
    mapping: {                           # Pre-confirmation channel mapping
      "Interlake CG": {
        channelId: "123456",
        channelName: "cg-tournaments",
        confidence: "auto"              # or "manual" or "unmatched"
      },
      "Cuttlefish AC": {
        channelId: "789012",
        channelName: "ac-tournaments",
        confidence: "auto"
      },
      "Interlake SW": {
        channelId: null,
        channelName: null,
        confidence: "unmatched"         # Could not find Discord channel
      }
    },
    allEntries: [                        # ALL tournament entries (not just ours)
      { code: "Interlake CG", entry: "Person1 & Person2" },
      { code: "Interlake AC", entry: "Person3 & Person4" },
      { code: "Opponent School AB", entry: "Person5 & Person6" },
      ... many more
    ],
    channelId: "987654",                # Discord channel where user initiated
    userId: "user_id"                   # Discord user ID of initiator
  }

FLOW:
  1. User: @Clerk Kent initiate pairings reports https://tabroom.com/...
     └─ handleInitiatePairings() called (line 143)

  2. Parse URL → extract tournId and eventId
     └─ TabroomScraper.parseUrl() and TabroomScraper.scrapeEntries()

  3. Filter to our school teams only
     └─ schoolNames = env.SCHOOL_NAMES split by comma (e.g., "Interlake,Cuttlefish")
     └─ ourEntries = result.entries.filter(e => name.toLowerCase().startsWith(school))

  4. Auto-map teams to Discord channels
     └─ channelMapper.autoMap(teamCodes) (line 213)
     └─ Looks for channels named "{SUFFIX}-tournaments"

  5. Show confirmation embed with mapping
     └─ Display which teams found channels (✅) vs not found (❌)
     └─ Two buttons: "✅ Confirm & Start" and "Cancel" (lines 232-241)

  6. Store _pendingSession (lines 247-255)
     └─ Held in memory until button click

  7. User can override mappings (optional step)
     └─ Type "CG=#helpful-channel" (no mention needed, line 59-64)
     └─ handleChannelOverride() updates _pendingSession.mapping (lines 266-324)
     └─ Can do multiple: "CG=#ch-name LZ=#other-name"

  8. User clicks "✅ Confirm & Start"
     └─ handleButtonInteraction() for "pairings_confirm" (lines 330-381)
     └─ Convert _pendingSession → activeSession (line 348)
     └─ Clear _pendingSession (line 337)
     └─ Start EmailMonitor (lines 355-363)

SETTINGS/STATE IN SESSION:
  After conversion to activeSession (see section 2):
  - tournId: Used to poll for new rounds (pairings-poller.js may use it)
  - channelMappings: Maps each team code to its Discord channel for message sending
  - allEntries: Used to look up opponent entry names (e.g., "Person1 & Person2")
    ├─ When processing pairings, we have opponent CODE but need their NAMES
    ├─ store.getEntryNamesForTeam(opponentCode) looks up from allEntries
    └─ Passed to caselist service to find opponent's cases
  - emailMonitorActive: Flag to restore monitor on bot restart
  - processedEmailUids: Prevents duplicate email processing (deduplication)
  - startedAt: Session start time (for logging/debugging)

═══════════════════════════════════════════════════════════════════════════════
2. ACTIVE SESSION STORAGE: tournament-store.js
═══════════════════════════════════════════════════════════════════════════════

FILE: tournament-store.js, lines 158-169 (setActiveSession method)

ACTIVE SESSION is the PERSISTENT version stored to tournaments.json:

activeSession = {
  tournId: "36452",                     # Tabroom tournament ID
  tournamentUrl: "https://...",         # Preserved for reference
  channelMappings: {                    # FINAL mapping (only teams with channels)
    "Interlake CG": "123456",
    "Interlake AC": "789012"
    # Note: "Interlake SW" with null channelId is NOT included
  },
  allEntries: [                         # All tournament entries for lookups
    { code: "Interlake CG", entry: "Chen & Griffiths" },
    { code: "Opponent AB", entry: "Smith & Jones" },
    ... (includes all teams in tournament, not just ours)
  ],
  emailMonitorActive: true,             # Is email monitor running?
  processedEmailUids: [],               # Grows as emails are processed
  startedAt: "2024-01-15T10:30:00Z"    # ISO timestamp
}

KEY FIELDS:
  - tournId & tournamentUrl: Identify tournament
  - channelMappings: Lookup table for sending reports to channels
  - allEntries: Critical for opponent name lookups
    ├─ When email says opponent code is "Opponent AB"
    ├─ We need to get their Tabroom entry names ("Person1 & Person2")
    ├─ Used by caselist service to find cases
    └─ store.getEntryNamesForTeam(teamCode) returns entry name string
  - emailMonitorActive: Used on bot restart to restore session (line 1044)
  - processedEmailUids: Prevents emails from being processed twice
    ├─ Each incoming email has a UID
    ├─ store.addProcessedEmailUid(uid) marks it processed
    ├─ store.isEmailProcessed(uid) checks if already seen

═══════════════════════════════════════════════════════════════════════════════
3. CHANNEL MAPPING STRUCTURE: channel-mapper.js
═══════════════════════════════════════════════════════════════════════════════

FILE: channel-mapper.js (full file, 141 lines)

MAPPING STRUCTURE:
  mapping = {
    "Interlake CG": {
      channelId: "123456789",           # Discord snowflake ID
      channelName: "cg-tournaments",    # Name of Discord channel
      confidence: "auto"                # or "manual" or "unmatched"
    },
    "Interlake AC": {
      channelId: "987654321",
      channelName: "ac-tournaments",
      confidence: "auto"
    },
    "Interlake OC": {
      channelId: null,
      channelName: null,
      confidence: "unmatched"           # No channel found for this team
    }
  }

AUTO-MAPPING ALGORITHM (lines 39-61):
  1. For each team code in the input array:
  2. Extract suffix: lastWordAfterSplit(code)
     └─ "Interlake CG".split(/\s+/) → ["Interlake", "CG"] → "CG"
  3. Search all Discord guilds for channel named "{suffix}-tournaments"
     └─ channelMapper.findChannel(suffix) (lines 23-33)
     └─ Looks in guild.channels.cache for case-insensitive name match
  4. If found → set confidence="auto", store channelId and channelName
  5. If not found → set confidence="unmatched", channelId=null

CONFIRMATION & OVERRIDES (lines 67-137):
  - Show embed with mapping, wait for reaction (✅) or message override
  - Override format: "CG=#ch-name LZ=#other-ch"
  - Pattern: /(\w+)=(?:#?)([\w-]+)/g
  - User types: "CG=#helpful-channel" (# optional)
  - Looks up channel by name and updates mapping to confidence="manual"

═══════════════════════════════════════════════════════════════════════════════
4. HANDLING PAIRING EVENTS: handlePairingEvent()
═══════════════════════════════════════════════════════════════════════════════

FILE: bot.js, lines 459-560

HIGH LEVEL FLOW:
  EmailMonitor emits 'pairing' event with email data
    → handlePairingEvent() receives eventData
      → Validate session & deduplication
        → Parse email if needed (regex first, LLM fallback)
          → Route by FORMAT (A=single, B=assignments)
            → Filter to our school teams
              → Call _processSinglePairing() for each of our teams

DETAILED FLOW:

INPUT eventData from EmailMonitor:
  {
    uid: "email_unique_id",             # For deduplication
    raw: "raw email body text",         # Full email text
    parsed: {                           # Pre-parsed by EmailMonitor
      format: "liveUpdate" | "assignments",
      roundTitle: "Round 3",
      startTime: "10:30 AM",
      aff: { teamCode: "...", ... },    # FORMAT A only
      neg: { teamCode: "...", ... },
      room: "104",
      judges: [...],
      entries: [...]                    # FORMAT B only
    }
  }

VALIDATION (lines 464-477):
  1. Extract uid, raw, parsed
  2. Get activeSession from store
  3. If no session → ignore email (no active pairings pipeline)
  4. If email already processed → skip (dedup check)
  5. Mark email as processed: store.addProcessedEmailUid(uid)

FALLBACK PARSING (lines 480-489):
  If parsed is incomplete or missing required fields:
    1. EmailParser._isCompletePairing(parsed) checks for required data
    2. If incomplete: EmailParser.parseWithFallback(raw, llmService)
       └─ Tries regex first
       └─ If regex fails, uses LLM to extract pairing data
    3. If still incomplete after LLM → skip email

FORMAT ROUTING (lines 497-556):

  FORMAT B — "assignments" (multiple teams per email)
  Subject: "[TAB] Cuttlefish Round Assignments"
  
    Process each entry in parsed.entries array:
      1. Check if entry.teamCode is ours (line 500)
      2. Determine opponent's side (line 504-507):
         ├─ If we're AFF → opponent is on NEG → opponentSide = 'N'
         ├─ If we're NEG → opponent is on AFF → opponentSide = 'A'
         └─ If FLIP → opponentSide = null
      3. Call _processSinglePairing() (line 509-519)
  
  FORMAT A — "liveUpdate" (single pairing)
  Subject: "[TAB] Interlake CG Round 3 CX-T"
  
    1. Extract aff.teamCode and neg.teamCode (line 523-524)
    2. Check which is ours (line 525-526)
    3. If our team on AFF (line 529-533):
       └─ ourTeamCode = affCode
       └─ opponentCode = negCode
       └─ opponentSide = 'N' (opponent is on NEG)
       └─ side = 'AFF'
    4. Else if our team on NEG (line 534-538):
       └─ ourTeamCode = negCode
       └─ opponentCode = affCode
       └─ opponentSide = 'A' (opponent is on AFF)
       └─ side = 'NEG'
    5. Call _processSinglePairing() (line 543-555)

═══════════════════════════════════════════════════════════════════════════════
5. SINGLE PAIRING PROCESSOR: _processSinglePairing()
═══════════════════════════════════════════════════════════════════════════════

FILE: bot.js, lines 565-668

INPUT PAIRING OBJECT:
  {
    ourTeamCode: "Interlake CG",        # Our team's code (string)
    opponentCode: "Opponent AB",        # Opponent team code
    opponentSide: "N" | "A" | null,     # Opponent's side: N=NEG, A=AFF, null=FLIP
    side: "AFF" | "NEG" | "FLIP",       # Our side
    room: "104",                        # Room number
    judges: [                           # Array of judges
      { name: "Judge Name", judgeId: 123 },
      { name: "Another Judge" }
    ],
    roundTitle: "Round 3",              # e.g., "Round 6 of Policy - Open"
    startTime: "10:30 AM",              # e.g., "10:30 AM"
    roundNumber: 3,                     # Numeric round number (may be null)
    aff: { teamCode: "Interlake CG" },  # (FORMAT A) Aff team object
    neg: { teamCode: "Opponent AB" }    # (FORMAT A) Neg team object
  }

INPUT SESSION (from store.getActiveSession()):
  {
    tournId: "36452",
    channelMappings: {
      "Interlake CG": "123456",
      ...
    },
    allEntries: [
      { code: "Interlake CG", entry: "Person1 & Person2" },
      { code: "Opponent AB", entry: "Opponent Names" },
      ...
    ],
    ...
  }

PROCESSING STEPS:

STEP 1: FIND DISCORD CHANNEL (lines 570-579)
  channelId = session.channelMappings[ourTeamCode]
  if (!channelId) return  # No channel mapped → skip
  channel = client.channels.fetch(channelId)
  channel.sendTyping()  # Show bot is typing

STEP 2: LOOK UP OPPONENT DATA (lines 582-614)

  A. Get opponent's Tabroom entry names (lines 585-588)
     entryNames = store.getEntryNamesForTeam(opponentCode)
     Example: "Chen & Griffiths"
     └─ Used by caselist service to search for their cases

  B. Look up opponent's caselist (lines 590-592)
     IF opponentSide is known (not FLIP):
       caselistResult = caselistService.lookupOpponent(
         opponentCode,           # Team code
         opponentSide,           # 'A' or 'N' (our opponent's side)
         entryNames              # Their Tabroom names
       )
       Returns: {
         rounds: [roundData, ...],  # Array of case round files
         schoolName: "School",
         teamCode: "AB",
         caselistUrl: "https://caselist.com/..."
       }

  C. Summarize opponent's arguments (lines 594-596)
     IF caselistResult.rounds.length > 0:
       argumentSummary = llmService.summarizeWithFallback(
         caselistResult.rounds,
         opponentSide,  # 'A' or 'N'
         downloadUrlFn,  # Function to generate download URLs
         negContext     # If opponent is on NEG: { ourAff: "PNT" }
       )
       └─ LLM reads case files and summarizes their strategy
       └─ For NEG opponent: includes analysis vs our aff ("PNT")

  D. Build opponentData object (lines 598-613)
     IF caselistResult found:
       opponentData = {
         schoolName: caselistResult.schoolName,
         teamCode: caselistResult.teamCode,
         caselistUrl: caselistResult.caselistUrl,
         side: opponentSide === 'A' ? 'Aff' : 'Neg',
         argumentSummary: argumentSummary
       }
     ELSE:
       opponentData = {
         schoolName: opponentCode,
         teamCode: '',
         caselistUrl: null,
         side: opponentSide ? (opponentSide === 'A' ? 'Aff' : 'Neg') : 'FLIP',
         argumentSummary: "_No caselist data found._" or "_Side unknown (FLIP)..._"
       }

STEP 3: LOOK UP JUDGES (lines 616-649)

  Initialize: judgeEmbedData = []

  For each judge in judges array:

    A. Validate judge name (line 621)
       Skip if: name < 3 chars, name is all dashes, name is signature (thanks/sent from)

    B. Fetch paradigm (lines 627-634)
       paradigm = paradigmService.fetchParadigmByName(judgeName)
       IF paradigm found:
         paradigmUrl = paradigm.paradigmUrl
         school = paradigm.school
         IF paradigm.philosophy:
           paradigmSummary = llmService.summarizeParadigm(philosophy)
           └─ LLM condenses paradigm philosophy to key points

    C. Fetch from Notion database (lines 638-646)
       notionResults = notion.searchJudge(judgeName)
       IF results found:
         j = results[0]  # First match
         notionUrl = j.url
         IF j.comments (length > 0):
           Build notionNotes from comments array
           If > 500 chars: truncate to 497 + "..."

    D. Add to judgeEmbedData (line 648)
       judgeEmbedData.push({
         name: judgeName,
         paradigmSummary,    # LLM-summarized paradigm
         paradigmUrl,        # Link to full paradigm
         school,
         notionNotes,        # Notion comments
         notionUrl           # Link to Notion page
       })

  Result: judgeEmbedData = [judge1_data, judge2_data, judge3_data, ...]

STEP 4: BUILD PAIRING EMBED DATA (lines 651-660)
  
  pairingEmbed = {
    roundTitle: roundTitle || "Round " + roundNumber,
    startTime: startTime,
    room: room,
    side: side,  # "AFF" or "NEG" or "FLIP" (our side)
    teamCode: ourTeamCode,
    aff: aff || { teamCode: side === 'AFF' ? ourTeamCode : opponentCode },
    neg: neg || { teamCode: side === 'NEG' ? ourTeamCode : opponentCode }
  }

STEP 5: BUILD DISCORD EMBEDS (lines 662-663)
  
  embeds = reportBuilder.buildFullReport(
    pairingEmbed,        # Pairing info
    opponentData,        # Opponent caselist summary
    judgeEmbedData       # Array of judge embeds
  )
  
  Returns: Array of Discord embeds (max 10 per API limits)

STEP 6: SEND TO DISCORD (lines 664-667)
  
  IF embeds.length > 0:
    channel.send({ embeds: embeds.slice(0, 10) })
    Log: "✅ Sent pairings report for Interlake CG (Round 3)"

═══════════════════════════════════════════════════════════════════════════════
6. REPORT BUILDER: report-builder.js (FULL CODE WITH LINE NUMBERS)
═══════════════════════════════════════════════════════════════════════════════
