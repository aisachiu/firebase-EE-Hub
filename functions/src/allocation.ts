import { presentDriveAccount, requireDriveActor } from './driveAccount';
import { requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, requireAdmin } from './session';
import { SheetGrid, spreadsheetIdFrom } from './sheetImport';
import { openGoogleWorkbook, SheetWorkbook, sheetTabTitle } from './sheetSync';
import { AllocationOp } from './store';
import {
  AllocationDesk,
  AllocationSettings,
  applySavedConfig,
  buildDesk,
  allocationExportRows,
  emptySettings,
  findAllocationTab,
  isEeActive,
  mergeDetected,
  parseTokenGrid,
  parseWorkspaceGrid,
  planBatchDraft,
  planCommit,
  planDraft,
  planReopen,
  planTokenTopUp,
  settingsFromDoc,
  tokenFromDoc,
  TokenRecord,
  workspaceFromDoc,
  WorkspaceRecord,
} from './allocationPure';
import { Doc, HubError, normalizeEmail, nowIso, shortId, text } from './util';

export interface AllocationIngestResult {
  cohortId: string;
  kind: 'workspace' | 'tokens';
  spreadsheetId: string;
  incoming: number;
  writing: number;
  skipped: number;
  creating: number;
  warnings: string[];
}

interface IngestDeps {
  workbook?: SheetWorkbook;
}

interface ExportDeps {
  workbook?: SheetWorkbook;
  actorEmail?: string;
  now?: Date;
}

export async function getAllocationDesk(app: App, cohortId: unknown): Promise<AllocationDesk & { driveReady: boolean; driveActor: string; driveError: string }> {
  await requireAdmin(app, 'GET_ALLOCATION_DESK');
  const cohort = await requireCohort(app, text(cohortId));
  const [members, workspaceDocs, tokenDocs, configDoc, staff, drive] = await Promise.all([
    app.store.listMembers(cohort.id),
    app.store.listWorkspace(cohort.id),
    app.store.listTokens(cohort.id),
    app.store.getAllocationConfig(cohort.id),
    app.store.list(COLLECTIONS.staffUsers),
    presentDriveAccount(app),
  ]);
  const desk = buildDesk({
    cohortId: cohort.id,
    members,
    workspaces: workspaceDocs.map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId))),
    tokens: tokensFrom(tokenDocs, cohort.id),
    staff: staff.map((person) => ({ email: normalizeEmail(person.EMAIL), displayName: text(person.DisplayName) })),
    settings: settingsFromDoc(configDoc),
  });
  return { ...desk, driveReady: drive.ready, driveActor: drive.actorEmail, driveError: drive.ready ? '' : drive.error };
}

export async function draftAllocation(app: App, cohortId: unknown, studentId: unknown, staffId: unknown, subject: unknown) {
  const user = await requireAdmin(app, 'DRAFT_ALLOCATION');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  return audited(app, user, 'DRAFT_ALLOCATION', { cohortId: cohort.id, studentId: email, staffId: normalizeEmail(staffId) }, async () => {
    const member = await requireActiveMember(app, cohort.id, email);
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const workspace = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
    const plan = planDraft({
      studentId: email,
      staffId: text(staffId),
      subject: text(subject),
      tokens,
      memberSupervisorId: normalizeEmail(member.supervisorId),
      pendingClear: workspace.pendingClear,
    });
    if (plan.error) throw new HubError(plan.error);
    if (!plan.changed) return { changed: false, studentId: email };
    for (const token of plan.tokens) await app.store.setToken(cohort.id, token.id, token);
    await app.store.setWorkspace(cohort.id, email, { ...workspace, studentId: email, pendingClear: plan.pendingClear, updatedAt: nowIso() });
    return { changed: true, studentId: email, pendingClear: plan.pendingClear };
  });
}

