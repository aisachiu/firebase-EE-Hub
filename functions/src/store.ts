import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from './schema';
import { cleanDoc, Doc, text } from './util';

export type AllocationOp =
  | { kind: 'member'; cohortId: string; id: string; data: Doc }
  | { kind: 'token'; cohortId: string; id: string; data: Doc }
  | { kind: 'workspace'; cohortId: string; id: string; data: Doc }
  | { kind: 'config'; cohortId: string; data: Doc };

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
  }

  async removeMember(cohortId: string, email: string): Promise<void> {
    await this.members(cohortId).doc(email).delete();
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
    await this.tokens(cohortId).doc(id).set(cleanDoc(data));
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

  async applyAllocationOps(ops: AllocationOp[]): Promise<void> {
    const size = 400;
    for (let index = 0; index < ops.length; index += size) {
      const batch = this.db.batch();
      ops.slice(index, index + size).forEach((op) => {
        if (op.kind === 'member') batch.set(this.members(op.cohortId).doc(op.id), cleanDoc(op.data));
        else if (op.kind === 'token') batch.set(this.tokens(op.cohortId).doc(op.id), cleanDoc(op.data));
        else if (op.kind === 'workspace') batch.set(this.workspace(op.cohortId).doc(op.id), cleanDoc(op.data));
        else batch.set(this.allocationConfig(op.cohortId), cleanDoc(op.data));
      });
      await batch.commit();
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
}
