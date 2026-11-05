import { presentDriveAccount, requireDriveActor } from './driveAccount';
import { requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, deny, requireAdmin, requireStaff } from './session';
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
  parseAllocationDraftGrid,
  planAllocationDraftIngest,
  planDraftTokenBackfill,
  isEeActive,
  mergeStaticWorkspaceRow,
  settingsAfterWorkspaceIngest,
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
  canonicalSubjectName,
  departmentKey,
  departmentOfSubject,
  departmentsMatch,
  emptyWorkspaceRecord,
  hodStatusFromDoc,
  HodStatusRecord,
  parseSubjectCell,
  subjectCatalogueFrom,
  suggestionCapacity,
  tokenSubjectCatalogue,
  staffQuotaTokenRows,
  tokenFromDoc,
  tokenPreviewRows,
  tokenSheetRows,
  TokenRecord,
  uniqueSubjects,
  workspaceFromDoc,
  workspaceWithLegacyTokenInterdisciplinary,
  workspacePreviewRows,
  WorkspaceRecord,
  AllocationPreviewRow,
} from './allocationPure';
import { WORKSPACE_SHEET_HELP } from './workspaceSheetHelp';
import {
  logAllocationDrafts,
  logCreatedTokens,
  logRemovedToken,
  logSelectedSubject,
  logTokenWrites,
  logUpdatedToken,
  readAllocationAudits,
} from './allocationAudit';
import { Doc, HubError, normalizeEmail, nowIso, shortId, text } from './util';

export interface AllocationIngestResult {
  cohortId: string;
  kind: 'workspace' | 'tokens' | 'drafts';
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

export async function getAllocationDesk(app: App, cohortId: unknown): Promise<AllocationDesk & { driveReady: boolean; driveActor: string; driveError: string; auditLogs: Doc[]; hodStatus: HodStatusRecord }> {
  const user = await requireAllocationReader(app, 'GET_ALLOCATION_DESK');
  const cohort = await requireCohort(app, text(cohortId));
  const [members, workspaceDocs, tokenDocs, configDoc, staff, drive, subjectDocs, auditLogs, hodDoc] = await Promise.all([
    app.store.listMembers(cohort.id),
    app.store.listWorkspace(cohort.id),
    app.store.listTokens(cohort.id),
    app.store.getAllocationConfig(cohort.id),
    app.store.list(COLLECTIONS.staffUsers),
    presentDriveAccount(app),
    app.store.list(COLLECTIONS.subjects),
    user.permissions?.canAdmin ? readAllocationAudits(app, cohort.id) : Promise.resolve([] as Doc[]),
    app.store.getHodStatus(cohort.id),
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
    staff: staff.map((person) => ({
      email: normalizeEmail(person.EMAIL),
      displayName: text(person.DisplayName),
      department: text(person['Primary Department']),
      isHOD: person.isHOD === true,
    })),
    settings: settingsFromDoc(configDoc),
    subjects: subjectDocs,
    choiceSources,
  });
  return {
    ...desk,
    auditLogs,
    hodStatus: hodStatusFromDoc(hodDoc),
    driveReady: drive.ready,
    driveActor: drive.actorEmail,
    driveError: drive.ready ? '' : drive.error,
  };
}

export async function draftAllocation(app: App, cohortId: unknown, studentId: unknown, staffId: unknown, subject: unknown, interdisciplinary?: unknown, interdisciplinarySubject?: unknown, options?: unknown) {
  const user = await requireAdmin(app, 'DRAFT_ALLOCATION');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  const extra = options && typeof options === 'object' ? options as Doc : {};
  return audited(app, user, 'DRAFT_ALLOCATION', { cohortId: cohort.id, studentId: email, staffId: normalizeEmail(staffId) }, async () => {
    const member = await requireActiveMember(app, cohort.id, email);
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const rawWorkspace = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
    const before = tokens.find((token) => token.allocatedTo === email && token.status !== 'available');
    const workspace = workspaceWithLegacyTokenInterdisciplinary(rawWorkspace, before);
    const selectedInterdisciplinary = interdisciplinary === undefined
      ? workspace.selectedInterdisciplinary === true
      : interdisciplinary === true || text(interdisciplinary) === 'Yes';
    const selectedInterdisciplinarySubject = selectedInterdisciplinary
      ? text(interdisciplinarySubject === undefined ? workspace.interdisciplinarySubject : interdisciplinarySubject)
      : '';
    const plan = planDraft({
      studentId: email,
      staffId: text(staffId),
      subject: text(subject),
      tokens,
      memberSupervisorId: normalizeEmail(member.supervisorId),
      pendingClear: workspace.pendingClear,
      interdisciplinary: selectedInterdisciplinary,
      interdisciplinarySubject: selectedInterdisciplinarySubject,
      bypassSubject: extra.bypassSubject === true,
      tokenId: text(extra.tokenId),
    });
    if (plan.error) throw new HubError(plan.error);
    const workspaceChanged = workspace.selectedInterdisciplinary !== selectedInterdisciplinary
      || workspace.interdisciplinarySubject !== selectedInterdisciplinarySubject;
    if (!plan.changed && !workspaceChanged) return { changed: false, studentId: email };
    const now = nowIso();
    const ops: AllocationOp[] = plan.tokens.map((token) => ({
      kind: 'token' as const,
      cohortId: cohort.id,
      id: token.id,
      data: { ...token, updatedAt: now },
    }));
    const afterWorkspace = {
      ...workspace,
      studentId: email,
      pendingClear: plan.pendingClear,
      selectedInterdisciplinary,
      interdisciplinarySubject: selectedInterdisciplinarySubject,
      updatedAt: now,
    };
    ops.push({
      kind: 'workspace',
      cohortId: cohort.id,
      id: email,
      data: afterWorkspace,
    });
    await app.store.applyAllocationOps(ops);
    const after = plan.changed
      ? plan.tokens.find((token) => token.allocatedTo === email && token.status !== 'available')
      : before;
    await logAllocationDrafts(app, user, cohort.id, [{ studentId: email, before, after, beforeWorkspace: rawWorkspace, afterWorkspace }]);
    return { changed: true, studentId: email, pendingClear: plan.pendingClear };
  });
}

export async function batchDraftAllocations(app: App, cohortId: unknown, staffId: unknown, studentIds: unknown, subjects: unknown, overrideSubject?: unknown) {
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
    active.forEach((id) => {
      const currentToken = tokens.find((token) => token.allocatedTo === id && token.status !== 'available');
      workspaceByStudent.set(
        id,
        workspaceWithLegacyTokenInterdisciplinary(workspaceByStudent.get(id) || emptyWorkspaceRecord(id, ''), currentToken),
      );
    });
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
      selectedInterdisciplinaryByStudent: Object.fromEntries(active.map((id) => [id, workspaceByStudent.get(id)?.selectedInterdisciplinary === true])),
      interdisciplinarySubjectByStudent: Object.fromEntries(active.map((id) => [id, text(workspaceByStudent.get(id)?.interdisciplinarySubject)])),
      overrideSubject: overrideSubject === true,
    });
    const now = nowIso();
    const ops: AllocationOp[] = plan.tokenWrites.map((token) => ({
      kind: 'token' as const,
      cohortId: cohort.id,
      id: token.id,
      data: { ...token, updatedAt: now },
    }));
    Object.keys(plan.pendingClears).forEach((studentId) => {
      const workspace = workspaceByStudent.get(studentId) || emptyWorkspace(studentId, now);
      const afterWorkspace = { ...workspace, pendingClear: plan.pendingClears[studentId], updatedAt: now };
      workspaceByStudent.set(studentId, afterWorkspace);
      ops.push({
        kind: 'workspace',
        cohortId: cohort.id,
        id: studentId,
        data: afterWorkspace,
      });
    });
    if (ops.length) await app.store.applyAllocationOps(ops);
    await logAllocationDrafts(app, user, cohort.id, plan.assigned.map((studentId) => ({
      studentId,
      before: tokens.find((token) => token.allocatedTo === studentId && token.status !== 'available'),
      after: plan.tokenWrites.find((token) => token.allocatedTo === studentId && token.status !== 'available'),
      beforeWorkspace: workspaces.find((workspace) => workspace.studentId === studentId),
      afterWorkspace: workspaceByStudent.get(studentId),
    })));
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
    if (plan.token && plan.token.status === 'draft' && tokens.find((token) => token.id === plan.token!.id)?.status !== 'draft') {
      const currentWorkspace = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
      const workspace = workspaceWithLegacyTokenInterdisciplinary(currentWorkspace, plan.token);
      const now = nowIso();
      await app.store.applyAllocationOps([
        { kind: 'token', cohortId: cohort.id, id: plan.token.id, data: { ...plan.token, updatedAt: now } },
        { kind: 'workspace', cohortId: cohort.id, id: email, data: { ...workspace, studentId: email, updatedAt: now } },
      ]);
    }
    return { studentId: email, status: 'draft' };
  });
}

