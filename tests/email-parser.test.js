const EmailParser = require('../email-parser');
const fixtures = require('./fixtures/emails');

// ─── parseSubject ────────────────────────────────────────────────

describe('parseSubject', () => {
  describe('Format A (liveUpdate) subjects', () => {
    test('parses Stanford round subject', () => {
      const result = EmailParser.parseSubject(fixtures.formatA_stanford.input.subject);
      expect(result).toEqual(fixtures.formatA_stanford.expectedSubject);
    });

    test('parses multiple-judges round subject', () => {
      const result = EmailParser.parseSubject(fixtures.formatA_multipleJudges.input.subject);
      expect(result).toEqual({
        teamCode: 'Cuttlefish CG',
        roundNumber: 2,
        event: 'CX-O',
        format: 'liveUpdate',
        school: null,
      });
    });

    test('parses DSDS round subject', () => {
      const result = EmailParser.parseSubject(fixtures.formatA_dsds.input.subject);
      expect(result).toEqual({
        teamCode: 'Cuttlefish independent CG',
        roundNumber: 5,
        event: 'CX-O',
        format: 'liveUpdate',
        school: null,
      });
    });

    test('parses elim round subject (Doubles)', () => {
      const result = EmailParser.parseSubject(fixtures.formatA_flip.input.subject);
      expect(result).toEqual(fixtures.formatA_flip.expectedSubject);
    });
  });

  describe('Format B (assignments) subjects', () => {
    test('parses Westchester assignments subject', () => {
      const result = EmailParser.parseSubject(fixtures.formatB_westchester.input.subject);
      expect(result).toEqual(fixtures.formatB_westchester.expectedSubject);
    });

    test('parses multiple-entries assignments subject', () => {
      const result = EmailParser.parseSubject(fixtures.formatB_multipleEntries.input.subject);
      expect(result).toEqual({
        teamCode: null,
        roundNumber: null,
        event: null,
        format: 'assignments',
        school: 'Interlake',
      });
    });
  });

  describe('null and invalid input', () => {
    test('returns null for null input', () => {
      expect(EmailParser.parseSubject(null)).toBeNull();
    });

    test('returns null for undefined input', () => {
      expect(EmailParser.parseSubject(undefined)).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(EmailParser.parseSubject('')).toBeNull();
    });

    test('returns null for non-string input', () => {
      expect(EmailParser.parseSubject(42)).toBeNull();
    });

    test('returns null for non-TAB subject', () => {
      expect(EmailParser.parseSubject('Hello from your mom')).toBeNull();
    });

    test('returns null for edge case with empty subject', () => {
      const result = EmailParser.parseSubject(fixtures.edgeCase_noSubject.input.subject);
      expect(result).toEqual(fixtures.edgeCase_noSubject.expectedSubject);
    });
  });
});

// ─── parseBody ───────────────────────────────────────────────────

