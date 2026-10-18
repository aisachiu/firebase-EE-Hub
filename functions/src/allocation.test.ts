import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAllocationIngest,
  commitAllocations,
  draftAllocation,
  exportAllocationDrafts,
  getAllocationDesk,
  previewAllocationIngest,
  saveAllocationConfig,
} from './allocation';
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
  assert.equal((await app.store.listWorkspace('2026')).length, 0);

  await applyAllocationIngest(app, '2026', SHEET, 'workspace', { workbook: workbook([workspaceGrid, tokenGrid]) });
  const jane = await app.store.getWorkspace('2026', JANE);
  assert.equal(jane?.subjectChoices.choice1, 'History');
  assert.equal(jane?.dynamicData['Y10 GPA'], 'Weak');
  const config = await app.store.getAllocationConfig('2026');
  assert.equal(config?.primaryChoiceKey, 'choice1');
  assert.ok(config?.lastWorkspaceSync);

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
