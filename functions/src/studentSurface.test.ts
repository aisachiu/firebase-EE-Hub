import assert from 'node:assert/strict';
import test from 'node:test';
import { getStaffStudentHome, getStudentHome } from './journey';
import {
  loadReflectionNotes,
  presentReflectionNotes,
  reflectionSlots,
  saveReflectionNote,
} from './reflectionNotes';
import { COLLECTIONS, tableFields, validateRecordFields } from './schema';
import { App } from './session';
import { Store } from './store';
import {
  getStudentPageSettings,
  normalizeStudentPages,
  saveStudentPageSettings,
} from './studentPages';
import { Doc } from './util';

const STUDENT = 'student@vsa.example.edu';
const SUPERVISOR = 'supervisor@vsa.example.edu';
const COORDINATOR = 'coordinator@vsa.example.edu';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};
  settings: Record<string, Doc> = {};
  notes: Record<string, Doc> = {};
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

  async whereEqual(name: string, field: string, value: unknown): Promise<Doc[]> {
    return (await this.list(name)).filter((row) => row[field] === value);
  }

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const row = (this.members[cohortId] || {})[email];
    return row ? { ...row } : null;
  }

  async listMembers(cohortId: string): Promise<Doc[]> {
    return Object.values(this.members[cohortId] || {}).map((row) => ({ ...row }));
  }

  async getSettings(id: string): Promise<Doc | null> {
    return this.settings[id] ? { ...this.settings[id] } : null;
  }

  async setSettings(id: string, data: Doc): Promise<void> {
    this.settings[id] = { ...data };
  }

  async listReflectionNotes(cohortId: string, email: string): Promise<Doc[]> {
    return Object.values(this.notes)
      .filter((row) => row.cohortId === cohortId && row.email === email)
      .map((row) => ({ ...row }));
  }

  async setReflectionNote(cohortId: string, email: string, noteId: string, data: Doc): Promise<void> {
    this.notes[`${cohortId}\u0000${email}\u0000${noteId}`] = { ...data, cohortId, email, noteId };
  }

  async addAudit(entry: Doc): Promise<void> {
    this.audits.push(entry);
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

async function seed(store: MemoryStore) {
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', Status: 'Active' });
  await store.set(COLLECTIONS.phases, 'writing', { phaseId: 'writing', phaseTitle: 'Writing', sequence: 1, active: true });
  await store.set(COLLECTIONS.milestoneTemplates, 'm4', {
    milestoneId: 'm4', type: 'meeting', milestoneTitle: 'First check-in', phase: 'writing', mOwner: 'supervisor', offsetDays: 5, position: 1,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'viva', {
    milestoneId: 'viva', type: 'meeting', milestoneTitle: 'Viva Voce', phase: 'writing', mOwner: 'supervisor', offsetDays: 1, position: 2,
  });
  await store.set(COLLECTIONS.studentUsers, STUDENT, { StudentId: STUDENT, DisplayName: 'Jamie Wong' });
  await store.set(COLLECTIONS.staffUsers, SUPERVISOR, {
    EMAIL: SUPERVISOR, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true, bookingLink: 'https://calendly.com/priya/ee',
  });
  await store.set(COLLECTIONS.staffUsers, COORDINATOR, {
    EMAIL: COORDINATOR, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  store.members['2026'] = {
    [STUDENT]: { StudentId: STUDENT, 'Display Name': 'Jamie Wong', supervisorId: SUPERVISOR, subject: 'English' },
  };
}

test('meeting templates and viva voce become reflection slots', () => {
  const slots = reflectionSlots([
    { milestoneId: 'm1', type: 'form', title: 'Proposal' },
    { milestoneId: 'm4', type: 'meeting', title: 'First check-in' },
    { milestoneId: 'viva', type: 'meeting', milestoneTitle: 'Viva Voce' },
  ]);
  assert.deepEqual(slots.map((slot) => slot.noteId), ['m4', 'viva']);
  assert.equal(slots[1].kind, 'viva');
  const withFallback = reflectionSlots([{ milestoneId: 'm4', type: 'meeting', title: 'First check-in' }]);
  assert.deepEqual(withFallback.map((slot) => slot.noteId), ['m4', 'viva-voce']);
  const notes = presentReflectionNotes(withFallback, [{
    noteId: 'm4', body: 'We narrowed the question.', complete: true, date: '2026-11-01', docLink: 'https://docs.google.com/document/d/abc/edit',
  }]);
  assert.equal(notes[0].complete, true);
  assert.equal(notes[0].docLink, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(notes[1].title, 'Viva Voce');
  assert.equal(notes[1].body, '');
});

test('a booking link is optional https and a blank staff sheet keeps the stored link', () => {
  assert.equal(tableFields('staffUsers').some((field) => field.name === 'bookingLink' && field.type === 'url'), true);
  validateRecordFields('staffUsers', { EMAIL: 'a@b.co', DisplayName: 'A', isStaff: true, bookingLink: '' });
  validateRecordFields('staffUsers', { EMAIL: 'a@b.co', DisplayName: 'A', isStaff: true, bookingLink: 'https://calendly.com/a/ee' });
  assert.throws(() => validateRecordFields('staffUsers', {
    EMAIL: 'a@b.co', DisplayName: 'A', isStaff: true, bookingLink: 'http://calendly.com/a',
  }), /HTTPS/);
});

test('student home binds the supervisor booking link, page flags, and saved reflections', async () => {
  const store = new MemoryStore();
  await seed(store);
  const student = appFor(store, STUDENT);
  const saved = await saveReflectionNote(student, 'm4', {
    body: 'Asked about the research question.',
    complete: true,
    date: '2026-11-01',
    docLink: 'https://docs.google.com/document/d/abc123/edit',
  });
  assert.equal(saved.noteId, 'm4');
  assert.equal(saved.complete, true);

  await assert.rejects(
    saveReflectionNote(student, 'm4', { body: 'x', docLink: 'https://example.com/notes' }),
    /Google Doc/,
  );
  await assert.rejects(saveReflectionNote(student, 'missing', { body: 'x' }), /not part of your meetings/);
  await assert.rejects(saveReflectionNote(appFor(store, COORDINATOR), 'm4', { body: 'staff' }), /Access denied/);

  const home = await getStudentHome(student);
  assert.equal(home.bookingUrl, 'https://calendly.com/priya/ee');
  assert.equal(home.studentPages.calendar, true);
  assert.equal(home.reflectionNotes.find((note) => note.noteId === 'm4')?.body, 'Asked about the research question.');
  assert.equal(home.reflectionNotes.some((note) => note.noteId === 'viva'), true);

  const staffHome = await getStaffStudentHome(appFor(store, COORDINATOR), STUDENT, '2026', 'coordinator');
  assert.equal(staffHome.bookingUrl, 'https://calendly.com/priya/ee');
  assert.equal(staffHome.reflectionNotes.find((note) => note.noteId === 'm4')?.date, '2026-11-01');
});

test('admin show and hide flags default to visible and persist on settings/studentUI', async () => {
  const store = new MemoryStore();
  await seed(store);
  assert.deepEqual(normalizeStudentPages(null), {
    document: true, journey: true, calendar: true, supervisor: true, chat: true,
  });
  assert.equal(normalizeStudentPages({ pages: { calendar: false } }).calendar, false);
  assert.equal(normalizeStudentPages({ pages: { calendar: false } }).document, true);

  const admin = appFor(store, COORDINATOR);
  const saved = await saveStudentPageSettings(admin, { pages: { calendar: false, chat: 'no' } });
  assert.equal(saved.pages.calendar, false);
  assert.equal(saved.pages.chat, false);
  assert.equal(saved.pages.journey, true);
  assert.deepEqual((await getStudentPageSettings(admin)).pages, saved.pages);
  assert.equal(store.settings.studentUI.updatedBy, COORDINATOR);

  const home = await getStudentHome(appFor(store, STUDENT));
  assert.equal(home.studentPages.calendar, false);
  assert.equal(home.studentPages.document, true);
  await assert.rejects(
    saveStudentPageSettings(admin, {
      pages: { document: false, journey: false, calendar: false, supervisor: false, chat: false },
    }),
    /at least one/,
  );
  await assert.rejects(getStudentPageSettings(appFor(store, STUDENT)), /Access denied/);

  const empty = await loadReflectionNotes(appFor(store, STUDENT), '', STUDENT, []);
  assert.equal(empty[0].noteId, 'viva-voce');
});