describe('parseBody', () => {
  describe('Format A (liveUpdate) bodies', () => {
    test('parses Stanford body with pronouns on separate line', () => {
      const result = EmailParser.parseBody(fixtures.formatA_stanford.input.body);
      expect(result.roundTitle).toBe('Round 4 of Policy - TOC');
      expect(result.startTime).toBe('5:30 PST');
      expect(result.room).toBe('NSDA Campus Section 18');
      expect(result.side).toBe('AFF');
      expect(result.competitors.aff.teamCode).toBe('Interlake OC');
      expect(result.competitors.neg.teamCode).toBe('Arizona Chandler Independent LS');
      expect(result.judges).toEqual([{ name: 'Evan Alexis', pronouns: 'He/Him' }]);
    });

    test('parses body with multiple judges (2 with pronouns, 1 without)', () => {
      const result = EmailParser.parseBody(fixtures.formatA_multipleJudges.input.body);
      expect(result.judges).toHaveLength(3);
      expect(result.judges[0]).toEqual({ name: 'Jane Doe', pronouns: 'she/her' });
      expect(result.judges[1]).toEqual({ name: 'John Smith', pronouns: 'he/him' });
      expect(result.judges[2]).toEqual({ name: 'Alex Kim', pronouns: null });
    });

    test('parses body with indented names (older format)', () => {
      const result = EmailParser.parseBody(fixtures.formatA_indentedNames.input.body);
      expect(result.competitors.aff.teamCode).toBe('Isidore Newman AW');
      expect(result.competitors.aff.names).toEqual([
        { name: 'Alex', pronouns: 'he/him' },
        { name: 'Will', pronouns: 'he/him' },
      ]);
      expect(result.competitors.neg.names).toEqual([
        { name: 'Sara', pronouns: 'she/her' },
        { name: 'Wei', pronouns: 'she/her' },
      ]);
      expect(result.judges).toEqual([{ name: 'Jenny Liu', pronouns: 'she/her' }]);
    });

    test('parses DSDS body with comma in judge name and no debater names', () => {
      const result = EmailParser.parseBody(fixtures.formatA_dsds.input.body);
      expect(result.competitors.aff.names).toEqual([]);
      expect(result.competitors.neg.names).toEqual([]);
      expect(result.judges).toEqual([{ name: 'Kyser, Drixxon', pronouns: null }]);
    });

    test('parses FLIP FOR SIDES body with 3 judges', () => {
      const result = EmailParser.parseBody(fixtures.formatA_flip.input.body);
      expect(result.roundTitle).toBe('Doubles of Policy - TOC');
      expect(result.startTime).toBe('3:30 PST');
      expect(result.room).toBe('NSDA Campus Section 6');
      expect(result.side).toBe('FLIP');
      expect(result.competitors.aff.teamCode).toBe('Interlake OC');
      expect(result.competitors.aff.names).toEqual([
        { name: 'Eva', pronouns: 'she/her' },
        { name: 'Mia', pronouns: 'she/her' },
      ]);
      expect(result.competitors.neg.teamCode).toBe('Peninsula BB');
      expect(result.judges).toHaveLength(3);
      expect(result.judges[0]).toEqual({ name: 'Evan Alexis', pronouns: 'He/Him' });
      expect(result.judges[1]).toEqual({ name: 'Eli Hatton', pronouns: 'he/they' });
      expect(result.judges[2]).toEqual({ name: 'Jayden Sampat', pronouns: 'they/them' });
    });

    test('returns empty result for empty body string', () => {
      const result = EmailParser.parseBody(fixtures.edgeCase_emptyBody.input.body);
      expect(result.roundTitle).toBeNull();
      expect(result.startTime).toBeNull();
      expect(result.room).toBeNull();
      expect(result.side).toBeNull();
      expect(result.competitors).toEqual({
        aff: { teamCode: null, names: [] },
        neg: { teamCode: null, names: [] },
      });
      expect(result.judges).toEqual([]);
    });
  });

  describe('Format B (assignments) bodies', () => {
    test('parses Westchester body with single entry, FLIP side, 3 judges', () => {
      const result = EmailParser.parseBody(fixtures.formatB_westchester.input.body);
      expect(result.format).toBe('assignments');
      expect(result.school).toBe('Cuttlefish independent');
      expect(result.roundTitle).toBe('Policy V Quarters');
      expect(result.startTime).toBe('9:00');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].teamCode).toBe('Cuttlefish independent WS');
      expect(result.entries[0].side).toBe('FLIP');
      expect(result.entries[0].judges).toHaveLength(3);
      expect(result.entries[0].room).toBe('NSDA Campus Section 2');
    });

    test('parses body with multiple entries in different rooms', () => {
      const result = EmailParser.parseBody(fixtures.formatB_multipleEntries.input.body);
      expect(result.format).toBe('assignments');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].side).toBe('AFF');
      expect(result.entries[0].room).toBe('101');
      expect(result.entries[1].side).toBe('NEG');
      expect(result.entries[1].room).toBe('205');
    });
  });
});

// ─── parse (full integration) ────────────────────────────────────

