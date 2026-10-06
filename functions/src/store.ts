import { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from './schema';
import { cleanDoc, Doc, text } from './util';

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
