const { EventEmitter } = require('events');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const EmailParser = require('./email-parser');

const FAST_INTERVAL = 1 * 1000;          // 1s — waiting for pairings
const SLOW_INTERVAL = 10 * 60 * 1000;   // 10min — round in progress
const RESUME_FAST_AT = 1.5 * 60 * 60 * 1000; // resume fast after 1.5h

class EmailMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.email = options.email || process.env.IMAP_EMAIL;
    this.password = options.password || process.env.IMAP_PASSWORD;
    this.maxReconnectDelay = options.maxReconnectDelay || 300000;
    this._pollTimer = null;
    this._resumeTimer = null;
    this._imap = null;
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._currentInterval = FAST_INTERVAL;
  }

  start() {
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._currentInterval = FAST_INTERVAL;
    this._connect();
  }

  /**
   * Switch to slow polling after a pairing event. Automatically resumes
   * fast polling after RESUME_FAST_AT ms.
   */
  enterSlowMode() {
    if (this._currentInterval === SLOW_INTERVAL) return;
    this._currentInterval = SLOW_INTERVAL;
    console.log(`[EmailMonitor] ⏳ Switching to slow polling (${SLOW_INTERVAL / 1000}s) — round in progress`);

    // Clear any existing resume timer
    if (this._resumeTimer) clearTimeout(this._resumeTimer);

    // Schedule return to fast polling
    this._resumeTimer = setTimeout(() => {
      this._currentInterval = FAST_INTERVAL;
      console.log(`[EmailMonitor] ⚡ Resuming fast polling (${FAST_INTERVAL / 1000}s)`);
      this._resumeTimer = null;
    }, RESUME_FAST_AT);
  }

  _connect() {
    if (this._stopped) return;

    this._imap = new Imap({
      user: this.email,
      password: this.password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true }
    });

    this._imap.once('ready', () => {
      this._reconnectAttempts = 0;
      this.emit('connected');
      this._startPolling();
    });

    this._imap.once('error', (err) => {
      console.error('[EmailMonitor] IMAP error:', err.message);
      this.emit('error', err);
      this._scheduleReconnect();
    });

    this._imap.once('end', () => {
      console.warn('[EmailMonitor] IMAP connection ended');
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this._imap.connect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._imap = null;

    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), this.maxReconnectDelay);
    console.log(`[EmailMonitor] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})...`);
    this._pollTimer = setTimeout(() => this._connect(), delay);
  }

  stop() {
    this._stopped = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
    if (this._imap) {
      this._imap.end();
      this._imap = null;
    }
  }

  _startPolling() {
    const runPoll = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.emit('error', err);
      }
      if (this._imap) {
        this._pollTimer = setTimeout(runPoll, this._currentInterval);
      }
    };
    runPoll();
  }

  async poll() {
    console.log('[EmailMonitor] Polling for new emails...');
    const uids = await this._search();
    console.log(`[EmailMonitor] Found ${uids.length} unseen email(s)${uids.length > 0 ? ': UIDs ' + uids.join(', ') : ''}`);
    for (const uid of uids) {
      try {
        const raw = await this._fetchMessage(uid);
        const parsed = await simpleParser(raw);

        const emailData = {
          subject: parsed.subject || '',
          from: parsed.from ? parsed.from.text : '',
          body: parsed.text || ''
        };

        console.log(`[EmailMonitor] Email UID ${uid}: subject="${emailData.subject}", from="${emailData.from}"`);

        if (!EmailParser.isPairingEmail(emailData)) {
          console.log(`[EmailMonitor] Email UID ${uid} skipped — not a pairing email`);
          continue;
        }

        console.log(`[EmailMonitor] Email UID ${uid} IS a pairing email — parsing...`);
        const result = EmailParser.parse(emailData);
        console.log(`[EmailMonitor] Parsed result:`, JSON.stringify(result, null, 2).slice(0, 500));
        this.emit('pairing', { uid, parsed: result, raw: emailData });
        await this._markSeen(uid);
      } catch (err) {
        console.error(`[EmailMonitor] Error processing UID ${uid}:`, err.message);
        this.emit('error', err);
      }
    }
  }

  _search() {
    return new Promise((resolve, reject) => {
      this._imap.openBox('INBOX', false, (err) => {
        if (err) return reject(err);
        // Search for unseen emails that are either from Tabroom OR have [TAB] in the subject
        const criteria = ['UNSEEN', ['OR', ['FROM', '@www.tabroom.com'], ['SUBJECT', '[TAB]']]];
        this._imap.search(criteria, (err, results) => {
          if (err) return reject(err);
          resolve(results || []);
        });
      });
    });
  }

  _fetchMessage(uid) {
    return new Promise((resolve, reject) => {
      const fetch = this._imap.fetch(uid, { bodies: '' });
      let buffer = '';

      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
          });
        });
      });

      fetch.once('error', reject);
      fetch.once('end', () => resolve(buffer));
    });
  }

  _markSeen(uid) {
    return new Promise((resolve, reject) => {
      this._imap.addFlags(uid, ['\\Seen'], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

module.exports = EmailMonitor;
