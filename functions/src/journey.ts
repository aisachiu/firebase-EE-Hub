import { activityFeed } from './activity';
import { getStudentActionItems, latestReturned, readActionItemsForEmails, readEvents } from './actions';
import { canCompleteMilestone, HubUser, normalizeStaffView } from './permissions';
import { findPlacement, orderTemplates, readPhases, readRoster, readStaffTables, readTemplates, staffMayAddStudentTodo, staffMayUpdateAllMilestones, staffStudentContext } from './roster';
import { COLLECTIONS } from './schema';
import { App, deny, requireStaff, requireUser } from './session';
import { staffUnreadNotices, studentTicketNotice } from './messaging';
import { publishedFormIds } from './forms';
import { dateOnlyValue, text } from './util';

function todayUtc() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function dueTime(value: string) {
  if (!value) return NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
}

export async function getStudentHome(app: App) {
  const user = await requireUser(app, 'VIEW_STUDENT_HOME');
  if (user.role !== 'student') return deny(app, user, 'VIEW_STUDENT_HOME', 'Student access required.');
  const placement = await findPlacement(app, user.email) || { cohortId: '', displayName: user.displayName, email: user.email, subject: '', supervisorId: '', hrm: '', anchor: '', folder: '', doc: '', rppf: '', poster: '', surname: '', firstName: '', studentNumber: '' };
  const phases = await readPhases(app);
  const templates = orderTemplates(await readTemplates(app), phases);
  const items = await getStudentActionItems(app, user.email, user);
  const events = await readEvents(app, [user.email]);
  const returned = latestReturned(events);
  items.forEach((item) => { item.returnedComment = returned[item.TaskId] ? returned[item.TaskId].comment : ''; });
  const published: Record<string, boolean> = {};
  (await publishedFormIds(app)).forEach((id) => { published[id] = true; });
  const ticketNotice = await studentTicketNotice(app, user.email);
  return {
    displayName: placement.displayName || user.displayName,
    email: user.email,
    cohort: placement.cohortId || '',
    subject: placement.subject || '',
    supervisorId: placement.supervisorId || '',
    hrm: placement.hrm || '',
    anchor: placement.anchor || '',
    links: { folder: placement.folder || '', doc: placement.doc || '', rppf: placement.rppf || '', poster: placement.poster || '' },
    phases,
    templates,
    actionItems: items,
    publishedForms: published,
    unreadTicketCount: ticketNotice.count,
    unreadTicketTitle: ticketNotice.title,
    unreadTickets: ticketNotice.tickets || [],
  };
}

function summarize(student: any, items: any[], templates: any[], returned: Record<string, { comment: string }>, today: number, user: HubUser, view: string) {
  const byTemplate: Record<string, any> = {};
  items.forEach((item) => { byTemplate[item.templateId] = item; });
  let done = 0;
  let behind = 0;
  let returnedCount = 0;
  let latest = '';
  const waiting: { taskId: string; title: string; templateId: string; type: string }[] = [];
  const segments: string[] = [];
  let currentPhase = templates.length ? templates[0].phase : '';
  let priorComplete = true;
  templates.forEach((template) => {
    const item = byTemplate[template.milestoneId];
    const status = item ? item.status : 'Pending';
    const due = item && item.due ? dueTime(item.due) : NaN;
    const overdue = status !== 'Completed' && !isNaN(due) && due < today;
    if (status === 'Completed') { done += 1; latest = template.title; }
    else if (priorComplete) currentPhase = template.phase;
    if (overdue) behind += 1;
    const segment = status === 'Completed' ? 'd' : (status === 'In Progress' ? 'p' : (overdue ? 'l' : 'o'));
    segments.push(segment);
    const canAct = view !== 'staff' && item && status !== 'Completed' && priorComplete && canCompleteMilestone(user, student.email, template.mOwner, template.type, student) && (template.type === 'approval' || template.type === 'meeting' || template.mOwner === 'supervisor' || template.mOwner === 'coordinator');
    if (canAct) waiting.push({ taskId: item.taskId, title: template.title, templateId: template.milestoneId, type: template.type });
    if (item && returned[item.taskId] && status !== 'Completed') returnedCount += 1;
    if (status !== 'Completed') priorComplete = false;
  });
  let nextSupervisor = null;
  for (const milestone of templates) {
    if (milestone.mOwner !== 'supervisor') continue;
    const milestoneItem = byTemplate[milestone.milestoneId];
    const milestoneStatus = milestoneItem ? milestoneItem.status : 'Pending';
    if (milestoneStatus === 'Completed') continue;
    nextSupervisor = { title: milestone.title, milestoneId: milestone.milestoneId, taskId: milestoneItem ? milestoneItem.taskId : '' };
    break;
  }
  return {
    email: student.email,
    displayName: student.displayName,
    surname: student.surname || '',
    firstName: student.firstName || '',
    studentNumber: student.studentNumber,
    hrm: student.hrm,
    subject: student.subject,
    supervisorId: student.supervisorId,
    done,
    total: templates.length,
    behind,
    phaseId: currentPhase,
    latestTitle: latest,
    segments: segments.join(''),
    returned: returnedCount,
    waiting: waiting.slice(0, 3),
    urgency: waiting.length * 100 + behind + returnedCount,
    nextSupervisor,
  };
}

