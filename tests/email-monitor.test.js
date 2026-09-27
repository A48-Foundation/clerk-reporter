const EmailMonitor = require('../email-monitor');

describe('EmailMonitor test isolation options', () => {
  test('uses production UNSEEN/Tabroom search and marks messages seen by default', () => {
    const monitor = new EmailMonitor({ email: 'x@example.com', password: 'secret' });

    expect(monitor.searchCriteria).toEqual([
      'UNSEEN',
      ['OR', ['FROM', '@www.tabroom.com'], ['SUBJECT', '[TAB]']],
    ]);
    expect(monitor.markSeen).toBe(true);
    expect(monitor.allowE2E).toBe(false);
  });

  test('accepts an isolated IMAP criterion without marking messages seen', async () => {
    const criteria = [['TO', 'clerk+e2e@example.com']];
    const monitor = new EmailMonitor({
      email: 'x@example.com',
      password: 'secret',
      searchCriteria: criteria,
      markSeen: false,
      allowE2E: true,
      pollInterval: 3000,
    });
    monitor._imap = {
      search: jest.fn((actual, callback) => callback(null, [101, 102])),
    };

    await expect(monitor._search()).resolves.toEqual([101, 102]);
    expect(monitor._imap.search).toHaveBeenCalledWith(criteria, expect.any(Function));
    expect(monitor.markSeen).toBe(false);
    expect(monitor.allowE2E).toBe(true);
    expect(monitor.fastInterval).toBe(3000);
  });

  test('production monitor discards E2E-tagged messages before parsing', async () => {
    const monitor = new EmailMonitor({ email: 'x@example.com', password: 'secret' });
    monitor._search = jest.fn().mockResolvedValue([101]);
    monitor._fetchMessage = jest.fn().mockResolvedValue([
      'From: x@example.com',
      'To: x@example.com',
      'Subject: [TAB] Interlake CH Round 1 CX',
      'X-Clerk-E2E-Run: test-run',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Round 1 of Policy',
      'Competitors',
      'AFF Interlake CH',
      'NEG Coppell PK',
      'Judging',
      'Test Judge',
    ].join('\r\n'));
    monitor._markSeen = jest.fn().mockResolvedValue();
    const pairing = jest.fn();
    monitor.on('pairing', pairing);

    await monitor.poll();

    expect(pairing).not.toHaveBeenCalled();
    expect(monitor._markSeen).toHaveBeenCalledWith(101);
  });
});
