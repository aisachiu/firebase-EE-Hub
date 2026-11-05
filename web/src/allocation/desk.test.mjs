import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const psychology = { name: 'Psychology', colour: '#6b4c9a', shortName: 'Psy' };
const theater = { name: 'Theater', colour: '#0e8a6a' };

function student(partial) {
  return {
    studentId: 'jane@school.edu',
    displayName: 'Doe, Jane',
    sortName: 'doe, jane',
    flags: { needsSupport: false, drafted: false, committed: false, subjectMatch: 'none', hlMatch: 'none' },
    choices: { primary: '["Psychology","Theater"]', secondary: '', interdisciplinary: false },
    requestedSubjects: [psychology, theater],
    token: null,
    pendingClear: false,
    dynamicData: {},
    ...partial,
  };
}

function supervisors() {
  return [
    { staffId: 'psy@school.edu', displayName: 'Dr Psy', eligibleSubjects: ['Psychology'], available: 1, used: 0, total: 1 },
    { staffId: 'art@school.edu', displayName: 'Mx Art', eligibleSubjects: ['Theater'], available: 2, used: 0, total: 2 },
    { staffId: 'open@school.edu', displayName: 'Pat Open', eligibleSubjects: ['Biology'], available: 1, used: 0, total: 1 },
  ];
}

function desk() {
  return {
    settings: { columns: [] },
    summary: { activeStudents: 2, tokenCount: 3, buffer: 1 },
    warnings: [],
    publish: { drafts: 0, clears: 0, blocked: 0 },
    supervisors: supervisors(),
    tokenSlots: [{ status: 'available', eligibleSubjects: 'Mathematics, Analysis and approaches' }],
    students: [
      student({}),
      student({
        studentId: 'mark@school.edu',
        displayName: 'Lee, Mark',
        sortName: 'lee, mark',
        choices: { primary: 'Theater', secondary: '', interdisciplinary: true },
        requestedSubjects: [theater],
      }),
    ],
  };
}

