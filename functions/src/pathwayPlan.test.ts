import assert from 'node:assert/strict';
import test from 'node:test';
import { saveAdminRecord, setMilestoneAnchor } from './admin';
import { assertSingleMilestoneAnchor, reanchorMilestones } from './pathwayPlan';
import { COLLECTIONS, normalizePhaseColor } from './schema';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const coordinatorEmail = 'coordinator@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};

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

  async addAudit(): Promise<void> {}
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'UTC' };
}

function milestone(id: string, offsetDays: number, isAnchor = false) {
  return {
    milestoneId: id,
    type: 'form',
    milestoneTitle: id,
    offsetDays,
    milestoneDescription: '',
    phase: 'topic',
    mOwner: 'student',
    position: Number(id.replace(/\D/g, '')) || 1,
    isAnchor,
  };
}

async function seed(store: MemoryStore) {
  await store.set(COLLECTIONS.staffUsers, coordinatorEmail, {
    EMAIL: coordinatorEmail, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set(COLLECTIONS.staffUsers, supervisorEmail, {
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set(COLLECTIONS.phases, 'topic', {
    phaseId: 'topic', phaseTitle: 'Topic', phaseDescription: '', sequence: 1, prerequisitePhaseId: '', active: true,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'm1', milestone('m1', 80, false));
  await store.set(COLLECTIONS.milestoneTemplates, 'm2', milestone('m2', 40, false));
  await store.set(COLLECTIONS.milestoneTemplates, 'm3', milestone('m3', 0, true));
}

test('adjusting the anchor keeps relative dates and releases the previous anchor', () => {
  const result = reanchorMilestones([
    milestone('m1', 80, false),
    milestone('m2', 40, false),
    milestone('m3', 0, true),
  ], 'm2', 'adjust');
  assert.equal(result.deltaDays, 40);
  const byId = Object.fromEntries(result.milestones.map((row) => [row.milestoneId, row]));
  assert.equal(byId.m2.offsetDays, 0);
  assert.equal(byId.m2.isAnchor, true);
  assert.equal(byId.m1.offsetDays, 40);
  assert.equal(byId.m1.isAnchor, false);
  assert.equal(byId.m3.offsetDays, -40);
  assert.equal(byId.m3.isAnchor, false);
});

test('moving onto the existing anchor date leaves other offsets alone', () => {
  const result = reanchorMilestones([
    milestone('m1', 80, false),
    milestone('m2', 40, false),
    milestone('m3', 0, true),
  ], 'm2', 'move');
  assert.equal(result.deltaDays, 0);
  const byId = Object.fromEntries(result.milestones.map((row) => [row.milestoneId, row]));
  assert.equal(byId.m2.offsetDays, 0);
  assert.equal(byId.m2.isAnchor, true);
  assert.equal(byId.m1.offsetDays, 80);
  assert.equal(byId.m1.isAnchor, false);
  assert.equal(byId.m3.offsetDays, 0);
  assert.equal(byId.m3.isAnchor, false);
});

test('releasing an anchor keeps days before anchor', () => {
  const result = reanchorMilestones([milestone('m3', 0, true), milestone('m1', 80, false)], 'm3', 'release');
  const byId = Object.fromEntries(result.milestones.map((row) => [row.milestoneId, row]));
  assert.equal(byId.m3.isAnchor, false);
  assert.equal(byId.m3.offsetDays, 0);
  assert.equal(byId.m1.offsetDays, 80);
  assert.equal(byId.m1.isAnchor, false);
});

test('two stored anchors are rejected', () => {
  assert.throws(() => assertSingleMilestoneAnchor([
    { isAnchor: true },
    { isAnchor: true },
  ]), /Only one milestone/);
  assert.doesNotThrow(() => assertSingleMilestoneAnchor([{ isAnchor: true }, { isAnchor: false }]));
});

test('a coordinator can set one anchor and a phase colour', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, coordinatorEmail);
  const adjusted = await setMilestoneAnchor(app, 'm1', 'adjust');
  assert.equal(adjusted.deltaDays, 80);
  const rows = await store.list(COLLECTIONS.milestoneTemplates);
  const anchors = rows.filter((row) => row.isAnchor);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].milestoneId, 'm1');
  assert.equal(anchors[0].offsetDays, 0);
  const research = rows.find((row) => row.milestoneId === 'm2');
  assert.equal(research && research.offsetDays, -40);
  assert.equal(research && research.isAnchor, false);

  const moved = await setMilestoneAnchor(app, 'm2', 'move');
  assert.equal(moved.deltaDays, 0);
  const afterMove = await store.list(COLLECTIONS.milestoneTemplates);
  assert.deepEqual(afterMove.filter((row) => row.isAnchor).map((row) => row.milestoneId), ['m2']);
  assert.equal(afterMove.find((row) => row.milestoneId === 'm2')?.offsetDays, 0);
  assert.equal(afterMove.find((row) => row.milestoneId === 'm1')?.offsetDays, 0);
  assert.equal(afterMove.find((row) => row.milestoneId === 'm1')?.isAnchor, false);

  await setMilestoneAnchor(app, 'm2', 'release');
  const released = await store.list(COLLECTIONS.milestoneTemplates);
  assert.equal(released.some((row) => row.isAnchor), false);
  assert.equal(released.find((row) => row.milestoneId === 'm2')?.offsetDays, 0);

  await saveAdminRecord(app, 'phases', {
    phaseId: 'topic',
    phaseTitle: 'Topic',
    phaseDescription: '',
    sequence: 1,
    prerequisitePhaseId: '',
    active: true,
    phaseColor: '#0E8A6A',
  }, 'topic');
  assert.equal((await store.get(COLLECTIONS.phases, 'topic'))?.phaseColor, '#0e8a6a');
  await assert.rejects(saveAdminRecord(app, 'phases', {
    phaseId: 'topic',
    phaseTitle: 'Topic',
    phaseDescription: '',
    sequence: 1,
    prerequisitePhaseId: '',
    active: true,
    phaseColor: 'green',
  }, 'topic'), /hex colour/);
  assert.equal(normalizePhaseColor(''), '');
});

test('saving a second anchor releases the previous one', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, coordinatorEmail);
  await saveAdminRecord(app, 'milestoneTemplates', {
    ...milestone('m2', 40, true),
  }, 'm2');
  const rows = await store.list(COLLECTIONS.milestoneTemplates);
  assert.deepEqual(rows.filter((row) => row.isAnchor).map((row) => row.milestoneId), ['m2']);
  assert.equal(rows.find((row) => row.milestoneId === 'm3')?.offsetDays, 0);
});

test('supervisors cannot change the anchor', async () => {
  const store = new MemoryStore();
  await seed(store);
  await assert.rejects(setMilestoneAnchor(appFor(store, supervisorEmail), 'm2', 'move'), /Access denied/);
  await assert.rejects(setMilestoneAnchor(appFor(store, coordinatorEmail), 'missing', 'adjust'), /Milestone not found/);
  await assert.rejects(setMilestoneAnchor(appFor(store, coordinatorEmail), 'm2', 'swap'), /existing anchor date/);
  const anchor = await store.get(COLLECTIONS.milestoneTemplates, 'm3');
  assert.equal(anchor && anchor.isAnchor, true);
});
