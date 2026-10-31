import { canCompleteMilestone, HubUser } from './permissions';
import { findPlacement, identityAliases, milestoneDocsFor, phaseDocsFor, Placement, readPhases, staffMayAddStudentTodo, staffMayUpdateAllMilestones, staffStudentContext } from './roster';
import { COLLECTIONS, fieldConfig } from './schema';
import { App, audited, deny, requireAdmin, requireStaff, requireUser } from './session';
import { addDays, dateOnlyValue, Doc, HubError, normalizeEmail, nowIso, parseActionDate, serializeDateOnly, shortId, text, toBoolean, uuid, validateEmail } from './util';
import { formWritesClosed } from './formsPure';

function creatorKind(record: Doc): string {
  const value = text(record.CreatorType || record.creatorType).toLowerCase();
  if (value === 'system') return 'System';
  if (value === 'student') return 'Student';
  if (value === 'supervisor') return 'Supervisor';
  return text(record.CreatorType || record.creatorType);
}

function actionTemplateId(record: Doc): string {
  return text(record.TemplateId || record.templateId || record.MilestoneId || record.milestoneId);
}

function actionStudentId(record: Doc): string {
  return normalizeEmail(record.StudentId || record.studentId);
}

function sameStudent(record: Doc, aliases: string[]): boolean {
  return aliases.includes(actionStudentId(record));
}

