import { validatePhasePrerequisites } from './phaseRules';
import { milestoneDocsFor, phaseDocsFor, requireCohort } from './roster';
import { COLLECTIONS, validateRecordFields } from './schema';
import { App, audited, requireAdmin } from './session';
import { Doc, HubError, normalizeEmail, parseActionDate, serializeDateOnly, text, toBoolean } from './util';

const PLAN_ANCHOR = 'PlanAnchor';
const PLAN_SEEDED = 'PathwaySeeded';

export interface PathwaySource {
  kind: 'template' | 'cohort';
  cohortId?: string;
}

function sortPhases(records: Doc[]) {
  return records.slice().sort((left, right) => Number(left.sequence) - Number(right.sequence) || text(left.phaseId).localeCompare(text(right.phaseId)));
}

function sortMilestones(records: Doc[]) {
  return records.slice().sort((left, right) => Number(left.position || 0) - Number(right.position || 0) || text(left.milestoneId).localeCompare(text(right.milestoneId)));
}

async function cohortRecord(app: App, cohortId: string): Promise<Doc> {
  const cohort = await requireCohort(app, cohortId, true);
  const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
  if (!record) throw new HubError('Cohort not found or inactive.');
  return record;
}

function assertSeededStore(app: App) {
  if (typeof app.store.listCohortPhases !== 'function' || typeof app.store.listCohortMilestones !== 'function') {
    throw new HubError('Cohort phases and milestones are not available.');
  }
}

