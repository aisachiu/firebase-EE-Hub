import assert from 'node:assert/strict';
import test from 'node:test';
import { activityFeed } from './activity';
import { buildRawMessage, gmailConfigured, sanitizeHeader } from './gmail';
import {
  deleteNotificationRule,
  executeSweep,
  listNotificationDesk,
  previewNotificationRule,
  saveNotificationOverlay,
  saveNotificationRule,
  sendNotificationRule,
} from './notifications';
import {
  audienceLabel,
  buildMessage,
  newlyEmailedStudent,
  notificationPowers,
  planSweep,
  sendIsBlocked,
  sendKey,
  sendVisibleTo,
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
    db: {
      collection(name: string) {
        return { doc(id: string) { return { name, id }; } };
      },
      async runTransaction(work: (tx: {
        get(ref: { name: string; id: string }): Promise<{ exists: boolean; data(): Doc | undefined }>;
        set(ref: { name: string; id: string }, data: Doc): void;
      }) => Promise<unknown>) {
        const tx = {
          async get(ref: { name: string; id: string }) {
            const data = (docs[ref.name] || {})[ref.id];
            return { exists: !!data, data: () => data };
          },
          set(ref: { name: string; id: string }, data: Doc) {
            (docs[ref.name] ||= {})[ref.id] = { ...data };
          },
        };
        return work(tx);
      },
    },
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

test('a student activity row is recorded only when that student is newly delivered', () => {
  assert.equal(newlyEmailedStudent('Student@vsa.example.edu', [], ['student@vsa.example.edu']), true);
  assert.equal(newlyEmailedStudent('student@vsa.example.edu', ['student@vsa.example.edu'], ['student@vsa.example.edu', 'coordinator@vsa.example.edu']), false);
  assert.equal(newlyEmailedStudent('student@vsa.example.edu', [], ['coordinator@vsa.example.edu']), false);
  assert.equal(newlyEmailedStudent('', [], ['student@vsa.example.edu']), false);
});

test('overlay sends stay with the owning supervisor, and coordinators see every send', () => {
  const overlay = { ruleKind: 'overlay', supervisorId: supervisor.email };
  assert.equal(sendVisibleTo(notificationPowers(supervisor), supervisor.email, overlay), true);
  assert.equal(sendVisibleTo(notificationPowers(supervisor), supervisor.email, { ruleKind: 'overlay', supervisorId: 'other-supervisor@vsa.example.edu' }), false);
  assert.equal(sendVisibleTo(notificationPowers(coordinator), coordinator.email, overlay), true);
  assert.equal(sendVisibleTo(notificationPowers(browser), browser.email, overlay), true);
  assert.equal(sendVisibleTo(notificationPowers(supervisor), supervisor.email, { ruleKind: 'cohort' }), true);
});

test('a sent reminder is on the email log and on that student’s activity', async () => {
  const store = memoryStore();
  await seedDesk(store);
  await store.set(COLLECTIONS.studentActionItems, 'task-1', {
    TaskId: 'task-1',
    StudentId: student.email,
    TemplateId: 'm2',
    DueDate: '2026-10-20',
    Status: 'Pending',
    CreatorType: 'System',
    Title: 'Research question',
  });
  await store.set(COLLECTIONS.notificationRules, 'rule-1', {
    ruleId: 'rule-1',
    cohortId: '2026',
    milestoneId: 'm2',
    when: 'before',
    days: 5,
    audience: 'owner',
    enabled: true,
    note: 'Upload the question.',
  });
  await store.set(COLLECTIONS.notificationSends, 'overlay-other-send', {
    sendId: 'overlay-other-send',
    ruleId: 'overlay-other',
    ruleKind: 'overlay',
    cohortId: '2026',
    milestoneId: 'm3',
    milestoneTitle: 'Supervisor approval',
    studentId: 'other@vsa.example.edu',
    studentName: 'Other Student',
    supervisorId: 'other-supervisor@vsa.example.edu',
    recipients: ['other-supervisor@vsa.example.edu'],
    audience: 'owner',
    subject: 'Other reminder',
    status: 'sent',
    sentAt: '2026-10-15T01:00:00.000Z',
    when: 'on',
    days: 0,
  });
  const now = new Date('2026-10-15T04:00:00.000Z');
  let attempts = 0;
  const failing = await executeSweep(appFor(store, coordinator.email), {
    now,
    mailer: {
      async send() {
        attempts += 1;
        throw new Error('mailbox unavailable');
      },
    },
  });
  assert.equal(failing.failed, 1);
  assert.equal(store.audits.filter((row) => row.Action === 'NOTIFICATION_EMAIL').length, 0);

  const summary = await executeSweep(appFor(store, coordinator.email), {
    now,
    mailer: { async send() { attempts += 1; } },
  });
  assert.equal(summary.sent, 1);
  assert.equal(attempts, 2);

  const coordinatorDesk = await listNotificationDesk(appFor(store, coordinator.email), '2026', '');
  assert.equal(coordinatorDesk.sends.length, 2);
  const own = coordinatorDesk.sends.find((row) => row.ruleKind === 'cohort');
  assert.equal(own?.status, 'sent');
  assert.equal(own?.studentName, 'Jamie Wong');
  assert.deepEqual(own?.recipients, [student.email]);

  const supervisorDesk = await listNotificationDesk(appFor(store, supervisor.email), '2026', '');
  assert.equal(supervisorDesk.sends.some((row) => row.supervisorId === 'other-supervisor@vsa.example.edu'), false);
  assert.equal(supervisorDesk.sends.some((row) => row.ruleKind === 'cohort'), true);
  assert.equal((await listNotificationDesk(appFor(store, browser.email), '2026', 'm3')).sends.length, 1);

  const feed = activityFeed(student.email, store.audits, { m2: 'Research question' }, { 'task-1': 'Research question' });
  const email = feed.entries.find((entry) => entry.kind === 'email');
  assert.equal(email?.title, 'Email reminder');
  assert.equal(email?.summary, 'Research question was emailed to you');
  assert.equal(feed.counts.email, 1);
  assert.equal(email?.details.some((row: { label: string; value: string }) => row.label === 'Emailed' && row.value === student.email), true);
  assert.equal(activityFeed('other@vsa.example.edu', store.audits, {}, {}).entries.some((entry) => entry.kind === 'email'), false);

  const again = await executeSweep(appFor(store, coordinator.email), {
    now,
    mailer: { async send() { attempts += 1; } },
  });
  assert.equal(again.considered, 0);
  assert.equal(store.audits.filter((row) => row.Action === 'NOTIFICATION_EMAIL').length, 1);
});

test('coordinator-only mail stays on the log and off the student activity', async () => {
  const store = memoryStore();
  await seedDesk(store);
  await store.set(COLLECTIONS.studentActionItems, 'task-1', {
    TaskId: 'task-1',
    StudentId: student.email,
    TemplateId: 'm2',
    DueDate: '2026-10-15',
    Status: 'Pending',
    CreatorType: 'System',
    Title: 'Research question',
  });
  await store.set(COLLECTIONS.notificationRules, 'rule-coord', {
    ruleId: 'rule-coord',
    cohortId: '2026',
    milestoneId: 'm2',
    when: 'on',
    days: 0,
    audience: 'coordinator',
    enabled: true,
    note: '',
  });
  const dry = await executeSweep(appFor(store, coordinator.email), {
    now: new Date('2026-10-15T04:00:00.000Z'),
    dryRun: true,
  });
  assert.equal(dry.sent, 0);
  assert.equal(store.audits.filter((row) => row.Action === 'NOTIFICATION_EMAIL').length, 0);

  const sentTo: string[] = [];
  const summary = await executeSweep(appFor(store, coordinator.email), {
    now: new Date('2026-10-15T04:00:00.000Z'),
    mailer: { async send(mail) { sentTo.push(...mail.to); } },
  });
  assert.equal(summary.sent, 1);
  assert.deepEqual(sentTo, [coordinator.email]);
  const desk = await listNotificationDesk(appFor(store, coordinator.email), '2026', 'm2');
  assert.equal(desk.sends.length, 1);
  assert.equal(desk.sends[0].status, 'sent');
  assert.equal(desk.sends[0].audienceLabel, 'Coordinator only');
  assert.equal(store.audits.filter((row) => row.Action === 'NOTIFICATION_EMAIL').length, 0);
});

test('preview and send emails only the messages a coordinator selects', async () => {
  const store = memoryStore();
  await seedDesk(store);
  const task = {
    TemplateId: 'm2',
    DueDate: '2026-10-20',
    Status: 'Pending',
    CreatorType: 'System',
    Title: 'Research question',
  };
  await store.set(COLLECTIONS.studentActionItems, 'task-1', {
    ...task, TaskId: 'task-1', StudentId: student.email,
  });
  await store.set(COLLECTIONS.studentActionItems, 'task-2', {
    ...task, TaskId: 'task-2', StudentId: 'other@vsa.example.edu',
  });
  await store.set(COLLECTIONS.notificationRules, 'rule-1', {
    ruleId: 'rule-1',
    cohortId: '2026',
    milestoneId: 'm2',
    when: 'before',
    days: 5,
    audience: 'owner',
    enabled: true,
    note: 'Upload the question.',
  });
  await store.set(COLLECTIONS.notificationRules, 'rule-other', {
    ruleId: 'rule-other',
    cohortId: '2026',
    milestoneId: 'm3',
    when: 'on',
    days: 0,
    audience: 'coordinator',
    enabled: true,
    note: '',
  });
  const now = new Date('2026-10-15T04:00:00.000Z');
  await assert.rejects(
    previewNotificationRule(appFor(store, supervisor.email), 'cohort', 'rule-1', now),
    /Access denied/,
  );
  const preview = await previewNotificationRule(appFor(store, coordinator.email), 'cohort', 'rule-1', now);
  assert.equal(preview.enabled, true);
  assert.equal(preview.today, '2026-10-15');
  assert.deepEqual(preview.messages.map((message) => message.studentId).sort(), ['other@vsa.example.edu', student.email]);
  assert.equal(preview.messages[0].subject.includes('Research question'), true);
  assert.equal(preview.messages[0].body.includes('Upload the question.'), true);
  const jamie = preview.messages.find((message) => message.studentId === student.email);
  assert.ok(jamie);

  const sentTo: string[] = [];
  const result = await sendNotificationRule(appFor(store, coordinator.email), {
    kind: 'cohort',
    ruleId: 'rule-1',
    sendIds: [jamie.sendId, 'rule-other-send'],
  }, {
    now,
    mailer: { async send(mail) { sentTo.push(...mail.to); } },
  });
  assert.deepEqual(sentTo, [student.email]);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 1);
  assert.equal(store.audits.filter((row) => row.Action === 'NOTIFICATION_EMAIL' && row.User === student.email).length, 1);
  assert.equal(store.audits.filter((row) => row.Action === 'NOTIFICATION_EMAIL' && row.User === 'other@vsa.example.edu').length, 0);

  const after = await previewNotificationRule(appFor(store, coordinator.email), 'cohort', 'rule-1', now);
  assert.equal(after.messages.some((message) => message.studentId === student.email), false);
  assert.equal(after.messages.some((message) => message.studentId === 'other@vsa.example.edu'), true);
  assert.equal(after.skipped.some((group) => group.reason === 'Already sent for this trigger day.' && group.students.includes('Jamie Wong')), true);

  await store.set(COLLECTIONS.notificationRules, 'rule-1', {
    ...(await store.get(COLLECTIONS.notificationRules, 'rule-1')),
    enabled: false,
  });
  const off = await previewNotificationRule(appFor(store, coordinator.email), 'cohort', 'rule-1', now);
  assert.equal(off.enabled, false);
  assert.equal(off.messages.some((message) => message.studentId === 'other@vsa.example.edu'), true);
  await assert.rejects(
    sendNotificationRule(appFor(store, coordinator.email), {
      kind: 'cohort',
      ruleId: 'rule-1',
      sendIds: [off.messages[0].sendId],
    }, { now, mailer: { async send() { sentTo.push('should-not'); } } }),
    /Turn this reminder on/,
  );
  const previous = process.env.EE_NOTIFICATIONS_DRY_RUN;
  process.env.EE_NOTIFICATIONS_DRY_RUN = 'true';
  await store.set(COLLECTIONS.notificationRules, 'rule-1', {
    ...(await store.get(COLLECTIONS.notificationRules, 'rule-1')),
    enabled: true,
  });
  await assert.rejects(
    sendNotificationRule(appFor(store, coordinator.email), {
      kind: 'cohort',
      ruleId: 'rule-1',
      sendIds: [off.messages[0].sendId],
    }, { now, mailer: { async send() { sentTo.push('should-not'); } } }),
    /Dry run is on/,
  );
  if (previous === undefined) delete process.env.EE_NOTIFICATIONS_DRY_RUN;
  else process.env.EE_NOTIFICATIONS_DRY_RUN = previous;
  assert.deepEqual(sentTo, [student.email]);
});
