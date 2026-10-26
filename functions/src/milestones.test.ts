import assert from 'node:assert/strict';
import test from 'node:test';
import { massUpdateMilestones, recordMilestoneDecision, setActionItemStatus, setStaffMilestoneStatus, updateMilestoneAssignment } from './actions';
import { getStaffHome, getStaffStudentHome } from './journey';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const coordinatorEmail = 'coordinator@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const studentEmail = 'student@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';

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

  async whereEqual(name: string, field: string, value: unknown): Promise<Doc[]> {
    return (await this.list(name)).filter((row) => row[field] === value);
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

function task(id: string, student: string, templateId: string, status: string, due: string) {
  return {
    TaskId: id,
    StudentId: student,
    CreatorType: 'System',
    TemplateId: templateId,
    PhaseId: templateId === 'm1' ? 'topic' : 'research',
    Title: templateId === 'm1' ? 'Subject preference' : 'Research question',
    Description: 'Original note',
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
  await store.set(COLLECTIONS.staffUsers, supervisorEmail, {
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set(COLLECTIONS.phases, 'topic', { phaseId: 'topic', phaseTitle: 'Topic', sequence: 1, active: true });
  await store.set(COLLECTIONS.phases, 'research', { phaseId: 'research', phaseTitle: 'Research', sequence: 2, active: true });
  await store.set(COLLECTIONS.milestoneTemplates, 'm1', {
    milestoneId: 'm1', milestoneTitle: 'Subject preference', phase: 'topic', type: 'form', mOwner: 'student', offsetDays: 80, position: 1,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'm2', {
    milestoneId: 'm2', milestoneTitle: 'Research question', phase: 'research', type: 'upload', mOwner: 'student', offsetDays: 40, position: 2,
  });
  store.members['2026'] = {
    [studentEmail]: {
      StudentId: studentEmail, 'Display Name': 'Jamie Wong', Surname: 'Wong', supervisorId: supervisorEmail,
    },
    [otherEmail]: {
      StudentId: otherEmail, 'Display Name': 'Alex Student', Surname: 'Student', supervisorId: supervisorEmail,
    },
  };
  await store.set(COLLECTIONS.studentActionItems, 'task-m1-a', task('task-m1-a', studentEmail, 'm1', 'Pending', '2026-10-01'));
  await store.set(COLLECTIONS.studentActionItems, 'task-m2-a', task('task-m2-a', studentEmail, 'm2', 'Pending', '2026-11-01'));
  await store.set(COLLECTIONS.studentActionItems, 'task-m1-b', task('task-m1-b', otherEmail, 'm1', 'Completed', '2026-10-15'));
  await store.set(COLLECTIONS.studentActionItems, 'todo-a', {
    ...task('todo-a', studentEmail, '', 'Pending', ''),
    CreatorType: 'Student',
    TemplateId: '',
    Title: 'Personal to-do',
  });
}

test('a coordinator can edit the fields of one milestone assignment', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, coordinatorEmail);
  const saved = await updateMilestoneAssignment(app, 'task-m1-a', studentEmail, '2026', 'coordinator', {
    title: 'Subject choice',
    description: 'Updated note',
    phaseId: 'research',
    status: 'In Progress',
    dueDate: '2026-12-01',
  });
  assert.equal(saved.title, 'Subject choice');
  assert.equal(saved.phaseId, 'research');
  assert.equal(saved.status, 'In Progress');
  assert.equal(saved.dueDate, '2026-12-01');
  const row = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  assert.equal(row && row.Description, 'Updated note');
  assert.equal(row && row.TemplateId, 'm1');
  assert.equal(row && row.UpdatedBy, coordinatorEmail);
  const untouched = await store.get(COLLECTIONS.studentActionItems, 'task-m2-a');
  assert.equal(untouched && untouched.DueDate, '2026-11-01');
});

test('supervisors, staff browse, and students cannot edit milestone assignments', async () => {
  const store = new MemoryStore();
  await seed(store);
  const payload = { title: 'Nope', description: '', phaseId: 'topic', status: 'Completed', dueDate: '2026-12-01' };
  await assert.rejects(updateMilestoneAssignment(appFor(store, supervisorEmail), 'task-m1-a', studentEmail, '2026', 'supervisor', payload), /Access denied/);
  await assert.rejects(updateMilestoneAssignment(appFor(store, coordinatorEmail), 'task-m1-a', studentEmail, '2026', 'staff', payload), /Access denied/);
  await assert.rejects(updateMilestoneAssignment(appFor(store, studentEmail), 'task-m1-a', studentEmail, '2026', '', payload), /Access denied/);
  await assert.rejects(updateMilestoneAssignment(appFor(store, coordinatorEmail), 'todo-a', studentEmail, '2026', 'coordinator', payload), /assigned milestone/);
  await assert.rejects(updateMilestoneAssignment(appFor(store, coordinatorEmail), 'task-m1-a', studentEmail, '2026', 'coordinator', {
    ...payload, dueDate: 'tomorrow',
  }), /valid date/);
  const row = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  assert.equal(row && row.Title, 'Subject preference');
});

test('mass edit updates only the chosen status, date, or both for a shared milestone', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, coordinatorEmail);
  await assert.rejects(massUpdateMilestones(app, '2026', [studentEmail, otherEmail], 'not-a-milestone', {
    updateStatus: true, status: 'In Progress', updateDate: false, dueDate: '',
  }, 'coordinator'), /not assigned to every selected student/);
  const before = await store.get(COLLECTIONS.studentActionItems, 'task-m2-a');
  assert.equal(before && before.Status, 'Pending');

  const statusOnly = await massUpdateMilestones(app, '2026', [studentEmail, otherEmail], 'm1', {
    updateStatus: true, status: 'In Progress', updateDate: false, dueDate: '',
  }, 'coordinator');
  assert.equal(statusOnly.updated, 2);
  const first = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  const second = await store.get(COLLECTIONS.studentActionItems, 'task-m1-b');
  assert.equal(first && first.Status, 'In Progress');
  assert.equal(first && first.DueDate, '2026-10-01');
  assert.equal(second && second.Status, 'In Progress');
  assert.equal(second && second.DueDate, '2026-10-15');

  await massUpdateMilestones(app, '2026', [studentEmail, otherEmail], 'm1', {
    updateStatus: false, status: 'Completed', updateDate: true, dueDate: '2027-01-20',
  }, 'coordinator');
  const dated = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  assert.equal(dated && dated.Status, 'In Progress');
  assert.equal(dated && dated.DueDate, '2027-01-20');

  await massUpdateMilestones(app, '2026', [studentEmail], 'm1', {
    updateStatus: true, status: 'Completed', updateDate: true, dueDate: '2027-02-02',
  }, 'coordinator');
  const both = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  assert.equal(both && both.Status, 'Completed');
  assert.equal(both && both.DueDate, '2027-02-02');
  const other = await store.get(COLLECTIONS.studentActionItems, 'task-m1-b');
  assert.equal(other && other.Status, 'In Progress');
});

test('mass edit rejects an empty change, a bad status, and a supervisor', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, coordinatorEmail);
  await assert.rejects(massUpdateMilestones(app, '2026', [studentEmail], 'm1', {
    updateStatus: false, updateDate: false,
  }, 'coordinator'), /status, the due date, or both/);
  await assert.rejects(massUpdateMilestones(app, '2026', [studentEmail], 'm1', {
    updateStatus: true, status: 'Done', updateDate: false,
  }, 'coordinator'), /valid task status/);
  await assert.rejects(massUpdateMilestones(appFor(store, supervisorEmail), '2026', [studentEmail], 'm1', {
    updateStatus: true, status: 'Completed', updateDate: false,
  }, 'supervisor'), /Access denied/);
  await assert.rejects(massUpdateMilestones(app, '2026', [studentEmail], 'm1', {
    updateStatus: true, status: 'Completed', updateDate: false,
  }, 'staff'), /Access denied/);
});

