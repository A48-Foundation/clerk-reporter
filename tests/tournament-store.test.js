jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));
const fs = require('fs');

const TournamentStore = require('../tournament-store');

beforeEach(() => {
  jest.clearAllMocks();
  fs.existsSync.mockReturnValue(false);
});

// ── Constructor / load ──────────────────────────────────────────────

describe('constructor / load', () => {
  test('no existing file → empty tournaments, null activeSession', () => {
    const store = new TournamentStore();
    expect(store.tournaments).toEqual({});
    expect(store.activeSession).toBeNull();
  });

  test('new format file → loads tournaments and activeSession', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      tournaments: { '123': { tournId: '123', teams: [], seenRounds: [] } },
      activeSession: { tournId: '123', channelMappings: {} },
    }));

    const store = new TournamentStore();
    expect(store.tournaments).toEqual({
      '123': { tournId: '123', teams: [], seenRounds: [] },
    });
    expect(store.activeSession).toEqual({ tournId: '123', channelMappings: {} });
  });

  test('new format file with missing activeSession → defaults to null', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      tournaments: { '456': { tournId: '456', teams: [], seenRounds: [] } },
    }));

    const store = new TournamentStore();
    expect(store.tournaments).toHaveProperty('456');
    expect(store.activeSession).toBeNull();
  });

  test('legacy format (tournaments at root) → loads tournaments, null activeSession', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      '123': { tournId: '123', teams: [], seenRounds: [] },
    }));

    const store = new TournamentStore();
    expect(store.tournaments).toEqual({
      '123': { tournId: '123', teams: [], seenRounds: [] },
    });
    expect(store.activeSession).toBeNull();
  });

  test('corrupted file → falls back to empty state', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('NOT_VALID_JSON');

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const store = new TournamentStore();
    expect(store.tournaments).toEqual({});
    expect(store.activeSession).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── addTeam ─────────────────────────────────────────────────────────

describe('addTeam', () => {
  test('adds team to a new tournament and saves', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');

    expect(store.tournaments['100']).toEqual({
      tournId: '100',
      teams: [{ code: 'Okemos AT', channelId: 'ch-1' }],
      seenRounds: [],
    });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('does not add duplicate team+channel combo (case-insensitive)', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');
    store.addTeam('100', 'okemos at', 'ch-1');

    expect(store.tournaments['100'].teams).toHaveLength(1);
  });

  test('allows same team in a different channel', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');
    store.addTeam('100', 'Okemos AT', 'ch-2');

    expect(store.tournaments['100'].teams).toHaveLength(2);
  });

  test('saved JSON has the correct structure', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');

    const savedJson = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(savedJson).toEqual({
      tournaments: {
        '100': {
          tournId: '100',
          teams: [{ code: 'Okemos AT', channelId: 'ch-1' }],
          seenRounds: [],
        },
      },
      activeSession: null,
    });
  });
});

// ── removeTeam ──────────────────────────────────────────────────────

describe('removeTeam', () => {
  test('removes an existing team and returns true', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');
    store.addTeam('100', 'Interlake CG', 'ch-2');

    const result = store.removeTeam('100', 'Okemos AT');
    expect(result).toBe(true);
    expect(store.tournaments['100'].teams).toEqual([
      { code: 'Interlake CG', channelId: 'ch-2' },
    ]);
  });

  test('returns false for non-existing team', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');

    expect(store.removeTeam('100', 'Ghost Team')).toBe(false);
  });

  test('returns false for non-existing tournament', () => {
    const store = new TournamentStore();
    expect(store.removeTeam('999', 'Anything')).toBe(false);
  });

  test('removes entire tournament entry when last team is removed', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');

    store.removeTeam('100', 'Okemos AT');
    expect(store.tournaments['100']).toBeUndefined();
  });

  test('removal is case-insensitive', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');

    expect(store.removeTeam('100', 'okemos at')).toBe(true);
    expect(store.tournaments['100']).toBeUndefined();
  });
});

// ── markRoundSeen / isRoundSeen ─────────────────────────────────────

