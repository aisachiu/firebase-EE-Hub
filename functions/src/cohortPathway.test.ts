import assert from 'node:assert/strict';
import test from 'node:test';
import { assignMilestonesToStudents } from './actions';
import {
  deleteCohortMilestone,
  getPathwayPlan,
  saveCohortMilestone,
  saveCohortPlanAnchor,
  seedCohortPathway,
} from './cohortPathway';
import { getStaffHome } from './journey';
import { planSweep } from './notificationsPure';
import { HubUser } from './permissions';
import { readPhases, readTemplates } from './roster';
import { COLLECTIONS } from './schema';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const coordinator: HubUser = {
  email: 'coordinator@vsa.example.edu',
  displayName: 'Alex',
  role: 'staff',
  permissions: { isStaff: true, isSupervisor: false, isLead: false, isCoordinator: true, isAdmin: true, canAdmin: true },
};
const student: HubUser = { email: 'student@vsa.example.edu', displayName: 'Jamie', role: 'student' };

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};
  phases: Record<string, Record<string, Doc>> = {};
  milestones: Record<string, Record<string, Doc>> = {};

  async list(name: string): Promise<Doc[]> {
    return Object.values(this.docs[name] || {}).map((row) => ({ ...row }));
  }

  async get(name: string, id: string): Promise<Doc | null> {
    const row = (this.docs[name] || {})[id];
    return row ? { ...row } : null;
  }

  async set(name: string, id: string, data: Doc): Promise<void> {
    (this.docs[name] ||= {})[id] = { ...data };
  }

  async remove(name: string, id: string): Promise<void> {
    delete (this.docs[name] || {})[id];
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

  async setMember(cohortId: string, email: string, data: Doc): Promise<void> {
    (this.members[cohortId] ||= {})[email] = { ...data };
  }

  async listCohortPhases(cohortId: string): Promise<Doc[]> {
    return Object.values(this.phases[cohortId] || {}).map((row) => ({ ...row }));
  }

  async getCohortPhase(cohortId: string, phaseId: string): Promise<Doc | null> {
    const row = (this.phases[cohortId] || {})[phaseId];
    return row ? { ...row } : null;
  }

  async setCohortPhase(cohortId: string, phaseId: string, data: Doc): Promise<void> {
    (this.phases[cohortId] ||= {})[phaseId] = { ...data };
  }

  async removeCohortPhase(cohortId: string, phaseId: string): Promise<void> {
    delete (this.phases[cohortId] || {})[phaseId];
  }

  async listCohortMilestones(cohortId: string): Promise<Doc[]> {
    return Object.values(this.milestones[cohortId] || {}).map((row) => ({ ...row }));
  }

  async getCohortMilestone(cohortId: string, milestoneId: string): Promise<Doc | null> {
    const row = (this.milestones[cohortId] || {})[milestoneId];
    return row ? { ...row } : null;
  }

  async setCohortMilestone(cohortId: string, milestoneId: string, data: Doc): Promise<void> {
    (this.milestones[cohortId] ||= {})[milestoneId] = { ...data };
  }

  async removeCohortMilestone(cohortId: string, milestoneId: string): Promise<void> {
    delete (this.milestones[cohortId] || {})[milestoneId];
  }

  async addAudit(): Promise<void> {}
}

function appFor(store: MemoryStore, user: HubUser): App {
  return { store: store as unknown as Store, email: user.email, timeZone: 'UTC', user, userLoaded: true };
}