export async function cohortPlanSummary(app: App) {
  const records = await app.store.list(COLLECTIONS.cohorts);
  return records
    .map((record) => ({
      id: text(record.Cohort),
      name: text(record.Cohort),
      status: text(record.Status) || 'Active',
      seeded: toBoolean(record[PLAN_SEEDED]),
      anchorDate: text(record[PLAN_ANCHOR]).slice(0, 10),
    }))
    .filter((cohort) => cohort.id)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sourcesFor(cohorts: { id: string; seeded: boolean }[], cohortId: string) {
  const sources: { kind: string; id: string; label: string }[] = [{ kind: 'template', id: 'template', label: 'Template' }];
  cohorts.filter((cohort) => cohort.seeded && cohort.id !== cohortId).forEach((cohort) => {
    sources.push({ kind: 'cohort', id: cohort.id, label: `Cohort ${cohort.id}` });
  });
  return sources;
}

export async function getPathwayPlan(app: App, scope?: unknown) {
  await requireAdmin(app, 'VIEW_PATHWAY');
  const requested = scope && typeof scope === 'object' ? scope as Doc : {};
  const mode = text(requested.mode) === 'template' ? 'template' : 'cohort';
  const cohorts = await cohortPlanSummary(app);
  if (mode === 'template') {
    const phases = sortPhases(await app.store.list(COLLECTIONS.phases));
    const milestones = sortMilestones(await app.store.list(COLLECTIONS.milestoneTemplates));
    return { mode, cohortId: '', seeded: false, anchorDate: '', cohorts, sources: sourcesFor(cohorts, ''), phases: { records: phases }, milestones: { records: milestones } };
  }
  let cohortId = text(requested.cohortId);
  if (!cohorts.some((cohort) => cohort.id === cohortId)) {
    cohortId = cohorts.find((cohort) => cohort.status.toLowerCase() !== 'inactive')?.id || cohorts[0]?.id || '';
  }
  const selected = cohorts.find((cohort) => cohort.id === cohortId);
  if (!selected) {
    return { mode, cohortId: '', seeded: false, anchorDate: '', cohorts, sources: sourcesFor(cohorts, ''), phases: { records: [] }, milestones: { records: [] } };
  }
  const phases = selected.seeded ? sortPhases(await phaseDocsFor(app, cohortId)) : [];
  const milestones = selected.seeded ? sortMilestones(await milestoneDocsFor(app, cohortId)) : [];
  return {
    mode,
    cohortId,
    seeded: selected.seeded,
    anchorDate: selected.anchorDate,
    cohorts,
    sources: sourcesFor(cohorts, cohortId),
    phases: { records: phases },
    milestones: { records: milestones },
  };
}

async function writePlanFlag(app: App, cohortId: string, anchorDate?: string) {
  const existing = await cohortRecord(app, cohortId);
  const next: Doc = { ...existing, [PLAN_SEEDED]: true };
  if (anchorDate) next[PLAN_ANCHOR] = anchorDate;
  await app.store.set(COLLECTIONS.cohorts, cohortId, next);
}

function normalizePhase(values: Doc, keyName: string, existing: Doc[]) {
  const phase = { ...values };
  const original = text(keyName).toLowerCase();
  phase.phaseId = text(phase.phaseId).toLowerCase();
  phase.prerequisitePhaseId = text(phase.prerequisitePhaseId).toLowerCase();
  if (phase.sequence !== '' && phase.sequence !== undefined && phase.sequence !== null) phase.sequence = Number(phase.sequence);
  phase.active = phase.active === undefined || phase.active === '' ? true : toBoolean(phase.active);
  validateRecordFields('phases', phase, original);
  const links = existing.map((item) => ({ phaseId: text(item.phaseId).toLowerCase(), prerequisitePhaseId: text(item.prerequisitePhaseId).toLowerCase() }));
  validatePhasePrerequisites(links, phase.phaseId, phase.prerequisitePhaseId, original);
  return phase;
}

function normalizeMilestone(values: Doc, keyName: string, phases: Doc[]) {
  const milestone = { ...values };
  milestone.type = text(milestone.type).toLowerCase();
  milestone.mOwner = text(milestone.mOwner).toLowerCase();
  milestone.phase = text(milestone.phase).toLowerCase();
  milestone.offsetDays = Number(milestone.offsetDays) || 0;
  validateRecordFields('milestoneTemplates', milestone, keyName);
  const phase = phases.find((item) => text(item.phaseId).toLowerCase() === milestone.phase);
  if (!phase || !toBoolean(phase.active)) throw new HubError('Choose an active phase before saving this milestone.');
  return milestone;
}

async function requireSeededCohort(app: App, cohortId: unknown) {
  assertSeededStore(app);
  const id = text(cohortId);
  await cohortRecord(app, id);
  const record = await app.store.get(COLLECTIONS.cohorts, id);
  if (!record || !toBoolean(record[PLAN_SEEDED])) throw new HubError('Create this cohort’s milestones before editing them.');
  return id;
}

export async function saveCohortPhase(app: App, cohortId: unknown, record: Doc, originalKey: unknown) {
  const user = await requireAdmin(app, 'SAVE_COHORT_PHASE');
  const id = await requireSeededCohort(app, cohortId);
  const keyName = text(originalKey);
  const existing = await app.store.listCohortPhases(id);
  const values = normalizePhase({ ...(record || {}) }, keyName, existing);
  return audited(app, user, keyName ? 'UPDATE_COHORT_PHASE' : 'CREATE_COHORT_PHASE', { cohortId: id, phaseId: values.phaseId }, async () => {
    const current = keyName ? await app.store.getCohortPhase(id, keyName) : null;
    if (keyName && !current) throw new HubError('Record no longer exists. Refresh and try again.');
    if (!keyName && await app.store.getCohortPhase(id, values.phaseId)) throw new HubError('A record with this phaseId already exists.');
    await app.store.setCohortPhase(id, values.phaseId, current ? { ...current, ...values } : values);
    return { key: values.phaseId };
  });
}

export async function deleteCohortPhase(app: App, cohortId: unknown, phaseId: unknown) {
  const user = await requireAdmin(app, 'DELETE_COHORT_PHASE');
  const id = await requireSeededCohort(app, cohortId);
  const key = text(phaseId).toLowerCase();
  if (!key) throw new HubError('A record key is required.');
  return audited(app, user, 'DELETE_COHORT_PHASE', { cohortId: id, phaseId: key }, async () => {
    const existing = await app.store.getCohortPhase(id, key);
    if (!existing) throw new HubError('Record not found.');
    const milestones = await app.store.listCohortMilestones(id);
    if (milestones.some((milestone) => text(milestone.phase) === key)) throw new HubError('Move or delete this phase’s milestones before deleting the phase.');
    const phases = await app.store.listCohortPhases(id);
    if (phases.some((phase) => text(phase.phaseId) !== key && text(phase.prerequisitePhaseId) === key)) {
      throw new HubError('Update dependent phases before deleting this phase.');
    }
    await app.store.removeCohortPhase(id, key);
    return { deleted: true };
  });
}

export async function saveCohortMilestone(app: App, cohortId: unknown, record: Doc, originalKey: unknown) {
  const user = await requireAdmin(app, 'SAVE_COHORT_MILESTONE');
  const id = await requireSeededCohort(app, cohortId);
  const keyName = text(originalKey);
  const phases = await app.store.listCohortPhases(id);
  const values = normalizeMilestone({ ...(record || {}) }, keyName, phases);
  return audited(app, user, keyName ? 'UPDATE_COHORT_MILESTONE' : 'CREATE_COHORT_MILESTONE', { cohortId: id, milestoneId: values.milestoneId }, async () => {
    const current = keyName ? await app.store.getCohortMilestone(id, keyName) : null;
    if (keyName && !current) throw new HubError('Record no longer exists. Refresh and try again.');
    if (!keyName && await app.store.getCohortMilestone(id, values.milestoneId)) throw new HubError('A record with this milestoneId already exists.');
    if (!current) {
      const all = await app.store.listCohortMilestones(id);
      values.position = all.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0) + 1;
    }
    await app.store.setCohortMilestone(id, values.milestoneId, current ? { ...current, ...values } : values);
    return { key: values.milestoneId };
  });
}

