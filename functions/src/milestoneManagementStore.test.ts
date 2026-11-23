import assert from 'node:assert/strict';
import test from 'node:test';
import { Firestore } from 'firebase-admin/firestore';
import { milestoneAssignmentScope } from './milestoneManagement';
import { COLLECTIONS } from './schema';
import { Store } from './store';
import { Doc } from './util';

class Reference {
  constructor(public path: string, public isDocument: boolean, public field = '', public value = '') {}
  doc(id = `archive-${Reference.next++}`) { return new Reference(`${this.path}/${id}`, true); }
  static next = 0;
  collection(name: string) { return new Reference(`${this.path}/${name}`, false); }
  where(field: string, _operator: string, value: string) { return new Reference(this.path, false, field, value); }
}

class FakeFirestore {
  records = new Map<string, Doc>();
  collection(name: string) { return new Reference(name, false); }
  async runTransaction<T>(work: (transaction: {
    get: (ref: Reference) => Promise<{ exists?: boolean; data: () => Doc | undefined; docs: { id: string; ref: Reference; data: () => Doc }[] }>;
    update: (ref: Reference, data: Doc) => void;
    create: (ref: Reference, data: Doc) => void;
    delete: (ref: Reference) => void;
  }) => Promise<T>): Promise<T> {
    const writes: (() => void)[] = [];
    const result = await work({
      get: async (ref) => {
        if (ref.isDocument) return { exists: this.records.has(ref.path), data: () => this.records.get(ref.path), docs: [] };
        const prefix = `${ref.path}/`;
        const docs = [...this.records.entries()].filter(([path, value]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && (!ref.field || value[ref.field] === ref.value))
          .map(([path, value]) => ({ id: path.slice(prefix.length), ref: new Reference(path, true), data: () => ({ ...value }) }));
        return { docs, data: () => undefined };
      },
      update: (ref, data) => writes.push(() => this.records.set(ref.path, { ...this.records.get(ref.path), ...data })),
      create: (ref, data) => writes.push(() => this.records.set(ref.path, data)),
      delete: (ref) => writes.push(() => this.records.delete(ref.path)),
    });
    writes.forEach((write) => write());
    return result;
  }
}

test('real store transactions reject stale and invalid previews without partial writes', async () => {
  const db = new FakeFirestore();
  const store = new Store(db as unknown as Firestore);
  const milestonePath = `${COLLECTIONS.cohorts}/2027/milestones/m1`;
  const member = { StudentId: 'login@example.edu', 'Student Email': 'student@example.edu' };
  const task = { CreatorType: 'System', TemplateId: 'm1', StudentId: 'login@example.edu', cohortId: '2027', Status: 'Completed', DueDate: '2027-01-01' };
  db.records.set(milestonePath, { milestoneId: 'm1' });
  db.records.set(`${COLLECTIONS.cohorts}/2027/members/login@example.edu`, member);
  db.records.set(`${COLLECTIONS.studentActionItems}/a`, { ...task, TaskId: 'a' });
  db.records.set(`${COLLECTIONS.studentActionItems}/wrong-document`, { ...task, TaskId: 'z' });
  const signature = () => milestoneAssignmentScope(
    [...db.records.entries()].filter(([path]) => path.startsWith(`${COLLECTIONS.studentActionItems}/`)).map(([, row]) => row),
    [member], '2027', 'm1',
  ).signature;
  await assert.rejects(store.manageCohortMilestoneAssignments('2027', 'm1', signature(), 'reset', 'admin', 'now'), /document ID/);
  assert.equal(db.records.get(`${COLLECTIONS.studentActionItems}/a`)?.Status, 'Completed');
  db.records.delete(`${COLLECTIONS.studentActionItems}/wrong-document`);
  const stale = signature();
  db.records.set(`${COLLECTIONS.studentActionItems}/b`, { ...task, TaskId: 'b' });
  await assert.rejects(store.manageCohortMilestoneAssignments('2027', 'm1', stale, 'delete', 'admin', 'now'), /changed since the preview/);
  await assert.rejects(store.deleteUnassignedCohortMilestone('2027', 'm1'), /assigned action items/);
  assert.equal(await store.manageCohortMilestoneAssignments('2027', 'm1', signature(), 'reset', 'admin', 'now'), 2);
  assert.equal(db.records.get(`${COLLECTIONS.studentActionItems}/a`)?.DueDate, '2027-01-01');
  assert.equal(db.records.get(`${COLLECTIONS.studentActionItems}/a`)?.Status, 'Pending');
  assert.equal(await store.manageCohortMilestoneAssignments('2027', 'm1', signature(), 'delete', 'admin', 'now'), 2);
  await store.deleteUnassignedCohortMilestone('2027', 'm1');
  assert.equal(db.records.has(milestonePath), false);
});

test('real store transaction handles more than 450 assignments and leaves other cohorts alone', async () => {
  const db = new FakeFirestore();
  const store = new Store(db as unknown as Firestore);
  const member = { StudentId: 'student@example.edu' };
  db.records.set(`${COLLECTIONS.cohorts}/2027/milestones/m1`, { milestoneId: 'm1' });
  db.records.set(`${COLLECTIONS.cohorts}/2027/members/student@example.edu`, member);
  const tasks = Array.from({ length: 451 }, (_, index) => ({
    TaskId: `task-${index}`, StudentId: member.StudentId, TemplateId: 'm1', CreatorType: 'System', cohortId: '2027', Status: 'Completed', DueDate: '2027-01-01',
  }));
  const other = { ...tasks[0], TaskId: 'other', cohortId: '2026' };
  [...tasks, other].forEach((task) => db.records.set(`${COLLECTIONS.studentActionItems}/${task.TaskId}`, task));
  const preview = milestoneAssignmentScope([...tasks, other], [member], '2027', 'm1');
  assert.equal(await store.manageCohortMilestoneAssignments('2027', 'm1', preview.signature, 'reset', 'admin', 'now'), 451);
  assert.equal(db.records.get(`${COLLECTIONS.studentActionItems}/task-450`)?.Status, 'Pending');
  assert.equal(db.records.get(`${COLLECTIONS.studentActionItems}/other`)?.Status, 'Completed');
});

test('selected assignments are archived and restored with their deleted milestone without overwriting progress', async () => {
  const db = new FakeFirestore();
  const store = new Store(db as unknown as Firestore);
  const member = { StudentId: 'student@example.edu', 'Student Email': 'alias@example.edu' };
  const milestone = { milestoneId: 'm1', phase: 'topic', milestoneTitle: 'Draft' };
  const task = { TaskId: 'a', StudentId: member.StudentId, TemplateId: 'm1', CreatorType: 'System', cohortId: '2027', Status: 'Completed' };
  const taskPath = `${COLLECTIONS.studentActionItems}/a`;
  const milestonePath = `${COLLECTIONS.cohorts}/2027/milestones/m1`;
  db.records.set(milestonePath, milestone);
  db.records.set(`${COLLECTIONS.cohorts}/2027/phases/topic`, { phaseId: 'topic', active: true });
  db.records.set(`${COLLECTIONS.cohorts}/2027/members/student@example.edu`, member);
  db.records.set(taskPath, task);
  db.records.set(`${COLLECTIONS.studentActionItems}/b`, { ...task, TaskId: 'b', StudentId: 'other@example.edu' });
  const scope = () => milestoneAssignmentScope([...db.records.entries()].filter(([path]) => path.startsWith(`${COLLECTIONS.studentActionItems}/`)).map(([, row]) => row), [member], '2027', 'm1');
  await assert.rejects(store.manageCohortMilestoneAssignments('2027', 'm1', scope().signature, 'archive', 'admin', 'now', ['missing']), /selected assignments changed/);
  assert.equal(await store.manageCohortMilestoneAssignments('2027', 'm1', scope().signature, 'archive', 'admin', 'now', ['a']), 1);
  assert.equal(db.records.has(taskPath), false);
  assert.equal(db.records.has(`${COLLECTIONS.studentActionItems}/b`), true);
  const archivePath = [...db.records.keys()].find((path) => path.includes('/milestoneAssignmentArchive/'))!;
  const archiveId = archivePath.split('/').pop()!;
  await store.manageCohortMilestoneAssignments('2027', 'm1', scope().signature, 'delete', 'admin', 'now');
  await store.deleteUnassignedCohortMilestone('2027', 'm1');
  db.records.set(`${COLLECTIONS.studentActionItems}/duplicate`, { ...task, TaskId: 'duplicate', StudentId: 'alias@example.edu' });
  await assert.rejects(store.restoreCohortMilestoneAssignment('2027', archiveId), /already has an assignment/);
  assert.equal(db.records.has(archivePath), true);
  db.records.delete(`${COLLECTIONS.studentActionItems}/duplicate`);
  db.records.set(milestonePath, { ...milestone, milestoneTitle: 'Different' });
  await assert.rejects(store.restoreCohortMilestoneAssignment('2027', archiveId), /milestone has changed/);
  db.records.delete(milestonePath);
  await store.restoreCohortMilestoneAssignment('2027', archiveId);
  assert.deepEqual(db.records.get(taskPath), task);
  assert.deepEqual(db.records.get(milestonePath), milestone);
  assert.equal(db.records.has(archivePath), false);
});

test('restoring an archived anchor refuses to create a second anchor', async () => {
  const db = new FakeFirestore();
  const store = new Store(db as unknown as Firestore);
  const task = { TaskId: 'a', StudentId: 's@example.edu', TemplateId: 'm1', CreatorType: 'System', cohortId: '2027' };
  const milestone = { milestoneId: 'm1', phase: 'topic', isAnchor: true };
  db.records.set(`${COLLECTIONS.cohorts}/2027/milestoneAssignmentArchive/a`, { task, milestone });
  db.records.set(`${COLLECTIONS.cohorts}/2027/phases/topic`, { active: true });
  db.records.set(`${COLLECTIONS.cohorts}/2027/milestones/m2`, { milestoneId: 'm2', isAnchor: true });
  await assert.rejects(store.restoreCohortMilestoneAssignment('2027', 'a'), /Another milestone is now the anchor/);
  assert.equal(db.records.has(`${COLLECTIONS.cohorts}/2027/milestoneAssignmentArchive/a`), true);
});

test('ambiguous legacy assignments are excluded and block milestone deletion', async () => {
  const db = new FakeFirestore();
  const store = new Store(db as unknown as Firestore);
  const member = { StudentId: 'student@example.edu' };
  const task = { TaskId: 'legacy', StudentId: member.StudentId, TemplateId: 'm1', CreatorType: 'System', Status: 'Completed' };
  db.records.set(`${COLLECTIONS.cohorts}/2027/milestones/m1`, { milestoneId: 'm1' });
  db.records.set(`${COLLECTIONS.cohorts}/2027/members/student@example.edu`, member);
  db.records.set(`${COLLECTIONS.studentActionItems}/legacy`, task);
  const preview = milestoneAssignmentScope([task], [member], '2027', 'm1');
  assert.equal(preview.assignments.length, 0);
  assert.equal(preview.excluded[0].reason, 'legacy');
  await assert.rejects(store.deleteUnassignedCohortMilestone('2027', 'm1'), /ambiguous legacy/);
  assert.deepEqual(db.records.get(`${COLLECTIONS.studentActionItems}/legacy`), task);
});
