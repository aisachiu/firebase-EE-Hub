import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKSPACE_SHEET_HELP } from './workspaceSheetHelp';
import {
  allocationExportRows,
  allocationTab,
  parseAllocationDraftGrid,
  planAllocationDraftIngest,
  planDraftTokenBackfill,
  applySavedConfig,
  buildDesk,
  choiceMatchFlag,
  columnMappingsFrom,
  emptyColumnMappings,
  COLOR_SCALE_STOPS,
  colorScaleFill,
  columnScaleExtent,
  diplomaLevelFlag,
  dashboardFieldKeys,
  emptySettings,
  findAllocationTab,
  isEeActive,
  indexLiveRoster,
  liveLinkProblems,
  liveSheetLinked,
  liveSyncAge,
  liveSyncCooldownError,
  liveWorkspaceDirty,
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
  planReopen,
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
  orderSubjectsForColours,
  spectrumColours,
  subjectNamesForLoad,
  subjectTokenLoad,
  subjectLoadNames,
  staffQuotaTokenRows,
  subjectsOverlap,
  tokenSheetRows,
  tokenFromDoc,
  departmentKey,
  departmentOfSubject,
  departmentsMatch,
  hodSuggestionOverview,
  suggestionCapacity,
  tokenDepartmentNames,
  workspaceFromDoc,
  workspaceWithLegacyTokenInterdisciplinary,
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
  assert.equal(cleared.changed, false);
  assert.equal(cleared.code, 'locked');
  assert.match(cleared.error, /Unpublish/);

  const switched = planDraft({
    studentId: MARK, staffId: SMITH, subject: 'Geography', tokens, memberSupervisorId: DAVIS, pendingClear: false,
  });
  assert.equal(switched.code, 'locked');
  assert.equal(switched.changed, false);

  const reopened = planReopen(tokens, MARK);
  assert.equal(reopened.token?.status, 'draft');
  const unlocked = tokens.map((item) => (item.id === reopened.token?.id ? reopened.token : item));
  const released = planDraft({
    studentId: MARK, staffId: '', subject: '', tokens: unlocked, memberSupervisorId: DAVIS, pendingClear: false,
  });
  assert.equal(released.tokens[0].status, 'available');
  assert.equal(released.pendingClear, true);
  const moved = planDraft({
    studentId: MARK, staffId: SMITH, subject: 'Geography', tokens: unlocked, memberSupervisorId: DAVIS, pendingClear: false,
  });
  assert.equal(moved.pendingClear, false);
  assert.equal(moved.tokens.find((item) => item.id === 'd1')?.status, 'available');
  assert.equal(moved.tokens.find((item) => item.staffId === SMITH)?.allocatedTo, MARK);
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
    { subject: 'Art', remaining: 0, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 },
    { subject: 'Biology', remaining: 1, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 },
    { subject: 'Geography', remaining: 1, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 },
    { subject: 'History', remaining: 2, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 },
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
  const subset = planCommit(tokens, workspaces, [MARK]);
  assert.deepEqual(subset.assignments, []);
  assert.deepEqual(subset.clears, [MARK]);
  assert.equal(publishedAllocationSubject('History', { choice1: 'Biology' }, 'choice1'), 'History');
  assert.equal(publishedAllocationSubject('', { choice1: 'Biology' }, 'choice1'), 'Biology');
  assert.equal(publishedAllocationSubject('  ', { choice1: 'Biology' }, ''), '');
});