export async function deleteCohortMilestone(app: App, cohortId: unknown, milestoneId: unknown) {
  const user = await requireAdmin(app, 'DELETE_COHORT_MILESTONE');
  const id = await requireSeededCohort(app, cohortId);
  const key = text(milestoneId);
  if (!key) throw new HubError('A record key is required.');
  return audited(app, user, 'DELETE_COHORT_MILESTONE', { cohortId: id, milestoneId: key }, async () => {
    const existing = await app.store.getCohortMilestone(id, key);
    if (!existing) throw new HubError('Record not found.');
    const members = await app.store.listMembers(id);
    const emails: Record<string, boolean> = {};
    members.forEach((member) => {
      const email = normalizeEmail(member.StudentId);
      if (email) emails[email] = true;
    });
    const items = await app.store.list(COLLECTIONS.studentActionItems);
    const assigned = items.some((item) => text(item.CreatorType) === 'System' && text(item.TemplateId) === key && emails[normalizeEmail(item.StudentId)]);
    if (assigned) throw new HubError('This milestone has assigned action items in this cohort and cannot be deleted.');
    await app.store.removeCohortMilestone(id, key);
    return { deleted: true };
  });
}

export async function saveCohortPlanAnchor(app: App, cohortId: unknown, anchorDate: unknown) {
  const user = await requireAdmin(app, 'SAVE_COHORT_PLAN_ANCHOR');
  const id = await requireSeededCohort(app, cohortId);
  const parsed = parseActionDate(anchorDate);
  if (!parsed) throw new HubError('Choose a valid anchor date.');
  const iso = serializeDateOnly(parsed);
  return audited(app, user, 'SAVE_COHORT_PLAN_ANCHOR', { cohortId: id, anchorDate: iso }, async () => {
    await writePlanFlag(app, id, iso);
    return { cohortId: id, anchorDate: iso };
  });
}

function sourceFrom(value: unknown): PathwaySource {
  if (typeof value === 'string') {
    if (value === 'template') return { kind: 'template' };
    if (value.startsWith('cohort:')) return { kind: 'cohort', cohortId: value.slice('cohort:'.length) };
  }
  const record = value && typeof value === 'object' ? value as Doc : {};
  const kind = text(record.kind);
  if (kind === 'cohort') return { kind: 'cohort', cohortId: text(record.cohortId || record.id) };
  if (kind === 'template' || !kind) return { kind: 'template' };
  throw new HubError('Choose the template or a cohort to copy.');
}

export async function seedCohortPathway(app: App, cohortId: unknown, sourceValue: unknown, anchorDate: unknown) {
  const user = await requireAdmin(app, 'SEED_COHORT_PATHWAY');
  assertSeededStore(app);
  const id = text(cohortId);
  const existing = await cohortRecord(app, id);
  if (toBoolean(existing[PLAN_SEEDED])) throw new HubError('This cohort already has phases and milestones.');
  const parsed = parseActionDate(anchorDate);
  if (!parsed) throw new HubError('Choose a valid anchor date.');
  const iso = serializeDateOnly(parsed);
  const source = sourceFrom(sourceValue);
  let phases: Doc[] = [];
  let milestones: Doc[] = [];
  if (source.kind === 'template') {
    phases = await app.store.list(COLLECTIONS.phases);
    milestones = await app.store.list(COLLECTIONS.milestoneTemplates);
  } else {
    const fromId = text(source.cohortId);
    if (!fromId || fromId === id) throw new HubError('Choose a different cohort to copy.');
    const from = await cohortRecord(app, fromId);
    if (!toBoolean(from[PLAN_SEEDED])) throw new HubError('That cohort has no milestones yet.');
    phases = await app.store.listCohortPhases(fromId);
    milestones = await app.store.listCohortMilestones(fromId);
  }
  const storedPhases = phases.map((phase) => normalizePhase({ ...phase }, text(phase.phaseId), phases));
  const storedMilestones = milestones.map((milestone) => normalizeMilestone({ ...milestone }, text(milestone.milestoneId), storedPhases));
  return audited(app, user, 'SEED_COHORT_PATHWAY', { cohortId: id, source: source.kind, sourceCohortId: source.cohortId || '', anchorDate: iso }, async () => {
    for (const phase of storedPhases) await app.store.setCohortPhase(id, phase.phaseId, phase);
    for (const milestone of storedMilestones) await app.store.setCohortMilestone(id, milestone.milestoneId, milestone);
    await writePlanFlag(app, id, iso);
    return { cohortId: id, anchorDate: iso, phases: storedPhases.length, milestones: storedMilestones.length };
  });
}
