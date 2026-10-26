import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTIONS } from './schema';
import { SheetGrid } from './sheetImport';
import {
  applySheetIngest,
  buildExportGrids,
  exportSheetCollections,
  listSheetCollections,
  previewSheetIngest,
  sheetTabTitle,
  SheetWorkbook,
} from './sheetSync';
import { App } from './session';
import { Doc } from './util';

const COORDINATOR = 'coordinator@vsa.edu';
const STUDENT = 'jamie.wong@vsa.edu';
const SHEET = 'https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit';

function memory() {
  const docs = new Map<string, Doc>();
  const members = new Map<string, Doc>();
  const messages = new Map<string, Doc>();
  const audits: Doc[] = [];
  const key = (name: string, id: string) => `${name}\u0000${id}`;
  return {
    audits,
    async get(name: string, id: string) { return docs.get(key(name, id)) ? { ...docs.get(key(name, id)) } : null; },
    async list(name: string) { return [...docs.keys()].filter((id) => id.startsWith(`${name}\u0000`)).map((id) => ({ ...docs.get(id)! })); },
    async set(name: string, id: string, data: Doc) { docs.set(key(name, id), { ...data }); },
    async remove(name: string, id: string) { docs.delete(key(name, id)); },
    async findBy(name: string, field: string, value: string) { return (await this.list(name)).filter((row) => String(row[field] || '') === value); },
    async getMeta() { return null; },
    async listMembers(cohortId: string) { return [...members.keys()].filter((id) => id.startsWith(`${cohortId}\u0000`)).map((id) => ({ ...members.get(id)! })); },
    async setMember(cohortId: string, id: string, data: Doc) { members.set(`${cohortId}\u0000${id}`, { ...data }); },
    async removeMember(cohortId: string, id: string) { members.delete(`${cohortId}\u0000${id}`); },
    async allMembers() {
      const cohorts = await this.list(COLLECTIONS.cohorts);
      const rows = [];
      for (const cohort of cohorts) {
        const cohortId = String(cohort.Cohort || '');
        for (const member of await this.listMembers(cohortId)) rows.push({ cohortId, member });
      }
      return rows;
    },
    async listMessages(ticketId: string) { return [...messages.keys()].filter((id) => id.startsWith(`${ticketId}\u0000`)).map((id) => ({ ...messages.get(id)! })); },
    async addMessage(ticketId: string, id: string, data: Doc) { messages.set(`${ticketId}\u0000${id}`, { ...data }); },
    async removeMessage(ticketId: string, id: string) { messages.delete(`${ticketId}\u0000${id}`); },
    async addAudit(entry: Doc) { audits.push(entry); },
  };
}