export async function reopenAllocations(app: App, cohortId: unknown, studentIds: unknown) {
  const user = await requireAdmin(app, 'REOPEN_ALLOCATION');
  const cohort = await requireCohort(app, text(cohortId));
  const ids = Array.isArray(studentIds) ? studentIds.map((id) => normalizeEmail(id)).filter(Boolean) : [];
  if (!ids.length) throw new HubError('Select at least one student.');
  if (ids.length > 1000) throw new HubError('Select no more than 1,000 students at a time.');
  return audited(app, user, 'REOPEN_ALLOCATION', { cohortId: cohort.id, students: ids.length }, async () => {
    const members = await app.store.listMembers(cohort.id);
    const active = new Set(members.filter((member) => isEeActive(member.eeActive)).map((member) => normalizeEmail(member.StudentId)));
    let tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const reopened: string[] = [];
    const skipped: { studentId: string; reason: string }[] = [];
    const writes: TokenRecord[] = [];
    const workspaceWrites = new Map<string, WorkspaceRecord>();
    const workspaces = new Map((await app.store.listWorkspace(cohort.id)).map((doc) => {
      const workspace = workspaceFromDoc(doc, text(doc.id || doc.studentId));
      return [workspace.studentId, workspace] as const;
    }));
    ids.forEach((email) => {
      if (!active.has(email)) {
        skipped.push({ studentId: email, reason: 'This student is not active for allocation.' });
        return;
      }
      const plan = planReopen(tokens, email);
      if (plan.error || !plan.token) {
        skipped.push({ studentId: email, reason: plan.error || 'This student has no allocation to reopen.' });
        return;
      }
      const current = tokens.find((token) => token.id === plan.token!.id);
      if (current && current.status === 'draft') {
        skipped.push({ studentId: email, reason: 'This allocation is already a draft.' });
        return;
      }
      writes.push(plan.token);
      workspaceWrites.set(
        email,
        workspaceWithLegacyTokenInterdisciplinary(workspaces.get(email) || emptyWorkspaceRecord(email, ''), current || plan.token),
      );
      tokens = tokens.map((token) => (token.id === plan.token!.id ? plan.token! : token));
      reopened.push(email);
    });
    if (writes.length) {
      const now = nowIso();
      const ops: AllocationOp[] = writes.map((token) => ({
        kind: 'token' as const,
        cohortId: cohort.id,
        id: token.id,
        data: { ...token, updatedAt: now },
      }));
      workspaceWrites.forEach((workspace, studentId) => {
        ops.push({ kind: 'workspace', cohortId: cohort.id, id: studentId, data: { ...workspace, studentId, updatedAt: now } });
      });
      await app.store.applyAllocationOps(ops);
    }
    return { reopened, skipped };
  });
}

