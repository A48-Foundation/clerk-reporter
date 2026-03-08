const ChannelMapper = require('../channel-mapper');

function createMockClient(channels = []) {
  const channelCollection = {
    find: (fn) => channels.find(fn),
  };

  const guild = {
    channels: {
      cache: channelCollection,
      fetch: jest.fn().mockResolvedValue(channelCollection),
    },
  };
  const guildsCache = new Map([['guild1', guild]]);

  return { guilds: { cache: guildsCache } };
}

describe('ChannelMapper', () => {
  describe('extractTeamSuffix', () => {
    const mapper = new ChannelMapper(createMockClient());

    test('extracts last word from two-word code', () => {
      expect(mapper.extractTeamSuffix('Interlake CG')).toBe('CG');
    });

    test('extracts last word from three-word code', () => {
      expect(mapper.extractTeamSuffix('Cuttlefish independent WS')).toBe('WS');
    });

    test('extracts last word from multi-word code', () => {
      expect(mapper.extractTeamSuffix('Arizona Chandler Independent LS')).toBe('LS');
    });

    test('returns null for single-word code', () => {
      expect(mapper.extractTeamSuffix('SingleWord')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(mapper.extractTeamSuffix('')).toBeNull();
    });

    test('returns null for null input', () => {
      expect(mapper.extractTeamSuffix(null)).toBeNull();
    });

    test('returns null for undefined input', () => {
      expect(mapper.extractTeamSuffix(undefined)).toBeNull();
    });
  });

  describe('findChannel', () => {
    test('finds channel matching suffix-tournaments pattern', async () => {
      const channels = [
        { id: 'ch1', name: 'cg-tournaments' },
        { id: 'ch2', name: 'general' },
      ];
      const mapper = new ChannelMapper(createMockClient(channels));

      const result = await mapper.findChannel('CG');
      expect(result).toEqual({ id: 'ch1', name: 'cg-tournaments' });
    });

    test('returns null when no channel matches', async () => {
      const channels = [{ id: 'ch1', name: 'cg-tournaments' }];
      const mapper = new ChannelMapper(createMockClient(channels));

      expect(await mapper.findChannel('WS')).toBeNull();
    });

    test('returns null for null suffix', async () => {
      const mapper = new ChannelMapper(createMockClient());
      expect(await mapper.findChannel(null)).toBeNull();
    });

    test('matches case-insensitively', async () => {
      const channels = [{ id: 'ch1', name: 'cg-tournaments' }];
      const mapper = new ChannelMapper(createMockClient(channels));

      const result = await mapper.findChannel('Cg');
      expect(result).toEqual({ id: 'ch1', name: 'cg-tournaments' });
    });
  });

  describe('autoMap', () => {
    test('maps matching and non-matching team codes correctly', async () => {
      const channels = [{ id: 'ch1', name: 'cg-tournaments' }];
      const mapper = new ChannelMapper(createMockClient(channels));

      const result = await mapper.autoMap(['Interlake CG', 'Cuttlefish WS']);
      expect(result).toEqual({
        'Interlake CG': { channelId: 'ch1', channelName: 'cg-tournaments', confidence: 'auto' },
        'Cuttlefish WS': { channelId: null, channelName: null, confidence: 'unmatched' },
      });
    });

    test('returns empty object for empty array', async () => {
      const mapper = new ChannelMapper(createMockClient());
      expect(await mapper.autoMap([])).toEqual({});
    });

    test('returns empty object for non-array input', async () => {
      const mapper = new ChannelMapper(createMockClient());
      expect(await mapper.autoMap('not-an-array')).toEqual({});
      expect(await mapper.autoMap(null)).toEqual({});
      expect(await mapper.autoMap(undefined)).toEqual({});
    });
  });
});