test('the desk marks first and second choice, their live-sheet scores, HL and SL subjects, and support flags', () => {
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
      subjectChoices: { choice1: 'History', choice2: 'Eng Lit', choice1_score: 'A-', choice2_score: 87.5, interdisciplinary: true },
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
  assert.equal(desk.students[0].flags.hlMatch, 'none');
  assert.equal(choiceMatchFlag('History', 'History', 'Eng Lit'), 'match');
  assert.equal(choiceMatchFlag('Eng Lit', 'History', 'Eng Lit'), 'second');
  assert.equal(choiceMatchFlag('Geography', 'History', 'Eng Lit'), 'miss');
  assert.equal(choiceMatchFlag('', 'History', 'Eng Lit'), 'none');
  assert.equal(choiceMatchFlag('Psychology', '["Psychology","Theater"]', ''), 'match');
  assert.equal(diplomaLevelFlag('History', { HL: 'History, Biology', 'SL subjects': 'Mathematics' }, 'HL'), 'match');
  assert.equal(diplomaLevelFlag('Mathematics', { HL: 'History, Biology', 'SL subjects': 'Mathematics' }, 'HL'), 'sl');
  assert.equal(diplomaLevelFlag('Geography', { HL: 'History, Biology', 'SL subjects': 'Mathematics' }, 'HL'), 'miss');
  assert.equal(diplomaLevelFlag('History', { HL: 'Bio, Chem' }, 'HL'), 'none');
  assert.equal(diplomaLevelFlag('Biology', { Subjects: 'Biology (HL), History (SL), Mathematics SL' }, ''), 'match');
  assert.equal(diplomaLevelFlag('History', { Subjects: 'Biology (HL), History (SL), Mathematics SL' }, ''), 'sl');
  assert.equal(diplomaLevelFlag('Art', { Subjects: 'Biology (HL), History (SL), Mathematics SL' }, ''), 'miss');
  assert.equal(desk.students[0].flags.needsSupport, true);
  assert.equal(desk.students[0].choices.primaryScore, 'A-');
  assert.equal(desk.students[0].choices.secondaryScore, '87.5');
  assert.equal(desk.students[0].choices.interdisciplinary, true);
  assert.equal(desk.supervisors[0].displayName, 'Mr. Smith');
  assert.equal(desk.supervisors[0].used, 1);
  assert.deepEqual(desk.tokenSlots, [{ status: 'draft', eligibleSubjects: ['History', 'Geography'] }]);
  assert.deepEqual(subjectTokenLoad(desk.tokenSlots).subjects, [
    { subject: 'Geography', remaining: 0, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 },
    { subject: 'History', remaining: 0, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 },
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
  assert.equal(saved.primaryChoiceScoreKey, 'choice1_score');
  assert.equal(saved.secondaryChoiceScoreKey, 'choice2_score');
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

test('requested subjects ignore choice score fields regardless of value type', () => {
  const settings = {
    primaryChoiceKey: 'choice1',
    secondaryChoiceKey: 'choice2',
    primaryChoiceScoreKey: 'choice1_score',
    secondaryChoiceScoreKey: 'choice2_score',
  };
  assert.deepEqual(requestedSubjectNames({
    choice1: 'Economics',
    choice2: 'History',
    choice1_score: '6',
    choice2_score: '-',
  }, settings), ['Economics', 'History']);
  assert.deepEqual(requestedSubjectNames({
    choice1: 'Economics',
    choice2: 'History',
    choice1_score: 6,
  }, settings), ['Economics', 'History']);
  assert.deepEqual(requestedSubjectNames({
    choice1: 'Economics',
    choice2: 'History',
  }, settings), ['Economics', 'History']);
  assert.deepEqual(requestedSubjectNames({
    choice1: 'Economics',
    choice2: 'History',
    custom_score_field: 'A',
  }, { ...settings, primaryChoiceScoreKey: 'custom_score_field' }), ['Economics', 'History']);
});

test('token load keeps a comma-joined subject string as one entry and still lists real arrays', () => {
  assert.deepEqual(subjectLoadNames('Mathematics, Analysis and approaches'), ['Mathematics, Analysis and approaches']);
  assert.deepEqual(subjectLoadNames(['Mathematics, Analysis and approaches', 'Biology']), ['Mathematics, Analysis and approaches', 'Biology']);
  assert.deepEqual(subjectLoadNames('["Theatre / Film","Biology"]'), ['Theatre / Film', 'Biology']);
  const joined = subjectTokenLoad([{ status: 'available', eligibleSubjects: 'Mathematics, Analysis and approaches' }]);
  assert.equal(joined.overlaps, false);
  assert.deepEqual(joined.subjects, [{ subject: 'Mathematics, Analysis and approaches', remaining: 1, pool: 0, upool: 0, alloc: 0, poolChoice1: 0, upoolChoice1: 0 }]);
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
    poolChoice1: 0,
    upoolChoice1: 0,
  });
  const plain = 'Sports, Exercise, and Health Science';
  const fragments = ['Sports', 'Exercise', 'and Health Science'];
  assert.deepEqual(subjectNamesForLoad(fragments, [plain, name, 'Biology']), [plain]);
  assert.deepEqual(subjectNamesForLoad(`${name}, Biology`, [name, 'Biology']), [name, 'Biology']);
  assert.deepEqual(subjectNamesForLoad('English, History', ['English', 'History']), ['English', 'History']);
  const rejoined = subjectTokenLoad([
    { status: 'available', eligibleSubjects: fragments },
  ], [{ subjects: fragments, allocated: false }], [plain]);
  assert.deepEqual(rejoined.subjects.map((item) => item.subject), [plain]);
  assert.equal(rejoined.subjects[0].remaining, 1);
  assert.equal(rejoined.subjects[0].pool, 1);
  const colourOrder = orderSubjectsForColours([
    { 'Subject ID': 'art', Name: 'Art', Department: 'Arts' },
    { 'Subject ID': 'bio', Name: 'Biology', Department: 'Science' },
    { 'Subject ID': 'chem', Name: 'Chemistry', Department: 'Science' },
    { 'Subject ID': 'blank', Name: '' },
  ], ['chem', 'bio', 'missing', 'chem']);
  assert.deepEqual(colourOrder.map((row) => row['Subject ID']), ['chem', 'bio', 'art']);
  assert.deepEqual(orderSubjectsForColours(colourOrder, []).map((row) => row.Name), ['Art', 'Biology', 'Chemistry']);
  const colours = spectrumColours(6);
  assert.equal(colours.length, 6);
  assert.equal(new Set(colours).size, 6);
  colours.forEach((colour) => assert.match(colour, /^#[0-9a-f]{6}$/));
  assert.notEqual(colours[0], colours[3]);
  assert.deepEqual(supportFlagTags('EAL, SEN, EAL'), ['EAL', 'SEN']);
  assert.deepEqual(supportFlagTags('Needs Support'), ['Needs support']);
  assert.equal(strictInterdisciplinaryValue('Yes'), 'Yes');
  assert.equal(strictInterdisciplinaryValue('yes'), null);
  assert.equal(strictInterdisciplinaryValue('No'), 'No');
});

test('a batch override assigns the teacher token when the requested subject does not match', () => {
  const tokens = [
    token({ id: 'held', staffId: DAVIS, status: 'committed', allocatedTo: JANE, assignedSubject: 'Art', eligibleSubjects: ['Art'] }),
    token({ id: 'open', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] }),
    token({ id: 'open2', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] }),
  ];
  const refused = planBatchDraft({
    studentIds: [MARK],
    staffId: SMITH,
    subjects: { [MARK]: 'Biology' },
    tokens,
    supervisorByStudent: {},
    pendingClearByStudent: {},
  });
  assert.deepEqual(refused.assigned, []);
  assert.match(refused.skipped[0].reason, /does not match/);
  const overridden = planBatchDraft({
    studentIds: [JANE, MARK],
    staffId: SMITH,
    subjects: { [JANE]: 'History', [MARK]: 'Biology' },
    tokens,
    supervisorByStudent: {},
    pendingClearByStudent: {},
    overrideSubject: true,
  });
  assert.deepEqual(overridden.assigned, [MARK]);
  assert.match(overridden.skipped[0].reason, /published/);
  assert.equal(overridden.tokenWrites[0].allocatedTo, MARK);
  assert.equal(overridden.tokenWrites[0].assignedSubject, 'History');
  assert.equal(overridden.tokenWrites[0].status, 'draft');
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
    interdisciplinarySubject: 'Eng Lit',
  });
  assert.equal(Object.hasOwn(marked.tokens[0], 'interdisciplinary'), false);
  assert.equal(Object.hasOwn(marked.tokens[0], 'interdisciplinarySubject'), false);
  assert.equal(marked.tokens[0].assignedSubject, 'History');
  const cleared = planDraft({
    studentId: JANE,
    staffId: SMITH,
    subject: 'History',
    tokens: marked.tokens,
    memberSupervisorId: '',
    pendingClear: false,
    interdisciplinary: false,
    interdisciplinarySubject: 'Eng Lit',
  });
  assert.equal(cleared.changed, false);
  const saved = applySavedConfig(mergeDetected(emptySettings(), ['choice1'], ['Notes']), {
    primaryChoiceKey: 'choice1',
    columns: [{ key: 'Notes', showOnCard: false, filterable: false, sortable: false, expanded: true }],
  });
  assert.equal(saved.columns.find((column) => column.key === 'Notes')?.expanded, true);
  assert.equal(saved.liveSheetUrl, '');
  assert.deepEqual(saved.columnMappings, emptyColumnMappings());
});

