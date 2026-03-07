jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');

const CaselistService = require('../caselist-service');

describe('CaselistService', () => {
  let originalEmail;
  let originalPassword;

  beforeEach(() => {
    originalEmail = process.env.TABROOM_EMAIL;
    originalPassword = process.env.TABROOM_PASSWORD;
    process.env.TABROOM_EMAIL = 'test@example.com';
    process.env.TABROOM_PASSWORD = 'testpass';
    fetch.mockReset();
  });

  afterEach(() => {
    if (originalEmail !== undefined) {
      process.env.TABROOM_EMAIL = originalEmail;
    } else {
      delete process.env.TABROOM_EMAIL;
    }
    if (originalPassword !== undefined) {
      process.env.TABROOM_PASSWORD = originalPassword;
    } else {
      delete process.env.TABROOM_PASSWORD;
    }
  });

  /** Helper: mock the login fetch call. */
  function mockLogin() {
    fetch.mockResolvedValueOnce({
      headers: { raw: () => ({ 'set-cookie': ['caselist_token=abc123; Path=/'] }) },
    });
  }

  describe('lookupOpponent - team code parsing', () => {
    test('"Isidore Newman AW" parses school as "Isidore Newman"', async () => {
      const service = new CaselistService();

      // Login
      mockLogin();
      // findSchool
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'IsidoreNewman', displayName: 'Isidore Newman' }]),
      });
      // findTeam
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'IsidoreNewmanAW', display_name: 'Isidore Newman AW' }]),
      });
      // getTeamRounds
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ tournament: 'Stanford', round: 'R1', side: 'A', report: '1AC heg' }]),
      });

      const result = await service.lookupOpponent('Isidore Newman AW', 'A');
      expect(result).not.toBeNull();
      expect(result.schoolName).toBe('Isidore Newman');
      expect(result.teamCode).toBe('AW');
      expect(result.rounds).toHaveLength(1);
    });

    test('"Coppell PK" parses school as "Coppell"', async () => {
      const service = new CaselistService();

      mockLogin();
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'Coppell', displayName: 'Coppell' }]),
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'CoppellPK', display_name: 'Coppell PK' }]),
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await service.lookupOpponent('Coppell PK', 'N');
      expect(result).not.toBeNull();
      expect(result.schoolName).toBe('Coppell');
      expect(result.teamCode).toBe('PK');
    });

    test('"Arizona Chandler Independent LS" parses school as "Arizona Chandler Independent"', async () => {
      const service = new CaselistService();

      mockLogin();
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ name: 'ArizonaChandlerIndependent', displayName: 'Arizona Chandler Independent' }]),
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ name: 'ArizonaChandlerIndependentLS', display_name: 'Arizona Chandler Independent LS' }]),
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await service.lookupOpponent('Arizona Chandler Independent LS', 'A');
      expect(result).not.toBeNull();
      expect(result.schoolName).toBe('Arizona Chandler Independent');
      expect(result.teamCode).toBe('LS');
    });

    test('single word team code returns null', async () => {
      const service = new CaselistService();

      const result = await service.lookupOpponent('Coppell', 'A');
      expect(result).toBeNull();
    });
  });

  describe('getWikiUrl', () => {
    test('builds correct OpenCaselist URL', () => {
      const service = new CaselistService();
      const url = service.getWikiUrl('hspolicy25', 'IsidoreNewman', 'IsidoreNewmanAW');
      expect(url).toBe('https://opencaselist.com/hspolicy25/IsidoreNewman/IsidoreNewmanAW');
    });
  });

  describe('findSchool - fuzzy matching', () => {
    test('returns exact match when displayName matches', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'Greenhill', displayName: 'Greenhill' },
            { name: 'GreenBay', displayName: 'Green Bay' },
            { name: 'Georgetown', displayName: 'Georgetown' },
          ]),
      });

      const result = await service.findSchool('hspolicy25', 'Greenhill');
      expect(result).toBe('Greenhill');
    });

    test('returns fuzzy match when no exact match exists', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'IsidoreNewman', displayName: 'Isidore Newman' },
            { name: 'NewTrier', displayName: 'New Trier' },
            { name: 'Niles', displayName: 'Niles' },
          ]),
      });

      // Slight misspelling should still fuzzy-match
      const result = await service.findSchool('hspolicy25', 'Isidore Newmn');
      expect(result).toBe('IsidoreNewman');
    });
  });
});
