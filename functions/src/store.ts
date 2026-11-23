import { Firestore, Transaction } from 'firebase-admin/firestore';
import { nextDocCommentSyncWrite, pairRecordId } from './docCommentsPure';
import { COLLECTIONS } from './schema';
import { cleanDoc, Doc, HubError, normalizeEmail, parseDriveId, text, toBoolean } from './util';
import { milestoneAssignmentScope } from './milestoneManagement';
import { actionStudentId, actionTemplateId, creatorKind } from './actionIdentifiers';
import { isDeepStrictEqual } from 'node:util';

function tokenWithoutInterdisciplinary(data: Doc): Doc {
  const token = { ...data };
  delete token.interdisciplinary;
  delete token.Interdisciplinary;
  delete token.interdisciplinarySubject;
  delete token.InterdisciplinarySubject;
  delete token.legacySelectedInterdisciplinary;
  delete token.legacyInterdisciplinarySubject;
  return token;
}

export type AllocationOp =
  | { kind: 'member'; cohortId: string; id: string; data: Doc }
  | { kind: 'token'; cohortId: string; id: string; data: Doc }
  | { kind: 'workspace'; cohortId: string; id: string; data: Doc }
  | { kind: 'config'; cohortId: string; data: Doc }
  | { kind: 'student'; id: string; data: Doc };

export class Store {
  constructor(public db: Firestore) {}

  private col(name: string) {
    return this.db.collection(name);
  }

