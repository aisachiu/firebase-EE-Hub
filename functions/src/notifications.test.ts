import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRawMessage, gmailConfigured, sanitizeHeader } from './gmail';
import {
  deleteNotificationRule,
  listNotificationDesk,
  saveNotificationOverlay,
  saveNotificationRule,
} from './notifications';
import {
  audienceLabel,
  buildMessage,
  notificationPowers,
  planSweep,
  sendIsBlocked,
  sendKey,
  SweepRule,
  timingLabel,
  triggerDay,
} from './notificationsPure';
import { HubUser } from './permissions';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const student: HubUser = { email: 'student@vsa.example.edu', displayName: 'Jamie', role: 'student' };
const supervisor: HubUser = {
  email: 'supervisor@vsa.example.edu', displayName: 'Priya', role: 'staff',
  permissions: { isStaff: true, isSupervisor: true, isLead: false, isCoordinator: false, isAdmin: false, canAdmin: false },
};
const coordinator: HubUser = {
  email: 'coordinator@vsa.example.edu', displayName: 'Alex', role: 'staff',
  permissions: { isStaff: true, isSupervisor: false, isLead: false, isCoordinator: true, isAdmin: true, canAdmin: true },
};
const browser: HubUser = {
  email: 'staff@vsa.example.edu', displayName: 'Sam', role: 'staff',
  permissions: { isStaff: true, isSupervisor: false, isLead: false, isCoordinator: false, isAdmin: false, canAdmin: false },
};

const baseRule: SweepRule = {
  ruleId: 'rule-1',
  kind: 'cohort',
  cohortId: '2026',
  milestoneId: 'm2',
  supervisorId: '',
  studentId: '',
  when: 'before',
  days: 5,
  audience: 'owner',
  enabled: true,
  note: 'Upload the question.',
};

function sweepInput(overrides: Partial<Parameters<typeof planSweep>[0]> = {}) {
  return {
    today: '2026-10-15',
    tasks: [{
      taskId: 'task-1',
      studentId: 'student@vsa.example.edu',
      templateId: 'm2',
      dueDate: '2026-10-20',
      status: 'Pending',
      creatorType: 'System',
      title: 'Research question',
    }],
    students: [{
      cohortId: '2026',
      email: 'student@vsa.example.edu',
      displayName: 'Jamie Wong',
      supervisorId: 'supervisor@vsa.example.edu',
    }],
    templates: [{ milestoneId: 'm2', title: 'Research question', mOwner: 'student' }],
    staff: [
      { email: 'coordinator@vsa.example.edu', isStaff: true, isLead: false, isCoordinator: true, isAdmin: true },
      { email: 'supervisor@vsa.example.edu', isStaff: true, isLead: true, isCoordinator: false, isAdmin: false },
    ],
    rules: [baseRule],
    ...overrides,
  };
}

test('notification powers follow coordinator, supervisor, and staff browse', () => {
  assert.deepEqual(notificationPowers(coordinator), { browse: true, editRules: true, editOwnOverlays: false, runSweep: true });
  assert.deepEqual(notificationPowers(supervisor), { browse: true, editRules: false, editOwnOverlays: true, runSweep: false });
  assert.equal(notificationPowers(browser).browse, true);
  assert.equal(notificationPowers(browser).editRules, false);
  assert.equal(notificationPowers(student).browse, false);
});

test('trigger day is counted from the milestone due date', () => {
  assert.equal(triggerDay('2026-10-20', 'before', 5), '2026-10-15');
  assert.equal(triggerDay('2026-10-15', 'on', 0), '2026-10-15');
  assert.equal(triggerDay('2026-10-14', 'after', 1), '2026-10-15');
  assert.equal(timingLabel('before', 1), '1 day before the due date');
  assert.equal(timingLabel('on', 0), 'On the due date');
  assert.equal(audienceLabel('coordinator', 'student'), 'Coordinator only');
  assert.equal(audienceLabel('owner', 'supervisor'), 'Milestone owner · assigned supervisor');
});