export async function batchDraftAllocations(app: App, cohortId: unknown, staffId: unknown, studentIds: unknown, subjects: unknown) {
  const user = await requireAdmin(app, 'BATCH_DRAFT_ALLOCATIONS');
  const cohort = await requireCohort(app, text(cohortId));
  const supervisor = normalizeEmail(staffId);
  if (!supervisor) throw new HubError('Choose a supervisor.');
  const ids = Array.isArray(studentIds) ? studentIds.map((id) => normalizeEmail(id)).filter(Boolean) : [];
  if (!ids.length) throw new HubError('Select at least one student.');
  if (ids.length > 1000) throw new HubError('Select no more than 1,000 students at a time.');
  return audited(app, user, 'BATCH_DRAFT_ALLOCATIONS', { cohortId: cohort.id, staffId: supervisor, students: ids.length }, async () => {
    const members = await app.store.listMembers(cohort.id);
    const byStudent = new Map(members.map((member) => [normalizeEmail(member.StudentId), member]));
    const active: string[] = [];
    const skippedInactive: { studentId: string; reason: string }[] = [];
    ids.forEach((id) => {
      const member = byStudent.get(id);
      if (!member) skippedInactive.push({ studentId: id, reason: 'Student is not in the selected cohort.' });
      else if (!isEeActive(member.eeActive)) skippedInactive.push({ studentId: id, reason: 'This student is not active for allocation.' });
      else active.push(id);
    });
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const workspaces = (await app.store.listWorkspace(cohort.id)).map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId)));
    const workspaceByStudent = new Map(workspaces.map((workspace) => [workspace.studentId, workspace]));
    const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
    const requested = subjectMap(subjects);
    const resolved: Record<string, string> = {};
    active.forEach((id) => {
      const workspace = workspaceByStudent.get(id);
      const explicit = text(requested[id]);
      const primary = settings.primaryChoiceKey ? text(workspace?.subjectChoices[settings.primaryChoiceKey]) : '';
      const current = tokens.find((token) => token.allocatedTo === id && token.status !== 'available');
      resolved[id] = explicit || current?.assignedSubject || primary;
    });
    const plan = planBatchDraft({
      studentIds: active,
      staffId: supervisor,
      subjects: resolved,
      tokens,
      supervisorByStudent: Object.fromEntries(active.map((id) => [id, normalizeEmail(byStudent.get(id)?.supervisorId)])),
      pendingClearByStudent: Object.fromEntries(active.map((id) => [id, !!workspaceByStudent.get(id)?.pendingClear])),
    });
    const now = nowIso();
    for (const token of plan.tokenWrites) await app.store.setToken(cohort.id, token.id, token);
    for (const studentId of Object.keys(plan.pendingClears)) {
      const workspace = workspaceByStudent.get(studentId) || emptyWorkspace(studentId, now);
      await app.store.setWorkspace(cohort.id, studentId, { ...workspace, pendingClear: plan.pendingClears[studentId], updatedAt: now });
    }
    return {
      assigned: plan.assigned,
      skipped: skippedInactive.concat(plan.skipped),
    };
  });
}

export async function reopenAllocation(app: App, cohortId: unknown, studentId: unknown) {
  const user = await requireAdmin(app, 'REOPEN_ALLOCATION');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  return audited(app, user, 'REOPEN_ALLOCATION', { cohortId: cohort.id, studentId: email }, async () => {
    await requireActiveMember(app, cohort.id, email);
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const plan = planReopen(tokens, email);
    if (plan.error) throw new HubError(plan.error);
    if (plan.token && plan.token.status === 'draft') await app.store.setToken(cohort.id, plan.token.id, plan.token);
    return { studentId: email, status: 'draft' };
  });
}

export async function commitAllocations(app: App, cohortId: unknown) {
  const user = await requireAdmin(app, 'COMMIT_ALLOCATIONS');
  const cohort = await requireCohort(app, text(cohortId));
  return audited(app, user, 'COMMIT_ALLOCATIONS', { cohortId: cohort.id }, async () => {
    const members = await app.store.listMembers(cohort.id);
    const byStudent = new Map(members.map((member) => [normalizeEmail(member.StudentId), member]));
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const workspaces = (await app.store.listWorkspace(cohort.id)).map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId)));
    const plan = planCommit(tokens, workspaces);
    if (plan.warnings.length) throw new HubError(plan.warnings[0]);
    const missing = plan.assignments.concat(plan.clears.map((studentId) => ({ studentId, staffId: '', subject: '', tokenId: '' }))).filter((row) => !byStudent.has(row.studentId));
    if (missing.length) throw new HubError(`${missing[0].studentId} is not on the cohort roster.`);
    const now = nowIso();
    const ops: AllocationOp[] = [];
    const tokenById = new Map(tokens.map((token) => [token.id, token]));
    plan.assignments.forEach((row) => {
      const member = { ...byStudent.get(row.studentId)!, supervisorId: row.staffId, subject: row.subject };
      ops.push({ kind: 'member', cohortId: cohort.id, id: row.studentId, data: member });
      const token = tokenById.get(row.tokenId);
      if (token) ops.push({ kind: 'token', cohortId: cohort.id, id: token.id, data: { ...token, status: 'committed' } });
      const workspace = workspaces.find((item) => item.studentId === row.studentId);
      if (workspace?.pendingClear) ops.push({ kind: 'workspace', cohortId: cohort.id, id: row.studentId, data: { ...workspace, pendingClear: false, updatedAt: now } });
    });
    plan.clears.forEach((studentId) => {
      const member = { ...byStudent.get(studentId)!, supervisorId: '', subject: '' };
      ops.push({ kind: 'member', cohortId: cohort.id, id: studentId, data: member });
      const workspace = workspaces.find((item) => item.studentId === studentId);
      if (workspace) ops.push({ kind: 'workspace', cohortId: cohort.id, id: studentId, data: { ...workspace, pendingClear: false, updatedAt: now } });
    });
    await app.store.applyAllocationOps(ops);
    return { published: plan.assignments.length, cleared: plan.clears.length };
  });
}