test('allocation desk tags, filter, column order, supervisor cues, and token load', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const deskMod = await server.ssrLoadModule('/src/allocation/desk.js');
    const pure = await server.ssrLoadModule('/../functions/src/allocationPure.ts');
    const stateMod = await server.ssrLoadModule('/src/shared/state.js');
    const state = stateMod.state;
    state.allocationCohorts = [{ id: '2026', name: '2026' }];
    state.cohortId = '2026';
    state.allocationStatus = 'all';
    state.allocationSupport = 'all';
    state.allocationSelected = [];
    state.allocationSubjects = {};
    state.allocationSubjectFilter = [];
    state.allocationSelectedSubjectFilter = [];
    state.allocationNeedSupport = 'all';
    state.allocationFlaggedFilter = 'all';
    state.allocationFilterDraft = null;
    state.allocationFilterSnapshot = null;
    state.allocationTeacherFilter = [];
    state.allocationSupportFlags = [];
    state.allocationOpenStudent = '';
    state.allocationAssignedOpen = {};
    state.allocationInterdisciplinary = {};
    state.allocationInterdisciplinarySubject = {};
    state.allocationCustomFilters = {};
    state.allocationQuery = '';
    state.allocationCustomQueries = {};
    state.allocationCustomOpen = '';
    state.allocationDrawerSortColumn = 'subject';
    state.allocationDrawerSortDirection = 1;
    state.allocationDataSelected = [];
    state.adminHeaderOpen = {};
    state.adminTableSort = { 'alloc-desk': { key: 'name', dir: 1 } };
    state.allocationIngestKind = 'drafts';
    const settingsHtml = deskMod.allocationSettingsMarkup({
      driveReady: true,
      settings: { columns: [], detectedDynamicKeys: [], detectedChoiceKeys: [] },
      summary: { staffCount: 1, tokenCount: 1, activeStudents: 1, buffer: 0 },
      students: [],
    });
    assert.match(settingsHtml, /value="drafts"[^>]*checked/);
    assert.doesNotMatch(settingsHtml, /id="alloc-primary-score"/);
    assert.doesNotMatch(settingsHtml, /id="alloc-secondary-score"/);
    assert.match(settingsHtml, /id="alloc-backfill-preview"/);
    assert.match(settingsHtml, /Selected Subject/);
    assert.match(deskMod.allocationConfirmCopy('drafts'), /Published tokens stay as they are/);
    state.allocationIngestKind = 'workspace';

    const html = deskMod.allocationDashboardMarkup(desk());
    const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    const subjectAt = head.indexOf('Requested subjects');
    const supervisorAt = head.indexOf('Supervisor');
    const studentAt = head.indexOf('>Student');
    assert.ok(studentAt >= 0 && studentAt < subjectAt && subjectAt < supervisorAt);
    assert.match(html, /data-alloc-subject="jane@school.edu" data-subject="Psychology"/);
    assert.match(html, /--subject:#6b4c9a/);
    assert.doesNotMatch(html, /\["Psychology"/);
    assert.match(html, /data-alloc-subject-filter="Psychology"/);
    assert.match(html, /data-alloc-subject-filter="Theater"/);
    const scoredChoices = deskMod.allocationSubjectChoiceMarkup(student({
      choices: {
        primary: '["Psychology","Theater"]',
        secondary: '',
        primaryScore: 'A&',
        secondaryScore: '87.5',
        interdisciplinary: false,
      },
    }), desk());
    assert.match(scoredChoices, /<span class="alloc-choice-kicker">1:<\/span>/);
    assert.match(scoredChoices, /Psychology \(A&amp;\)<\/label>/);
    assert.match(scoredChoices, /<span class="alloc-choice-kicker">2:<\/span>/);
    assert.match(scoredChoices, /\(87\.5\)/);
    const unscoredChoices = deskMod.allocationSubjectChoiceMarkup(student({
      choices: { primary: '["Psychology","Theater"]', secondary: '', primaryScore: '', secondaryScore: '', interdisciplinary: false },
    }), desk());
    assert.doesNotMatch(unscoredChoices, /\(\s*\)/);

    const row = deskMod.allocationRowMarkup(student({}), supervisors(), [], {});
    const cells = row.split('</td>');
    assert.match(cells[2], /data-subject="Psychology"/);
    assert.match(cells[3], /Unassigned/);
    assert.match(cells[3], /data-alloc-supervisor/);
    assert.match(cells[3], /disabled/);
    assert.doesNotMatch(cells[2], /data-alloc-supervisor/);
    assert.doesNotMatch(row, /class="supervisor-cue"/);
    assert.match(deskMod.allocationRowMarkup(desk().students[1], supervisors(), [], {}), /class="id-tag"[^>]*>ID</);

    const cues = deskMod.allocationSupervisorCues(student({
      selectedSubject: 'Psychology',
      token: { staffId: 'psy@school.edu', assignedSubject: 'Psychology' },
    }), supervisors());
    assert.match(cues, /Dr Psy/);
    assert.match(cues, /data-alloc-supervisor="jane@school.edu"/);
    assert.match(cues, /<option value="psy@school.edu" selected>/);
    assert.match(cues, /--subject:#6b4c9a/);
    assert.doesNotMatch(cues, /Mx Art/);
    assert.doesNotMatch(cues, /Pat Open/);
    assert.doesNotMatch(cues, /alloc-teacher-empty/);
    const exhausted = supervisors().map(function(person) {
      return person.staffId === 'psy@school.edu' ? Object.assign({}, person, { available: 0, used: 1 }) : person;
    });
    const grey = deskMod.allocationSupervisorCues(student({
      selectedSubject: 'Psychology',
      token: { staffId: 'art@school.edu', assignedSubject: 'Psychology' },
    }), exhausted);
    assert.match(grey, /class="alloc-teacher-empty"/);
    assert.match(grey, /disabled/);
    assert.match(grey, /Dr Psy \(1\/1\)/);
    const restored = deskMod.allocationSupervisorCues(student({
      selectedSubject: 'Psychology',
      token: { staffId: 'art@school.edu', assignedSubject: 'Psychology' },
    }), supervisors());
    assert.doesNotMatch(restored, /alloc-teacher-empty/);
    assert.doesNotMatch(restored, /0 remaining/);
    const chosenRow = deskMod.allocationRowMarkup(student({
      selectedSubject: 'Psychology',
      token: { staffId: 'psy@school.edu', assignedSubject: 'Psychology' },
    }), supervisors(), [], {});
    assert.match(chosenRow, /class="alloc-supervisor-name"[^>]*>Dr Psy/);
    assert.match(chosenRow, />Psychology</);
    assert.match(chosenRow, /data-alloc-supervisor="jane@school.edu"/);
    assert.match(chosenRow, /<option value="psy@school.edu" selected>/);
    assert.doesNotMatch(chosenRow, /Mx Art/);
    assert.doesNotMatch(chosenRow, /Pat Open/);
    assert.match(chosenRow, /<select/);
    assert.match(chosenRow, /class="subject-chip on is-locked"[^>]*data-subject="Psychology"/);
    assert.match(chosenRow, /data-alloc-subject="jane@school.edu" data-subject="Psychology" checked disabled/);
    assert.match(chosenRow, /Choice 1/);
    assert.doesNotMatch(chosenRow, /data-alloc-subject-add="jane@school.edu"/);
    assert.doesNotMatch(chosenRow, /class="subject-chip on[^"]*"[^>]*data-subject="Theater"/);
    assert.doesNotMatch(chosenRow, /data-subject="Theater" checked/);
    const subjectCell = chosenRow.split('</td>')[2];
    const supervisorCell = chosenRow.split('</td>')[3];
    assert.match(subjectCell, /Interdisciplinary EE/);
    assert.match(subjectCell, /alloc-ee-flag is-unset/);
    assert.doesNotMatch(subjectCell, /data-alloc-supervisor/);
    assert.doesNotMatch(supervisorCell, /Interdisciplinary EE/);
    assert.match(supervisorCell, /data-alloc-supervisor/);

    const plain = deskMod.allocationRowMarkup(student({}), supervisors(), [], {});
    assert.doesNotMatch(plain, /subject-chip on/);
    assert.match(plain, /Choice 1/);
    assert.match(plain, /Choice 2/);
    assert.match(plain, /data-alloc-subject-add="jane@school.edu"/);
    assert.doesNotMatch(plain, /data-alloc-subject="jane@school.edu"[^>]*checked/);
    assert.doesNotMatch(plain, /data-alloc-extra-subject/);
    state.allocationSubjectPicker = { 'jane@school.edu': true };
    state.allocationDesk = { subjects: [
      { name: 'Psychology', shortName: 'Psy', colour: '#6b4c9a', department: 'Humanities' },
      { name: 'Theater', shortName: 'The', colour: '#0e8a6a', department: 'Arts' },
      { name: 'Biology', shortName: 'Bio', colour: '#1d4e89', department: 'Science' },
    ] };
    const opened = deskMod.allocationRowMarkup(student({}), supervisors(), [], {});
    assert.match(opened, /data-alloc-extra-subject="jane@school.edu"/);
    assert.match(opened, /<option value="Biology">Biology<\/option>/);
    assert.ok(opened.indexOf('data-subject="Theater"') < opened.indexOf('data-alloc-subject-add'));
    assert.ok(opened.indexOf('data-alloc-subject-add') < opened.indexOf('data-alloc-extra-subject'));
    const otherSubject = deskMod.allocationRowMarkup(student({ selectedSubject: 'Biology' }), supervisors(), [], {});
    state.allocationSubjectPicker = {};
    const otherChip = deskMod.allocationRowMarkup(student({ selectedSubject: 'Biology' }), supervisors(), [], {});
    assert.match(otherChip, /class="subject-chip on"[^>]*data-subject="Biology"/);
    assert.match(otherChip, /data-subject="Biology" checked/);
    assert.doesNotMatch(otherChip, /class="subject-chip on"[^>]*data-subject="Psychology"/);
    assert.doesNotMatch(otherSubject, /class="subject-chip on"[^>]*data-subject="Biology"/);
    assert.equal(deskMod.allocationSubjectAction(student({}), 'Theater').type, 'select');
    assert.equal(deskMod.allocationSubjectAction(student({ selectedSubject: 'Psychology', token: { assignedSubject: 'Psychology', staffId: 'psy@school.edu' } }), 'Psychology').type, 'select');
    assert.equal(deskMod.allocationSubjectAction(student({ selectedSubject: 'Psychology', token: { assignedSubject: 'Psychology', staffId: 'psy@school.edu' } }), 'Theater').type, 'select');
    const scopedDesk = desk();
    scopedDesk.tokenRows = [
      { id: 'a', staffId: 'psy@school.edu', status: 'draft', eligibleSubjects: ['Psychology'], assignedSubject: 'Psychology', studentId: 'mark@school.edu' },
      { id: 'b', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Psychology'] },
      { id: 'c', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Biology'] },
    ];
    const scoped = deskMod.allocationSupervisorCues(student({ selectedSubject: 'Psychology' }), supervisors(), scopedDesk);
    assert.match(scoped, /Dr Psy \(1\/2\)/);
    assert.doesNotMatch(scoped, /disabled/);
    const fullDesk = desk();
    fullDesk.tokenRows = [
      { id: 'a', staffId: 'psy@school.edu', status: 'draft', eligibleSubjects: ['Psychology'] },
      { id: 'b', staffId: 'psy@school.edu', status: 'committed', eligibleSubjects: ['Psychology'] },
      { id: 'c', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Theater'] },
    ];
    const full = deskMod.allocationSupervisorCues(student({ selectedSubject: 'Psychology', token: { staffId: 'art@school.edu', assignedSubject: 'Psychology' } }), supervisors(), fullDesk);
    assert.match(full, /Dr Psy \(2\/2\)/);
    assert.match(full, /disabled/);
    assert.match(full, /class="alloc-teacher-empty"/);
    const openTeacher = deskMod.nextAllocationTeacher(student({}), 'Psychology', supervisors(), scopedDesk);
    assert.equal(openTeacher.staffId, 'psy@school.edu');
    const noTeacher = deskMod.nextAllocationTeacher(student({}), 'Psychology', supervisors(), fullDesk);
    assert.equal(noTeacher, null);
    state.allocationAuditLogs = [
      { id: 'a1', seq: 1, studentName: 'Doe, Jane', subject: 'History', teacher: 'Mr. Smith', action: 'Allocated', userName: 'Coordinator', at: '2026-11-03T00:00:00.000Z' },
      { id: 'a2', seq: 2, studentName: 'Lee, Mark', subject: 'Geography', teacher: 'Mr. Smith', action: 'Unallocated', userName: 'Coordinator', at: '2026-11-03T00:01:00.000Z' },
    ];
    const audit = deskMod.allocationAuditMarkup();
    assert.match(audit, /Doe, Jane/);
    assert.match(audit, /data-alloc-undo="a1"/);
    assert.match(audit, /Undo/);
    assert.ok(audit.indexOf('Lee, Mark') < audit.indexOf('Doe, Jane'));
    assert.equal(deskMod.allocationUndoCount(state.allocationAuditLogs, 'a1'), 2);
    assert.equal(deskMod.allocationUndoCount(state.allocationAuditLogs, 'a2'), 1);
    assert.equal(deskMod.allocationUndoMessage(2), 'You are about to undo 2 actions. Are you sure you want to proceed?');
    state.allocationSubjects = { 'jane@school.edu': 'Psychology' };
    state.allocationAuditLogs = [];

    const source = desk();
    state.allocationSubjectFilter = ['Psychology'];
    assert.deepEqual(deskMod.visibleAllocationStudents(source).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationSubjectFilter = ['Theater'];
    assert.deepEqual(deskMod.visibleAllocationStudents(source).map((item) => item.studentId), ['jane@school.edu', 'mark@school.edu']);
    state.allocationSubjectFilter = [];
    assert.equal(deskMod.visibleAllocationStudents(source).length, 2);
    assert.deepEqual(deskMod.allocationRequestedSubjects(student({})).map((item) => item.name), ['Psychology', 'Theater']);

    const load = pure.subjectTokenLoad([{ status: 'available', eligibleSubjects: 'Mathematics, Analysis and approaches' }]);
    const table = deskMod.subjectTokenLoadMarkup(load);
    assert.match(table, /Mathematics, Analysis and approaches/);
    assert.match(table, />Pool \(1\)/);
    assert.match(table, />UPool \(1\)/);
    assert.match(table, />Alloc/);
    assert.match(table, />Rem/);
    assert.match(table, /Pool \(1\)/);
    assert.match(table, /15 \(10\) means 15 students requested the subject/);
    assert.match(table, /class="alloc-subject-block"/);
    assert.equal((table.match(/alloc-subject-block/g) || []).length, 1);
    assert.doesNotMatch(table, /<table/);
    assert.doesNotMatch(table, />Mathematics</);
    assert.match(html, /id="alloc-clear-filters"/);
    assert.doesNotMatch(html, /id="alloc-apply-filters"/);
    assert.match(html, /data-alloc-selected-filter="Psychology"/);
    assert.match(html, /Selected subject/);
    assert.match(html, /id="alloc-need-support"/);
    assert.match(html, /id="alloc-flagged-filter"/);
    assert.match(html, /<option value="unallocated">Unallocated<\/option>/);
    assert.match(html, /<option value="drafted">Drafted<\/option>/);
    assert.match(html, /<option value="suggested">Suggested<\/option>/);
    assert.match(html, /<option value="allocated">Allocated<\/option>/);
    assert.match(html, /<option value="published">Published<\/option>/);
    assert.match(html, /title="Psychology">Psy</);
    assert.match(html, /data-alloc-teacher-filter="psy@school.edu"/);
    assert.ok(html.indexOf('data-table-header="alloc-filters"') < html.indexOf('id="alloc-student-search"'));
    assert.ok(html.indexOf('id="alloc-student-search"') < html.indexOf('id="alloc-batch-assign"'));
    assert.ok(html.indexOf('id="alloc-batch-assign"') < html.indexOf('<table'));
    assert.match(html, /id="alloc-status"/);
    assert.doesNotMatch(html, /data-alloc-status="flagged"/);
    assert.match(html, /data-alloc-flag="jane@school.edu"/);
    assert.match(html, /data-alloc-flag-toggle="jane@school.edu"/);
    assert.match(html, /class="alloc-flag-icon"/);
    assert.match(html, /alloc-flag-panel" hidden/);
    assert.doesNotMatch(html, /subject-chip on/);
    assert.match(html, /Allocation audit log/);
    assert.match(html, /No allocation changes yet/);
    assert.match(html, /alloc-ee-flag is-unset/);
    assert.match(html, /alloc-ee-flag is-chosen/);
    assert.match(html, /id="alloc-batch-subject"/);
    assert.match(html, /value="__no_subject__">\[no subject\]/);
    assert.match(html, /id="alloc-batch-apply-subject">Apply Subject/);
    assert.match(html, /id="alloc-batch-approve">Assign From Suggestions/);
    assert.match(html, /id="alloc-batch-supervisor"/);
    assert.match(html, /value="__no_supervisor__">\[no supervisor\]/);
    assert.match(html, /id="alloc-batch-assign">Assign Supervisor/);
    assert.match(html, /id="alloc-batch-publication-action"[^>]*><option value="publish">Publish<\/option><option value="unpublish">Unpublish<\/option>/);
    assert.match(html, /id="alloc-batch-publication">Publish/);
    assert.match(html, /Assigned Tokens/);
    assert.ok(html.indexOf('data-alloc-ee-inter="jane@school.edu"') < html.indexOf('class="alloc-supervisor-name'));
    assert.match(html, /data-alloc-supervisor/);
    assert.match(html, /Choose a subject first/);
    state.allocationFlaggedFilter = 'yes';
    const flaggedDesk = desk();
    flaggedDesk.students[1].isFlagged = true;
    flaggedDesk.students[1].flagNote = 'Needs a call';
    assert.deepEqual(deskMod.visibleAllocationStudents(flaggedDesk).map((item) => item.studentId), ['mark@school.edu']);
    state.allocationFlaggedFilter = 'all';
    state.allocationNeedSupport = 'yes';
    flaggedDesk.students[0].flags = { needsSupport: true, drafted: false, committed: false, subjectMatch: 'none', hlMatch: 'none' };
    assert.deepEqual(deskMod.visibleAllocationStudents(flaggedDesk).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationNeedSupport = 'all';
    assert.equal(deskMod.allocationStudentStatus(student({})), 'unallocated');
    assert.equal(deskMod.allocationStudentStatus(student({ selectedSubject: 'Psychology' })), 'drafted');
    assert.equal(deskMod.allocationStudentStatus(student({ selectedSubject: 'Psychology', suggestedStaffId: 'psy@school.edu' })), 'suggested');
    assert.equal(deskMod.allocationStudentStatus(student({ selectedSubject: 'Psychology', suggestedStaffId: 'psy@school.edu', token: { status: 'draft', assignedSubject: 'Psychology', staffId: 'psy@school.edu' } })), 'allocated');
    assert.equal(deskMod.allocationStudentStatus(student({ token: { status: 'committed', assignedSubject: 'Psychology', staffId: 'psy@school.edu' } })), 'published');
    const sticky = desk();
    sticky.students[0].selectedSubject = 'Psychology';
    state.allocationStatus = 'unallocated';
    state.allocationFilterSnapshot = sticky.students.map((item) => item.studentId);
    assert.deepEqual(deskMod.visibleAllocationStudents(sticky).map((item) => item.studentId), ['jane@school.edu', 'mark@school.edu']);
    state.allocationFilterSnapshot = null;
    assert.deepEqual(deskMod.visibleAllocationStudents(sticky).map((item) => item.studentId), ['mark@school.edu']);
    state.allocationFilterDraft = { status: 'drafted', needSupport: 'all', flagged: 'all', supportFlags: [], subject: [], selected: [], teacher: [], custom: {} };
    assert.deepEqual(deskMod.commitAllocationFilterDraft(sticky), ['jane@school.edu']);
    assert.equal(state.allocationStatus, 'drafted');
    assert.deepEqual(state.allocationFilterSnapshot, ['jane@school.edu']);
    sticky.students[0].selectedSubject = '';
    sticky.students[1].selectedSubject = 'Theater';
    assert.deepEqual(deskMod.visibleAllocationStudents(sticky).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationFilterDraft = { status: 'unallocated', needSupport: 'all', flagged: 'all', supportFlags: [], subject: [], selected: [], teacher: [], custom: {} };
    assert.deepEqual(deskMod.commitAllocationFilterDraft(sticky), ['jane@school.edu']);
    assert.deepEqual(deskMod.visibleAllocationStudents(sticky).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationFilterSnapshot = null;
    state.allocationStatus = 'all';
    state.allocationFilterDraft = null;
    const coordinatorFlagRow = deskMod.allocationRowMarkup(flaggedDesk.students[1], supervisors(), [], {});
    assert.match(coordinatorFlagRow, /data-alloc-flag="mark@school.edu"/);
    assert.match(coordinatorFlagRow, /data-alloc-flag-note="mark@school.edu"/);
    assert.match(coordinatorFlagRow, /checked/);
    assert.match(coordinatorFlagRow, /value="Needs a call"/);
    assert.match(coordinatorFlagRow, /class="is-flagged"/);
    assert.match(coordinatorFlagRow, /alloc-flag-icon is-on/);
    state.allocationFlagOpen = { 'mark@school.edu': true };
    const openFlag = deskMod.allocationRowMarkup(flaggedDesk.students[1], supervisors(), [], {});
    assert.doesNotMatch(openFlag, /alloc-flag-panel" hidden/);
    delete state.allocationFlagOpen['mark@school.edu'];
    state.allocationStatus = 'all';
    assert.match(html, /id="alloc-batch-publication"/);
    assert.match(html, /id="alloc-batch-publication-action"/);
    assert.doesNotMatch(html, /id="alloc-publish"/);
    assert.match(html, /Active Students<\/span> <strong>2<\/strong>/);
    assert.match(html, /Unassigned \(students\)<\/span> <strong>2<\/strong>/);
    assert.match(html, /Remaining Tokens<\/span> <strong>4<\/strong>/);
    assert.match(html, /class="alloc-mark on status"/);
    assert.match(html, /class="alloc-mark on subject" title="First choice match"/);
    assert.match(html, /class="alloc-mark off subject" title="Second choice"/);
    assert.match(html, /class="alloc-mark warn subject" title="Not first or second choice"/);
    assert.match(html, /class="alloc-mark on hl" title="HL subject"/);
    assert.match(html, /class="alloc-mark off hl" title="SL subject"/);
    assert.match(html, /class="alloc-mark warn hl" title="Not one of the six subjects"/);
    assert.match(html, />First choice match</);
    assert.match(html, />Second choice</);
    assert.match(html, />Not 1st or 2nd</);
    assert.match(html, />HL subject</);
    assert.match(html, />SL subject</);
    assert.match(html, />Not in 6 subjects</);
    assert.doesNotMatch(html, /Subject match/);
    assert.doesNotMatch(html, /HL match/);
    const choiceRow = (partial) => deskMod.allocationRowMarkup(student(partial), supervisors(), [], {});
    const firstChoice = choiceRow({
      choices: { primary: 'History', secondary: 'Eng Lit', interdisciplinary: false },
      token: { assignedSubject: 'History', staffId: 'psy@school.edu', status: 'draft' },
      dynamicData: { HL: 'History, Biology', 'SL subjects': 'Mathematics' },
    });
    assert.match(firstChoice, /class="alloc-mark on subject" title="First choice match"/);
    assert.match(firstChoice, /class="alloc-mark on hl" title="HL subject"/);
    const secondChoice = choiceRow({
      choices: { primary: 'History', secondary: 'Eng Lit', interdisciplinary: false },
      token: { assignedSubject: 'Eng Lit', staffId: 'art@school.edu', status: 'draft' },
      dynamicData: { HL: 'Biology', 'SL subjects': 'Eng Lit, Mathematics' },
    });
    assert.match(secondChoice, /class="alloc-mark off subject" title="Second choice"/);
    assert.match(secondChoice, /class="alloc-mark off hl" title="SL subject"/);
    const outside = choiceRow({
      choices: { primary: 'History', secondary: 'Eng Lit', interdisciplinary: false },
      token: { assignedSubject: 'Geography', staffId: 'open@school.edu', status: 'draft' },
      dynamicData: { HL: 'Biology, Chemistry', 'SL subjects': 'Mathematics, Eng Lit' },
    });
    assert.match(outside, /class="alloc-mark warn subject" title="Not first or second choice"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v12h-2z"/);
    assert.match(outside, /class="alloc-mark warn hl" title="Not one of the six subjects"/);
    const unallocated = choiceRow({ choices: { primary: 'History', secondary: 'Eng Lit', interdisciplinary: false } });
    assert.match(unallocated, /class="alloc-mark idle subject" title="No allocation"/);
    assert.match(unallocated, /class="alloc-mark idle hl" title="No allocation"/);
    assert.match(html, /data-alloc-load="assigned"/);
    assert.match(html, /aria-label="Star key"/);
    assert.doesNotMatch(html, /id="alloc-cohort"/);
    assert.doesNotMatch(html, /Resync Live Choice Data/);
    assert.match(html, /class="alloc-drawer"/);
    assert.match(html, /id="alloc-drawer-peek"/);
    assert.match(html, />Token Overview</);
    assert.doesNotMatch(html, />Token load</);
    assert.doesNotMatch(html, /class="alloc-side"/);

    const sehs = 'Sports, Exercise, and Health Science (SEHS)';
    const sehsLoad = pure.subjectTokenLoad([{ status: 'available', eligibleSubjects: ['Sports', 'Exercise', 'and Health Science (SEHS)'] }], [], [sehs]);
    const sehsTable = deskMod.subjectTokenLoadMarkup(sehsLoad, { subjects: [{ name: sehs, shortName: 'SEHS' }] });
    assert.match(sehsTable, /Sports, Exercise, and Health Science \(SEHS\)/);
    assert.match(sehsTable, /title="Sports, Exercise, and Health Science \(SEHS\)">SEHS</);
    assert.equal((sehsTable.match(/alloc-subject-block/g) || []).length, 1);
    assert.doesNotMatch(sehsTable, />Sports</);
    assert.doesNotMatch(sehsTable, /<table/);
    assert.match(table, /class="alloc-meter/);
    const warned = deskMod.subjectTokenLoadMarkup({
      subjects: [
        { subject: 'Biology', pool: 4, upool: 1, alloc: 2, remaining: 2 },
        { subject: 'Chemistry', pool: 1, upool: 5, alloc: 0, remaining: 2 },
        { subject: 'Drama', pool: 2, upool: 2, alloc: 1, remaining: 2 },
      ],
    });
    assert.match(warned, /class="alloc-capacity-warn">4 \(0\)/);
    assert.match(warned, /class="alloc-capacity-warn">5 \(0\)/);
    assert.equal((warned.match(/alloc-capacity-warn/g) || []).length, 2);
    const biology = warned.slice(warned.indexOf('Biology'), warned.indexOf('Chemistry'));
    assert.match(biology, /role="progressbar"[^>]*aria-valuenow="2"[^>]*aria-valuemax="4"/);
    state.allocationDrawerSortColumn = 'pool';
    state.allocationDrawerSortDirection = -1;
    const sortedByPool = deskMod.subjectTokenLoadMarkup({
      subjects: [
        { subject: 'Biology', pool: 4, upool: 1, alloc: 2, remaining: 2 },
        { subject: 'Chemistry', pool: 1, upool: 5, alloc: 0, remaining: 2 },
      ],
    });
    assert.ok(sortedByPool.indexOf('Biology') < sortedByPool.indexOf('Chemistry'));
    assert.match(sortedByPool, /data-alloc-drawer-sort="pool" aria-sort="descending">Pool \(1\) ▼/);
    const choiceLoad = deskMod.subjectTokenLoadMarkup({
      subjects: [{ subject: 'History', pool: 15, poolChoice1: 10, upool: 6, upoolChoice1: 4, alloc: 2, remaining: 8 }],
    });
    assert.match(choiceLoad, /15 \(10\)/);
    assert.match(choiceLoad, /6 \(4\)/);
    state.allocationDrawerSortColumn = 'subject';
    state.allocationDrawerSortDirection = 1;

    state.allocationOpenStudent = 'jane@school.edu';
    state.allocationDesk = desk();
    state.allocationDesk.settings.columns = [{ key: 'Research notes', showOnCard: false, expanded: true }];
    const expandedStudent = student({ dynamicData: { 'Research notes': 'A long paragraph about the question.' }, subjectChoices: { interdisciplinary: 'Yes' } });
    const expanded = deskMod.allocationRowMarkup(expandedStudent, supervisors(), [], {});
    assert.match(expanded, /data-alloc-expand="jane@school.edu"/);
    assert.match(expanded, /<dt>Choice 1<\/dt>/);
    assert.ok(expanded.indexOf('<dt>StudentId</dt>') < expanded.indexOf('<dt>Choice 1</dt>'));
    assert.match(expanded, /<dt>Choice 2<\/dt>/);
    assert.match(expanded, /<dt>Interdisciplinary<\/dt>/);
    assert.match(expanded, /Research notes/);
    assert.match(expanded, /A long paragraph/);
    assert.match(expanded, /Interdisciplinary EE/);
    state.allocationInterdisciplinary['jane@school.edu'] = true;
    const interRow = deskMod.allocationRowMarkup(student({
      choices: { primary: 'Psychology', secondary: 'Theater', interdisciplinary: true },
    }), supervisors(), [], {});
    assert.match(interRow, /data-alloc-inter-subject="jane@school.edu"/);
    assert.match(interRow, /<option value="Theater" selected>Theater<\/option>/);
    state.allocationInterdisciplinarySubject['jane@school.edu'] = 'Biology';
    const keptSubject = deskMod.allocationRowMarkup(student({
      choices: { primary: 'Psychology', secondary: 'Theater', interdisciplinary: true },
    }), supervisors(), [], {});
    assert.match(keptSubject, /<option value="Biology" selected>Biology<\/option>/);
    assert.doesNotMatch(keptSubject, /<option value="Theater" selected>/);
    const modal = deskMod.allocationInterdisciplinaryModalMarkup(student({
      choices: { primary: 'Psychology', secondary: 'Theater', interdisciplinary: true },
    }), desk());
    assert.match(modal, /id="alloc-inter-token"/);
    assert.match(modal, /id="alloc-inter-modal-subject"/);
    assert.match(modal, /<option value="Biology" selected>Biology<\/option>/);
    assert.match(modal, /Dr Psy/);
    assert.match(modal, /Mx Art/);
    assert.match(modal, /Pat Open/);
    delete state.allocationInterdisciplinary['jane@school.edu'];
    delete state.allocationInterdisciplinarySubject['jane@school.edu'];
    state.allocationOpenStudent = 'mark@school.edu';
    const onlyMark = deskMod.allocationRowMarkup(expandedStudent, supervisors(), [], {});
    assert.doesNotMatch(onlyMark, /alloc-expanded/);

    state.adminHeaderOpen = {};
    const settings = deskMod.allocationSettingsMarkup({
      driveReady: true,
      settings: {
        detectedChoiceKeys: ['choice1', 'interdisciplinary'],
        detectedDynamicKeys: ['Research notes', 'Mentor note'],
        columns: [
          { key: 'Research notes', showOnCard: true, expanded: false, source: 'static' },
          { key: 'Mentor note', showOnCard: true, expanded: false, source: 'live' },
        ],
        interdisciplinaryKey: 'interdisciplinary',
        primaryChoiceKey: 'choice1',
      },
      summary: { staffCount: 1, tokenCount: 1, activeStudents: 1, buffer: 0 },
      choiceRows: [{ studentId: 'jane@school.edu', displayName: 'Doe, Jane', subjectChoices: { choice1: 'History', interdisciplinary: 'maybe' }, dynamicData: {} }],
      students: [],
    });
    assert.match(settings, /Google Sheets sync/);
    assert.match(settings, /COHORTDATA Columns/);
    assert.match(settings, /Subject choice mapping/);
    assert.match(settings, /Dashboard Fields/);
    assert.match(settings, /First Choice/);
    assert.match(settings, /Interdisciplinary/);
    assert.match(settings, /data-alloc-col="choice1"/);
    assert.match(settings, /data-alloc-col="interdisciplinary"/);
    assert.match(settings, /Data Management/);
    assert.match(settings, /data-flag="expanded"/);
    assert.match(settings, /Mentor note/);
    assert.match(settings, /class="live-badge">LIVE</);
    assert.equal((settings.match(/class="live-badge"/g) || []).length, 1);
    assert.doesNotMatch(settings.slice(settings.indexOf('Research notes'), settings.indexOf('Research notes') + 80), /live-badge/);
    assert.match(settings, /must be exactly Yes or No/);
    assert.match(settings, /Doe, Jane/);
    assert.match(settings, /data-alloc-data-edit="jane@school.edu"/);
    assert.match(settings, /class="actions"/);
    const editor = deskMod.allocationStudentEditorMarkup({
      studentId: 'jane@school.edu',
      displayName: 'Doe, Jane',
      subjectChoices: { choice1: 'History', interdisciplinary: 'Yes' },
      dynamicData: { 'Y10 GPA': 'Strong', 'Mentor note': 'Bring sources' },
    }, {
      detectedChoiceKeys: ['choice1', 'interdisciplinary'],
      detectedDynamicKeys: ['Y10 GPA', 'Mentor note'],
      interdisciplinaryKey: 'interdisciplinary',
      columns: [
        { key: 'Y10 GPA', source: 'static' },
        { key: 'Mentor note', source: 'live' },
      ],
    });
    assert.match(editor, /id="alloc-student-editor-title">Edit Doe, Jane</);
    assert.match(editor, /value="History"/);
    assert.match(editor, /Y10 GPA/);
    assert.match(editor, /Mentor note/);
    assert.match(editor, /class="live-badge">LIVE</);
    assert.equal((editor.match(/data-alloc-modal-field/g) || []).length, 4);
    assert.match(editor, /data-key="interdisciplinary"[^>]*>[\s\S]*<option value="Yes" selected>/);
    assert.doesNotMatch(settings, /id="alloc-cohort"/);
    ['alloc-sync', 'alloc-cohortdata', 'alloc-choice-map', 'alloc-fields', 'alloc-data'].forEach(function(id) {
      assert.match(settings, new RegExp('data-toggle-header="' + id + '" aria-expanded="false"'));
      assert.match(settings, new RegExp('data-toggle-header="' + id + '" aria-expanded="false"><span class="table-header-mark" aria-hidden="true">></span>'));
    });
    assert.doesNotMatch(settings, />Hide</);
    assert.doesNotMatch(settings, />Show</);
    assert.match(settings, /id="alloc-live-url"/);
    assert.match(settings, /Live Google Sheet URL/);
    assert.match(settings, /Load sheet tabs/);
    assert.doesNotMatch(settings, /Core Data Fields/);

    state.allocationLiveCohort = '2026';
    state.allocationLiveUrl = 'https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit';
    state.allocationLiveTab = 'Choices';
    state.allocationLiveTabs = ['Choices', 'Notes'];
    state.allocationLiveHeaders = ['Student Email', 'First choice', 'Choice 1 Score', 'Choice 2 Score', 'HL subjects'];
    state.allocationLiveDraft = null;
    state.allocationLiveBusy = '';
    const liveDesk = {
      driveReady: true,
      settings: {
        detectedChoiceKeys: ['choice1'],
        detectedDynamicKeys: ['Research notes'],
        columns: [{ key: 'Research notes', showOnCard: true, expanded: false }],
        interdisciplinaryKey: 'interdisciplinary',
        primaryChoiceKey: 'choice1',
        spreadsheetId: 'abc123_XYZ-000000000000',
        sheetName: 'Choices',
        liveSheetTab: 'Choices',
        liveSheetUrl: state.allocationLiveUrl,
        columnMappings: {
          core: { studentNumber: '', studentEmail: 'Student Email' },
          subjectChoice: { primary: '', secondary: '', primaryScore: '', secondaryScore: '', interdisciplinary: '' },
          dashboard: { hl: '', support: '' },
        },
      },
      summary: { staffCount: 1, tokenCount: 1, activeStudents: 1, buffer: 0 },
      choiceRows: [],
      students: [],
    };
    const blocked = deskMod.allocationSettingsMarkup(liveDesk);
    assert.match(blocked, /Core Data Fields/);
    assert.match(blocked, /Subject Choice Mapping/);
    assert.match(blocked, /data-live-map="subjectChoice.primaryScore"/);
    assert.match(blocked, /Choice 1 Score/);
    assert.match(blocked, /data-live-map="subjectChoice.secondaryScore"/);
    assert.match(blocked, /Choice 2 Score/);
    assert.match(blocked, /Dashboard Fields/);
    assert.match(blocked, /id="alloc-live-tab"/);
    assert.match(blocked, /id="alloc-live-save"[^>]*disabled/);
    assert.match(blocked, /Map Primary choice before saving/);
    state.allocationLiveDraft = {
      core: { studentNumber: '', studentEmail: 'Student Email' },
      subjectChoice: { primary: 'First choice', secondary: '', primaryScore: 'Choice 1 Score', secondaryScore: 'Choice 2 Score', interdisciplinary: '' },
      dashboard: { hl: '', support: '' },
    };
    const ready = deskMod.allocationSettingsMarkup(liveDesk);
    const saveButton = ready.slice(ready.indexOf('id="alloc-live-save"'), ready.indexOf('id="alloc-live-save"') + 80);
    assert.match(saveButton, /id="alloc-live-save"/);
    assert.doesNotMatch(saveButton, /disabled/);
    state.allocationLiveDraft = null;
    state.allocationLiveTabs = [];
    state.allocationLiveHeaders = [];
    state.allocationLiveCohort = '';

    const linkedDesk = desk();
    linkedDesk.settings = { columns: [], spreadsheetId: 'abc123_XYZ-000000000000', sheetName: 'Choices', liveSheetTab: 'Choices', driveReady: true };
    const linkedHtml = deskMod.allocationDashboardMarkup(linkedDesk);
    assert.match(linkedHtml, /id="alloc-resync-live"/);
    assert.match(linkedHtml, /Resync Live Choice Data/);
    const syncSlot = linkedHtml.slice(linkedHtml.indexOf('alloc-sync-slot'), linkedHtml.indexOf('data-table-header="alloc-filters"'));
    assert.match(syncSlot, /Resync Live Choice Data/);
    assert.ok(linkedHtml.indexOf('Active Students') < linkedHtml.indexOf('alloc-sync-slot'));
    assert.ok(syncSlot.indexOf('id="alloc-resync-live"') < syncSlot.indexOf('class="alloc-sync-meta"') || !/alloc-sync-meta/.test(syncSlot));
    assert.doesNotMatch(linkedHtml.slice(linkedHtml.indexOf('id="alloc-resync-live"'), linkedHtml.indexOf('id="alloc-resync-live"') + 120), /disabled/);
    state.allocationLiveBusy = 'resync';
    const busyHtml = deskMod.allocationDashboardMarkup(linkedDesk);
    assert.match(busyHtml, /id="alloc-resync-live"[^>]*disabled/);
    assert.match(busyHtml, /Resyncing live choice data/);
    state.allocationLiveBusy = '';
    linkedDesk.settings.lastSyncedAt = new Date(Date.now() - 15000).toISOString();
    const cooling = deskMod.allocationDashboardMarkup(linkedDesk);
    assert.match(cooling, /id="alloc-resync-live"[^>]*disabled/);
    assert.match(cooling, /Last synced 1[45] seconds ago/);
    linkedDesk.settings.lastSyncedAt = new Date(Date.now() - 120000).toISOString();
    const cooled = deskMod.allocationDashboardMarkup(linkedDesk);
    assert.doesNotMatch(cooled.slice(cooled.indexOf('id="alloc-resync-live"'), cooled.indexOf('id="alloc-resync-live"') + 160), /disabled/);
    assert.match(cooled, /Last synced \d+ seconds ago/);
    const cooledSlot = cooled.slice(cooled.indexOf('alloc-sync-slot'), cooled.indexOf('data-table-header="alloc-filters"'));
    assert.ok(cooledSlot.indexOf('id="alloc-resync-live"') < cooledSlot.indexOf('id="alloc-resync-age"'));
    assert.match(cooledSlot, /class="alloc-sync-meta"/);
    delete linkedDesk.settings.lastSyncedAt;

    const board = deskMod.cohortTokensMarkup({
      cohortId: '2026',
      subjects: ['History'],
      staff: [{ email: 'psy@school.edu', displayName: 'Dr Psy' }],
      summary: { teachersAllocated: 1, tokenCount: 2, studentCount: 4 },
      tokens: [{
        id: 't1',
        staffId: 'psy@school.edu',
        staffName: 'Dr Psy',
        eligibleSubjects: ['History'],
        status: 'draft',
        allocatedTo: 'jane@school.edu',
        studentName: 'Doe, Jane',
        assignedSubject: 'History',
      }],
    });
    assert.match(board, /Teachers allocated <strong>1<\/strong>/);
    assert.match(board, /Number of tokens <strong>2<\/strong>/);
    assert.match(board, /Number of students <strong>4<\/strong>/);
    assert.match(board, /<strong>Doe, Jane<\/strong><div class="muted">jane@school.edu<\/div>/);
    assert.doesNotMatch(board, /id="alloc-cohort"/);

    const flagged = student({ supportFlags: ['EAL', 'SEN'] });
    const flaggedRow = deskMod.allocationRowMarkup(flagged, supervisors(), [], {});
    assert.match(flaggedRow, /class="support-tag">EAL</);
    assert.match(flaggedRow, /class="support-tag">SEN</);
    assert.doesNotMatch(flaggedRow, /support-badge/);
    const needsSupport = student({
      supportFlags: ['Needs support', 'Needs support'],
      flags: { needsSupport: true, drafted: false, committed: false, subjectMatch: 'none', hlMatch: 'none' },
    });
    const once = deskMod.allocationRowMarkup(needsSupport, supervisors(), [], {});
    assert.equal((once.match(/class="support-tag"/g) || []).length, 1);
    assert.match(once, /class="support-tag">Needs support</);
    assert.doesNotMatch(once, /support-badge/);
    state.allocationAssignedOpen = { biology: true };
    const assigned = deskMod.allocationAssignedMarkup({
      subjects: [{ name: 'Biology', shortName: 'Bio' }],
      tokenRows: [
        { status: 'available', eligibleSubjects: ['Biology'], staffId: 'ann@school.edu', staffName: 'Ann', studentId: '', studentName: '' },
        { status: 'draft', eligibleSubjects: ['Biology'], staffId: 'ben@school.edu', staffName: 'Ben', studentId: 'jane@school.edu', studentName: 'Doe, Jane', assignedSubject: 'Biology' },
      ],
    });
    assert.match(assigned, /class="alloc-token-open"/);
    assert.match(assigned, /class="alloc-token-taken"/);
    assert.match(assigned, /Ann/);
    assert.match(assigned, /Doe, Jane/);
    assert.match(assigned, /role="progressbar"[^>]*aria-valuenow="1"[^>]*aria-valuemax="2"/);
    state.allocationAssignedOpen = {};
    state.allocationSupportFlags = ['EAL'];
    state.allocationSubjectFilter = [];
    const flagSource = desk();
    flagSource.students[0].supportFlags = ['EAL'];
    flagSource.students[1].supportFlags = ['SEN'];
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationSupportFlags = [];
    state.allocationSelectedSubjectFilter = ['Theater'];
    flagSource.students[1].token = { staffId: 'art@school.edu', staffName: 'Mx Art', assignedSubject: 'Theater', eligibleSubjects: ['Theater'] };
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), []);
    flagSource.students[1].selectedSubject = 'Theater';
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), ['mark@school.edu']);
    const customSource = desk();
    customSource.settings.columns = [{ key: 'Y10 GPA', filterable: true }];
    customSource.students[0].dynamicData = { 'Y10 GPA': 'Weak' };
    customSource.students[1].dynamicData = { 'Y10 GPA': 'Strong' };
    state.allocationSelectedSubjectFilter = [];
    state.allocationTeacherFilter = [];
    state.allocationCustomFilters = {};
    customSource.students[0].dynamicData = { 'Y10 GPA': '10' };
    customSource.students[1].dynamicData = { 'Y10 GPA': '2' };
    const numericMarkup = deskMod.allocationCustomFilterMarkup(customSource);
    assert.ok(numericMarkup.indexOf('data-alloc-custom-value="2"') < numericMarkup.indexOf('data-alloc-custom-value="10"'));
    customSource.students[0].dynamicData = { 'Y10 GPA': 'Weak' };
    customSource.students[1].dynamicData = { 'Y10 GPA': 'Strong' };
    const customMarkup = deskMod.allocationCustomFilterMarkup(customSource);
    assert.match(customMarkup, /data-alloc-custom-filter="Y10 GPA"/);
    assert.match(customMarkup, /data-alloc-custom-query="Y10 GPA"/);
    assert.ok(customMarkup.indexOf('data-alloc-custom-value="Strong"') < customMarkup.indexOf('data-alloc-custom-value="Weak"'));
    state.allocationCustomFilters = { 'Y10 GPA': 'Weak' };
    assert.match(deskMod.allocationDashboardMarkup(customSource), /data-alloc-custom-filter="Y10 GPA"/);
    assert.deepEqual(deskMod.visibleAllocationStudents(customSource).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationCustomFilters = { 'Y10 GPA': ['Weak', 'Strong'] };
    assert.deepEqual(deskMod.visibleAllocationStudents(customSource).map((item) => item.studentId), ['jane@school.edu', 'mark@school.edu']);
    state.allocationCustomFilters = {};
    state.allocationQuery = 'lee, mark';
    assert.deepEqual(deskMod.visibleAllocationStudents(customSource).map((item) => item.studentId), ['mark@school.edu']);
    state.allocationQuery = 'JANE@school';
    assert.deepEqual(deskMod.visibleAllocationStudents(customSource).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationQuery = '';
    customSource.students[0].flags = { needsSupport: false, drafted: false, committed: true, subjectMatch: 'match', hlMatch: 'none' };
    customSource.students[0].token = { staffId: 'psy@school.edu', staffName: 'Dr Psy', assignedSubject: 'Psychology', status: 'committed' };
    state.allocationStatus = 'published';
    assert.deepEqual(deskMod.visibleAllocationStudents(customSource).map((item) => item.studentId), ['jane@school.edu']);
    const publishedRow = deskMod.allocationRowMarkup(customSource.students[0], supervisors(), [], {});
    assert.match(publishedRow, /class="is-published"/);
    assert.match(publishedRow, /title="Published"/);
    assert.match(publishedRow, /disabled/);
    assert.doesNotMatch(publishedRow, /Return to draft/);
    assert.doesNotMatch(publishedRow, /class="supervisor-cue/);
    state.allocationStatus = 'unallocated';
    assert.deepEqual(deskMod.visibleAllocationStudents(customSource).map((item) => item.studentId), ['mark@school.edu']);
    state.allocationStatus = 'all';
    state.allocationCustomFilters = {};
    state.allocationSelectedSubjectFilter = [];
    state.allocationTeacherFilter = ['art@school.edu'];
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), ['mark@school.edu']);

    const live = await server.ssrLoadModule('/src/allocation/realtime.js');
    const pending = {
      'jane@school.edu': { staffId: 'psy@school.edu', subject: 'Psychology', interdisciplinary: true, acked: false, ackRevision: 0 },
    };
    const remote = desk();
    const shown = live.overlayPendingEdits(remote, pending);
    assert.equal(shown.students[0].token.staffId, 'psy@school.edu');
    assert.equal(shown.supervisors.find((person) => person.staffId === 'psy@school.edu').available, 0);
    const held = desk();
    held.students[0].token = { staffId: 'psy@school.edu', assignedSubject: 'Psychology', status: 'draft' };
    held.supervisors = supervisors().map(function(person) {
      return person.staffId === 'psy@school.edu' ? Object.assign({}, person, { available: 0, used: 1, total: 1 }) : person;
    });
    const released = live.overlayPendingEdits(held, {
      'jane@school.edu': { staffId: '', subject: '', interdisciplinary: false },
    });
    assert.equal(released.students[0].token, null);
    assert.equal(released.supervisors.find((person) => person.staffId === 'psy@school.edu').available, 1);
    assert.equal(shown.students[0].token.assignedSubject, 'Psychology');
    assert.equal(shown.students[0].token.interdisciplinary, true);
    assert.equal(shown.students[0].token.status, 'draft');
    assert.equal(shown.students[1].studentId, 'mark@school.edu');
    assert.equal(shown.students[1].token, null);
    const echoed = desk();
    echoed.students[0].token = { staffId: 'psy@school.edu', assignedSubject: 'Psychology', interdisciplinary: true, status: 'draft' };
    assert.deepEqual(live.reconcilePendingEdits(pending, echoed, 2), {});
    const other = desk();
    other.students[0].token = { staffId: 'art@school.edu', assignedSubject: 'Theater', interdisciplinary: false, status: 'draft' };
    assert.equal(live.reconcilePendingEdits(pending, other, 2)['jane@school.edu'].staffId, 'psy@school.edu');
    const acked = { 'jane@school.edu': Object.assign({}, pending['jane@school.edu'], { acked: true, startedAt: '2026-10-29T00:00:00.000Z' }) };
    assert.equal(live.reconcilePendingEdits(acked, other, { 'jane@school.edu': '2026-10-28T00:00:00.000Z' })['jane@school.edu'].staffId, 'psy@school.edu');
    assert.deepEqual(live.reconcilePendingEdits(acked, other, { 'jane@school.edu': '2026-10-29T00:00:01.000Z' }), {});
    const kept = live.overlayPendingEdits(other, pending);
    assert.equal(kept.students[0].token.staffId, 'psy@school.edu');
    assert.equal(kept.students[0].token.staffName, 'Dr Psy');
    const withRows = desk();
    withRows.tokenRows = [
      { id: 't1', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Psychology'], studentId: '', assignedSubject: '' },
      { id: 't2', staffId: 'art@school.edu', status: 'available', eligibleSubjects: ['Theater'], studentId: '', assignedSubject: '' },
    ];
    const overlaid = live.overlayPendingEdits(withRows, pending);
    assert.equal(overlaid.tokenRows.find((row) => row.id === 't1').status, 'draft');
    assert.equal(overlaid.tokenRows.find((row) => row.id === 't1').assignedSubject, 'Psychology');
    assert.equal(overlaid.tokenRows.find((row) => row.id === 't2').status, 'available');
    assert.equal(overlaid.supervisors.find((person) => person.staffId === 'psy@school.edu').available, 0);

    const built = live.deskFromAllocationSources('2026', {
      members: [{ StudentId: 'jane@school.edu', Surname: 'Doe', 'First Name': 'Jane', eeActive: true }],
      workspace: [{ id: 'jane@school.edu', studentId: 'jane@school.edu', subjectChoices: { choice1: 'Psychology' }, dynamicData: {}, pendingClear: false }],
      tokens: [{ id: 't1', cohortId: '2026', staffId: 'psy@school.edu', allocatedTo: 'jane@school.edu', assignedSubject: 'Psychology', interdisciplinary: true, status: 'draft', eligibleSubjects: ['Psychology'] }],
      settings: { primaryChoiceKey: 'choice1', lastSyncedAt: '2026-10-29T00:00:00.000Z', columns: [], columnMappings: {} },
      staff: [{ id: 'psy@school.edu', EMAIL: 'psy@school.edu', DisplayName: 'Dr Psy' }],
      subjects: [{ Name: 'Psychology', Active: true, Colour: '#6b4c9a' }],
    });
    assert.equal(built.students.length, 1);
    assert.equal(built.students[0].token.staffName, 'Dr Psy');
    assert.equal(built.students[0].token.interdisciplinary, true);
    assert.equal(built.students[0].token.assignedSubject, 'Psychology');
    assert.equal(built.settings.lastSyncedAt, '2026-10-29T00:00:00.000Z');
    assert.equal(built.students[0].requestedSubjects[0].name, 'Psychology');
  } finally {
    await server.close();
  }
});

test('allocation listeners unsubscribe when the dashboard is left', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const previousWindow = globalThis.window;
  try {
    globalThis.window = globalThis;
    let stops = 0;
    window.eeCall = function() {
      return Promise.resolve({ driveReady: true, settings: { columns: [] }, students: [], supervisors: [] });
    };
    window.eeWatchAllocation = function() {
      return function() { stops += 1; };
    };
    const live = await server.ssrLoadModule('/src/allocation/realtime.js');
    const stateMod = await server.ssrLoadModule('/src/shared/state.js');
    globalThis.document = {
      getElementById() { return null; },
      querySelector() { return null; },
      addEventListener() {},
      scrollingElement: null,
    };
    stateMod.state.cohortId = '2026';
    stateMod.state.section = 'allocation';
    stateMod.state.allocationView = 'dashboard';
    live.beginAllocationWatch('2026');
    live.beginAllocationWatch('2027');
    stateMod.state.allocationPendingEdits = { 'jane@school.edu': { staffId: 'psy@school.edu', subject: 'Psychology', interdisciplinary: false } };
    assert.equal(stops, 1);
    assert.equal(stateMod.state.allocationWatchCohort, '2027');
    live.releaseAllocationWatch();
    assert.equal(stops, 2);
    assert.equal(stateMod.state.allocationWatchCohort, '');
    assert.deepEqual(stateMod.state.allocationPendingEdits, {});
    assert.equal(typeof window.eeReleaseAllocationWatch, 'function');
    window.eeWatchAllocation = function() {
      return function() { stops += 1; };
    };
    live.beginAllocationWatch('2026');
    window.eeReleaseAllocationWatch();
    assert.equal(stops, 3);
    assert.equal(stateMod.state.allocationWatchCohort, '');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    delete globalThis.document;
    await server.close();
  }
});

test('suggestions, department rows, and the HOD drawer', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const deskMod = await server.ssrLoadModule('/src/allocation/desk.js');
    const stateMod = await server.ssrLoadModule('/src/shared/state.js');
    const state = stateMod.state;
    state.allocationView = 'dashboard';
    state.allocationLoadView = 'subject';
    state.allocationAssignedOpen = {};
    state.allocationHodDepartment = '';
    state.allocationHodStatus = { byDepartment: {} };
    state.user = { email: 'hod@school.edu', permissions: { isHOD: true, canAdmin: false } };
    state.adminTableSort = {};
    const suggested = deskMod.allocationRowMarkup(student({
      selectedSubject: 'Psychology',
      suggestedStaffId: 'psy@school.edu',
      suggestedStaffName: 'Dr Psy',
    }), supervisors(), [], {});
    assert.match(suggested.split('</td>')[2], /Suggested: Dr Psy/);
    assert.match(suggested.split('</td>')[2], /class="alloc-approve-link"[^>]*>Approve</);
    assert.match(suggested.split('</td>')[2], /data-alloc-approve="jane@school.edu"/);
    assert.doesNotMatch(suggested.split('</td>')[2], /class="button"/);
    const published = deskMod.allocationRowMarkup(student({
      selectedSubject: 'Psychology',
      suggestedStaffId: 'psy@school.edu',
      suggestedStaffName: 'Dr Psy',
      flags: { committed: true, drafted: false, needsSupport: false, subjectMatch: 'none', hlMatch: 'none' },
      token: { status: 'committed', staffId: 'psy@school.edu', assignedSubject: 'Psychology', staffName: 'Dr Psy' },
    }), supervisors(), [], {});
    assert.match(published, /Suggested: Dr Psy/);
    assert.doesNotMatch(published, /data-alloc-approve/);

    const hodDesk = desk();
    hodDesk.subjects = [
      { name: 'Psychology', shortName: 'Psy', colour: '#6b4c9a', department: 'Humanities' },
      { name: 'Theater', shortName: 'The', colour: '#0e8a6a', department: 'Arts' },
    ];
    hodDesk.directory = [{ email: 'hod@school.edu', displayName: 'Dr Hod', department: 'Humanities', isHOD: true }];
    hodDesk.tokenRows = [
      { id: 't1', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Psychology'], studentId: '' },
      { id: 't2', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Psychology'], studentId: '' },
      { id: 't3', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Psychology'], studentId: '' },
    ];
    hodDesk.students = [
      student({ selectedSubject: 'Psychology', suggestedStaffId: 'psy@school.edu', suggestedSubject: 'Psychology', suggestedStaffName: 'Dr Psy' }),
      student({ studentId: 'pat@school.edu', displayName: 'Jones, Pat', sortName: 'jones, pat', selectedSubject: 'Psychology', suggestedStaffId: 'psy@school.edu', suggestedSubject: 'Psychology', suggestedStaffName: 'Dr Psy' }),
      student({ studentId: 'mark@school.edu', displayName: 'Lee, Mark', sortName: 'lee, mark', selectedSubject: 'Theater', requestedSubjects: [theater] }),
    ];
    state.allocationView = 'hod';
    state.allocationHodDepartment = 'Arts';
    const other = deskMod.allocationHodMarkup(hodDesk);
    assert.match(other, /data-alloc-suggest="mark@school.edu"[^>]*disabled/);
    state.allocationHodDepartment = 'Humanities';
    state.allocationHodStatus = { byDepartment: {} };
    const own = deskMod.allocationHodMarkup(hodDesk);
    const janeAt = own.indexOf('data-alloc-suggest="jane@school.edu"');
    assert.doesNotMatch(own.slice(janeAt, janeAt + 220), /disabled/);
    assert.match(own, /Dr Psy \(2\/3\)/);
    assert.match(own, /Certify & Submit Suggestions/);
    state.allocationHodStatus = { byDepartment: { humanities: { department: 'Humanities', submitted: true, submittedAt: '2026-11-04T00:00:00.000Z', submittedBy: 'hod@school.edu' } } };
    const locked = deskMod.allocationHodMarkup(hodDesk);
    assert.match(locked, /data-alloc-suggest="jane@school.edu"[^>]*disabled/);
    assert.match(locked, /Submitted/);
    assert.match(own, /data-table-header="alloc-hod-status"/);
    assert.match(own, /HOD listing/);
    assert.match(own, /table-header-body" hidden/);
    assert.match(own, /data-alloc-expand="jane@school.edu"/);
    state.allocationOpenStudent = 'jane@school.edu';
    state.allocationDesk = hodDesk;
    const openedStudent = deskMod.allocationHodMarkup(hodDesk);
    assert.match(openedStudent, /class="alloc-expanded"/);
    assert.match(openedStudent, /<dt>Choice 1<\/dt>/);
    state.allocationOpenStudent = '';
    state.allocationLoadView = 'assigned';
    const drawer = deskMod.allocationLoadPanel(hodDesk, supervisors());
    assert.match(drawer, /Suggested taken/);
  } finally {
    await server.close();
  }
});

test('coordinator token overview summarizes workflow stages and drilldown IDs', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const deskMod = await server.ssrLoadModule('/src/allocation/desk.js');
    const stateMod = await server.ssrLoadModule('/src/shared/state.js');
    const state = stateMod.state;
    state.allocationView = 'dashboard';
    state.allocationLoadView = 'overview';
    state.allocationHodStatus = {
      byDepartment: {
        humanities: { department: 'Humanities', submitted: true },
        arts: { department: 'Arts', submitted: false },
      },
    };
    const workflow = desk();
    workflow.subjects = [
      { name: 'Psychology', department: 'Humanities' },
      { name: 'Theater', department: 'Arts' },
    ];
    workflow.tokenRows = [
      { id: 'p1', staffId: 'psy@school.edu', status: 'available', eligibleSubjects: ['Psychology'], studentId: '' },
      { id: 't1', staffId: 'art@school.edu', status: 'draft', eligibleSubjects: ['Theater'], studentId: 'mark@school.edu', assignedSubject: 'Theater' },
    ];
    workflow.students = [
      student({ selectedSubject: 'Psychology', suggestedStaffId: 'psy@school.edu', suggestedSubject: 'Psychology' }),
      student({ studentId: 'pat@school.edu', displayName: 'Jones, Pat', sortName: 'jones, pat', selectedSubject: 'Psychology' }),
      student({ studentId: 'mark@school.edu', displayName: 'Lee, Mark', sortName: 'lee, mark', selectedSubject: 'Theater', token: { staffId: 'art@school.edu', status: 'draft', assignedSubject: 'Theater' } }),
      student({ studentId: 'sam@school.edu', displayName: 'Smith, Sam', sortName: 'smith, sam' }),
    ];

    const overview = deskMod.allocationCoordinatorOverview(workflow);
    assert.deepEqual(overview.subject, { selected: 3, needed: 1 });
    assert.deepEqual(overview.proposal, { needsProposal: 1, awaitingApproval: 1, stale: 0 });
    assert.deepEqual(overview.assignment, { drafts: 1, published: 0 });
    assert.deepEqual(overview.drilldowns['proposal-review'], ['jane@school.edu']);
    assert.deepEqual(overview.drilldowns['subject-needed'], ['sam@school.edu']);
    assert.deepEqual(overview.drilldowns['department:Humanities'], ['jane@school.edu', 'pat@school.edu']);
    assert.equal(overview.departments.find((item) => item.department === 'Humanities').submitted, true);
    assert.equal(overview.subjects.find((item) => item.subject === 'Psychology').shortfall, 1);

    const html = deskMod.allocationLoadPanel(workflow, supervisors());
    assert.match(html, /Subject decisions/);
    assert.match(html, /HOD proposals/);
    assert.match(html, /Coordinator assignment/);
    assert.match(html, /Proposal subject changed/);
    assert.match(html, /over capacity/);
    assert.match(html, /HOD submitted/);

    state.allocationOverviewDrilldown = {
      ids: overview.drilldowns['proposal-review'],
      label: overview.drilldownLabels['proposal-review'],
    };
    assert.deepEqual(deskMod.visibleAllocationStudents(workflow).map((item) => item.studentId), ['jane@school.edu']);
  } finally {
    await server.close();
  }
});
