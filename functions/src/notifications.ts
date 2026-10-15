import { createGmailMailer, gmailConfigured, gmailSender, Mailer } from './gmail';
import { HubUser } from './permissions';
import {
  audienceHint,
  audienceLabel,
  buildMessage,
  cleanNote,
  normalizeAudience,
  normalizeEnabled,
  normalizeTiming,
  notificationPowers,
  NotifyAudience,
  NotifyKind,
  NotifyWhen,
  PlannedSend,
  newlyEmailedStudent,
  planSweep,
  requireEnabledFlag,
  sendIsBlocked,
  sendVisibleTo,
  SweepPlan,
  SweepRule,
  SweepStaff,
  SweepStudent,
  SweepTask,
  SweepTemplate,
  timingLabel,
} from './notificationsPure';
import { listCohorts, placementFromMember, requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audit, audited, deny, requireStaff } from './session';
import { clockParts, Doc, HubError, normalizeEmail, nowIso, serializeDateOnly, text, toBoolean, uuid } from './util';

const ITEM_LIMIT = 200;

interface RuleInput {
  ruleId?: unknown;
  cohortId?: unknown;
  milestoneId?: unknown;
  when?: unknown;
  days?: unknown;
  audience?: unknown;
  enabled?: unknown;
  note?: unknown;
  studentId?: unknown;
}

export interface DeskRule {
  ruleId: string;
  kind: NotifyKind;
  cohortId: string;
  milestoneId: string;
  milestoneTitle: string;
  mOwner: string;
  supervisorId: string;
  studentId: string;
  when: NotifyWhen;
  days: number;
  audience: NotifyAudience;
  enabled: boolean;
  note: string;
  timingLabel: string;
  audienceLabel: string;
  audienceHint: string;
}

export interface SweepSummary {
  dryRun: boolean;
  today: string;
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
  gmailConfigured: boolean;
  items: Array<{
    studentName: string;
    studentId: string;
    milestoneTitle: string;
    recipients: string[];
    subject: string;
    timing: string;
    audience: string;
    status: string;
    error: string;
  }>;
}

function asInput(value: unknown): RuleInput {
  if (!value || typeof value !== 'object') return {};
  return value as RuleInput;
}

function ruleFromDoc(doc: Doc, kind: NotifyKind): SweepRule | null {
  const ruleId = text(kind === 'overlay' ? doc.overlayId || doc.ruleId : doc.ruleId);
  const timing = text(doc.when).toLowerCase();
  const audience = text(doc.audience).toLowerCase();
  if (!ruleId || !text(doc.cohortId) || !text(doc.milestoneId)) return null;
  if (timing !== 'before' && timing !== 'on' && timing !== 'after') return null;
  if (audience !== 'owner' && audience !== 'coordinator') return null;
  return {
    ruleId,
    kind,
    cohortId: text(doc.cohortId),
    milestoneId: text(doc.milestoneId),
    supervisorId: normalizeEmail(doc.supervisorId),
    studentId: normalizeEmail(doc.studentId),
    when: timing,
    days: timing === 'on' ? 0 : Number(doc.days) || 0,
    audience,
    enabled: toBoolean(doc.enabled),
    note: text(doc.note),
  };
}

async function loadTemplates(app: App): Promise<SweepTemplate[]> {
  const records = await app.store.list(COLLECTIONS.milestoneTemplates);
  return records.map((record) => ({
    milestoneId: text(record.milestoneId),
    title: text(record.milestoneTitle),
    mOwner: text(record.mOwner).toLowerCase(),
  })).filter((template) => template.milestoneId);
}

async function loadStaff(app: App): Promise<SweepStaff[]> {
  const records = await app.store.list(COLLECTIONS.staffUsers);
  return records.map((record) => ({
    email: normalizeEmail(record.EMAIL),
    isStaff: toBoolean(record.isStaff),
    isLead: toBoolean(record.isLead),
    isCoordinator: toBoolean(record.isCoordinator),
    isAdmin: toBoolean(record.isAdmin),
  })).filter((person) => person.email);
}

