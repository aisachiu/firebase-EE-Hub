import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKSPACE_SHEET_HELP } from './workspaceSheetHelp';
import {
  allocationExportRows,
  allocationTab,
  applySavedConfig,
  buildDesk,
  columnMappingsFrom,
  emptyColumnMappings,
  COLOR_SCALE_STOPS,
  colorScaleFill,
  columnScaleExtent,
  emptySettings,
  findAllocationTab,
  isEeActive,
  indexLiveRoster,
  liveLinkProblems,
  liveSheetLinked,
  mergeDetected,
  mergeLiveChoiceRow,
  mergeStaticWorkspaceRow,
  parseLiveSheet,
  resolveLiveStudent,
  settingsForLiveLink,
  settingsFromDoc,
  parseTokenGrid,
  parseWorkspaceGrid,
  tokenPreviewRows,
  workspacePreviewRows,
  planBatchDraft,
  planCommit,
  publishedAllocationSubject,
  planDraft,
  planTokenTopUp,
  preserveEeActive,
  activeSubjectNamesFrom,
  canonicalSubjectAssignment,
  formatSubjectCell,
  keepLiteralSubject,
  parseSubjectCell,
  supportFlagTags,
  strictInterdisciplinaryValue,
  quotaCapacity,
  subjectTokenLoad,
  subjectLoadNames,
  staffQuotaTokenRows,
  subjectsOverlap,
  tokenSheetRows,
  tokenFromDoc,
  interdisciplinarySignal,
  requestedSubjectNames,
  resolveRequestedSubjects,
  TokenRecord,
  WorkspaceRecord,
} from './allocationPure';

const JANE = 'jane.doe@vsa.edu';
const MARK = 'mark.lee@vsa.edu';
const SMITH = 'smith@vsa.edu';
const DAVIS = 'davis@vsa.edu';

function token(partial: Partial<TokenRecord> & Pick<TokenRecord, 'id' | 'staffId' | 'status'>): TokenRecord {
  return {
    cohortId: '2026',
    eligibleSubjects: ['History'],
    allocatedTo: '',
    assignedSubject: '',
    interdisciplinary: false,
    createdAt: '2026-10-18T00:00:00.000Z',
    ...partial,
  };
}

test('a missing eeActive flag counts as active and a blank sheet cell does not wipe a saved flag', () => {
  assert.equal(isEeActive(undefined), true);
  assert.equal(isEeActive(false), false);
  assert.equal(isEeActive('no'), false);
  const kept = preserveEeActive({ StudentId: JANE, Surname: 'Doe' }, { StudentId: JANE, eeActive: false });
  assert.equal(kept.eeActive, false);
  const explicit = preserveEeActive({ StudentId: JANE, eeActive: true }, { StudentId: JANE, eeActive: false });
  assert.equal(explicit.eeActive, true);
});

test('workspace rows split choice columns, JSON, and the rest of the sheet', () => {
  const parsed = parseWorkspaceGrid({
    title: 'COHORTDATA: 2026',
    rows: [
      ['StudentId', 'SubjectChoice', 'Choice_choice2', 'Y10 GPA', 'EEActive'],
      [JANE, '{"choice1":"History","interdisciplinary":true}', 'Eng Lit', 3.4, 'yes'],
      ['not-an-email', '{}', '', '', ''],
      [JANE, '{"choice1":"Biology"}', 'Physics', 2, 'no'],
    ],
  });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].subjectChoices.choice1, 'Biology');
  assert.equal(parsed.rows[0].subjectChoices.choice2, 'Physics');
  assert.equal(parsed.rows[0].dynamicData['Y10 GPA'], 2);
  assert.equal(parsed.rows[0].eeActive, false);
  assert.deepEqual(parsed.choiceKeys, ['choice1', 'choice2']);
  assert.ok(parsed.warnings.some((warning) => warning.includes('repeats')));
  assert.ok(parsed.warnings.some((warning) => warning.includes('student email')));
});

