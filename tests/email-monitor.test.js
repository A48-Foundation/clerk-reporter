const EmailMonitor = require('../email-monitor');

describe('EmailMonitor test isolation options', () => {
  test('uses production UNSEEN/Tabroom search and marks messages seen by default', () => {
    const monitor = new EmailMonitor({ email: 'x@example.com', password: 'secret' });

    expect(monitor.searchCriteria).toEqual([
      'UNSEEN',
      ['OR', ['FROM', '@www.tabroom.com'], ['SUBJECT', '[TAB]']],
    ]);
    expect(monitor.markSeen).toBe(true);
  });

  test('accepts an isolated IMAP criterion without marking messages seen', async () => {
    const criteria = [['TO', 'clerk+e2e@example.com']];
    const monitor = new EmailMonitor({
      email: 'x@example.com',
      password: 'secret',
      searchCriteria: criteria,
      markSeen: false,
      pollInterval: 3000,
    });
    monitor._imap = {
      search: jest.fn((actual, callback) => callback(null, [101, 102])),
    };

    await expect(monitor._search()).resolves.toEqual([101, 102]);
    expect(monitor._imap.search).toHaveBeenCalledWith(criteria, expect.any(Function));
    expect(monitor.markSeen).toBe(false);
    expect(monitor.fastInterval).toBe(3000);
  });
});
