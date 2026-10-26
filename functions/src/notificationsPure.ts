import { HubUser } from './permissions';
import { addDays, HubError, normalizeEmail, parseActionDate, serializeDateOnly, text, toBoolean } from './util';

export type NotifyWhen = 'before' | 'on' | 'after';
export type NotifyAudience = 'owner' | 'coordinator';
export type NotifyKind = 'cohort' | 'overlay';

export interface SweepTask {
  taskId: string;
  studentId: string;
  templateId: string;
  dueDate: string;
  status: string;
  creatorType: string;
  title: string;
}

export interface SweepStudent {
  cohortId: string;
  /** Login StudentId. Used to match tasks, not to address mail. */
  email: string;
  /** Student Email. Gmail uses this and never the login StudentId. */
  studentEmail: string;
  displayName: string;
  supervisorId: string;
}

export interface SweepTemplate {
  milestoneId: string;
  title: string;
  mOwner: string;
  cohortId?: string;
}

export interface SweepStaff {
  email: string;
  isStaff: boolean;
  isLead: boolean;
  isCoordinator: boolean;
  isAdmin: boolean;
}

export interface SweepRule {
  ruleId: string;
  kind: NotifyKind;
  cohortId: string;
  milestoneId: string;
  supervisorId: string;
  studentId: string;
  when: NotifyWhen;
  days: number;
  audience: NotifyAudience;
  enabled: boolean;
  note: string;
}

export interface PlannedSend {
  sendId: string;
  ruleId: string;
  ruleKind: NotifyKind;
  taskId: string;
  triggerDay: string;
  cohortId: string;
  milestoneId: string;
  milestoneTitle: string;
  studentId: string;
  studentEmail: string;
  studentName: string;
  dueDate: string;
  when: NotifyWhen;
  days: number;
  audience: NotifyAudience;
  mOwner: string;
  supervisorId: string;
  recipients: string[];
  note: string;
  subject: string;
  body: string;
}

export interface PlannedSkip {
  sendId: string;
  ruleId: string;
  ruleKind: NotifyKind;
  taskId: string;
  studentId: string;
  reason: string;
}

export interface SweepPlan {
  today: string;
  sends: PlannedSend[];
  skipped: PlannedSkip[];
}

export interface SendLogState {
  status?: string;
  sentAt?: string;
}

const WHEN: NotifyWhen[] = ['before', 'on', 'after'];
const AUDIENCE: NotifyAudience[] = ['owner', 'coordinator'];
const FRESH_SEND_MS = 15 * 60 * 1000;

export function notificationPowers(user: HubUser | null): {
  browse: boolean;
  editRules: boolean;
  editOwnOverlays: boolean;
  runSweep: boolean;
} {
  const staff = !!user && user.role === 'staff';
  const editRules = staff && !!user?.permissions?.canAdmin;
  return {
    browse: staff,
    editRules,
    editOwnOverlays: staff && !!user?.permissions?.isSupervisor,
    runSweep: editRules,
  };
}

export function normalizeTiming(when: unknown, days: unknown): { when: NotifyWhen; days: number } {
  const timing = text(when).toLowerCase() as NotifyWhen;
  if (!WHEN.includes(timing)) throw new HubError('Choose before, on, or after the due date.');
  if (timing === 'on') return { when: 'on', days: 0 };
  const count = Number(days);
  if (!Number.isInteger(count) || count < 1 || count > 365) throw new HubError('Days must be a whole number from 1 to 365.');
  return { when: timing, days: count };
}

export function normalizeAudience(value: unknown): NotifyAudience {
  const audience = text(value).toLowerCase() as NotifyAudience;
  if (!AUDIENCE.includes(audience)) throw new HubError('Choose the milestone owner or the coordinator.');
  return audience;
}

export function normalizeEnabled(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return toBoolean(value);
}

export function requireEnabledFlag(value: unknown): boolean {
  if (value === true || value === false) return value;
  const token = text(value).toLowerCase();
  if (['true', '1', 'yes'].includes(token)) return true;
  if (['false', '0', 'no'].includes(token)) return false;
  throw new HubError('Choose whether this reminder is on.');
}

export function cleanNote(value: unknown): string {
  const note = text(value);
  if (note.length > 1000) throw new HubError('The note must be 1,000 characters or fewer.');
  return note;
}

export function triggerDay(dueDate: string, when: NotifyWhen, days: number): string {
  const due = parseActionDate(dueDate);
  if (!due) return '';
  const shift = when === 'before' ? -Math.abs(days) : when === 'after' ? Math.abs(days) : 0;
  return serializeDateOnly(addDays(due, shift));
}