async function loadTasks(app: App): Promise<SweepTask[]> {
  const records = await app.store.list(COLLECTIONS.studentActionItems);
  return records.map((record) => ({
    taskId: text(record.TaskId),
    studentId: normalizeEmail(record.StudentId),
    templateId: text(record.TemplateId),
    dueDate: text(record.DueDate).slice(0, 10),
    status: text(record.Status),
    creatorType: text(record.CreatorType),
    title: text(record.Title),
  })).filter((task) => task.taskId);
}

async function loadStudents(app: App, cohortIds: string[]): Promise<SweepStudent[]> {
  const rows: SweepStudent[] = [];
  for (const cohortId of cohortIds) {
    const members = await app.store.listMembers(cohortId);
    members.forEach((member) => {
      const placement = placementFromMember(cohortId, member);
      if (!placement.email) return;
      rows.push({
        cohortId,
        email: placement.email,
        displayName: placement.displayName,
        supervisorId: placement.supervisorId,
      });
    });
  }
  return rows;
}

async function loadRules(app: App): Promise<SweepRule[]> {
  const [rules, overlays] = await Promise.all([
    app.store.list(COLLECTIONS.notificationRules),
    app.store.list(COLLECTIONS.notificationOverlays),
  ]);
  return [
    ...rules.map((doc) => ruleFromDoc(doc, 'cohort')).filter((rule): rule is SweepRule => !!rule),
    ...overlays.map((doc) => ruleFromDoc(doc, 'overlay')).filter((rule): rule is SweepRule => !!rule),
  ];
}

function presentRule(rule: SweepRule, templates: Map<string, SweepTemplate>): DeskRule {
  const template = templates.get(rule.milestoneId);
  const mOwner = template?.mOwner || '';
  return {
    ...rule,
    milestoneTitle: template?.title || rule.milestoneId,
    mOwner,
    timingLabel: timingLabel(rule.when, rule.days),
    audienceLabel: audienceLabel(rule.audience, mOwner),
    audienceHint: audienceHint(rule.audience, mOwner),
  };
}

function sortRules(left: DeskRule, right: DeskRule): number {
  const title = left.milestoneTitle.localeCompare(right.milestoneTitle);
  if (title) return title;
  const order = { before: 0, on: 1, after: 2 };
  const when = order[left.when] - order[right.when];
  if (when) return when;
  return left.days - right.days;
}

export async function listNotificationDesk(app: App, cohortId: unknown, milestoneId: unknown) {
  const user = await requireStaff(app, 'LIST_NOTIFICATIONS');
  const powers = notificationPowers(user);
  const cohorts = await listCohorts(app, true);
  let selectedCohort = text(cohortId);
  if (selectedCohort && !cohorts.some((cohort) => cohort.id === selectedCohort)) {
    throw new HubError('Cohort not found.');
  }
  if (!selectedCohort) selectedCohort = cohorts[0]?.id || '';
  const milestoneFilter = text(milestoneId);
  const templates = await loadTemplates(app);
  const templateMap = new Map(templates.map((template) => [template.milestoneId, template]));
  const rules = (await loadRules(app))
    .filter((rule) => !selectedCohort || rule.cohortId === selectedCohort)
    .filter((rule) => !milestoneFilter || rule.milestoneId === milestoneFilter)
    .filter((rule) => rule.kind === 'cohort' || powers.editRules || !powers.editOwnOverlays || rule.supervisorId === user.email)
    .map((rule) => presentRule(rule, templateMap))
    .sort(sortRules);
  const students = selectedCohort
    ? (await app.store.listMembers(selectedCohort))
      .map((member) => placementFromMember(selectedCohort, member))
      .filter((student) => student.email)
      .map((student) => ({
        email: student.email,
        displayName: student.displayName,
        supervisorId: student.supervisorId,
      }))
    : [];
  return {
    access: powers,
    actorEmail: user.email,
    cohortId: selectedCohort,
    milestoneId: milestoneFilter,
    cohorts: cohorts.map((cohort) => ({ id: cohort.id, name: cohort.name, status: cohort.status })),
    milestones: templates
      .map((template) => ({ milestoneId: template.milestoneId, title: template.title, mOwner: template.mOwner }))
      .sort((left, right) => left.title.localeCompare(right.title) || left.milestoneId.localeCompare(right.milestoneId)),
    rules: rules.filter((rule) => rule.kind === 'cohort'),
    overlays: rules.filter((rule) => rule.kind === 'overlay'),
    students,
    sends: await loadSendLog(app, user.email, powers, selectedCohort, milestoneFilter, templateMap),
    gmail: {
      configured: gmailConfigured(),
      sender: gmailSender(),
      dryRun: toBoolean(process.env.EE_NOTIFICATIONS_DRY_RUN),
    },
  };
}