test('token ingest tops up available slots and leaves drafts alone', () => {
  const existing = [
    token({ id: 'keep', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'History', eligibleSubjects: ['History'] }),
    token({ id: 'free', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] }),
  ];
  const parsed = parseTokenGrid({
    title: 'SUPERVISORTOKENS 2026',
    rows: [
      ['StaffEmail', 'Quota', 'EligibleSubjects'],
      [SMITH, 4, 'History, Geography'],
      ['bad-row', 'many', 'Art'],
    ],
  });
  let next = 0;
  const plan = planTokenTopUp(existing, parsed.rows, '2026', '2026-10-18T01:00:00.000Z', () => `new-${next++}`);
  assert.equal(plan.create.length, 2);
  assert.equal(plan.create.every((item) => item.status === 'available' && item.allocatedTo === ''), true);
  assert.deepEqual(plan.eligibleUpdates, [{ id: 'free', eligibleSubjects: ['History', 'Geography'] }]);
  assert.equal(plan.create[0].eligibleSubjects.join(', '), 'History, Geography');
  assert.ok(parsed.warnings.some((warning) => warning.includes('bad-row') || warning.includes('quota')));

  const over = planTokenTopUp(existing, [{ staffId: SMITH, quota: 1, eligibleSubjects: ['History'] }], '2026', '2026-10-18T01:00:00.000Z', () => 'x');
  assert.equal(over.create.length, 0);
  assert.match(over.warnings[0], /quota is 1/);
});

test('staff quotas count once per subject and sum once for the cohort total', () => {
  const capacity = quotaCapacity([
    { quota: 3, eligibleSubjects: ['English', 'History'] },
    { quota: 2, eligibleSubjects: ['English'] },
    { quota: 4, eligibleSubjects: [] },
    { quota: 0, eligibleSubjects: ['Biology'] },
  ]);
  assert.equal(capacity.totalQuota, 9);
  assert.equal(capacity.untiedQuota, 4);
  assert.deepEqual(capacity.subjects, [
    { subject: 'English', capacity: 5 },
    { subject: 'History', capacity: 3 },
  ]);
  const parsed = staffQuotaTokenRows([
    { EMAIL: 'Smith@VSA.edu', EEQuota: 3, EESubjects: 'English, History' },
    { EMAIL: 'lee@vsa.edu', EEQuota: '', EESubjects: 'Art' },
    { EMAIL: 'ng@vsa.edu', EEQuota: 0, EESubjects: '' },
  ]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].staffId, 'smith@vsa.edu');
  assert.deepEqual(tokenSheetRows(parsed.rows)[1], ['smith@vsa.edu', 3, 'English, History']);
  const slash = staffQuotaTokenRows([
    { EMAIL: 'lee@vsa.edu', EEQuota: 2, EESubjects: ['Theatre / Film', 'Biology'] },
  ]);
  assert.deepEqual(slash.rows[0].eligibleSubjects, ['Theatre / Film', 'Biology']);
});

test('EE subject lists keep names that contain commas or slashes', () => {
  assert.deepEqual(activeSubjectNamesFrom([
    { Name: 'History', Active: true },
    { Name: 'biology', Active: 'yes' },
    { Name: 'Latin', Active: false },
    { Name: 'History', Active: true },
  ]), ['biology', 'History']);
  assert.deepEqual(parseSubjectCell('English, History'), ['English', 'History']);
  assert.deepEqual(parseSubjectCell('["Theatre / Film","Biology"]'), ['Theatre / Film', 'Biology']);
  assert.deepEqual(parseSubjectCell(['Theatre / Film', 'Biology']), ['Theatre / Film', 'Biology']);
  assert.equal(formatSubjectCell(['English', 'History']), 'English, History');
  assert.equal(formatSubjectCell(['Theatre / Film', 'Biology']), '["Theatre / Film","Biology"]');
  assert.deepEqual(canonicalSubjectAssignment(['english', 'History'], ['English', 'History'], []), ['English', 'History']);
  assert.deepEqual(canonicalSubjectAssignment(['Latin', 'English'], ['English'], ['Latin']), ['Latin', 'English']);
  assert.throws(() => canonicalSubjectAssignment(['Art'], ['English'], []), /not an active subject/);
});

test('drafting claims a matching slot, and clearing a published token waits for the next publish', () => {
  const tokens = [
    token({ id: 's1', staffId: SMITH, status: 'available', eligibleSubjects: ['History', 'Geography'] }),
    token({ id: 's2', staffId: SMITH, status: 'available', eligibleSubjects: ['Art'] }),
    token({ id: 'd1', staffId: DAVIS, status: 'committed', allocatedTo: MARK, assignedSubject: 'Art', eligibleSubjects: ['Art'] }),
  ];
  const claimed = planDraft({
    studentId: JANE, staffId: SMITH, subject: 'History', tokens, memberSupervisorId: '', pendingClear: false,
  });
  assert.equal(claimed.tokens[0].id, 's1');
  assert.equal(claimed.tokens[0].status, 'draft');
  assert.equal(claimed.pendingClear, false);

  const cleared = planDraft({
    studentId: MARK, staffId: '', subject: '', tokens, memberSupervisorId: DAVIS, pendingClear: false,
  });
  assert.equal(cleared.tokens[0].status, 'available');
  assert.equal(cleared.pendingClear, true);

  const switched = planDraft({
    studentId: MARK, staffId: SMITH, subject: 'Geography', tokens, memberSupervisorId: DAVIS, pendingClear: false,
  });
  assert.equal(switched.pendingClear, false);
  assert.equal(switched.tokens.find((item) => item.id === 'd1')?.status, 'available');
  assert.equal(switched.tokens.find((item) => item.staffId === SMITH)?.allocatedTo, MARK);
});