test('a cohort rule emails the milestone owner once on the trigger day', () => {
  const plan = planSweep(sweepInput());
  assert.equal(plan.sends.length, 1);
  assert.deepEqual(plan.sends[0].recipients, ['student@vsa.example.edu']);
  assert.equal(plan.sends[0].subject.includes('Research question'), true);
  assert.equal(plan.sends[0].body.includes('Upload the question.'), true);
  assert.equal(planSweep(sweepInput({ today: '2026-10-14' })).sends.length, 0);
  assert.equal(planSweep(sweepInput({
    tasks: [{ ...sweepInput().tasks[0], status: 'Completed' }],
  })).sends.length, 0);
  const key = sendKey('cohort', 'rule-1', 'task-1', '2026-10-15');
  assert.equal(planSweep(sweepInput({ blockedSendIds: new Set([key]) })).sends.length, 0);
});

test('coordinator-only mail does not copy the milestone owner', () => {
  const plan = planSweep(sweepInput({
    rules: [{ ...baseRule, audience: 'coordinator' }],
    templates: [{ milestoneId: 'm2', title: 'Research question', mOwner: 'student' }],
  }));
  assert.deepEqual(plan.sends[0].recipients, ['coordinator@vsa.example.edu']);
});

test('supervisor-owned milestones email the roster supervisor', () => {
  const plan = planSweep(sweepInput({
    templates: [{ milestoneId: 'm2', title: 'Supervisor approval', mOwner: 'supervisor' }],
  }));
  assert.deepEqual(plan.sends[0].recipients, ['supervisor@vsa.example.edu']);
  const missing = planSweep(sweepInput({
    templates: [{ milestoneId: 'm2', title: 'Supervisor approval', mOwner: 'supervisor' }],
    students: [{ ...sweepInput().students[0], supervisorId: '' }],
  }));
  assert.equal(missing.sends.length, 0);
  assert.equal(missing.skipped[0].reason, 'No recipient for this milestone owner.');
});

test('supervisor overlays add reminders only for that supervisor’s students', () => {
  const overlay: SweepRule = {
    ...baseRule,
    ruleId: 'overlay-1',
    kind: 'overlay',
    supervisorId: 'supervisor@vsa.example.edu',
    studentId: '',
    when: 'on',
    days: 0,
    audience: 'owner',
  };
  const other = {
    cohortId: '2026',
    email: 'other@vsa.example.edu',
    displayName: 'Other Student',
    supervisorId: 'other-supervisor@vsa.example.edu',
  };
  const tasks = [
    sweepInput().tasks[0],
    { ...sweepInput().tasks[0], taskId: 'task-2', studentId: other.email, dueDate: '2026-10-15' },
  ];
  const plan = planSweep(sweepInput({
    today: '2026-10-15',
    rules: [{ ...overlay }],
    tasks: [
      { ...tasks[0], dueDate: '2026-10-15' },
      tasks[1],
    ],
    students: [sweepInput().students[0], other],
  }));
  assert.deepEqual(plan.sends.map((send) => send.studentId), ['student@vsa.example.edu']);

  const narrowed = planSweep(sweepInput({
    today: '2026-10-15',
    rules: [{ ...overlay, studentId: 'other@vsa.example.edu', supervisorId: 'other-supervisor@vsa.example.edu' }],
    tasks: [
      { ...tasks[0], dueDate: '2026-10-15' },
      tasks[1],
    ],
    students: [
      sweepInput().students[0],
      { ...other, supervisorId: 'other-supervisor@vsa.example.edu' },
    ],
  }));
  assert.deepEqual(narrowed.sends.map((send) => send.studentId), ['other@vsa.example.edu']);
});

