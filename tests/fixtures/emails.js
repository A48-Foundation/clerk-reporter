/**
 * Test fixtures for email-parser tests.
 * Each fixture contains a raw email input and the expected parsed output.
 */

// ─── FORMAT A: Live Update emails ────────────────────────────────

const formatA_stanford = {
  input: {
    subject: '[TAB] Interlake OC Round 4 CX-T',
    from: '40th Annual Stanford Invitational <stanford_1770512406@www.tabroom.com>',
    body: [
      'Round 4 of Policy - TOC',
      'Start: 5:30 PST',
      '',
      'Room: NSDA Campus Section 18',
      '',
      'Side: AFF',
      '',
      'Competitors',
      '',
      'AFF Interlake OC',
      '',
      'Eva : she/her Mia : she/her',
      '',
      'NEG Arizona Chandler Independent LS',
      '',
      'Austin : he/him',
      '',
      'Judging',
      '',
      'Evan Alexis',
      '',
      'He/Him',
    ].join('\n'),
  },
  expectedSubject: {
    teamCode: 'Interlake OC',
    roundNumber: 4,
    event: 'CX-T',
    format: 'liveUpdate',
    school: null,
  },
  expectedParsed: {
    format: 'liveUpdate',
    teamCode: 'Interlake OC',
    roundNumber: 4,
    event: 'CX-T',
    roundTitle: 'Round 4 of Policy - TOC',
    startTime: '5:30 PST',
    room: 'NSDA Campus Section 18',
    side: 'AFF',
    aff: {
      teamCode: 'Interlake OC',
      names: [
        { name: 'Eva', pronouns: 'she/her' },
        { name: 'Mia', pronouns: 'she/her' },
      ],
    },
    neg: {
      teamCode: 'Arizona Chandler Independent LS',
      names: [
        { name: 'Austin', pronouns: 'he/him' },
      ],
    },
    judges: [
      { name: 'Evan Alexis', pronouns: 'He/Him' },
    ],
  },
};

const formatA_multipleJudges = {
  input: {
    subject: '[TAB] Cuttlefish CG Round 2 CX-O',
    from: 'Some Tournament <tourn_123@www.tabroom.com>',
    body: [
      'Round 2 of CX Open',
      'Start: 10:00 AM EST',
      '',
      'Room: Room 203',
      '',
      'Side: NEG',
      '',
      'Competitors',
      '',
      'AFF Lake Highland SB',
      '',
      'Sam : he/him Ben : they/them',
      '',
      'NEG Cuttlefish CG',
      '',
      'Charlie : he/him Grace : she/her',
      '',
      'Judging',
      '',
      'Jane Doe',
      '',
      'she/her',
      '',
      'John Smith',
      '',
      'he/him',
      '',
      'Alex Kim',
    ].join('\n'),
  },
  expectedParsed: {
    format: 'liveUpdate',
    teamCode: 'Cuttlefish CG',
    roundNumber: 2,
    event: 'CX-O',
    roundTitle: 'Round 2 of CX Open',
    startTime: '10:00 AM EST',
    room: 'Room 203',
    side: 'NEG',
    aff: {
      teamCode: 'Lake Highland SB',
      names: [
        { name: 'Sam', pronouns: 'he/him' },
        { name: 'Ben', pronouns: 'they/them' },
      ],
    },
    neg: {
      teamCode: 'Cuttlefish CG',
      names: [
        { name: 'Charlie', pronouns: 'he/him' },
        { name: 'Grace', pronouns: 'she/her' },
      ],
    },
    judges: [
      { name: 'Jane Doe', pronouns: 'she/her' },
      { name: 'John Smith', pronouns: 'he/him' },
      { name: 'Alex Kim', pronouns: null },
    ],
  },
};

