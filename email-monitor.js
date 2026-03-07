const { EventEmitter } = require('events');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const EmailParser = require('./email-parser');

class EmailMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.email = options.email || process.env.IMAP_EMAIL;
    this.password = options.password || process.env.IMAP_PASSWORD;
    this.pollInterval = options.pollInterval || 30000;
    this._pollTimer = null;
    this._imap = null;
  }

  start() {
    this._imap = new Imap({
      user: this.email,
      password: this.password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    this._imap.once('ready', () => {
      this.emit('connected');
      this._startPolling();
    });

    this._imap.once('error', (err) => {
      this.emit('error', err);
    });

    this._imap.once('end', () => {
      this.emit('disconnected');
    });

    this._imap.connect();
  }

  stop() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
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
        this._pollTimer = setTimeout(runPoll, this.pollInterval);
      }
    };
    runPoll();
  }

  async poll() {
    const uids = await this._search();
    for (const uid of uids) {
      try {
        const raw = await this._fetchMessage(uid);
        const parsed = await simpleParser(raw);

        const emailData = {
          subject: parsed.subject || '',
          from: parsed.from ? parsed.from.text : '',
          body: parsed.text || ''
        };

        if (!EmailParser.isPairingEmail(emailData)) {
          continue;
        }

        const result = EmailParser.parse(emailData);
        this.emit('pairing', { uid, parsed: result, raw: emailData });
        await this._markSeen(uid);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  _search() {
    return new Promise((resolve, reject) => {
      this._imap.openBox('INBOX', false, (err) => {
        if (err) return reject(err);
        const criteria = ['UNSEEN', ['FROM', '@www.tabroom.com']];
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