describe('parse', () => {
  test('Format A — Stanford (standard with 1 judge, pronouns)', () => {
    const result = EmailParser.parse(fixtures.formatA_stanford.input);
    expect(result).toEqual(fixtures.formatA_stanford.expectedParsed);
  });

  test('Format A — multiple judges (2 with pronouns, 1 without)', () => {
    const result = EmailParser.parse(fixtures.formatA_multipleJudges.input);
    expect(result).toEqual(fixtures.formatA_multipleJudges.expectedParsed);
  });

  test('Format A — indented names (older format)', () => {
    const result = EmailParser.parse(fixtures.formatA_indentedNames.input);
    expect(result).toEqual(fixtures.formatA_indentedNames.expectedParsed);
  });

  test('Format A — DSDS with comma in judge name', () => {
    const result = EmailParser.parse(fixtures.formatA_dsds.input);
    expect(result).toEqual(fixtures.formatA_dsds.expectedParsed);
  });

  test('Format A — FLIP FOR SIDES with 3 judges (elim round)', () => {
    const result = EmailParser.parse(fixtures.formatA_flip.input);
    expect(result).toEqual(fixtures.formatA_flip.expectedParsed);
  });

  test('Format B — Westchester (single entry, FLIP, 3 judges)', () => {
    const result = EmailParser.parse(fixtures.formatB_westchester.input);
    expect(result).toEqual(fixtures.formatB_westchester.expectedParsed);
  });

  test('Format B — multiple entries (AFF and NEG, different rooms)', () => {
    const result = EmailParser.parse(fixtures.formatB_multipleEntries.input);
    expect(result).toEqual(fixtures.formatB_multipleEntries.expectedParsed);
  });

  test('edge case — empty body still parses subject', () => {
    const result = EmailParser.parse(fixtures.edgeCase_emptyBody.input);
    expect(result).toEqual(fixtures.edgeCase_emptyBody.expectedParsed);
  });

  test('edge case — null email returns null', () => {
    const result = EmailParser.parse(fixtures.edgeCase_nullEmail.input);
    expect(result).toEqual(fixtures.edgeCase_nullEmail.expectedParsed);
  });

  test('edge case — no subject, body still parses', () => {
    const result = EmailParser.parse(fixtures.edgeCase_noSubject.input);
    expect(result).not.toBeNull();
    expect(result.format).toBe('liveUpdate');
    expect(result.teamCode).toBeNull();
    expect(result.roundNumber).toBeNull();
    expect(result.event).toBeNull();
    expect(result.roundTitle).toBe('Round 1 of Policy');
    expect(result.room).toBe('101');
    expect(result.judges).toEqual([{ name: 'Some Judge', pronouns: null }]);
  });
});

// ─── isTabroomEmail ──────────────────────────────────────────────

describe('isTabroomEmail', () => {
  test('returns true for Format A Stanford email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.formatA_stanford.input)).toBe(true);
  });

  test('returns true for Format A multiple judges email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.formatA_multipleJudges.input)).toBe(true);
  });

  test('returns true for Format A indented names email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.formatA_indentedNames.input)).toBe(true);
  });

  test('returns true for Format A DSDS email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.formatA_dsds.input)).toBe(true);
  });

  test('returns true for Format B Westchester email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.formatB_westchester.input)).toBe(true);
  });

  test('returns true for Format B multiple entries email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.formatB_multipleEntries.input)).toBe(true);
  });

  test('returns true for check-in email (tabroom, not pairing)', () => {
    expect(EmailParser.isTabroomEmail(fixtures.nonPairing_checkin.input)).toBe(fixtures.nonPairing_checkin.expectedIsTabroom);
  });

  test('returns true for registration reminder (tabroom, not pairing)', () => {
    expect(EmailParser.isTabroomEmail(fixtures.nonPairing_registration.input)).toBe(fixtures.nonPairing_registration.expectedIsTabroom);
  });

  test('returns false for non-tabroom email', () => {
    expect(EmailParser.isTabroomEmail(fixtures.nonPairing_nonTabroom.input)).toBe(fixtures.nonPairing_nonTabroom.expectedIsTabroom);
  });

  test('returns true for schedule update (tabroom, not pairing)', () => {
    expect(EmailParser.isTabroomEmail(fixtures.nonPairing_scheduleUpdate.input)).toBe(fixtures.nonPairing_scheduleUpdate.expectedIsTabroom);
  });

  test('returns false for null input', () => {
    expect(EmailParser.isTabroomEmail(null)).toBe(false);
  });

  test('returns false for non-object input', () => {
    expect(EmailParser.isTabroomEmail('not an object')).toBe(false);
  });
});

// ─── isPairingEmail ──────────────────────────────────────────────

describe('isPairingEmail', () => {
  describe('pairing emails (should return true)', () => {
    test('Format A — Stanford', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatA_stanford.input)).toBe(true);
    });

    test('Format A — multiple judges', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatA_multipleJudges.input)).toBe(true);
    });

    test('Format A — indented names', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatA_indentedNames.input)).toBe(true);
    });

    test('Format A — DSDS', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatA_dsds.input)).toBe(true);
    });

    test('Format A — FLIP FOR SIDES', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatA_flip.input)).toBe(true);
    });

    test('Format B — Westchester', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatB_westchester.input)).toBe(true);
    });

    test('Format B — multiple entries', () => {
      expect(EmailParser.isPairingEmail(fixtures.formatB_multipleEntries.input)).toBe(true);
    });
  });

  describe('non-pairing emails (should return false)', () => {
    test('check-in email', () => {
      expect(EmailParser.isPairingEmail(fixtures.nonPairing_checkin.input)).toBe(fixtures.nonPairing_checkin.expectedIsPairing);
    });

    test('registration reminder', () => {
      expect(EmailParser.isPairingEmail(fixtures.nonPairing_registration.input)).toBe(fixtures.nonPairing_registration.expectedIsPairing);
    });

    test('non-tabroom email', () => {
      expect(EmailParser.isPairingEmail(fixtures.nonPairing_nonTabroom.input)).toBe(fixtures.nonPairing_nonTabroom.expectedIsPairing);
    });

    test('schedule update', () => {
      expect(EmailParser.isPairingEmail(fixtures.nonPairing_scheduleUpdate.input)).toBe(fixtures.nonPairing_scheduleUpdate.expectedIsPairing);
    });
  });

  describe('edge cases', () => {
    test('returns false for null input', () => {
      expect(EmailParser.isPairingEmail(null)).toBe(false);
    });

    test('returns false for non-object input', () => {
      expect(EmailParser.isPairingEmail('not an object')).toBe(false);
    });

    test('returns false for empty object', () => {
      expect(EmailParser.isPairingEmail({})).toBe(false);
    });
  });
});