async function actionItemsForAliases(app: App, aliases: string[]): Promise<Doc[]> {
  const found: Doc[] = [];
  const seen = new Set<string>();
  for (const email of aliases) {
    const rows = await app.store.whereEqual(COLLECTIONS.studentActionItems, 'StudentId', email);
    rows.forEach((row) => {
      const taskId = text(row.TaskId);
      const key = taskId || `row-${found.length}-${actionTemplateId(row)}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push(row);
    });
  }
  return found;
}

async function systemTasksForAliases(app: App, aliases: string[], templateId: string): Promise<Doc[]> {
  const id = text(templateId);
  const rows = await actionItemsForAliases(app, aliases);
  return rows.filter((item) => creatorKind(item) === 'System' && actionTemplateId(item) === id && sameStudent(item, aliases));
}

function initialDueDate(roster: Placement, template: Doc, explicit: string): string {
  if (explicit) return explicit;
  const anchor = parseActionDate(roster.anchor);
  if (!anchor) return '';
  return serializeDateOnly(addDays(anchor, -Number(template.offsetDays || 0)));
}

function newSystemTask(user: HubUser, studentId: string, template: Doc, status: string, dueDate: string, cohortId?: unknown): Doc {
  const record = stampActors({
    TaskId: shortId('ACT_'),
    StudentId: normalizeEmail(studentId),
    CreatorType: 'System',
    TemplateId: text(template.milestoneId),
    PhaseId: text(template.phase),
    Title: text(template.milestoneTitle),
    Description: text(template.milestoneDescription),
    DueDate: dueDate,
    Status: status || 'Pending',
    LastUpdated: nowIso(),
  }, user.email, true);
  const cohort = text(cohortId);
  if (cohort) record.cohortId = cohort;
  return record;
}

export async function getStudentActionItems(app: App, studentEmail: string, user: HubUser | null) {
  const normalizedStudentId = normalizeEmail(studentEmail);
  const placementForTemplates = await findPlacement(app, normalizedStudentId);
  const records = await actionItemsForAliases(app, identityAliases(placementForTemplates, normalizedStudentId));
  const templates = await milestoneDocsFor(app, placementForTemplates?.cohortId || '');
  const templateOwners: Record<string, string> = {};
  const templateTypes: Record<string, string> = {};
  templates.forEach((template) => {
    templateOwners[text(template.milestoneId)] = text(template.mOwner).toLowerCase();
    templateTypes[text(template.milestoneId)] = text(template.type).toLowerCase();
  });
  const placement = user && user.role === 'staff' ? placementForTemplates : null;
  const items = [];
  for (const source of records) {
    const item: Doc = { ...source };
    item.TaskId = text(item.TaskId);
    item.CreatorType = creatorKind(item);
    item.TemplateId = actionTemplateId(item);
    item.StudentId = actionStudentId(item) || normalizeEmail(item.StudentId);
    item.Status = text(item.Status) || 'Pending';
    item.DueDate = item.DueDate ? dateOnlyValue(item.DueDate) || text(item.DueDate) : '';
    item.templateType = templateTypes[text(item.TemplateId)] || '';
    item.mOwner = templateOwners[text(item.TemplateId)] || '';
    item.canEdit = item.CreatorType === 'Student' && user && user.role === 'student' && normalizeEmail(item.StudentId) === user.email;
    const known = item.mOwner === 'supervisor' ? placement : null;
    item.canUpdate = item.canEdit || (item.CreatorType === 'System' && !!user && canCompleteMilestone(user, item.StudentId, item.mOwner, item.templateType, known));
    item.formOpen = item.templateType !== 'form' || !formWritesClosed(item.DueDate, new Date(), app.timeZone);
    items.push(item);
  }
  return items.sort((left, right) => {
    const leftDate = left.DueDate ? Date.parse(left.DueDate) : Number.MAX_SAFE_INTEGER;
    const rightDate = right.DueDate ? Date.parse(right.DueDate) : Number.MAX_SAFE_INTEGER;
    return leftDate - rightDate || text(left.TaskId).localeCompare(text(right.TaskId));
  });
}

function stampActors(record: Doc, actorEmail: string, creating: boolean) {
  const email = normalizeEmail(actorEmail);
  if (creating) record.CreatedBy = email;
  record.UpdatedBy = email;
  return record;
}

async function prepareTodo(app: App, title: unknown, phaseId: unknown, cohortId?: unknown) {
  const taskTitle = text(title);
  if (!taskTitle) throw new HubError('To-Do title is required.');
  if (taskTitle.length > 240) throw new HubError('To-Do title must be 240 characters or fewer.');
  const phase = text(phaseId);
  if (phase) {
    const known = (await phaseDocsFor(app, cohortId)).find((item) => text(item.phaseId) === phase);
    if (!known || !toBoolean(known.active)) throw new HubError('Choose an active phase for this to-do.');
  }
  return { title: taskTitle, phase };
}

async function milestoneForStudent(app: App, studentId: string, milestoneId: string, cohortId?: unknown) {
  const cohort = text(cohortId) || (await findPlacement(app, studentId))?.cohortId || '';
  const templates = await milestoneDocsFor(app, cohort);
  return templates.find((template) => text(template.milestoneId) === text(milestoneId)) || null;
}

async function appendAction(app: App, values: Doc) {
  await app.store.set(COLLECTIONS.studentActionItems, text(values.TaskId), values);
}

export async function addStudentTodo(app: App, title: unknown, phaseId: unknown) {
  const user = await requireUser(app, 'ADD_STUDENT_TODO');
  if (user.role !== 'student') return deny(app, user, 'ADD_STUDENT_TODO', 'Student access required.');
  const placement = await findPlacement(app, user.email);
  const input = await prepareTodo(app, title, phaseId, placement?.cohortId || '');
  return audited(app, user, 'ADD_STUDENT_TODO', { studentId: user.email, phaseId: input.phase }, async () => {
    const values = stampActors({
      TaskId: shortId('ACT_'),
      StudentId: user.email,
      CreatorType: 'Student',
      TemplateId: '',
      PhaseId: input.phase,
      Title: input.title,
      Description: '',
      DueDate: '',
      Status: 'Pending',
      LastUpdated: nowIso(),
      cohortId: text(placement?.cohortId),
    }, user.email, true);
    await appendAction(app, values);
    return { TaskId: values.TaskId };
  });
}

export async function addStaffStudentTodo(app: App, title: unknown, phaseId: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'ADD_STAFF_STUDENT_TODO');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'ADD_STAFF_STUDENT_TODO', viewAs);
  if (!staffMayAddStudentTodo(user, context)) return deny(app, user, 'ADD_STAFF_STUDENT_TODO', 'You cannot add a to-do for this student.');
  const input = await prepareTodo(app, title, phaseId, text(cohortId));
  return audited(app, user, 'ADD_STAFF_STUDENT_TODO', { studentId: context.email, phaseId: input.phase, cohort: text(cohortId) }, async () => {
    const values = stampActors({
      TaskId: shortId('ACT_'),
      StudentId: context.email,
      CreatorType: 'Student',
      TemplateId: '',
      PhaseId: input.phase,
      Title: input.title,
      Description: '',
      DueDate: '',
      Status: 'Pending',
      LastUpdated: nowIso(),
      cohortId: text(cohortId),
    }, user.email, true);
    await appendAction(app, values);
    return { TaskId: values.TaskId, StudentId: context.email };
  });
}

async function findActionItem(app: App, taskId: string) {
  const record = await app.store.get(COLLECTIONS.studentActionItems, text(taskId));
  if (!record) throw new HubError('Action item not found.');
  return record;
}

function requireOwnedStudentTodo(app: App, item: Doc, user: HubUser) {
  if (item.CreatorType !== 'Student' || normalizeEmail(item.StudentId) !== user.email) {
    return deny(app, user, 'UPDATE_STUDENT_TODO', 'This is not your editable To-Do.');
  }
  return null;
}

export async function saveStudentTodo(app: App, taskId: unknown, title: unknown, description: unknown, dueDate: unknown) {
  const user = await requireUser(app, 'UPDATE_STUDENT_TODO');
  if (user.role !== 'student') return deny(app, user, 'UPDATE_STUDENT_TODO', 'Student access required.');
  const nextTitle = text(title);
  if (!nextTitle) throw new HubError('To-Do title is required.');
  if (nextTitle.length > 240) throw new HubError('To-Do title must be 240 characters or fewer.');
  const parsedDate = dueDate ? parseActionDate(dueDate) : null;
  if (dueDate && !parsedDate) throw new HubError('Due date must be a valid date.');
  return audited(app, user, 'UPDATE_STUDENT_TODO', { taskId: text(taskId), studentId: user.email }, async () => {
    const item = await findActionItem(app, text(taskId));
    await requireOwnedStudentTodo(app, item, user);
    item.Title = nextTitle;
    item.Description = text(description);
    item.DueDate = parsedDate ? serializeDateOnly(parsedDate) : '';
    item.LastUpdated = nowIso();
    stampActors(item, user.email, false);
    await app.store.set(COLLECTIONS.studentActionItems, text(item.TaskId), item);
    return { saved: true, dueDate: item.DueDate };
  });
}

async function requireActionStatus(app: App, user: HubUser, item: Doc) {
  if (creatorKind(item) === 'Student') {
    if (user.role !== 'student' || actionStudentId(item) !== user.email) {
      return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Only the creating student can change this To-Do.');
    }
    return;
  }
  if (creatorKind(item) !== 'System') throw new HubError('Unsupported action-item creator type.');
  const template = await milestoneForStudent(app, actionStudentId(item), actionTemplateId(item));
  const placement = template && text(template.mOwner).toLowerCase() === 'supervisor' ? await findPlacement(app, actionStudentId(item)) : null;
  if (!template || !canCompleteMilestone(user, actionStudentId(item), text(template.mOwner).toLowerCase(), text(template.type).toLowerCase(), placement)) {
    return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Only the milestone owner can change this status.');
  }
}

export async function staffMayUpdateSystemItem(app: App, user: HubUser, context: { view: string; roster: Placement }, record: Doc) {
  if (!context || creatorKind(record) !== 'System') return false;
  if (staffMayUpdateAllMilestones(user, context.roster, context.view)) return true;
  if (context.view === 'staff') return false;
  const template = await milestoneForStudent(app, actionStudentId(record), actionTemplateId(record), context.roster.cohortId);
  if (!template) return false;
  const placement = context.roster;
  return canCompleteMilestone(user, actionStudentId(record), text(template.mOwner).toLowerCase(), text(template.type).toLowerCase(), placement);
}

export async function setActionItemStatus(app: App, taskId: unknown, status: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireUser(app, 'SET_ACTION_ITEM_STATUS');
  const targetStudentId = user.role === 'student' ? user.email : normalizeEmail(studentEmail);
  const item = await findActionItem(app, text(taskId));
  let staffContext = null as Awaited<ReturnType<typeof staffStudentContext>> | null;
  let aliases = [targetStudentId];
  if (user.role === 'staff') {
    staffContext = await staffStudentContext(app, user, targetStudentId, text(cohortId), 'SET_ACTION_ITEM_STATUS', viewAs);
    aliases = identityAliases(staffContext.roster, targetStudentId);
    if (creatorKind(item) === 'Student') return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Staff can only read student to-dos.');
  } else if (user.role !== 'student' || targetStudentId !== user.email) {
    return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Student access required.');
  }
  if (!sameStudent(item, aliases)) return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Task belongs to another student.');
  const statusField = fieldConfig('studentActionItems', 'Status');
  if (!statusField?.options?.some((option) => option === status)) throw new HubError('Choose a valid task status.');
  if (staffContext) {
    if (!await staffMayUpdateSystemItem(app, user, staffContext, item)) return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'You cannot update this milestone.');
  } else {
    await requireActionStatus(app, user, item);
  }
  return audited(app, user, 'UPDATE_ACTION_ITEM_STATUS', { taskId: text(taskId), studentId: targetStudentId, status }, async () => {
    const current = await findActionItem(app, text(taskId));
    if (!sameStudent(current, aliases)) throw new HubError('Task belongs to another student.');
    if (creatorKind(current) !== creatorKind(item)) throw new HubError('This task changed. Refresh and try again.');
    current.Status = status;
    current.LastUpdated = nowIso();
    stampActors(current, user.email, false);
    await app.store.set(COLLECTIONS.studentActionItems, text(current.TaskId), current);
    return { status, taskId: text(current.TaskId) };
  });
}

export async function assignMilestonesToStudents(app: App, cohortId: unknown, selectedStudentIds: unknown, baselineAnchorDate: unknown) {
  const user = await requireAdminSafe(app);
  if (!Array.isArray(selectedStudentIds) || !selectedStudentIds.length) throw new HubError('Select one or more students.');
  const anchorDate = parseActionDate(baselineAnchorDate);
  if (!anchorDate) throw new HubError('Choose a valid baseline anchor date.');
  const anchor = serializeDateOnly(anchorDate);
  return audited(app, user, 'ASSIGN_MILESTONES', { cohort: text(cohortId), studentCount: selectedStudentIds.length, anchorDate: anchor }, async () => {
    const cohort = text(cohortId);
    await requireCohortLocal(app, cohort);
    const selected: Record<string, boolean> = {};
    selectedStudentIds.forEach((value) => {
      const studentId = validateEmail(value, 'StudentId');
      if (selected[studentId]) throw new HubError('A student was selected more than once.');
      selected[studentId] = true;
    });
    const templates = await milestoneDocsFor(app, cohort);
    if (!templates.length) throw new HubError('This cohort has no milestones to assign.');
    const existingItems = await app.store.list(COLLECTIONS.studentActionItems);
    const existing: Record<string, boolean> = {};
    existingItems.forEach((row) => {
      if (text(row.CreatorType) !== 'System') return;
      existing[`${normalizeEmail(row.StudentId)}\u0000${text(row.TemplateId)}`] = true;
    });
    let created = 0;
    const now = nowIso();
    for (const studentId of Object.keys(selected)) {
      const member = await app.store.getMember(cohort, studentId);
      if (!member) throw new HubError(`Students not found in cohort: ${studentId}`);
      member.Anchor_Date = anchor;
      await app.store.setMember(cohort, studentId, member);
      for (const template of templates) {
        const pairKey = `${studentId}\u0000${text(template.milestoneId)}`;
        if (existing[pairKey]) continue;
        const dueDate = serializeDateOnly(addDays(anchorDate, -Number(template.offsetDays || 0)));
        const taskId = shortId('ACT_');
        await app.store.set(COLLECTIONS.studentActionItems, taskId, {
          TaskId: taskId,
          cohortId: cohort,
          StudentId: studentId,
          CreatorType: 'System',
          TemplateId: text(template.milestoneId),
          PhaseId: text(template.phase),
          Title: text(template.milestoneTitle),
          Description: text(template.milestoneDescription),
          DueDate: dueDate,
          Status: 'Pending',
          LastUpdated: now,
          CreatedBy: user.email,
          UpdatedBy: user.email,
        });
        existing[pairKey] = true;
        created += 1;
      }
    }
    return { assignedStudents: Object.keys(selected).length, createdTasks: created };
  });
}

async function requireAdminSafe(app: App) {
  const { requireAdmin } = await import('./session');
  return requireAdmin(app, 'ASSIGN_MILESTONES');
}

async function requireCohortLocal(app: App, cohortId: string) {
  const { requireCohort } = await import('./roster');
  return requireCohort(app, cohortId);
}

export async function saveStudentAnchorAndSync(app: App, cohortId: unknown, studentId: unknown, anchorDateValue: unknown) {
  const { requireAdmin } = await import('./session');
  const user = await requireAdmin(app, 'SET_STUDENT_ANCHOR_DATE');
  const normalized = validateEmail(studentId, 'StudentId');
  const anchorDate = anchorDateValue ? parseActionDate(anchorDateValue) : null;
  if (anchorDateValue && !anchorDate) throw new HubError('Anchor_Date must be a valid date.');
  return audited(app, user, 'SET_STUDENT_ANCHOR_DATE', { cohort: text(cohortId), studentId: normalized, sync: true }, async () => {
    const cohort = text(cohortId);
    await requireCohortLocal(app, cohort);
    const member = await app.store.getMember(cohort, normalized);
    if (!member) throw new HubError('Student is not in the selected cohort.');
    member.Anchor_Date = anchorDate ? serializeDateOnly(anchorDate) : '';
    await app.store.setMember(cohort, normalized, member);
    const synced = await applyDateSync(app, user, cohort, normalized);
    return { saved: true, updated: synced.updated };
  });
}

async function applyDateSync(app: App, user: HubUser, cohortId: string, targetStudentId: string) {
  const member = await app.store.getMember(cohortId, targetStudentId);
  if (!member) throw new HubError('Student is not in the selected cohort.');
  const anchorDate = parseActionDate(member.Anchor_Date);
  if (!anchorDate) throw new HubError('Set the student Anchor_Date before syncing.');
  const templates = await milestoneDocsFor(app, cohortId);
  const byId: Record<string, Doc> = {};
  templates.forEach((template) => { byId[text(template.milestoneId)] = template; });
  const items = await app.store.whereEqual(COLLECTIONS.studentActionItems, 'StudentId', targetStudentId);
  const now = nowIso();
  let updated = 0;
  for (const row of items) {
    if (text(row.CreatorType) !== 'System') continue;
    const template = byId[text(row.TemplateId)];
    if (!template) continue;
    row.DueDate = serializeDateOnly(addDays(anchorDate, -Number(template.offsetDays || 0)));
    row.LastUpdated = now;
    row.UpdatedBy = user.email;
    await app.store.set(COLLECTIONS.studentActionItems, text(row.TaskId), row);
    updated += 1;
  }
  return { updated };
}

export async function readEvents(app: App, emails: string[]) {
  const wanted: Record<string, boolean> = {};
  emails.forEach((email) => { wanted[normalizeEmail(email)] = true; });
  const records = await app.store.list(COLLECTIONS.milestoneEvents);
  return records.filter((event) => wanted[normalizeEmail(event.StudentId)]).map((event) => ({
    eventId: text(event.EventId),
    taskId: text(event.TaskId),
    studentId: normalizeEmail(event.StudentId),
    milestoneId: text(event.MilestoneId),
    type: text(event.EventType),
    comment: text(event.Comment),
    actor: normalizeEmail(event.Actor),
    at: event.CreatedAt ? text(event.CreatedAt) : '',
  }));
}

export function latestReturned(events: { type: string; taskId: string; at: string; comment: string }[]) {
  const latest: Record<string, { at: string; comment: string }> = {};
  events.forEach((event) => {
    if (event.type !== 'returned') return;
    const current = latest[event.taskId];
    if (!current || String(event.at) > String(current.at)) latest[event.taskId] = event;
  });
  return latest;
}

export async function recordMilestoneDecision(app: App, taskId: unknown, action: unknown, comment: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown, milestoneId?: unknown) {
  const user = await requireStaff(app, 'MILESTONE_DECISION');
  const email = normalizeEmail(studentEmail);
  const decision = text(action);
  if (!['approve', 'return', 'session'].includes(decision)) throw new HubError('Unknown milestone action.');
  const note = text(comment);
  if ((decision === 'return' || decision === 'session') && !note) throw new HubError('A comment is required.');
  if (note.length > 2000) throw new HubError('Comments must be 2,000 characters or fewer.');
  const context = await staffStudentContext(app, user, email, text(cohortId), 'MILESTONE_DECISION', viewAs);
  const aliases = identityAliases(context.roster, email);
  const requestedMilestone = text(milestoneId);
  return audited(app, user, `MILESTONE_${decision.toUpperCase()}`, { taskId: text(taskId), milestoneId: requestedMilestone, studentId: email, cohort: text(cohortId) }, async () => {
    let item = text(taskId) ? await findActionItem(app, text(taskId)) : null;
    if (item && !sameStudent(item, aliases)) throw new HubError('Task belongs to another student.');
    if (!item) {
      const tasks = await systemTasksForAliases(app, aliases, requestedMilestone);
      item = tasks[0] || null;
    }
    const template = await milestoneForStudent(app, email, item ? actionTemplateId(item) : requestedMilestone, text(cohortId));
    if (!template) throw new HubError('Milestone template not found.');
    if (!item) {
      if (!staffMayUpdateAllMilestones(user, context.roster, context.view)) throw new HubError('You cannot update this milestone.');
      item = newSystemTask(user, email, template, 'Pending', initialDueDate(context.roster, template, ''), text(cohortId));
      await app.store.set(COLLECTIONS.studentActionItems, text(item.TaskId), item);
    }
    const owner = text(template.mOwner).toLowerCase();
    const type = text(template.type).toLowerCase();
    if (!await staffMayUpdateSystemItem(app, user, context, item)) throw new HubError('You cannot update this milestone.');
    if (decision === 'return' && type !== 'approval' && owner === 'student') throw new HubError('Only a review milestone can be returned.');
    item.Status = decision === 'return' ? 'In Progress' : 'Completed';
    item.LastUpdated = nowIso();
    stampActors(item, user.email, false);
    await app.store.set(COLLECTIONS.studentActionItems, text(item.TaskId), item);
    const eventId = shortId('EVT_');
    await app.store.set(COLLECTIONS.milestoneEvents, eventId, {
      EventId: eventId,
      TaskId: text(item.TaskId),
      StudentId: email,
      MilestoneId: text(template.milestoneId),
      EventType: decision === 'approve' ? 'approved' : (decision === 'return' ? 'returned' : 'session_logged'),
      Comment: note,
      Actor: user.email,
      CreatedAt: nowIso(),
    });
    return { status: item.Status, taskId: text(item.TaskId) };
  });
}

const TASK_TITLE_LIMIT = 500;
const TASK_DESCRIPTION_LIMIT = 8000;

function taskStatusOptions(): string[] {
  return fieldConfig('studentActionItems', 'Status')?.options || ['Pending', 'In Progress', 'Completed'];
}

function requireTaskStatus(status: unknown): string {
  const value = text(status);
  const options = taskStatusOptions();
  if (!options.some((option) => option === value)) throw new HubError('Choose a valid task status.');
  return value;
}

function assignmentFields(payload: any) {
  const input = payload || {};
  const title = text(input.title);
  if (!title) throw new HubError('Title is required.');
  if (title.length > TASK_TITLE_LIMIT) throw new HubError(`Title must be ${TASK_TITLE_LIMIT} characters or fewer.`);
  const description = text(input.description);
  if (description.length > TASK_DESCRIPTION_LIMIT) throw new HubError(`Description must be ${TASK_DESCRIPTION_LIMIT.toLocaleString('en-US')} characters or fewer.`);
  const dueRaw = text(input.dueDate);
  let dueDate = '';
  if (dueRaw) {
    const parsed = parseActionDate(dueRaw);
    if (!parsed) throw new HubError('Due date must be a valid date.');
    dueDate = serializeDateOnly(parsed);
  }
  return {
    title,
    description,
    status: requireTaskStatus(input.status),
    dueDate,
    phaseId: text(input.phaseId),
  };
}

function massAssignmentFields(payload: any) {
  const input = payload || {};
  const updateStatus = toBoolean(input.updateStatus);
  const updateDate = toBoolean(input.updateDate);
  if (!updateStatus && !updateDate) throw new HubError('Choose the status, the due date, or both.');
  const status = updateStatus ? requireTaskStatus(input.status) : '';
  let dueDate = '';
  if (updateDate) {
    const parsed = parseActionDate(input.dueDate);
    if (!parsed) throw new HubError('Due date must be a valid date.');
    dueDate = serializeDateOnly(parsed);
  }
  return { updateStatus, status, updateDate, dueDate };
}

async function requireKnownPhase(app: App, phaseId: string, cohortId?: unknown) {
  if (!phaseId) throw new HubError('Choose a phase.');
  const known = (await phaseDocsFor(app, cohortId)).find((phase) => text(phase.phaseId) === phaseId);
  if (!known) throw new HubError('Choose a phase that exists.');
  return phaseId;
}

async function requireMilestoneEditor(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown, operation: string) {
  const user = await requireAdmin(app, operation);
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), operation, viewAs);
  if (!staffMayUpdateAllMilestones(user, context.roster, context.view)) {
    return deny(app, user, operation, 'You cannot edit milestones in this view.');
  }
  return { user, context };
}

function applyAssignment(item: Doc, changes: { title: string; description: string; status: string; dueDate: string }, phaseId: string, actor: string) {
  item.Title = changes.title;
  item.Description = changes.description;
  item.PhaseId = phaseId;
  item.Status = changes.status;
  item.DueDate = changes.dueDate;
  item.LastUpdated = nowIso();
  stampActors(item, actor, false);
  return item;
}

function assignmentResult(item: Doc) {
  return {
    taskId: text(item.TaskId),
    title: text(item.Title),
    description: text(item.Description),
    phaseId: text(item.PhaseId),
    status: text(item.Status),
    dueDate: text(item.DueDate),
  };
}

export async function updateMilestoneAssignment(app: App, taskId: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown, payload: unknown) {
  const editor = await requireMilestoneEditor(app, studentEmail, cohortId, viewAs, 'UPDATE_MILESTONE_ASSIGNMENT');
  const changes = assignmentFields(payload);
  const phaseId = await requireKnownPhase(app, changes.phaseId, cohortId);
  const id = text(taskId);
  const aliases = identityAliases(editor.context.roster, editor.context.email);
  const milestoneKey = text((payload as Doc | null)?.milestoneId);
  if (!id) {
    if (!milestoneKey) throw new HubError('Choose a milestone.');
    const template = await milestoneForStudent(app, editor.context.email, milestoneKey, cohortId);
    if (!template) throw new HubError('Milestone template not found.');
    return audited(app, editor.user, 'UPDATE_MILESTONE_ASSIGNMENT', {
      taskId: '',
      studentId: editor.context.email,
      cohort: text(cohortId),
      templateId: text(template.milestoneId),
    }, async () => {
      const tasks = await systemTasksForAliases(app, aliases, text(template.milestoneId));
      const target = tasks[0] || newSystemTask(editor.user, editor.context.email, template, changes.status, changes.dueDate, text(cohortId));
      applyAssignment(target, changes, phaseId, editor.user.email);
      await app.store.set(COLLECTIONS.studentActionItems, text(target.TaskId), target);
      for (const extra of tasks.slice(1)) {
        applyAssignment(extra, changes, phaseId, editor.user.email);
        await app.store.set(COLLECTIONS.studentActionItems, text(extra.TaskId), extra);
      }
      return assignmentResult(target);
    });
  }
  const existing = await findActionItem(app, id);
  if (!sameStudent(existing, aliases)) return deny(app, editor.user, 'UPDATE_MILESTONE_ASSIGNMENT', 'Task belongs to another student.');
  if (creatorKind(existing) !== 'System') throw new HubError('Only an assigned milestone can be edited here.');
  return audited(app, editor.user, 'UPDATE_MILESTONE_ASSIGNMENT', {
    taskId: id,
    studentId: editor.context.email,
    cohort: text(cohortId),
    templateId: actionTemplateId(existing),
  }, async () => {
    const item = await findActionItem(app, id);
    if (!sameStudent(item, aliases)) throw new HubError('Task belongs to another student.');
    if (creatorKind(item) !== 'System') throw new HubError('Only an assigned milestone can be edited here.');
    applyAssignment(item, changes, phaseId, editor.user.email);
    await app.store.set(COLLECTIONS.studentActionItems, text(item.TaskId), item);
    return assignmentResult(item);
  });
}

export async function setStaffMilestoneStatus(app: App, studentEmail: unknown, cohortId: unknown, milestoneId: unknown, status: unknown, viewAs: unknown) {
  const editor = await requireMilestoneEditor(app, studentEmail, cohortId, viewAs, 'SET_STAFF_MILESTONE_STATUS');
  const nextStatus = requireTaskStatus(status);
  const milestone = text(milestoneId);
  if (!milestone) throw new HubError('Choose a milestone.');
  const template = await milestoneForStudent(app, editor.context.email, milestone, cohortId);
  if (!template) throw new HubError('Milestone template not found.');
  const aliases = identityAliases(editor.context.roster, editor.context.email);
  return audited(app, editor.user, 'SET_STAFF_MILESTONE_STATUS', {
    studentId: editor.context.email,
    cohort: text(cohortId),
    milestoneId: text(template.milestoneId),
    status: nextStatus,
  }, async () => {
    const tasks = await systemTasksForAliases(app, aliases, text(template.milestoneId));
    const targets = tasks.length
      ? tasks
      : [newSystemTask(editor.user, editor.context.email, template, nextStatus, initialDueDate(editor.context.roster, template, ''), text(cohortId))];
    for (const item of targets) {
      item.Status = nextStatus;
      item.LastUpdated = nowIso();
      stampActors(item, editor.user.email, !text(item.CreatedBy));
      await app.store.set(COLLECTIONS.studentActionItems, text(item.TaskId), item);
    }
    return { status: nextStatus, taskId: text(targets[0].TaskId), updated: targets.length };
  });
}

export async function massUpdateMilestones(app: App, cohortId: unknown, studentIds: unknown, milestoneId: unknown, payload: unknown, viewAs: unknown) {
  const user = await requireAdmin(app, 'MASS_UPDATE_MILESTONES');
  const changes = massAssignmentFields(payload);
  const milestone = text(milestoneId);
  if (!milestone) throw new HubError('Choose a milestone.');
  if (!Array.isArray(studentIds) || !studentIds.length) throw new HubError('Select one or more students.');
  const emails: string[] = [];
  const seen: Record<string, boolean> = {};
  studentIds.forEach((value) => {
    const email = validateEmail(value, 'Student');
    if (seen[email]) throw new HubError('A student was selected more than once.');
    seen[email] = true;
    emails.push(email);
  });
  const cohort = text(cohortId);
  const contexts: Record<string, Awaited<ReturnType<typeof staffStudentContext>>> = {};
  for (const email of emails) {
    const context = await staffStudentContext(app, user, email, cohort, 'MASS_UPDATE_MILESTONES', viewAs);
    if (!staffMayUpdateAllMilestones(user, context.roster, context.view)) {
      return deny(app, user, 'MASS_UPDATE_MILESTONES', 'You cannot edit milestones in this view.');
    }
    contexts[email] = context;
  }
  const template = await milestoneForStudent(app, emails[0], milestone, cohort);
  const pending: { email: string; taskId: string }[] = [];
  const missing: string[] = [];
  for (const email of emails) {
    const aliases = identityAliases(contexts[email].roster, email);
    const tasks = await systemTasksForAliases(app, aliases, milestone);
    if (!tasks.length) {
      if (!template) throw new HubError('That milestone is not assigned to every selected student.');
      missing.push(email);
      continue;
    }
    tasks.forEach((task) => pending.push({ email, taskId: text(task.TaskId) }));
  }
  return audited(app, user, 'MASS_UPDATE_MILESTONES', {
    cohort,
    milestoneId: milestone,
    studentCount: emails.length,
    updateStatus: changes.updateStatus,
    updateDate: changes.updateDate,
    status: changes.status,
    dueDate: changes.dueDate,
  }, async () => {
    let updated = 0;
    for (const entry of pending) {
      const current = await findActionItem(app, entry.taskId);
      const aliases = identityAliases(contexts[entry.email].roster, entry.email);
      if (!sameStudent(current, aliases) || creatorKind(current) !== 'System' || actionTemplateId(current) !== milestone) {
        throw new HubError('That milestone is not assigned to every selected student.');
      }
      if (changes.updateStatus) current.Status = changes.status;
      if (changes.updateDate) current.DueDate = changes.dueDate;
      current.LastUpdated = nowIso();
      stampActors(current, user.email, false);
      await app.store.set(COLLECTIONS.studentActionItems, text(current.TaskId), current);
      updated += 1;
    }
    if (template) {
      for (const email of missing) {
        const due = changes.updateDate ? changes.dueDate : initialDueDate(contexts[email].roster, template, '');
        const created = newSystemTask(user, email, template, changes.updateStatus ? changes.status : 'Pending', due, cohort);
        await app.store.set(COLLECTIONS.studentActionItems, text(created.TaskId), created);
        updated += 1;
      }
    }
    return { updated, students: emails.length, milestoneId: milestone };
  });
}

export async function findSystemActionItem(app: App, studentEmail: string, templateId: string) {
  const email = normalizeEmail(studentEmail);
  const placement = await findPlacement(app, email);
  const tasks = await systemTasksForAliases(app, identityAliases(placement, email), text(templateId));
  return tasks[0] || null;
}

function todoFrom(record: Doc) {
  const active = record.Active;
  return {
    templateId: text(record.TemplateId),
    title: text(record.Title),
    description: text(record.Description),
    phaseId: text(record.PhaseId),
    owner: normalizeEmail(record.Owner),
    sortOrder: Number(record.SortOrder) || 0,
    active: active === '' || active === null || typeof active === 'undefined' ? true : toBoolean(active),
  };
}

export async function listTodoTemplatesFor(app: App, ownerEmail: string) {
  const owner = normalizeEmail(ownerEmail);
  const records = await app.store.list(COLLECTIONS.todoTemplates);
  return records.map(todoFrom).filter((template) => template.templateId && template.owner === owner && template.active)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title));
}

async function assertActivePhase(app: App, phaseId: unknown) {
  const phase = text(phaseId);
  if (!phase) return '';
  const known = await app.store.get(COLLECTIONS.phases, phase);
  if (!known || !toBoolean(known.active)) throw new HubError('Choose an active phase for this template.');
  return phase;
}

export async function saveTodoTemplate(app: App, payload: any) {
  const user = await requireStaff(app, 'SAVE_TODO_TEMPLATE');
  if (!user.permissions?.isSupervisor && !user.permissions?.canAdmin) return deny(app, user, 'SAVE_TODO_TEMPLATE', 'Supervisors and coordinators save template tasks.');
  const input = payload || {};
  const title = text(input.title);
  if (!title) throw new HubError('Template title is required.');
  if (title.length > 240) throw new HubError('Template title must be 240 characters or fewer.');
  const description = text(input.description);
  if (description.length > 2000) throw new HubError('Template note must be 2,000 characters or fewer.');
  const phase = await assertActivePhase(app, input.phaseId);
  const templateId = text(input.templateId);
  return audited(app, user, 'SAVE_TODO_TEMPLATE', { templateId, title, phaseId: phase }, async () => {
    const all = (await app.store.list(COLLECTIONS.todoTemplates)).map(todoFrom);
    const existing = templateId ? all.find((template) => template.templateId === templateId) : null;
    if (templateId && (!existing || existing.owner !== user.email)) throw new HubError('Choose one of your template tasks.');
    const owned = all.filter((template) => template.owner === user.email && template.active);
    const record = {
      TemplateId: existing ? existing.templateId : uuid(),
      Title: title,
      Description: description,
      PhaseId: phase,
      Owner: user.email,
      SortOrder: existing ? existing.sortOrder : owned.length + 1,
      Active: true,
    };
    await app.store.set(COLLECTIONS.todoTemplates, record.TemplateId, record);
    return todoFrom(record);
  });
}

export async function deleteTodoTemplate(app: App, templateId: unknown) {
  const user = await requireStaff(app, 'DELETE_TODO_TEMPLATE');
  if (!user.permissions?.isSupervisor && !user.permissions?.canAdmin) return deny(app, user, 'SAVE_TODO_TEMPLATE', 'Supervisors and coordinators save template tasks.');
  const id = text(templateId);
  const existing = (await app.store.list(COLLECTIONS.todoTemplates)).map(todoFrom).find((template) => template.templateId === id);
  if (!existing || existing.owner !== user.email) throw new HubError('Choose one of your template tasks.');
  return audited(app, user, 'DELETE_TODO_TEMPLATE', { templateId: id, title: existing.title }, async () => {
    await app.store.set(COLLECTIONS.todoTemplates, existing.templateId, {
      TemplateId: existing.templateId,
      Title: existing.title,
      Description: existing.description,
      PhaseId: existing.phaseId,
      Owner: existing.owner,
      SortOrder: existing.sortOrder,
      Active: false,
    });
    return { templateId: id, active: false };
  });
}

export async function applyTodoTemplate(app: App, templateId: unknown, studentEmail: unknown, cohortId: unknown, phaseId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'APPLY_TODO_TEMPLATE');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'APPLY_TODO_TEMPLATE', viewAs);
  if (!staffMayAddStudentTodo(user, context)) return deny(app, user, 'APPLY_TODO_TEMPLATE', 'You cannot add a to-do for this student.');
  const id = text(templateId);
  const template = (await app.store.list(COLLECTIONS.todoTemplates)).map(todoFrom).find((item) => item.templateId === id);
  if (!template || template.owner !== user.email || !template.active) throw new HubError('Choose one of your template tasks.');
  const phase = template.phaseId || text(phaseId);
  const input = await prepareTodo(app, template.title, phase, text(cohortId));
  return audited(app, user, 'APPLY_TODO_TEMPLATE', { templateId: id, studentId: context.email, phaseId: input.phase, title: input.title, cohort: text(cohortId) }, async () => {
    const values = stampActors({
      TaskId: shortId('ACT_'),
      StudentId: context.email,
      CreatorType: 'Student',
      TemplateId: '',
      PhaseId: input.phase,
      Title: input.title,
      Description: template.description,
      DueDate: '',
      Status: 'Pending',
      LastUpdated: nowIso(),
      cohortId: text(cohortId),
    }, user.email, true);
    await appendAction(app, values);
    return { TaskId: values.TaskId, StudentId: context.email, PhaseId: input.phase, Title: input.title, Description: template.description, CreatedBy: user.email };
  });
}

export async function readActionItemsForEmails(app: App, emails: Record<string, boolean>, aliasToLogin?: Record<string, string>) {
  const owner: Record<string, string> = {};
  Object.keys(emails).forEach((email) => {
    const id = normalizeEmail(email);
    if (id && emails[email]) owner[id] = id;
  });
  Object.keys(aliasToLogin || {}).forEach((alias) => {
    const from = normalizeEmail(alias);
    const login = normalizeEmail((aliasToLogin || {})[alias]);
    if (from && login && emails[login]) owner[from] = login;
  });
  const grouped: Record<string, any[]> = {};
  const records = await app.store.list(COLLECTIONS.studentActionItems);
  records.forEach((item) => {
    const email = owner[actionStudentId(item)];
    const templateId = actionTemplateId(item);
    if (!email || creatorKind(item) !== 'System' || !templateId) return;
    if (!grouped[email]) grouped[email] = [];
    grouped[email].push({
      taskId: text(item.TaskId),
      templateId,
      phaseId: text(item.PhaseId),
      title: text(item.Title),
      status: text(item.Status) || 'Pending',
      due: dateOnlyValue(item.DueDate),
    });
  });
  return grouped;
}

void readPhases;