export async function commitAllocations(app: App, cohortId: unknown, studentIds?: unknown) {
  const user = await requireAdmin(app, 'COMMIT_ALLOCATIONS');
  const cohort = await requireCohort(app, text(cohortId));
  const limit = Array.isArray(studentIds) ? studentIds.map((id) => normalizeEmail(id)).filter(Boolean) : undefined;
  if (Array.isArray(studentIds) && !(limit && limit.length)) throw new HubError('Select at least one student.');
  if (limit && limit.length > 1000) throw new HubError('Select no more than 1,000 students at a time.');
  return audited(app, user, 'COMMIT_ALLOCATIONS', { cohortId: cohort.id, students: limit ? limit.length : 'all' }, async () => {
    const members = await app.store.listMembers(cohort.id);
    const byStudent = new Map(members.map((member) => [normalizeEmail(member.StudentId), member]));
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const workspaces = (await app.store.listWorkspace(cohort.id)).map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId)));
    const plan = planCommit(tokens, workspaces, limit);
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
    const writeStudentSubject = (studentId: string, subject: string, interdisciplinary: boolean, interdisciplinarySubject: string) => {
      if (!profileByStudent.get(studentId)) return;
      ops.push({
        kind: 'student',
        id: studentId,
        data: { subject, interdisciplinary, interdisciplinarySubject, Interdisciplinary: interdisciplinary, InterdisciplinarySubject: interdisciplinarySubject },
      });
    };
    plan.assignments.forEach((row) => {
      const token = tokenById.get(row.tokenId);
      const workspace = workspaceWithLegacyTokenInterdisciplinary(
        workspaceByStudent.get(row.studentId) || emptyWorkspaceRecord(row.studentId, now),
        token,
      );
      const subject = publishedAllocationSubject(row.subject, workspace?.subjectChoices, settings.primaryChoiceKey);
      const interdisciplinary = workspace.selectedInterdisciplinary === true;
      const interdisciplinarySubject = interdisciplinary
        ? workspace.interdisciplinarySubject || text(workspace.subjectChoices[settings.secondaryChoiceKey])
        : '';
      const member = {
        ...byStudent.get(row.studentId)!,
        supervisorId: row.staffId,
        subject,
        interdisciplinary,
        interdisciplinarySubject,
        Interdisciplinary: interdisciplinary,
        InterdisciplinarySubject: interdisciplinarySubject,
      };
      ops.push({ kind: 'member', cohortId: cohort.id, id: row.studentId, data: member });
      writeStudentSubject(row.studentId, subject, interdisciplinary, interdisciplinarySubject);
      if (token) ops.push({ kind: 'token', cohortId: cohort.id, id: token.id, data: { ...token, assignedSubject: subject, status: 'committed' } });
      ops.push({
        kind: 'workspace',
        cohortId: cohort.id,
        id: row.studentId,
        data: { ...workspace, studentId: row.studentId, pendingClear: false, updatedAt: now },
      });
    });
    plan.clears.forEach((studentId) => {
      const member = {
        ...byStudent.get(studentId)!,
        supervisorId: '',
        subject: '',
        interdisciplinary: false,
        interdisciplinarySubject: '',
        Interdisciplinary: false,
        InterdisciplinarySubject: '',
      };
      ops.push({ kind: 'member', cohortId: cohort.id, id: studentId, data: member });
      writeStudentSubject(studentId, '', false, '');
      const token = tokens.find((item) => item.allocatedTo === studentId && item.status !== 'available');
      const workspace = workspaceWithLegacyTokenInterdisciplinary(
        workspaceByStudent.get(studentId) || emptyWorkspaceRecord(studentId, now),
        token,
      );
      ops.push({
        kind: 'workspace',
        cohortId: cohort.id,
        id: studentId,
        data: { ...workspace, pendingClear: false, updatedAt: now },
      });
    });
    await app.store.applyAllocationOps(ops);
    return { published: plan.assignments.length, cleared: plan.clears.length };
  });
}

export async function saveAllocationFlag(app: App, cohortId: unknown, studentId: unknown, isFlagged: unknown, flagNote: unknown) {
  const user = await requireAdmin(app, 'SAVE_ALLOCATION_FLAG');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  const flagged = isFlagged === true || text(isFlagged).toLowerCase() === 'true';
  const note = text(flagNote).slice(0, 500);
  return audited(app, user, 'SAVE_ALLOCATION_FLAG', { cohortId: cohort.id, studentId: email, isFlagged: flagged }, async () => {
    await requireActiveMember(app, cohort.id, email);
    const existing = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
    const now = nowIso();
    await app.store.setWorkspace(cohort.id, email, {
      ...existing,
      studentId: email,
      isFlagged: flagged,
      flagNote: note,
      updatedAt: now,
    });
    return { studentId: email, isFlagged: flagged, flagNote: note };
  });
}