// ─── _isCompletePairing ─────────────────────────────────────────

describe('_isCompletePairing', () => {
  test('returns true for complete Format A pairing', () => {
    const parsed = EmailParser.parse(fixtures.formatA_stanford.input);
    expect(EmailParser._isCompletePairing(parsed)).toBe(true);
  });

  test('returns true for complete Format B pairing', () => {
    const parsed = EmailParser.parse(fixtures.formatB_westchester.input);
    expect(EmailParser._isCompletePairing(parsed)).toBe(true);
  });

  test('returns false for empty body Format A', () => {
    const parsed = EmailParser.parse(fixtures.edgeCase_emptyBody.input);
    // Empty body: aff/neg teamCodes are null, no judges, no startTime
    expect(EmailParser._isCompletePairing(parsed)).toBe(false);
  });

  test('returns false for null', () => {
    expect(EmailParser._isCompletePairing(null)).toBe(false);
  });

  test('returns false for Format A missing judges', () => {
    expect(EmailParser._isCompletePairing({
      format: 'liveUpdate',
      aff: { teamCode: 'Team A' },
      neg: { teamCode: 'Team B' },
      judges: [],
      startTime: '10:00',
    })).toBe(false);
  });

  test('returns false for Format A missing startTime', () => {
    expect(EmailParser._isCompletePairing({
      format: 'liveUpdate',
      aff: { teamCode: 'Team A' },
      neg: { teamCode: 'Team B' },
      judges: [{ name: 'Judge' }],
      startTime: null,
    })).toBe(false);
  });
});

// ─── parseWithFallback ──────────────────────────────────────────

describe('parseWithFallback', () => {
  test('returns regex result when complete (no LLM needed)', async () => {
    const result = await EmailParser.parseWithFallback(fixtures.formatA_stanford.input, null);
    expect(result).toEqual(fixtures.formatA_stanford.expectedParsed);
  });

  test('returns regex result for Format B without LLM', async () => {
    const result = await EmailParser.parseWithFallback(fixtures.formatB_westchester.input, null);
    expect(result).toEqual(fixtures.formatB_westchester.expectedParsed);
  });

  test('returns null for null email', async () => {
    const result = await EmailParser.parseWithFallback(null, null);
    expect(result).toBeNull();
  });

  test('returns null for empty body without LLM (no meaningful data)', async () => {
    // Empty body has subject data (team code from subject) but no aff/neg/judges in body
    const result = await EmailParser.parseWithFallback(fixtures.edgeCase_emptyBody.input, null);
    // No teams in body, no judges, no start time → null
    expect(result).toBeNull();
  });

  test('attempts LLM fallback when regex parse is incomplete', async () => {
    const mockLlm = {
      enabled: true,
      model: 'gpt-4o-mini',
      client: {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{
                message: {
                  content: JSON.stringify({
                    format: 'liveUpdate',
                    roundTitle: 'Round 3',
                    startTime: '2:00 PM',
                    room: '101',
                    side: 'AFF',
                    aff: { teamCode: 'Interlake OC', names: [] },
                    neg: { teamCode: 'Coppell PK', names: [] },
                    judges: [{ name: 'Test Judge', pronouns: null }],
                  }),
                },
              }],
            }),
          },
        },
      },
    };

    // Construct an email that regex can't fully parse
    const weirdEmail = {
      subject: 'Some unusual format',
      from: 'tourn@tabroom.com',
      body: 'This is round 3, Interlake OC vs Coppell PK, judged by Test Judge at 2:00 PM in room 101',
    };

    const result = await EmailParser.parseWithFallback(weirdEmail, mockLlm);
    expect(result).not.toBeNull();
    expect(mockLlm.client.chat.completions.create).toHaveBeenCalled();
  });
});
