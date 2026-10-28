import assert from 'node:assert/strict';
import test from 'node:test';
import { clearCohortWorkspaceLinks } from './admin';
import { dispatch } from './dispatch';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Doc } from './util';

const COORDINATOR = 'coordinator@vsa.edu';
const SUPERVISOR = 'supervisor@vsa.edu';
const JANE = 'jane.doe@vsa.edu';
const MARK = 'mark.lee@vsa.edu';
const JANE_FOLDER = 'https://drive.google.com/drive/folders/folder-jane';
const JANE_DOC = 'https://docs.google.com/document/d/doc-jane/edit';
const MARK_FOLDER = 'https://drive.google.com/drive/folders/folder-mark';
const MARK_DOC = 'https://docs.google.com/document/d/doc-mark/edit';

function memory() {
  const docs = new Map<string, Doc>();
  const members = new Map<string, Doc>();
  const key = (name: string, id: string) => `${name}\u0000${id}`;
  const copy = (row: Doc | undefined) => (row ? { ...row } : null);
  return {
    async get(name: string, id: string) { return copy(docs.get(key(name, id))); },
    async list(name: string) {
      return [...docs.keys()].filter((id) => id.startsWith(`${name}\u0000`)).map((id) => ({ ...docs.get(id)! }));
    },
    async set(name: string, id: string, data: Doc) { docs.set(key(name, id), { ...data }); },
    async getMeta() { return null; },
    async addAudit() {},
    async listMembers(cohortId: string) {
      return [...members.keys()].filter((id) => id.startsWith(`${cohortId}\u0000`)).map((id) => ({ ...members.get(id)! }));
    },
    async getMember(cohortId: string, id: string) { return copy(members.get(`${cohortId}\u0000${id}`)); },
    async setMember(cohortId: string, id: string, data: Doc) { members.set(`${cohortId}\u0000${id}`, { ...data }); },
  };
}

function appFor(email = COORDINATOR): App {
  return { store: memory() as unknown as App['store'], email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(app: App) {
  const store = app.store as unknown as ReturnType<typeof memory>;
  await store.set(COLLECTIONS.staffUsers, COORDINATOR, { EMAIL: COORDINATOR, DisplayName: 'Coordinator', isStaff: true, isCoordinator: true, isAdmin: true });
  await store.set(COLLECTIONS.staffUsers, SUPERVISOR, { EMAIL: SUPERVISOR, DisplayName: 'Supervisor', isStaff: true, isSupervisor: true });
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active' });
  await store.setMember('2026', JANE, {
    StudentId: JANE,
    'Display Name': 'Jane Doe',
    subject: 'Biology',
    EEFolder: JANE_FOLDER,
    EEDoc: JANE_DOC,
    RPPFDoc: 'https://docs.google.com/document/d/rppf-jane/edit',
  });
  await store.setMember('2026', MARK, {
    StudentId: MARK,
    'Display Name': 'Mark Lee',
    subject: 'Art',
    EEFolder: MARK_FOLDER,
    EEDoc: MARK_DOC,
  });
  return store;
}

test('clearing workspace links blanks only the selected students folder and doc', async () => {
  const app = appFor();
  const store = await seed(app);
  const result = await clearCohortWorkspaceLinks(app, '2026', [JANE]);
  assert.equal(result.cleared, 1);
  const jane = await store.getMember('2026', JANE);
  assert.equal(jane?.EEFolder, '');
  assert.equal(jane?.EEDoc, '');
  assert.equal(jane?.subject, 'Biology');
  assert.equal(jane?.RPPFDoc, 'https://docs.google.com/document/d/rppf-jane/edit');
  assert.equal(jane?.['Display Name'], 'Jane Doe');
  const mark = await store.getMember('2026', MARK);
  assert.equal(mark?.EEFolder, MARK_FOLDER);
  assert.equal(mark?.EEDoc, MARK_DOC);
  assert.equal(mark?.subject, 'Art');
});

test('dispatch routes the clear workspace action', async () => {
  const app = appFor();
  await seed(app);
  const result = await dispatch(app, 'clearCohortWorkspaceLinks', ['2026', [MARK]]) as { cleared: number };
  assert.equal(result.cleared, 1);
  const mark = await (app.store as unknown as ReturnType<typeof memory>).getMember('2026', MARK);
  assert.equal(mark?.EEFolder, '');
  assert.equal(mark?.EEDoc, '');
});

test('clearing workspace links rejects an empty selection, duplicates, unknown students, and non-admins', async () => {
  const app = appFor();
  const store = await seed(app);
  await assert.rejects(() => clearCohortWorkspaceLinks(app, '2026', []), /Select at least one student/);
  await assert.rejects(() => clearCohortWorkspaceLinks(app, '2026', [JANE, JANE]), /selected more than once/);
  await assert.rejects(() => clearCohortWorkspaceLinks(app, '2026', ['missing@vsa.edu']), /not in this cohort/);
  assert.equal((await store.getMember('2026', JANE))?.EEFolder, JANE_FOLDER);
  const supervisor = appFor(SUPERVISOR);
  await seed(supervisor);
  await assert.rejects(() => clearCohortWorkspaceLinks(supervisor, '2026', [JANE]), /Access denied/);
});