export function sendKey(ruleKind: string, ruleId: string, taskId: string, triggerDayValue: string): string {
  return `${ruleKind}_${ruleId}_${taskId}_${triggerDayValue}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 700);
}

export function newlyEmailedStudent(studentId: string, before: string[], after: string[]): boolean {
  const student = normalizeEmail(studentId);
  if (!student) return false;
  const prior = new Set(before.map((email) => normalizeEmail(email)));
  const delivered = new Set(after.map((email) => normalizeEmail(email)));
  return delivered.has(student) && !prior.has(student);
}

export function sendVisibleTo(powers: { editRules: boolean; editOwnOverlays: boolean }, email: string, send: { ruleKind: string; supervisorId?: string }): boolean {
  if (text(send.ruleKind) !== 'overlay') return true;
  if (powers.editRules || !powers.editOwnOverlays) return true;
  return normalizeEmail(send.supervisorId) === normalizeEmail(email);
}

export function sendIsBlocked(existing: SendLogState | null, now: Date): boolean {
  if (!existing) return false;
  if (existing.status === 'sent') return true;
  if (existing.status !== 'sending') return false;
  const then = Date.parse(existing.sentAt || '');
  return isFinite(then) && now.getTime() - then < FRESH_SEND_MS;
}

export function timingLabel(when: NotifyWhen, days: number): string {
  if (when === 'on' || days === 0) return 'On the due date';
  const unit = days === 1 ? 'day' : 'days';
  if (when === 'before') return `${days} ${unit} before the due date`;
  return `${days} ${unit} after the due date`;
}

export function audienceLabel(audience: NotifyAudience, mOwner: string): string {
  if (audience === 'coordinator') return 'Coordinator only';
  if (mOwner === 'student') return 'Milestone owner · student';
  if (mOwner === 'supervisor') return 'Milestone owner · assigned supervisor';
  if (mOwner === 'lead') return 'Milestone owner · EE lead';
  if (mOwner === 'coordinator') return 'Milestone owner · coordinator';
  return 'Milestone owner';
}

export function audienceHint(audience: NotifyAudience, mOwner: string): string {
  if (audience === 'coordinator') return 'The email goes only to coordinators and admins. The milestone owner is not copied.';
  if (mOwner === 'supervisor') return 'The email goes to the supervisor assigned on the cohort roster.';
  if (mOwner === 'lead') return 'The email goes to staff marked as EE lead.';
  if (mOwner === 'coordinator') return 'The email goes to coordinators and admins, because they own this milestone.';
  return 'The email goes to the Student Email on the cohort roster.';
}

export function buildMessage(input: {
  audience: NotifyAudience;
  milestoneTitle: string;
  studentName: string;
  dueDate: string;
  when: NotifyWhen;
  days: number;
  note: string;
  test?: boolean;
}): { subject: string; body: string } {
  const title = text(input.milestoneTitle) || 'Milestone';
  const studentName = text(input.studentName) || 'Student';
  const prefix = input.audience === 'coordinator' ? 'EE coordinator notice' : 'EE reminder';
  const subject = `${input.test ? '[Test] ' : ''}${prefix}: ${title} · ${studentName}`;
  const lines = [
    input.test
      ? 'This is a test sent only to you. The usual recipients were not emailed.'
      : input.audience === 'coordinator'
        ? `This is a coordinator notice for ${studentName}.`
        : 'This reminder is for the milestone owner.',
    '',
    `${studentName} — ${title}`,
    `Due date: ${input.dueDate || 'not set'}`,
    `Timing: ${timingLabel(input.when, input.days)}`,
  ];
  if (text(input.note)) lines.push('', text(input.note));
  lines.push('', 'Open the EE Hub to review this milestone.');
  return { subject, body: lines.join('\n') };
}

function uniqueEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  values.forEach((value) => {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) return;
    seen.add(email);
    out.push(email);
  });
  return out;
}

export function recipientEmails(audience: NotifyAudience, mOwner: string, student: SweepStudent, staff: SweepStaff[]): string[] {
  const active = staff.filter((person) => person.isStaff && person.email);
  const coordinators = uniqueEmails(active.filter((person) => person.isCoordinator || person.isAdmin).map((person) => person.email));
  const leads = uniqueEmails(active.filter((person) => person.isLead).map((person) => person.email));
  if (audience === 'coordinator') return coordinators;
  const owner = text(mOwner).toLowerCase();
  if (owner === 'supervisor') return uniqueEmails([student.supervisorId]);
  if (owner === 'lead') return leads;
  if (owner === 'coordinator') return coordinators;
  return uniqueEmails([student.studentEmail]);
}

export function planSweep(input: {
  today: string;
  tasks: SweepTask[];
  students: SweepStudent[];
  templates: SweepTemplate[];
  staff: SweepStaff[];
  rules: SweepRule[];
  blockedSendIds?: Set<string>;
  cohortSets?: string[];
}): SweepPlan {
  const shared = new Map<string, SweepTemplate>();
  const scoped = new Map<string, SweepTemplate>();
  input.templates.forEach((template) => {
    if (template.cohortId) scoped.set(`${template.cohortId}|${template.milestoneId}`, template);
    else shared.set(template.milestoneId, template);
  });
  const cohortSets = new Set(input.cohortSets || []);
  const tasksByStudent = new Map<string, SweepTask[]>();
  input.tasks.forEach((task) => {
    if (text(task.creatorType) !== 'System') return;
    const email = normalizeEmail(task.studentId);
    const templateId = text(task.templateId);
    if (!email || !templateId) return;
    const bucket = tasksByStudent.get(`${email}|${templateId}`) || [];
    bucket.push(task);
    tasksByStudent.set(`${email}|${templateId}`, bucket);
  });
  const studentsByCohort = new Map<string, SweepStudent[]>();
  input.students.forEach((student) => {
    const cohortId = text(student.cohortId);
    const email = normalizeEmail(student.email);
    if (!cohortId || !email) return;
    const bucket = studentsByCohort.get(cohortId) || [];
    bucket.push({
      ...student,
      email,
      studentEmail: normalizeEmail(student.studentEmail),
      supervisorId: normalizeEmail(student.supervisorId),
    });
    studentsByCohort.set(cohortId, bucket);
  });

  const sends: PlannedSend[] = [];
  const skipped: PlannedSkip[] = [];
  const blocked = input.blockedSendIds || new Set<string>();

  input.rules.filter((rule) => rule.enabled).forEach((rule) => {
    const template = cohortSets.has(rule.cohortId)
      ? scoped.get(`${rule.cohortId}|${rule.milestoneId}`)
      : (scoped.get(`${rule.cohortId}|${rule.milestoneId}`) || shared.get(rule.milestoneId));
    const roster = studentsByCohort.get(rule.cohortId) || [];
    roster.forEach((student) => {
      if (rule.kind === 'overlay') {
        if (!rule.supervisorId || student.supervisorId !== normalizeEmail(rule.supervisorId)) return;
        if (rule.studentId && normalizeEmail(rule.studentId) !== student.email) return;
      }
      const tasks = tasksByStudent.get(`${student.email}|${rule.milestoneId}`) || [];
      if (!template) {
        skipped.push({ sendId: '', ruleId: rule.ruleId, ruleKind: rule.kind, taskId: '', studentId: student.email, reason: 'Milestone template is missing.' });
        return;
      }
      if (!tasks.length) {
        skipped.push({ sendId: '', ruleId: rule.ruleId, ruleKind: rule.kind, taskId: '', studentId: student.email, reason: 'No milestone task for this student.' });
        return;
      }
      tasks.forEach((task) => {
        const dueDate = text(task.dueDate).slice(0, 10);
        const fireOn = triggerDay(dueDate, rule.when, rule.days);
        if (!fireOn || fireOn !== input.today) return;
        const sendId = sendKey(rule.kind, rule.ruleId, task.taskId, fireOn);
        if (text(task.status).toLowerCase() === 'completed') {
          skipped.push({ sendId, ruleId: rule.ruleId, ruleKind: rule.kind, taskId: task.taskId, studentId: student.email, reason: 'Milestone is already completed.' });
          return;
        }
        if (blocked.has(sendId)) {
          skipped.push({ sendId, ruleId: rule.ruleId, ruleKind: rule.kind, taskId: task.taskId, studentId: student.email, reason: 'Already sent for this trigger day.' });
          return;
        }
        const recipients = recipientEmails(rule.audience, template.mOwner, student, input.staff);
        if (!recipients.length) {
          skipped.push({ sendId, ruleId: rule.ruleId, ruleKind: rule.kind, taskId: task.taskId, studentId: student.email, reason: 'No recipient for this milestone owner.' });
          return;
        }
        const message = buildMessage({
          audience: rule.audience,
          milestoneTitle: template.title || task.title,
          studentName: student.displayName,
          dueDate,
          when: rule.when,
          days: rule.days,
          note: rule.note,
        });
        sends.push({
          sendId,
          ruleId: rule.ruleId,
          ruleKind: rule.kind,
          taskId: task.taskId,
          triggerDay: fireOn,
          cohortId: rule.cohortId,
          milestoneId: rule.milestoneId,
          milestoneTitle: template.title || task.title,
          studentId: student.email,
          studentEmail: student.studentEmail,
          studentName: student.displayName || student.email,
          dueDate,
          when: rule.when,
          days: rule.days,
          audience: rule.audience,
          mOwner: template.mOwner,
          supervisorId: rule.kind === 'overlay' ? normalizeEmail(rule.supervisorId) : '',
          recipients,
          note: rule.note,
          subject: message.subject,
          body: message.body,
        });
      });
    });
  });

  return { today: input.today, sends, skipped };
}