export async function saveAllocationConfig(app: App, cohortId: unknown, config: unknown) {
  const user = await requireAdmin(app, 'SAVE_ALLOCATION_CONFIG');
  const cohort = await requireCohort(app, text(cohortId));
  const incoming = config && typeof config === 'object' ? config as Doc : {};
  return audited(app, user, 'SAVE_ALLOCATION_CONFIG', { cohortId: cohort.id }, async () => {
    const current = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
    const next = applySavedConfig(current, incoming);
    await app.store.setAllocationConfig(cohort.id, next);
    return next;
  });
}

export async function previewAllocationIngest(app: App, cohortId: unknown, source: unknown, kind: unknown, deps?: IngestDeps): Promise<AllocationIngestResult> {
  await requireAdmin(app, 'PREVIEW_ALLOCATION_INGEST');
  const prepared = await prepareIngest(app, cohortId, source, kind, deps);
  return prepared.preview;
}

export async function applyAllocationIngest(app: App, cohortId: unknown, source: unknown, kind: unknown, deps?: IngestDeps): Promise<AllocationIngestResult> {
  const user = await requireAdmin(app, 'APPLY_ALLOCATION_INGEST');
  const cohort = text(cohortId);
  return audited(app, user, 'APPLY_ALLOCATION_INGEST', { cohortId: cohort, kind: text(kind) }, async () => {
    const prepared = await prepareIngest(app, cohortId, source, kind, deps);
    await app.store.applyAllocationOps(prepared.ops);
    return prepared.preview;
  });
}

export async function exportAllocationDrafts(app: App, cohortId: unknown, deps?: ExportDeps) {
  const user = await requireAdmin(app, 'EXPORT_ALLOCATIONS');
  const cohort = await requireCohort(app, text(cohortId));
  const desk = await getAllocationDesk(app, cohort.id);
  const grid: SheetGrid = {
    title: sheetTabTitle(`ALLOCATIONS: ${cohort.id}`),
    rows: allocationExportRows(desk.students, desk.settings),
  };
  return audited(app, user, 'EXPORT_ALLOCATIONS', { cohortId: cohort.id }, async () => {
    const owner = deps?.workbook ? normalizeEmail(deps.actorEmail) || user.email : (await requireDriveActor(app)).actorEmail;
    const workbook = deps?.workbook || await openGoogleWorkbook();
    const title = `EE Hub allocations ${cohort.id} ${(deps?.now || new Date()).toISOString().slice(0, 10)}`;
    const created = await workbook.create(title, [grid]);
    let shared = normalizeEmail(owner) === user.email;
    let shareProblem = '';
    if (!shared) {
      try {
        await workbook.share(created.spreadsheetId, user.email);
        shared = true;
      } catch (error) {
        shareProblem = error instanceof Error ? error.message : 'The spreadsheet could not be shared.';
      }
    }
    const settings = { ...desk.settings, lastExport: nowIso() };
    await app.store.setAllocationConfig(cohort.id, settings);
    return { ...created, shared, shareProblem, owner, title };
  });
}

async function prepareIngest(app: App, cohortId: unknown, source: unknown, kindValue: unknown, deps?: IngestDeps) {
  const cohort = await requireCohort(app, text(cohortId));
  const kind = ingestKind(kindValue);
  const spreadsheetId = spreadsheetIdFrom(sheetSource(source));
  const workbook = deps?.workbook || await openGoogleWorkbook();
  const grids = await workbook.read(spreadsheetId);
  const grid = findAllocationTab(grids, cohort.id, kind);
  if (!grid) {
    const label = kind === 'workspace' ? 'COHORTDATA' : 'SUPERVISORTOKENS';
    throw new HubError(`The spreadsheet has no ${label} tab for ${cohort.id}.`);
  }
  const now = nowIso();
  const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
  if (kind === 'workspace') return prepareWorkspace(app, cohort.id, grid, spreadsheetId, settings, now);
  return prepareTokens(app, cohort.id, grid, spreadsheetId, settings, now);
}