test('the cohort listing reports shared milestone assignments and who may edit them', async () => {
  const store = new MemoryStore();
  await seed(store);
  const home = await getStaffHome(appFor(store, coordinatorEmail), '2026', 'coordinator');
  assert.equal(home.canEditMilestones, true);
  const byEmail: Record<string, { templateId: string }[]> = {};
  home.students.forEach((student) => { byEmail[student.email] = student.assigned; });
  assert.deepEqual(byEmail[studentEmail].map((item) => item.templateId).sort(), ['m1', 'm2']);
  assert.deepEqual(byEmail[otherEmail].map((item) => item.templateId), ['m1']);
  const supervisorHome = await getStaffHome(appFor(store, supervisorEmail), '2026', 'supervisor');
  assert.equal(supervisorHome.canEditMilestones, false);
});

test('a coordinator who is not an admin can still edit cohort milestones', async () => {
  const store = new MemoryStore();
  await seed(store);
  const only = 'only-coord@vsa.example.edu';
  await store.set(COLLECTIONS.staffUsers, only, {
    EMAIL: only, DisplayName: 'Only Coord', isStaff: true, isCoordinator: true, isAdmin: false,
  });
  const home = await getStaffHome(appFor(store, only), '2026', 'coordinator');
  assert.equal(home.canEditMilestones, true);
  const checked = await setStaffMilestoneStatus(appFor(store, only), otherEmail, '2026', 'm2', 'Completed', 'coordinator');
  assert.equal(checked.status, 'Completed');
  const created = (await store.list(COLLECTIONS.studentActionItems)).find((item) => item.StudentId === otherEmail && item.TemplateId === 'm2');
  assert.equal(created && created.Status, 'Completed');
  assert.equal(created && created.CreatorType, 'System');
});