test('send log blocks a finished send and a fresh in-progress send', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  assert.equal(sendIsBlocked({ status: 'sent', sentAt: now.toISOString() }, now), true);
  assert.equal(sendIsBlocked({ status: 'failed', sentAt: now.toISOString() }, now), false);
  assert.equal(sendIsBlocked({ status: 'dry-run', sentAt: now.toISOString() }, now), false);
  assert.equal(sendIsBlocked({ status: 'sending', sentAt: now.toISOString() }, now), true);
  assert.equal(sendIsBlocked({ status: 'sending', sentAt: '2026-10-14T00:00:00Z' }, now), false);
  assert.equal(sendKey('cohort', 'rule/1', 'task 1', '2026-10-15').includes('/'), false);
});

test('gmail raw messages keep header text on one line', () => {
  const raw = Buffer.from(buildRawMessage('ee@vsa.example.edu', {
    to: ['student@vsa.example.edu'],
    subject: 'Hello\r\nBcc: sneak@evil.test',
    body: 'Line one\nLine two',
  }), 'base64url').toString('utf8');
  assert.equal(raw.includes('\nBcc'), false);
  assert.equal(raw.includes('Subject: Hello Bcc: sneak@evil.test'), true);
  assert.equal(sanitizeHeader('a\nb'), 'a b');
  assert.equal(buildMessage({
    audience: 'owner',
    milestoneTitle: 'Research question',
    studentName: 'Jamie',
    dueDate: '2026-10-20',
    when: 'before',
    days: 5,
    note: '',
    test: true,
  }).subject.startsWith('[Test] '), true);
  const previous = process.env.EE_GMAIL_SENDER;
  const previousJson = process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON;
  delete process.env.EE_GMAIL_SENDER;
  delete process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON;
  assert.equal(gmailConfigured(), false);
  if (previous === undefined) delete process.env.EE_GMAIL_SENDER;
  else process.env.EE_GMAIL_SENDER = previous;
  if (previousJson === undefined) delete process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON;
  else process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON = previousJson;
});

function memoryStore() {
  const docs: Record<string, Record<string, Doc>> = {};
  const members: Record<string, Record<string, Doc>> = {};
  const audits: Doc[] = [];
  const store = {
    audits,
    async list(name: string) { return Object.values(docs[name] || {}); },
    async get(name: string, id: string) { return (docs[name] || {})[id] || null; },
    async set(name: string, id: string, data: Doc) { (docs[name] ||= {})[id] = { ...data }; },
    async remove(name: string, id: string) { if (docs[name]) delete docs[name][id]; },
    async whereEqual(name: string, field: string, value: unknown) {
      return Object.values(docs[name] || {}).filter((row) => row[field] === value);
    },
    async findBy() { return null; },
    async listMembers(cohortId: string) { return Object.values(members[cohortId] || {}); },
    async getMember(cohortId: string, email: string) { return (members[cohortId] || {})[email] || null; },
    async setMember(cohortId: string, email: string, data: Doc) { (members[cohortId] ||= {})[email] = { ...data }; },
    async addAudit(entry: Doc) { audits.push(entry); },
    db: {},
  };
  return store;
}

function appFor(store: ReturnType<typeof memoryStore>, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'Asia/Hong_Kong' };
}