async function staffDirectory(app: App) {
  const names: Record<string, string> = {};
  const staff = await app.store.list(COLLECTIONS.staffUsers);
  staff.forEach((row) => {
    const email = text(row.EMAIL).toLowerCase();
    if (email) names[email] = text(row.DisplayName) || email;
  });
  return names;
}

function supervisorChoices(roster: any[], names: Record<string, string>) {
  const seen: Record<string, boolean> = {};
  const choices: { id: string; name: string }[] = [];
  roster.forEach((student) => {
    const id = student.supervisorId || '';
    const key = id || '__unassigned__';
    if (seen[key]) return;
    seen[key] = true;
    choices.push({ id: key, name: id ? (names[id] || id) : 'Unassigned' });
  });
  choices.sort((left, right) => left.name.localeCompare(right.name));
  return choices;
}

export async function getStaffHome(app: App, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_STAFF_HOME');
  const tables = await readStaffTables(app);
  const cohorts = tables.activeCohorts.map((cohort) => ({ id: cohort.id, name: cohort.name, sheetName: cohort.sheetName }));
  let selected = text(cohortId);
  if (!selected && cohorts.length) selected = cohorts[0].id;
  if (!selected) return { cohorts, cohortId: '', viewAs: 'staff', students: [], phases: [], templates: [] };
  const known = cohorts.some((cohort) => cohort.id === selected);
  if (!known) {
    const { requireCohort } = await import('./roster');
    await requireCohort(app, selected);
  }
  const view = normalizeStaffView(user, viewAs);
  const phases = await readPhases(app);
  const templates = orderTemplates(await readTemplates(app), phases);
  let roster = (tables.byCohort[selected] || []).slice();
  if (view === 'supervisor') roster = roster.filter((student) => student.supervisorId === user.email);
  const emails: Record<string, boolean> = {};
  roster.forEach((student) => { emails[student.email] = true; });
  const items = await readActionItemsForEmails(app, emails);
  const events = await readEvents(app, Object.keys(emails));
  const returned = latestReturned(events);
  const today = todayUtc();
  const students = roster.map((student) => summarize(student, items[student.email] || [], templates, returned, today, user, view))
    .sort((left, right) => right.urgency - left.urgency || left.displayName.localeCompare(right.displayName));
  const notices = await staffUnreadNotices(app, user, view, tables.byEmail);
  return {
    cohorts,
    cohortId: selected,
    viewAs: view,
    viewerEmail: user.email,
    canAct: view !== 'staff',
    phases,
    templates,
    supervisors: supervisorChoices(roster, await staffDirectory(app)),
    students,
    unreadTicketCount: notices.count,
    unreadTickets: notices.tickets,
  };
}