test('a batch stops when the supervisor runs out of slots', () => {
  const tokens = [token({ id: 'only', staffId: SMITH, status: 'available', eligibleSubjects: ['Biology'] })];
  const plan = planBatchDraft({
    studentIds: [JANE, MARK],
    staffId: SMITH,
    subjects: { [JANE]: 'Biology', [MARK]: 'Biology' },
    tokens,
    supervisorByStudent: {},
    pendingClearByStudent: {},
  });
  assert.deepEqual(plan.assigned, [JANE]);
  assert.equal(plan.skipped[0].studentId, MARK);
  assert.match(plan.skipped[0].reason, /no available slots/);
  assert.equal(plan.tokenWrites[0].allocatedTo, JANE);
});

test('subject token load groups remaining slots by subject', () => {
  const load = subjectTokenLoad([
    { status: 'available', eligibleSubjects: ['History', 'Geography'] },
    { status: 'available', eligibleSubjects: ['history', 'History'] },
    { status: 'available', eligibleSubjects: ['Biology'] },
    { status: 'draft', eligibleSubjects: ['Art'] },
    { status: 'committed', eligibleSubjects: ['Biology'] },
    { status: 'available', eligibleSubjects: [] },
    { status: 'draft', eligibleSubjects: [] },
  ]);
  assert.equal(load.untied, 1);
  assert.equal(load.overlaps, true);
  assert.deepEqual(load.subjects, [
    { subject: 'Art', remaining: 0, pool: 0, upool: 0, alloc: 0 },
    { subject: 'Biology', remaining: 1, pool: 0, upool: 0, alloc: 0 },
    { subject: 'Geography', remaining: 1, pool: 0, upool: 0, alloc: 0 },
    { subject: 'History', remaining: 2, pool: 0, upool: 0, alloc: 0 },
  ]);
  const single = subjectTokenLoad([{ status: 'available', eligibleSubjects: ['Chemistry'] }]);
  assert.equal(single.overlaps, false);
  assert.equal(single.untied, 0);
});

test('publish writes drafts and clears a released supervisor', () => {
  const tokens = [
    token({ id: 'draft', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'History' }),
    token({ id: 'free', staffId: DAVIS, status: 'available' }),
  ];
  const workspaces: WorkspaceRecord[] = [
    { studentId: JANE, subjectChoices: {}, dynamicData: {}, pendingClear: true, updatedAt: '' },
    { studentId: MARK, subjectChoices: {}, dynamicData: {}, pendingClear: true, updatedAt: '' },
  ];
  const plan = planCommit(tokens, workspaces);
  assert.deepEqual(plan.assignments.map((row) => row.studentId), [JANE]);
  assert.deepEqual(plan.clears, [MARK]);
  assert.equal(plan.warnings.length, 0);
  assert.equal(publishedAllocationSubject('History', { choice1: 'Biology' }, 'choice1'), 'History');
  assert.equal(publishedAllocationSubject('', { choice1: 'Biology' }, 'choice1'), 'Biology');
  assert.equal(publishedAllocationSubject('  ', { choice1: 'Biology' }, ''), '');
});

