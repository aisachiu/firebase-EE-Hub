import assert from 'node:assert/strict';
import test from 'node:test';
import { getStudentChat, getStaffStudentChat, sendStaffStudentChat, sendStudentChat } from './chat';
import { getStaffStudentHome } from './journey';
import { createStaffNote } from './messaging';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const studentEmail = 'student@vsa.example.edu';
const unassignedEmail = 'unassigned@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const coordinatorEmail = 'coordinator@vsa.example.edu';
const leadEmail = 'lead@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';
const browseEmail = 'browse@vsa.example.edu';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};
  messages: Record<string, Record<string, Doc>> = {};
  chats: Record<string, Record<string, Doc>> = {};
  entries: Record<string, Record<string, Doc>> = {};

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

  async removeMessage(ticketId: string, messageId: string): Promise<void> {
    if (this.messages[ticketId]) delete this.messages[ticketId][messageId];
  }

  async getChat(cohortId: string, studentId: string): Promise<Doc | null> {
    const row = (this.chats[cohortId] || {})[studentId];
    return row ? { ...row } : null;
  }

  async setChat(cohortId: string, studentId: string, data: Doc): Promise<void> {
    if (!this.chats[cohortId]) this.chats[cohortId] = {};
    this.chats[cohortId][studentId] = { ...data };
  }

  async listChats(cohortId: string): Promise<Doc[]> {
    return Object.values(this.chats[cohortId] || {}).map((row) => ({ ...row }));
  }

  async listChatEntries(cohortId: string, studentId: string): Promise<Doc[]> {
    const key = `${cohortId}\n${studentId}`;
    return Object.values(this.entries[key] || {}).map((row) => ({ ...row }));
  }

  async setChatEntry(cohortId: string, studentId: string, entryId: string, data: Doc): Promise<void> {
    const key = `${cohortId}\n${studentId}`;
    if (!this.entries[key]) this.entries[key] = {};
    this.entries[key][entryId] = { ...data };
  }

  async addAudit(): Promise<void> {}

  async getMeta(): Promise<Doc | null> {
    return null;
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

function chatBodies(entries: { kind?: string; body?: string }[]) {
  return entries.filter((entry) => entry.kind === 'chat').map((entry) => entry.body);
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
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true, LeadId: leadEmail,
  });
  await store.set('staffUsers', coordinatorEmail, {
    EMAIL: coordinatorEmail, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set('staffUsers', leadEmail, {
    EMAIL: leadEmail, DisplayName: 'Jordan Lee', isStaff: true, isLead: true,
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

test('supervisors, leads, and coordinators post into one student chat', async () => {
  const store = new MemoryStore();
  await seed(store);
  const student = appFor(store, studentEmail);
  const supervisor = appFor(store, supervisorEmail);
  const coordinator = appFor(store, coordinatorEmail);
  const lead = appFor(store, leadEmail);
  const other = appFor(store, otherEmail);
  const browse = appFor(store, browseEmail);

  const supervisorHome = await getStaffStudentHome(supervisor, studentEmail, '2026', 'supervisor');
  const coordinatorHome = await getStaffStudentHome(coordinator, studentEmail, '2026', 'coordinator');
  const leadHome = await getStaffStudentHome(lead, studentEmail, '2026', 'lead');
  const browseHome = await getStaffStudentHome(browse, studentEmail, '2026', 'staff');
  assert.equal(supervisorHome.canSendChat, true);
  assert.equal(coordinatorHome.canSendChat, true);
  assert.equal(leadHome.canSendChat, true);
  assert.equal(browseHome.canSendChat, false);

  await assert.rejects(getStaffStudentChat(browse, studentEmail, '2026', 'staff'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(browse, studentEmail, '2026', 'Hello', '', 'staff'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(other, studentEmail, '2026', 'Hello', '', 'supervisor'), /Access denied/);
  await assert.rejects(getStaffStudentChat(other, studentEmail, '2026', 'lead'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(student, studentEmail, '2026', 'Hello', '', ''), /Access denied/);
  await assert.rejects(getStaffStudentChat(supervisor, unassignedEmail, '2026', 'supervisor'), /Access denied/);
  await assert.rejects(sendStaffStudentChat(lead, unassignedEmail, '2026', 'Hello', '', 'lead'), /Access denied/);

  await assert.rejects(sendStaffStudentChat(supervisor, studentEmail, '2026', '   ', '', 'supervisor'), /Write a message/);
  await assert.rejects(
    sendStaffStudentChat(supervisor, studentEmail, '2026', 'x'.repeat(2001), '', 'supervisor'),
    /2,000 characters or fewer/,
  );

  const created = await sendStudentChat(student, 'Is this okay?', '');
  assert.equal(created.cohortId, '2026');
  const afterStudent = await store.getChat('2026', studentEmail);
  assert.deepEqual([...(afterStudent?.UnreadFor as string[])].sort(), [leadEmail, supervisorEmail].sort());

  const opened = await getStaffStudentChat(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(opened.canCompose, true);
  assert.equal(opened.viewerEmail, supervisorEmail);
  assert.deepEqual(chatBodies(opened.entries), ['Is this okay?']);
  assert.equal(opened.entries[0].authorRole, 'student');
  assert.equal(opened.entries[0].authorName, 'Jamie Wong');
  const cleared = await store.getChat('2026', studentEmail);
  assert.equal((cleared?.UnreadFor as string[]).includes(supervisorEmail), false);
  assert.equal((cleared?.UnreadFor as string[]).includes(leadEmail), true);

  await assert.rejects(
    sendStaffStudentChat(supervisor, studentEmail, '2026', 'Too late.', '2020-01-01T00:00:00.000Z', 'supervisor'),
    /changed in another tab/,
  );

  const leadSent = await sendStaffStudentChat(lead, studentEmail, '2026', 'I can help with the question.', opened.lastUpdated, 'lead');
  assert.equal(leadSent.created, false);
  const afterLead = await store.getChat('2026', studentEmail);
  assert.deepEqual([...(afterLead?.UnreadFor as string[])].sort(), [studentEmail, supervisorEmail].sort());

  const coordinatorSent = await sendStaffStudentChat(
    coordinator,
    studentEmail,
    '2026',
    'Try the second question.',
    leadSent.lastUpdated,
    'coordinator',
  );
  assert.equal(coordinatorSent.created, false);
  const afterCoordinator = await store.getChat('2026', studentEmail);
  assert.deepEqual(
    [...(afterCoordinator?.UnreadFor as string[])].sort(),
    [leadEmail, studentEmail, supervisorEmail].sort(),
  );

  const studentView = await getStudentChat(student);
  assert.deepEqual(chatBodies(studentView.entries), ['Is this okay?', 'I can help with the question.', 'Try the second question.']);
  assert.equal(studentView.entries[2].authorRole, 'staff');
  assert.equal(studentView.entries[2].authorName, 'Alex Chen');
  const studentCleared = await store.getChat('2026', studentEmail);
  assert.equal((studentCleared?.UnreadFor as string[]).includes(studentEmail), false);

  const supervisorSent = await sendStaffStudentChat(
    supervisor,
    studentEmail,
    '2026',
    'Friday works.',
    studentView.lastUpdated,
    'supervisor',
  );
  assert.equal(supervisorSent.created, false);
  const afterSupervisor = await store.getChat('2026', studentEmail);
  assert.deepEqual(afterSupervisor?.UnreadFor, [studentEmail]);
  const shared = await getStudentChat(student);
  assert.deepEqual(chatBodies(shared.entries), ['Is this okay?', 'I can help with the question.', 'Try the second question.', 'Friday works.']);
  assert.equal(shared.entries[3].authorName, 'Priya Shah');
});

test('a staff message starts the chat when the student has not written yet', async () => {
  const store = new MemoryStore();
  await seed(store);
  const supervisor = appFor(store, supervisorEmail);
  const student = appFor(store, studentEmail);
  const empty = await getStaffStudentChat(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(empty.entries.length, 0);

  const sent = await sendStaffStudentChat(supervisor, studentEmail, '2026', 'Welcome to the essay.\nMore detail.', '', 'supervisor');
  assert.equal(sent.created, true);
  const chat = await store.getChat('2026', studentEmail);
  assert.deepEqual(chat?.UnreadFor, [studentEmail]);
  const hub = await getStudentChat(student);
  assert.equal(hub.entries.length, 1);
  assert.equal(hub.entries[0].kind, 'chat');
  assert.equal(hub.entries[0].authorRole, 'staff');
  assert.equal(hub.entries[0].authorName, 'Priya Shah');
  assert.equal(hub.entries[0].body, 'Welcome to the essay.\nMore detail.');
  const quiet = await store.getChat('2026', studentEmail);
  assert.deepEqual(quiet?.UnreadFor, []);
});

test('chat posts skip private notes and keep doc comments in the same stream', async () => {
  const store = new MemoryStore();
  await seed(store);
  const supervisor = appFor(store, supervisorEmail);
  const coordinator = appFor(store, coordinatorEmail);
  const student = appFor(store, studentEmail);

  await createStaffNote(supervisor, studentEmail, '2026', 'Private', 'Keep this off the chat.', 'supervisor');
  await store.set('tickets', 'legacy-1', {
    TicketId: 'legacy-1',
    StudentId: studentEmail,
    Cohort: '2026',
    Category: 'Question',
    Title: 'Old thread',
    Status: 'Open',
    Route: 'supervisor',
    Assignee: supervisorEmail,
    CreatedAt: '2026-10-01T00:00:00.000Z',
    LastUpdated: '2026-10-01T00:00:00.000Z',
    LastActor: studentEmail,
    StudentUnread: false,
    StaffUnread: true,
    Shared: true,
  });
  await store.addMessage('legacy-1', 'm-old', {
    MessageId: 'm-old',
    TicketId: 'legacy-1',
    AuthorEmail: studentEmail,
    AuthorRole: 'student',
    Body: 'This used to be a ticket.',
    CreatedAt: '2026-10-01T00:00:00.000Z',
  });
  await store.set('docCommentThreads', 'essay__thread-1', {
    Id: 'essay__thread-1',
    FileId: 'essayDocId123456',
    ThreadId: 'thread-1',
    StudentId: studentEmail,
    Cohort: '2026',
    AuthorName: 'Priya Shah',
    AuthorEmail: supervisorEmail,
    CreatedAt: '2026-11-01T00:00:00.000Z',
    ModifiedAt: '2026-11-01T00:00:00.000Z',
    Quote: 'the river',
    Body: 'Tighten this.',
    ReplyCount: 0,
    RepliesJson: '[]',
    DocUrl: 'https://docs.google.com/document/d/essayDocId123456/edit',
    Deleted: false,
    Resolved: false,
  });
  store.members['2026'][studentEmail].EEDoc = 'https://docs.google.com/document/d/essayDocId123456/edit';

  const before = await getStaffStudentChat(coordinator, studentEmail, '2026', 'coordinator');
  assert.equal(before.entries.some((entry) => entry.kind === 'chat' && entry.body === 'This used to be a ticket.'), true);
  assert.equal(before.entries.some((entry) => entry.kind === 'doc-comment' && entry.body === 'Tighten this.'), true);
  assert.equal(before.entries.some((entry) => entry.body === 'Keep this off the chat.'), false);
  assert.equal(await store.get('tickets', 'legacy-1'), null);
  assert.equal(await store.get('docCommentThreads', 'essay__thread-1'), null);
  assert.ok(await store.get('tickets', (await store.list('tickets'))[0].TicketId as string));

  const sent = await sendStaffStudentChat(coordinator, studentEmail, '2026', 'See you Monday.', before.lastUpdated, 'coordinator');
  assert.equal(sent.created, false);
  const studentHub = await getStudentChat(student);
  assert.equal(studentHub.entries.some((entry) => entry.body === 'Keep this off the chat.'), false);
  assert.equal(studentHub.entries.some((entry) => entry.body === 'See you Monday.'), true);
  assert.equal(studentHub.entries.find((entry) => entry.body === 'See you Monday.')?.authorName, 'Alex Chen');
  const note = (await store.list('tickets')).find((row) => row.Category === 'Note');
  assert.ok(note);
});

test('a coordinator can open the chat for a student with no supervisor', async () => {
  const store = new MemoryStore();
  await seed(store);
  const coordinator = appFor(store, coordinatorEmail);
  const student = appFor(store, unassignedEmail);
  const sent = await sendStaffStudentChat(coordinator, unassignedEmail, '2026', 'I can help until a supervisor is assigned.', '', 'coordinator');
  assert.equal(sent.created, true);
  const hub = await getStudentChat(student);
  assert.equal(hub.entries.length, 1);
  assert.equal(hub.entries[0].body, 'I can help until a supervisor is assigned.');
  assert.equal(hub.entries[0].authorRole, 'staff');
  const record = await store.getChat('2026', unassignedEmail);
  assert.equal(record && record.SupervisorId, '');
  assert.deepEqual(record && record.UnreadFor, []);
});

test('a repeat year keeps a separate chat on the later cohort', async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.set('cohorts', '2025', { Cohort: '2025', Status: 'Active' });
  store.members['2025'] = {
    [studentEmail]: {
      StudentId: studentEmail,
      'Display Name': 'Jamie Wong',
      supervisorId: supervisorEmail,
      eeActive: true,
    },
  };
  store.members['2026'][studentEmail].eeActive = '';
  await store.set('tickets', 'blank-year', {
    TicketId: 'blank-year',
    StudentId: studentEmail,
    Cohort: '',
    Category: 'Question',
    Title: 'Earlier year',
    Status: 'Open',
    Route: 'supervisor',
    Assignee: supervisorEmail,
    CreatedAt: '2025-05-01T00:00:00.000Z',
    LastUpdated: '2025-05-01T00:00:00.000Z',
    LastActor: studentEmail,
    Shared: true,
  });
  await store.addMessage('blank-year', 'm-blank', {
    MessageId: 'm-blank',
    TicketId: 'blank-year',
    AuthorEmail: studentEmail,
    AuthorRole: 'student',
    Body: 'This belongs with the earlier cohort.',
    CreatedAt: '2025-05-01T00:00:00.000Z',
  });

  const student = appFor(store, studentEmail);
  const current = await sendStudentChat(student, 'This year I am starting again.', '');
  assert.equal(current.cohortId, '2026');
  const currentChat = await getStudentChat(student);
  assert.deepEqual(chatBodies(currentChat.entries), ['This year I am starting again.']);

  const supervisor = appFor(store, supervisorEmail);
  const earlier = await getStaffStudentChat(supervisor, studentEmail, '2025', 'supervisor');
  assert.deepEqual(chatBodies(earlier.entries), ['This belongs with the earlier cohort.']);
  assert.equal(await store.get('tickets', 'blank-year'), null);
});

test('reassignment moves an unread chat from the previous supervisor to the new one', async () => {
  const store = new MemoryStore();
  await seed(store);
  const student = appFor(store, studentEmail);
  await sendStudentChat(student, 'Please read this.', '');
  store.members['2026'][studentEmail].supervisorId = otherEmail;
  await store.set('staffUsers', otherEmail, {
    EMAIL: otherEmail, DisplayName: 'Other Supervisor', isStaff: true, isSupervisor: true, LeadId: coordinatorEmail,
  });
  const moved = await getStudentChat(student);
  assert.equal(moved.entries[0].body, 'Please read this.');
  const chat = await store.getChat('2026', studentEmail);
  assert.equal(chat?.SupervisorId, otherEmail);
  assert.equal(chat?.LeadId, coordinatorEmail);
  const unread = chat?.UnreadFor as string[];
  assert.equal(unread.includes(supervisorEmail), false);
  assert.equal(unread.includes(otherEmail), true);
  assert.equal(unread.includes(leadEmail), false);
  assert.equal(unread.includes(coordinatorEmail), true);
});
