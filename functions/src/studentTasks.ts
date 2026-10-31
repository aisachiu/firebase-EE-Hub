import { requireCohort } from './roster';
import { adminSchema, COLLECTIONS, fieldConfig, tableHeaders, validateRecordFields } from './schema';
import { App, audited, requireAdmin } from './session';
import { dateOnlyValue, Doc, HubError, normalizeEmail, nowIso, parseActionDate, serializeDateOnly, shortId, text } from './util';

function optionValue(fieldName: string, value: unknown, fallback = ''): string {
  const raw = text(value) || fallback;
  const options = fieldConfig('studentActionItems', fieldName)?.options || [];
  return options.find((option) => option.toLowerCase() === raw.toLowerCase()) || raw;
}

function presentTask(record: Doc): Doc {
  const copy = { ...record };
  copy.TaskId = text(copy.TaskId);
  copy.cohortId = text(copy.cohortId);
  copy.StudentId = normalizeEmail(copy.StudentId);
  copy.DueDate = copy.DueDate ? dateOnlyValue(copy.DueDate) || text(copy.DueDate) : '';
  copy.LastUpdated = text(copy.LastUpdated);
  return copy;
}

export async function listStudentTasks(app: App, cohortId: unknown) {
  await requireAdmin(app, 'LIST_STUDENT_TASKS');
  const cohort = await requireCohort(app, text(cohortId));
  const records = (await app.store.whereEqual(COLLECTIONS.studentActionItems, 'cohortId', cohort.id))
    .map(presentTask)
    .sort((left, right) => text(left.DueDate).localeCompare(text(right.DueDate)) || text(left.Title).localeCompare(text(right.Title)) || text(left.TaskId).localeCompare(text(right.TaskId)));
  return { schema: adminSchema('studentActionItems', []), headers: tableHeaders('studentActionItems'), records };
}

export async function saveStudentTask(app: App, cohortId: unknown, record: Doc, originalKey: unknown) {
  const user = await requireAdmin(app, 'SAVE_STUDENT_TASK');
  const cohort = await requireCohort(app, text(cohortId));
  const keyName = text(originalKey);
  return audited(app, user, keyName ? 'UPDATE_STUDENT_TASK' : 'CREATE_STUDENT_TASK', { cohort: cohort.id, taskId: keyName }, async () => {
    const existing = keyName ? await app.store.get(COLLECTIONS.studentActionItems, keyName) : null;
    if (keyName && !existing) throw new HubError('Record no longer exists. Refresh and try again.');
    if (existing && text(existing.cohortId) !== cohort.id) throw new HubError('This task belongs to another cohort.');
    const values = { ...(record || {}) };
    const taskId = existing ? text(existing.TaskId) : shortId('ACT_');
    values.TaskId = taskId;
    values.cohortId = cohort.id;
    values.StudentId = normalizeEmail(values.StudentId);
    values.CreatorType = optionValue('CreatorType', values.CreatorType);
    values.Status = optionValue('Status', values.Status, 'Pending');
    values.Title = text(values.Title);
    values.Description = text(values.Description);
    values.TemplateId = text(values.TemplateId);
    values.PhaseId = text(values.PhaseId);
    const dueRaw = text(values.DueDate);
    if (dueRaw) {
      const parsed = parseActionDate(dueRaw);
      if (!parsed) throw new HubError('DueDate must be a valid date.');
      values.DueDate = serializeDateOnly(parsed);
    } else values.DueDate = '';
    values.LastUpdated = nowIso();
    values.UpdatedBy = user.email;
    values.CreatedBy = existing ? (normalizeEmail(existing.CreatedBy) || user.email) : user.email;
    const member = await app.store.getMember(cohort.id, values.StudentId);
    if (!member) throw new HubError('Student is not in the selected cohort.');
    validateRecordFields('studentActionItems', values, existing ? taskId : '');
    const stored = existing ? { ...existing, ...values } : { ...values };
    stored.cohortId = cohort.id;
    stored.TaskId = taskId;
    await app.store.set(COLLECTIONS.studentActionItems, taskId, stored);
    return { key: taskId };
  });
}

export async function deleteStudentTask(app: App, cohortId: unknown, taskId: unknown) {
  const user = await requireAdmin(app, 'DELETE_STUDENT_TASK');
  const cohort = await requireCohort(app, text(cohortId));
  const id = text(taskId);
  if (!id) throw new HubError('A record key is required.');
  return audited(app, user, 'DELETE_STUDENT_TASK', { cohort: cohort.id, taskId: id }, async () => {
    const existing = await app.store.get(COLLECTIONS.studentActionItems, id);
    if (!existing) throw new HubError('Record not found.');
    if (text(existing.cohortId) !== cohort.id) throw new HubError('This task belongs to another cohort.');
    await app.store.remove(COLLECTIONS.studentActionItems, id);
    return { deleted: true, key: id };
  });
}