test('the desk marks subject match, an HL miss, and support flags from the saved columns', () => {
  const settings = mergeDetected(emptySettings(), ['choice1', 'choice2', 'interdisciplinary'], ['Y10 GPA', 'HL', 'Academic Flag']);
  settings.hlColumn = 'HL';
  settings.supportColumn = 'Academic Flag';
  const desk = buildDesk({
    cohortId: '2026',
    members: [
      { StudentId: JANE, Surname: 'Doe', 'First Name': 'Jane', eeActive: true, supervisorId: '', subject: '' },
      { StudentId: MARK, Surname: 'Lee', 'First Name': 'Mark', eeActive: false },
    ],
    workspaces: [{
      studentId: JANE,
      subjectChoices: { choice1: 'History', choice2: 'Eng Lit', interdisciplinary: true },
      dynamicData: { 'Y10 GPA': 3.4, HL: 'Bio, Chem', 'Academic Flag': 'Needs Support' },
      pendingClear: false,
      updatedAt: '',
    }],
    tokens: [token({ id: 's1', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'History', eligibleSubjects: ['History', 'Geography'] })],
    staff: [{ email: SMITH, displayName: 'Mr. Smith' }],
    settings,
  });
  assert.equal(desk.students.length, 1);
  assert.equal(desk.students[0].displayName, 'Doe, Jane');
  assert.equal(desk.students[0].flags.subjectMatch, 'match');
  assert.equal(desk.students[0].flags.hlMatch, 'miss');
  assert.equal(desk.students[0].flags.needsSupport, true);
  assert.equal(desk.students[0].choices.interdisciplinary, true);
  assert.equal(desk.supervisors[0].displayName, 'Mr. Smith');
  assert.equal(desk.supervisors[0].used, 1);
  assert.deepEqual(desk.tokenSlots, [{ status: 'draft', eligibleSubjects: ['History', 'Geography'] }]);
  assert.deepEqual(subjectTokenLoad(desk.tokenSlots).subjects, [
    { subject: 'Geography', remaining: 0, pool: 0, upool: 0, alloc: 0 },
    { subject: 'History', remaining: 0, pool: 0, upool: 0, alloc: 0 },
  ]);
  assert.deepEqual(desk.students[0].supportFlags, ['Needs support']);
  assert.equal(desk.summary.buffer, 0);
  assert.equal(subjectsOverlap('Vis Art', ['Visual Arts']), true);

  const saved = applySavedConfig(desk.settings, {
    primaryChoiceKey: 'choice1',
    secondaryChoiceKey: 'missing',
    hlColumn: 'HL',
    supportColumn: 'Academic Flag',
    columns: [
      { key: 'Y10 GPA', showOnCard: true, filterable: false, sortable: true },
      { key: 'HL', showOnCard: true, filterable: false, sortable: false },
      { key: 'Academic Flag', showOnCard: false, filterable: true, sortable: false },
    ],
  });
  assert.equal(saved.primaryChoiceKey, 'choice1');
  assert.equal(saved.secondaryChoiceKey, '');
  assert.equal(saved.columns.find((column) => column.key === 'Y10 GPA')?.sortable, true);
  assert.equal(saved.columns.find((column) => column.key === 'Y10 GPA')?.colorScale, false);
  assert.equal(saved.columns.find((column) => column.key === 'Y10 GPA')?.expanded, false);
  assert.equal(settings.columns.every((column) => column.showOnCard && column.sortable && column.colorScale === false), true);
  const rows = allocationExportRows(desk.students, saved);
  assert.equal(rows[1][2], 'Draft');
  assert.equal(rows[0].includes('Y10 GPA'), true);
  assert.equal(findAllocationTab([{ title: 'COHORTDATA 2026', rows: [] }, { title: 'SUPERVISORTOKENS: 2026', rows: [] }], '2026', 'tokens')?.title, 'SUPERVISORTOKENS: 2026');
});

test('workspace preview compares each sheet row with the hub and does not list removals', () => {
  const leftOut = 'left.out@vsa.edu';
  const parsed = parseWorkspaceGrid({
    title: 'COHORTDATA: 2026',
    rows: [
      ['StudentId', 'SubjectChoice', 'Y10 GPA', 'EEActive'],
      [JANE, '{"choice1":"History"}', 3.4, ''],
      [MARK, '{"choice1":"Art"}', 2, 'no'],
      ['missing@vsa.edu', '{"choice1":"Film"}', '', ''],
    ],
  });
  const rows = workspacePreviewRows(parsed.rows, [
    { studentId: JANE, eeActive: true },
    { studentId: MARK, eeActive: true },
    { studentId: leftOut, eeActive: true },
  ], [{
    studentId: JANE,
    subjectChoices: { choice1: 'History' },
    dynamicData: { 'Y10 GPA': 3.4 },
    pendingClear: false,
    updatedAt: '',
  }]);
  assert.equal(rows.find((row) => row.id === JANE)?.action, 'Unchanged');
  assert.equal(rows.find((row) => row.id === MARK)?.action, 'Add');
  assert.match(rows.find((row) => row.id === MARK)?.incoming || '', /choice1: Art/);
  assert.equal(rows.find((row) => row.id === MARK)?.hub, '—');
  assert.equal(rows.find((row) => row.id === 'missing@vsa.edu')?.action, 'Skip');
  assert.equal(rows.find((row) => row.id === 'missing@vsa.edu')?.hub, 'Not on the roster');
  assert.equal(rows.find((row) => row.id === leftOut), undefined);

  const changed = workspacePreviewRows([{
    studentId: JANE,
    subjectChoices: { choice1: 'Biology' },
    dynamicData: { 'Y10 GPA': 3.1 },
    eeActive: false,
  }], [{ studentId: JANE, eeActive: true }], [{
    studentId: JANE,
    subjectChoices: { choice1: 'History' },
    dynamicData: { 'Y10 GPA': 3.4 },
    pendingClear: false,
    updatedAt: '',
  }]);
  assert.equal(changed[0].action, 'Update');
  assert.match(changed[0].incoming, /Biology/);
  assert.match(changed[0].incoming, /EEActive: no/);
  assert.match(changed[0].hub, /History/);
  assert.match(changed[0].hub, /EEActive: yes/);
});