export async function saveAllocationChoices(app: App, cohortId: unknown, updates: unknown) {
  const user = await requireAdmin(app, 'SAVE_ALLOCATION_CHOICES');
  const cohort = await requireCohort(app, text(cohortId));
  const rows = Array.isArray(updates) ? updates : [];
  if (!rows.length) throw new HubError('Choose at least one cell to update.');
  if (rows.length > 5000) throw new HubError('Update no more than 5,000 cells at a time.');
  return audited(app, user, 'SAVE_ALLOCATION_CHOICES', { cohortId: cohort.id, cells: rows.length }, async () => {
    const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
    const choiceKeys = new Set(settings.detectedChoiceKeys);
    const dynamicKeys = new Set(settings.detectedDynamicKeys);
    const grouped = new Map<string, { choices: Record<string, string>; dynamic: Record<string, string> }>();
    rows.forEach((row) => {
      const item = row && typeof row === 'object' ? row as Doc : {};
      const studentId = normalizeEmail(item.studentId);
      const key = text(item.key).slice(0, 80);
      if (!studentId || !key) throw new HubError('Each update needs a student and a column.');
      const inChoice = choiceKeys.has(key);
      const inDynamic = dynamicKeys.has(key);
      if (!inChoice && !inDynamic) throw new HubError(`${key} is not a detected column.`);
      let value = text(item.value);
      if (settings.interdisciplinaryKey && key === settings.interdisciplinaryKey) {
        if (value !== 'Yes' && value !== 'No') throw new HubError('Is Interdisciplinary? must be Yes or No.');
      }
      const bucket = grouped.get(studentId) || { choices: {}, dynamic: {} };
      if (inChoice) bucket.choices[key] = value;
      else bucket.dynamic[key] = value;
      grouped.set(studentId, bucket);
    });
    const now = nowIso();
    for (const [studentId, bucket] of grouped) {
      const member = await app.store.getMember(cohort.id, studentId);
      if (!member) throw new HubError(`${studentId} is not on the cohort roster.`);
      const existing = workspaceFromDoc(await app.store.getWorkspace(cohort.id, studentId) || {}, studentId);
      await app.store.setWorkspace(cohort.id, studentId, {
        ...existing,
        studentId,
        subjectChoices: { ...existing.subjectChoices, ...bucket.choices },
        dynamicData: { ...existing.dynamicData, ...bucket.dynamic },
        updatedAt: now,
      });
    }
    return { updated: grouped.size };
  });
}

export async function setAllocationSubject(app: App, cohortId: unknown, studentId: unknown, subject: unknown, clearExistingValue?: unknown) {
  const user = await requireAdmin(app, 'SET_ALLOCATION_SUBJECT');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  const clearExisting = clearExistingValue === true;
  return audited(app, user, 'SET_ALLOCATION_SUBJECT', { cohortId: cohort.id, studentId: email }, async () => {
    await requireActiveMember(app, cohort.id, email);
    const active = activeSubjectNamesFrom(await app.store.list(COLLECTIONS.subjects));
    const raw = text(subject).trim();
    const canonical = raw ? canonicalSubjectName(subject, active) : '';
    const rawWorkspace = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const held = tokens.find((token) => token.allocatedTo === email && token.status !== 'available');
    const existing = workspaceWithLegacyTokenInterdisciplinary(rawWorkspace, held);
    if (held?.status === 'committed') throw new HubError('This allocation is published. Unpublish it before changing the subject.');
    const hasSuggestion = !!(existing.suggestedStaffId || existing.suggestedSubject);
    if ((held || hasSuggestion) && !clearExisting) {
      throw new HubError('Confirm clearing the suggested teacher and/or assigned token before changing the subject.');
    }
    const before = text(existing.selectedSubject);
    if (before.toLowerCase() === canonical.toLowerCase() && !clearExisting) {
      return { studentId: email, selectedSubject: before, suggestedStaffId: existing.suggestedStaffId, suggestedSubject: existing.suggestedSubject };
    }
    const plan = clearExisting ? planDraft({
      studentId: email,
      staffId: '',
      subject: '',
      tokens,
      memberSupervisorId: normalizeEmail((await app.store.getMember(cohort.id, email))?.supervisorId),
      pendingClear: existing.pendingClear,
    }) : { tokens: [], changed: false, pendingClear: existing.pendingClear, error: '' };
    if (plan.error) throw new HubError(plan.error);
    const now = nowIso();
    const next: WorkspaceRecord = {
      ...existing,
      studentId: email,
      selectedSubject: canonical,
      suggestedStaffId: clearExisting ? '' : existing.suggestedStaffId,
      suggestedSubject: clearExisting ? '' : existing.suggestedSubject,
      pendingClear: plan.pendingClear,
      updatedAt: now,
    };
    const ops: AllocationOp[] = plan.tokens.map((token) => ({
      kind: 'token' as const,
      cohortId: cohort.id,
      id: token.id,
      data: { ...token, updatedAt: now },
    }));
    ops.push({ kind: 'workspace', cohortId: cohort.id, id: email, data: next });
    await app.store.applyAllocationOps(ops);
    if (plan.changed) {
      const afterToken = plan.tokens.find((token) => token.allocatedTo === email && token.status !== 'available');
      await logAllocationDrafts(app, user, cohort.id, [{
        studentId: email,
        before: held,
        after: afterToken,
        beforeWorkspace: rawWorkspace,
        afterWorkspace: next,
      }]);
    }
    await logSelectedSubject(app, user, cohort.id, {
      studentId: email,
      before,
      after: canonical,
      beforeSuggestedStaffId: existing.suggestedStaffId,
      beforeSuggestedSubject: existing.suggestedSubject,
    });
    return { studentId: email, selectedSubject: canonical, suggestedStaffId: next.suggestedStaffId, suggestedSubject: next.suggestedSubject, tokenCleared: !!held && plan.changed };
  });
}

