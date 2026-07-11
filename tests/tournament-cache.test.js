const fs = require('fs');
const os = require('os');
const path = require('path');
const TournamentCache = require('../tournament-cache');

describe('TournamentCache', () => {
  let dir;
  let cache;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcache-'));
    cache = new TournamentCache(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('normalizeName', () => {
    test('is order- and format-insensitive', () => {
      const a = TournamentCache.normalizeName('Miriam Mokhemar');
      expect(TournamentCache.normalizeName('Mokhemar, Miriam')).toBe(a);
      expect(TournamentCache.normalizeName('mokhemar miriam')).toBe(a);
    });

    test('strips punctuation and extra whitespace', () => {
      expect(TournamentCache.normalizeName("  O'Brien,  Sean-Paul ")).toBe(
        TournamentCache.normalizeName('Sean Paul O Brien')
      );
    });

    test('empty input returns empty string', () => {
      expect(TournamentCache.normalizeName('')).toBe('');
      expect(TournamentCache.normalizeName(null)).toBe('');
    });
  });

  describe('opponents cache', () => {
    test('hasOpponents is false before priming', () => {
      expect(cache.hasOpponents('123')).toBe(false);
      expect(cache.getOpponent('123', 'Interlake CG', 'A')).toBeUndefined();
    });

    test('saves and reads back per team + side', () => {
      const affResult = { schoolName: 'Interlake', rounds: [{ round: '1' }] };
      cache.saveOpponents('123', { tournamentName: 'Test' }, {
        'interlake cg': { A: affResult, N: null },
      });

      expect(cache.hasOpponents('123')).toBe(true);
      // team code lookup is case-insensitive
      expect(cache.getOpponent('123', 'Interlake CG', 'A')).toEqual(affResult);
      // cached-but-empty (null) is distinct from a miss (undefined)
      expect(cache.getOpponent('123', 'Interlake CG', 'N')).toBeNull();
      // team not primed at all → undefined (caller falls back to live)
      expect(cache.getOpponent('123', 'Someone Else XY', 'A')).toBeUndefined();
    });

    test('persists to disk and is readable by a fresh instance', () => {
      cache.saveOpponents('99', {}, { 'a b': { A: { rounds: [] }, N: null } });
      const fresh = new TournamentCache(dir);
      expect(fresh.hasOpponents('99')).toBe(true);
      expect(fresh.getOpponent('99', 'A B', 'A')).toEqual({ rounds: [] });
    });
  });

  describe('paradigms cache', () => {
    test('hasParadigms is false before priming', () => {
      expect(cache.hasParadigms('123')).toBe(false);
      expect(cache.getParadigm('123', 'Jane Doe')).toBeUndefined();
    });

    test('saves and reads back by normalized judge name', () => {
      const paradigm = { name: 'Jane Doe', philosophy: 'tech > truth' };
      cache.saveParadigms('123', {
        [TournamentCache.normalizeName('Jane Doe')]: paradigm,
        [TournamentCache.normalizeName('John Smith')]: null,
      });

      expect(cache.hasParadigms('123')).toBe(true);
      // different formatting of the same name still hits
      expect(cache.getParadigm('123', 'Doe, Jane')).toEqual(paradigm);
      // cached-but-empty (null) vs miss (undefined)
      expect(cache.getParadigm('123', 'John Smith')).toBeNull();
      expect(cache.getParadigm('123', 'Nobody Here')).toBeUndefined();
    });
  });
});
