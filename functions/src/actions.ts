import { canCompleteMilestone, HubUser } from './permissions';
import { findPlacement, Placement, readPhases, staffMayAddStudentTodo, staffMayUpdateAllMilestones, staffStudentContext } from './roster';
import { COLLECTIONS, fieldConfig } from './schema';
import { App, audited, deny, requireStaff, requireUser } from './session';
import { addDays, dateOnlyValue, Doc, HubError, normalizeEmail, nowIso, parseActionDate, serializeDateOnly, shortId, text, toBoolean, uuid, validateEmail } from './util';
import { formWritesClosed } from './formsPure';

export async function getStudentActionItems(app: App, studentEmail: string, user: HubUser | null) {
  const normalizedStudentId = normalizeEmail(studentEmail);
  const records = (await app.store.whereEqual(COLLECTIONS.studentActionItems, 'StudentId', normalizedStudentId));
  const templates = await app.store.list(COLLECTIONS.milestoneTemplates);
  const templateOwners: Record<string, string> = {};
  const templateTypes: Record<string, string> = {};
  templates.forEach((template) => {
    templateOwners[text(template.milestoneId)] = text(template.mOwner).toLowerCase();
    templateTypes[text(template.milestoneId)] = text(template.type).toLowerCase();
  });
  const placement = user && user.role === 'staff' ? await findPlacement(app, normalizedStudentId) : null;
  const items = [];
  for (const source of records) {
    const item: Doc = { ...source };
    item.TaskId = text(item.TaskId);
    item.CreatorType = text(item.CreatorType);
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

async function prepareTodo(app: App, title: unknown, phaseId: unknown) {
  const taskTitle = text(title);
  if (!taskTitle) throw new HubError('To-Do title is required.');
  if (taskTitle.length > 240) throw new HubError('To-Do title must be 240 characters or fewer.');
  const phase = text(phaseId);
  if (phase) {
    const known = await app.store.get(COLLECTIONS.phases, phase);
    if (!known || !toBoolean(known.active)) throw new HubError('Choose an active phase for this to-do.');
  }
  return { title: taskTitle, phase };
}

async function appendAction(app: App, values: Doc) {
  await app.store.set(COLLECTIONS.studentActionItems, text(values.TaskId), values);
}

export async function addStudentTodo(app: App, title: unknown, phaseId: unknown) {
  const user = await requireUser(app, 'ADD_STUDENT_TODO');
  if (user.role !== 'student') return deny(app, user, 'ADD_STUDENT_TODO', 'Student access required.');
  const input = await prepareTodo(app, title, phaseId);
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
    }, user.email, true);
    await appendAction(app, values);
    return { TaskId: values.TaskId };
  });
}

export async function addStaffStudentTodo(app: App, title: unknown, phaseId: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'ADD_STAFF_STUDENT_TODO');
  const input = await prepareTodo(app, title, phaseId);
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'ADD_STAFF_STUDENT_TODO', viewAs);
  if (!staffMayAddStudentTodo(user, context)) return deny(app, user, 'ADD_STAFF_STUDENT_TODO', 'You cannot add a to-do for this student.');
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
  if (item.CreatorType === 'Student') {
    if (user.role !== 'student' || normalizeEmail(item.StudentId) !== user.email) {
      return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Only the creating student can change this To-Do.');
    }
    return;
  }
  if (item.CreatorType !== 'System') throw new HubError('Unsupported action-item creator type.');
  const template = await app.store.get(COLLECTIONS.milestoneTemplates, text(item.TemplateId));
  const placement = template && text(template.mOwner).toLowerCase() === 'supervisor' ? await findPlacement(app, item.StudentId) : null;
  if (!template || !canCompleteMilestone(user, item.StudentId, text(template.mOwner).toLowerCase(), text(template.type).toLowerCase(), placement)) {
    return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Only the milestone owner can change this status.');
  }
}

export async function staffMayUpdateSystemItem(app: App, user: HubUser, context: { view: string; roster: Placement }, record: Doc) {
  if (!context || text(record.CreatorType) !== 'System') return false;
  if (staffMayUpdateAllMilestones(user, context.roster, context.view)) return true;
  if (context.view === 'staff') return false;
  const template = await app.store.get(COLLECTIONS.milestoneTemplates, text(record.TemplateId));
  if (!template) return false;
  const placement = context.roster;
  return canCompleteMilestone(user, record.StudentId, text(template.mOwner).toLowerCase(), text(template.type).toLowerCase(), placement);
}