const formatA_indentedNames = {
  input: {
    subject: '[TAB] Interlake SW Round 1 CX-T',
    from: 'Stanford Invitational <stanford@www.tabroom.com>',
    body: [
      'Round 1 of Policy - TOC',
      'Start: 8:00 AM PST',
      '',
      'Room: NSDA Campus Section 5',
      '',
      'Side: NEG',
      '',
      'Competitors',
      'AFF Isidore Newman AW',
      '  Alex : he/him Will : he/him',
      'NEG Interlake SW',
      '  Sara : she/her Wei : she/her',
      '',
      'Judging',
      'Jenny Liu',
      '  she/her',
    ].join('\n'),
  },
  expectedParsed: {
    format: 'liveUpdate',
    teamCode: 'Interlake SW',
    roundNumber: 1,
    event: 'CX-T',
    roundTitle: 'Round 1 of Policy - TOC',
    startTime: '8:00 AM PST',
    room: 'NSDA Campus Section 5',
    side: 'NEG',
    aff: {
      teamCode: 'Isidore Newman AW',
      names: [
        { name: 'Alex', pronouns: 'he/him' },
        { name: 'Will', pronouns: 'he/him' },
      ],
    },
    neg: {
      teamCode: 'Interlake SW',
      names: [
        { name: 'Sara', pronouns: 'she/her' },
        { name: 'Wei', pronouns: 'she/her' },
      ],
    },
    judges: [
      { name: 'Jenny Liu', pronouns: 'she/her' },
    ],
  },
};

// ─── FORMAT B: Round Assignments emails ──────────────────────────

const formatB_westchester = {
  input: {
    subject: '[TAB] Cuttlefish independent Round Assignments',
    from: 'Westchester Classic <lakeland_1772371806@www.tabroom.com>',
    body: [
      'Full assignments for Cuttlefish independent',
      '',
      'Policy V Quarters Start 9:00',
      '',
      'ENTRIES',
      'Cuttlefish independent WS',
      '         FLIP vs Ronald Reagan FP',
      '        Judges: Wheezy Ervin,  Cayden Mayer,  Jonathan Meza     Room NSDA Campus Section 2 Counter 2 Letter 2',
      '',
      '----------------------------',
      'You received this email through your account on https://www.tabroom.com',
    ].join('\n'),
  },
  expectedSubject: {
    teamCode: null,
    roundNumber: null,
    event: null,
    format: 'assignments',
    school: 'Cuttlefish independent',
  },
  expectedParsed: {
    format: 'assignments',
    school: 'Cuttlefish independent',
    roundTitle: 'Policy V Quarters',
    startTime: '9:00',
    entries: [
      {
        teamCode: 'Cuttlefish independent WS',
        opponent: 'Ronald Reagan FP',
        side: 'FLIP',
        judges: [
          { name: 'Wheezy Ervin', pronouns: null },
          { name: 'Cayden Mayer', pronouns: null },
          { name: 'Jonathan Meza', pronouns: null },
        ],
        room: 'NSDA Campus Section 2',
      },
    ],
  },
};

const formatB_multipleEntries = {
  input: {
    subject: '[TAB] Interlake Round Assignments',
    from: 'Big Tournament <tourn_456@www.tabroom.com>',
    body: [
      'Full assignments for Interlake',
      '',
      'Policy Open Round 3 Start 2:30 PM',
      '',
      'ENTRIES',
      'Interlake CG',
      '         AFF vs Coppell PK',
      '        Judges: Bob Jones     Room 101',
      'Interlake SW',
      '         NEG vs Montgomery Bell MB',
      '        Judges: Alice Chen, David Lee     Room 205',
      '',
      '----------------------------',
    ].join('\n'),
  },
  expectedParsed: {
    format: 'assignments',
    school: 'Interlake',
    roundTitle: 'Policy Open Round 3',
    startTime: '2:30 PM',
    entries: [
      {
        teamCode: 'Interlake CG',
        opponent: 'Coppell PK',
        side: 'AFF',
        judges: [{ name: 'Bob Jones', pronouns: null }],
        room: '101',
      },
      {
        teamCode: 'Interlake SW',
        opponent: 'Montgomery Bell MB',
        side: 'NEG',
        judges: [
          { name: 'Alice Chen', pronouns: null },
          { name: 'David Lee', pronouns: null },
        ],
        room: '205',
      },
    ],
  },
};

// ─── NON-PAIRING emails (should NOT pass isPairingEmail) ─────────

const nonPairing_checkin = {
  input: {
    subject: '[TAB] Cuttlefish independent Check-In Open',
    from: 'TOC Digital Speech and Debate Series 3 4th Annual <dsds3_2806804@www.tabroom.com>',
    body: [
      'School: Cuttlefish independent',
      '',
      'Online Check-in is now open. A guide with assistance on how to check in can be found here.',
      '',
      'Before attempting to check-in, please double check',
      '',
      'all competitors and judges are accurate',
      '',
      'all payments have posted (if you made a payment between 6:30am and when you\'re receiving this, it\'s likely delayed)',
      '',
      'There is a new Tabroom feature we are using for DSDS 3.',
      '',
      'Payment Information:',
      '',
      'If you have an unpaid balance, you will not be able to check-in online until this is paid.',
    ].join('\n'),
  },
  expectedIsPairing: false,
  expectedIsTabroom: true,
};