export async function suggestAllocation(app: App, cohortId: unknown, studentId: unknown, staffId: unknown) {
  const user = await requireHod(app, 'SUGGEST_ALLOCATION');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  const teacher = normalizeEmail(staffId);
  return audited(app, user, 'SUGGEST_ALLOCATION', { cohortId: cohort.id, studentId: email, staffId: teacher }, async () => {
    await requireActiveMember(app, cohort.id, email);
    const department = await callerDepartment(app, user.email);
    if (!departmentKey(department)) throw new HubError('Your staff record has no primary department.');
    const catalogue = subjectCatalogueFrom(await app.store.list(COLLECTIONS.subjects));
    const existing = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
    if (!existing.selectedSubject) throw new HubError('Choose a subject before suggesting a teacher.');
    const subjectDepartment = departmentOfSubject(existing.selectedSubject, catalogue);
    if (!departmentsMatch(subjectDepartment, department)) throw new HubError('That subject is outside your department.');
    const status = hodStatusFromDoc(await app.store.getHodStatus(cohort.id));
    if (departmentSubmitted(status, department)) throw new HubError('Suggestions for this department are submitted. Reopen them before editing.');
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    if (tokens.some((token) => token.allocatedTo === email && token.status === 'committed')) {
      throw new HubError('This allocation is published. Unpublish it before changing the suggestion.');
    }
    let suggestedStaffId = '';
    let suggestedSubject = '';
    if (teacher) {
      const workspaces = (await app.store.listWorkspace(cohort.id)).map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId)));
      const capacity = suggestionCapacity({
        staffId: teacher,
        subject: existing.selectedSubject,
        tokens,
        suggestions: workspaces.map((workspace) => ({
          studentId: workspace.studentId,
          suggestedStaffId: text(workspace.suggestedStaffId),
          suggestedSubject: text(workspace.suggestedSubject),
        })),
        exceptStudentId: email,
      });
      if (!capacity.eligible) throw new HubError(`${existing.selectedSubject} does not match the supervisor's EE subjects.`);
      if (capacity.remaining <= 0) throw new HubError(`${teacher} has no available slots.`);
      suggestedStaffId = teacher;
      suggestedSubject = existing.selectedSubject;
    }
    const now = nowIso();
    await app.store.setWorkspace(cohort.id, email, {
      ...existing,
      studentId: email,
      suggestedStaffId,
      suggestedSubject,
      updatedAt: now,
    });
    return { studentId: email, suggestedStaffId, suggestedSubject };
  });
}

export async function certifyHodSuggestions(app: App, cohortId: unknown) {
  const user = await requireHod(app, 'CERTIFY_HOD_SUGGESTIONS');
  const cohort = await requireCohort(app, text(cohortId));
  return audited(app, user, 'CERTIFY_HOD_SUGGESTIONS', { cohortId: cohort.id }, async () => {
    const department = await callerDepartment(app, user.email);
    if (!departmentKey(department)) throw new HubError('Your staff record has no primary department.');
    const catalogue = subjectCatalogueFrom(await app.store.list(COLLECTIONS.subjects));
    const display = catalogue.find((item) => departmentsMatch(item.department, department))?.department || department;
    const current = hodStatusFromDoc(await app.store.getHodStatus(cohort.id));
    current.byDepartment[departmentKey(display)] = {
      department: display,
      submitted: true,
      submittedAt: nowIso(),
      submittedBy: user.email,
    };
    await app.store.setHodStatus(cohort.id, current);
    return current;
  });
}

export async function reopenHodSuggestions(app: App, cohortId: unknown, department: unknown) {
  const user = await requireStaff(app, 'REOPEN_HOD_SUGGESTIONS');
  const canAdmin = !!user.permissions?.canAdmin;
  if (!canAdmin && !user.permissions?.isHOD) return deny(app, user, 'REOPEN_HOD_SUGGESTIONS', 'Head of department access required.');
  const cohort = await requireCohort(app, text(cohortId));
  const requested = text(department).trim();
  if (!departmentKey(requested)) throw new HubError('Choose a department.');
  return audited(app, user, 'REOPEN_HOD_SUGGESTIONS', { cohortId: cohort.id, department: requested }, async () => {
    if (!canAdmin) {
      const own = await callerDepartment(app, user.email);
      if (!departmentsMatch(own, requested)) throw new HubError('You can reopen only your own department.');
    }
    const current = hodStatusFromDoc(await app.store.getHodStatus(cohort.id));
    const key = Object.keys(current.byDepartment).find((id) => id === departmentKey(requested) || departmentsMatch(current.byDepartment[id].department, requested));
    if (key) {
      current.byDepartment[key] = {
        ...current.byDepartment[key],
        submitted: false,
        submittedAt: '',
        submittedBy: '',
      };
    }
    await app.store.setHodStatus(cohort.id, current);
    return current;
  });
}