test('token preview tops up and updates open slots without marking missing tokens for removal', () => {
  const existing = [
    token({ id: 'free', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] }),
    token({ id: 'keep', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'History', eligibleSubjects: ['History'] }),
    token({ id: 'other', staffId: DAVIS, status: 'available', eligibleSubjects: ['Art'] }),
  ];
  const rows = tokenPreviewRows([
    { staffId: SMITH, quota: 4, eligibleSubjects: ['History', 'Geography'] },
    { staffId: 'new@vsa.edu', quota: 1, eligibleSubjects: ['Biology'] },
    { staffId: 'same@vsa.edu', quota: 1, eligibleSubjects: ['Art'] },
  ], existing.concat([
    token({ id: 'same', staffId: 'same@vsa.edu', status: 'available', eligibleSubjects: ['Art'] }),
  ]));
  const smith = rows.find((row) => row.id === SMITH);
  assert.equal(smith?.action, 'Update');
  assert.match(smith?.incoming || '', /Quota 4/);
  assert.match(smith?.hub || '', /2 tokens/);
  assert.match(smith?.hub || '', /1 open, 1 draft, 0 committed/);
  assert.equal(rows.find((row) => row.id === 'new@vsa.edu')?.action, 'Add');
  assert.equal(rows.find((row) => row.id === 'new@vsa.edu')?.hub, 'No tokens yet');
  assert.equal(rows.find((row) => row.id === 'same@vsa.edu')?.action, 'Unchanged');
  assert.equal(rows.find((row) => row.id === DAVIS), undefined);

  const kept = tokenPreviewRows([
    { staffId: SMITH, quota: 1, eligibleSubjects: ['History'] },
  ], existing);
  assert.equal(kept[0].action, 'Unchanged');
  assert.match(kept[0].hub, /2 tokens/);
});

test('color scale runs from the visible min to max on a blue sequential palette', () => {
  assert.equal(columnScaleExtent(['', 'n/a', null]), null);
  assert.equal(columnScaleExtent([3, '3']), null);
  const extent = columnScaleExtent(['1', '', 'Weak', 4, 'History']);
  assert.deepEqual(extent, { min: 0, max: 4 });
  const low = colorScaleFill('Weak', extent);
  const mid = colorScaleFill(2, extent);
  const high = colorScaleFill(4, extent);
  assert.equal(colorScaleFill('', extent), null);
  assert.equal(colorScaleFill('History', extent), null);
  assert.equal(low?.background, COLOR_SCALE_STOPS[0].background);
  assert.equal(high?.background, COLOR_SCALE_STOPS[COLOR_SCALE_STOPS.length - 1].background);
  assert.notEqual(low?.background, high?.background);
  assert.equal(mid?.background, '#6baed6');
  COLOR_SCALE_STOPS.forEach((stop) => {
    assert.ok(contrastRatio(stop.background, stop.color) >= 4.5, stop.background);
    const [red, green, blue] = rgb(stop.background);
    assert.ok(blue >= red && blue >= green, stop.background);
    assert.ok(stop.color === '#263746' || stop.color === '#ffffff');
  });
  assert.equal(colorScaleFill(0, null), null);
});

