import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStaffNote,
  getStaffNotesHub,
  getStaffStudentPanel,
  getTicketHub,
  replyTicket,
  setMessageShared,
} from './messaging';
import { App } from './session';
import { Store } from './store';
import { staffNotesForStudent, TicketShape } from './ticketsPure';
import { Doc } from './util';

const studentEmail = 'student@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const coordinatorEmail = 'coordinator@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';

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
  await store.set('studentUsers', studentEmail, { StudentId: studentEmail, DisplayName: 'Jamie Wong' });
}

test('staff notes for a student include every author and the latest activity first', () => {
  const older: TicketShape = {
    studentId: studentEmail,
    category: 'Note',
    route: 'supervisor',
    assignee: supervisorEmail,
    shared: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUpdated: '2026-10-02T00:00:00.000Z',
  };
  const replied: TicketShape = {
    studentId: studentEmail,
    category: 'Note',
    route: 'coordinator',
    assignee: coordinatorEmail,
    shared: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUpdated: '2026-10-05T00:00:00.000Z',
  };
  const message: TicketShape = { ...older, category: 'Ethics', shared: true };
  const otherStudent: TicketShape = { ...older, studentId: 'other-student@vsa.example.edu' };
  const notes = staffNotesForStudent([older, message, otherStudent, replied], studentEmail);
  assert.deepEqual(notes.map((note) => note.assignee), [coordinatorEmail, supervisorEmail]);
});

test('staff share notes on the student page, with titles, authors, and replies', async () => {
  const store = new MemoryStore();
  await seed(store);
  const supervisor = appFor(store, supervisorEmail);
  const coordinator = appFor(store, coordinatorEmail);
  const other = appFor(store, otherEmail);
  const student = appFor(store, studentEmail);

  await assert.rejects(
    createStaffNote(supervisor, studentEmail, '2026', '   ', 'A note without a title.', 'supervisor'),
    /Add a title/,
  );

  const first = await createStaffNote(
    supervisor,
    studentEmail,
    '2026',
    'Research question',
    'Jamie is still choosing between two questions.',
    'supervisor',
  );
  const firstRecord = await store.get('tickets', String(first.ticketId));
  assert.ok(firstRecord);
  firstRecord.CreatedAt = '2020-01-01T00:00:00.000Z';
  firstRecord.LastUpdated = '2020-01-01T00:00:00.000Z';
  await store.set('tickets', String(first.ticketId), firstRecord);

  await createStaffNote(coordinator, studentEmail, '2026', 'Supervisor meeting', 'Met on Monday.', 'coordinator');

  const panel = await getStaffStudentPanel(coordinator, studentEmail, '2026', 'coordinator');
  assert.equal(panel.notes.length, 2);
  assert.equal(panel.notes[0].title, 'Supervisor meeting');
  assert.equal(panel.notes[1].title, 'Research question');
  assert.equal(panel.notes[1].authorName, 'Priya Shah');
  assert.equal(panel.notes[1].messages[0].authorName, 'Priya Shah');
  assert.equal(panel.notes[1].messages[0].body, 'Jamie is still choosing between two questions.');
  assert.equal(panel.notes[0].canShare, true);
  assert.equal(panel.notes[1].canShare, false);

  const supervisorPanel = await getStaffStudentPanel(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(supervisorPanel.notes[1].canShare, true);
  await assert.rejects(
    getStaffStudentPanel(other, studentEmail, '2026', 'supervisor'),
    /Access denied/,
  );

  const hidden = await getTicketHub(student);
  assert.equal(hidden.tickets.length, 0);

  await assert.rejects(
    replyTicket(other, first.ticketId, 'I should not see this.', '2020-01-01T00:00:00.000Z', 'supervisor'),
    /Access denied/,
  );
  const reply = await replyTicket(
    coordinator,
    first.ticketId,
    'I read the draft and the second question is stronger.',
    '2020-01-01T00:00:00.000Z',
    'coordinator',
  );
  const afterReply = await store.get('tickets', String(first.ticketId));
  assert.equal(afterReply && afterReply.Status, 'Open');
  assert.equal(afterReply && afterReply.StudentUnread, false);

  const repliedPanel = await getStaffStudentPanel(supervisor, studentEmail, '2026', 'supervisor');
  assert.equal(repliedPanel.notes[0].title, 'Research question');
  assert.equal(repliedPanel.notes[0].messages.length, 2);
  assert.equal(repliedPanel.notes[0].messages[1].authorName, 'Alex Chen');
  assert.equal(repliedPanel.notes[0].messages[1].body, 'I read the draft and the second question is stronger.');

  const hub = await getStaffNotesHub(coordinator, 'coordinator');
  assert.equal(hub.notes[0].ticketId, first.ticketId);
  const otherHub = await getStaffNotesHub(other, 'supervisor');
  assert.equal(otherHub.notes.length, 0);

  await assert.rejects(
    setMessageShared(coordinator, first.ticketId, true, reply.lastUpdated, 'coordinator'),
    /Access denied/,
  );
  const shared = await setMessageShared(supervisor, first.ticketId, true, reply.lastUpdated, 'supervisor');
  assert.equal(shared.shared, true);
  const visible = await getTicketHub(student);
  assert.equal(visible.tickets.length, 1);
  assert.equal(visible.tickets[0].title, 'Research question');
  assert.equal(visible.tickets[0].messages.length, 2);
});
