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
    state.allocationAllocatedFilter = [];
    state.allocationTeacherFilter = [];
    state.allocationSupportFlags = [];
    state.allocationOpenStudent = '';
    state.allocationAssignedOpen = {};
    state.allocationInterdisciplinary = {};
    state.allocationDataSelected = [];
    state.adminHeaderOpen = {};
    state.adminTableSort = { 'alloc-desk': { key: 'name', dir: 1 } };

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

    const row = deskMod.allocationRowMarkup(student({}), supervisors(), [], {});
    const cells = row.split('</td>');
    assert.match(cells[2], /data-subject="Psychology"/);
    assert.match(cells[3], /<select/);
    assert.match(cells[3], /Dr Psy/);
    assert.match(cells[3], /Mx Art/);
    assert.match(cells[3], /Pat Open/);
    assert.doesNotMatch(row, /class="supervisor-cue"/);
    assert.match(deskMod.allocationRowMarkup(desk().students[1], supervisors(), [], {}), /class="id-tag"[^>]*>ID</);

    state.allocationSubjects = { 'jane@school.edu': 'Psychology' };
    const cues = deskMod.allocationSupervisorCues(student({
      token: { staffId: 'psy@school.edu', assignedSubject: 'Psychology' },
    }), supervisors());
    assert.match(cues, /Dr Psy/);
    assert.match(cues, /class="supervisor-cue is-chosen"/);
    assert.match(cues, /--subject:#6b4c9a/);
    assert.doesNotMatch(cues, /Mx Art/);
    assert.doesNotMatch(cues, /Pat Open/);
    const chosenRow = deskMod.allocationRowMarkup(student({
      token: { staffId: 'psy@school.edu', assignedSubject: 'Psychology' },
    }), supervisors(), [], {});
    const select = chosenRow.slice(chosenRow.indexOf('<select'), chosenRow.indexOf('</select>'));
    assert.match(select, /Dr Psy/);
    assert.match(select, /Mx Art/);
    assert.match(select, /Pat Open/);

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
    assert.match(table, /Pool \| UPool \| Alloc \| Rem/);
    assert.match(table, /Total requested \(Pool\)/);
    assert.match(table, /class="alloc-subject-block"/);
    assert.match(table, /class="alloc-subject-figures"/);
    assert.equal((table.match(/alloc-subject-block/g) || []).length, 1);
    assert.doesNotMatch(table, /<table/);
    assert.doesNotMatch(table, />Mathematics</);
    assert.match(html, /id="alloc-clear-filters"/);
    assert.match(html, /data-alloc-allocated-filter="Psychology"/);
    assert.match(html, /title="Psychology">Psy</);
    assert.match(html, /data-alloc-teacher-filter="psy@school.edu"/);
    assert.match(html, /data-alloc-load="assigned"/);
    assert.match(html, /aria-label="Star key"/);
    assert.doesNotMatch(html, /id="alloc-cohort"/);
    assert.doesNotMatch(html, /Resync Live Choice Data/);
    assert.match(html, /class="alloc-drawer"/);
    assert.match(html, /id="alloc-drawer-peek"/);
    assert.match(html, /Token load/);
    assert.doesNotMatch(html, /class="alloc-side"/);

    const sehs = 'Sports, Exercise, and Health Science (SEHS)';
    const sehsLoad = pure.subjectTokenLoad([{ status: 'available', eligibleSubjects: ['Sports', 'Exercise', 'and Health Science (SEHS)'] }], [], [sehs]);
    const sehsTable = deskMod.subjectTokenLoadMarkup(sehsLoad, { subjects: [{ name: sehs, shortName: 'SEHS' }] });
    assert.match(sehsTable, /Sports, Exercise, and Health Science \(SEHS\)/);
    assert.match(sehsTable, /title="Sports, Exercise, and Health Science \(SEHS\)">SEHS</);
    assert.equal((sehsTable.match(/alloc-subject-block/g) || []).length, 1);
    assert.doesNotMatch(sehsTable, />Sports</);
    assert.doesNotMatch(sehsTable, /<table/);

    state.allocationOpenStudent = 'jane@school.edu';
    state.allocationDesk = desk();
    state.allocationDesk.settings.columns = [{ key: 'Research notes', showOnCard: false, expanded: true }];
    const expandedStudent = student({ dynamicData: { 'Research notes': 'A long paragraph about the question.' }, subjectChoices: { interdisciplinary: 'Yes' } });
    const expanded = deskMod.allocationRowMarkup(expandedStudent, supervisors(), [], {});
    assert.match(expanded, /data-alloc-expand="jane@school.edu"/);
    assert.match(expanded, /<dt>Choice 1<\/dt>/);
    assert.match(expanded, /<dt>Choice 2<\/dt>/);
    assert.match(expanded, /<dt>Interdisciplinary<\/dt>/);
    assert.match(expanded, /Research notes/);
    assert.match(expanded, /A long paragraph/);
    assert.match(expanded, /Interdisciplinary EE/);
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
    assert.match(settings, /Data Management/);
    assert.match(settings, /data-flag="expanded"/);
    assert.match(settings, /Mentor note/);
    assert.match(settings, /class="live-badge">LIVE</);
    assert.equal((settings.match(/class="live-badge"/g) || []).length, 1);
    assert.doesNotMatch(settings.slice(settings.indexOf('Research notes'), settings.indexOf('Research notes') + 80), /live-badge/);
    assert.match(settings, /must be exactly Yes or No/);
    assert.match(settings, /Doe, Jane/);
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
    state.allocationLiveHeaders = ['Student Email', 'First choice', 'HL subjects'];
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
          subjectChoice: { primary: '', secondary: '', interdisciplinary: '' },
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
    assert.match(blocked, /Dashboard Fields/);
    assert.match(blocked, /id="alloc-live-tab"/);
    assert.match(blocked, /id="alloc-live-save"[^>]*disabled/);
    assert.match(blocked, /Map Primary choice before saving/);
    state.allocationLiveDraft = {
      core: { studentNumber: '', studentEmail: 'Student Email' },
      subjectChoice: { primary: 'First choice', secondary: '', interdisciplinary: '' },
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
    assert.doesNotMatch(linkedHtml.slice(linkedHtml.indexOf('id="alloc-resync-live"'), linkedHtml.indexOf('id="alloc-resync-live"') + 120), /disabled/);
    state.allocationLiveBusy = 'resync';
    const busyHtml = deskMod.allocationDashboardMarkup(linkedDesk);
    assert.match(busyHtml, /id="alloc-resync-live"[^>]*disabled/);
    assert.match(busyHtml, /Resyncing live choice data/);
    state.allocationLiveBusy = '';

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
    state.allocationSupportFlags = ['EAL'];
    state.allocationSubjectFilter = [];
    const flagSource = desk();
    flagSource.students[0].supportFlags = ['EAL'];
    flagSource.students[1].supportFlags = ['SEN'];
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), ['jane@school.edu']);
    state.allocationSupportFlags = [];
    state.allocationAllocatedFilter = ['Theater'];
    flagSource.students[1].token = { staffId: 'art@school.edu', staffName: 'Mx Art', assignedSubject: 'Theater', eligibleSubjects: ['Theater'] };
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), ['mark@school.edu']);
    state.allocationAllocatedFilter = [];
    state.allocationTeacherFilter = ['art@school.edu'];
    assert.deepEqual(deskMod.visibleAllocationStudents(flagSource).map((item) => item.studentId), ['mark@school.edu']);
  } finally {
    await server.close();
  }
});