test('the settings help example is the workspace sheet the parser accepts', () => {
  const row = WORKSPACE_SHEET_HELP.exampleRow;
  const parsed = parseWorkspaceGrid({
    title: WORKSPACE_SHEET_HELP.tabExample,
    rows: [
      WORKSPACE_SHEET_HELP.exampleHeaders,
      [row.StudentId, row.SubjectChoice, row.Choice_choice2, row['Y10 GPA'], row.EEActive],
    ],
  });
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.rows[0].subjectChoices.choice1, 'History');
  assert.equal(parsed.rows[0].subjectChoices.choice2, 'Eng Lit');
  assert.equal(parsed.rows[0].subjectChoices.interdisciplinary, true);
  assert.equal(parsed.rows[0].dynamicData['Y10 GPA'], '3.4');
  assert.equal(parsed.rows[0].eeActive, true);
  assert.deepEqual(parsed.choiceKeys, ['choice1', 'choice2', 'interdisciplinary']);
  assert.equal(allocationTab(WORKSPACE_SHEET_HELP.tabExample)?.kind, 'workspace');
  assert.equal(allocationTab('COHORTDATA: 2026')?.cohortId, '2026');
  const json = JSON.parse(WORKSPACE_SHEET_HELP.jsonExample) as Record<string, unknown>;
  assert.equal(Array.isArray(json), false);
  assert.equal(json.choice1, 'History');
  assert.equal(json.choice2, 'Eng Lit');
  assert.equal(json.interdisciplinary, true);
  assert.match(WORKSPACE_SHEET_HELP.mappingNote, /No subject choices/);
  assert.match(WORKSPACE_SHEET_HELP.mappingNote, /Malformed JSON/);
  assert.match(WORKSPACE_SHEET_HELP.requiredColumn, /StudentId/);
  assert.match(WORKSPACE_SHEET_HELP.workspaceNote, /does not remove/);
  assert.match(WORKSPACE_SHEET_HELP.tokenNote, /does not remove/);
  assert.ok(WORKSPACE_SHEET_HELP.choiceHeaders.includes('SubjectChoice'));
  assert.ok(WORKSPACE_SHEET_HELP.choiceColumnPrefixes.includes('Choice_'));
});

test('requested subjects unwrap JSON cells and Choice columns into catalogue names', () => {
  const subjects = [
    { 'Subject ID': 'psy', Name: 'Psychology', Colour: '#6B4C9A', Active: true },
    { 'Subject ID': 'thr', Name: 'Theater', Active: true },
  ];
  assert.deepEqual(requestedSubjectNames({
    choice1: '["Psychology","Theater"]',
    interdisciplinary: true,
  }, { primaryChoiceKey: 'choice1', interdisciplinaryKey: 'interdisciplinary' }), ['Psychology', 'Theater']);
  assert.deepEqual(requestedSubjectNames({
    choice2: '{"subject":"Theater"}',
  }, { secondaryChoiceKey: 'choice2' }), ['Theater']);
  const resolved = resolveRequestedSubjects({
    choice1: '{"name":"psychology"}',
    Choice_subjects: '["Psychology","Theater"]',
  }, { primaryChoiceKey: 'choice1' }, subjects);
  assert.equal(resolved[0].name, 'Psychology');
  assert.equal(resolved[0].colour, '#6b4c9a');
  assert.equal(resolved[1].name, 'Theater');
  assert.equal(resolved[1].colour, '#0e8a6a');
  const desk = buildDesk({
    cohortId: '2026',
    members: [{ StudentId: JANE, Surname: 'Doe', 'First Name': 'Jane', eeActive: true }],
    workspaces: [{
      studentId: JANE,
      subjectChoices: { choice1: '[object Object]', interdisciplinary: 'deciding' },
      dynamicData: {},
      pendingClear: false,
      updatedAt: '',
    }],
    tokens: [],
    staff: [],
    settings: mergeDetected(emptySettings(), ['choice1', 'interdisciplinary'], []),
    subjects,
    choiceSources: new Map([[JANE, { choice1: { subject: 'Psychology' }, choice2: 'Theater', interdisciplinary: 'deciding' }]]),
  });
  assert.deepEqual(desk.students[0].requestedSubjects.map((item) => item.name), ['Psychology', 'Theater']);
  assert.equal(desk.students[0].choices.interdisciplinary, true);
  assert.equal(interdisciplinarySignal('no'), false);
  assert.equal(interdisciplinarySignal(true), true);
});