describe('markRoundSeen / isRoundSeen', () => {
  test('marked round is seen', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');
    jest.clearAllMocks();

    store.markRoundSeen('100', 'r1');
    expect(store.isRoundSeen('100', 'r1')).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('unmarked round is not seen', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');

    expect(store.isRoundSeen('100', 'r99')).toBe(false);
  });

  test('marking same round twice only saves once', () => {
    const store = new TournamentStore();
    store.addTeam('100', 'Okemos AT', 'ch-1');
    jest.clearAllMocks();

    store.markRoundSeen('100', 'r1');
    store.markRoundSeen('100', 'r1');

    expect(store.tournaments['100'].seenRounds).toEqual(['r1']);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('isRoundSeen returns false for unknown tournament', () => {
    const store = new TournamentStore();
    expect(store.isRoundSeen('unknown', 'r1')).toBe(false);
  });

  test('markRoundSeen is a no-op for unknown tournament', () => {
    const store = new TournamentStore();
    store.markRoundSeen('unknown', 'r1');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ── Active session methods ──────────────────────────────────────────

describe('active session', () => {
  test('setActiveSession stores full session object', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {
      'Interlake CG': 'ch1',
    });

    const session = store.getActiveSession();
    expect(session).toMatchObject({
      tournId: '123',
      tournamentUrl: 'https://tabroom.com/t/123',
      channelMappings: { 'Interlake CG': 'ch1' },
      emailMonitorActive: true,
      processedEmailUids: [],
    });
    expect(session.startedAt).toBeDefined();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  test('clearActiveSession sets session to null and saves', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {});
    jest.clearAllMocks();

    store.clearActiveSession();
    expect(store.getActiveSession()).toBeNull();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

    const savedJson = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(savedJson.activeSession).toBeNull();
  });

  test('getActiveSession returns null when no session set', () => {
    const store = new TournamentStore();
    expect(store.getActiveSession()).toBeNull();
  });

  test('addProcessedEmailUid tracks processed UIDs', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {});
    jest.clearAllMocks();

    store.addProcessedEmailUid(42);
    expect(store.isEmailProcessed(42)).toBe(true);
    expect(store.isEmailProcessed(99)).toBe(false);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('addProcessedEmailUid is a no-op without active session', () => {
    const store = new TournamentStore();
    store.addProcessedEmailUid(42);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('addProcessedEmailUid does not add duplicates', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {});
    jest.clearAllMocks();

    store.addProcessedEmailUid(42);
    store.addProcessedEmailUid(42);

    expect(store.activeSession.processedEmailUids).toEqual([42]);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('isEmailProcessed returns false without active session', () => {
    const store = new TournamentStore();
    expect(store.isEmailProcessed(42)).toBe(false);
  });

  test('getChannelForTeam returns mapped channel', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {
      'Interlake CG': 'ch1',
    });

    expect(store.getChannelForTeam('Interlake CG')).toBe('ch1');
  });

  test('getChannelForTeam returns null for unknown team', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {
      'Interlake CG': 'ch1',
    });

    expect(store.getChannelForTeam('Unknown')).toBeNull();
  });

  test('getChannelForTeam returns null without active session', () => {
    const store = new TournamentStore();
    expect(store.getChannelForTeam('Anything')).toBeNull();
  });

  test('updateChannelMapping updates existing mapping and saves', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {
      'Interlake CG': 'ch1',
    });
    jest.clearAllMocks();

    store.updateChannelMapping('Interlake CG', 'ch2');
    expect(store.getChannelForTeam('Interlake CG')).toBe('ch2');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  test('updateChannelMapping adds a new mapping', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {});

    store.updateChannelMapping('NewTeam', 'ch9');
    expect(store.getChannelForTeam('NewTeam')).toBe('ch9');
  });

  test('updateChannelMapping is a no-op without active session', () => {
    const store = new TournamentStore();
    store.updateChannelMapping('Team', 'ch1');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('saved JSON includes full active session', () => {
    const store = new TournamentStore();
    store.setActiveSession('123', 'https://tabroom.com/t/123', {
      'Interlake CG': 'ch1',
    });

    const savedJson = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(savedJson.activeSession).toMatchObject({
      tournId: '123',
      tournamentUrl: 'https://tabroom.com/t/123',
      channelMappings: { 'Interlake CG': 'ch1' },
      emailMonitorActive: true,
      processedEmailUids: [],
    });
  });
});
