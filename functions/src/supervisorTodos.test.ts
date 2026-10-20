import assert from 'node:assert/strict';
import test from 'node:test';
import { getStaffHome } from './journey';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Store } from './store';
import {
  addSupervisorTodo,
  deleteSupervisorTodo,
  getSupervisorTodoDesk,
  setSupervisorTodoStatus,
  supervisorOwnedMilestones,
} from './supervisorTodos';
import { Doc } from './util';

const coordinatorEmail = 'coordinator@vsa.example.edu';
const leadEmail = 'lead@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';
const studentEmail = 'student@vsa.example.edu';
const secondEmail = 'second@vsa.example.edu';
const staffEmail = 'staff@vsa.example.edu';

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
    if (!this.docs[name]) this.docs[name] = {};
    this.docs[name][id] = { ...data };
  }

  async remove(name: string, id: string): Promise<void> {
    if (this.docs[name]) delete this.docs[name][id];
  }

  async listMembers(cohortId: string): Promise<Doc[]> {
    return Object.values(this.members[cohortId] || {}).map((row) => ({ ...row }));
  }

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const row = (this.members[cohortId] || {})[email];
    return row ? { ...row } : null;
  }

  async addAudit(): Promise<void> {}
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

function task(id: string, student: string, templateId: string, status: string, due: string, title: string) {
  return {
    TaskId: id,
    StudentId: student,
    CreatorType: 'System',
    TemplateId: templateId,
    PhaseId: 'research',
    Title: title,
    Description: '',
    DueDate: due,
    Status: status,
    LastUpdated: '2026-10-01T00:00:00.000Z',
    CreatedBy: coordinatorEmail,
    UpdatedBy: coordinatorEmail,
  };
}