test('live sheet mappings merge choice data and scores onto static auxiliary columns', () => {
  const headers = ['Student Number', 'Student Email', 'First choice', 'Choice 1 Score', 'Choice 2 Score', 'HL subjects', 'Mentor note'];
  const mappings = columnMappingsFrom({
    core: { studentNumber: 'Student Number', studentEmail: 'Student Email' },
    subjectChoice: { primary: 'First choice', primaryScore: 'Choice 1 Score', secondaryScore: 'Choice 2 Score' },
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
      ['20260001', JANE, 'Physics', 'A-', 87.5, 'Bio', 'Bring sources'],
      ['', '', '', '', ''],
      ['999', 'missing@vsa.edu', 'Art', '', '', '', ''],
    ],
  }, mappings);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].line, 2);
  assert.equal(parsed.rows[1].line, 4);
  assert.equal(parsed.rows[0].fields['Mentor note'], 'Bring sources');
  assert.equal(parsed.rows[0].fields['HL subjects'], 'Bio');
  assert.equal(parsed.rows[0].fields['First choice'], 'Physics');
  assert.equal(parsed.rows[0].primaryScore, 'A-');
  assert.equal(parsed.rows[0].secondaryScore, 87.5);
  assert.equal(parsed.rows[0].fields['Student Email'], undefined);
  const settings = settingsForLiveLink(emptySettings(), 'https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit', 'abc123_XYZ-000000000000', 'Choices', mappings, headers);
  assert.equal(liveSheetLinked(settings), true);
  assert.equal(settings.primaryChoiceKey, 'choice1');
  assert.equal(settings.primaryChoiceScoreKey, 'choice1_score');
  assert.equal(settings.secondaryChoiceScoreKey, 'choice2_score');
  assert.ok(settings.detectedChoiceKeys.includes('choice1_score'));
  assert.ok(settings.detectedChoiceKeys.includes('choice2_score'));
  assert.equal(settings.hlColumn, 'HL subjects');
  assert.equal(settings.sheetName, 'Choices');
  assert.ok(settings.detectedDynamicKeys.includes('Mentor note'));
  assert.ok(settings.detectedDynamicKeys.includes('HL subjects'));
  assert.equal(settings.detectedDynamicKeys.includes('First choice'), true);
  assert.equal(settings.detectedDynamicKeys.includes('Student Email'), false);
  assert.ok(dashboardFieldKeys(settings).includes('First choice'));
  assert.ok(dashboardFieldKeys(settings).includes('choice1'));
  assert.equal(dashboardFieldKeys(settings).includes('Student Email'), false);
  assert.equal(settings.columns.find((column) => column.key === 'First choice')?.source, 'live');
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
  const emailRow = parseLiveSheet({ title: 'Choices', rows: [headers, ['', MARK, 'Art', '', '', '', '']] }, emailOnly).rows[0];
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
  assert.equal(merged.subjectChoices.choice1_score, 'A-');
  assert.equal(merged.subjectChoices.choice2_score, 87.5);
  assert.equal(merged.dynamicData['Y10 GPA'], 'Weak');
  assert.equal(merged.dynamicData['HL subjects'], 'Bio');
  assert.equal(merged.dynamicData['Mentor note'], 'Bring sources');
  assert.equal(merged.dynamicData['First choice'], 'Physics');
  assert.equal(merged.pendingClear, true);
  assert.equal(liveWorkspaceDirty(undefined, merged), true);
  assert.equal(liveWorkspaceDirty({ ...merged, updatedAt: 'earlier' }, { ...merged, updatedAt: 'later' }), false);
  assert.equal(liveWorkspaceDirty(merged, { ...merged, subjectChoices: { ...merged.subjectChoices, choice1: 'Art' } }), true);
  const fresh = liveSyncAge('', Date.parse('2026-10-29T00:01:00.000Z'));
  assert.equal(fresh.blocked, false);
  assert.equal(fresh.label, '');
  const recent = liveSyncAge('2026-10-29T00:00:45.000Z', Date.parse('2026-10-29T00:01:00.000Z'));
  assert.equal(recent.blocked, true);
  assert.equal(recent.secondsAgo, 15);
  assert.equal(recent.label, 'Last synced 15 seconds ago');
  assert.match(liveSyncCooldownError('2026-10-29T00:00:45.000Z', Date.parse('2026-10-29T00:01:00.000Z')), /Last synced 15 seconds ago/);
  const cooled = liveSyncAge('2026-10-29T00:00:00.000Z', Date.parse('2026-10-29T00:01:00.000Z'));
  assert.equal(cooled.blocked, false);
  assert.equal(cooled.secondsAgo, 60);
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
  assert.equal(staticAgain.dynamicData['First choice'], 'Physics');
});

test('pool and upool count first-choice requests separately from every request', () => {
  const load = subjectTokenLoad([
    { status: 'available', eligibleSubjects: ['History'] },
  ], [
    { subjects: ['History', 'Biology'], primary: 'History', allocated: false },
    { subjects: ['History'], primary: 'Biology', allocated: false },
    { subjects: ['History'], primary: 'History', allocated: true, assignedSubject: 'History' },
    { subjects: ['Biology'], primary: 'Biology', allocated: true },
  ]);
  const history = load.subjects.find((item) => item.subject === 'History');
  const biology = load.subjects.find((item) => item.subject === 'Biology');
  assert.equal(history?.pool, 3);
  assert.equal(history?.poolChoice1, 2);
  assert.equal(history?.upool, 2);
  assert.equal(history?.upoolChoice1, 1);
  assert.equal(biology?.pool, 2);
  assert.equal(biology?.poolChoice1, 1);
  assert.equal(biology?.upool, 1);
  assert.equal(biology?.upoolChoice1, 0);
});

