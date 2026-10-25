import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCohortTokens,
  applyAllocationIngest,
  applyStaffQuotaTokens,
  commitAllocations,
  deleteCohortToken,
  draftAllocation,
  exportAllocationDrafts,
  exportStaffQuotaSheet,
  assignStaffSubjects,
  getAllocationDesk,
  getStaffQuotaSheet,
  previewAllocationIngest,
  previewStaffQuotaTokens,
  saveAllocationConfig,
  saveStaffQuotas,
  saveStaffSubjects,
  updateCohortToken,
} from './allocation';
import { getAdminRecords, saveAdminRecord } from './admin';
import { COLLECTIONS } from './schema';
import { SheetGrid } from './sheetImport';
import { SheetWorkbook } from './sheetSync';
import { AllocationOp } from './store';
import { App } from './session';
import { Doc } from './util';

const COORDINATOR = 'coordinator@vsa.edu';
const SMITH = 'smith@vsa.edu';
const JANE = 'jane.doe@vsa.edu';
const MARK = 'mark.lee@vsa.edu';
const SHEET = 'https://docs.google.com/spreadsheets/d/abc123_XYZ-000000000000/edit';

function memory() {
  const docs = new Map<string, Doc>();
  const members = new Map<string, Doc>();
  const tokens = new Map<string, Doc>();
  const workspace = new Map<string, Doc>();
  const config = new Map<string, Doc>();
  const audits: Doc[] = [];
  const key = (name: string, id: string) => `${name}\u0000${id}`;
  const copy = (row: Doc | undefined) => (row ? { ...row } : null);
  const store = {
    audits,
    async get(name: string, id: string) { return copy(docs.get(key(name, id))); },
    async list(name: string) { return [...docs.keys()].filter((id) => id.startsWith(`${name}\u0000`)).map((id) => ({ ...docs.get(id)! })); },
    async set(name: string, id: string, data: Doc) { docs.set(key(name, id), { ...data }); },
    async remove(name: string, id: string) { docs.delete(key(name, id)); },
    async getMeta() { return null; },
    async listMembers(cohortId: string) { return [...members.keys()].filter((id) => id.startsWith(`${cohortId}\u0000`)).map((id) => ({ ...members.get(id)! })); },
    async getMember(cohortId: string, id: string) { return copy(members.get(`${cohortId}\u0000${id}`)); },
    async setMember(cohortId: string, id: string, data: Doc) { members.set(`${cohortId}\u0000${id}`, { ...data }); },
    async listTokens(cohortId: string) { return [...tokens.keys()].filter((id) => id.startsWith(`${cohortId}\u0000`)).map((id) => ({ ...tokens.get(id)!, id: id.split('\u0000')[1] })); },
    async setToken(cohortId: string, id: string, data: Doc) { tokens.set(`${cohortId}\u0000${id}`, { ...data, id }); },
    async getToken(cohortId: string, id: string) {
      const row = tokens.get(`${cohortId}\u0000${id}`);
      return row ? { ...row, id } : null;
    },
    async removeToken(cohortId: string, id: string) { tokens.delete(`${cohortId}\u0000${id}`); },
    async listWorkspace(cohortId: string) { return [...workspace.keys()].filter((id) => id.startsWith(`${cohortId}\u0000`)).map((id) => ({ ...workspace.get(id)!, id: id.split('\u0000')[1] })); },
    async getWorkspace(cohortId: string, id: string) { return copy(workspace.get(`${cohortId}\u0000${id}`)); },
    async setWorkspace(cohortId: string, id: string, data: Doc) { workspace.set(`${cohortId}\u0000${id}`, { ...data }); },
    async getAllocationConfig(cohortId: string) { return copy(config.get(cohortId)); },
    async setAllocationConfig(cohortId: string, data: Doc) { config.set(cohortId, { ...data }); },
    async applyAllocationOps(ops: AllocationOp[]) {
      for (const op of ops) {
        if (op.kind === 'member') await store.setMember(op.cohortId, op.id, op.data);
        else if (op.kind === 'token') await store.setToken(op.cohortId, op.id, op.data);
        else if (op.kind === 'workspace') await store.setWorkspace(op.cohortId, op.id, op.data);
        else await store.setAllocationConfig(op.cohortId, op.data);
      }
    },
    async addAudit(entry: Doc) { audits.push(entry); },
  };
  return store;
}

