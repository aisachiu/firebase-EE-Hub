import { HubUser } from './permissions';
import { loginAliasMap, readPhases, readStaffTables, readTemplates, orderTemplates, requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, deny, requireStaff } from './session';
import { dateOnlyValue, Doc, HubError, normalizeEmail, nowIso, parseActionDate, serializeDateOnly, shortId, text } from './util';
import { readActionItemsForEmails } from './actions';

export interface SupervisorMilestoneTodo {
  supervisorId: string;
  studentEmail: string;
  studentName: string;
  surname: string;
  title: string;
  milestoneId: string;
  taskId: string;
  due: string;
  next: boolean;
}

export interface SupervisorAddedTodo {
  todoId: string;
  supervisorId: string;
  cohortId: string;
  title: string;
  note: string;
  due: string;
  status: string;
  createdBy: string;
}

interface MilestoneStudent {
  email: string;
  displayName: string;
  surname?: string;
  supervisorId?: string;
  studentEmail?: string;
}

interface MilestoneTemplateRef {
  milestoneId: string;
  title: string;
  mOwner: string;
}

interface MilestoneItemRef {
  templateId?: string;
  taskId?: string;
  title?: string;
  status?: string;
  due?: string;
}

const TODO_STATUSES = ['Pending', 'Completed'];

export function mayManageSupervisorTodos(user: HubUser | null | undefined): boolean {
  return !!(user && user.permissions && (user.permissions.isLead || user.permissions.canAdmin));
}

export function supervisorOwnedMilestones(
  students: MilestoneStudent[],
  templates: MilestoneTemplateRef[],
  itemsByEmail: Record<string, MilestoneItemRef[]>,
): SupervisorMilestoneTodo[] {
  const owned = templates.filter((template) => template.mOwner === 'supervisor' && template.milestoneId);
  const rows: SupervisorMilestoneTodo[] = [];
  students.forEach((student) => {
    const supervisorId = normalizeEmail(student.supervisorId);
    const studentEmail = normalizeEmail(student.email);
    if (!supervisorId || !studentEmail) return;
    const byTemplate: Record<string, MilestoneItemRef> = {};
    (itemsByEmail[studentEmail] || []).forEach((item) => {
      const templateId = text(item.templateId);
      if (templateId && !byTemplate[templateId]) byTemplate[templateId] = item;
    });
    let markedNext = false;
    owned.forEach((template) => {
      const item = byTemplate[template.milestoneId];
      const status = item ? text(item.status) || 'Pending' : 'Pending';
      if (status === 'Completed') return;
      const next = !markedNext;
      markedNext = true;
      rows.push({
        supervisorId,
        studentEmail,
        studentName: text(student.displayName) || studentEmail,
        surname: text(student.surname),
        title: text(item && item.title) || text(template.title) || template.milestoneId,
        milestoneId: template.milestoneId,
        taskId: text(item && item.taskId),
        due: item && item.due ? String(item.due).slice(0, 10) : '',
        next,
      });
    });
  });
  rows.sort((left, right) => {
    const due = dueKey(left.due).localeCompare(dueKey(right.due));
    if (due) return due;
    const name = (left.surname || left.studentName).localeCompare(right.surname || right.studentName);
    if (name) return name;
    return left.title.localeCompare(right.title) || left.milestoneId.localeCompare(right.milestoneId);
  });
  return rows;
}

function dueKey(due: string): string {
  return due || '9999-99-99';
}

function addedFrom(record: Doc): SupervisorAddedTodo {
  return {
    todoId: text(record.TodoId),
    supervisorId: normalizeEmail(record.SupervisorId),
    cohortId: text(record.Cohort),
    title: text(record.Title),
    note: text(record.Note),
    due: dateOnlyValue(record.DueDate),
    status: text(record.Status) || 'Pending',
    createdBy: normalizeEmail(record.CreatedBy),
  };
}

