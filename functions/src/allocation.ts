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
  publishedAllocationSubject,
  planTokenTopUp,
  settingsFromDoc,
  activeSubjectNamesFrom,
  canonicalSubjectAssignment,
  parseSubjectCell,
  staffQuotaTokenRows,
  tokenFromDoc,
  tokenPreviewRows,
  tokenSheetRows,
  TokenRecord,
  uniqueSubjects,
  workspaceFromDoc,
  workspacePreviewRows,
  WorkspaceRecord,
  AllocationPreviewRow,
} from './allocationPure';
import { WORKSPACE_SHEET_HELP } from './workspaceSheetHelp';
import { Doc, HubError, normalizeEmail, nowIso, shortId, text } from './util';

export interface AllocationIngestResult {
  cohortId: string;
  kind: 'workspace' | 'tokens';
  spreadsheetId: string;
  sheet: string;
  incoming: number;
  existing: number;
  removing: number;
  writing: number;
  skipped: number;
  creating: number;
  warnings: string[];
  rows: AllocationPreviewRow[];
  note: string;
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
  const [members, workspaceDocs, tokenDocs, configDoc, staff, drive, subjectDocs] = await Promise.all([
    app.store.listMembers(cohort.id),
    app.store.listWorkspace(cohort.id),
    app.store.listTokens(cohort.id),
    app.store.getAllocationConfig(cohort.id),
    app.store.list(COLLECTIONS.staffUsers),
    presentDriveAccount(app),
    app.store.list(COLLECTIONS.subjects),
  ]);
  const choiceSources = new Map<string, unknown>();
  workspaceDocs.forEach((doc) => {
    choiceSources.set(normalizeEmail(doc.studentId || doc.id), doc.subjectChoices);
  });
  const desk = buildDesk({
    cohortId: cohort.id,
    members,
    workspaces: workspaceDocs.map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId))),
    tokens: tokensFrom(tokenDocs, cohort.id),
    staff: staff.map((person) => ({ email: normalizeEmail(person.EMAIL), displayName: text(person.DisplayName) })),
    settings: settingsFromDoc(configDoc),
    subjects: subjectDocs,
    choiceSources,
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
    const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
    const workspaceByStudent = new Map(workspaces.map((workspace) => [workspace.studentId, workspace]));
    const touched = plan.assignments.map((row) => row.studentId).concat(plan.clears);
    const profileByStudent = new Map<string, Doc | null>();
    await Promise.all(touched.map(async (studentId) => {
      profileByStudent.set(studentId, await app.store.get(COLLECTIONS.studentUsers, studentId));
    }));
    const now = nowIso();
    const ops: AllocationOp[] = [];
    const tokenById = new Map(tokens.map((token) => [token.id, token]));
    const writeStudentSubject = (studentId: string, subject: string) => {
      if (!profileByStudent.get(studentId)) return;
      ops.push({ kind: 'student', id: studentId, data: { subject } });
    };
    plan.assignments.forEach((row) => {
      const workspace = workspaceByStudent.get(row.studentId);
      const subject = publishedAllocationSubject(row.subject, workspace?.subjectChoices, settings.primaryChoiceKey);
      const member = { ...byStudent.get(row.studentId)!, supervisorId: row.staffId, subject };
      ops.push({ kind: 'member', cohortId: cohort.id, id: row.studentId, data: member });
      writeStudentSubject(row.studentId, subject);
      const token = tokenById.get(row.tokenId);
      if (token) ops.push({ kind: 'token', cohortId: cohort.id, id: token.id, data: { ...token, assignedSubject: subject, status: 'committed' } });
      if (workspace?.pendingClear) ops.push({ kind: 'workspace', cohortId: cohort.id, id: row.studentId, data: { ...workspace, pendingClear: false, updatedAt: now } });
    });
    plan.clears.forEach((studentId) => {
      const member = { ...byStudent.get(studentId)!, supervisorId: '', subject: '' };
      ops.push({ kind: 'member', cohortId: cohort.id, id: studentId, data: member });
      writeStudentSubject(studentId, '');
      const workspace = workspaceByStudent.get(studentId);
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

export async function getStaffQuotaSheet(app: App) {
  await requireAdmin(app, 'GET_STAFF_QUOTA_SHEET');
  const [staff, subjects] = await Promise.all([
    app.store.list(COLLECTIONS.staffUsers),
    activeSubjectNames(app),
  ]);
  const rows = staff
    .map((person) => ({
      email: normalizeEmail(person.EMAIL),
      displayName: text(person.DisplayName),
      department: text(person['Primary Department']),
      quota: person.EEQuota === '' || person.EEQuota === undefined || person.EEQuota === null ? '' : person.EEQuota,
      subjects: parseSubjectCell(person.EESubjects),
    }))
    .filter((person) => person.email)
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.email.localeCompare(right.email));
  return { staff: rows, subjects };
}

export async function saveStaffQuotas(app: App, rows: unknown) {
  const user = await requireAdmin(app, 'SAVE_STAFF_QUOTAS');
  const incoming = quotaEdits(rows);
  const active = await activeSubjectNames(app);
  return audited(app, user, 'SAVE_STAFF_QUOTAS', { staff: incoming.length }, async () => {
    const saved = await writeStaffSubjects(app, incoming, active, true);
    return { updated: saved.length, staff: saved };
  });
}

export async function saveStaffSubjects(app: App, rows: unknown) {
  const user = await requireAdmin(app, 'SAVE_STAFF_SUBJECTS');
  const incoming = subjectEdits(rows);
  const active = await activeSubjectNames(app);
  return audited(app, user, 'SAVE_STAFF_SUBJECTS', { staff: incoming.length }, async () => {
    const saved = await writeStaffSubjects(app, incoming.map((row) => ({ ...row, quota: undefined })), active, false);
    return { updated: saved.length, staff: saved };
  });
}

export async function assignStaffSubjects(app: App, emails: unknown, subjects: unknown, mode: unknown) {
  const user = await requireAdmin(app, 'ASSIGN_STAFF_SUBJECTS');
  const modeName = text(mode).toLowerCase();
  if (modeName !== 'add' && modeName !== 'remove') throw new HubError('Choose add or remove.');
  const picked = uniqueSubjects(subjects);
  if (!picked.length) throw new HubError('Choose at least one subject.');
  const emailList = staffEmails(emails);
  const active = await activeSubjectNames(app);
  if (modeName === 'add') canonicalSubjectAssignment(picked, active, []);
  return audited(app, user, 'ASSIGN_STAFF_SUBJECTS', { staff: emailList.length, mode: modeName }, async () => {
    const saved: { email: string; subjects: string[] }[] = [];
    for (const email of emailList) {
      const existing = await app.store.get(COLLECTIONS.staffUsers, email);
      if (!existing) throw new HubError(`${email} is not a staff user.`);
      const current = parseSubjectCell(existing.EESubjects);
      const next = modeName === 'add'
        ? canonicalSubjectAssignment(current.concat(picked), active, current)
        : current.filter((item) => !picked.some((subject) => subject.toLowerCase() === item.toLowerCase()));
      existing.EESubjects = next;
      await app.store.set(COLLECTIONS.staffUsers, email, existing);
      saved.push({ email, subjects: next });
    }
    return { updated: saved.length, staff: saved };
  });
}

export async function previewStaffQuotaTokens(app: App, cohortId: unknown): Promise<AllocationIngestResult> {
  await requireAdmin(app, 'PREVIEW_STAFF_QUOTA_TOKENS');
  const cohort = await requireCohort(app, text(cohortId));
  return (await prepareStaffQuota(app, cohort.id)).preview;
}

export async function applyStaffQuotaTokens(app: App, cohortId: unknown): Promise<AllocationIngestResult> {
  const user = await requireAdmin(app, 'APPLY_STAFF_QUOTA_TOKENS');
  const cohort = text(cohortId);
  return audited(app, user, 'APPLY_STAFF_QUOTA_TOKENS', { cohortId: cohort }, async () => {
    const prepared = await prepareStaffQuota(app, cohort);
    await app.store.applyAllocationOps(prepared.ops);
    return prepared.preview;
  });
}

export async function exportStaffQuotaSheet(app: App, cohortId: unknown, deps?: ExportDeps) {
  const user = await requireAdmin(app, 'EXPORT_STAFF_QUOTA_SHEET');
  const cohort = await requireCohort(app, text(cohortId));
  const parsed = staffQuotaTokenRows(await app.store.list(COLLECTIONS.staffUsers));
  if (!parsed.rows.length) throw new HubError('Set a quota on at least one staff member before exporting tokens.');
  const grid: SheetGrid = {
    title: sheetTabTitle(`SUPERVISORTOKENS: ${cohort.id}`),
    rows: tokenSheetRows(parsed.rows),
  };
  return audited(app, user, 'EXPORT_STAFF_QUOTA_SHEET', { cohortId: cohort.id, staff: parsed.rows.length }, async () => {
    const owner = deps?.workbook ? normalizeEmail(deps.actorEmail) || user.email : (await requireDriveActor(app)).actorEmail;
    const workbook = deps?.workbook || await openGoogleWorkbook();
    const title = `EE Hub supervisor tokens ${cohort.id} ${(deps?.now || new Date()).toISOString().slice(0, 10)}`;
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
    return { ...created, shared, shareProblem, owner, title, warnings: parsed.warnings };
  });
}

export async function listCohortTokens(app: App, cohortId: unknown) {
  await requireAdmin(app, 'LIST_COHORT_TOKENS');
  const cohort = await requireCohort(app, text(cohortId));
  const [tokenDocs, staff, subjects] = await Promise.all([
    app.store.listTokens(cohort.id),
    app.store.list(COLLECTIONS.staffUsers),
    activeSubjectNames(app),
  ]);
  const names = new Map(staff.map((person) => [normalizeEmail(person.EMAIL), text(person.DisplayName) || normalizeEmail(person.EMAIL)]));
  const tokens = tokensFrom(tokenDocs, cohort.id)
    .map((token) => ({
      ...token,
      staffName: names.get(token.staffId) || token.staffId,
    }))
    .sort((left, right) => left.staffName.localeCompare(right.staffName) || left.status.localeCompare(right.status) || left.id.localeCompare(right.id));
  return {
    cohortId: cohort.id,
    tokens,
    staff: staff
      .map((person) => ({ email: normalizeEmail(person.EMAIL), displayName: text(person.DisplayName) || normalizeEmail(person.EMAIL) }))
      .filter((person) => person.email)
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    subjects,
  };
}

export async function addCohortTokens(app: App, cohortId: unknown, staffId: unknown, subjects: unknown, count: unknown) {
  const user = await requireAdmin(app, 'ADD_COHORT_TOKENS');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(staffId);
  const eligibleSubjects = uniqueSubjects(subjects);
  const slots = typeof count === 'number' ? count : Number(text(count));
  if (!email) throw new HubError('Choose a staff member.');
  if (!eligibleSubjects.length) throw new HubError('Choose at least one EE subject.');
  if (!Number.isInteger(slots) || slots < 1 || slots > 100) throw new HubError('Add between 1 and 100 tokens.');
  return audited(app, user, 'ADD_COHORT_TOKENS', { cohortId: cohort.id, staffId: email, count: slots }, async () => {
    const staff = await app.store.get(COLLECTIONS.staffUsers, email);
    if (!staff) throw new HubError(`${email} is not a staff user.`);
    const existing = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const taken = new Set(existing.map((token) => token.id));
    const now = nowIso();
    const created: TokenRecord[] = [];
    for (let index = 0; index < slots; index += 1) {
      let id = shortId('tok');
      while (taken.has(id)) id = shortId('tok');
      taken.add(id);
      const token: TokenRecord = {
        id,
        cohortId: cohort.id,
        staffId: email,
        eligibleSubjects,
        allocatedTo: '',
        assignedSubject: '',
        status: 'available',
        createdAt: now,
      };
      await app.store.setToken(cohort.id, id, token);
      created.push(token);
    }
    return { created: created.length };
  });
}

export async function updateCohortToken(app: App, cohortId: unknown, tokenId: unknown, subjects: unknown) {
  const user = await requireAdmin(app, 'UPDATE_COHORT_TOKEN');
  const cohort = await requireCohort(app, text(cohortId));
  const id = text(tokenId);
  const eligibleSubjects = uniqueSubjects(subjects);
  if (!id) throw new HubError('Choose a token.');
  if (!eligibleSubjects.length) throw new HubError('Choose at least one EE subject.');
  return audited(app, user, 'UPDATE_COHORT_TOKEN', { cohortId: cohort.id, tokenId: id }, async () => {
    const existing = tokenFromDoc({ ...(await app.store.getToken(cohort.id, id) || {}), cohortId: cohort.id });
    if (!existing) throw new HubError('Token not found.');
    await app.store.setToken(cohort.id, existing.id, { ...existing, eligibleSubjects });
    return { id: existing.id, eligibleSubjects };
  });
}

export async function deleteCohortToken(app: App, cohortId: unknown, tokenId: unknown) {
  const user = await requireAdmin(app, 'DELETE_COHORT_TOKEN');
  const cohort = await requireCohort(app, text(cohortId));
  const id = text(tokenId);
  if (!id) throw new HubError('Choose a token.');
  return audited(app, user, 'DELETE_COHORT_TOKEN', { cohortId: cohort.id, tokenId: id }, async () => {
    const existing = tokenFromDoc({ ...(await app.store.getToken(cohort.id, id) || {}), cohortId: cohort.id });
    if (!existing) throw new HubError('Token not found.');
    if (existing.status === 'committed') throw new HubError('This token is published. Return it to draft on the allocation dashboard before deleting it.');
    await app.store.removeToken(cohort.id, existing.id);
    return { deleted: true, id: existing.id };
  });
}

async function prepareStaffQuota(app: App, cohortId: string) {
  const cohort = await requireCohort(app, cohortId);
  const parsed = staffQuotaTokenRows(await app.store.list(COLLECTIONS.staffUsers));
  if (!parsed.rows.length) throw new HubError('Set a quota on at least one staff member before generating tokens.');
  const existing = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
  const taken = new Set(existing.map((token) => token.id));
  const now = nowIso();
  const plan = planTokenTopUp(existing, parsed.rows, cohort.id, now, () => {
    let id = shortId('tok');
    while (taken.has(id)) id = shortId('tok');
    taken.add(id);
    return id;
  });
  const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
  const ops: AllocationOp[] = plan.create.map((token) => ({ kind: 'token' as const, cohortId: cohort.id, id: token.id, data: token }));
  plan.eligibleUpdates.forEach((update) => {
    const token = existing.find((item) => item.id === update.id);
    if (!token) return;
    ops.push({ kind: 'token', cohortId: cohort.id, id: token.id, data: { ...token, eligibleSubjects: update.eligibleSubjects } });
  });
  ops.push({ kind: 'config', cohortId: cohort.id, data: { ...settings, lastTokenSync: now } });
  return {
    ops,
    preview: ingestPreview({
      cohortId: cohort.id,
      kind: 'tokens',
      spreadsheetId: '',
      sheet: `SUPERVISORTOKENS: ${cohort.id}`,
      incoming: parsed.rows.length,
      existing: existing.length,
      writing: plan.eligibleUpdates.length,
      skipped: 0,
      creating: plan.create.length,
      warnings: parsed.warnings.concat(plan.warnings),
      rows: tokenPreviewRows(parsed.rows, existing),
      note: WORKSPACE_SHEET_HELP.tokenNote,
    }),
  };
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
  const roster = members.map((member) => ({ studentId: normalizeEmail(member.StudentId), eeActive: member.eeActive }));
  return {
    ops,
    preview: ingestPreview({
      cohortId,
      kind: 'workspace',
      spreadsheetId,
      sheet: grid.title,
      incoming: parsed.rows.length,
      existing: existing.size,
      writing,
      skipped,
      creating: 0,
      warnings: parsed.warnings,
      rows: workspacePreviewRows(parsed.rows, roster, [...existing.values()]),
      note: WORKSPACE_SHEET_HELP.workspaceNote,
    }),
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
    preview: ingestPreview({
      cohortId,
      kind: 'tokens',
      spreadsheetId,
      sheet: grid.title,
      incoming: parsed.rows.length,
      existing: existing.length,
      writing: plan.eligibleUpdates.length,
      skipped: 0,
      creating: plan.create.length,
      warnings: parsed.warnings.concat(plan.warnings),
      rows: tokenPreviewRows(parsed.rows, existing),
      note: WORKSPACE_SHEET_HELP.tokenNote,
    }),
  };
}

function ingestPreview(input: Omit<AllocationIngestResult, 'removing'>): AllocationIngestResult {
  return { ...input, removing: 0 };
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

async function writeStaffSubjects(app: App, rows: { email: string; quota?: number | ''; subjects: string[] }[], active: string[], writeQuota: boolean) {
  const saved: { email: string; subjects: string[] }[] = [];
  for (const row of rows) {
    const existing = await app.store.get(COLLECTIONS.staffUsers, row.email);
    if (!existing) throw new HubError(`${row.email} is not a staff user.`);
    if (writeQuota) existing.EEQuota = row.quota;
    const subjects = canonicalSubjectAssignment(row.subjects, active, parseSubjectCell(existing.EESubjects));
    existing.EESubjects = subjects;
    await app.store.set(COLLECTIONS.staffUsers, row.email, existing);
    saved.push({ email: row.email, subjects });
  }
  return saved;
}

function subjectEdits(value: unknown): { email: string; subjects: string[] }[] {
  return staffSubjectRows(value).map((row) => ({ email: row.email, subjects: row.subjects }));
}

function staffEmails(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new HubError('Select at least one staff member.');
  if (value.length > 500) throw new HubError('Update no more than 500 staff at a time.');
  const seen = new Set<string>();
  const emails: string[] = [];
  value.forEach((item) => {
    const email = normalizeEmail(item);
    if (!email) throw new HubError('Each selected row needs a staff email.');
    if (seen.has(email)) return;
    seen.add(email);
    emails.push(email);
  });
  return emails;
}

function quotaEdits(value: unknown): { email: string; quota: number | ''; subjects: string[] }[] {
  return staffSubjectRows(value).map((row) => {
    const source = row.raw;
    const quota = readQuota(source.quota === undefined ? source.EEQuota : source.quota);
    return { email: row.email, quota, subjects: row.subjects };
  });
}

function staffSubjectRows(value: unknown): { email: string; subjects: string[]; raw: Doc }[] {
  if (!Array.isArray(value) || !value.length) throw new HubError('Add at least one staff row.');
  if (value.length > 500) throw new HubError('Save no more than 500 staff at a time.');
  const seen = new Set<string>();
  return value.map((item) => {
    const row = item && typeof item === 'object' ? item as Doc : {};
    const email = normalizeEmail(row.email || row.staffId);
    if (!email) throw new HubError('Each row needs a staff email.');
    if (seen.has(email)) throw new HubError(`${email} is listed more than once.`);
    seen.add(email);
    const subjects = uniqueSubjects(row.subjects === undefined ? row.EESubjects : row.subjects);
    if (subjects.length > 40) throw new HubError(`${email} has too many EE subjects.`);
    subjects.forEach((subject) => {
      if (subject.length > 80) throw new HubError('An EE subject name is too long.');
    });
    return { email, subjects, raw: row };
  });
}

function readQuota(value: unknown): number | '' {
  if (value === '' || value === null || value === undefined) return '';
  const quota = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isInteger(quota) || quota < 0 || quota > 200) throw new HubError('Quota must be a whole number from 0 to 200, or left blank.');
  return quota;
}

async function activeSubjectNames(app: App): Promise<string[]> {
  return activeSubjectNamesFrom(await app.store.list(COLLECTIONS.subjects));
}

function ingestKind(value: unknown): 'workspace' | 'tokens' {
  const kind = text(value).toLowerCase();
  if (kind === 'workspace' || kind === 'tokens') return kind;
  throw new HubError('Choose student data or staff tokens.');
}

export { emptySettings };
