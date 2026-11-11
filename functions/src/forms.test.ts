import assert from 'node:assert/strict';
import test from 'node:test';
import { getFormResponse } from './forms';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const studentEmail = 'student@vsa.example.edu';
const unassignedEmail = 'unassigned@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const coordinatorEmail = 'coordinator@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';
const leadEmail = 'lead@vsa.example.edu';
const staffEmail = 'staff@vsa.example.edu';
const milestoneId = 'm1';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};
  audits: Doc[] = [];

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

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const row = (this.members[cohortId] || {})[email];
    return row ? { ...row } : null;
  }

  async addAudit(entry: Doc): Promise<void> {
    this.audits.push({ ...entry });
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

function responseId(email: string) {
  return `${milestoneId}__${encodeURIComponent(email)}`;
}

async function seed(store: MemoryStore) {
  await store.set('cohorts', '2026', { Cohort: '2026', Status: 'Active' });
  store.members['2026'] = {
    [studentEmail]: {
      StudentId: studentEmail,
      'Display Name': 'Jamie Wong',
      supervisorId: 'Supervisor@VSA.example.edu',
    },
    [unassignedEmail]: {
      StudentId: unassignedEmail,
      'Display Name': 'No Supervisor',
      supervisorId: '',
    },
  };
  await store.set('staffUsers', supervisorEmail, {
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set('staffUsers', coordinatorEmail, {
    EMAIL: coordinatorEmail, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true,
  });
  await store.set('staffUsers', otherEmail, {
    EMAIL: otherEmail, DisplayName: 'Other Supervisor', isStaff: true, isSupervisor: true,
  });
  await store.set('staffUsers', leadEmail, {
    EMAIL: leadEmail, DisplayName: 'Lead Teacher', isStaff: true, isLead: true,
  });
  await store.set('staffUsers', staffEmail, {
    EMAIL: staffEmail, DisplayName: 'Active Staff', isStaff: true,
  });
  await store.set('studentUsers', studentEmail, { StudentId: studentEmail, DisplayName: 'Jamie Wong' });
  await store.set('studentUsers', unassignedEmail, { StudentId: unassignedEmail, DisplayName: 'No Supervisor' });
  await store.set('milestoneTemplates', milestoneId, {
    milestoneId, type: 'form', milestoneTitle: 'Subject preference', phase: 'topic', mOwner: 'student',
  });
  await store.set('formDefinitions', milestoneId, {
    milestoneId,
    status: 'Published',
    version: 1,
    fieldsJson: JSON.stringify([{ name: 'question', label: 'Question', type: 'textarea', required: true }]),
    html: '<p>Question</p>',
    js: '',
    submitCompletes: true,
    LastUpdated: '2026-10-01T00:00:00.000Z',
    UpdatedBy: coordinatorEmail,
  });
  await store.set('formResponses', responseId(studentEmail), {
    MilestoneId: milestoneId,
    StudentId: studentEmail,
    FormVersion: 1,
    Status: 'Submitted',
    question: 'Why do cities flood?',
    LastUpdated: '2026-10-02T00:00:00.000Z',
  });
  await store.set('formResponses', responseId(unassignedEmail), {
    MilestoneId: milestoneId,
    StudentId: unassignedEmail,
    FormVersion: 1,
    Status: 'Submitted',
    question: 'Unassigned answer',
    LastUpdated: '2026-10-02T00:00:00.000Z',
  });
}

function deniedOperations(store: MemoryStore) {
  return store.audits.filter((row) => row.Action === 'ACCESS_DENIED').map((row) => String(row.Payload));
}

test('the assigned supervisor and a coordinator can read a published form response', async () => {
  const store = new MemoryStore();
  await seed(store);
  const supervisor = appFor(store, supervisorEmail);
  const coordinator = appFor(store, coordinatorEmail);

  const assigned = await getFormResponse(supervisor, milestoneId, studentEmail);
  assert.equal(assigned.title, 'Subject preference');
  assert.equal(assigned.response?.values.question, 'Why do cities flood?');
  assert.equal(assigned.response?.status, 'Submitted');

  const byCoordinator = await getFormResponse(coordinator, milestoneId, `  ${studentEmail.toUpperCase()}  `);
  assert.equal(byCoordinator.response?.values.question, 'Why do cities flood?');

  const unassigned = await getFormResponse(coordinator, milestoneId, unassignedEmail);
  assert.equal(unassigned.response?.values.question, 'Unassigned answer');
});

test('staff who are not the assigned supervisor cannot read a form response', async () => {
  const store = new MemoryStore();
  await seed(store);
  const callers = [otherEmail, leadEmail, staffEmail, studentEmail];
  for (const email of callers) {
    await assert.rejects(getFormResponse(appFor(store, email), milestoneId, studentEmail), /Access denied/);
  }
  const payloads = deniedOperations(store);
  assert.equal(payloads.length, callers.length);
  assert.ok(payloads.every((payload) => payload.includes('VIEW_FORM_RESPONSE')));
  assert.equal(store.audits.some((row) => String(row.Payload).includes('Why do cities flood?')), false);
});

test('a student without an assigned supervisor is not readable by other staff', async () => {
  const store = new MemoryStore();
  await seed(store);
  const callers = [supervisorEmail, otherEmail, leadEmail, staffEmail];
  for (const email of callers) {
    await assert.rejects(getFormResponse(appFor(store, email), milestoneId, unassignedEmail), /Access denied/);
  }
  const payloads = deniedOperations(store);
  assert.equal(payloads.length, callers.length);
  assert.ok(payloads.every((payload) => payload.includes('assigned supervisor')));
  assert.equal(store.audits.some((row) => String(row.Payload).includes('Unassigned answer')), false);

  store.members['2026'][unassignedEmail].supervisorId = '   ';
  await assert.rejects(getFormResponse(appFor(store, staffEmail), milestoneId, unassignedEmail), /Access denied/);
  const stillOpen = await getFormResponse(appFor(store, coordinatorEmail), milestoneId, unassignedEmail);
  assert.equal(stillOpen.response?.values.question, 'Unassigned answer');
});