async function requireMilestone(app: App, milestoneId: string): Promise<SweepTemplate> {
  const template = (await loadTemplates(app)).find((item) => item.milestoneId === milestoneId);
  if (!template) throw new HubError('Choose a milestone.');
  return template;
}

function storedRule(ruleId: string, input: {
  cohortId: string;
  milestoneId: string;
  when: NotifyWhen;
  days: number;
  audience: NotifyAudience;
  enabled: boolean;
  note: string;
  actor: string;
  existing: Doc | null;
  supervisorId?: string;
  studentId?: string;
}): Doc {
  const now = nowIso();
  const identity = input.supervisorId !== undefined
    ? { overlayId: ruleId, supervisorId: input.supervisorId, studentId: input.studentId || '' }
    : { ruleId };
  return {
    ...identity,
    cohortId: input.cohortId,
    milestoneId: input.milestoneId,
    when: input.when,
    days: input.days,
    audience: input.audience,
    enabled: input.enabled,
    note: input.note,
    createdBy: input.existing ? normalizeEmail(input.existing.createdBy) || input.actor : input.actor,
    updatedBy: input.actor,
    createdAt: input.existing ? text(input.existing.createdAt) || now : now,
    updatedAt: now,
  };
}

export async function saveNotificationRule(app: App, raw: unknown) {
  const user = await requireStaff(app, 'SAVE_NOTIFICATION_RULE');
  if (!notificationPowers(user).editRules) return deny(app, user, 'SAVE_NOTIFICATION_RULE', 'Coordinators manage cohort email rules.');
  const input = asInput(raw);
  const timing = normalizeTiming(input.when, input.days);
  const audience = normalizeAudience(input.audience);
  const note = cleanNote(input.note);
  const enabled = normalizeEnabled(input.enabled, true);
  const cohort = await requireCohort(app, text(input.cohortId), true);
  const milestoneId = text(input.milestoneId);
  await requireMilestone(app, milestoneId);
  const existingId = text(input.ruleId);
  return audited(app, user, existingId ? 'UPDATE_NOTIFICATION_RULE' : 'CREATE_NOTIFICATION_RULE', { ruleId: existingId, cohortId: cohort.id, milestoneId }, async () => {
    const existing = existingId ? await app.store.get(COLLECTIONS.notificationRules, existingId) : null;
    if (existingId && !existing) throw new HubError('That notification rule no longer exists. Refresh and try again.');
    const ruleId = existingId || uuid();
    await app.store.set(COLLECTIONS.notificationRules, ruleId, storedRule(ruleId, {
      cohortId: cohort.id,
      milestoneId,
      ...timing,
      audience,
      enabled,
      note,
      actor: user.email,
      existing,
    }));
    return { ruleId };
  });
}

export async function deleteNotificationRule(app: App, ruleId: unknown) {
  const user = await requireStaff(app, 'DELETE_NOTIFICATION_RULE');
  if (!notificationPowers(user).editRules) return deny(app, user, 'DELETE_NOTIFICATION_RULE', 'Coordinators manage cohort email rules.');
  const id = text(ruleId);
  if (!id) throw new HubError('Choose a notification rule.');
  return audited(app, user, 'DELETE_NOTIFICATION_RULE', { ruleId: id }, async () => {
    const existing = await app.store.get(COLLECTIONS.notificationRules, id);
    if (!existing) throw new HubError('That notification rule no longer exists. Refresh and try again.');
    await app.store.remove(COLLECTIONS.notificationRules, id);
    return { ruleId: id };
  });
}