async function seed(store: MemoryStore) {
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', Status: 'Active' });
  await store.set(COLLECTIONS.staffUsers, coordinatorEmail, {
    EMAIL: coordinatorEmail, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set(COLLECTIONS.staffUsers, leadEmail, {
    EMAIL: leadEmail, DisplayName: 'Jordan Lee', isStaff: true, isLead: true,
  });
  await store.set(COLLECTIONS.staffUsers, supervisorEmail, {
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set(COLLECTIONS.staffUsers, otherEmail, {
    EMAIL: otherEmail, DisplayName: 'Sam Rivera', isStaff: true, isSupervisor: true,
  });
  await store.set(COLLECTIONS.staffUsers, staffEmail, {
    EMAIL: staffEmail, DisplayName: 'Browse Only', isStaff: true,
  });
  await store.set(COLLECTIONS.phases, 'topic', { phaseId: 'topic', phaseTitle: 'Topic', sequence: 1, active: true });
  await store.set(COLLECTIONS.phases, 'research', { phaseId: 'research', phaseTitle: 'Research', sequence: 2, active: true });
  await store.set(COLLECTIONS.milestoneTemplates, 'm1', {
    milestoneId: 'm1', milestoneTitle: 'Subject preference', phase: 'topic', type: 'form', mOwner: 'student', offsetDays: 80, position: 1,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'm3', {
    milestoneId: 'm3', milestoneTitle: 'Supervisor approval', phase: 'research', type: 'approval', mOwner: 'supervisor', offsetDays: 40, position: 2,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'm4', {
    milestoneId: 'm4', milestoneTitle: 'Final meeting', phase: 'research', type: 'meeting', mOwner: 'supervisor', offsetDays: 10, position: 3,
  });
  store.members['2026'] = {
    [studentEmail]: {
      StudentId: studentEmail, 'Display Name': 'Jamie Wong', Surname: 'Wong', supervisorId: supervisorEmail,
    },
    [secondEmail]: {
      StudentId: secondEmail, 'Display Name': 'Alex Student', Surname: 'Student', supervisorId: otherEmail,
    },
  };
  await store.set(COLLECTIONS.studentActionItems, 'm1-jamie', task('m1-jamie', studentEmail, 'm1', 'Pending', '2026-10-01', 'Subject preference'));
  await store.set(COLLECTIONS.studentActionItems, 'm3-jamie', task('m3-jamie', studentEmail, 'm3', 'Pending', '2026-12-01', 'Supervisor approval'));
  await store.set(COLLECTIONS.studentActionItems, 'm4-jamie', task('m4-jamie', studentEmail, 'm4', 'Pending', '2026-11-01', 'Final meeting'));
  await store.set(COLLECTIONS.studentActionItems, 'm1-alex', task('m1-alex', secondEmail, 'm1', 'Completed', '2026-10-01', 'Subject preference'));
  await store.set(COLLECTIONS.studentActionItems, 'm3-alex', task('m3-alex', secondEmail, 'm3', 'Completed', '2026-11-01', 'Supervisor approval'));
  await store.set(COLLECTIONS.studentActionItems, 'm4-alex', task('m4-alex', secondEmail, 'm4', 'Pending', '2026-12-15', 'Final meeting'));
}

test('supervisor to-dos include every open milestone they own, and the next one is marked', () => {
  const rows = supervisorOwnedMilestones([
    { email: studentEmail, displayName: 'Jamie Wong', surname: 'Wong', supervisorId: supervisorEmail },
    { email: 'done@vsa.example.edu', displayName: 'Done Student', surname: 'Done', supervisorId: supervisorEmail },
  ], [
    { milestoneId: 'm1', title: 'Subject preference', mOwner: 'student' },
    { milestoneId: 'm3', title: 'Supervisor approval', mOwner: 'supervisor' },
    { milestoneId: 'm4', title: 'Final meeting', mOwner: 'supervisor' },
  ], {
    [studentEmail]: [
      { templateId: 'm1', taskId: 'a', title: 'Subject preference', status: 'Pending', due: '2026-10-01' },
      { templateId: 'm3', taskId: 'b', title: 'Supervisor approval', status: 'Pending', due: '2026-12-01' },
      { templateId: 'm4', taskId: 'c', title: 'Final meeting', status: 'Pending', due: '2026-11-01' },
    ],
    'done@vsa.example.edu': [
      { templateId: 'm3', taskId: 'd', title: 'Supervisor approval', status: 'Completed', due: '2026-10-01' },
      { templateId: 'm4', taskId: 'e', title: 'Final meeting', status: 'Completed', due: '2026-10-02' },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.studentEmail, row.milestoneId, row.next, row.due]), [
    [studentEmail, 'm4', false, '2026-11-01'],
    [studentEmail, 'm3', true, '2026-12-01'],
  ]);
});

test('an unassigned supervisor milestone still counts as the next one', () => {
  const rows = supervisorOwnedMilestones([
    { email: studentEmail, displayName: 'Jamie Wong', surname: 'Wong', supervisorId: supervisorEmail },
  ], [
    { milestoneId: 'm3', title: 'Supervisor approval', mOwner: 'supervisor' },
  ], {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].next, true);
  assert.equal(rows[0].title, 'Supervisor approval');
  assert.equal(rows[0].taskId, '');
});

test('the supervisor My Students home lists owned milestones and added to-dos', async () => {
  const store = new MemoryStore();
  await seed(store);
  const added = await addSupervisorTodo(appFor(store, leadEmail), '2026', supervisorEmail, {
    title: 'Check the research questions',
    note: 'Before Friday',
    due: '2026-10-24',
  });
  assert.equal(added.supervisorId, supervisorEmail);
  assert.equal(added.status, 'Pending');
  await addSupervisorTodo(appFor(store, coordinatorEmail), '2026', otherEmail, { title: 'Other supervisor task' });

  const home = await getStaffHome(appFor(store, supervisorEmail), '2026', 'supervisor');
  assert.equal(home.viewAs, 'supervisor');
  assert.deepEqual(home.supervisorMilestoneTodos.map((item) => [item.studentEmail, item.milestoneId, item.next]), [
    [studentEmail, 'm4', false],
    [studentEmail, 'm3', true],
  ]);
  assert.deepEqual(home.supervisorTodos.map((item) => item.title), ['Check the research questions']);
  assert.equal(home.students.every((student) => student.supervisorId === supervisorEmail), true);
});

test('leads and coordinators see and add supervisor to-dos by supervisor', async () => {
  const store = new MemoryStore();
  await seed(store);
  await assert.rejects(getSupervisorTodoDesk(appFor(store, supervisorEmail), '2026'), /Access denied/);
  await assert.rejects(getSupervisorTodoDesk(appFor(store, staffEmail), '2026'), /Access denied/);
  await assert.rejects(addSupervisorTodo(appFor(store, supervisorEmail), '2026', supervisorEmail, { title: 'Mine' }), /Access denied/);
  await assert.rejects(addSupervisorTodo(appFor(store, leadEmail), '2026', supervisorEmail, { title: '' }), /title is required/);
  await assert.rejects(addSupervisorTodo(appFor(store, leadEmail), '2026', supervisorEmail, { title: 'When', due: 'tomorrow' }), /valid date/);
  await assert.rejects(addSupervisorTodo(appFor(store, leadEmail), '2026', 'missing@vsa.example.edu', { title: 'Nope' }), /supervisor in this cohort/);

  const desk = await getSupervisorTodoDesk(appFor(store, leadEmail), '2026');
  assert.equal(desk.canAdd, true);
  assert.deepEqual(desk.supervisors.map((supervisor) => supervisor.name), ['Priya Shah', 'Sam Rivera']);
  const priya = desk.supervisors[0];
  assert.equal(priya.milestones.some((item) => item.next && item.milestoneId === 'm3'), true);
  assert.equal(priya.milestones.some((item) => item.milestoneId === 'm4' && !item.next), true);
  const sam = desk.supervisors[1];
  assert.deepEqual(sam.milestones.map((item) => [item.milestoneId, item.next]), [['m4', true]]);

  const created = await addSupervisorTodo(appFor(store, coordinatorEmail), '2026', otherEmail, { title: 'Read the outline' });
  const again = await getSupervisorTodoDesk(appFor(store, coordinatorEmail), '2026');
  const updated = again.supervisors.find((supervisor) => supervisor.supervisorId === otherEmail);
  assert.equal(updated && updated.added[0].title, 'Read the outline');

  await assert.rejects(setSupervisorTodoStatus(appFor(store, supervisorEmail), created.todoId, 'Completed'), /Access denied/);
  await assert.rejects(deleteSupervisorTodo(appFor(store, otherEmail), created.todoId), /Access denied/);
  const done = await setSupervisorTodoStatus(appFor(store, otherEmail), created.todoId, 'Completed');
  assert.equal(done.status, 'Completed');
  const afterDone = await getStaffHome(appFor(store, otherEmail), '2026', 'supervisor');
  assert.equal(afterDone.supervisorTodos.length, 0);

  const reopened = await setSupervisorTodoStatus(appFor(store, leadEmail), created.todoId, 'Pending');
  assert.equal(reopened.status, 'Pending');
  await deleteSupervisorTodo(appFor(store, leadEmail), created.todoId);
  const cleared = await getSupervisorTodoDesk(appFor(store, leadEmail), '2026');
  const samAfter = cleared.supervisors.find((supervisor) => supervisor.supervisorId === otherEmail);
  assert.equal(samAfter && samAfter.added.length, 0);
});