export async function setActionItemStatus(app: App, taskId: unknown, status: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireUser(app, 'SET_ACTION_ITEM_STATUS');
  const targetStudentId = user.role === 'student' ? user.email : normalizeEmail(studentEmail);
  const item = await findActionItem(app, text(taskId));
  if (normalizeEmail(item.StudentId) !== targetStudentId) return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Task belongs to another student.');
  let staffContext = null as Awaited<ReturnType<typeof staffStudentContext>> | null;
  if (user.role === 'staff') {
    staffContext = await staffStudentContext(app, user, targetStudentId, text(cohortId), 'SET_ACTION_ITEM_STATUS', viewAs);
    if (text(item.CreatorType) === 'Student') return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Staff can only read student to-dos.');
  } else if (user.role !== 'student' || targetStudentId !== user.email) {
    return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'Student access required.');
  }
  const statusField = fieldConfig('studentActionItems', 'Status');
  if (!statusField?.options?.some((option) => option === status)) throw new HubError('Choose a valid task status.');
  if (staffContext) {
    if (!await staffMayUpdateSystemItem(app, user, staffContext, item)) return deny(app, user, 'SET_ACTION_ITEM_STATUS', 'You cannot update this milestone.');
  } else {
    await requireActionStatus(app, user, item);
  }
  return audited(app, user, 'UPDATE_ACTION_ITEM_STATUS', { taskId: text(taskId), studentId: targetStudentId, status }, async () => {
    const current = await findActionItem(app, text(taskId));
    if (normalizeEmail(current.StudentId) !== targetStudentId) throw new HubError('Task belongs to another student.');
    if (text(current.CreatorType) !== text(item.CreatorType)) throw new HubError('This task changed. Refresh and try again.');
    current.Status = status;
    current.LastUpdated = nowIso();
    stampActors(current, user.email, false);
    await app.store.set(COLLECTIONS.studentActionItems, text(current.TaskId), current);
    return { status };
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
    const templates = await app.store.list(COLLECTIONS.milestoneTemplates);
    if (!templates.length) throw new HubError('MILESTONE_TEMPLATES has no milestone templates.');
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
  const templates = await app.store.list(COLLECTIONS.milestoneTemplates);
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

export async function recordMilestoneDecision(app: App, taskId: unknown, action: unknown, comment: unknown, studentEmail: unknown, cohortId: unknown, viewAs: unknown) {
  const user = await requireStaff(app, 'MILESTONE_DECISION');
  const email = normalizeEmail(studentEmail);
  const decision = text(action);
  if (!['approve', 'return', 'session'].includes(decision)) throw new HubError('Unknown milestone action.');
  const note = text(comment);
  if ((decision === 'return' || decision === 'session') && !note) throw new HubError('A comment is required.');
  if (note.length > 2000) throw new HubError('Comments must be 2,000 characters or fewer.');
  const context = await staffStudentContext(app, user, email, text(cohortId), 'MILESTONE_DECISION', viewAs);
  return audited(app, user, `MILESTONE_${decision.toUpperCase()}`, { taskId: text(taskId), studentId: email, cohort: text(cohortId) }, async () => {
    const item = await findActionItem(app, text(taskId));
    if (normalizeEmail(item.StudentId) !== email) throw new HubError('Task belongs to another student.');
    const template = await app.store.get(COLLECTIONS.milestoneTemplates, text(item.TemplateId));
    if (!template) throw new HubError('Milestone template not found.');
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
    return { status: item.Status };
  });
}

export async function findSystemActionItem(app: App, studentEmail: string, templateId: string) {
  const items = await app.store.whereEqual(COLLECTIONS.studentActionItems, 'StudentId', normalizeEmail(studentEmail));
  return items.find((item) => text(item.TemplateId) === text(templateId) && text(item.CreatorType) === 'System') || null;
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
  const input = await prepareTodo(app, template.title, phase);
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
    }, user.email, true);
    await appendAction(app, values);
    return { TaskId: values.TaskId, StudentId: context.email, PhaseId: input.phase, Title: input.title, Description: template.description, CreatedBy: user.email };
  });
}

export async function readActionItemsForEmails(app: App, emails: Record<string, boolean>) {
  const grouped: Record<string, any[]> = {};
  const records = await app.store.list(COLLECTIONS.studentActionItems);
  records.forEach((item) => {
    const email = normalizeEmail(item.StudentId);
    if (!emails[email] || text(item.CreatorType) !== 'System') return;
    if (!grouped[email]) grouped[email] = [];
    grouped[email].push({
      taskId: text(item.TaskId),
      templateId: text(item.TemplateId),
      phaseId: text(item.PhaseId),
      title: text(item.Title),
      status: text(item.Status) || 'Pending',
      due: dateOnlyValue(item.DueDate),
    });
  });
  return grouped;
}

void readPhases;