const nonPairing_registration = {
  input: {
    subject: '[TAB] Registration Reminder for Big Tournament',
    from: 'Big Tournament <tourn_456@www.tabroom.com>',
    body: 'Please complete your registration by Friday.',
  },
  expectedIsPairing: false,
  expectedIsTabroom: true,
};

const nonPairing_nonTabroom = {
  input: {
    subject: 'Hello from your mom',
    from: 'mom@gmail.com',
    body: 'Hi honey, how is the tournament going?',
  },
  expectedIsPairing: false,
  expectedIsTabroom: false,
};

const nonPairing_scheduleUpdate = {
  input: {
    subject: '[TAB] Schedule Change Notification',
    from: 'TOC <toc@www.tabroom.com>',
    body: [
      'Due to weather, the schedule has been updated.',
      'Round 3 will now start at 4:00 PM instead of 3:00 PM.',
      'Please check the updated schedule on Tabroom.',
    ].join('\n'),
  },
  expectedIsPairing: false,
  expectedIsTabroom: true,
};

// ─── DSDS sample (non-standard format, also a pairing) ──────────

const formatA_dsds = {
  input: {
    subject: '[TAB] Cuttlefish independent CG Round 5 CX-O',
    from: 'TOC Digital Speech and Debate Series 3 4th Annual <dsds3_2806804@www.tabroom.com>',
    body: [
      'Round 5 of CX-O',
      'Start: Sat 5:00 PM',
      '',
      'Room: 2',
      '',
      'Side: AFF',
      '',
      'Competitors',
      '',
      'AFF Cuttlefish independent CG',
      '',
      'NEG Coppell PK',
      '',
      'Judging',
      '',
      'Kyser, Drixxon',
    ].join('\n'),
  },
  expectedParsed: {
    format: 'liveUpdate',
    teamCode: 'Cuttlefish independent CG',
    roundNumber: 5,
    event: 'CX-O',
    roundTitle: 'Round 5 of CX-O',
    startTime: 'Sat 5:00 PM',
    room: '2',
    side: 'AFF',
    aff: {
      teamCode: 'Cuttlefish independent CG',
      names: [],
    },
    neg: {
      teamCode: 'Coppell PK',
      names: [],
    },
    judges: [
      { name: 'Kyser, Drixxon', pronouns: null },
    ],
  },
};

// ─── Edge cases ──────────────────────────────────────────────────

const edgeCase_emptyBody = {
  input: {
    subject: '[TAB] Interlake OC Round 1 CX-T',
    from: 'Stanford <stanford@www.tabroom.com>',
    body: '',
  },
  expectedParsed: {
    format: 'liveUpdate',
    teamCode: 'Interlake OC',
    roundNumber: 1,
    event: 'CX-T',
    roundTitle: null,
    startTime: null,
    room: null,
    side: null,
    aff: { teamCode: null, names: [] },
    neg: { teamCode: null, names: [] },
    judges: [],
  },
};

const edgeCase_nullEmail = {
  input: null,
  expectedParsed: null,
};

const edgeCase_noSubject = {
  input: {
    subject: '',
    from: 'tourn@www.tabroom.com',
    body: [
      'Round 1 of Policy',
      'Start: 10:00 AM',
      'Room: 101',
      'Side: AFF',
      '',
      'Competitors',
      'AFF Interlake OC',
      'NEG Coppell PK',
      '',
      'Judging',
      'Some Judge',
    ].join('\n'),
  },
  // Subject parse returns null, body still parses
  expectedSubject: null,
};

module.exports = {
  formatA_stanford,
  formatA_multipleJudges,
  formatA_indentedNames,
  formatA_dsds,
  formatB_westchester,
  formatB_multipleEntries,
  nonPairing_checkin,
  nonPairing_registration,
  nonPairing_nonTabroom,
  nonPairing_scheduleUpdate,
  edgeCase_emptyBody,
  edgeCase_nullEmail,
  edgeCase_noSubject,
};