  async list(name: string): Promise<Doc[]> {
    const snap = await this.col(name).get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async get(name: string, id: string): Promise<Doc | null> {
    if (!id) return null;
    const snap = await this.col(name).doc(id).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async set(name: string, id: string, data: Doc): Promise<void> {
    await this.col(name).doc(id).set(cleanDoc(data));
  }

  async remove(name: string, id: string): Promise<void> {
    await this.col(name).doc(id).delete();
  }

  private milestoneActionQueries(milestoneId: string) {
    return ['TemplateId', 'templateId', 'MilestoneId', 'milestoneId'].map((field) =>
      this.col(COLLECTIONS.studentActionItems).where(field, '==', milestoneId));
  }

  private async milestoneActionDocuments(milestoneId: string, transaction?: Transaction) {
    const snapshots = await Promise.all(this.milestoneActionQueries(milestoneId).map((query) =>
      transaction ? transaction.get(query) : query.get()));
    return [...new Map(snapshots.flatMap((snapshot) => snapshot.docs).map((doc) => [doc.id, doc])).values()];
  }

  async listMilestoneActionItems(milestoneId: string): Promise<Doc[]> {
    return (await this.milestoneActionDocuments(milestoneId)).map((doc) => doc.data() as Doc);
  }

  async manageCohortMilestoneAssignments(cohortId: string, milestoneId: string, signature: string, action: 'reset' | 'delete' | 'archive', actor: string, now: string, selectedIds?: string[]): Promise<number> {
    return this.db.runTransaction(async (transaction) => {
      const [milestone, members, tasks] = await Promise.all([
        transaction.get(this.cohortMilestones(cohortId).doc(milestoneId)),
        transaction.get(this.members(cohortId)),
        this.milestoneActionDocuments(milestoneId, transaction),
      ]);
      if (!milestone.exists) throw new HubError('Milestone not found. Refresh and try again.');
      const scope = milestoneAssignmentScope(tasks.map((doc) => doc.data() as Doc), members.docs.map((doc) => doc.data() as Doc), cohortId, milestoneId);
      if (scope.signature !== signature) throw new HubError('Assignments changed since the preview. Refresh the preview and try again.');
      const selected = selectedIds ? new Set(selectedIds) : null;
      if (selected && (selected.size !== selectedIds!.length || [...selected].some((id) => !scope.assignments.some((row) => row.taskId === id)))) {
        throw new HubError('The selected assignments changed. Refresh the preview and try again.');
      }
      const assignments = scope.assignments.filter((row) => !selected || selected.has(row.taskId));
      const byId = new Map(tasks.map((doc) => [doc.id, doc]));
      for (const assignment of assignments) {
        const doc = byId.get(assignment.taskId);
        const record = doc?.data();
        if (!doc || !record || text(record.TaskId) !== assignment.taskId || actionStudentId(record) !== assignment.studentId
          || text(record.cohortId) !== assignment.cohortId || actionTemplateId(record) !== milestoneId || creatorKind(record) !== assignment.creator) {
          throw new HubError('An action item TaskId does not match its document ID. Correct it before managing this milestone.');
        }
        if (action === 'archive') {
          const archive = this.cohortMilestoneArchives(cohortId).doc();
          transaction.create(archive, { task: record, milestone: milestone.data(), archivedAt: now, archivedBy: actor });
          transaction.delete(doc.ref);
        } else if (action === 'delete') transaction.delete(doc.ref);
        else transaction.update(doc.ref, { Status: 'Pending', LastUpdated: now, UpdatedBy: actor });
      }

      return assignments.length;
    });
  }

  async deleteUnassignedCohortMilestone(cohortId: string, milestoneId: string): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const ref = this.cohortMilestones(cohortId).doc(milestoneId);
      const [milestone, members, tasks] = await Promise.all([
        transaction.get(ref),
        transaction.get(this.members(cohortId)),
        this.milestoneActionDocuments(milestoneId, transaction),
      ]);
      if (!milestone.exists) throw new HubError('Record not found.');
      const scope = milestoneAssignmentScope(tasks.map((doc) => doc.data() as Doc), members.docs.map((doc) => doc.data() as Doc), cohortId, milestoneId);
      if (scope.assignments.length || scope.excluded.some((row) => row.reason === 'legacy')) throw new HubError('This milestone has assigned action items or ambiguous legacy assignments and cannot be deleted.');
      transaction.delete(ref);
    });
  }

  private cohortMilestoneArchives(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('milestoneAssignmentArchive');
  }

  async listCohortMilestoneArchives(cohortId: string) {
    const snapshot = await this.cohortMilestoneArchives(cohortId).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async restoreCohortMilestoneAssignment(cohortId: string, archiveId: string): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const archiveRef = this.cohortMilestoneArchives(cohortId).doc(archiveId);
      const archive = await transaction.get(archiveRef);
      if (!archive.exists) throw new HubError('Archive entry not found. Refresh and try again.');
      const data = archive.data() as Doc;
      const task = data.task as Doc;
      const originalMilestone = data.milestone as Doc;
      const taskId = text(task?.TaskId);
      const milestoneId = actionTemplateId(task || {});
      const phaseId = text(originalMilestone?.phase);
      if (!taskId || !milestoneId || !phaseId || [taskId, milestoneId, phaseId].some((id) => id.includes('/')) || text(task?.cohortId) !== cohortId || text(originalMilestone?.milestoneId) !== milestoneId) {
        throw new HubError('This archive entry is invalid and cannot be restored.');
      }
      const taskRef = this.col(COLLECTIONS.studentActionItems).doc(taskId);
      const milestoneRef = this.cohortMilestones(cohortId).doc(milestoneId);
      const phaseRef = this.cohortPhases(cohortId).doc(phaseId);
      const [existingTask, milestone, phase, members, tasks, milestones] = await Promise.all([
        transaction.get(taskRef), transaction.get(milestoneRef), transaction.get(phaseRef),
        transaction.get(this.members(cohortId)), this.milestoneActionDocuments(milestoneId, transaction), transaction.get(this.cohortMilestones(cohortId)),
      ]);
      if (existingTask.exists) throw new HubError('An assignment with this ID already exists. Restore stopped.');
      if (!phase.exists || !toBoolean(phase.data()?.active)) throw new HubError('The original phase is missing or inactive. Restore it before restoring this assignment.');
      if (milestone.exists && !isDeepStrictEqual(milestone.data(), originalMilestone)) {
        throw new HubError('The milestone has changed since archiving. Restore stopped to avoid attaching progress to a different milestone.');
      }
      if (!milestone.exists && toBoolean(originalMilestone.isAnchor) && milestones.docs.some((doc) => toBoolean(doc.data().isAnchor))) {
        throw new HubError('Another milestone is now the anchor. Resolve the anchor before restoring this assignment.');
      }
      const scope = milestoneAssignmentScope(tasks.map((doc) => doc.data() as Doc), members.docs.map((doc) => doc.data() as Doc), cohortId, milestoneId);
      const student = actionStudentId(task);
      const identities = members.docs.map((doc) => doc.data() as Doc);
      const member = identities.find((row) => [row.StudentId, row['Student Email']].some((value) => normalizeEmail(value) === student));
      const aliases = new Set([student, normalizeEmail(member?.StudentId), normalizeEmail(member?.['Student Email'])].filter(Boolean));
      if (scope.assignments.some((row) => aliases.has(row.studentId)) || scope.excluded.some((row) => row.reason === 'legacy' && aliases.has(row.studentId))) {
        throw new HubError('This student already has an assignment for the milestone. Restore stopped.');
      }
      if (!milestone.exists) transaction.create(milestoneRef, originalMilestone);
      transaction.create(taskRef, task);
      transaction.delete(archiveRef);
    });
  }

  async whereEqual(name: string, field: string, value: unknown): Promise<Doc[]> {
    const snap = await this.col(name).where(field, '==', value).get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async findBy(name: string, field: string, value: unknown): Promise<Doc | null> {
    const rows = await this.whereEqual(name, field, value);
    return rows[0] || null;
  }

  members(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('members');
  }

  async listMembers(cohortId: string): Promise<Doc[]> {
    const snap = await this.members(cohortId).get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const snap = await this.members(cohortId).doc(email).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setMember(cohortId: string, email: string, data: Doc): Promise<void> {
    await this.members(cohortId).doc(email).set(cleanDoc(data));
    await this.enrollDocCommentSync(cohortId, data);
  }

  async removeMember(cohortId: string, email: string): Promise<void> {
    await this.members(cohortId).doc(email).delete();
    const studentId = normalizeEmail(email);
    if (!studentId) return;
    const rows = await this.whereEqual(COLLECTIONS.docCommentSync, 'StudentId', studentId);
    for (const row of rows) {
      if (text(row.Cohort) !== text(cohortId)) continue;
      const id = text(row.Id);
      if (id) await this.remove(COLLECTIONS.docCommentSync, id);
    }
  }

  /** One small index row per essay Doc so the daily sweep can query due cursors. */
  private async enrollDocCommentSync(cohortId: string, member: Doc): Promise<void> {
    const studentId = normalizeEmail(member.StudentId);
    const docUrl = text(member.EEDoc);
    const fileId = parseDriveId(docUrl);
    if (!studentId || !fileId) return;
    const id = pairRecordId(studentId, fileId);
    const existing = await this.get(COLLECTIONS.docCommentSync, id);
    const next = nextDocCommentSyncWrite(existing, { studentId, cohortId, fileId, docUrl });
    if (next) await this.set(COLLECTIONS.docCommentSync, id, next);
  }

  async listDueDocCommentSync(nowMs: number, limit: number): Promise<Doc[]> {
    const cap = Math.max(0, Math.floor(limit));
    if (!cap) return [];
    const snap = await this.col(COLLECTIONS.docCommentSync)
      .where('DueAt', '<=', nowMs)
      .orderBy('DueAt')
      .orderBy('LastAttemptAt')
      .limit(cap)
      .get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async countFreshDocCommentSync(nowMs: number): Promise<number> {
    const snap = await this.col(COLLECTIONS.docCommentSync).where('DueAt', '>', nowMs).count().get();
    return snap.data().count;
  }

  cohortPhases(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('phases');
  }

  async listCohortPhases(cohortId: string): Promise<Doc[]> {
    const snap = await this.cohortPhases(cohortId).get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async getCohortPhase(cohortId: string, phaseId: string): Promise<Doc | null> {
    if (!cohortId || !phaseId) return null;
    const snap = await this.cohortPhases(cohortId).doc(phaseId).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setCohortPhase(cohortId: string, phaseId: string, data: Doc): Promise<void> {
    await this.cohortPhases(cohortId).doc(phaseId).set(cleanDoc(data));
  }

  async removeCohortPhase(cohortId: string, phaseId: string): Promise<void> {
    await this.cohortPhases(cohortId).doc(phaseId).delete();
  }

  cohortMilestones(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('milestones');
  }

  async listCohortMilestones(cohortId: string): Promise<Doc[]> {
    const snap = await this.cohortMilestones(cohortId).get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async getCohortMilestone(cohortId: string, milestoneId: string): Promise<Doc | null> {
    if (!cohortId || !milestoneId) return null;
    const snap = await this.cohortMilestones(cohortId).doc(milestoneId).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setCohortMilestone(cohortId: string, milestoneId: string, data: Doc): Promise<void> {
    await this.cohortMilestones(cohortId).doc(milestoneId).set(cleanDoc(data));
  }

  async removeCohortMilestone(cohortId: string, milestoneId: string): Promise<void> {
    await this.cohortMilestones(cohortId).doc(milestoneId).delete();
  }

  tokens(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('supervisorTokens');
  }

  async listTokens(cohortId: string): Promise<Doc[]> {
    const snap = await this.tokens(cohortId).get();
    return snap.docs.map((doc) => ({ ...(doc.data() as Doc), id: doc.id }));
  }

  async getToken(cohortId: string, id: string): Promise<Doc | null> {
    if (!id) return null;
    const snap = await this.tokens(cohortId).doc(id).get();
    return snap.exists ? ({ ...(snap.data() as Doc), id: snap.id }) : null;
  }

  async setToken(cohortId: string, id: string, data: Doc): Promise<void> {
    await this.tokens(cohortId).doc(id).set(cleanDoc(tokenWithoutInterdisciplinary(data)));
  }

  async removeToken(cohortId: string, id: string): Promise<void> {
    await this.tokens(cohortId).doc(id).delete();
  }

  workspace(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('allocationWorkspace');
  }

  async listWorkspace(cohortId: string): Promise<Doc[]> {
    const snap = await this.workspace(cohortId).get();
    return snap.docs.map((doc) => ({ ...(doc.data() as Doc), id: doc.id }));
  }

  async getWorkspace(cohortId: string, studentId: string): Promise<Doc | null> {
    if (!studentId) return null;
    const snap = await this.workspace(cohortId).doc(studentId).get();
    return snap.exists ? ({ ...(snap.data() as Doc), id: snap.id }) : null;
  }

  async setWorkspace(cohortId: string, studentId: string, data: Doc): Promise<void> {
    await this.workspace(cohortId).doc(studentId).set(cleanDoc(data));
  }

  async updateWorkspace(cohortId: string, studentId: string, data: Doc): Promise<void> {
    await this.workspace(cohortId).doc(studentId).set(cleanDoc(data), { merge: true });
  }

  allocationConfig(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('allocationConfig').doc('settings');
  }

  async getAllocationConfig(cohortId: string): Promise<Doc | null> {
    const snap = await this.allocationConfig(cohortId).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setAllocationConfig(cohortId: string, data: Doc): Promise<void> {
    await this.allocationConfig(cohortId).set(cleanDoc(data));
  }

  hodStatus(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('allocationConfig').doc('hodStatus');
  }

  async getHodStatus(cohortId: string): Promise<Doc | null> {
    const snap = await this.hodStatus(cohortId).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setHodStatus(cohortId: string, data: Doc): Promise<void> {
    await this.hodStatus(cohortId).set(cleanDoc(data));
  }

  allocationAudits(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('allocationAuditLogs');
  }

  async listAllocationAudits(cohortId: string): Promise<Doc[]> {
    if (!cohortId) return [];
    const snap = await this.allocationAudits(cohortId).get();
    return snap.docs.map((doc) => ({ ...(doc.data() as Doc), id: doc.id }));
  }

  async setAllocationAudit(cohortId: string, id: string, data: Doc): Promise<void> {
    await this.allocationAudits(cohortId).doc(id).set(cleanDoc(data));
  }

  async removeAllocationAudit(cohortId: string, id: string): Promise<void> {
    await this.allocationAudits(cohortId).doc(id).delete();
  }

  async applyAllocationOps(ops: AllocationOp[]): Promise<void> {
    const size = 400;
    for (let index = 0; index < ops.length; index += size) {
      const batch = this.db.batch();
      const slice = ops.slice(index, index + size);
      slice.forEach((op) => {
        if (op.kind === 'member') batch.set(this.members(op.cohortId).doc(op.id), cleanDoc(op.data));
        else if (op.kind === 'token') batch.set(this.tokens(op.cohortId).doc(op.id), cleanDoc(tokenWithoutInterdisciplinary(op.data)));
        else if (op.kind === 'workspace') batch.set(this.workspace(op.cohortId).doc(op.id), cleanDoc(op.data));
        else if (op.kind === 'student') batch.set(this.col(COLLECTIONS.studentUsers).doc(op.id), cleanDoc(op.data), { merge: true });
        else batch.set(this.allocationConfig(op.cohortId), cleanDoc(op.data));
      });
      await batch.commit();
      for (const op of slice) {
        if (op.kind === 'member') await this.enrollDocCommentSync(op.cohortId, op.data);
      }
    }
  }

  async allMembers(): Promise<{ cohortId: string; member: Doc }[]> {
    const cohorts = await this.list(COLLECTIONS.cohorts);
    const rows = await Promise.all(cohorts.map(async (cohort) => {
      const cohortId = text(cohort.Cohort);
      const members = await this.listMembers(cohortId);
      return members.map((member) => ({ cohortId, member }));
    }));
    return rows.flat();
  }

  messages(ticketId: string) {
    return this.db.collection(COLLECTIONS.tickets).doc(ticketId).collection('messages');
  }

  async listMessages(ticketId: string): Promise<Doc[]> {
    const snap = await this.messages(ticketId).get();
    return snap.docs
      .map((doc) => doc.data() as Doc)
      .sort((left, right) => text(left.CreatedAt).localeCompare(text(right.CreatedAt)));
  }

  async addMessage(ticketId: string, messageId: string, data: Doc): Promise<void> {
    await this.messages(ticketId).doc(messageId).set(cleanDoc(data));
  }

  async removeMessage(ticketId: string, messageId: string): Promise<void> {
    await this.messages(ticketId).doc(messageId).delete();
  }

  chats(cohortId: string) {
    return this.db.collection(COLLECTIONS.cohorts).doc(cohortId).collection('chats');
  }

  chatEntries(cohortId: string, studentId: string) {
    return this.chats(cohortId).doc(studentId).collection('entries');
  }

  async getChat(cohortId: string, studentId: string): Promise<Doc | null> {
    if (!cohortId || !studentId) return null;
    const snap = await this.chats(cohortId).doc(studentId).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setChat(cohortId: string, studentId: string, data: Doc): Promise<void> {
    await this.chats(cohortId).doc(studentId).set(cleanDoc(data));
  }

  async listChats(cohortId: string): Promise<Doc[]> {
    if (!cohortId) return [];
    const snap = await this.chats(cohortId).get();
    return snap.docs.map((doc) => doc.data() as Doc);
  }

  async listChatEntries(cohortId: string, studentId: string): Promise<Doc[]> {
    if (!cohortId || !studentId) return [];
    const snap = await this.chatEntries(cohortId, studentId).get();
    return snap.docs
      .map((doc) => doc.data() as Doc)
      .sort((left, right) => text(left.CreatedAt).localeCompare(text(right.CreatedAt)) || text(left.EntryId).localeCompare(text(right.EntryId)));
  }

  async setChatEntry(cohortId: string, studentId: string, entryId: string, data: Doc): Promise<void> {
    await this.chatEntries(cohortId, studentId).doc(entryId).set(cleanDoc(data));
  }

  async addAudit(entry: Doc): Promise<void> {
    await this.col(COLLECTIONS.auditLogs).add(cleanDoc(entry));
  }

  async getMeta(id: string): Promise<Doc | null> {
    const snap = await this.db.collection('meta').doc(id).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setMeta(id: string, data: Doc): Promise<void> {
    await this.db.collection('meta').doc(id).set(cleanDoc(data));
  }

  settings(id: string) {
    return this.db.collection('settings').doc(id);
  }

  async getSettings(id: string): Promise<Doc | null> {
    if (!id) return null;
    const snap = await this.settings(id).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setSettings(id: string, data: Doc): Promise<void> {
    await this.settings(id).set(cleanDoc(data));
  }

  reflectionNotes(cohortId: string, email: string) {
    return this.members(cohortId).doc(email).collection('reflectionNotes');
  }

  async listReflectionNotes(cohortId: string, email: string): Promise<Doc[]> {
    if (!cohortId || !email) return [];
    const snap = await this.reflectionNotes(cohortId, email).get();
    return snap.docs.map((doc) => {
      const data = doc.data() as Doc;
      return { ...data, noteId: text(data.noteId) || doc.id };
    });
  }

  async getReflectionNote(cohortId: string, email: string, noteId: string): Promise<Doc | null> {
    if (!cohortId || !email || !noteId) return null;
    const snap = await this.reflectionNotes(cohortId, email).doc(noteId).get();
    return snap.exists ? (snap.data() as Doc) : null;
  }

  async setReflectionNote(cohortId: string, email: string, noteId: string, data: Doc): Promise<void> {
    await this.reflectionNotes(cohortId, email).doc(noteId).set(cleanDoc(data));
  }
}