function appFor(email = COORDINATOR): App {
  return { store: memory() as unknown as App['store'], email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(app: App) {
  const store = app.store as unknown as ReturnType<typeof memory>;
  await store.set(COLLECTIONS.staffUsers, COORDINATOR, { EMAIL: COORDINATOR, DisplayName: 'Coordinator', isStaff: true, isCoordinator: true, isAdmin: true });
  await store.set(COLLECTIONS.staffUsers, 'supervisor@vsa.edu', { EMAIL: 'supervisor@vsa.edu', DisplayName: 'Supervisor', isStaff: true, isSupervisor: true });
  await store.set(COLLECTIONS.phases, 'topic', { phaseId: 'topic', phaseTitle: 'Topic', phaseDescription: 'Choose.', sequence: 1, prerequisitePhaseId: '', active: true });
  await store.set(COLLECTIONS.milestoneTemplates, 'm1', { milestoneId: 'm1', type: 'form', milestoneTitle: 'Subject preference', offsetDays: 80, milestoneDescription: 'Tell us.', phase: 'topic', mOwner: 'student', position: 1 });
  await store.set(COLLECTIONS.milestoneTemplates, 'm2', { milestoneId: 'm2', type: 'upload', milestoneTitle: 'Research question', offsetDays: 40, milestoneDescription: 'Upload.', phase: 'topic', mOwner: 'student', position: 2 });
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active', DriveRootFolderId: 'folder', FolderPrefix: 'EE ', FolderSuffix: '', EEDocTemplateId: '' });
  await store.setMember('2026', STUDENT, {
    StudentId: STUDENT, 'Display Name': 'Jamie Wong', Surname: 'Wong', 'First Name': 'Jamie', 'Student ID': '20260001', 'Student Email': STUDENT, 'Year Group': 12, supervisorId: 'supervisor@vsa.edu',
  });
  await store.set(COLLECTIONS.subjects, 'english', { 'Subject ID': 'english', Name: 'English', Active: true });
  await store.set(COLLECTIONS.formResponses, `m1__${encodeURIComponent(STUDENT)}`, { MilestoneId: 'm1', StudentId: STUDENT, FormVersion: 1, Status: 'Submitted', SubmittedAt: '2026-10-02T00:00:00.000Z', LastUpdated: '2026-10-02T00:00:00.000Z', choice1: 'English' });
  await store.set(COLLECTIONS.formResponses, `m2__${encodeURIComponent(STUDENT)}`, { MilestoneId: 'm2', StudentId: STUDENT, FormVersion: 1, Status: 'Draft', SubmittedAt: '', LastUpdated: '2026-10-03T00:00:00.000Z', choice1: 'History' });
  await store.set(COLLECTIONS.tickets, 't1', { TicketId: 't1', StudentId: STUDENT, Category: 'Subject', Title: 'Question', Status: 'Open', Route: 'supervisor', Assignee: 'supervisor@vsa.edu', CreatedAt: '2026-10-06T00:00:00.000Z', LastUpdated: '2026-10-06T00:00:00.000Z', LastActor: STUDENT });
  await store.addMessage('t1', 'keep', { MessageId: 'keep', TicketId: 't1', AuthorEmail: STUDENT, AuthorRole: 'student', Body: 'Keep this', CreatedAt: '2026-10-06T00:00:00.000Z' });
  await store.addMessage('t1', 'drop', { MessageId: 'drop', TicketId: 't1', AuthorEmail: STUDENT, AuthorRole: 'student', Body: 'Drop this', CreatedAt: '2026-10-06T01:00:00.000Z' });
}

function workbook(grids: SheetGrid[], calls?: { shared: string[]; titles: string[] }): SheetWorkbook {
  return {
    async create(_title, created) {
      if (calls) calls.titles = created.map((grid) => grid.title);
      return { spreadsheetId: 'abc123_XYZ-000000000000', url: SHEET };
    },
    async read() { return grids; },
    async share(_id, email) { if (calls) calls.shared.push(email); },
  };
}

test('sheet tab titles omit characters Google Sheets rejects', () => {
  assert.equal(sheetTabTitle('COHORT: 2026'), 'COHORT 2026');
  assert.equal(sheetTabTitle('FORM: m1'), 'FORM m1');
});

test('an admin can export milestones and ingest the edited sheet', async () => {
  const app = appFor();
  await seed(app);
  const listed = await listSheetCollections(app);
  assert.equal(listed.collections.find((item) => item.id === 'milestoneTemplates')?.recommended, true);
  assert.equal(listed.collections.find((item) => item.id === 'milestoneTemplates')?.count, 2);
  assert.equal(listed.collections.find((item) => item.id === 'auditLogs')?.exportOnly, true);

  const grids = await buildExportGrids(app, ['phases', 'milestoneTemplates', 'cohorts', 'cohortMembers', 'formResponses']);
  assert.ok(grids.every((grid) => !grid.title.includes(':')));
  const cohort = grids.find((grid) => grid.title === 'COHORTS');
  assert.ok(cohort);
  assert.equal(cohort.rows[1][cohort.rows[0].indexOf('FolderPrefix')], 'EE ');
  const milestones = grids.find((grid) => grid.title === 'MILESTONE_TEMPLATES');
  assert.ok(milestones);
  const titleIndex = milestones.rows[0].indexOf('milestoneTitle');
  milestones.rows[1][titleIndex] = 'Subject form';
  milestones.rows = milestones.rows.filter((row, index) => index === 0 || row[0] !== 'm2');
  const answers = grids.find((grid) => grid.title === 'FORM m1');
  assert.ok(answers);
  answers.rows[1][answers.rows[0].indexOf('choice1')] = 'Biology';

  const calls = { shared: [] as string[], titles: [] as string[] };
  const exported = await exportSheetCollections(app, ['milestoneTemplates'], {
    workbook: workbook(grids, calls),
    actorEmail: 'drive@vsa.edu',
    now: new Date('2026-10-16T00:00:00.000Z'),
  });
  assert.equal(exported.title, 'EE Hub export 2026-10-16');
  assert.equal(exported.shared, true);
  assert.deepEqual(calls.shared, [COORDINATOR]);
  assert.deepEqual(calls.titles, ['MILESTONE_TEMPLATES']);

  const preview = await previewSheetIngest(app, SHEET, ['milestoneTemplates', 'cohorts', 'formResponses'], { workbook: workbook(grids) });
  assert.equal(preview.tables.find((table) => table.id === 'milestoneTemplates')?.removing, 1);
  assert.equal(preview.tables.find((table) => table.id === 'cohorts')?.removing, 0);

  await applySheetIngest(app, SHEET, ['milestoneTemplates', 'cohorts', 'cohortMembers', 'formResponses'], true, { workbook: workbook(grids) });
  const saved = await app.store.get(COLLECTIONS.milestoneTemplates, 'm1');
  assert.equal(saved?.milestoneTitle, 'Subject form');
  assert.equal(saved?.position, 1);
  assert.equal(await app.store.get(COLLECTIONS.milestoneTemplates, 'm2'), null);
  assert.equal((await app.store.get(COLLECTIONS.cohorts, '2026'))?.FolderPrefix, 'EE ');
  assert.equal((await app.store.get(COLLECTIONS.subjects, 'english'))?.Name, 'English');
  assert.equal((await app.store.get(COLLECTIONS.formResponses, `m1__${encodeURIComponent(STUDENT)}`))?.choice1, 'Biology');
  assert.equal((await app.store.get(COLLECTIONS.formResponses, `m2__${encodeURIComponent(STUDENT)}`))?.choice1, 'History');
  const members = await app.store.listMembers('2026');
  assert.equal(members.length, 1);
  assert.equal(members[0]['Year Group'], 12);
});

test('a missing tab and a refused confirmation leave the hub unchanged', async () => {
  const app = appFor();
  await seed(app);
  const grids = await buildExportGrids(app, ['milestoneTemplates']);
  await assert.rejects(applySheetIngest(app, SHEET, ['subjects'], true, { workbook: workbook(grids) }), /SUBJECTS/);
  await assert.rejects(applySheetIngest(app, SHEET, ['milestoneTemplates'], false, { workbook: workbook(grids) }), /Confirm/);
  await assert.rejects(previewSheetIngest(app, SHEET, ['auditLogs'], { workbook: workbook(grids) }), /Audit logs/);
  assert.equal((await app.store.get(COLLECTIONS.subjects, 'english'))?.Name, 'English');
  assert.ok(await app.store.get(COLLECTIONS.milestoneTemplates, 'm2'));
});

test('an invalid student row and a staff sheet with no admin are not written', async () => {
  const app = appFor();
  await seed(app);
  const grids = await buildExportGrids(app, ['cohortMembers', 'staffUsers']);
  const members = grids.find((grid) => grid.title === 'COHORT 2026');
  assert.ok(members);
  members.rows[1][members.rows[0].indexOf('Year Group')] = 'twelve';
  const staff = grids.find((grid) => grid.title === 'USERS-STAFF');
  assert.ok(staff);
  staff.rows = [staff.rows[0], staff.rows.find((row) => String(row[0]).includes('supervisor')) || staff.rows[1]];
  await assert.rejects(applySheetIngest(app, SHEET, ['cohortMembers'], true, { workbook: workbook(grids) }), /Year Group/);
  await assert.rejects(applySheetIngest(app, SHEET, ['staffUsers'], true, { workbook: workbook(grids) }), /admin or coordinator/);
  assert.equal((await app.store.listMembers('2026')).length, 1);
  assert.equal((await app.store.get(COLLECTIONS.staffUsers, COORDINATOR))?.isCoordinator, true);
});

test('message replies replace only the rows in the tab, including an older colon title', async () => {
  const app = appFor();
  await seed(app);
  const grids = await buildExportGrids(app, ['ticketMessages', 'cohortMembers']);
  const replies = grids.find((grid) => grid.title === 'TICKET_MESSAGES');
  assert.ok(replies);
  replies.rows = replies.rows.filter((row, index) => index === 0 || row[0] !== 'drop');
  const roster = grids.find((grid) => grid.title === 'COHORT 2026');
  assert.ok(roster);
  roster.title = 'COHORT: 2026';
  roster.rows[1][roster.rows[0].indexOf('Surname')] = 'Wong-Smith';
  await applySheetIngest(app, SHEET, ['ticketMessages', 'cohortMembers'], true, { workbook: workbook(grids) });
  const messages = await app.store.listMessages('t1');
  assert.deepEqual(messages.map((message) => message.MessageId).sort(), ['keep']);
  assert.equal((await app.store.listMembers('2026'))[0].Surname, 'Wong-Smith');
});

test('removing a message thread also removes its replies', async () => {
  const app = appFor();
  await seed(app);
  const grids = await buildExportGrids(app, ['tickets']);
  const tickets = grids.find((grid) => grid.title === 'TICKETS');
  assert.ok(tickets);
  tickets.rows = [tickets.rows[0]];
  await applySheetIngest(app, SHEET, ['tickets'], true, { workbook: workbook(grids) });
  assert.equal(await app.store.get(COLLECTIONS.tickets, 't1'), null);
  assert.deepEqual(await app.store.listMessages('t1'), []);
});

test('roster ingest stores Student Number and copies it onto the student user', async () => {
  const app = appFor();
  await seed(app);
  const store = app.store as unknown as ReturnType<typeof memory>;
  await store.set(COLLECTIONS.studentUsers, STUDENT, {
    StudentId: STUDENT,
    DisplayName: 'Jamie Wong',
    studentEmail: STUDENT,
  });
  const grid: SheetGrid = {
    title: 'COHORT: 2026',
    rows: [
      ['StudentId', 'Display Name', 'Student ID', 'Student Email', 'Year Group', 'Surname'],
      [STUDENT, 'Jamie Wong', '20260001', 'jamie.mail@vsa.edu', 12, 'Wong'],
    ],
  };
  await applySheetIngest(app, SHEET, ['cohortMembers'], true, { workbook: workbook([grid]) });
  const member = (await store.listMembers('2026'))[0];
  assert.equal(member['Student Number'], '20260001');
  assert.equal(member['Student ID'], undefined);
  assert.equal(member['Student Email'], 'jamie.mail@vsa.edu');
  const user = await store.get(COLLECTIONS.studentUsers, STUDENT);
  assert.equal(user?.['Student Number'], '20260001');
  assert.equal(user?.['Student Email'], 'jamie.mail@vsa.edu');
  assert.equal(user?.studentEmail, undefined);
  assert.equal(user?.StudentId, STUDENT);
});

test('roster ingest keeps eeActive when the sheet has no column for it', async () => {
  const app = appFor();
  await seed(app);
  const store = app.store as unknown as ReturnType<typeof memory>;
  const member = (await store.listMembers('2026'))[0];
  member.eeActive = false;
  await store.setMember('2026', STUDENT, member);
  const grid: SheetGrid = {
    title: 'COHORT: 2026',
    rows: [
      ['StudentId', 'Display Name', 'Student ID', 'Student Email', 'Year Group', 'Surname'],
      [STUDENT, 'Jamie Wong', '20260001', STUDENT, 12, 'Wong-Li'],
    ],
  };
  await applySheetIngest(app, SHEET, ['cohortMembers'], true, { workbook: workbook([grid]) });
  const saved = (await store.listMembers('2026'))[0];
  assert.equal(saved.eeActive, false);
  assert.equal(saved.Surname, 'Wong-Li');
});

test('a supervisor cannot export collections', async () => {
  const app = appFor('supervisor@vsa.edu');
  await seed(app);
  let created = false;
  await assert.rejects(exportSheetCollections(app, ['phases'], {
    workbook: { async create() { created = true; return { spreadsheetId: 'abc123_XYZ-000000000000', url: SHEET }; }, async read() { return []; }, async share() { return; } },
    actorEmail: 'drive@vsa.edu',
  }), /Access denied/);
  assert.equal(created, false);
});