export async function listAddedSupervisorTodos(app: App, cohortId: string): Promise<SupervisorAddedTodo[]> {
  const cohort = text(cohortId);
  const records = await app.store.list(COLLECTIONS.supervisorTodos);
  return records.map(addedFrom)
    .filter((todo) => todo.todoId && todo.supervisorId && todo.cohortId === cohort)
    .sort((left, right) => dueKey(left.due).localeCompare(dueKey(right.due)) || left.title.localeCompare(right.title) || left.todoId.localeCompare(right.todoId));
}

async function staffNames(app: App): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const staff = await app.store.list(COLLECTIONS.staffUsers);
  staff.forEach((row) => {
    const email = normalizeEmail(row.EMAIL);
    if (email) names[email] = text(row.DisplayName) || email;
  });
  return names;
}

async function cohortRoster(app: App, cohortId: string) {
  const tables = await readStaffTables(app);
  const cohorts = tables.activeCohorts.map((cohort) => ({ id: cohort.id, name: cohort.name }));
  const selected = text(cohortId);
  if (!selected) return { cohorts, cohortId: '', roster: [] as typeof tables.byCohort[string] };
  await requireCohort(app, selected);
  return { cohorts, cohortId: selected, roster: tables.byCohort[selected] || [] };
}

export async function supervisorMilestoneTodosForCohort(app: App, cohortId: string, roster: MilestoneStudent[]) {
  const phases = await readPhases(app);
  const templates = orderTemplates(await readTemplates(app), phases);
  const emails: Record<string, boolean> = {};
  roster.forEach((student) => {
    const email = normalizeEmail(student.email);
    if (email) emails[email] = true;
  });
  const items = await readActionItemsForEmails(app, emails, loginAliasMap(roster));
  return supervisorOwnedMilestones(roster, templates, items);
}

export async function getSupervisorTodoDesk(app: App, cohortId: unknown) {
  const user = await requireStaff(app, 'VIEW_SUPERVISOR_TODOS');
  if (!mayManageSupervisorTodos(user)) return deny(app, user, 'VIEW_SUPERVISOR_TODOS', 'Leads and coordinators view supervisor to-dos.');
  const tables = await readStaffTables(app);
  const cohorts = tables.activeCohorts.map((cohort) => ({ id: cohort.id, name: cohort.name }));
  let selected = text(cohortId);
  if (!selected && cohorts.length) selected = cohorts[0].id;
  if (!selected) return { cohorts, cohortId: '', canAdd: true, supervisors: [] };
  await requireCohort(app, selected);
  const roster = tables.byCohort[selected] || [];
  const milestones = await supervisorMilestoneTodosForCohort(app, selected, roster);
  const added = await listAddedSupervisorTodos(app, selected);
  const names = await staffNames(app);
  const ids: Record<string, boolean> = {};
  roster.forEach((student) => {
    const supervisorId = normalizeEmail(student.supervisorId);
    if (supervisorId) ids[supervisorId] = true;
  });
  added.forEach((todo) => { ids[todo.supervisorId] = true; });
  const supervisors = Object.keys(ids).map((supervisorId) => ({
    supervisorId,
    name: names[supervisorId] || supervisorId,
    milestones: milestones.filter((item) => item.supervisorId === supervisorId),
    added: added.filter((todo) => todo.supervisorId === supervisorId),
  })).sort((left, right) => left.name.localeCompare(right.name) || left.supervisorId.localeCompare(right.supervisorId));
  return { cohorts, cohortId: selected, canAdd: true, supervisors };
}

function rosterSupervisorIds(roster: { supervisorId?: string }[]): Record<string, boolean> {
  const ids: Record<string, boolean> = {};
  roster.forEach((student) => {
    const supervisorId = normalizeEmail(student.supervisorId);
    if (supervisorId) ids[supervisorId] = true;
  });
  return ids;
}