test('token load keeps a comma-joined subject string as one entry and still lists real arrays', () => {
  assert.deepEqual(subjectLoadNames('Mathematics, Analysis and approaches'), ['Mathematics, Analysis and approaches']);
  assert.deepEqual(subjectLoadNames(['Mathematics, Analysis and approaches', 'Biology']), ['Mathematics, Analysis and approaches', 'Biology']);
  assert.deepEqual(subjectLoadNames('["Theatre / Film","Biology"]'), ['Theatre / Film', 'Biology']);
  const joined = subjectTokenLoad([{ status: 'available', eligibleSubjects: 'Mathematics, Analysis and approaches' }]);
  assert.equal(joined.overlaps, false);
  assert.deepEqual(joined.subjects, [{ subject: 'Mathematics, Analysis and approaches', remaining: 1, pool: 0, upool: 0, alloc: 0 }]);
  const stored = tokenFromDoc({
    id: 't1',
    staffId: SMITH,
    status: 'available',
    eligibleSubjects: 'Mathematics, Analysis and approaches',
  });
  assert.deepEqual(stored?.eligibleSubjects, ['Mathematics, Analysis and approaches']);
  const listed = tokenFromDoc({
    id: 't2',
    staffId: SMITH,
    status: 'available',
    eligibleSubjects: ['History', 'Geography'],
  });
  assert.deepEqual(listed?.eligibleSubjects, ['History', 'Geography']);
});

test('a subject name that contains commas stays one requested subject and one token-load row', () => {
  const name = 'Sports, Exercise, and Health Science (SEHS)';
  assert.equal(keepLiteralSubject(name), true);
  assert.equal(keepLiteralSubject('English, History'), false);
  assert.deepEqual(parseSubjectCell(name), [name]);
  assert.deepEqual(parseSubjectCell('English, History'), ['English', 'History']);
  assert.deepEqual(parseSubjectCell(`"${name}", Biology`), [name, 'Biology']);
  assert.deepEqual(requestedSubjectNames({ choice1: name }, { primaryChoiceKey: 'choice1' }), [name]);
  const load = subjectTokenLoad([
    { status: 'available', eligibleSubjects: [name] },
    { status: 'draft', eligibleSubjects: [name], assignedSubject: name },
  ], [
    { subjects: [name], allocated: false },
    { subjects: [name, 'Biology'], allocated: true, assignedSubject: name },
  ]);
  assert.deepEqual(load.subjects.find((item) => item.subject === name), {
    subject: name,
    remaining: 1,
    pool: 2,
    upool: 1,
    alloc: 1,
  });
  assert.deepEqual(supportFlagTags('EAL, SEN, EAL'), ['EAL', 'SEN']);
  assert.deepEqual(supportFlagTags('Needs Support'), ['Needs support']);
  assert.equal(strictInterdisciplinaryValue('Yes'), 'Yes');
  assert.equal(strictInterdisciplinaryValue('yes'), null);
  assert.equal(strictInterdisciplinaryValue('No'), 'No');
});

test('a draft is refused when the EE subject does not match the supervisor token', () => {
  const tokens = [token({ id: 's1', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] })];
  const refused = planDraft({
    studentId: JANE,
    staffId: SMITH,
    subject: 'Biology',
    tokens,
    memberSupervisorId: '',
    pendingClear: false,
  });
  assert.equal(refused.changed, false);
  assert.match(refused.error, /does not match/);
  const marked = planDraft({
    studentId: JANE,
    staffId: SMITH,
    subject: 'History',
    tokens,
    memberSupervisorId: '',
    pendingClear: false,
    interdisciplinary: true,
  });
  assert.equal(marked.tokens[0].interdisciplinary, true);
  assert.equal(marked.tokens[0].assignedSubject, 'History');
  const saved = applySavedConfig(mergeDetected(emptySettings(), ['choice1'], ['Notes']), {
    primaryChoiceKey: 'choice1',
    columns: [{ key: 'Notes', showOnCard: false, filterable: false, sortable: false, expanded: true }],
  });
  assert.equal(saved.columns.find((column) => column.key === 'Notes')?.expanded, true);
  assert.equal(saved.liveSheetUrl, '');
  assert.deepEqual(saved.columnMappings, emptyColumnMappings());
});

