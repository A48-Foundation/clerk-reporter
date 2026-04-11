# Clerk Reporter

Automated debate tournament scouting reports, delivered straight to Discord.

Clerk Reporter monitors a Gmail inbox for [Tabroom](https://www.tabroom.com) pairing notification emails. When a new round is paired, it automatically identifies your team, researches the opponent on [OpenCaselist](https://opencaselist.com/hspolicy25), fetches the judge's paradigm from Tabroom, summarizes both with an LLM, and posts a rich scouting report to the team's Discord channel.

---

## For Users

### What the Bot Does

When you activate the pairings pipeline during a tournament, the bot will automatically send a **scouting report** to each team's Discord channel every time Tabroom publishes a new pairing. Each report includes:

- **Pairing summary** — round name, your side (Aff/Neg/Flip), opponent, room, and start time
- **Opponent scouting** — arguments the opponent has read on the relevant side, pulled from OpenCaselist with frequency analysis (e.g. "1AC - PNT (6 occurrences)", "2NR - Politics (3 occurrences)")
- **Open source documents** — if the opponent has open sourced their most recent aff or their most recent neg strategy vs your aff, the report includes a download link
- **Judge info** — concise bullet-point paradigm summary (Neg Ks, T v K Affs, T v Policy, CPs, DAs, Theory, Speed, Experience), Tabroom profile link, and any notes from your Notion judge database

### Commands

All commands start by @-mentioning the bot.

#### Start Automated Reports

```
@Clerk Kent initiate pairings reports <tabroom_entries_url>
```

Provide a link to the tournament **entries** page on Tabroom (with `tourn_id` and `event_id`). The bot will:

1. Log into Tabroom and scrape the entries list for that event
2. Identify all your teams (based on `SCHOOL_NAMES`)
3. Propose a channel mapping and show **Confirm** / **Cancel** buttons
4. On confirm, start monitoring the email inbox for pairing notifications
5. Automatically send scouting reports as rounds are paired

**Example:**

```
@Clerk Kent initiate pairings reports https://www.tabroom.com/index/tourn/fields.mhtml?tourn_id=36452&event_id=372080
```

If you only provide a `tourn_id` (no `event_id`), the bot will list available events and auto-select if there's exactly one policy event.

#### Add Manual Entries

```
@Clerk Kent add entry <team_code> #channel-name
```

Manually add a team to the active session's tracking. Useful when a team wasn't found in the scraped entries, or to override the auto-mapped channel. If no channel is specified, defaults to the current channel.

#### Stop Automated Reports

```
@Clerk Kent stop pairings
```

Deactivates the email monitor and clears the session.

#### Set Your Aff

```
@Clerk Kent our aff is <name>
```

Sets the name of your team's current 1AC (e.g. `PNT`, `Science Diplomacy`). This is used when scouting opponents on **Neg** — the bot searches their caselist for rounds where they went neg against your aff. Defaults to `PNT`. Persists between sessions.

#### Email Processing

When a pairing email arrives, the bot:
1. **Tries regex parsing first** — matches both Format A (live updates) and Format B (round assignments)
2. **Falls back to LLM** if regex can't extract complete data (requires OpenAI API key)
3. **Validates** the email has an opponent, team, judge, and start time — skips if any are missing

#### Manual Team Tracking

```
@Clerk Kent track <tabroom_url> <team_code>
```

Registers a team for round-by-round updates in the current channel. The bot polls Tabroom directly (no email needed).

```
@Clerk Kent report <code>
```

Fetches the latest round's pairing and judge info for a tracked team. Use just the team suffix (e.g. `SW`, `CG`).

#### Coach Reports

```
@Clerk Kent report coaches <tabroom_judges_url>
```

Scrapes the Tabroom judges page and identifies coaches from your tracked schools (e.g. Interlake, Cuttlefish Independent). When a coach's judging assignment email arrives, the bot sends a simplified report to the channel where the command was issued — showing only the **coach name**, **start time**, **room**, and **competitors** (no paradigm/wiki lookup).

```
@Clerk Kent stop coaches
```

Stop monitoring for coach assignment emails.

```
@Clerk Kent untrack <team_code>
@Clerk Kent tournaments
```

Remove a tracked team, or list all active tournament trackings.

#### Health Check

```
@Clerk Kent poll test
```

Runs a live diagnostic and replies with a status embed showing:
- **Discord** — connection status
- **Email Monitor** — INBOX state and last successful poll time
- **Tabroom** — live connectivity test against a tracked tournament
- **Notion** — judge cache status and count
- **Uptime** — how long the bot has been running (e.g. `2d 5h 13m`)

Also responds to `@Clerk Kent health` and `@Clerk Kent alive`.

#### Judge Lookup

```
@Clerk Kent <judge name>
```

Searches the Notion judge database and returns info (win rate, email, prefs, tags, and any coach notes).

### Example Report Output

**Argument Summary (Opponent on Aff):**
```
1AC - PNT (6 occurrences) - Docs
1AC - sci dip (5 occurrences) - Docs
Most Recent: sci dip - TOC Digital Speech Series, Round 3
```

**Judge Paradigm Summary:**
```
• Neg Ks: Hard for neg to win that aff shouldn't weigh the plan if framework is answered well
• T v K Affs: Aff doesn't need to solve like the plan; neg should justify their model of debate
• T v Policy: Persuaded by negative appeals to limits; fairness is an impact
• CPs: Non-topical CPs acceptable; prefer well-researched mechanisms; 2 condo good, 3 okay
• DAs: Enjoys DA and case debate; impact calculus and turns case analysis important
• Theory: Reject the argument not the team; consult/conditioning/delay CPs, intl fiat, 50 state fiat bad
• Speed: Clarity > speed
• Experience: Former policy debater at University of Washington
```

### Channel Naming Convention

The bot automatically maps team codes to Discord channels using this pattern:

| Team Code | Expected Channel |
|-----------|-----------------|
| Interlake CG | `#cg-tournaments` |
| Cuttlefish independent WS | `#ws-tournaments` |
| Interlake SW | `#sw-tournaments` |

The last word of the team code (the letter suffix) is lowercased and appended with `-tournaments`. Create your channels following this pattern, or use overrides when prompted.

### Email Formats Supported

The bot detects and parses two Tabroom email formats:

- **Live Update** — one team per email, sent to `[TAB] Team Round N Event` subjects with a structured body (Competitors, Judging sections)
- **Round Assignments** — one school per email with `[TAB] School Round Assignments` subjects, may contain multiple team entries

Non-pairing emails (check-in notices, registration reminders, payment info) are automatically filtered out.

---

## For Developers

### Architecture

```
index.js                  Entry point — env validation, crash guards, graceful shutdown
  └─ bot.js               Discord command handler + pairings pipeline orchestrator
       ├─ email-monitor.js       Gmail IMAP poller → emits 'pairing' events
       ├─ email-parser.js        Parses email subject/body → structured pairing data
       ├─ caselist-service.js    OpenCaselist API client (auth, school/team lookup, rounds)
       ├─ paradigm-service.js    Tabroom paradigm scraper (cheerio-based)
       ├─ paradigm-summarizer.js LLM paradigm summarizer (reusable)
       ├─ llm-service.js         Argument frequency analysis + delegates to paradigm-summarizer
       ├─ channel-mapper.js      Team code → Discord channel auto-mapping
       ├─ report-builder.js      Builds Discord embed arrays
       ├─ tournament-store.js    JSON file persistence for sessions + tracking
       ├─ notion-service.js      Notion API — judge search with Fuse.js fuzzy matching
       ├─ tabroom-scraper.js     Scrapes Tabroom pairings HTML pages (30s request timeouts)
       └─ pairings-poller.js     Polling-based round checker with heartbeat logging
```

### Data Flow

```
Tabroom emails → Gmail IMAP
                     │
            EmailMonitor polls every 30s
                     │
            isPairingEmail() filter
                     │
     ┌───── Regex parse (Format A / B) ─────┐
     │                                       │
  Complete?                           Incomplete?
     │                                       │
     │                              LLM fallback parse
     │                                       │
     └───────────────┬───────────────────────┘
                     │
          Validate: opponent + team + judge + startTime
          (skip if any missing)
                     │
          handlePairingEvent()
                     │
     ┌───────────────┼───────────────┐
     │               │               │
 CaselistService  ParadigmService  NotionService
 (opponent args)  (judge paradigm) (judge notes)
     │               │               │
     └───────┬───────┘               │
             │                       │
        LlmService                   │
     (summarization)                 │
             │                       │
             └───────────┬───────────┘
                         │
                  ReportBuilder
                  (Discord embeds)
                         │
                  channel.send()
```

### Setup

#### Prerequisites

- **Node.js** ≥ 18
- A **Discord bot** with `Send Messages`, `Read Message History`, and `Add Reactions` permissions, plus **Message Content Intent** enabled
- A **Notion integration** connected to your judge database
- A **Gmail account** with IMAP enabled and a 16-character App Password (requires 2FA)
- A **Tabroom account** (used for OpenCaselist API auth and paradigm scraping)
- *(Optional)* An **OpenAI API key** for LLM-powered summaries — without it, the bot falls back to keyword frequency analysis

#### 1. Clone and Install

```bash
git clone https://github.com/A48-Foundation/clerk-reporter.git
cd clerk-reporter
npm install
```

#### 2. Configure Environment

Create a `.env` file in the project root:

```env
# ── Required ──────────────────────────────────────────
NOTION_TOKEN=secret_abc123...
JUDGE_DATABASE_ID=abc123-def456-...
DISCORD_TOKEN=MTIz...

# ── Tabroom (for caselist + paradigm lookups) ─────────
TABROOM_EMAIL=your@email.com
TABROOM_PASSWORD=your_tabroom_password

# ── Gmail IMAP (for pairing email monitoring) ─────────
IMAP_EMAIL=clerk.kent.debate@gmail.com
IMAP_PASSWORD=abcdefghijklmnop

# ── Optional ──────────────────────────────────────────
OPENAI_API_KEY=sk-...
SCHOOL_NAMES=Interlake,Cuttlefish,Cuttlefish Independent
FEEDBACK_DATABASE_ID=abc123-...
```

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTION_TOKEN` | ✅ | Notion integration token |
| `JUDGE_DATABASE_ID` | ✅ | ID of the Notion judge database |
| `DISCORD_TOKEN` | ✅ | Discord bot token |
| `TABROOM_EMAIL` | For pairings | Tabroom login email (also used for OpenCaselist auth) |
| `TABROOM_PASSWORD` | For pairings | Tabroom login password |
| `IMAP_EMAIL` | For pairings | Gmail address to monitor for Tabroom emails |
| `IMAP_PASSWORD` | For pairings | Gmail App Password (16 chars, requires 2FA) |
| `OPENAI_API_KEY` | Optional | Enables LLM summarization; without it, uses keyword frequency analysis |
| `SCHOOL_NAMES` | Optional | Comma-separated school names to detect in pairings (default: `Interlake,Cuttlefish`) |
| `FEEDBACK_DATABASE_ID` | Optional | Notion feedback database (reserved for future features) |

#### 3. Gmail App Password

1. Enable **2-Step Verification** on the Gmail account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Generate a new App Password for "Mail"
4. Copy the 16-character password into `IMAP_PASSWORD`

#### 4. Notion Database

The judge database must have these properties:
- **Name** (title) — judge name
- **Win%** (rollup → number) — win rate as decimal
- **Email** (email)
- **Tabroom** (URL) — link to Tabroom profile
- **Tags** (multi-select)
- **Prefs** (number)
- Comments on pages are used as coach notes

> ⚠️ The bot only **reads** from Notion — it will never create, update, or delete pages.

#### 5. Discord Channel Setup

Create channels following the `{suffix}-tournaments` pattern for each team:
- `#cg-tournaments` for team code ending in CG
- `#sw-tournaments` for team code ending in SW
- etc.

#### 6. Run

```bash
npm start
```

#### 7. Deploy to Railway (Optional)

1. Push your repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub Repo**
3. Select the `clerk-reporter` repository
4. Railway auto-detects Node.js. The `Procfile` runs it as a **worker** (no web port needed)
5. Add environment variables in **Settings → Variables**:

   ```
   DISCORD_TOKEN=MTIz...
   NOTION_TOKEN=secret_abc123...
   JUDGE_DATABASE_ID=abc123-def456-...
   TABROOM_EMAIL=your@email.com
   TABROOM_PASSWORD=your_tabroom_password
   IMAP_EMAIL=clerk.kent.debate@gmail.com
   IMAP_PASSWORD=abcdefghijklmnop
   OPENAI_API_KEY=sk-...
   SCHOOL_NAMES=Interlake,Cuttlefish,Cuttlefish Independent
   ```

6. Deploy — the bot will start automatically and reconnect on restarts

> **Note:** `tournaments.json` (session state) is ephemeral on Railway — it resets on each deploy. The bot auto-restores email monitoring from persisted sessions, but channel mappings will need to be re-confirmed after a fresh deploy.

### Running Tests

```bash
npm test
```

The test suite includes **176 tests** across 6 files:

| File | Tests | What it covers |
|------|-------|----------------|
| `email-parser.test.js` | 63 | Subject/body parsing, pairing detection, LLM fallback, validation |
| `channel-mapper.test.js` | 14 | Team suffix extraction, channel lookup, auto-mapping |
| `report-builder.test.js` | 21 | Embed construction, doc link fields, truncation, embed cap |
| `llm-service.test.js` | 13 | Frequency analysis, inline doc links, paradigm truncation, LLM fallback |
| `caselist-service.test.js` | 31 | Team code parsing, school lookup, wiki URL construction, entry name matching |
| `tournament-store.test.js` | 33 | Load/save, team tracking, session management, email UID tracking, settings |

Test fixtures live in `tests/fixtures/emails.js` — real email samples with pre-calculated expected outputs.

### Key Implementation Details

**Email parsing** (`email-parser.js`):
- Format A ("Live Update"): subject `[TAB] Team Round N Event`, body has `Competitors` and `Judging` sections
- Format B ("Round Assignments"): subject `[TAB] School Round Assignments`, body has `ENTRIES` section with indented data blocks
- `isPairingEmail()` uses a signal-counting approach — checks for structural markers (Competitors, ENTRIES, Judges:, AFF/NEG, vs) and rejects logistics emails (check-in, payment, registration)
- `parseWithFallback()` tries regex first, falls back to LLM if incomplete, validates required fields (opponent, team, judge, startTime)
- `_isCompletePairing()` ensures all critical fields are present before generating a report

**Tournament setup** (`tabroom-scraper.js` + `bot.js`):
- Authenticates with Tabroom to access entries pages
- Scrapes entries from `/index/tourn/fields.mhtml?tourn_id=X&event_id=Y` (table with Institution/Location/Entry/Code columns)
- Discord buttons (ActionRowBuilder + ButtonBuilder) for Confirm/Cancel interaction
- `add entry` command for manual team→channel mapping overrides

**OpenCaselist API** (`caselist-service.js`):
- Auth: `POST https://api.opencaselist.com/v1/login` with Tabroom credentials → `caselist_token` cookie
- Team lookup: uses Tabroom entry names (e.g. "Levine & Zhang") to derive caselist slug (e.g. "LeZh") via 3-strategy matching
- Uses Fuse.js fuzzy matching for school name resolution
- `getLatestAffDoc()` — finds opponent's most recent open-sourced aff document
- `getNegVsAff()` — searches opponent's neg rounds for strategies against your aff (fuzzy matches report text)
- Download URL: `GET https://api.opencaselist.com/v1/download?path=<opensource_path>`

**Session persistence** (`tournament-store.js`):
- Stores to `tournaments.json` with format: `{ tournaments: {...}, activeSession: {...}, settings: {...} }`
- Tracks processed email UIDs to prevent duplicate reports
- `settings.ourAff` persists the team's current aff name across sessions (default: "PNT")

**Reliability (multi-day uptime)**:
- `uncaughtException` and `unhandledRejection` handlers in `index.js` log errors without crashing the process
- All HTTP requests in `tabroom-scraper.js` have a 30-second timeout to prevent hung connections from blocking the poll loop
- Graceful shutdown on `SIGTERM`/`SIGINT` cleanly destroys the Discord client
- Email monitor has a watchdog timer, exponential backoff reconnect, and per-poll timeouts
- Pairings poller logs a heartbeat to stdout every 30 minutes
- `@Clerk Kent poll test` command provides a live health check from Discord

---

### Standalone: Paradigm Summarizer

`paradigm-summarizer.js` is a self-contained module you can use independently in other projects. It takes raw Tabroom paradigm text and returns concise bullet points via OpenAI.

#### Usage

```js
const ParadigmSummarizer = require('./paradigm-summarizer');

const summarizer = new ParadigmSummarizer(process.env.OPENAI_API_KEY, {
  model: 'gpt-4o-mini',   // optional, default
  temperature: 0.15,       // optional, default
  maxTokens: 250,          // optional, default
});

const bullets = await summarizer.summarize(paradigmText);
console.log(bullets);
```

#### With Paradigm Service (fetch + summarize)

```js
const ParadigmService = require('./paradigm-service');
const ParadigmSummarizer = require('./paradigm-summarizer');

const ps = new ParadigmService();
const summarizer = new ParadigmSummarizer(process.env.OPENAI_API_KEY);

const judge = await ps.fetchParadigmByName('Miriam Mokhemar');
const summary = await summarizer.summarize(judge.philosophy);
```

#### Output Categories

The summarizer extracts bullets for (when present in the paradigm):

| Category | What it covers |
|----------|---------------|
| Neg Ks | Good/bad for kritiks on neg, alt voting, framework |
| T v K Affs | Topicality/framework vs critical affs, topical version of aff |
| T v Policy | Topicality vs policy affs, limits, precision |
| CPs | Counterplan preferences, conditionality |
| DAs | Disadvantage preferences, link quality |
| Theory | Specific bad/good args (consult CPs, intl fiat, etc.), reject arg/team |
| Speed | Speed tolerance, clarity preferences |
| Experience | Judging/coaching/competing background |
| Non-policy | LD, PF, parli, speech background |
| Speaker points | Point range, scale, criteria |
| Strong indicators | Auto-rejects, dealbreakers |