async function seedDesk(store: ReturnType<typeof memoryStore>) {
  await store.set(COLLECTIONS.staffUsers, coordinator.email, {
    EMAIL: coordinator.email, DisplayName: 'Alex', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set(COLLECTIONS.staffUsers, supervisor.email, {
    EMAIL: supervisor.email, DisplayName: 'Priya', isStaff: true, isSupervisor: true,
  });
  await store.set(COLLECTIONS.staffUsers, browser.email, {
    EMAIL: browser.email, DisplayName: 'Sam', isStaff: true,
  });
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active' });
  await store.set(COLLECTIONS.milestoneTemplates, 'm2', {
    milestoneId: 'm2', milestoneTitle: 'Research question', mOwner: 'student', type: 'upload', phase: 'research',
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'm3', {
    milestoneId: 'm3', milestoneTitle: 'Supervisor approval', mOwner: 'supervisor', type: 'approval', phase: 'research',
  });
  await store.setMember('2026', student.email, {
    StudentId: student.email,
    'Display Name': 'Jamie Wong',
    'Student Email': student.email,
    supervisorId: supervisor.email,
  });
  await store.setMember('2026', 'other@vsa.example.edu', {
    StudentId: 'other@vsa.example.edu',
    'Display Name': 'Other Student',
    'Student Email': 'other@vsa.example.edu',
    supervisorId: 'other-supervisor@vsa.example.edu',
  });
}

test('coordinators own cohort rules and supervisors only overlay their students', async () => {
  const store = memoryStore();
  await seedDesk(store);
  const coordinatorApp = appFor(store, coordinator.email);
  const saved = await saveNotificationRule(coordinatorApp, {
    cohortId: '2026', milestoneId: 'm2', when: 'before', days: 7, audience: 'owner', enabled: true, note: 'Soon',
  });
  assert.equal(typeof saved.ruleId, 'string');
  await assert.rejects(
    saveNotificationRule(appFor(store, supervisor.email), {
      cohortId: '2026', milestoneId: 'm2', when: 'on', days: 0, audience: 'coordinator',
    }),
    /Access denied/,
  );
  await assert.rejects(saveNotificationRule(appFor(store, student.email), { cohortId: '2026', milestoneId: 'm2', when: 'on', days: 0, audience: 'owner' }), /Access denied/);

  const overlay = await saveNotificationOverlay(appFor(store, supervisor.email), {
    cohortId: '2026', milestoneId: 'm3', when: 'before', days: 2, audience: 'owner', studentId: student.email, enabled: true,
  });
  assert.equal(typeof overlay.overlayId, 'string');
  await assert.rejects(
    saveNotificationOverlay(appFor(store, supervisor.email), {
      cohortId: '2026', milestoneId: 'm3', when: 'after', days: 1, audience: 'owner', studentId: 'other@vsa.example.edu',
    }),
    /Access denied/,
  );
  await assert.rejects(
    saveNotificationOverlay(coordinatorApp, {
      cohortId: '2026', milestoneId: 'm3', when: 'on', days: 0, audience: 'coordinator',
    }),
    /Access denied/,
  );

  await store.set(COLLECTIONS.notificationOverlays, 'other-overlay', {
    overlayId: 'other-overlay',
    cohortId: '2026',
    milestoneId: 'm3',
    supervisorId: 'other-supervisor@vsa.example.edu',
    studentId: '',
    when: 'on',
    days: 0,
    audience: 'owner',
    enabled: true,
    note: '',
    createdBy: 'other-supervisor@vsa.example.edu',
    updatedBy: 'other-supervisor@vsa.example.edu',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  const desk = await listNotificationDesk(appFor(store, supervisor.email), '2026', '');
  assert.equal(desk.access.editRules, false);
  assert.equal(desk.access.editOwnOverlays, true);
  assert.equal(desk.rules.length, 1);
  assert.equal(desk.overlays.length, 1);
  assert.equal(desk.rules[0].audienceLabel, 'Milestone owner · student');
  assert.equal((await listNotificationDesk(coordinatorApp, '2026', '')).overlays.length, 2);

  const staffDesk = await listNotificationDesk(appFor(store, browser.email), '2026', '');
  assert.equal(staffDesk.access.editRules, false);
  assert.equal(staffDesk.access.editOwnOverlays, false);
  assert.equal(staffDesk.rules.length, 1);
  assert.equal(staffDesk.overlays.length, 2);
  assert.equal((await listNotificationDesk(appFor(store, browser.email), '2026', 'm2')).overlays.length, 0);

  await deleteNotificationRule(coordinatorApp, saved.ruleId);
  assert.equal((await listNotificationDesk(coordinatorApp, '2026', '')).rules.length, 0);
});