test('workspace fields round-trip and survive choice merges', () => {
  const round = workspaceFromDoc({
    selectedSubject: 'History',
    suggestedStaffId: 'Smith@Vsa.edu',
    suggestedSubject: 'History',
    isFlagged: true,
    flagNote: 'Check the proposal',
  }, JANE);
  assert.equal(round.studentId, JANE);
  assert.equal(round.selectedSubject, 'History');
  assert.equal(round.suggestedStaffId, SMITH);
  assert.equal(round.suggestedSubject, 'History');
  assert.equal(round.isFlagged, true);
  assert.equal(round.flagNote, 'Check the proposal');
  const legacy = workspaceFromDoc({}, JANE);
  assert.equal(legacy.selectedSubject, '');
  assert.equal(legacy.suggestedStaffId, '');
  assert.equal(legacy.suggestedSubject, '');
  assert.equal(legacy.isFlagged, false);
  assert.equal(legacy.flagNote, '');
  const settings = settingsForLiveLink(emptySettings(), 'https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit', 'abc123_XYZ-000000000000', 'Choices', columnMappingsFrom({
    core: { studentNumber: 'Student Number' },
    subjectChoice: { primary: 'First choice' },
  }), ['Student Number', 'First choice']);
  const prior: WorkspaceRecord = {
    ...legacy,
    subjectChoices: { choice1: 'History' },
    isFlagged: true,
    flagNote: 'Keep me',
    selectedSubject: 'History',
    suggestedStaffId: SMITH,
    suggestedSubject: 'History',
  };
  const live = mergeLiveChoiceRow(prior, {
    line: 2,
    studentNumber: '20260001',
    studentEmail: '',
    primary: 'Physics',
    secondary: '',
    primaryScore: '',
    secondaryScore: '',
    interdisciplinary: '',
    hl: '',
    support: '',
    fields: {},
  }, settings, JANE, '2026-11-04T00:00:00.000Z');
  assert.equal(live.subjectChoices.choice1, 'Physics');
  assert.equal(live.selectedSubject, 'History');
  assert.equal(live.suggestedStaffId, SMITH);
  assert.equal(live.suggestedSubject, 'History');
  assert.equal(live.isFlagged, true);
  assert.equal(live.flagNote, 'Keep me');
  const again = mergeStaticWorkspaceRow({
    studentId: JANE,
    subjectChoices: { choice1: 'Art' },
    dynamicData: {},
    eeActive: null,
  }, live, settings, '2026-11-04T01:00:00.000Z');
  assert.equal(again.subjectChoices.choice1, 'Physics');
  assert.equal(again.selectedSubject, 'History');
  assert.equal(again.suggestedStaffId, SMITH);
  assert.equal(again.isFlagged, true);
  assert.equal(again.flagNote, 'Keep me');
});

test('department match is case-insensitive and a token can sit in two departments', () => {
  const catalogue = [
    { name: 'History', department: 'Humanities' },
    { name: 'Biology', department: 'Science' },
    { name: 'Art', department: '  ' },
  ];
  assert.equal(departmentKey(' Humanities '), 'humanities');
  assert.equal(departmentsMatch('Humanities', ' humanities '), true);
  assert.equal(departmentsMatch('', 'Science'), false);
  assert.equal(departmentsMatch('Art', ''), false);
  assert.equal(departmentOfSubject('History', catalogue), 'Humanities');
  assert.equal(departmentOfSubject('Art', catalogue), '');
  assert.deepEqual(tokenDepartmentNames(['History', 'Biology'], catalogue), ['Humanities', 'Science']);
  assert.deepEqual(tokenDepartmentNames(['Art'], catalogue), []);
  assert.deepEqual(tokenDepartmentNames([], catalogue), []);
});

test('suggestion capacity counts unrealized suggestions once and ignores an approved assignment', () => {
  const tokens = [
    { staffId: SMITH, status: 'available', eligibleSubjects: ['History'], allocatedTo: '' },
    { staffId: SMITH, status: 'draft', eligibleSubjects: ['History'], allocatedTo: JANE },
  ];
  const open = suggestionCapacity({
    staffId: SMITH,
    subject: 'History',
    tokens: [tokens[0]],
    suggestions: [
      { studentId: JANE, suggestedStaffId: SMITH, suggestedSubject: 'History' },
    ],
    exceptStudentId: MARK,
  });
  assert.equal(open.eligible, true);
  assert.equal(open.open, 1);
  assert.equal(open.held, 1);
  assert.equal(open.remaining, 0);
  const second = suggestionCapacity({
    staffId: SMITH,
    subject: 'History',
    tokens: [tokens[0]],
    suggestions: [
      { studentId: JANE, suggestedStaffId: SMITH, suggestedSubject: 'History' },
    ],
    exceptStudentId: JANE,
  });
  assert.equal(second.remaining, 1);
  const approved = suggestionCapacity({
    staffId: SMITH,
    subject: 'History',
    tokens,
    suggestions: [
      { studentId: JANE, suggestedStaffId: SMITH, suggestedSubject: 'History' },
    ],
    exceptStudentId: MARK,
  });
  assert.equal(approved.open, 1);
  assert.equal(approved.held, 0);
  assert.equal(approved.remaining, 1);
  const outside = suggestionCapacity({
    staffId: SMITH,
    subject: 'Biology',
    tokens: [tokens[0]],
    suggestions: [],
  });
  assert.equal(outside.eligible, false);
});

test('subject token load counts each student once by selected subject', () => {
  const load = subjectTokenLoad([
    { status: 'available', eligibleSubjects: ['History'] },
    { status: 'draft', eligibleSubjects: ['Biology'], assignedSubject: 'Biology' },
  ], [
    { subjects: ['History', 'Biology'], selectedSubject: 'History', primary: 'History', allocated: false },
    { subjects: ['History', 'Biology'], selectedSubject: 'Biology', primary: 'History', allocated: true },
    { subjects: ['History', 'Biology'], selectedSubject: '', primary: 'Biology', allocated: false },
  ]);
  const history = load.subjects.find((item) => item.subject === 'History');
  const biology = load.subjects.find((item) => item.subject === 'Biology');
  assert.equal(history?.pool, 1);
  assert.equal(history?.poolChoice1, 1);
  assert.equal(history?.upool, 1);
  assert.equal(history?.alloc, 0);
  assert.equal(history?.remaining, 1);
  assert.equal(biology?.pool, 1);
  assert.equal(biology?.alloc, 1);
  assert.equal(biology?.upool, 0);
  assert.equal(load.subjects.some((item) => item.pool > 1), false);
});