export async function setNotificationRuleEnabled(app: App, ruleId: unknown, enabled: unknown) {
  const user = await requireStaff(app, 'SET_NOTIFICATION_RULE');
  if (!notificationPowers(user).editRules) return deny(app, user, 'SET_NOTIFICATION_RULE', 'Coordinators manage cohort email rules.');
  const id = text(ruleId);
  const flag = requireEnabledFlag(enabled);
  return audited(app, user, 'SET_NOTIFICATION_RULE', { ruleId: id, enabled: flag }, async () => {
    const existing = await app.store.get(COLLECTIONS.notificationRules, id);
    if (!existing) throw new HubError('That notification rule no longer exists. Refresh and try again.');
    await app.store.set(COLLECTIONS.notificationRules, id, { ...existing, enabled: flag, updatedBy: user.email, updatedAt: nowIso() });
    return { ruleId: id, enabled: flag };
  });
}

async function assertOwnStudent(app: App, user: HubUser, cohortId: string, studentId: string): Promise<void> {
  if (!notificationPowers(user).editOwnOverlays) {
    return deny(app, user, 'SAVE_NOTIFICATION_OVERLAY', 'Supervisors add reminders for their own students.');
  }
  if (!studentId) return;
  const student = (await app.store.listMembers(cohortId))
    .map((member) => placementFromMember(cohortId, member))
    .find((item) => item.email === studentId);
  if (!student) throw new HubError('That student is not on this cohort roster.');
  if (student.supervisorId !== user.email) {
    return deny(app, user, 'SAVE_NOTIFICATION_OVERLAY', 'Supervisors can only add reminders for their own students.');
  }
}

export async function saveNotificationOverlay(app: App, raw: unknown) {
  const user = await requireStaff(app, 'SAVE_NOTIFICATION_OVERLAY');
  const powers = notificationPowers(user);
  if (!powers.editOwnOverlays) return deny(app, user, 'SAVE_NOTIFICATION_OVERLAY', 'Supervisors add reminders for their own students.');
  const input = asInput(raw);
  const timing = normalizeTiming(input.when, input.days);
  const audience = normalizeAudience(input.audience);
  const note = cleanNote(input.note);
  const enabled = normalizeEnabled(input.enabled, true);
  const cohort = await requireCohort(app, text(input.cohortId), true);
  const milestoneId = text(input.milestoneId);
  await requireMilestone(app, milestoneId);
  const studentId = normalizeEmail(input.studentId);
  await assertOwnStudent(app, user, cohort.id, studentId);
  const existingId = text(input.ruleId);
  return audited(app, user, existingId ? 'UPDATE_NOTIFICATION_OVERLAY' : 'CREATE_NOTIFICATION_OVERLAY', { overlayId: existingId, cohortId: cohort.id, milestoneId }, async () => {
    const existing = existingId ? await app.store.get(COLLECTIONS.notificationOverlays, existingId) : null;
    if (existingId && !existing) throw new HubError('That reminder no longer exists. Refresh and try again.');
    if (existing && normalizeEmail(existing.supervisorId) !== user.email) {
      return deny(app, user, 'SAVE_NOTIFICATION_OVERLAY', 'Supervisors can only edit their own reminders.');
    }
    const overlayId = existingId || uuid();
    const doc = storedRule(overlayId, {
      cohortId: cohort.id,
      milestoneId,
      ...timing,
      audience,
      enabled,
      note,
      actor: user.email,
      existing,
      supervisorId: user.email,
      studentId,
    });
    await app.store.set(COLLECTIONS.notificationOverlays, overlayId, doc);
    return { overlayId };
  });
}