function appFor(email = COORDINATOR): App {
  return { store: memory() as unknown as App['store'], email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(app: App) {
  const store = app.store as unknown as ReturnType<typeof memory>;
  await store.set(COLLECTIONS.staffUsers, COORDINATOR, { EMAIL: COORDINATOR, DisplayName: 'Coordinator', isStaff: true, isCoordinator: true, isAdmin: true });
  await store.set(COLLECTIONS.staffUsers, SMITH, { EMAIL: SMITH, DisplayName: 'Mr. Smith', isStaff: true, isSupervisor: true });
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active' });
  await store.setMember('2026', JANE, { StudentId: JANE, 'Display Name': 'Jane Doe', Surname: 'Doe', 'First Name': 'Jane', supervisorId: '', subject: '' });
  await store.setMember('2026', MARK, { StudentId: MARK, 'Display Name': 'Mark Lee', Surname: 'Lee', 'First Name': 'Mark', supervisorId: SMITH, subject: 'Art', eeActive: false });
}

function workbook(grids: SheetGrid[]): SheetWorkbook {
  return {
    async create() { return { spreadsheetId: 'abc123_XYZ-000000000000', url: SHEET }; },
    async read() { return grids; },
    async share() { return; },
  };
}

const workspaceGrid: SheetGrid = {
  title: 'COHORTDATA: 2026',
  rows: [
    ['StudentId', 'SubjectChoice', 'Y10 GPA', 'HL', 'Academic Flag'],
    [JANE, '{"choice1":"History","choice2":"Eng Lit"}', 'Weak', 'Bio, Chem', 'Needs Support'],
    ['missing@vsa.edu', '{"choice1":"Art"}', '', '', ''],
  ],
};

const tokenGrid: SheetGrid = {
  title: 'SUPERVISORTOKENS: 2026',
  rows: [
    ['StaffEmail', 'Quota', 'EligibleSubjects'],
    [SMITH, 2, 'History, Geography'],
  ],
};

test('a supervisor cannot open the allocation desk', async () => {
  const app = appFor(SMITH);
  await seed(app);
  await assert.rejects(getAllocationDesk(app, '2026'), /Access denied/);
});

test('ingest writes workspace rows for roster students and tops up tokens once', async () => {
  const app = appFor();
  await seed(app);
  const preview = await previewAllocationIngest(app, '2026', SHEET, 'workspace', { workbook: workbook([workspaceGrid, tokenGrid]) });
  assert.equal(preview.writing, 1);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.removing, 0);
  assert.equal(preview.rows.find((row) => row.id === JANE)?.action, 'Add');
  assert.equal(preview.rows.find((row) => row.id === 'missing@vsa.edu')?.action, 'Skip');
  assert.match(preview.note, /does not remove/);
  assert.equal((await app.store.listWorkspace('2026')).length, 0);

  await applyAllocationIngest(app, '2026', SHEET, 'workspace', { workbook: workbook([workspaceGrid, tokenGrid]) });
  const jane = await app.store.getWorkspace('2026', JANE);
  assert.equal(jane?.subjectChoices.choice1, 'History');
  assert.equal(jane?.dynamicData['Y10 GPA'], 'Weak');
  const config = await app.store.getAllocationConfig('2026');
  assert.equal(config?.primaryChoiceKey, 'choice1');
  assert.equal(config?.columns?.find((column: Doc) => column.key === 'Y10 GPA')?.sortable, true);
  assert.equal(config?.columns?.find((column: Doc) => column.key === 'Y10 GPA')?.showOnCard, true);
  assert.equal(config?.columns?.find((column: Doc) => column.key === 'Y10 GPA')?.colorScale, false);
  assert.ok(config?.lastWorkspaceSync);

  const tokenPreview = await previewAllocationIngest(app, '2026', SHEET, 'tokens', { workbook: workbook([workspaceGrid, tokenGrid]) });
  assert.equal(tokenPreview.removing, 0);
  assert.equal(tokenPreview.creating, 2);
  assert.equal(tokenPreview.rows.find((row) => row.id === SMITH)?.action, 'Add');
  assert.match(tokenPreview.note, /does not remove/);
  await applyAllocationIngest(app, '2026', SHEET, 'tokens', { workbook: workbook([workspaceGrid, tokenGrid]) });
  await applyAllocationIngest(app, '2026', SHEET, 'tokens', { workbook: workbook([workspaceGrid, tokenGrid]) });
  const tokens = await app.store.listTokens('2026');
  assert.equal(tokens.length, 2);
  assert.equal(tokens.every((token) => token.status === 'available'), true);
});

test('draft, publish, release, and publish again update the live roster', async () => {
  const app = appFor();
  await seed(app);
  await applyAllocationIngest(app, '2026', SHEET, 'workspace', { workbook: workbook([workspaceGrid]) });
  await applyAllocationIngest(app, '2026', SHEET, 'tokens', { workbook: workbook([tokenGrid]) });
  await app.store.setMember('2026', MARK, { StudentId: MARK, 'Display Name': 'Mark Lee', Surname: 'Lee', 'First Name': 'Mark', supervisorId: '', subject: '', eeActive: true });

  const first = await draftAllocation(app, '2026', JANE, SMITH, 'History');
  assert.equal(first.changed, true);
  await draftAllocation(app, '2026', MARK, SMITH, 'Geography');
  const published = await commitAllocations(app, '2026');
  assert.equal(published.published, 2);
  assert.equal((await app.store.getMember('2026', JANE))?.supervisorId, SMITH);
  assert.equal((await app.store.getMember('2026', JANE))?.subject, 'History');
  assert.equal((await app.store.listTokens('2026')).every((token) => token.status === 'committed'), true);

  await draftAllocation(app, '2026', JANE, '', '');
  const cleared = await commitAllocations(app, '2026');
  assert.equal(cleared.cleared, 1);
  assert.equal(cleared.published, 0);
  const jane = await app.store.getMember('2026', JANE);
  assert.equal(jane?.supervisorId, '');
  assert.equal(jane?.subject, '');
  await saveAllocationConfig(app, '2026', {
    supportColumn: 'Academic Flag',
    columns: [
      { key: 'Y10 GPA', showOnCard: true, filterable: false, sortable: true },
      { key: 'HL', showOnCard: true, filterable: false, sortable: false },
      { key: 'Academic Flag', showOnCard: true, filterable: true, sortable: false },
    ],
  });
  const desk = await getAllocationDesk(app, '2026');
  assert.equal(desk.students.find((student) => student.studentId === JANE)?.flags.needsSupport, true);
  assert.equal(desk.publish.drafts, 0);
});

test('export writes the allocation sheet and records the export time', async () => {
  const app = appFor();
  await seed(app);
  await applyAllocationIngest(app, '2026', SHEET, 'workspace', { workbook: workbook([workspaceGrid]) });
  let titles: string[] = [];
  const exported = await exportAllocationDrafts(app, '2026', {
    workbook: {
      async create(_title, grids) { titles = grids.map((grid) => grid.title); return { spreadsheetId: 'abc123_XYZ-000000000000', url: SHEET }; },
      async read() { return []; },
      async share() { return; },
    },
    actorEmail: COORDINATOR,
    now: new Date('2026-10-18T00:00:00.000Z'),
  });
  assert.equal(exported.title, 'EE Hub allocations 2026 2026-10-18');
  assert.deepEqual(titles, ['ALLOCATIONS 2026']);
  assert.ok((await app.store.getAllocationConfig('2026'))?.lastExport);
});

test('staff quotas top up a cohort without replacing tokens already there', async () => {
  const app = appFor();
  await seed(app);
  await app.store.set(COLLECTIONS.subjects, 'eng', { 'Subject ID': 'eng', Name: 'English', Active: true });
  await app.store.set(COLLECTIONS.subjects, 'his', { 'Subject ID': 'his', Name: 'History', Active: true });
  await saveStaffQuotas(app, [
    { email: SMITH, quota: 2, subjects: ['English', 'History'] },
    { email: COORDINATOR, quota: '', subjects: [] },
  ]);
  const saved = await app.store.get(COLLECTIONS.staffUsers, SMITH);
  assert.equal(saved?.EEQuota, 2);
  assert.deepEqual(saved?.EESubjects, ['English', 'History']);
  assert.equal(saved?.DisplayName, 'Mr. Smith');
  assert.deepEqual((await app.store.get(COLLECTIONS.staffUsers, COORDINATOR))?.EESubjects, []);

  const preview = await previewStaffQuotaTokens(app, '2026');
  assert.equal(preview.creating, 2);
  assert.equal((await app.store.listTokens('2026')).length, 0);
  await applyStaffQuotaTokens(app, '2026');
  const first = await app.store.listTokens('2026');
  assert.equal(first.length, 2);
  await draftAllocation(app, '2026', JANE, SMITH, 'English');
  await saveStaffQuotas(app, [{ email: SMITH, quota: 3, subjects: ['English'] }]);
  const again = await applyStaffQuotaTokens(app, '2026');
  assert.equal(again.creating, 1);
  const tokens = await app.store.listTokens('2026');
  assert.equal(tokens.length, 3);
  const drafted = tokens.find((token) => token.allocatedTo === JANE);
  assert.equal(drafted?.status, 'draft');
  assert.deepEqual(drafted?.eligibleSubjects, ['English', 'History']);
  const open = tokens.filter((token) => token.status === 'available');
  assert.equal(open.every((token) => token.eligibleSubjects.join(', ') === 'English'), true);

  const captured: { grid: { title: string; rows: unknown[][] } | null } = { grid: null };
  const exported = await exportStaffQuotaSheet(app, '2026', {
    workbook: {
      async create(_title, grids) { captured.grid = grids[0]; return { spreadsheetId: 'abc123_XYZ-000000000000', url: SHEET }; },
      async read() { return []; },
      async share() { return; },
    },
    actorEmail: COORDINATOR,
    now: new Date('2026-10-18T00:00:00.000Z'),
  });
  assert.equal(exported.title, 'EE Hub supervisor tokens 2026 2026-10-18');
  assert.equal(captured.grid?.title, 'SUPERVISORTOKENS 2026');
  assert.deepEqual(captured.grid?.rows[0], ['StaffEmail', 'Quota', 'EligibleSubjects']);

  const added = await addCohortTokens(app, '2026', COORDINATOR, ['English'], 1);
  assert.equal(added.created, 1);
  const extra = (await app.store.listTokens('2026')).find((token) => token.staffId === COORDINATOR);
  assert.ok(extra);
  await updateCohortToken(app, '2026', extra!.id, ['History']);
  assert.deepEqual((await app.store.getToken('2026', extra!.id))?.eligibleSubjects, ['History']);
  await deleteCohortToken(app, '2026', extra!.id);
  assert.equal(await app.store.getToken('2026', extra!.id), null);
  await commitAllocations(app, '2026');
  await assert.rejects(deleteCohortToken(app, '2026', drafted!.id), /published/);
});

test('multiple EE subjects persist on the staff record and in bulk', async () => {
  const app = appFor();
  await seed(app);
  await app.store.set(COLLECTIONS.subjects, 'eng', { 'Subject ID': 'eng', Name: 'English', Active: true });
  await app.store.set(COLLECTIONS.subjects, 'film', { 'Subject ID': 'film', Name: 'Theatre / Film', Active: true });
  await app.store.set(COLLECTIONS.subjects, 'lat', { 'Subject ID': 'lat', Name: 'Latin', Active: false });
  await app.store.set(COLLECTIONS.staffUsers, SMITH, {
    EMAIL: SMITH, DisplayName: 'Mr. Smith', isStaff: true, isSupervisor: true, EEQuota: 4, EESubjects: ['Latin'],
  });

  const legacy = await getStaffQuotaSheet(app);
  assert.deepEqual(legacy.subjects, ['English', 'Theatre / Film']);
  await app.store.set(COLLECTIONS.staffUsers, COORDINATOR, {
    EMAIL: COORDINATOR, DisplayName: 'Coordinator', isStaff: true, isCoordinator: true, isAdmin: true, EESubjects: 'English, History',
  });
  const read = await getStaffQuotaSheet(app);
  assert.deepEqual(read.staff.find((person) => person.email === COORDINATOR)?.subjects, ['English', 'History']);

  await saveStaffSubjects(app, [{ email: SMITH, subjects: ['Latin', 'Theatre / Film'] }]);
  const smith = await app.store.get(COLLECTIONS.staffUsers, SMITH);
  assert.equal(smith?.EEQuota, 4);
  assert.deepEqual(smith?.EESubjects, ['Latin', 'Theatre / Film']);
  await assert.rejects(saveStaffSubjects(app, [{ email: SMITH, subjects: ['Art'] }]), /not an active subject/);

  await assignStaffSubjects(app, [SMITH, COORDINATOR], ['English'], 'add');
  assert.deepEqual((await app.store.get(COLLECTIONS.staffUsers, SMITH))?.EESubjects, ['Latin', 'Theatre / Film', 'English']);
  await assignStaffSubjects(app, [SMITH], ['Latin'], 'remove');
  assert.deepEqual((await app.store.get(COLLECTIONS.staffUsers, SMITH))?.EESubjects, ['Theatre / Film', 'English']);

  await saveAdminRecord(app, 'staffUsers', {
    EMAIL: 'new.teacher@vsa.edu',
    DisplayName: 'New Teacher',
    isSupervisor: true,
    EESubjects: ['english', 'Theatre / Film'],
  }, '');
  const created = await app.store.get(COLLECTIONS.staffUsers, 'new.teacher@vsa.edu');
  assert.deepEqual(created?.EESubjects, ['English', 'Theatre / Film']);
  const admin = await getAdminRecords(app, 'staffUsers');
  const field = admin.schema.fields.find((item) => item.name === 'EESubjects');
  assert.equal(field?.type, 'checks');
  assert.deepEqual(field?.options, [
    { value: 'English', label: 'English' },
    { value: 'Theatre / Film', label: 'Theatre / Film' },
  ]);
});
