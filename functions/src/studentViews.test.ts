import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFeed, STUDENT_VIEW_EVENTS, studentViewEventName } from './activity';
import { recordStudentView } from './journey';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const STUDENT = 'student@vsa.example.edu';
const STAFF = 'supervisor@vsa.example.edu';

function memory() {
  const audits: Doc[] = [];
  const store = {
    audits,
    async list() { return []; },
    async get(name: string, id: string) {
      if (name === COLLECTIONS.staffUsers && id === STAFF) {
        return { EMAIL: STAFF, DisplayName: 'Priya', isStaff: true, isSupervisor: true };
      }
      if (name === COLLECTIONS.studentUsers && id === STUDENT) {
        return { StudentId: STUDENT, DisplayName: 'Jamie' };
      }
      return null;
    },
    async getMember() { return null; },
    async addAudit(entry: Doc) { audits.push(entry); },
  };
  return store;
}

function appFor(email: string, store: ReturnType<typeof memory>): App {
  return { store: store as unknown as Store, email, timeZone: 'Asia/Hong_Kong' };
}

test('student view opens use three distinct ledger names', () => {
  assert.equal(studentViewEventName('document'), 'student.view.document');
  assert.equal(studentViewEventName('journey'), 'student.view.journey');
  assert.equal(studentViewEventName('supervisor'), 'student.view.supervisor');
  assert.deepEqual(Object.values(STUDENT_VIEW_EVENTS), [
    'student.view.document',
    'student.view.journey',
    'student.view.supervisor',
  ]);
  assert.throws(() => studentViewEventName('help'), /Unknown student view/);
  assert.throws(() => studentViewEventName(''), /Unknown student view/);
});

test('a student view open is one ledger row and a staff open is not', async () => {
  const store = memory();
  const studentApp = appFor(STUDENT, store);
  const saved = [];
  for (const view of ['document', 'journey', 'supervisor']) {
    saved.push(await recordStudentView(studentApp, view));
  }
  assert.deepEqual(saved.map((row) => row.event), [
    'student.view.document',
    'student.view.journey',
    'student.view.supervisor',
  ]);
  assert.deepEqual(store.audits.map((row) => row.Action), [
    'student.view.document',
    'student.view.journey',
    'student.view.supervisor',
  ]);
  store.audits.forEach((row) => {
    assert.equal(row.User, STUDENT);
    const payload = JSON.parse(String(row.Payload));
    assert.equal(payload.actor, 'student');
    assert.equal(payload.event, row.Action);
  });

  const before = store.audits.length;
  const staffStore = memory();
  await assert.rejects(recordStudentView(appFor(STAFF, staffStore), 'document'), /Access denied/);
  assert.equal(staffStore.audits.some((row) => String(row.Action).startsWith('student.view.')), false);
  assert.equal(store.audits.length, before);
  await assert.rejects(recordStudentView(studentApp, 'help'), /Unknown student view/);
  assert.equal(store.audits.length, before);
});

test('view opens show up in the student activity feed under their own names', () => {
  const feed = activityFeed(STUDENT, [
    { Timestamp: '2026-10-01T00:00:00.000Z', User: STUDENT, Action: 'student.view.document', Payload: '{"event":"student.view.document","view":"document","cohort":"2026","actor":"student"}' },
    { Timestamp: '2026-10-02T00:00:00.000Z', User: STUDENT, Action: 'student.view.supervisor', Payload: '{"event":"student.view.supervisor","view":"supervisor","cohort":"2026","actor":"student"}' },
  ], {}, {});
  assert.deepEqual(feed.entries.map((entry) => entry.action), ['student.view.supervisor', 'student.view.document']);
  assert.equal(feed.entries[0].kind, 'view');
  assert.equal(feed.entries[0].title, 'Opened Supervisor');
  assert.equal(feed.entries[0].summary, 'Opened the Supervisor view');
  assert.equal(feed.entries[1].title, 'Opened Document');
  assert.equal(feed.counts.view, 2);
  assert.equal(feed.entries[0].details.some((row: { label: string; value: string }) => row.label === 'View' && row.value === 'student.view.supervisor'), true);
  assert.equal(feed.entries[0].details.some((row: { label: string; value: string }) => row.label === 'Cohort' && row.value === '2026'), true);
});
