require('dotenv').config();
const ClerkKentBot = require('./bot');

// Alias .env names so existing services (notion-service.js, bot.js) work unchanged
process.env.NOTION_TOKEN = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
process.env.JUDGE_DATABASE_ID = process.env.JUDGE_DATABASE_ID || process.env.NOTION_DATABASE_ID;
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;

// Validate required environment variables
const required = ['NOTION_TOKEN', 'JUDGE_DATABASE_ID', 'DISCORD_TOKEN'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Warn about optional vars needed for the pairings pipeline
if (!process.env.IMAP_EMAIL) {
  console.warn('⚠️  IMAP_EMAIL not set — email-based pairings pipeline will be unavailable.');
}

const bot = new ClerkKentBot();
bot.start().catch(err => {
  console.error('❌ Failed to start Clerk Kent:', err);
  process.exit(1);
});
