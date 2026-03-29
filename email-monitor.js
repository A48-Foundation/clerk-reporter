const { EventEmitter } = require('events');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const EmailParser = require('./email-parser');

const FAST_INTERVAL = 15 * 1000;         // 15s — waiting for pairings
const SLOW_INTERVAL = 10 * 60 * 1000;    // 10min — round in progress
const RESUME_FAST_AT = 1.5 * 60 * 60 * 1000; // resume fast after 1.5h
const OP_TIMEOUT = 30 * 1000;            // 30s timeout per IMAP operation
const WATCHDOG_INTERVAL = 5 * 60 * 1000; // check every 5min
const WATCHDOG_STALE = 5 * 60 * 1000;    // force reconnect if no poll in 5min

class EmailMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.email = options.email || process.env.IMAP_EMAIL;
    this.password = options.password || process.env.IMAP_PASSWORD;
    this.maxReconnectDelay = options.maxReconnectDelay || 300000;
    this._pollTimer = null;
    this._resumeTimer = null;
    this._watchdogTimer = null;
    this._imap = null;
    this._inboxOpen = false;
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._currentInterval = FAST_INTERVAL;
    this._lastSuccessfulPoll = null;
  }

  start() {
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._currentInterval = FAST_INTERVAL;
    this._connect();
    this._startWatchdog();
  }

  /**
   * Switch to slow polling after a pairing event. Automatically resumes
   * fast polling after RESUME_FAST_AT ms.
   */
  enterSlowMode() {
    if (this._currentInterval === SLOW_INTERVAL) return;
    this._currentInterval = SLOW_INTERVAL;
    console.log(`[EmailMonitor] ⏳ Switching to slow polling (${SLOW_INTERVAL / 1000}s) — round in progress`);

    if (this._resumeTimer) clearTimeout(this._resumeTimer);

    this._resumeTimer = setTimeout(() => {
      this._currentInterval = FAST_INTERVAL;
      console.log(`[EmailMonitor] ⚡ Resuming fast polling (${FAST_INTERVAL / 1000}s)`);
      this._resumeTimer = null;
    }, RESUME_FAST_AT);
  }

  _connect() {
    if (this._stopped) return;

    // Tear down any lingering connection before creating a new one
    this._destroyConnection();

    const imap = new Imap({
      user: this.email,
      password: this.password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true }
    });

    this._imap = imap;
    this._reconnecting = false;

    imap.once('ready', () => {
      if (this._imap !== imap) return; // stale connection, ignore
      this._reconnectAttempts = 0;
      this._inboxOpen = false;
      this.emit('connected');
      this._openInboxThenPoll();
    });

    imap.once('error', (err) => {
      console.error('[EmailMonitor] IMAP error:', err.message);
      this.emit('error', err);
      this._handleDisconnect(imap);
    });

    imap.once('end', () => {
      console.warn('[EmailMonitor] IMAP connection ended');
      this.emit('disconnected');
      this._handleDisconnect(imap);
    });

    imap.connect();
  }

  /** Safely destroy the current IMAP connection so the server releases the slot. */
  _destroyConnection() {
    if (!this._imap) return;
    try { this._imap.destroy(); } catch (_) { /* ignore */ }
    this._imap = null;
    this._inboxOpen = false;
  }

  /**
   * Unified handler for both 'error' and 'end' events.
   * Deduplicates so only the first of the two triggers a reconnect,
   * and ignores events from stale (replaced) connections.
   */
  _handleDisconnect(imap) {
    if (this._imap !== imap) return;   // event from a stale connection
    if (this._reconnecting) return;    // already handling this disconnect
    this._reconnecting = true;
    this._scheduleReconnect();
  }

  /** Open INBOX once, then start the poll loop. */
  _openInboxThenPoll() {
    this._imap.openBox('INBOX', false, (err) => {
      if (err) {
        console.error('[EmailMonitor] Failed to open INBOX:', err.message);
        this._scheduleReconnect();
        return;
      }
      this._inboxOpen = true;
      console.log('[EmailMonitor] INBOX opened');
      this._startPolling();
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._destroyConnection();

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
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._imap) {
      this._imap.end();
      this._imap = null;
    }
    this._inboxOpen = false;
  }

  /** Watchdog: force reconnect if polling has stalled. */
  _startWatchdog() {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(() => {
      if (this._stopped || !this._lastSuccessfulPoll) return;
      const staleSince = Date.now() - this._lastSuccessfulPoll;
      if (staleSince > WATCHDOG_STALE) {
        console.warn(`[EmailMonitor] 🐕 Watchdog: no successful poll in ${Math.round(staleSince / 1000)}s — forcing reconnect`);
        this._forceReconnect();
      }
    }, WATCHDOG_INTERVAL);
  }

  /** Tear down current connection and reconnect immediately. */
  _forceReconnect() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._destroyConnection();
    this._reconnectAttempts = 0;
    this._connect();
  }

  _startPolling() {
    const runPoll = async () => {
      try {
        await this._timedPoll();
        this._lastSuccessfulPoll = Date.now();
      } catch (err) {
        console.error('[EmailMonitor] Poll failed:', err.message);
        this.emit('error', err);
        // If the error indicates the connection is dead, reconnect
        if (!this._imap || err.message.includes('timeout')) {
          this._scheduleReconnect();
          return;
        }
      }
      if (this._imap && !this._stopped) {
        this._pollTimer = setTimeout(runPoll, this._currentInterval);
      }
    };
    runPoll();
  }

  /** Run poll() with a timeout to prevent hangs on dead connections. */
  _timedPoll() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Poll operation timeout — IMAP may be hung'));
      }, OP_TIMEOUT);

      this.poll()
        .then((v) => { clearTimeout(timer); resolve(v); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  async poll() {
    const uids = await this._search();
    if (uids.length > 0) {
      console.log(`[EmailMonitor] Found ${uids.length} unseen email(s): UIDs ${uids.join(', ')}`);
    }
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
      if (!this._imap) return reject(new Error('No IMAP connection'));
      const criteria = ['UNSEEN', ['OR', ['FROM', '@www.tabroom.com'], ['SUBJECT', '[TAB]']]];
      this._imap.search(criteria, (err, results) => {
        if (err) return reject(err);
        resolve(results || []);
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