export async function addSupervisorTodo(app: App, cohortId: unknown, supervisorId: unknown, payload: unknown) {
  const user = await requireStaff(app, 'ADD_SUPERVISOR_TODO');
  if (!mayManageSupervisorTodos(user)) return deny(app, user, 'ADD_SUPERVISOR_TODO', 'Leads and coordinators add supervisor to-dos.');
  const input = payload && typeof payload === 'object' ? payload as Doc : {};
  const title = text(input.title);
  if (!title) throw new HubError('To-do title is required.');
  if (title.length > 240) throw new HubError('To-do title must be 240 characters or fewer.');
  const note = text(input.note);
  if (note.length > 2000) throw new HubError('To-do note must be 2,000 characters or fewer.');
  const dueText = text(input.due);
  const parsedDue = dueText ? parseActionDate(dueText) : null;
  if (dueText && !parsedDue) throw new HubError('Due date must be a valid date.');
  const context = await cohortRoster(app, text(cohortId));
  if (!context.cohortId) throw new HubError('Cohort not found or inactive.');
  const owner = normalizeEmail(supervisorId);
  if (!owner || !rosterSupervisorIds(context.roster)[owner]) throw new HubError('Choose a supervisor in this cohort.');
  return audited(app, user, 'ADD_SUPERVISOR_TODO', { cohort: context.cohortId, supervisorId: owner, title }, async () => {
    const record = {
      TodoId: shortId('STDO_'),
      SupervisorId: owner,
      Cohort: context.cohortId,
      Title: title,
      Note: note,
      DueDate: parsedDue ? serializeDateOnly(parsedDue) : '',
      Status: 'Pending',
      CreatedBy: user.email,
      UpdatedBy: user.email,
      LastUpdated: nowIso(),
    };
    await app.store.set(COLLECTIONS.supervisorTodos, record.TodoId, record);
    return addedFrom(record);
  });
}

async function requireSupervisorTodo(app: App, todoId: unknown) {
  const id = text(todoId);
  const record = id ? await app.store.get(COLLECTIONS.supervisorTodos, id) : null;
  if (!record) throw new HubError('Supervisor to-do not found.');
  return record;
}

function mayUpdateAddedTodo(user: HubUser, record: Doc): boolean {
  if (mayManageSupervisorTodos(user)) return true;
  return !!(user.permissions?.isSupervisor && normalizeEmail(record.SupervisorId) === user.email);
}

export async function setSupervisorTodoStatus(app: App, todoId: unknown, status: unknown) {
  const user = await requireStaff(app, 'SET_SUPERVISOR_TODO_STATUS');
  const nextStatus = text(status);
  if (!TODO_STATUSES.includes(nextStatus)) throw new HubError('Choose a valid to-do status.');
  const existing = await requireSupervisorTodo(app, todoId);
  if (!mayUpdateAddedTodo(user, existing)) return deny(app, user, 'SET_SUPERVISOR_TODO_STATUS', 'You cannot update this supervisor to-do.');
  return audited(app, user, 'SET_SUPERVISOR_TODO_STATUS', { todoId: text(existing.TodoId), status: nextStatus, supervisorId: normalizeEmail(existing.SupervisorId) }, async () => {
    const current = await requireSupervisorTodo(app, existing.TodoId);
    current.Status = nextStatus;
    current.UpdatedBy = user.email;
    current.LastUpdated = nowIso();
    await app.store.set(COLLECTIONS.supervisorTodos, text(current.TodoId), current);
    return addedFrom(current);
  });
}

export async function deleteSupervisorTodo(app: App, todoId: unknown) {
  const user = await requireStaff(app, 'DELETE_SUPERVISOR_TODO');
  if (!mayManageSupervisorTodos(user)) return deny(app, user, 'DELETE_SUPERVISOR_TODO', 'Leads and coordinators remove supervisor to-dos.');
  const existing = await requireSupervisorTodo(app, todoId);
  return audited(app, user, 'DELETE_SUPERVISOR_TODO', { todoId: text(existing.TodoId), supervisorId: normalizeEmail(existing.SupervisorId), title: text(existing.Title) }, async () => {
    await app.store.remove(COLLECTIONS.supervisorTodos, text(existing.TodoId));
    return { todoId: text(existing.TodoId) };
  });
}