test('the desk exposes a suggestion without treating it as a held token', () => {
  const settings = mergeDetected(emptySettings(), ['choice1', 'choice2'], []);
  const desk = buildDesk({
    cohortId: '2026',
    members: [{ StudentId: JANE, Surname: 'Doe', 'First Name': 'Jane', eeActive: true }],
    workspaces: [{
      studentId: JANE,
      subjectChoices: { choice1: 'History', choice2: 'Biology' },
      dynamicData: {},
      pendingClear: false,
      selectedSubject: 'History',
      suggestedStaffId: SMITH,
      suggestedSubject: 'History',
      isFlagged: true,
      flagNote: 'Look again',
      updatedAt: '',
    }],
    tokens: [token({ id: 'open', staffId: SMITH, status: 'available', eligibleSubjects: ['History', 'Biology'] })],
    staff: [{ email: SMITH, displayName: 'Mr. Smith', department: 'Humanities', isHOD: true }],
    settings,
    subjects: [
      { Name: 'History', Department: 'Humanities', Active: true },
      { Name: 'Biology', Department: 'Science', Active: true },
    ],
  });
  assert.equal(desk.students[0].token, null);
  assert.equal(desk.students[0].selectedSubject, 'History');
  assert.equal(desk.students[0].suggestedStaffId, SMITH);
  assert.equal(desk.students[0].suggestedStaffName, 'Mr. Smith');
  assert.equal(desk.students[0].isFlagged, true);
  assert.equal(desk.subjects.find((item) => item.name === 'History')?.department, 'Humanities');
  assert.equal(desk.directory[0].isHOD, true);
  const overview = hodSuggestionOverview({
    department: 'Humanities',
    catalogue: desk.subjects.map((item) => ({ name: item.name, department: item.department })),
    tokens: desk.tokenRows,
    students: desk.students.map((student) => ({
      studentId: student.studentId,
      displayName: student.displayName,
      suggestedStaffId: student.suggestedStaffId,
      suggestedSubject: student.suggestedSubject,
      tokenStaffId: student.token?.staffId || '',
    })),
    staff: [{ staffId: SMITH, displayName: 'Mr. Smith' }],
  });
  assert.equal(overview.subjects.find((item) => item.subject === 'History')?.taken, 1);
  assert.equal(overview.subjects.find((item) => item.subject === 'History')?.remaining, 0);
  assert.equal(overview.supervisors[0].students[0].displayName, 'Doe, Jane');
});

test('an interdisciplinary draft can take any available token', () => {
  const tokens = [token({ id: 'art', staffId: SMITH, status: 'available', eligibleSubjects: ['Art'] })];
  const refused = planDraft({
    studentId: JANE,
    staffId: SMITH,
    subject: 'History',
    tokens,
    memberSupervisorId: '',
    pendingClear: false,
    interdisciplinary: true,
    interdisciplinarySubject: 'Biology',
  });
  assert.match(refused.error, /does not match/);
  const allowed = planDraft({
    studentId: JANE,
    staffId: SMITH,
    subject: 'History',
    tokens,
    memberSupervisorId: '',
    pendingClear: false,
    interdisciplinary: true,
    interdisciplinarySubject: 'Biology',
    bypassSubject: true,
    tokenId: 'art',
  });
  assert.equal(allowed.changed, true);
  assert.equal(allowed.tokens[0].id, 'art');
  assert.equal(allowed.tokens[0].assignedSubject, 'History');
  assert.equal(Object.hasOwn(allowed.tokens[0], 'interdisciplinary'), false);
  assert.equal(Object.hasOwn(allowed.tokens[0], 'interdisciplinarySubject'), false);
});

test('interdisciplinary token eligibility includes the workspace second subject and migrates legacy token fields', () => {
  const secondSubjectToken = token({ id: 'biology', staffId: SMITH, status: 'available', eligibleSubjects: ['Biology'] });
  const matched = planDraft({
    studentId: JANE,
    staffId: SMITH,
    subject: 'History',
    tokens: [secondSubjectToken],
    memberSupervisorId: '',
    pendingClear: false,
    interdisciplinary: true,
    interdisciplinarySubject: 'Biology',
  });
  assert.equal(matched.changed, true);
  const legacyToken = tokenFromDoc({
    id: 'legacy',
    staffId: SMITH,
    allocatedTo: JANE,
    assignedSubject: 'History',
    status: 'draft',
    interdisciplinary: true,
    interdisciplinarySubject: 'Biology',
  });
  assert.ok(legacyToken);
  const workspace = workspaceWithLegacyTokenInterdisciplinary(workspaceFromDoc({}, JANE), legacyToken);
  assert.equal(workspace.selectedInterdisciplinary, true);
  assert.equal(workspace.interdisciplinarySubject, 'Biology');
});

