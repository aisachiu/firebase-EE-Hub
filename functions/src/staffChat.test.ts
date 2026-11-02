import assert from 'node:assert/strict';
import test from 'node:test';
import { getStaffStudentHome } from './journey';
import {
  createStaffNote,
  createTicket,
  getStaffStudentChat,
  getStaffTickets,
  getTicketHub,
  replyTicket,
  sendStaffStudentChat,
} from './messaging';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const studentEmail = 'student@vsa.example.edu';
const unassignedEmail = 'unassigned@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const coordinatorEmail = 'coordinator@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';
const browseEmail = 'browse@vsa.example.edu';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};
  messages: Record<string, Record<string, Doc>> = {};

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

  async findBy(name: string, field: string, value: unknown): Promise<Doc | null> {
    return (await this.list(name)).find((row) => row[field] === value) || null;
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

  async listMessages(ticketId: string): Promise<Doc[]> {
    return Object.values(this.messages[ticketId] || {})
      .map((row) => ({ ...row }))
      .sort((left, right) => String(left.CreatedAt).localeCompare(String(right.CreatedAt)));
  }

  async addMessage(ticketId: string, messageId: string, data: Doc): Promise<void> {
    if (!this.messages[ticketId]) this.messages[ticketId] = {};
    this.messages[ticketId][messageId] = { ...data };
  }

  async addAudit(): Promise<void> {}

  async getMeta(): Promise<Doc | null> {
    return null;
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

async function seed(store: MemoryStore) {
  await store.set('cohorts', '2026', { Cohort: '2026', Status: 'Active' });
  store.members['2026'] = {
    [studentEmail]: {
      StudentId: studentEmail,
      'Display Name': 'Jamie Wong',
      supervisorId: supervisorEmail,
    },
    [unassignedEmail]: {
      StudentId: unassignedEmail,
      'Display Name': 'No Supervisor',
    },
  };
  await store.set('staffUsers', supervisorEmail, {
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set('staffUsers', coordinatorEmail, {
    EMAIL: coordinatorEmail, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set('staffUsers', otherEmail, {
    EMAIL: otherEmail, DisplayName: 'Other Supervisor', isStaff: true, isSupervisor: true,
  });
  await store.set('staffUsers', browseEmail, {
    EMAIL: browseEmail, DisplayName: 'Browser', isStaff: true,
  });
  await store.set('studentUsers', studentEmail, { StudentId: studentEmail, DisplayName: 'Jamie Wong' });
  await store.set('studentUsers', unassignedEmail, { StudentId: unassignedEmail, DisplayName: 'No Supervisor' });
}

function bodies(ticket: { messages?: { body?: string }[] }) {
  return (ticket.messages || []).map((message) => message.body);
}

test('supervisors and coordinators post into the student chat and the student sees it', async () => {
  const store = new MemoryStore();
  await seed(store);
  const student = appFor(store, studentEmail);
  const supervisor = appFor(store, supervisorEmail);
  const coordinator = appFor(store, coordinatorEmail);
  const other = appFor(store, otherEmail);
  const browse = appFor(store, browseEmail);

  const supervisorHome = await getStaffStudentHome(supervisor, studentEmail, '2026', 'supervisor');
  const coordinatorHome = await getStaffStudentHome(coordinator, studentEmail, '2026', 'coordinator');
  const browseHome = await getStaffStudentHome(browse, studentEmail, '2026', 'staff');
  assert.equal(supervisorHome.canSendChat, true);
  assert.equal(coordinatorHome.canSendChat, true);
  assert.equal(browseHome.canSendChat, false);

  await assert.rejects(getStaffStudentChat(browse, studentEmail, '2026', 'staff'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(browse, studentEmail, '2026', 'Hello', '', 'staff'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(other, studentEmail, '2026', 'Hello', '', 'supervisor'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(student, studentEmail, '2026', 'Hello', '', ''), /Access denied/);
  await assert.rejects(getStaffStudentChat(supervisor, unassignedEmail, '2026', 'supervisor'), /Access denied/);

  await assert.rejects(sendStaffStudentChat(supervisor, studentEmail, '2026', '   ', '', 'supervisor'), /Write a message/);
  await assert.rejects(
    sendStaffStudentChat(supervisor, studentEmail, '2026', 'x'.repeat(2001), '', 'supervisor'),
    /2,000 characters or fewer/,
  );

  const created = await createTicket(student, {
    category: 'Subject & Methodology',
    title: 'Question',
    body: 'Is this okay?',
  });
  const opened = await getStaffStudentChat(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(opened.canCompose, true);
  assert.equal(opened.viewerEmail, supervisorEmail);
  assert.equal(opened.tickets.length, 1);
  assert.deepEqual(bodies(opened.tickets[0]), ['Is this okay?']);
  assert.equal(opened.tickets[0].messages[0].authorRole, 'student');
  assert.equal(opened.tickets[0].messages[0].authorName, 'Jamie Wong');

  await assert.rejects(
    replyTicket(coordinator, created.ticketId, 'From the queue.', opened.tickets[0].lastUpdated, 'coordinator'),
    /Access denied/,
  );

  const coordinatorSent = await sendStaffStudentChat(
    coordinator,
    studentEmail,
    '2026',
    'Try the second question.',
    opened.tickets[0].lastUpdated,
    'coordinator',
  );
  assert.equal(coordinatorSent.created, false);
  assert.equal(coordinatorSent.ticketId, created.ticketId);

  const afterCoordinator = await getTicketHub(student);
  assert.equal(afterCoordinator.tickets.length, 1);
  assert.deepEqual(bodies(afterCoordinator.tickets[0]), ['Is this okay?', 'Try the second question.']);
  assert.equal(afterCoordinator.tickets[0].messages[1].authorRole, 'staff');
  assert.equal(afterCoordinator.tickets[0].messages[1].authorName, 'Alex Chen');
  assert.equal(afterCoordinator.unreadCount, 1);

  const supervisorQueue = await getStaffTickets(supervisor, 'supervisor');
  assert.equal(supervisorQueue.tickets.some((ticket) => ticket.ticketId === created.ticketId), true);
  assert.equal(supervisorQueue.tickets.find((ticket) => ticket.ticketId === created.ticketId)?.staffUnread, true);
  const coordinatorQueue = await getStaffTickets(coordinator, 'coordinator');
  assert.equal(coordinatorQueue.tickets.some((ticket) => ticket.ticketId === created.ticketId), false);

  const fresh = await getStaffStudentChat(coordinator, studentEmail, '2026', 'coordinator');
  await assert.rejects(
    sendStaffStudentChat(supervisor, studentEmail, '2026', 'Too late.', '2020-01-01T00:00:00.000Z', 'supervisor'),
    /changed in another tab/,
  );
  const unchanged = await getStaffStudentChat(supervisor, studentEmail, '2026', 'supervisor');
  assert.deepEqual(bodies(unchanged.tickets[0]), ['Is this okay?', 'Try the second question.']);

  const supervisorSent = await sendStaffStudentChat(
    supervisor,
    studentEmail,
    '2026',
    'Friday works.',
    fresh.tickets[0].lastUpdated,
    'supervisor',
  );
  assert.equal(supervisorSent.created, false);
  const shared = await getTicketHub(student);
  assert.deepEqual(bodies(shared.tickets[0]), ['Is this okay?', 'Try the second question.', 'Friday works.']);
  assert.equal(shared.tickets[0].messages[2].authorName, 'Priya Shah');
  const quietQueue = await getStaffTickets(supervisor, 'supervisor');
  assert.equal(quietQueue.tickets.find((ticket) => ticket.ticketId === created.ticketId)?.staffUnread, false);

  const both = await getStaffStudentChat(coordinator, studentEmail, '2026', 'coordinator');
  assert.deepEqual(bodies(both.tickets[0]), ['Is this okay?', 'Try the second question.', 'Friday works.']);
});

test('a staff message starts the supervisor chat when the student has not written yet', async () => {
  const store = new MemoryStore();
  await seed(store);
  const supervisor = appFor(store, supervisorEmail);
  const student = appFor(store, studentEmail);
  const empty = await getStaffStudentChat(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(empty.tickets.length, 0);

  const sent = await sendStaffStudentChat(supervisor, studentEmail, '2026', 'Welcome to the essay.\nMore detail.', '', 'supervisor');
  assert.equal(sent.created, true);
  const hub = await getTicketHub(student);
  assert.equal(hub.tickets.length, 1);
  assert.equal(hub.tickets[0].route, 'supervisor');
  assert.equal(hub.tickets[0].title, 'Welcome to the essay.');
  assert.equal(hub.tickets[0].messages[0].authorRole, 'staff');
  assert.equal(hub.tickets[0].messages[0].authorName, 'Priya Shah');
  assert.equal(hub.tickets[0].messages[0].body, 'Welcome to the essay.\nMore detail.');
  const record = await store.get('tickets', String(sent.ticketId));
  assert.equal(record && record.Shared, true);
  assert.equal(record && record.Assignee, supervisorEmail);
  assert.equal(record && record.StudentUnread, true);
  assert.equal(record && record.StaffUnread, false);
});

test('chat posts skip private notes and doc comment cards', async () => {
  const store = new MemoryStore();
  await seed(store);
  const supervisor = appFor(store, supervisorEmail);
  const coordinator = appFor(store, coordinatorEmail);
  const student = appFor(store, studentEmail);

  await createStaffNote(supervisor, studentEmail, '2026', 'Private', 'Keep this off the chat.', 'supervisor');
  await store.set('tickets', 'doc-1', {
    TicketId: 'doc-1',
    StudentId: studentEmail,
    Cohort: '2026',
    Category: 'Doc comment',
    Title: 'Comment',
    Status: 'Open',
    Route: 'supervisor',
    Assignee: supervisorEmail,
    CreatedAt: '2026-11-01T00:00:00.000Z',
    LastUpdated: '2026-11-01T00:00:00.000Z',
    LastActor: supervisorEmail,
    StudentUnread: false,
    StaffUnread: false,
    Shared: true,
  });
  await store.addMessage('doc-1', 'm-doc', {
    MessageId: 'm-doc',
    TicketId: 'doc-1',
    AuthorEmail: supervisorEmail,
    AuthorRole: 'staff',
    Body: 'Tighten this.',
    CreatedAt: '2026-11-01T00:00:00.000Z',
  });

  const before = await getStaffStudentChat(coordinator, studentEmail, '2026', 'coordinator');
  assert.equal(before.tickets.length, 1);
  assert.equal(before.tickets[0].category, 'Doc comment');

  const sent = await sendStaffStudentChat(coordinator, studentEmail, '2026', 'See you Monday.', '', 'coordinator');
  assert.equal(sent.created, true);
  assert.notEqual(sent.ticketId, 'doc-1');
  const docMessages = await store.listMessages('doc-1');
  assert.equal(docMessages.length, 1);

  const studentHub = await getTicketHub(student);
  assert.equal(studentHub.tickets.some((ticket) => ticket.category === 'Note'), false);
  const chat = studentHub.tickets.find((ticket) => ticket.ticketId === sent.ticketId);
  assert.ok(chat);
  assert.equal(chat && chat.messages[0].body, 'See you Monday.');
  assert.equal(chat && chat.messages[0].authorName, 'Alex Chen');

  const stream = await getStaffStudentChat(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(stream.tickets.some((ticket) => ticket.category === 'Note'), false);
  assert.equal(stream.tickets.some((ticket) => ticket.category === 'Doc comment'), true);
  assert.equal(stream.tickets.some((ticket) => ticket.ticketId === sent.ticketId), true);
});

test('a coordinator can open the chat for a student with no supervisor', async () => {
  const store = new MemoryStore();
  await seed(store);
  const coordinator = appFor(store, coordinatorEmail);
  const student = appFor(store, unassignedEmail);
  const sent = await sendStaffStudentChat(coordinator, unassignedEmail, '2026', 'I can help until a supervisor is assigned.', '', 'coordinator');
  const hub = await getTicketHub(student);
  assert.equal(hub.tickets.length, 1);
  assert.equal(hub.tickets[0].messages[0].body, 'I can help until a supervisor is assigned.');
  assert.equal(hub.tickets[0].messages[0].authorRole, 'staff');
  const record = await store.get('tickets', String(sent.ticketId));
  assert.equal(record && record.Assignee, '');
  assert.equal(record && record.StaffUnread, false);
});