function staffViewLabel(view: string, canUpdate: boolean) {
  if (view === 'coordinator') return canUpdate ? 'Coordinator · you can update every milestone' : 'Coordinator';
  if (view === 'supervisor') return canUpdate ? 'Supervisor · you can update every milestone' : 'Supervisor · you can update milestones you own';
  return 'Staff browse · read only';
}

export async function getStaffStudentHome(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'VIEW_STAFF_STUDENT');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'VIEW_STAFF_STUDENT', viewAs);
  const phases = await readPhases(app);
  const templates = orderTemplates(await readTemplates(app), phases);
  const items = await getStudentActionItems(app, context.email, user);
  const events = await readEvents(app, [context.email]);
  const returned = latestReturned(events);
  const canUpdateAll = staffMayUpdateAllMilestones(user, context.roster, context.view);
  items.forEach((item) => {
    item.returnedComment = returned[item.TaskId] ? returned[item.TaskId].comment : '';
    if (item.CreatorType === 'Student') {
      item.canEdit = false;
      item.canUpdate = false;
    } else if (item.CreatorType === 'System') {
      const allowed = !!canUpdateAll || (context.view !== 'staff' && canCompleteMilestone(user, context.email, item.mOwner, item.templateType, context.roster));
      item.canUpdate = allowed;
      item.staffUpdate = allowed;
    }
  });
  const published: Record<string, boolean> = {};
  (await publishedFormIds(app)).forEach((id) => { published[id] = true; });
  const roster = context.roster;
  return {
    staffView: true,
    viewAs: context.view,
    canUpdateMilestones: canUpdateAll,
    canWriteTodos: staffMayAddStudentTodo(user, context),
    viewLabel: staffViewLabel(context.view, canUpdateAll),
    displayName: roster.displayName,
    email: context.email,
    cohort: text(cohortId),
    subject: roster.subject || '',
    supervisorId: roster.supervisorId || '',
    hrm: roster.hrm || '',
    anchor: roster.anchor || '',
    surname: roster.surname || '',
    studentNumber: roster.studentNumber || '',
    links: { folder: roster.folder || '', doc: roster.doc || '', rppf: roster.rppf || '', poster: roster.poster || '' },
    phases,
    templates,
    actionItems: items,
    publishedForms: published,
    unreadTicketCount: 0,
    unreadTickets: [],
  };
}

export async function getMyActivity(app: App) {
  const user = await requireUser(app, 'VIEW_MY_ACTIVITY');
  if (user.role !== 'student') return deny(app, user, 'VIEW_MY_ACTIVITY', 'Student access required.');
  return activityFor(app, user.email);
}

export async function getStudentActivity(app: App, studentEmail: unknown, cohortId: unknown) {
  const user = await requireStaff(app, 'VIEW_STUDENT_ACTIVITY');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'VIEW_STUDENT_ACTIVITY');
  return activityFor(app, context.email);
}

async function activityFor(app: App, email: string) {
  const logs = await app.store.list(COLLECTIONS.auditLogs);
  logs.sort((left, right) => text(left.Timestamp).localeCompare(text(right.Timestamp)));
  const templates: Record<string, string> = {};
  (await readTemplates(app)).forEach((template) => { templates[template.milestoneId] = template.title; });
  const tasks: Record<string, string> = {};
  const items = await app.store.list(COLLECTIONS.studentActionItems);
  items.forEach((item) => {
    if (text(item.StudentId).toLowerCase() !== email) return;
    if (text(item.TaskId)) tasks[text(item.TaskId)] = text(item.Title);
    const templateId = text(item.TemplateId);
    if (templateId && text(item.Title) && !templates[templateId]) templates[templateId] = text(item.Title);
  });
  return activityFeed(email, logs, templates, tasks);
}

export async function getPathwayPlan(app: App) {
  const { getAdminRecords } = await import('./admin');
  return { phases: await getAdminRecords(app, 'phases'), milestones: await getAdminRecords(app, 'milestoneTemplates') };
}

void readRoster;
void dateOnlyValue;