async function seedTemplate(store: MemoryStore) {
  await store.set(COLLECTIONS.cohorts, '2026', { Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active' });
  await store.set(COLLECTIONS.cohorts, '2027', { Cohort: '2027', SheetName: 'COHORT: 2027', Status: 'Active' });
  await store.set(COLLECTIONS.phases, 'topic', {
    phaseId: 'topic', phaseTitle: 'Topic', phaseDescription: 'Choose.', sequence: 1, prerequisitePhaseId: '', active: true,
  });
  await store.set(COLLECTIONS.phases, 'research', {
    phaseId: 'research', phaseTitle: 'Research', phaseDescription: 'Read.', sequence: 2, prerequisitePhaseId: 'topic', active: true,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'm1', {
    milestoneId: 'm1', type: 'form', milestoneTitle: 'Subject preference', offsetDays: 80, milestoneDescription: 'Tell us.', phase: 'topic', mOwner: 'student', position: 1,
  });
  await store.set(COLLECTIONS.milestoneTemplates, 'anchor', {
    milestoneId: 'anchor', type: 'upload', milestoneTitle: 'Final essay', offsetDays: 0, milestoneDescription: 'Hand in.', phase: 'research', mOwner: 'student', position: 2,
  });
  await store.setMember('2026', student.email, {
    StudentId: student.email, 'Display Name': 'Jamie', 'Student Email': student.email, 'Year Group': 12, Anchor_Date: '',
  });
  await store.setMember('2027', student.email, {
    StudentId: student.email, 'Display Name': 'Jamie', 'Student Email': student.email, 'Year Group': 12, Anchor_Date: '',
  });
}

test('a cohort without its own set still reads the template', async () => {
  const store = new MemoryStore();
  await seedTemplate(store);
  const phases = await readPhases(appFor(store, coordinator), '2027');
  const templates = await readTemplates(appFor(store, coordinator), '2027');
  assert.deepEqual(phases.map((phase) => phase.phaseId), ['topic', 'research']);
  assert.equal(templates.find((item) => item.milestoneId === 'm1')?.offsetDays, 80);
});

test('seeding a cohort copies the template onto a new anchor and leaves the template alone', async () => {
  const store = new MemoryStore();
  await seedTemplate(store);
  const app = appFor(store, coordinator);
  const before = await getPathwayPlan(app, { mode: 'cohort', cohortId: '2027' });
  assert.equal(before.seeded, false);
  assert.equal(before.milestones.records.length, 0);
  const seeded = await seedCohortPathway(app, '2027', { kind: 'template' }, '2027-12-01');
  assert.equal(seeded.anchorDate, '2027-12-01');
  assert.equal(seeded.milestones, 2);
  const plan = await getPathwayPlan(app, { mode: 'cohort', cohortId: '2027' });
  assert.equal(plan.seeded, true);
  assert.equal(plan.anchorDate, '2027-12-01');
  assert.equal(plan.milestones.records.find((row) => row.milestoneId === 'anchor')?.offsetDays, 0);
  assert.equal(plan.milestones.records.find((row) => row.milestoneId === 'm1')?.offsetDays, 80);
  assert.equal((await store.get(COLLECTIONS.milestoneTemplates, 'm1'))?.offsetDays, 80);
  assert.equal(toFlag(await store.get(COLLECTIONS.cohorts, '2026'), 'PathwaySeeded'), false);
  await assert.rejects(seedCohortPathway(app, '2027', { kind: 'template' }, '2028-01-01'), /already has phases/);
  await assert.rejects(seedCohortPathway(appFor(store, student), '2026', { kind: 'template' }, '2026-12-01'), /Access denied/);
});

test('a cohort edit does not change the template or another cohort', async () => {
  const store = new MemoryStore();
  await seedTemplate(store);
  const app = appFor(store, coordinator);
  await seedCohortPathway(app, '2026', { kind: 'template' }, '2026-11-15');
  await seedCohortPathway(app, '2027', { kind: 'cohort', cohortId: '2026' }, '2027-12-01');
  const milestone = await store.getCohortMilestone('2027', 'm1');
  await saveCohortMilestone(app, '2027', { ...milestone, offsetDays: 10, milestoneTitle: 'Question 2027' }, 'm1');
  await saveCohortPlanAnchor(app, '2027', '2027-12-20');
  assert.equal((await store.getCohortMilestone('2027', 'm1'))?.offsetDays, 10);
  assert.equal((await store.getCohortMilestone('2027', 'm1'))?.milestoneTitle, 'Question 2027');
  assert.equal((await store.getCohortMilestone('2026', 'm1'))?.offsetDays, 80);
  assert.equal((await store.getCohortMilestone('2026', 'm1'))?.milestoneTitle, 'Subject preference');
  assert.equal((await store.get(COLLECTIONS.milestoneTemplates, 'm1'))?.milestoneTitle, 'Subject preference');
  assert.equal((await store.get(COLLECTIONS.cohorts, '2027'))?.PlanAnchor, '2027-12-20');
  assert.equal((await store.get(COLLECTIONS.cohorts, '2026'))?.PlanAnchor, '2026-11-15');
  const home = await getStaffHome(app, '2027', 'coordinator');
  assert.equal(home.templates.find((item) => item.milestoneId === 'm1')?.title, 'Question 2027');
  assert.equal((await readTemplates(app, '2026')).find((item) => item.milestoneId === 'm1')?.title, 'Subject preference');
  await store.set(COLLECTIONS.milestoneTemplates, 'm1', { ...(await store.get(COLLECTIONS.milestoneTemplates, 'm1')), milestoneTitle: 'Template question', offsetDays: 70 });
  assert.equal((await readTemplates(app, '2027')).find((item) => item.milestoneId === 'm1')?.offsetDays, 10);
  assert.equal((await readTemplates(app)).find((item) => item.milestoneId === 'm1')?.offsetDays, 70);
});

test('assigning milestones uses the cohort set when one exists', async () => {
  const store = new MemoryStore();
  await seedTemplate(store);
  const app = appFor(store, coordinator);
  await seedCohortPathway(app, '2027', { kind: 'template' }, '2027-12-01');
  await saveCohortMilestone(app, '2027', { ...(await store.getCohortMilestone('2027', 'm1')), offsetDays: 12 }, 'm1');
  const assigned = await assignMilestonesToStudents(app, '2027', [student.email], '2027-06-01');
  assert.equal(assigned.createdTasks, 2);
  const items = await store.list(COLLECTIONS.studentActionItems);
  const question = items.find((item) => item.TemplateId === 'm1');
  const anchor = items.find((item) => item.TemplateId === 'anchor');
  assert.equal(String(question?.DueDate).slice(0, 10), '2027-05-20');
  assert.equal(String(anchor?.DueDate).slice(0, 10), '2027-06-01');
  await assert.rejects(deleteCohortMilestone(app, '2027', 'm1'), /assigned action items/);
  await assert.rejects(deleteCohortMilestone(app, '2026', 'm1'), /Create this cohort/);
});

test('notification planning uses the cohort milestone owner', () => {
  const plan = planSweep({
    today: '2026-10-15',
    tasks: [{ taskId: 'task-1', studentId: student.email, templateId: 'm1', dueDate: '2026-10-15', status: 'Pending', creatorType: 'System', title: 'Question' }],
    students: [{ cohortId: '2027', email: student.email, displayName: 'Jamie', supervisorId: 'supervisor@vsa.example.edu' }],
    templates: [
      { milestoneId: 'm1', title: 'Template question', mOwner: 'student' },
      { cohortId: '2027', milestoneId: 'm1', title: 'Cohort question', mOwner: 'supervisor' },
    ],
    cohortSets: ['2027'],
    staff: [{ email: 'supervisor@vsa.example.edu', isStaff: true, isLead: false, isCoordinator: false, isAdmin: false }],
    rules: [{
      ruleId: 'rule-1', kind: 'cohort', cohortId: '2027', milestoneId: 'm1', supervisorId: '', studentId: '',
      when: 'on', days: 0, audience: 'owner', enabled: true, note: '',
    }],
  });
  assert.equal(plan.sends.length, 1);
  assert.equal(plan.sends[0].milestoneTitle, 'Cohort question');
  assert.deepEqual(plan.sends[0].recipients, ['supervisor@vsa.example.edu']);
});

test('the template plan stays separate from cohort calendars', async () => {
  const store = new MemoryStore();
  await seedTemplate(store);
  const app = appFor(store, coordinator);
  await seedCohortPathway(app, '2026', { kind: 'template' }, '2026-12-15');
  const template = await getPathwayPlan(app, { mode: 'template' });
  assert.equal(template.mode, 'template');
  assert.equal(template.milestones.records.length, 2);
  assert.equal(template.phases.records.length, 2);
  const cohort = await getPathwayPlan(app, { mode: 'cohort', cohortId: '2027' });
  assert.equal(cohort.seeded, false);
  assert.equal(cohort.sources.some((source) => source.kind === 'template'), true);
  assert.equal(cohort.sources.some((source) => source.id === '2026'), true);
});

function toFlag(record: Doc | null, field: string) {
  return !!(record && record[field]);
}
