# Clerk Kent — Discord Judge Lookup & Pairings Report Bot

A Discord bot that searches a Notion database of debate judges, tracks tournament pairings from Tabroom, and automatically generates scouting reports with opponent argument analysis and judge paradigm summaries.

## Features

### Judge Lookup
Mention the bot with a judge name to get their info from Notion (win rate, email, prefs, tags, notes).

### Automated Pairings Reports (NEW)
When activated, the bot monitors a Gmail inbox for Tabroom pairing notification emails and automatically sends scouting reports to each team's Discord channel:
- **Opponent scouting** — looks up the opponent on [OpenCaselist](https://opencaselist.com/hspolicy25), summarizes their arguments (1AC list for aff, 2NR strategies for neg) with frequency analysis
- **Judge paradigm** — fetches and LLM-summarizes the judge's paradigm from Tabroom, plus any notes from the Notion judge database
- **Auto channel mapping** — maps team codes to Discord channels (e.g. `Interlake CG` → `#cg-tournaments`)

## Setup

### 1. Discord Bot Setup
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application named **Clerk Kent**
3. Go to **Bot** → click **Reset Token** → copy the token into `.env`
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`
6. Copy the generated URL and open it in your browser to invite the bot to your server

### 2. Notion Integration Setup
1. Go to [Notion Integrations](https://www.notion.so/my-integrations) and create an integration
2. Copy the integration token into `.env` as `NOTION_TOKEN`
3. Share your **Judges** database with the integration

### 3. Gmail IMAP Setup (for pairings pipeline)
1. Enable 2-Step Verification on the Gmail account (`clerk.kent.debate@gmail.com`)
2. Generate an App Password at [myaccount.google.com](https://myaccount.google.com/apppasswords)
3. Copy the 16-character app password into `.env` as `IMAP_PASSWORD`

### 4. Environment Variables
Create a `.env` file with:
```
# Notion
NOTION_TOKEN=your_notion_integration_token
JUDGE_DATABASE_ID=your_judge_database_id
FEEDBACK_DATABASE_ID=your_feedback_database_id

# Discord
DISCORD_TOKEN=your_discord_bot_token

# Tabroom credentials (for OpenCaselist API + paradigm scraping)
TABROOM_EMAIL=your_tabroom_email
TABROOM_PASSWORD=your_tabroom_password

# Gmail IMAP for pairing email monitoring
IMAP_EMAIL=clerk.kent.debate@gmail.com
IMAP_PASSWORD=your_gmail_app_password

# LLM API key for argument/paradigm summarization
OPENAI_API_KEY=your_openai_api_key

# Comma-separated school names to auto-detect in pairings
SCHOOL_NAMES=Interlake,Cuttlefish,Cuttlefish Independent
```

### 5. Install & Run
```bash
npm install
npm start
```

### 6. Run Tests
```bash
npm test
```

## Usage

### Judge Lookup
```
@Clerk Kent John Smith
@Clerk Kent Smith
```

### Pairings Pipeline
```
@Clerk Kent initiate pairings reports https://www.tabroom.com/index/tourn/postings/round.mhtml?tourn_id=36452&round_id=1503711
```
The bot will:
1. Find all Interlake/Cuttlefish teams in the pairings
2. Auto-map them to Discord channels (e.g. CG → #cg-tournaments)
3. Ask for confirmation/overrides
4. Start monitoring the email inbox for pairing notifications
5. Automatically send scouting reports when new pairings arrive

To stop: `@Clerk Kent stop pairings`

### Manual Commands
```
@Clerk Kent track <tabroom_url> <team_code>    — Register a team
@Clerk Kent report <code>                      — Get latest round report
@Clerk Kent untrack <team_code>                — Stop tracking
@Clerk Kent tournaments                        — Show tracked tournaments
```

## Files
| File | Purpose |
|------|---------|
| `index.js` | Entry point — loads env vars, aliases, starts bot |
| `bot.js` | Discord bot — commands, pairings pipeline orchestration |
| `notion-service.js` | Notion API — judge search + data extraction |
| `email-monitor.js` | Gmail IMAP polling for Tabroom pairing emails |
| `email-parser.js` | Parses Tabroom email subject/body into structured data |
| `caselist-service.js` | OpenCaselist API — opponent school/team/rounds lookup |
| `paradigm-service.js` | Tabroom paradigm scraper (judge philosophy) |
| `llm-service.js` | OpenAI wrapper for argument + paradigm summarization |
| `channel-mapper.js` | Auto-maps team codes → Discord channels |
| `report-builder.js` | Builds rich Discord embed reports |
| `tournament-store.js` | Persists tournament tracking + session state |
| `tabroom-scraper.js` | Scrapes Tabroom pairings pages |
| `pairings-poller.js` | Legacy polling-based pairings checker |