test('allocation draft sheets export and ingest workspace interdisciplinary fields with draft allocations', () => {
  const rows = allocationExportRows([{
    studentId: JANE,
    displayName: 'Jane Doe',
    selectedSubject: 'History',
    selectedInterdisciplinary: true,
    interdisciplinarySubject: 'Theater',
    suggestedStaffId: SMITH,
    suggestedSubject: 'History',
    isFlagged: true,
    flagNote: 'keep',
    pendingClear: false,
    token: { staffId: SMITH, assignedSubject: 'History', status: 'draft' },
    flags: { drafted: true, committed: false },
    dynamicData: { 'Y10 GPA': 3.4, SelectedSubject: 'ignore' },
  } as never], {
    ...emptySettings(),
    columns: [
      { key: 'Y10 GPA', showOnCard: true, filterable: false, sortable: true, colorScale: false, expanded: false, source: 'static' },
      { key: 'SelectedSubject', showOnCard: true, filterable: false, sortable: false, colorScale: false, expanded: false, source: 'static' },
    ],
  });
  assert.deepEqual(rows[0].slice(0, 10), [
    'StudentId',
    'Display Name',
    'Status',
    'SupervisorEmail',
    'AssignedSubject',
    'SelectedSubject',
    'SuggestedStaffEmail',
    'SuggestedSubject',
    'SelectedInterdisciplinary',
    'InterdisciplinarySubject',
  ]);
  assert.equal(rows[0].includes('Y10 GPA'), true);
  assert.equal(rows[0].filter((header) => header === 'SelectedSubject').length, 1);
  assert.deepEqual(rows[0].slice(10, 13), ['IsFlagged', 'FlagNote', 'PendingClear']);
  assert.deepEqual(rows[1].slice(0, 13), [JANE, 'Jane Doe', 'Draft', SMITH, 'History', 'History', SMITH, 'History', true, 'Theater', true, 'keep', false]);
  assert.equal(rows[1][13], 3.4);
  assert.equal(allocationTab('ALLOCATIONS 2026')?.kind, 'drafts');
  assert.equal(allocationTab('ALLOCATIONS: 2026')?.cohortId, '2026');

  const parsed = parseAllocationDraftGrid({ title: 'ALLOCATIONS 2026', rows });
  assert.equal(parsed.warnings.length, 0);
  const clearRow = parseAllocationDraftGrid({
    title: 'ALLOCATIONS 2026',
    rows: [
      ['StudentId', 'SelectedInterdisciplinary', 'InterdisciplinarySubject'],
      [JANE, '', ''],
    ],
  });
  assert.equal(clearRow.rows[0].selectedInterdisciplinary, false);
  assert.equal(clearRow.rows[0].interdisciplinarySubject, '');
  const oldFormatRow = parseAllocationDraftGrid({
    title: 'ALLOCATIONS 2026',
    rows: [['StudentId'], [JANE]],
  });
  assert.equal(oldFormatRow.rows[0].selectedInterdisciplinary, undefined);
  assert.equal(oldFormatRow.rows[0].interdisciplinarySubject, undefined);
  const open = token({ id: 'open', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] });
  const kept = {
    studentId: JANE,
    subjectChoices: { choice1: 'History' },
    dynamicData: { 'Y10 GPA': 3.4 },
    pendingClear: false,
    isFlagged: true,
    flagNote: 'keep',
    selectedSubject: '',
    suggestedStaffId: '',
    suggestedSubject: '',
    updatedAt: '',
  };
  const plan = planAllocationDraftIngest({
    rows: parsed.rows,
    tokens: [open],
    workspaces: [kept],
    roster: [{ studentId: JANE }],
    activeSubjects: ['History', 'Theater'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(plan.writing, 1);
  assert.equal(plan.workspaceWrites[0].selectedSubject, 'History');
  assert.equal(plan.workspaceWrites[0].suggestedStaffId, SMITH);
  assert.equal(plan.workspaceWrites[0].suggestedSubject, 'History');
  assert.equal(plan.workspaceWrites[0].selectedInterdisciplinary, true);
  assert.equal(plan.workspaceWrites[0].interdisciplinarySubject, 'Theater');
  assert.equal(plan.workspaceWrites[0].isFlagged, true);
  assert.equal(plan.workspaceWrites[0].flagNote, 'keep');
  assert.equal(plan.workspaceWrites[0].dynamicData['Y10 GPA'], 3.4);
  assert.equal(plan.tokenWrites[0].allocatedTo, JANE);
  assert.equal(plan.tokenWrites[0].assignedSubject, 'History');
  assert.equal(plan.tokenWrites[0].status, 'draft');
  assert.equal(plan.draftChanges[0].after?.staffId, SMITH);

  const again = planAllocationDraftIngest({
    rows: parsed.rows,
    tokens: plan.tokenWrites,
    workspaces: plan.workspaceWrites,
    roster: [{ studentId: JANE }],
    activeSubjects: ['History', 'Theater'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(again.writing, 0);
  assert.equal(again.tokenWrites.length, 0);

  const cleared = planAllocationDraftIngest({
    rows: clearRow.rows,
    tokens: plan.tokenWrites,
    workspaces: plan.workspaceWrites,
    roster: [{ studentId: JANE }],
    activeSubjects: ['History', 'Theater'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(cleared.workspaceWrites[0].selectedInterdisciplinary, false);
  assert.equal(cleared.workspaceWrites[0].interdisciplinarySubject, '');

  const unchanged = planAllocationDraftIngest({
    rows: [{ studentId: JANE }],
    tokens: plan.tokenWrites,
    workspaces: plan.workspaceWrites,
    roster: [{ studentId: JANE }],
    activeSubjects: ['History', 'Theater'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(unchanged.writing, 0);
  assert.equal(unchanged.workspaceWrites.length, 0);
});

test('draft ingest leaves a published token in place and can release a draft', () => {
  const published = token({ id: 'pub', staffId: SMITH, status: 'committed', allocatedTo: JANE, assignedSubject: 'History' });
  const blocked = planAllocationDraftIngest({
    rows: [{ studentId: JANE, status: 'Draft', supervisorEmail: DAVIS, assignedSubject: 'History', selectedSubject: 'History' }],
    tokens: [published, token({ id: 'other', staffId: DAVIS, status: 'available', eligibleSubjects: ['History'] })],
    workspaces: [],
    roster: [{ studentId: JANE }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(blocked.tokenWrites.length, 0);
  assert.match(blocked.warnings.join(' '), /published allocation/);
  assert.equal(blocked.workspaceWrites[0].selectedSubject, 'History');

  const drafted = token({ id: 'draft', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'History' });
  const released = planAllocationDraftIngest({
    rows: [{ studentId: JANE, status: 'Unallocated', supervisorEmail: '', assignedSubject: '', selectedSubject: '' }],
    tokens: [drafted],
    workspaces: [{
      studentId: JANE,
      subjectChoices: {},
      dynamicData: {},
      pendingClear: false,
      selectedSubject: 'History',
      suggestedStaffId: SMITH,
      suggestedSubject: 'History',
      updatedAt: '',
    }],
    roster: [{ studentId: JANE, supervisorId: '' }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(released.tokenWrites[0].status, 'available');
  assert.equal(released.tokenWrites[0].allocatedTo, '');
  assert.equal(released.workspaceWrites[0].selectedSubject, '');
  assert.equal(released.workspaceWrites[0].suggestedStaffId, '');
});

test('an older allocation sheet without the new columns still restores the draft token', () => {
  const parsed = parseAllocationDraftGrid({
    title: 'ALLOCATIONS 2026',
    rows: [
      ['StudentId', 'Display Name', 'Status', 'SupervisorEmail', 'AssignedSubject'],
      [JANE, 'Jane Doe', 'Draft', SMITH, 'History'],
    ],
  });
  assert.equal(parsed.rows[0].selectedSubject, undefined);
  const plan = planAllocationDraftIngest({
    rows: parsed.rows,
    tokens: [token({ id: 'open', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] })],
    workspaces: [{
      studentId: JANE,
      subjectChoices: { choice1: 'Art' },
      dynamicData: { 'Y10 GPA': 3.4 },
      pendingClear: false,
      isFlagged: true,
      flagNote: 'stay',
      selectedSubject: 'Biology',
      suggestedStaffId: '',
      suggestedSubject: '',
      updatedAt: '',
    }],
    roster: [{ studentId: JANE }],
    activeSubjects: ['History', 'Biology'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(plan.tokenWrites[0].allocatedTo, JANE);
  assert.equal(plan.tokenWrites[0].assignedSubject, 'History');
  assert.equal(plan.workspaceWrites.length, 0);
});

test('allocation sheets export and ingest coordinator flags without touching live dynamic data', () => {
  const settings = {
    ...emptySettings(),
    columns: [
      { key: 'Y10 GPA', showOnCard: true, filterable: false, sortable: true, colorScale: false, expanded: false, source: 'live' as const },
      { key: 'Academic Flag', showOnCard: false, filterable: true, sortable: false, colorScale: false, expanded: false, source: 'live' as const },
    ],
  };
  const flagged = {
    studentId: JANE,
    displayName: 'Jane Doe',
    selectedSubject: 'History',
    selectedInterdisciplinary: false,
    interdisciplinarySubject: '',
    suggestedStaffId: SMITH,
    suggestedSubject: 'History',
    isFlagged: true,
    flagNote: 'Check the proposal',
    pendingClear: true,
    token: { staffId: SMITH, assignedSubject: 'History', status: 'committed' as const },
    flags: { drafted: false, committed: true },
    dynamicData: { 'Y10 GPA': 3.4, 'Academic Flag': 'Needs support' },
  };
  const clear = {
    studentId: MARK,
    displayName: 'Mark Lee',
    selectedSubject: '',
    selectedInterdisciplinary: false,
    interdisciplinarySubject: '',
    suggestedStaffId: '',
    suggestedSubject: '',
    isFlagged: false,
    flagNote: '',
    pendingClear: false,
    token: null,
    flags: { drafted: false, committed: false },
    dynamicData: { 'Y10 GPA': 2 },
  };
  const rows = allocationExportRows([flagged, clear] as never, settings);
  assert.deepEqual(rows[0].slice(0, 14), [
    'StudentId',
    'Display Name',
    'Status',
    'SupervisorEmail',
    'AssignedSubject',
    'SelectedSubject',
    'SuggestedStaffEmail',
    'SuggestedSubject',
    'SelectedInterdisciplinary',
    'InterdisciplinarySubject',
    'IsFlagged',
    'FlagNote',
    'PendingClear',
    'Y10 GPA',
  ]);
  assert.equal(rows[0].includes('Academic Flag'), false);
  assert.deepEqual(rows[1].slice(10, 14), [true, 'Check the proposal', true, 3.4]);
  assert.deepEqual(rows[2].slice(10, 14), [false, '', false, 2]);

  const parsed = parseAllocationDraftGrid({ title: 'ALLOCATIONS 2026', rows });
  assert.equal(parsed.warnings.length, 0);
  assert.equal(parsed.rows[0].isFlagged, true);
  assert.equal(parsed.rows[0].flagNote, 'Check the proposal');
  assert.equal(parsed.rows[0].pendingClear, true);
  assert.equal(parsed.rows[1].isFlagged, false);
  assert.equal(parsed.rows[1].flagNote, '');
  assert.equal(parsed.rows[1].pendingClear, false);

  const jane = {
    studentId: JANE,
    subjectChoices: { choice1: 'History' },
    dynamicData: { 'Y10 GPA': 3.4, 'Academic Flag': 'Needs support' },
    pendingClear: true,
    isFlagged: true,
    flagNote: 'Check the proposal',
    selectedSubject: 'History',
    selectedInterdisciplinary: false,
    interdisciplinarySubject: '',
    suggestedStaffId: SMITH,
    suggestedSubject: 'History',
    updatedAt: '',
  };
  const unchanged = planAllocationDraftIngest({
    rows: parsed.rows.filter((row) => row.studentId === JANE),
    tokens: [token({ id: 'pub', staffId: SMITH, status: 'committed', allocatedTo: JANE, assignedSubject: 'History' })],
    workspaces: [jane],
    roster: [{ studentId: JANE, supervisorId: SMITH }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(unchanged.writing, 0);
  assert.equal(unchanged.workspaceWrites.length, 0);
  assert.equal(unchanged.tokenWrites.length, 0);

  const editedGrid = rows.map((row) => row.slice());
  editedGrid[1][editedGrid[0].indexOf('IsFlagged')] = 'no';
  editedGrid[1][editedGrid[0].indexOf('FlagNote')] = 'Edited in the sheet';
  editedGrid[1][editedGrid[0].indexOf('PendingClear')] = '0';
  editedGrid[1][editedGrid[0].indexOf('Y10 GPA')] = 9;
  const edited = parseAllocationDraftGrid({ title: 'ALLOCATIONS 2026', rows: editedGrid });
  const applied = planAllocationDraftIngest({
    rows: edited.rows.filter((row) => row.studentId === JANE),
    tokens: [token({ id: 'pub', staffId: SMITH, status: 'committed', allocatedTo: JANE, assignedSubject: 'History' })],
    workspaces: [jane],
    roster: [{ studentId: JANE, supervisorId: SMITH }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(applied.writing, 1);
  assert.equal(applied.tokenWrites.length, 0);
  assert.equal(applied.workspaceWrites[0].isFlagged, false);
  assert.equal(applied.workspaceWrites[0].flagNote, 'Edited in the sheet');
  assert.equal(applied.workspaceWrites[0].pendingClear, false);
  assert.equal(applied.workspaceWrites[0].selectedSubject, 'History');
  assert.equal(applied.workspaceWrites[0].dynamicData['Y10 GPA'], 3.4);
  assert.equal(applied.workspaceWrites[0].dynamicData['Academic Flag'], 'Needs support');
  assert.equal(applied.workspaceWrites[0].subjectChoices.choice1, 'History');

  const coerced = parseAllocationDraftGrid({
    title: 'ALLOCATIONS 2026',
    rows: [
      ['StudentId', 'Is Flagged', 'Flag Note', 'Pending Clear'],
      [JANE, 'YES', 'Watch', '1'],
      [MARK, 'false', '', 'no'],
      ['ada@vsa.edu', true, 'From a checkbox', false],
      ['bea@vsa.edu', 0, 'zero', 1],
      ['cy@vsa.edu', 'maybe', 'leave the flag', 'soon'],
    ],
  });
  assert.equal(coerced.rows[0].isFlagged, true);
  assert.equal(coerced.rows[0].flagNote, 'Watch');
  assert.equal(coerced.rows[0].pendingClear, true);
  assert.equal(coerced.rows[1].isFlagged, false);
  assert.equal(coerced.rows[1].flagNote, '');
  assert.equal(coerced.rows[1].pendingClear, false);
  assert.equal(coerced.rows[2].isFlagged, true);
  assert.equal(coerced.rows[2].pendingClear, false);
  assert.equal(coerced.rows[3].isFlagged, false);
  assert.equal(coerced.rows[3].flagNote, 'zero');
  assert.equal(coerced.rows[3].pendingClear, true);
  assert.equal(coerced.rows[4].isFlagged, undefined);
  assert.equal(coerced.rows[4].flagNote, 'leave the flag');
  assert.equal(coerced.rows[4].pendingClear, undefined);
  assert.equal(coerced.warnings.length, 2);
  assert.match(coerced.warnings.join('\n'), /IsFlagged must be true or false/);
  assert.match(coerced.warnings.join('\n'), /PendingClear must be true or false/);

  const cleared = planAllocationDraftIngest({
    rows: [{ studentId: JANE, isFlagged: false, flagNote: '', pendingClear: false }],
    tokens: [token({ id: 'pub', staffId: SMITH, status: 'committed', allocatedTo: JANE, assignedSubject: 'History' })],
    workspaces: [jane],
    roster: [{ studentId: JANE, supervisorId: SMITH }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(cleared.workspaceWrites[0].isFlagged, false);
  assert.equal(cleared.workspaceWrites[0].flagNote, '');
  assert.equal(cleared.workspaceWrites[0].pendingClear, false);
  assert.equal(cleared.workspaceWrites[0].dynamicData['Y10 GPA'], 3.4);

  const omitted = planAllocationDraftIngest({
    rows: [{ studentId: JANE, selectedSubject: 'History' }],
    tokens: [token({ id: 'pub', staffId: SMITH, status: 'committed', allocatedTo: JANE, assignedSubject: 'History' })],
    workspaces: [jane],
    roster: [{ studentId: JANE, supervisorId: SMITH }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(omitted.writing, 0);
  assert.equal(omitted.workspaceWrites.length, 0);

  const flagOnly = planAllocationDraftIngest({
    rows: [{ studentId: MARK, isFlagged: true, flagNote: 'New flag' }],
    tokens: [],
    workspaces: [],
    roster: [{ studentId: MARK }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(flagOnly.workspaceWrites[0].isFlagged, true);
  assert.equal(flagOnly.workspaceWrites[0].flagNote, 'New flag');
  assert.equal(flagOnly.workspaceWrites[0].pendingClear, false);
  assert.deepEqual(flagOnly.workspaceWrites[0].dynamicData, {});

  const drafted = planAllocationDraftIngest({
    rows: [{
      studentId: MARK,
      status: 'Draft',
      supervisorEmail: SMITH,
      assignedSubject: 'History',
      selectedSubject: 'History',
      pendingClear: true,
      isFlagged: true,
      flagNote: 'Still flagged',
    }],
    tokens: [token({ id: 'open', staffId: SMITH, status: 'available', eligibleSubjects: ['History'] })],
    workspaces: [],
    roster: [{ studentId: MARK }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(drafted.tokenWrites[0].status, 'draft');
  assert.equal(drafted.workspaceWrites[0].isFlagged, true);
  assert.equal(drafted.workspaceWrites[0].flagNote, 'Still flagged');
  assert.equal(drafted.workspaceWrites[0].pendingClear, false);
});

test('backfill copies a drafted token into an empty selected subject and suggestion', () => {
  const prior = {
    studentId: JANE,
    subjectChoices: { choice1: 'History' },
    dynamicData: { Note: 'keep' },
    pendingClear: false,
    isFlagged: true,
    flagNote: 'watch',
    selectedSubject: '',
    suggestedStaffId: '',
    suggestedSubject: '',
    updatedAt: '',
  };
  const plan = planDraftTokenBackfill({
    tokens: [
      token({ id: 'draft', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'history' }),
      token({ id: 'pub', staffId: DAVIS, status: 'committed', allocatedTo: MARK, assignedSubject: 'Biology' }),
      token({ id: 'blank', staffId: DAVIS, status: 'draft', allocatedTo: 'ada@vsa.edu', assignedSubject: '' }),
      token({ id: 'set', staffId: DAVIS, status: 'draft', allocatedTo: 'bea@vsa.edu', assignedSubject: 'Biology' }),
    ],
    workspaces: [
      prior,
      {
        studentId: 'bea@vsa.edu',
        subjectChoices: {},
        dynamicData: {},
        pendingClear: false,
        selectedSubject: 'History',
        suggestedStaffId: '',
        suggestedSubject: '',
        updatedAt: '',
      },
    ],
    roster: [{ studentId: JANE }, { studentId: MARK }, { studentId: 'ada@vsa.edu' }, { studentId: 'bea@vsa.edu' }],
    activeSubjects: ['History', 'Biology'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(plan.writing, 1);
  assert.equal(plan.writes[0].studentId, JANE);
  assert.equal(plan.writes[0].selectedSubject, 'History');
  assert.equal(plan.writes[0].suggestedStaffId, SMITH);
  assert.equal(plan.writes[0].suggestedSubject, 'History');
  assert.equal(plan.writes[0].isFlagged, true);
  assert.equal(plan.writes[0].flagNote, 'watch');
  assert.equal(plan.writes[0].dynamicData.Note, 'keep');
  assert.equal(plan.rows.find((row) => row.id === MARK), undefined);
  assert.equal(plan.rows.find((row) => row.id === 'ada@vsa.edu')?.action, 'Skip');
  assert.equal(plan.rows.find((row) => row.id === 'bea@vsa.edu')?.action, 'Skip');
  const second = planDraftTokenBackfill({
    tokens: [token({ id: 'draft', staffId: SMITH, status: 'draft', allocatedTo: JANE, assignedSubject: 'History' })],
    workspaces: plan.writes,
    roster: [{ studentId: JANE }],
    activeSubjects: ['History'],
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(second.writing, 0);
  assert.equal(second.rows[0].action, 'Unchanged');
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