export async function approveAllocationSuggestion(app: App, cohortId: unknown, studentId: unknown) {
  const user = await requireAdmin(app, 'APPROVE_ALLOCATION_SUGGESTION');
  const cohort = await requireCohort(app, text(cohortId));
  const email = normalizeEmail(studentId);
  return audited(app, user, 'APPROVE_ALLOCATION_SUGGESTION', { cohortId: cohort.id, studentId: email }, async () => {
    const member = await requireActiveMember(app, cohort.id, email);
    const tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const rawWorkspace = workspaceFromDoc(await app.store.getWorkspace(cohort.id, email) || {}, email);
    const current = tokens.find((token) => token.allocatedTo === email && token.status !== 'available');
    const workspace = workspaceWithLegacyTokenInterdisciplinary(rawWorkspace, current);
    if (!workspace.suggestedStaffId) throw new HubError('This student has no suggestion to approve.');
    if (!workspace.selectedSubject) throw new HubError('Choose a subject before approving a suggestion.');
    if (current && current.staffId === workspace.suggestedStaffId && current.assignedSubject === workspace.selectedSubject) {
      return { changed: false, studentId: email, suggestedStaffId: workspace.suggestedStaffId };
    }
    const plan = planDraft({
      studentId: email,
      staffId: workspace.suggestedStaffId,
      subject: workspace.selectedSubject,
      tokens,
      memberSupervisorId: normalizeEmail(member.supervisorId),
      pendingClear: workspace.pendingClear,
      interdisciplinary: workspace.selectedInterdisciplinary === true,
      interdisciplinarySubject: workspace.interdisciplinarySubject || '',
    });
    if (plan.error) throw new HubError(plan.error);
    const now = nowIso();
    const ops: AllocationOp[] = plan.tokens.map((token) => ({
      kind: 'token' as const,
      cohortId: cohort.id,
      id: token.id,
      data: { ...token, updatedAt: now },
    }));
    ops.push({
      kind: 'workspace',
      cohortId: cohort.id,
      id: email,
      data: {
        ...workspace,
        studentId: email,
        pendingClear: plan.pendingClear,
        selectedInterdisciplinary: workspace.selectedInterdisciplinary === true,
        interdisciplinarySubject: workspace.interdisciplinarySubject || '',
        updatedAt: now,
      },
    });
    await app.store.applyAllocationOps(ops);
    if (plan.changed) {
      const after = plan.tokens.find((token) => token.allocatedTo === email && token.status !== 'available');
      await logAllocationDrafts(app, user, cohort.id, [{ studentId: email, before: current, after, beforeWorkspace: rawWorkspace, afterWorkspace: workspace }]);
    }
    return { changed: plan.changed, studentId: email, suggestedStaffId: '' };
  });
}

export async function batchApproveAllocationSuggestions(app: App, cohortId: unknown, studentIds: unknown) {
  const user = await requireAdmin(app, 'BATCH_APPROVE_ALLOCATION_SUGGESTIONS');
  const cohort = await requireCohort(app, text(cohortId));
  const ids = Array.isArray(studentIds) ? studentIds.map((id) => normalizeEmail(id)).filter(Boolean) : [];
  if (!ids.length) throw new HubError('Select at least one student.');
  if (ids.length > 1000) throw new HubError('Select no more than 1,000 students at a time.');
  return audited(app, user, 'BATCH_APPROVE_ALLOCATION_SUGGESTIONS', { cohortId: cohort.id, students: ids.length }, async () => {
    const members = await app.store.listMembers(cohort.id);
    const byStudent = new Map(members.map((member) => [normalizeEmail(member.StudentId), member]));
    let tokens = tokensFrom(await app.store.listTokens(cohort.id), cohort.id);
    const workspaces = (await app.store.listWorkspace(cohort.id)).map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId)));
    const workspaceByStudent = new Map(workspaces.map((workspace) => [workspace.studentId, workspace]));
    const assigned: string[] = [];
    const skipped: { studentId: string; reason: string }[] = [];
    const tokenWrites = new Map<string, TokenRecord>();
    const workspaceWrites = new Map<string, WorkspaceRecord>();
    const drafts: { studentId: string; before?: TokenRecord; after?: TokenRecord; beforeWorkspace?: WorkspaceRecord; afterWorkspace?: WorkspaceRecord }[] = [];
    ids.forEach((id) => {
      const member = byStudent.get(id);
      if (!member) {
        skipped.push({ studentId: id, reason: 'Student is not in the selected cohort.' });
        return;
      }
      if (!isEeActive(member.eeActive)) {
        skipped.push({ studentId: id, reason: 'This student is not active for allocation.' });
        return;
      }
      const rawWorkspace = workspaceByStudent.get(id) || emptyWorkspace(id, '');
      const before = tokens.find((token) => token.allocatedTo === id && token.status !== 'available');
      const workspace = workspaceWithLegacyTokenInterdisciplinary(rawWorkspace, before);
      if (!workspace.suggestedStaffId) {
        skipped.push({ studentId: id, reason: 'No suggestion.' });
        return;
      }
      if (!workspace.selectedSubject) {
        skipped.push({ studentId: id, reason: 'Choose a subject before approving a suggestion.' });
        return;
      }
      if (before && before.status === 'committed') {
        skipped.push({ studentId: id, reason: 'This allocation is published. Unpublish it before changing the token.' });
        return;
      }
      if (before && before.staffId === workspace.suggestedStaffId && before.assignedSubject === workspace.selectedSubject) {
        skipped.push({ studentId: id, reason: 'This suggestion is already assigned.' });
        return;
      }
      const plan = planDraft({
        studentId: id,
        staffId: workspace.suggestedStaffId,
        subject: workspace.selectedSubject,
        tokens,
        memberSupervisorId: normalizeEmail(member.supervisorId),
        pendingClear: workspace.pendingClear,
        interdisciplinary: workspace.selectedInterdisciplinary === true,
        interdisciplinarySubject: workspace.interdisciplinarySubject || '',
      });
      if (plan.error) {
        skipped.push({ studentId: id, reason: plan.error });
        return;
      }
      if (plan.changed) {
        plan.tokens.forEach((token) => {
          const index = tokens.findIndex((item) => item.id === token.id);
          if (index >= 0) tokens[index] = token;
          tokenWrites.set(token.id, token);
        });
        drafts.push({
          studentId: id,
          before,
          after: plan.tokens.find((token) => token.allocatedTo === id && token.status !== 'available'),
          beforeWorkspace: rawWorkspace,
          afterWorkspace: { ...workspace, pendingClear: plan.pendingClear },
        });
      }
      const next = {
        ...workspace,
        studentId: id,
        pendingClear: plan.pendingClear,
        selectedInterdisciplinary: workspace.selectedInterdisciplinary === true,
        interdisciplinarySubject: workspace.interdisciplinarySubject || '',
      };
      workspaceByStudent.set(id, next);
      workspaceWrites.set(id, next);
      assigned.push(id);
    });
    const now = nowIso();
    const ops: AllocationOp[] = [...tokenWrites.values()].map((token) => ({
      kind: 'token' as const,
      cohortId: cohort.id,
      id: token.id,
      data: { ...token, updatedAt: now },
    }));
    workspaceWrites.forEach((workspace, studentId) => {
      ops.push({ kind: 'workspace', cohortId: cohort.id, id: studentId, data: { ...workspace, updatedAt: now } });
    });
    if (ops.length) await app.store.applyAllocationOps(ops);
    if (drafts.length) await logAllocationDrafts(app, user, cohort.id, drafts);
    return { assigned, skipped };
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
    const beforeTokens = tokensFrom(await app.store.listTokens(prepared.preview.cohortId), prepared.preview.cohortId);
    await app.store.applyAllocationOps(prepared.ops);
    await logTokenWrites(app, user, prepared.preview.cohortId, beforeTokens, prepared.ops);
    if (prepared.draftChanges.length) await logAllocationDrafts(app, user, prepared.preview.cohortId, prepared.draftChanges);
    return prepared.preview;
  });
}