export async function deleteNotificationOverlay(app: App, overlayId: unknown) {
  const user = await requireStaff(app, 'DELETE_NOTIFICATION_OVERLAY');
  const powers = notificationPowers(user);
  const id = text(overlayId);
  if (!id) throw new HubError('Choose a reminder.');
  return audited(app, user, 'DELETE_NOTIFICATION_OVERLAY', { overlayId: id }, async () => {
    const existing = await app.store.get(COLLECTIONS.notificationOverlays, id);
    if (!existing) throw new HubError('That reminder no longer exists. Refresh and try again.');
    const owner = normalizeEmail(existing.supervisorId) === user.email && powers.editOwnOverlays;
    if (!owner && !powers.editRules) return deny(app, user, 'DELETE_NOTIFICATION_OVERLAY', 'You can only remove your own reminders.');
    await app.store.remove(COLLECTIONS.notificationOverlays, id);
    return { overlayId: id };
  });
}

export async function setNotificationOverlayEnabled(app: App, overlayId: unknown, enabled: unknown) {
  const user = await requireStaff(app, 'SET_NOTIFICATION_OVERLAY');
  const powers = notificationPowers(user);
  const id = text(overlayId);
  const flag = requireEnabledFlag(enabled);
  return audited(app, user, 'SET_NOTIFICATION_OVERLAY', { overlayId: id, enabled: flag }, async () => {
    const existing = await app.store.get(COLLECTIONS.notificationOverlays, id);
    if (!existing) throw new HubError('That reminder no longer exists. Refresh and try again.');
    const owner = normalizeEmail(existing.supervisorId) === user.email && powers.editOwnOverlays;
    if (!owner && !powers.editRules) return deny(app, user, 'SET_NOTIFICATION_OVERLAY', 'You can only change your own reminders.');
    await app.store.set(COLLECTIONS.notificationOverlays, id, { ...existing, enabled: flag, updatedBy: user.email, updatedAt: nowIso() });
    return { overlayId: id, enabled: flag };
  });
}

async function blockedSendIds(app: App, today: string, now: Date): Promise<Set<string>> {
  const rows = await app.store.whereEqual(COLLECTIONS.notificationSends, 'triggerDay', today);
  const blocked = new Set<string>();
  rows.forEach((row) => {
    const id = text(row.sendId);
    if (id && sendIsBlocked({ status: text(row.status), sentAt: text(row.sentAt) }, now)) blocked.add(id);
  });
  return blocked;
}

async function buildPlan(app: App, cohortId: string, now: Date): Promise<SweepPlan> {
  const today = localToday(now, app.timeZone);
  const cohorts = await listCohorts(app, true);
  const active = cohorts.filter((cohort) => cohort.status.toLowerCase() !== 'inactive');
  const chosen = cohortId ? cohorts.filter((cohort) => cohort.id === cohortId) : active;
  if (cohortId && !chosen.length) throw new HubError('Cohort not found.');
  const cohortIds = chosen.map((cohort) => cohort.id);
  const [tasks, students, templates, staff, rules, blocked] = await Promise.all([
    loadTasks(app),
    loadStudents(app, cohortIds),
    loadTemplates(app),
    loadStaff(app),
    loadRules(app),
    blockedSendIds(app, today, now),
  ]);
  const cohortSet = new Set(cohortIds);
  return planSweep({
    today,
    tasks,
    students,
    templates,
    staff,
    rules: rules.filter((rule) => cohortSet.has(rule.cohortId)),
    blockedSendIds: blocked,
  });
}

function localToday(now: Date, timeZone: string): string {
  const parts = clockParts(now, timeZone);
  return serializeDateOnly(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

function summaryFrom(plan: SweepPlan, dryRun: boolean, statuses: Map<string, { status: string; error: string }>): SweepSummary {
  const items = plan.sends.slice(0, ITEM_LIMIT).map((send) => {
    const outcome = statuses.get(send.sendId);
    return {
      studentName: send.studentName,
      studentId: send.studentId,
      milestoneTitle: send.milestoneTitle,
      recipients: send.recipients,
      subject: send.subject,
      timing: timingLabel(send.when, send.days),
      audience: audienceLabel(send.audience, send.mOwner),
      status: outcome?.status || (dryRun ? 'dry-run' : 'pending'),
      error: outcome?.error || '',
    };
  });
  let sent = 0;
  let failed = 0;
  statuses.forEach((outcome) => {
    if (outcome.status === 'sent') sent += 1;
    else if (outcome.status === 'failed') failed += 1;
  });
  return {
    dryRun,
    today: plan.today,
    considered: plan.sends.length,
    sent: dryRun ? 0 : sent,
    failed: dryRun ? 0 : failed,
    skipped: plan.skipped.length,
    gmailConfigured: gmailConfigured(),
    items,
  };
}

async function claimSend(app: App, send: PlannedSend, now: Date): Promise<'send' | 'skip'> {
  const ref = app.store.db.collection(COLLECTIONS.notificationSends).doc(send.sendId);
  return app.store.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() as Doc : null;
    if (sendIsBlocked(data ? { status: text(data.status), sentAt: text(data.sentAt) } : null, now)) return 'skip';
    tx.set(ref, sendLog(send, {
      status: 'sending',
      delivered: Array.isArray(data?.delivered) ? data.delivered.map((email: unknown) => normalizeEmail(email)).filter(Boolean) : [],
      error: '',
      sentAt: nowIso(now),
    }));
    return 'send';
  });
}

