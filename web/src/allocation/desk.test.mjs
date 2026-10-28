import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const psychology = { name: 'Psychology', colour: '#6b4c9a' };
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
    assert.equal((table.match(/<tr>/g) || []).length, 2);
    assert.doesNotMatch(table, />Mathematics</);
  } finally {
    await server.close();
  }
});