export async function previewAllocationBackfill(app: App, cohortId: unknown) {
  await requireAdmin(app, 'PREVIEW_ALLOCATION_BACKFILL');
  const cohort = await requireCohort(app, text(cohortId));
  return buildAllocationBackfill(app, cohort.id);
}

export async function applyAllocationBackfill(app: App, cohortId: unknown) {
  const user = await requireAdmin(app, 'APPLY_ALLOCATION_BACKFILL');
  const cohort = await requireCohort(app, text(cohortId));
  return audited(app, user, 'APPLY_ALLOCATION_BACKFILL', { cohortId: cohort.id }, async () => {
    const plan = await buildAllocationBackfill(app, cohort.id);
    const now = nowIso();
    const ops: AllocationOp[] = plan.writes.map((workspace) => ({
      kind: 'workspace' as const,
      cohortId: cohort.id,
      id: workspace.studentId,
      data: { ...workspace, updatedAt: now },
    }));
    if (ops.length) await app.store.applyAllocationOps(ops);
    return {
      cohortId: plan.cohortId,
      drafts: plan.drafts,
      writing: plan.writing,
      skipped: plan.skipped,
      warnings: plan.warnings,
      rows: plan.rows,
    };
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
    const beforeTokens = tokensFrom(await app.store.listTokens(prepared.preview.cohortId), prepared.preview.cohortId);
    await app.store.applyAllocationOps(prepared.ops);
    await logTokenWrites(app, user, prepared.preview.cohortId, beforeTokens, prepared.ops);
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
  const [tokenDocs, staff, subjectDocs, members] = await Promise.all([
    app.store.listTokens(cohort.id),
    app.store.list(COLLECTIONS.staffUsers),
    app.store.list(COLLECTIONS.subjects),
    app.store.listMembers(cohort.id),
  ]);
  const subjects = tokenSubjectCatalogue(subjectDocs);
  const names = new Map(staff.map((person) => [normalizeEmail(person.EMAIL), text(person.DisplayName) || normalizeEmail(person.EMAIL)]));
  const studentNames = new Map(members.map((member) => [normalizeEmail(member.StudentId), text(member['Display Name']) || normalizeEmail(member.StudentId)]));
  members.forEach((member) => {
    const id = normalizeEmail(member.StudentId);
    const surname = text(member.Surname);
    const first = text(member['Preferred Name']) || text(member['First Name']);
    if (id && surname && first) studentNames.set(id, `${surname}, ${first}`);
  });
  const tokens = tokensFrom(tokenDocs, cohort.id)
    .map((token) => ({
      ...token,
      staffName: names.get(token.staffId) || token.staffId,
      studentName: token.allocatedTo ? (studentNames.get(token.allocatedTo) || token.allocatedTo) : '',
    }))
    .sort((left, right) => left.staffName.localeCompare(right.staffName) || left.status.localeCompare(right.status) || left.id.localeCompare(right.id));
  const teachersAllocated = new Set(tokens.filter((token) => token.status !== 'available').map((token) => token.staffId)).size;
  const studentCount = members.filter((member) => normalizeEmail(member.StudentId) && isEeActive(member.eeActive)).length;
  return {
    cohortId: cohort.id,
    tokens,
    summary: { teachersAllocated, tokenCount: tokens.length, studentCount },
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
    await logCreatedTokens(app, user, cohort.id, created);
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
    if (existing.status === 'committed') throw new HubError('This token is published. Unpublish it on the allocation dashboard before editing it.');
    const now = nowIso();
    const ops: AllocationOp[] = [{ kind: 'token', cohortId: cohort.id, id: existing.id, data: { ...existing, eligibleSubjects, updatedAt: now } }];
    if (existing.allocatedTo) {
      const workspace = workspaceWithLegacyTokenInterdisciplinary(
        workspaceFromDoc(await app.store.getWorkspace(cohort.id, existing.allocatedTo) || {}, existing.allocatedTo),
        existing,
      );
      ops.push({ kind: 'workspace', cohortId: cohort.id, id: existing.allocatedTo, data: { ...workspace, updatedAt: now } });
    }
    await app.store.applyAllocationOps(ops);
    await logUpdatedToken(app, user, cohort.id, existing, eligibleSubjects);
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
    if (existing.allocatedTo) {
      const workspace = workspaceWithLegacyTokenInterdisciplinary(
        workspaceFromDoc(await app.store.getWorkspace(cohort.id, existing.allocatedTo) || {}, existing.allocatedTo),
        existing,
      );
      await app.store.setWorkspace(cohort.id, existing.allocatedTo, { ...workspace, updatedAt: nowIso() });
    }
    await app.store.removeToken(cohort.id, existing.id);
    await logRemovedToken(app, user, cohort.id, existing);
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
    const label = kind === 'workspace' ? 'COHORTDATA' : kind === 'drafts' ? 'ALLOCATIONS' : 'SUPERVISORTOKENS';
    throw new HubError(`The spreadsheet has no ${label} tab for ${cohort.id}.`);
  }
  const now = nowIso();
  const settings = settingsFromDoc(await app.store.getAllocationConfig(cohort.id));
  if (kind === 'workspace') return prepareWorkspace(app, cohort.id, grid, spreadsheetId, settings, now);
  if (kind === 'drafts') return prepareDraftSheet(app, cohort.id, grid, spreadsheetId, now);
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
    const workspace: WorkspaceRecord = mergeStaticWorkspaceRow(row, prior, settings, now);
    ops.push({ kind: 'workspace', cohortId, id: row.studentId, data: workspace });
    if (row.eeActive !== null) ops.push({ kind: 'member', cohortId, id: row.studentId, data: { ...member, eeActive: row.eeActive } });
  });
  const next = settingsAfterWorkspaceIngest(settings, parsed.choiceKeys, parsed.dynamicKeys, now);
  ops.push({ kind: 'config', cohortId, data: next });
  const roster = members.map((member) => ({ studentId: normalizeEmail(member.StudentId), eeActive: member.eeActive }));
  return {
    ops,
    draftChanges: [] as { studentId: string; before?: TokenRecord; after?: TokenRecord }[],
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
    draftChanges: [] as { studentId: string; before?: TokenRecord; after?: TokenRecord }[],
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
  return emptyWorkspaceRecord(studentId, now);
}

async function requireAllocationReader(app: App, operation: string) {
  const user = await requireStaff(app, operation);
  if (!user.permissions?.canAdmin && !user.permissions?.isHOD) return deny(app, user, operation, 'Allocation access required.');
  return user;
}

async function requireHod(app: App, operation: string) {
  const user = await requireStaff(app, operation);
  if (!user.permissions?.isHOD) return deny(app, user, operation, 'Head of department access required.');
  return user;
}

async function callerDepartment(app: App, email: string): Promise<string> {
  const staff = await app.store.get(COLLECTIONS.staffUsers, email);
  return text(staff?.['Primary Department']).trim();
}

function departmentSubmitted(status: HodStatusRecord, department: string): boolean {
  const key = departmentKey(department);
  if (!key) return false;
  return Object.values(status.byDepartment).some((row) => row.submitted && departmentsMatch(row.department, department));
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

function ingestKind(value: unknown): 'workspace' | 'tokens' | 'drafts' {
  const kind = text(value).toLowerCase();
  if (kind === 'workspace' || kind === 'tokens' || kind === 'drafts') return kind;
  throw new HubError('Choose student data, allocation drafts, or staff tokens.');
}

async function prepareDraftSheet(app: App, cohortId: string, grid: SheetGrid, spreadsheetId: string, now: string) {
  const parsed = parseAllocationDraftGrid(grid);
  const [members, tokens, workspaceDocs, subjects] = await Promise.all([
    app.store.listMembers(cohortId),
    tokensFrom(await app.store.listTokens(cohortId), cohortId),
    app.store.listWorkspace(cohortId),
    app.store.list(COLLECTIONS.subjects),
  ]);
  const plan = planAllocationDraftIngest({
    rows: parsed.rows,
    tokens,
    workspaces: workspaceDocs.map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId))),
    roster: members.map((member) => ({ studentId: normalizeEmail(member.StudentId), supervisorId: normalizeEmail(member.supervisorId) })),
    activeSubjects: activeSubjectNamesFrom(subjects),
    now,
  });
  const ops: AllocationOp[] = [
    ...plan.tokenWrites.map((token) => ({ kind: 'token' as const, cohortId, id: token.id, data: { ...token, updatedAt: now } })),
    ...plan.workspaceWrites.map((workspace) => ({ kind: 'workspace' as const, cohortId, id: workspace.studentId, data: workspace })),
  ];
  return {
    ops,
    draftChanges: plan.draftChanges,
    preview: ingestPreview({
      cohortId,
      kind: 'drafts',
      spreadsheetId,
      sheet: grid.title,
      incoming: parsed.rows.length,
      existing: workspaceDocs.length,
      writing: plan.writing,
      skipped: plan.skipped,
      creating: 0,
      warnings: parsed.warnings.concat(plan.warnings),
      rows: plan.rows,
      note: WORKSPACE_SHEET_HELP.draftNote,
    }),
  };
}

async function buildAllocationBackfill(app: App, cohortId: string) {
  const [members, tokens, workspaceDocs, subjects] = await Promise.all([
    app.store.listMembers(cohortId),
    tokensFrom(await app.store.listTokens(cohortId), cohortId),
    app.store.listWorkspace(cohortId),
    app.store.list(COLLECTIONS.subjects),
  ]);
  const plan = planDraftTokenBackfill({
    tokens,
    workspaces: workspaceDocs.map((doc) => workspaceFromDoc(doc, text(doc.id || doc.studentId))),
    roster: members.map((member) => ({ studentId: normalizeEmail(member.StudentId) })),
    activeSubjects: activeSubjectNamesFrom(subjects),
    now: nowIso(),
  });
  return { cohortId, ...plan };
}

export { emptySettings };