const SEND_LOG_LIMIT = 120;

function sendLog(send: PlannedSend, extra: Doc): Doc {
  return {
    sendId: send.sendId,
    ruleId: send.ruleId,
    ruleKind: send.ruleKind,
    taskId: send.taskId,
    triggerDay: send.triggerDay,
    cohortId: send.cohortId,
    milestoneId: send.milestoneId,
    milestoneTitle: send.milestoneTitle,
    studentId: send.studentId,
    studentName: send.studentName,
    supervisorId: send.supervisorId || '',
    when: send.when,
    days: send.days,
    recipients: send.recipients,
    audience: send.audience,
    subject: send.subject,
    ...extra,
  };
}

async function loadSendLog(app: App, email: string, powers: { editRules: boolean; editOwnOverlays: boolean }, cohortId: string, milestoneId: string, templates: Map<string, SweepTemplate>) {
  const rows = await app.store.list(COLLECTIONS.notificationSends);
  return rows
    .map((row) => presentSend(row, templates))
    .filter((row) => row.sendId && (!cohortId || row.cohortId === cohortId))
    .filter((row) => !milestoneId || row.milestoneId === milestoneId)
    .filter((row) => sendVisibleTo(powers, email, row))
    .sort((left, right) => text(right.sentAt).localeCompare(text(left.sentAt)))
    .slice(0, SEND_LOG_LIMIT);
}

function presentSend(row: Doc, templates: Map<string, SweepTemplate>) {
  const when = text(row.when).toLowerCase();
  const timing = when === 'before' || when === 'on' || when === 'after'
    ? timingLabel(when, when === 'on' ? 0 : Number(row.days) || 0)
    : '';
  const milestoneId = text(row.milestoneId);
  const audience = text(row.audience).toLowerCase();
  const mOwner = templates.get(milestoneId)?.mOwner || '';
  return {
    sendId: text(row.sendId),
    ruleId: text(row.ruleId),
    ruleKind: text(row.ruleKind) || 'cohort',
    cohortId: text(row.cohortId),
    milestoneId,
    milestoneTitle: text(row.milestoneTitle) || templates.get(milestoneId)?.title || milestoneId,
    studentId: normalizeEmail(row.studentId),
    studentName: text(row.studentName) || normalizeEmail(row.studentId) || 'Sample student',
    supervisorId: normalizeEmail(row.supervisorId),
    recipients: Array.isArray(row.recipients) ? row.recipients.map((item: unknown) => normalizeEmail(item)).filter(Boolean) : [],
    subject: text(row.subject),
    status: text(row.status) || 'sent',
    error: text(row.error),
    sentAt: text(row.sentAt),
    timing,
    audienceLabel: audience === 'owner' || audience === 'coordinator' ? audienceLabel(audience, mOwner) : '',
  };
}