test('mass edit creates a missing cohort milestone and updates the students who already have it', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, coordinatorEmail);
  const result = await massUpdateMilestones(app, '2026', [studentEmail, otherEmail], 'm2', {
    updateStatus: true, status: 'In Progress', updateDate: true, dueDate: '2027-03-01',
  }, 'coordinator');
  assert.equal(result.students, 2);
  assert.equal(result.updated, 2);
  const existing = await store.get(COLLECTIONS.studentActionItems, 'task-m2-a');
  assert.equal(existing && existing.Status, 'In Progress');
  assert.equal(String(existing && existing.DueDate).slice(0, 10), '2027-03-01');
  const created = (await store.list(COLLECTIONS.studentActionItems)).find((item) => item.StudentId === otherEmail && item.TemplateId === 'm2');
  assert.equal(created && created.Status, 'In Progress');
  assert.equal(String(created && created.DueDate).slice(0, 10), '2027-03-01');
});

test('a coordinator can edit or approve a milestone before a task exists', async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.set(COLLECTIONS.milestoneTemplates, 'm3', {
    milestoneId: 'm3', milestoneTitle: 'Supervisor approval', phase: 'research', type: 'approval', mOwner: 'supervisor', offsetDays: 10, position: 3,
  });
  const app = appFor(store, coordinatorEmail);
  const saved = await updateMilestoneAssignment(app, '', otherEmail, '2026', 'coordinator', {
    title: 'Question draft',
    description: 'Added from the journey',
    phaseId: 'research',
    status: 'In Progress',
    dueDate: '2027-04-01',
    milestoneId: 'm2',
  });
  assert.equal(saved.status, 'In Progress');
  assert.equal(saved.title, 'Question draft');
  const row = await store.get(COLLECTIONS.studentActionItems, saved.taskId);
  assert.equal(row && row.StudentId, otherEmail);
  assert.equal(row && row.TemplateId, 'm2');
  const approved = await recordMilestoneDecision(app, '', 'approve', '', studentEmail, '2026', 'coordinator', 'm3');
  assert.equal(approved.status, 'Completed');
  const approval = await store.get(COLLECTIONS.studentActionItems, approved.taskId);
  assert.equal(approval && approval.TemplateId, 'm3');
  assert.equal(approval && approval.Status, 'Completed');
});

test('a task stored under Student Email can still be checked off by a coordinator', async () => {
  const store = new MemoryStore();
  await seed(store);
  const mail = 'jamie.mail@vsa.example.edu';
  store.members['2026'][studentEmail]['Student Email'] = mail;
  const stored = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  if (!stored) throw new Error('missing task');
  stored.StudentId = mail;
  stored.CreatorType = 'system';
  await store.set(COLLECTIONS.studentActionItems, 'task-m1-a', stored);
  const app = appFor(store, coordinatorEmail);
  const home = await getStaffHome(app, '2026', 'coordinator');
  const student = home.students.find((entry) => entry.email === studentEmail);
  assert.ok(student && student.assigned.some((item) => item.templateId === 'm1'));
  const detail = await getStaffStudentHome(app, studentEmail, '2026', 'coordinator');
  const item = detail.actionItems.find((entry) => entry.TaskId === 'task-m1-a');
  assert.equal(item && item.canUpdate, true);
  assert.equal(item && item.CreatorType, 'System');
  assert.equal(detail.canUpdateMilestones, true);
  await setActionItemStatus(app, 'task-m1-a', 'Completed', studentEmail, '2026', 'coordinator');
  const updated = await store.get(COLLECTIONS.studentActionItems, 'task-m1-a');
  assert.equal(updated && updated.Status, 'Completed');
  assert.equal(updated && updated.StudentId, mail);
});