async function prepareWorkspace(app: App, cohortId: string, grid: SheetGrid, spreadsheetId: string, settings: AllocationSettings, now: string) {
  const parsed = parseWorkspaceGrid(grid);
  const members = await app.store.listMembers(cohortId);
  const byStudent = new Map(members.map((member) => [normalizeEmail(member.StudentId), member]));
  const existingDocs = await app.store.listWorkspace(cohortId);
  const existing = new Map(existingDocs.map((doc) => [normalizeEmail(doc.studentId || doc.id), workspaceFromDoc(doc, text(doc.id || doc.studentId))]));
  const ops: AllocationOp[] = [];
  let writing = 0;
  let skipped = 0;
  parsed.rows.forEach((row) => {
    const member = byStudent.get(row.studentId);
    if (!member) {
      skipped += 1;
      parsed.warnings.push(`${row.studentId} is not on the ${cohortId} roster.`);
      return;
    }
    writing += 1;
    const prior = existing.get(row.studentId);
    const workspace: WorkspaceRecord = {
      studentId: row.studentId,
      subjectChoices: row.subjectChoices,
      dynamicData: row.dynamicData,
      pendingClear: !!prior?.pendingClear,
      updatedAt: now,
    };
    ops.push({ kind: 'workspace', cohortId, id: row.studentId, data: workspace });
    if (row.eeActive !== null) ops.push({ kind: 'member', cohortId, id: row.studentId, data: { ...member, eeActive: row.eeActive } });
  });
  const next = { ...mergeDetected(settings, parsed.choiceKeys, parsed.dynamicKeys), lastWorkspaceSync: now };
  ops.push({ kind: 'config', cohortId, data: next });
  return {
    ops,
    preview: ingestPreview(cohortId, 'workspace', spreadsheetId, parsed.rows.length, writing, skipped, 0, parsed.warnings),
  };
}

async function prepareTokens(app: App, cohortId: string, grid: SheetGrid, spreadsheetId: string, settings: AllocationSettings, now: string) {
  const parsed = parseTokenGrid(grid);
  const existing = tokensFrom(await app.store.listTokens(cohortId), cohortId);
  const taken = new Set(existing.map((token) => token.id));
  const plan = planTokenTopUp(existing, parsed.rows, cohortId, now, () => {
    let id = shortId('tok');
    while (taken.has(id)) id = shortId('tok');
    taken.add(id);
    return id;
  });
  const ops: AllocationOp[] = plan.create.map((token) => ({ kind: 'token' as const, cohortId, id: token.id, data: token }));
  plan.eligibleUpdates.forEach((update) => {
    const token = existing.find((item) => item.id === update.id);
    if (!token) return;
    ops.push({ kind: 'token', cohortId, id: token.id, data: { ...token, eligibleSubjects: update.eligibleSubjects } });
  });
  ops.push({ kind: 'config', cohortId, data: { ...settings, lastTokenSync: now } });
  return {
    ops,
    preview: ingestPreview(cohortId, 'tokens', spreadsheetId, parsed.rows.length, plan.eligibleUpdates.length, 0, plan.create.length, parsed.warnings.concat(plan.warnings)),
  };
}

function ingestPreview(cohortId: string, kind: 'workspace' | 'tokens', spreadsheetId: string, incoming: number, writing: number, skipped: number, creating: number, warnings: string[]): AllocationIngestResult {
  return { cohortId, kind, spreadsheetId, incoming, writing, skipped, creating, warnings };
}

async function requireActiveMember(app: App, cohortId: string, studentId: string): Promise<Doc> {
  const member = await app.store.getMember(cohortId, studentId);
  if (!member) throw new HubError('Student is not in the selected cohort.');
  if (!isEeActive(member.eeActive)) throw new HubError('This student is not active for allocation.');
  return member;
}

function tokensFrom(docs: Doc[], cohortId: string): TokenRecord[] {
  return docs
    .map((doc) => tokenFromDoc({ ...doc, cohortId: text(doc.cohortId) || cohortId }))
    .filter((token): token is TokenRecord => !!token);
}

function emptyWorkspace(studentId: string, now: string): WorkspaceRecord {
  return { studentId, subjectChoices: {}, dynamicData: {}, pendingClear: false, updatedAt: now };
}

function subjectMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    const email = normalizeEmail(key);
    if (email) out[email] = text(item);
  });
  return out;
}

function sheetSource(source: unknown): string {
  if (source && typeof source === 'object') return text((source as Doc).url || (source as Doc).source);
  return text(source);
}

function ingestKind(value: unknown): 'workspace' | 'tokens' {
  const kind = text(value).toLowerCase();
  if (kind === 'workspace' || kind === 'tokens') return kind;
  throw new HubError('Choose student data or staff tokens.');
}

export { emptySettings };
