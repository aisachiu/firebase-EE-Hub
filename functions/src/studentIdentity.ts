import { COLLECTIONS } from './schema';
import { Store } from './store';
import { Doc, normalizeEmail, text } from './util';

/** Google account used to sign in. Primary key across student records. */
export const STUDENT_ID_FIELD = 'StudentId';
/** School identifier. Record-keeping only; not used for sign-in or sharing. */
export const STUDENT_NUMBER_FIELD = 'Student Number';
/** Workspace and mail address. May differ from StudentId. */
export const STUDENT_EMAIL_FIELD = 'Student Email';

const LEGACY_STUDENT_NUMBER_FIELD = 'Student ID';
const LEGACY_STUDENT_EMAIL_FIELD = 'studentEmail';

function hasOwn(record: Doc, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** School number. A stored Student Number wins over the older Student ID column. */
export function canonicalStudentNumber(record: Doc | null | undefined): string {
  if (!record) return '';
  if (hasOwn(record, STUDENT_NUMBER_FIELD)) return text(record[STUDENT_NUMBER_FIELD]);
  return text(record[LEGACY_STUDENT_NUMBER_FIELD]);
}

/**
 * Communication address. Never falls back to StudentId.
 * An explicit Student Email, even blank, wins over the older studentEmail field.
 */
export function canonicalStudentEmail(record: Doc | null | undefined): string {
  if (!record) return '';
  if (hasOwn(record, STUDENT_EMAIL_FIELD)) return normalizeEmail(record[STUDENT_EMAIL_FIELD]);
  return normalizeEmail(record[LEGACY_STUDENT_EMAIL_FIELD]);
}

export function studentLoginId(record: Doc | null | undefined): string {
  return normalizeEmail(record?.[STUDENT_ID_FIELD]);
}

/** Copy legacy keys onto the canonical fields and drop the old names. */
export function writeStudentIdentifiers(record: Doc): Doc {
  const number = canonicalStudentNumber(record);
  const email = canonicalStudentEmail(record);
  if (number) record[STUDENT_NUMBER_FIELD] = number;
  else delete record[STUDENT_NUMBER_FIELD];
  if (email) record[STUDENT_EMAIL_FIELD] = email;
  else delete record[STUDENT_EMAIL_FIELD];
  delete record[LEGACY_STUDENT_NUMBER_FIELD];
  delete record[LEGACY_STUDENT_EMAIL_FIELD];
  return record;
}

/** Show canonical fields in admin tables without rewriting the stored document. */
export function presentStoredIdentifiers(record: Doc): Doc {
  const copy = { ...record };
  if (!text(copy[STUDENT_NUMBER_FIELD]) && text(copy[LEGACY_STUDENT_NUMBER_FIELD])) {
    copy[STUDENT_NUMBER_FIELD] = text(copy[LEGACY_STUDENT_NUMBER_FIELD]);
  }
  if (!normalizeEmail(copy[STUDENT_EMAIL_FIELD]) && normalizeEmail(copy[LEGACY_STUDENT_EMAIL_FIELD])) {
    copy[STUDENT_EMAIL_FIELD] = normalizeEmail(copy[LEGACY_STUDENT_EMAIL_FIELD]);
  }
  return copy;
}

export function canonicalStudentHeader(header: string, knownNames: string[]): string {
  if (header === LEGACY_STUDENT_NUMBER_FIELD && knownNames.includes(STUDENT_NUMBER_FIELD)) return STUDENT_NUMBER_FIELD;
  if (header === LEGACY_STUDENT_EMAIL_FIELD && knownNames.includes(STUDENT_EMAIL_FIELD)) return STUDENT_EMAIL_FIELD;
  return header;
}

/** Copy Student Number and Student Email from a cohort member onto an existing student user. */
export async function syncStudentUserFromMember(store: Store, member: Doc): Promise<boolean> {
  const studentId = studentLoginId(member);
  if (!studentId) return false;
  const existing = await store.get(COLLECTIONS.studentUsers, studentId);
  if (!existing) return false;
  const next: Doc = {
    ...existing,
    [STUDENT_ID_FIELD]: studentId,
    [STUDENT_NUMBER_FIELD]: canonicalStudentNumber(member),
    [STUDENT_EMAIL_FIELD]: canonicalStudentEmail(member),
  };
  delete next[LEGACY_STUDENT_NUMBER_FIELD];
  delete next[LEGACY_STUDENT_EMAIL_FIELD];
  if (hasOwn(member, 'subject')) next.subject = text(member.subject);
  await store.set(COLLECTIONS.studentUsers, studentId, next);
  return true;
}

/** Keep a published EE subject when a sheet row does not include that column. */
export function keepPublishedSubject(incoming: Doc, previous: Doc | null | undefined): Doc {
  if (hasOwn(incoming, 'subject')) return incoming;
  if (!previous || !hasOwn(previous, 'subject')) return incoming;
  return { ...incoming, subject: text(previous.subject) };
}
