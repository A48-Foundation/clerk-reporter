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

  test('waits for pairing delivery before marking the email seen', async () => {
    const monitor = new EmailMonitor({ email: 'x@example.com', password: 'secret' });
    const order = [];
    monitor._search = jest.fn().mockResolvedValue([102]);
    monitor._fetchMessage = jest.fn().mockResolvedValue([
      'From: tourn@www.tabroom.com',
      'To: x@example.com',
      'Subject: [TAB] Interlake OC Round 1 CX',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Round 1 of Policy',
      'Start: 9:00 AM',
      'Room: 101',
      'Side: AFF',
      'Competitors',
      'AFF Interlake OC',
      'NEG Coppell PK',
      'Judging',
      'Test Judge',
    ].join('\r\n'));
    monitor._markSeen = jest.fn(async () => order.push('seen'));
    monitor.on('pairing', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('delivered');
    });

    await monitor.poll();

    expect(order).toEqual(['delivered', 'seen']);
  });

  test('prefers a complete HTML MIME body over a degraded plain-text body', async () => {
    const monitor = new EmailMonitor({
      email: 'x@example.com',
      password: 'secret',
      markSeen: false,
    });
    monitor._search = jest.fn().mockResolvedValue([103]);
    monitor._fetchMessage = jest.fn().mockResolvedValue([
      'From: Mid America Cup <x@www.tabroom.com>',
      'To: x@example.com',
      'Subject: [TAB] Interlake Shreshth Seth & Aanya Chetan Round 5 CX',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="test-boundary"',
      '',
      '--test-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Round 5 of CX',
      'Room: NSDA Campus Section 28',
      'Judging',
      'Hunter Harwood Hunter Harwood (He/Him)',
      '--test-boundary',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Round 5 of Policy</p>',
      '<p>Start: 8:00 CDT</p>',
      '<p>Room: NSDA Campus Section 28</p>',
      '<p>Side: NEG</p>',
      '<p>Competitors</p>',
      '<p>AFF Eagan Skye Hoover &amp; Madeline Risk</p>',
      '<p>NEG Interlake Shreshth Seth &amp; Aanya Chetan</p>',
      '<p>Judging</p>',
      '<p>Hunter Harwood (He/Him)</p>',
      '--test-boundary--',
    ].join('\r\n'));
    let pairing;
    monitor.on('pairing', async eventData => {
      pairing = eventData.parsed;
    });

    await monitor.poll();

    expect(pairing.startTime).toBe('8:00 CDT');
    expect(pairing.side).toBe('NEG');
    expect(pairing.aff.teamCode).toBe('Eagan Skye Hoover & Madeline Risk');
    expect(pairing.neg.teamCode).toBe('Interlake Shreshth Seth & Aanya Chetan');
    expect(pairing.judges).toEqual([{ name: 'Hunter Harwood', pronouns: 'He/Him' }]);
  });
});