async function recordStudentEmail(app: App, send: PlannedSend, before: string[], after: string[]): Promise<void> {
  if (!newlyEmailedStudent(send.studentId, before, after)) return;
  try {
    await audit(app, 'NOTIFICATION_EMAIL', {
      studentId: send.studentId,
      milestoneId: send.milestoneId,
      taskId: send.taskId,
      cohort: send.cohortId,
      recipients: send.recipients,
      subject: send.subject,
      audience: send.audience,
      timing: timingLabel(send.when, send.days),
      ruleKind: send.ruleKind,
      note: send.note,
    }, send.studentId);
  } catch (error) {
    console.error('Unable to record notification activity', error);
  }
}

async function deliverSend(app: App, mailer: Mailer, send: PlannedSend): Promise<{ status: string; error: string }> {
  const existing = await app.store.get(COLLECTIONS.notificationSends, send.sendId);
  const before = Array.isArray(existing?.delivered) ? existing.delivered.map((email: unknown) => normalizeEmail(email)).filter(Boolean) : [];
  const delivered = new Set<string>(before);
  const errors: string[] = [];
  for (const recipient of send.recipients) {
    if (delivered.has(recipient)) continue;
    try {
      await mailer.send({ to: [recipient], subject: send.subject, body: send.body });
      delivered.add(recipient);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The email could not be sent.';
      errors.push(`${recipient}: ${message}`);
    }
  }
  const error = errors.join(' ').slice(0, 500);
  const status = delivered.size === send.recipients.length && !error ? 'sent' : 'failed';
  const deliveredList = Array.from(delivered);
  await app.store.set(COLLECTIONS.notificationSends, send.sendId, sendLog(send, {
    status,
    delivered: deliveredList,
    error,
    sentAt: nowIso(),
  }));
  await recordStudentEmail(app, send, before, deliveredList);
  return { status, error };
}

export async function executeSweep(app: App, options: { now?: Date; dryRun?: boolean; cohortId?: string; mailer?: Mailer | null }): Promise<SweepSummary> {
  const now = options.now || new Date();
  const dryRun = !!options.dryRun;
  const plan = await buildPlan(app, text(options.cohortId), now);
  const statuses = new Map<string, { status: string; error: string }>();
  if (dryRun) {
    for (const send of plan.sends) {
      statuses.set(send.sendId, { status: 'dry-run', error: '' });
      const existing = await app.store.get(COLLECTIONS.notificationSends, send.sendId);
      if (existing && text(existing.status) === 'sent') continue;
      await app.store.set(COLLECTIONS.notificationSends, send.sendId, sendLog(send, {
        status: 'dry-run',
        delivered: [],
        error: '',
        sentAt: nowIso(now),
      }));
    }
    return summaryFrom(plan, true, statuses);
  }
  const mailer = options.mailer === undefined ? await createGmailMailer() : options.mailer;
  if (!mailer) throw new HubError('Gmail is not configured. Set EE_GMAIL_SENDER and EE_GMAIL_SERVICE_ACCOUNT_JSON.');
  for (const send of plan.sends) {
    const claim = await claimSend(app, send, now);
    if (claim === 'skip') {
      statuses.set(send.sendId, { status: 'skipped', error: '' });
      continue;
    }
    const outcome = await deliverSend(app, mailer, send);
    statuses.set(send.sendId, outcome);
  }
  return summaryFrom(plan, false, statuses);
}

export async function previewNotificationSweep(app: App, cohortId: unknown): Promise<SweepSummary> {
  const user = await requireStaff(app, 'PREVIEW_NOTIFICATIONS');
  const powers = notificationPowers(user);
  const now = new Date();
  const plan = await buildPlan(app, text(cohortId), now);
  const rules = await loadRules(app);
  const visible = new Set(rules.filter((rule) => {
    if (rule.kind === 'cohort') return true;
    if (powers.editRules || !powers.editOwnOverlays) return true;
    return rule.supervisorId === user.email;
  }).map((rule) => `${rule.kind}:${rule.ruleId}`));
  plan.sends = plan.sends.filter((send) => visible.has(`${send.ruleKind}:${send.ruleId}`));
  plan.skipped = plan.skipped.filter((skip) => visible.has(`${skip.ruleKind}:${skip.ruleId}`));
  return summaryFrom(plan, true, new Map());
}

