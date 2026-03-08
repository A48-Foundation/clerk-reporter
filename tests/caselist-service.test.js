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

  describe('_parseEntryNames', () => {
    test('parses "A & B" format', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('Levine & Zhang');
      expect(result).toEqual(['levine', 'zhang']);
    });

    test('parses "A, B" format', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('Chen, Olteanu');
      expect(result).toEqual(['chen', 'olteanu']);
    });

    test('parses "A and B" format (case insensitive)', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('Smith and Jones');
      expect(result).toEqual(['smith', 'jones']);
    });

    test('parses "A AND B" format (uppercase)', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('Brown AND Green');
      expect(result).toEqual(['brown', 'green']);
    });

    test('handles extra whitespace around separators', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('Lee  &  Park');
      expect(result).toEqual(['lee', 'park']);
    });

    test('returns empty array for null input', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames(null);
      expect(result).toEqual([]);
    });

    test('returns empty array for empty string', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('');
      expect(result).toEqual([]);
    });

    test('handles undefined input', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames(undefined);
      expect(result).toEqual([]);
    });

    test('handles three-person entry', () => {
      const service = new CaselistService();
      const result = service._parseEntryNames('Anderson & Brown & Carter');
      expect(result).toEqual(['anderson', 'brown', 'carter']);
    });
  });

  describe('findTeamByEntry', () => {
    test('matches team by debater last names', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'levine_zhang', debater1_last: 'Levine', debater2_last: 'Zhang', display_name: 'Levine & Zhang' },
            { name: 'smith_jones', debater1_last: 'Smith', debater2_last: 'Jones', display_name: 'Smith & Jones' },
          ]),
      });

      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', 'Levine & Zhang', 'LZ');
      expect(result).not.toBeNull();
      expect(result.name).toBe('levine_zhang');
      expect(result.debater1_last).toBe('Levine');
      expect(result.debater2_last).toBe('Zhang');
    });

    test('matches team by slug derived from last names', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'lezh', debater1_last: 'Levine', debater2_last: 'Zhang', display_name: 'Levine & Zhang' },
            { name: 'smjo', debater1_last: 'Smith', debater2_last: 'Jones', display_name: 'Smith & Jones' },
          ]),
      });

      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', 'Levine & Zhang', 'LZ');
      expect(result).not.toBeNull();
      expect(result.name).toBe('lezh');
    });

    test('matches team by team suffix initials (fallback)', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'team1', debater1_last: 'Doe', debater2_last: 'Smith', display_name: 'School DS' },
            { name: 'team2', debater1_last: 'Lee', debater2_last: 'Zhang', display_name: 'School LZ' },
          ]),
      });

      // No entry names provided, should fall back to suffix matching
      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', null, 'LZ');
      expect(result).not.toBeNull();
      expect(result.name).toBe('team2');
    });

    test('matches team by suffix initials reverse order', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'team1', debater1_last: 'Zhang', debater2_last: 'Lee', display_name: 'School ZL' },
          ]),
      });

      // Suffix "LZ" should match debater1_last starting with L and debater2_last starting with Z, or vice versa
      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', null, 'ZL');
      expect(result).not.toBeNull();
      expect(result.name).toBe('team1');
    });

    test('returns null when no team matches', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'team1', debater1_last: 'Anderson', debater2_last: 'Brown', display_name: 'School AB' },
          ]),
      });

      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', 'Levine & Zhang', 'LZ');
      expect(result).toBeNull();
    });

    test('returns null when teams array is empty', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', 'Levine & Zhang', 'LZ');
      expect(result).toBeNull();
    });

    test('handles partial name matching', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'lev_zhang', debater1_last: 'Levinson', debater2_last: 'Zhang', display_name: 'Levinson & Zhang' },
          ]),
      });

      // "Lev" should match "Levinson" (prefix match)
      const result = await service.findTeamByEntry('hspolicy25', 'IsidoreNewman', 'Lev & Zhang', 'LZ');
      expect(result).not.toBeNull();
      expect(result.name).toBe('lev_zhang');
    });
  });

  describe('lookupOpponent - team code parsing', () => {
    test('"Isidore Newman AW" with entry names parses school and finds team', async () => {
      const service = new CaselistService();

      // Login
      mockLogin();
      // findSchool
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'IsidoreNewman', displayName: 'Isidore Newman' }]),
      });
      // _getTeams (for findTeamByEntry)
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              name: 'levine_zhang',
              debater1_last: 'Levine',
              debater2_last: 'Zhang',
              display_name: 'Levine & Zhang',
            },
          ]),
      });
      // getTeamRounds
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ tournament: 'Stanford', round: 'R1', side: 'A', report: '1AC heg' }]),
      });

      const result = await service.lookupOpponent('Isidore Newman AW', 'A', 'Levine & Zhang');
      expect(result).not.toBeNull();
      expect(result.schoolName).toBe('Isidore Newman');
      expect(result.teamCode).toBe('AW');
      expect(result.teamSlug).toBe('levine_zhang');
      expect(result.rounds).toHaveLength(1);
    });

    test('"Coppell PK" without entry names still works', async () => {
      const service = new CaselistService();

      mockLogin();
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'Coppell', displayName: 'Coppell' }]),
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ name: 'team_pk', debater1_last: 'Paul', debater2_last: 'Knight', display_name: 'Paul & Knight' }]),
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
          Promise.resolve([{ name: 'team_ls', debater1_last: 'Lee', debater2_last: 'Smith', display_name: 'Lee & Smith' }]),
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
    test('builds correct OpenCaselist URL without side', () => {
      const service = new CaselistService();
      const url = service.getWikiUrl('hspolicy25', 'IsidoreNewman', 'IsidoreNewmanAW');
      expect(url).toBe('https://opencaselist.com/hspolicy25/IsidoreNewman/IsidoreNewmanAW');
    });

    test('appends /Aff when side is "A"', () => {
      const service = new CaselistService();
      const url = service.getWikiUrl('hspolicy25', 'IsidoreNewman', 'IsidoreNewmanAW', 'A');
      expect(url).toBe('https://opencaselist.com/hspolicy25/IsidoreNewman/IsidoreNewmanAW/Aff');
    });

    test('appends /Neg when side is "N"', () => {
      const service = new CaselistService();
      const url = service.getWikiUrl('hspolicy25', 'IsidoreNewman', 'IsidoreNewmanAW', 'N');
      expect(url).toBe('https://opencaselist.com/hspolicy25/IsidoreNewman/IsidoreNewmanAW/Neg');
    });

    test('ignores side if not "A" or "N"', () => {
      const service = new CaselistService();
      const url = service.getWikiUrl('hspolicy25', 'IsidoreNewman', 'IsidoreNewmanAW', 'X');
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

    test('caches schools across multiple calls', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'Greenhill', displayName: 'Greenhill' },
            { name: 'GreenBay', displayName: 'Green Bay' },
          ]),
      });

      // First call - fetches from API
      await service.findSchool('hspolicy25', 'Greenhill');
      // Second call - should use cache, no additional fetch
      await service.findSchool('hspolicy25', 'GreenBay');

      // Should only have made one fetch call
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('_getTeams caching', () => {
    test('caches teams for a school', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'team1', debater1_last: 'Smith', debater2_last: 'Jones' },
            { name: 'team2', debater1_last: 'Brown', debater2_last: 'Green' },
          ]),
      });

      // First call - fetches from API
      await service._getTeams('hspolicy25', 'IsidoreNewman');
      // Second call - should use cache, no additional fetch
      await service._getTeams('hspolicy25', 'IsidoreNewman');

      // Should only have made one fetch call
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('maintains separate cache for different caselist slugs', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=abc123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'team1' }]),
      });

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'team2' }]),
      });

      // Different caselists should fetch separately
      await service._getTeams('hspolicy25', 'IsidoreNewman');
      await service._getTeams('hsdebate26', 'IsidoreNewman');

      // Should have made two fetch calls
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('auto-login on _get', () => {
    test('calls login automatically if no cookie exists', async () => {
      const service = new CaselistService();
      // No cookie set initially
      expect(service.cookie).toBeNull();

      mockLogin();
      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'school1' }]),
      });

      // _getSchools internally calls _get, which should auto-login
      await service.findSchool('hspolicy25', 'test');

      // First fetch is login, second is the actual request
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(service.cookie).not.toBeNull();
    });

    test('does not re-login if cookie already exists', async () => {
      const service = new CaselistService();
      service.cookie = 'caselist_token=existing123';

      fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: 'school1' }]),
      });

      await service.findSchool('hspolicy25', 'test');

      // Only one fetch call (the actual request, no login)
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
