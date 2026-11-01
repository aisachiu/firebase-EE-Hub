import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Store } from './store';
import { deleteStudentTask, listStudentTasks, saveStudentTask } from './studentTasks';
import { Doc } from './util';

const COORDINATOR = 'coordinator@vsa.example.edu';
const SUPERVISOR = 'supervisor@vsa.example.edu';
const JAMIE = 'jamie@vsa.example.edu';
const OTHER = 'other@vsa.example.edu';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};

  async list(name: string): Promise<Doc[]> {
    return Object.values(this.docs[name] || {}).map((row) => ({ ...row }));
  }

  async get(name: string, id: string): Promise<Doc | null> {
    const row = (this.docs[name] || {})[id];
    return row ? { ...row } : null;
  }

  async set(name: string, id: string, data: Doc): Promise<void> {
    (this.docs[name] ||= {})[id] = { ...data };
  }

  async remove(name: string, id: string): Promise<void> {
    delete (this.docs[name] || {})[id];
  }

  async whereEqual(name: string, field: string, value: unknown): Promise<Doc[]> {
    return (await this.list(name)).filter((row) => row[field] === value);
  }

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const row = (this.members[cohortId] || {})[email];
    return row ? { ...row } : null;
  }

  async setMember(cohortId: string, email: string, data: Doc): Promise<void> {
    (this.members[cohortId] ||= {})[email] = { ...data };
  }

  async addAudit(): Promise<void> {}
}

function appFor(store: MemoryStore, email = COORDINATOR): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

async function seed(store: MemoryStore) {
  await store.set(COLLECTIONS.staffUsers, COORDINATOR, { EMAIL: COORDINATOR, DisplayName: 'Alex', isStaff: true, isCoordinator: true, isAdmin: true });
  await store.set(COLLECTIONS.staffUsers, SUPERVISOR, { EMAIL: SUPERVISOR, DisplayName: 'Priya', isStaff: true, isSupervisor: true });
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active' });
  await store.set(COLLECTIONS.cohorts, '2027', { Cohort: '2027', SheetName: 'COHORT: 2027', Status: 'Active' });
  await store.setMember('2026', JAMIE, { StudentId: JAMIE, 'Display Name': 'Jamie Wong' });
  await store.setMember('2027', OTHER, { StudentId: OTHER, 'Display Name': 'Other Student' });
  await store.set(COLLECTIONS.studentActionItems, 'task-2026', {
    TaskId: 'task-2026', cohortId: '2026', StudentId: JAMIE, CreatorType: 'Student', Title: 'Draft question', Status: 'Pending', LastUpdated: '2026-01-01T00:00:00.000Z',
  });
  await store.set(COLLECTIONS.studentActionItems, 'task-2027', {
    TaskId: 'task-2027', cohortId: '2027', StudentId: OTHER, CreatorType: 'System', Title: 'Other cohort', Status: 'Pending', LastUpdated: '2026-01-01T00:00:00.000Z',
  });
  await store.set(COLLECTIONS.studentActionItems, 'task-legacy', {
    TaskId: 'task-legacy', StudentId: JAMIE, CreatorType: 'System', Title: 'No cohort', Status: 'Pending', LastUpdated: '2026-01-01T00:00:00.000Z',
  });
}

test('student tasks list only the selected cohort', async () => {
  const store = new MemoryStore();
  await seed(store);
  const listed = await listStudentTasks(appFor(store), '2026');
  assert.deepEqual(listed.records.map((row) => row.TaskId), ['task-2026']);
  assert.equal(listed.records[0].cohortId, '2026');
});

test('saving a student task stamps the global cohort and rejects another cohort', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store);
  const created = await saveStudentTask(app, '2026', {
    StudentId: JAMIE,
    CreatorType: 'supervisor',
    Title: 'Meet your supervisor',
    Description: 'Bring a question.',
    DueDate: '2026-11-02',
    Status: 'pending',
    cohortId: '2027',
  }, '');
  const stored = await store.get(COLLECTIONS.studentActionItems, String(created.key));
  assert.equal(stored?.cohortId, '2026');
  assert.equal(stored?.CreatorType, 'Supervisor');
  assert.equal(stored?.Status, 'Pending');
  assert.equal(stored?.DueDate, '2026-11-02');
  assert.equal(stored?.CreatedBy, COORDINATOR);
  const listed = await listStudentTasks(app, '2026');
  assert.equal(listed.records.some((row) => row.TaskId === created.key), true);
  assert.equal((await listStudentTasks(app, '2027')).records.some((row) => row.TaskId === created.key), false);

  await assert.rejects(saveStudentTask(app, '2026', {
    StudentId: OTHER, CreatorType: 'Student', Title: 'Wrong roster', Status: 'Pending',
  }, ''), /not in the selected cohort/);
  await assert.rejects(saveStudentTask(app, '2027', {
    StudentId: OTHER, CreatorType: 'Student', Title: 'Moved', Status: 'Pending',
  }, 'task-2026'), /another cohort/);

  const updated = await saveStudentTask(app, '2026', {
    StudentId: JAMIE, CreatorType: 'Student', Title: 'Revised question', Status: 'In Progress', TaskId: 'ignored',
  }, created.key);
  assert.equal(updated.key, created.key);
  assert.equal((await store.get(COLLECTIONS.studentActionItems, String(created.key)))?.Title, 'Revised question');
  assert.equal((await store.get(COLLECTIONS.studentActionItems, String(created.key)))?.cohortId, '2026');
});

test('deleting a student task stays inside the selected cohort', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store);
  await assert.rejects(deleteStudentTask(app, '2026', 'task-2027'), /another cohort/);
  assert.ok(await store.get(COLLECTIONS.studentActionItems, 'task-2027'));
  const removed = await deleteStudentTask(app, '2026', 'task-2026');
  assert.equal(removed.deleted, true);
  assert.equal(await store.get(COLLECTIONS.studentActionItems, 'task-2026'), null);
  assert.equal((await listStudentTasks(app, '2026')).records.length, 0);
});

test('a supervisor cannot manage student tasks', async () => {
  const store = new MemoryStore();
  await seed(store);
  await assert.rejects(listStudentTasks(appFor(store, SUPERVISOR), '2026'), /Access denied/);
});