test('live sheet mappings merge choice data onto static auxiliary columns', () => {
  const headers = ['Student Number', 'Student Email', 'First choice', 'HL subjects', 'Mentor note'];
  const mappings = columnMappingsFrom({
    core: { studentNumber: 'Student Number', studentEmail: 'Student Email' },
    subjectChoice: { primary: 'First choice' },
    dashboard: { hl: 'HL subjects' },
  });
  assert.match(liveLinkProblems(emptyColumnMappings(), headers)[0], /Student Number or Student Email/);
  assert.match(liveLinkProblems(columnMappingsFrom({ core: { studentEmail: 'Student Email' } }), headers)[0], /Primary choice/);
  assert.deepEqual(liveLinkProblems(mappings, headers), []);
  assert.match(liveLinkProblems(mappings, ['Student Email'])[0], /not on this sheet/);

  const parsed = parseLiveSheet({
    title: 'Choices',
    rows: [
      headers,
      ['20260001', JANE, 'Physics', 'Bio', 'Bring sources'],
      ['', '', '', '', ''],
      ['999', 'missing@vsa.edu', 'Art', '', ''],
    ],
  }, mappings);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].line, 2);
  assert.equal(parsed.rows[1].line, 4);
  assert.equal(parsed.rows[0].fields['Mentor note'], 'Bring sources');
  assert.equal(parsed.rows[0].fields['HL subjects'], 'Bio');
  assert.equal(parsed.rows[0].fields['First choice'], undefined);
  assert.equal(parsed.rows[0].fields['Student Email'], undefined);
  const settings = settingsForLiveLink(emptySettings(), 'https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit', 'abc123_XYZ-000000000000', 'Choices', mappings, headers);
  assert.equal(liveSheetLinked(settings), true);
  assert.equal(settings.primaryChoiceKey, 'choice1');
  assert.equal(settings.hlColumn, 'HL subjects');
  assert.equal(settings.sheetName, 'Choices');
  assert.ok(settings.detectedDynamicKeys.includes('Mentor note'));
  assert.ok(settings.detectedDynamicKeys.includes('HL subjects'));
  assert.equal(settings.detectedDynamicKeys.includes('First choice'), false);
  assert.equal(settings.detectedDynamicKeys.includes('Student Email'), false);
  assert.equal(settings.columns.find((column) => column.key === 'Mentor note')?.source, 'live');
  assert.equal(settings.columns.find((column) => column.key === 'HL subjects')?.source, 'live');
  assert.equal(settings.liveSheetTab, 'Choices');
  const index = indexLiveRoster([
    { studentId: JANE, studentNumber: '20260001', studentEmail: '' },
    { studentId: MARK, studentNumber: '', studentEmail: '' },
  ]);
  assert.equal(resolveLiveStudent(parsed.rows[0], index, mappings).studentId, JANE);
  assert.match(resolveLiveStudent(parsed.rows[1], index, mappings).warning, /not on the roster/);
  const emailOnly = columnMappingsFrom({
    core: { studentEmail: 'Student Email' },
    subjectChoice: { primary: 'First choice' },
  });
  const emailRow = parseLiveSheet({ title: 'Choices', rows: [headers, ['', MARK, 'Art', '']] }, emailOnly).rows[0];
  assert.equal(resolveLiveStudent(emailRow, index, emailOnly).studentId, MARK);
  const merged = mergeLiveChoiceRow({
    studentId: JANE,
    subjectChoices: { choice1: 'History', choice2: 'Eng Lit' },
    dynamicData: { 'Y10 GPA': 'Weak' },
    pendingClear: true,
    updatedAt: '',
  }, parsed.rows[0], settings, JANE, '2026-10-29T00:00:00.000Z');
  assert.equal(merged.subjectChoices.choice1, 'Physics');
  assert.equal(merged.subjectChoices.choice2, 'Eng Lit');
  assert.equal(merged.dynamicData['Y10 GPA'], 'Weak');
  assert.equal(merged.dynamicData['HL subjects'], 'Bio');
  assert.equal(merged.dynamicData['Mentor note'], 'Bring sources');
  assert.equal(merged.pendingClear, true);
  const roundTrip = settingsFromDoc(settings);
  assert.equal(roundTrip.spreadsheetId, settings.spreadsheetId);
  assert.equal(roundTrip.columnMappings.subjectChoice.primary, 'First choice');
  const kept = applySavedConfig(roundTrip, { primaryChoiceKey: 'choice1', columns: [] });
  assert.equal(kept.liveSheetUrl, settings.liveSheetUrl);
  assert.equal(kept.columnMappings.dashboard.hl, 'HL subjects');
  const staticAgain = mergeStaticWorkspaceRow({
    studentId: JANE,
    subjectChoices: { choice1: 'Art', choice2: 'Drama' },
    dynamicData: { 'Y10 GPA': 'Strong' },
    eeActive: null,
  }, merged, kept, '2026-10-29T01:00:00.000Z');
  assert.equal(staticAgain.subjectChoices.choice1, 'Physics');
  assert.equal(staticAgain.subjectChoices.choice2, 'Drama');
  assert.equal(staticAgain.dynamicData['Y10 GPA'], 'Strong');
  assert.equal(staticAgain.dynamicData['HL subjects'], 'Bio');
  assert.equal(staticAgain.dynamicData['Mentor note'], 'Bring sources');
});

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function contrastRatio(background: string, foreground: string): number {
  const lighter = Math.max(relativeLuminance(background), relativeLuminance(foreground));
  const darker = Math.min(relativeLuminance(background), relativeLuminance(foreground));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
