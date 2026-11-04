import {
  emptyWorkspaceRecord,
  planDraft,
  studentLabel,
  subjectsOverlap,
  tokenFromDoc,
  TokenRecord,
  workspaceFromDoc,
  WorkspaceRecord,
} from './allocationPure';
import { requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, requireAdmin } from './session';
import { AllocationOp } from './store';
import { HubUser } from './permissions';
import { Doc, HubError, normalizeEmail, nowIso, shortId, text } from './util';

type AuditKind = 'allocation' | 'token-add' | 'token-update' | 'token-remove';

interface AuditWriter {
  allocation(input: { studentId: string; before?: TokenRecord; after?: TokenRecord }): Promise<void>;
  tokenAdd(token: TokenRecord): Promise<void>;
  tokenUpdate(before: TokenRecord, eligibleSubjects: string[]): Promise<void>;
  tokenRemove(token: TokenRecord): Promise<void>;
}

function sameSubjects(left: string[], right: string[]): boolean {
  const a = left.map((item) => item.toLowerCase()).sort();
  const b = right.map((item) => item.toLowerCase()).sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function assignmentBypass(token: TokenRecord | undefined): boolean {
  if (!token || !token.assignedSubject) return false;
  return !subjectsOverlap(token.assignedSubject, token.eligibleSubjects || []);
}

function snapshotToken(token: TokenRecord): Doc {
  return {
    id: token.id,
    cohortId: token.cohortId,
    staffId: token.staffId,
    eligibleSubjects: token.eligibleSubjects.slice(),
    allocatedTo: token.allocatedTo || '',
    assignedSubject: token.assignedSubject || '',
    interdisciplinary: token.interdisciplinary === true,
    interdisciplinarySubject: token.interdisciplinarySubject || '',
    status: token.status,
    createdAt: token.createdAt || '',
  };
}

function subjectList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function emptyWorkspace(studentId: string, now: string): WorkspaceRecord {
  return emptyWorkspaceRecord(studentId, now);
}

function tokensFrom(docs: Doc[], cohortId: string): TokenRecord[] {
  return docs
    .map((doc) => tokenFromDoc({ ...doc, cohortId: text(doc.cohortId) || cohortId }))
    .filter((token): token is TokenRecord => !!token);
}

async function startAuditWriter(app: App, user: HubUser, cohortId: string): Promise<AuditWriter> {
  const [staffList, members, existing] = await Promise.all([
    app.store.list(COLLECTIONS.staffUsers),
    app.store.listMembers(cohortId),
    app.store.listAllocationAudits(cohortId),
  ]);
  const staffNames = new Map(staffList.map((person) => [normalizeEmail(person.EMAIL), text(person.DisplayName) || normalizeEmail(person.EMAIL)]));
  const studentNames = new Map<string, string>();
  members.forEach((member) => {
    const id = normalizeEmail(member.StudentId);
    if (id) studentNames.set(id, studentLabel(member) || id);
  });
  let seq = existing.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
  const write = async (entry: Doc) => {
    seq += 1;
    const id = shortId('aud');
    await app.store.setAllocationAudit(cohortId, id, {
      ...entry,
      id,
      cohortId,
      seq,
      at: nowIso(),
      userEmail: user.email,
      userName: user.displayName || user.email,
    });
  };
  const teacherName = (staffId: string) => staffNames.get(normalizeEmail(staffId)) || normalizeEmail(staffId);
  const studentName = (studentId: string) => studentNames.get(normalizeEmail(studentId)) || normalizeEmail(studentId);
  return {
    async allocation(input) {
      const before = input.before;
      const after = input.after;
      if (!before && !after) return;
      const clearing = !after;
      const teacherId = clearing ? (before?.staffId || '') : after.staffId;
      const subject = clearing ? (before?.assignedSubject || '') : (after.assignedSubject || '');
      await write({
        kind: 'allocation' satisfies AuditKind,
        action: clearing ? 'Unallocated' : 'Allocated',
        studentId: normalizeEmail(input.studentId),
        studentName: studentName(input.studentId),
        subject,
        teacherId: normalizeEmail(teacherId),
        teacher: teacherId ? teacherName(teacherId) : '',
        beforeStaffId: before?.staffId || '',
        beforeSubject: before?.assignedSubject || '',
        beforeInterdisciplinary: before?.interdisciplinary === true,
        beforeInterdisciplinarySubject: before?.interdisciplinary === true ? (before.interdisciplinarySubject || '') : '',
        beforeBypass: assignmentBypass(before),
      });
    },
    async tokenAdd(token) {
      await write(tokenEntry('token-add', 'Token added', token, teacherName, studentName));
    },
    async tokenUpdate(before, eligibleSubjects) {
      if (sameSubjects(before.eligibleSubjects, eligibleSubjects)) return;
      await write({
        ...tokenEntry('token-update', 'Token updated', { ...before, eligibleSubjects: eligibleSubjects.slice() }, teacherName, studentName),
        beforeSubjects: before.eligibleSubjects.slice(),
      });
    },
    async tokenRemove(token) {
      await write(tokenEntry('token-remove', 'Token removed', token, teacherName, studentName));
    },
  };
}

function tokenEntry(
  kind: AuditKind,
  action: string,
  token: TokenRecord,
  teacherName: (staffId: string) => string,
  studentName: (studentId: string) => string,
): Doc {
  const subject = token.assignedSubject || token.eligibleSubjects.join(', ');
  return {
    kind,
    action,
    studentId: token.allocatedTo || '',
    studentName: token.allocatedTo ? studentName(token.allocatedTo) : '',
    subject,
    teacherId: token.staffId,
    teacher: teacherName(token.staffId),
    tokenId: token.id,
    tokenSnapshot: snapshotToken(token),
  };
}

export async function logAllocationDrafts(
  app: App,
  user: HubUser,
  cohortId: string,
  changes: { studentId: string; before?: TokenRecord; after?: TokenRecord }[],
): Promise<void> {
  const rows = changes.filter((change) => change.before || change.after);
  if (!rows.length) return;
  const writer = await startAuditWriter(app, user, cohortId);
  for (const change of rows) await writer.allocation(change);
}

export async function logCreatedTokens(app: App, user: HubUser, cohortId: string, tokens: TokenRecord[]): Promise<void> {
  if (!tokens.length) return;
  const writer = await startAuditWriter(app, user, cohortId);
  for (const token of tokens) await writer.tokenAdd(token);
}

export async function logUpdatedToken(app: App, user: HubUser, cohortId: string, before: TokenRecord, eligibleSubjects: string[]): Promise<void> {
  const writer = await startAuditWriter(app, user, cohortId);
  await writer.tokenUpdate(before, eligibleSubjects);
}

export async function logRemovedToken(app: App, user: HubUser, cohortId: string, token: TokenRecord): Promise<void> {
  const writer = await startAuditWriter(app, user, cohortId);
  await writer.tokenRemove(token);
}

export async function logTokenWrites(app: App, user: HubUser, cohortId: string, before: TokenRecord[], ops: AllocationOp[]): Promise<void> {
  const tokenOps = ops.filter((op): op is Extract<AllocationOp, { kind: 'token' }> => op.kind === 'token');
  if (!tokenOps.length) return;
  const writer = await startAuditWriter(app, user, cohortId);
  for (const op of tokenOps) {
    const previous = before.find((token) => token.id === op.id);
    const next = tokenFromDoc({ ...op.data, id: op.id, cohortId });
    if (!next) continue;
    if (!previous) await writer.tokenAdd(next);
    else await writer.tokenUpdate(previous, next.eligibleSubjects);
  }
}

export async function readAllocationAudits(app: App, cohortId: string): Promise<Doc[]> {
  const rows = await app.store.listAllocationAudits(cohortId);
  return rows.slice().sort((left, right) => Number(left.seq) - Number(right.seq) || text(left.at).localeCompare(text(right.at)) || text(left.id).localeCompare(text(right.id)));
}

function tokenSignature(token: TokenRecord): string {
  return [
    token.staffId,
    token.status,
    token.allocatedTo,
    token.assignedSubject,
    token.interdisciplinary ? '1' : '0',
    token.interdisciplinarySubject,
    token.eligibleSubjects.join('|'),
  ].join('~');
}

export async function undoAllocationAudit(app: App, cohortId: unknown, logId: unknown): Promise<{ undone: number }> {
  const user = await requireAdmin(app, 'UNDO_ALLOCATION_AUDIT');
  const cohort = await requireCohort(app, text(cohortId));
  const id = text(logId);
  if (!id) throw new HubError('Choose an audit entry.');
  return audited(app, user, 'UNDO_ALLOCATION_AUDIT', { cohortId: cohort.id, logId: id }, async () => {
    const rows = await readAllocationAudits(app, cohort.id);
    const target = rows.find((row) => text(row.id) === id);
    if (!target) throw new HubError('That audit entry is no longer in the log.');
    const targetSeq = Number(target.seq) || 0;
    const slice = rows.filter((row) => (Number(row.seq) || 0) >= targetSeq);
    const reverse = slice.slice().sort((left, right) => (Number(right.seq) || 0) - (Number(left.seq) || 0) || text(right.id).localeCompare(text(left.id)));
    const members = await app.store.listMembers(cohort.id);
    const memberBy = new Map(members.map((member) => [normalizeEmail(member.StudentId), member]));
    const original = tokensFrom(await app.store.listTokens(cohort.id), cohort.id).map((token) => ({ ...token, eligibleSubjects: token.eligibleSubjects.slice() }));
    let working = original.map((token) => ({ ...token, eligibleSubjects: token.eligibleSubjects.slice() }));
    const workspaceDocs = await app.store.listWorkspace(cohort.id);
    const workspaceBy = new Map(workspaceDocs.map((doc) => {
      const workspace = workspaceFromDoc(doc, text(doc.id || doc.studentId));
      return [workspace.studentId, workspace] as const;
    }));
    const dirty = new Set<string>();
    const now = nowIso();
    const replaceTokens = (updates: TokenRecord[]) => {
      const map = new Map(working.map((token) => [token.id, token]));
      updates.forEach((token) => map.set(token.id, { ...token, eligibleSubjects: token.eligibleSubjects.slice() }));
      working = [...map.values()];
    };
    for (const entry of reverse) {
      const kind = text(entry.kind);
      if (kind === 'allocation') {
        const studentId = normalizeEmail(entry.studentId);
        if (!studentId) throw new HubError('That audit entry has no student.');
        const plan = planDraft({
          studentId,
          staffId: normalizeEmail(entry.beforeStaffId),
          subject: text(entry.beforeSubject),
          tokens: working,
          memberSupervisorId: normalizeEmail(memberBy.get(studentId)?.supervisorId),
          pendingClear: workspaceBy.get(studentId)?.pendingClear === true,
          interdisciplinary: entry.beforeInterdisciplinary === true,
          interdisciplinarySubject: text(entry.beforeInterdisciplinarySubject),
          bypassSubject: entry.beforeBypass === true,
        });
        if (plan.error) throw new HubError(plan.error);
        if (!plan.changed) continue;
        replaceTokens(plan.tokens);
        const current = workspaceBy.get(studentId) || emptyWorkspace(studentId, now);
        if (current.pendingClear !== plan.pendingClear) {
          workspaceBy.set(studentId, { ...current, pendingClear: plan.pendingClear, updatedAt: now });
          dirty.add(studentId);
        }
        continue;
      }
      if (kind === 'token-add') {
        const tokenId = text(entry.tokenId);
        const current = working.find((token) => token.id === tokenId);
        if (!current) continue;
        if (current.status === 'committed') throw new HubError('This token is published. Unpublish it before undoing.');
        if (current.status !== 'available') throw new HubError('A token added in this range is still allocated.');
        working = working.filter((token) => token.id !== tokenId);
        continue;
      }
      if (kind === 'token-update') {
        const tokenId = text(entry.tokenId);
        const current = working.find((token) => token.id === tokenId);
        if (!current) throw new HubError('A token in this undo no longer exists.');
        if (current.status === 'committed') throw new HubError('This token is published. Unpublish it before undoing.');
        replaceTokens([{ ...current, eligibleSubjects: subjectList(entry.beforeSubjects) }]);
        continue;
      }
      if (kind === 'token-remove') {
        const restored = tokenFromDoc({ ...(entry.tokenSnapshot && typeof entry.tokenSnapshot === 'object' ? entry.tokenSnapshot as Doc : {}), cohortId: cohort.id });
        if (!restored) throw new HubError('That token change cannot be undone.');
        if (working.some((token) => token.id === restored.id)) throw new HubError('That token is already on the cohort.');
        working.push({ ...restored, eligibleSubjects: restored.eligibleSubjects.slice() });
        continue;
      }
      throw new HubError('That audit entry cannot be undone.');
    }
    const originalById = new Map(original.map((token) => [token.id, token]));
    const finalById = new Map(working.map((token) => [token.id, token]));
    const ops: AllocationOp[] = [];
    finalById.forEach((token, tokenId) => {
      const previous = originalById.get(tokenId);
      if (previous && tokenSignature(previous) === tokenSignature(token)) return;
      ops.push({ kind: 'token', cohortId: cohort.id, id: tokenId, data: { ...token, updatedAt: now } });
    });
    dirty.forEach((studentId) => {
      const workspace = workspaceBy.get(studentId);
      if (!workspace) return;
      ops.push({ kind: 'workspace', cohortId: cohort.id, id: studentId, data: workspace });
    });
    if (ops.length) await app.store.applyAllocationOps(ops);
    for (const tokenId of originalById.keys()) {
      if (!finalById.has(tokenId)) await app.store.removeToken(cohort.id, tokenId);
    }
    for (const entry of slice) {
      const entryId = text(entry.id);
      if (entryId) await app.store.removeAllocationAudit(cohort.id, entryId);
    }
    return { undone: slice.length };
  });
}