export async function runNotificationSweep(app: App, raw: unknown) {
  const user = await requireStaff(app, 'RUN_NOTIFICATIONS');
  if (!notificationPowers(user).runSweep) return deny(app, user, 'RUN_NOTIFICATIONS', 'Coordinators run the email sweep.');
  const input = asInput(raw);
  const dryRun = toBoolean((input as Doc).dryRun);
  const cohortId = text((input as Doc).cohortId);
  return audited(app, user, dryRun ? 'PREVIEW_NOTIFICATION_SWEEP' : 'RUN_NOTIFICATION_SWEEP', { cohortId, dryRun }, async () => {
    return executeSweep(app, { dryRun, cohortId });
  });
}

export async function runScheduledNotifications(app: App, now = new Date()): Promise<SweepSummary> {
  const dryRun = toBoolean(process.env.EE_NOTIFICATIONS_DRY_RUN);
  if (!dryRun && !gmailConfigured()) {
    console.warn('Notification sweep skipped: set EE_GMAIL_SENDER and EE_GMAIL_SERVICE_ACCOUNT_JSON, or EE_NOTIFICATIONS_DRY_RUN=true.');
    return {
      dryRun: true,
      today: localToday(now, app.timeZone),
      considered: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      gmailConfigured: false,
      items: [],
    };
  }
  const summary = await executeSweep(app, { now, dryRun });
  console.log(`Notification sweep ${summary.today}: considered ${summary.considered}, sent ${summary.sent}, failed ${summary.failed}, skipped ${summary.skipped}, dryRun ${summary.dryRun}.`);
  return summary;
}

export async function sendNotificationTest(app: App, ruleKind: unknown, ruleId: unknown) {
  const user = await requireStaff(app, 'TEST_NOTIFICATION');
  const kind = text(ruleKind) === 'overlay' ? 'overlay' : text(ruleKind) === 'cohort' ? 'cohort' : '';
  if (!kind) throw new HubError('Choose a cohort rule or a supervisor reminder.');
  const id = text(ruleId);
  const powers = notificationPowers(user);
  const collection = kind === 'overlay' ? COLLECTIONS.notificationOverlays : COLLECTIONS.notificationRules;
  const existing = await app.store.get(collection, id);
  if (!existing) throw new HubError('That reminder no longer exists. Refresh and try again.');
  const rule = ruleFromDoc(existing, kind);
  if (!rule) throw new HubError('That reminder could not be read.');
  if (kind === 'cohort' && !powers.editRules) return deny(app, user, 'TEST_NOTIFICATION', 'Coordinators send test emails for cohort rules.');
  if (kind === 'overlay' && normalizeEmail(existing.supervisorId) !== user.email && !powers.editRules) {
    return deny(app, user, 'TEST_NOTIFICATION', 'Supervisors can test their own reminders.');
  }
  const template = await requireMilestone(app, rule.milestoneId);
  const message = buildMessage({
    audience: rule.audience,
    milestoneTitle: template.title,
    studentName: 'Sample student',
    dueDate: localToday(new Date(), app.timeZone),
    when: rule.when,
    days: rule.days,
    note: rule.note,
    test: true,
  });
  return audited(app, user, 'TEST_NOTIFICATION', { ruleId: id, kind }, async () => {
    const mailer = await createGmailMailer();
    await mailer.send({ to: [user.email], subject: message.subject, body: message.body });
    const sendId = `test_${uuid().replace(/-/g, '')}`;
    await app.store.set(COLLECTIONS.notificationSends, sendId, {
      sendId,
      ruleId: id,
      ruleKind: kind,
      taskId: '',
      triggerDay: localToday(new Date(), app.timeZone),
      cohortId: rule.cohortId,
      milestoneId: rule.milestoneId,
      milestoneTitle: template.title,
      studentId: '',
      studentName: 'Sample student',
      supervisorId: kind === 'overlay' ? normalizeEmail(existing.supervisorId) : '',
      when: rule.when,
      days: rule.days,
      recipients: [user.email],
      delivered: [user.email],
      audience: rule.audience,
      subject: message.subject,
      status: 'test',
      error: '',
      sentAt: nowIso(),
    });
    return { sent: true, to: user.email };
  });
}
