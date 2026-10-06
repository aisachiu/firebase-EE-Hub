import { findSystemActionItem } from './actions';
import { FormField, formClosedMessage, formWritesClosed, lintFormSource, normalizeFormFields, starterFor, validateFormAnswers } from './formsPure';
import { findPlacement } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, deny, requireAdmin, requireStaff, requireUser } from './session';
import { Doc, HubError, normalizeEmail, nowIso, text, textHash, toBoolean } from './util';

function formResponseId(milestoneId: string, email: string) {
  return `${text(milestoneId)}__${encodeURIComponent(normalizeEmail(email))}`;
}

function definitionFrom(record: Doc) {
  let fields: FormField[] = [];
  try { fields = normalizeFormFields(JSON.parse(text(record.fieldsJson) || '[]')); }
  catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError('Stored form fields are not valid JSON.');
  }
  return {
    milestoneId: text(record.milestoneId),
    status: text(record.status) || 'Draft',
    version: Number(record.version) || 0,
    fields,
    html: String(record.html || ''),
    js: String(record.js || ''),
    submitCompletes: toBoolean(record.submitCompletes),
    lastUpdated: record.LastUpdated ? text(record.LastUpdated) : '',
  };
}

async function requireFormTemplate(app: App, milestoneId: string) {
  const template = await app.store.get(COLLECTIONS.milestoneTemplates, text(milestoneId));
  if (!template || text(template.type).toLowerCase() !== 'form') throw new HubError('Choose a form milestone.');
  return template;
}

async function subjectNames(app: App) {
  const subjects = await app.store.list(COLLECTIONS.subjects);
  return subjects.filter((subject) => subject.Active === '' || subject.Active === undefined || toBoolean(subject.Active))
    .map((subject) => text(subject.Name)).filter(Boolean);
}

function resolveOptions(fields: FormField[], names: string[]) {
  return fields.map((field) => ({
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    maxLength: field.maxLength,
    maxSelections: field.maxSelections || 0,
    options: field.optionsFrom === 'subjects' ? names.slice() : field.options.slice(),
  }));
}

function payloadToDefinition(milestoneId: string, payload: any) {
  const source = payload || {};
  const definition = {
    milestoneId: text(milestoneId),
    fields: normalizeFormFields(source.fields),
    html: String(source.html || ''),
    js: String(source.js || ''),
    submitCompletes: source.submitCompletes !== false && text(source.submitCompletes).toLowerCase() !== 'false',
  };
  lintFormSource(definition.html, definition.js);
  return definition;
}

async function responsesFor(app: App, milestoneId: string) {
  return app.store.whereEqual(COLLECTIONS.formResponses, 'MilestoneId', text(milestoneId));
}

function fieldNames(fields: { name: string }[]) {
  return fields.map((field) => field.name);
}

async function writeDefinition(app: App, userEmail: string, definition: { milestoneId: string; fields: FormField[]; html: string; js: string; submitCompletes: boolean }, status: string, version?: number) {
  const existingRecord = await app.store.get(COLLECTIONS.formDefinitions, definition.milestoneId);
  const existing = existingRecord ? definitionFrom(existingRecord) : null;
  let nextVersion = version === undefined || version === null ? (existing ? existing.version : 0) : version;
  let nextStatus = status || (existing ? existing.status : 'Draft');
  if (!status && nextStatus === 'Published' && existing && fieldNames(existing.fields).join('\u0000') !== fieldNames(definition.fields).join('\u0000')) {
    nextStatus = 'Draft';
  }
  if (version === undefined || version === null) nextVersion = existing ? existing.version : 0;
  const values = {
    milestoneId: definition.milestoneId,
    status: nextStatus,
    version: nextVersion,
    fieldsJson: JSON.stringify(definition.fields),
    html: definition.html,
    js: definition.js,
    submitCompletes: definition.submitCompletes,
    LastUpdated: nowIso(),
    UpdatedBy: userEmail,
  };
  await app.store.set(COLLECTIONS.formDefinitions, definition.milestoneId, values);
  return nextStatus;
}

function assertAppendOnly(existingCount: number, previous: string[], next: string[]) {
  if (!existingCount) return;
  const appended = next.slice(0, previous.length).every((name, index) => name === previous[index]);
  if (!appended || next.length < previous.length) {
    throw new HubError('Published fields can only be appended. Rename or delete is blocked while responses exist.');
  }
}

export async function listFormMilestones(app: App) {
  await requireAdmin(app, 'LIST_FORMS');
  const templates = (await app.store.list(COLLECTIONS.milestoneTemplates)).filter((template) => text(template.type).toLowerCase() === 'form');
  const result = [];
  for (const template of templates) {
    const record = await app.store.get(COLLECTIONS.formDefinitions, text(template.milestoneId));
    result.push({
      milestoneId: text(template.milestoneId),
      title: text(template.milestoneTitle),
      phase: text(template.phase),
      status: record ? text(record.status) : 'Not started',
      version: record ? Number(record.version) || 0 : 0,
    });
  }
  return result;
}

export async function getFormDesigner(app: App, milestoneId: unknown) {
  const user = await requireAdmin(app, 'VIEW_FORM_DESIGN');
  const template = await requireFormTemplate(app, text(milestoneId));
  const record = await app.store.get(COLLECTIONS.formDefinitions, text(milestoneId));
  const definition = record ? definitionFrom(record) : starterFor(text(template.milestoneId));
  const responses = await responsesFor(app, text(template.milestoneId));
  return {
    milestoneId: text(template.milestoneId),
    title: text(template.milestoneTitle),
    definition,
    sheetName: `FORM: ${text(template.milestoneId)}`,
    responseCount: responses.length,
    subjectNames: await subjectNames(app),
    designer: user.email,
  };
}

export async function saveFormDraft(app: App, milestoneId: unknown, payload: any) {
  const user = await requireAdmin(app, 'SAVE_FORM_DRAFT');
  await requireFormTemplate(app, text(milestoneId));
  const definition = payloadToDefinition(text(milestoneId), payload);
  return audited(app, user, 'SAVE_FORM_DRAFT', { milestoneId: definition.milestoneId, fields: fieldNames(definition.fields) }, async () => {
    const status = await writeDefinition(app, user.email, definition, '');
    return { status, milestoneId: definition.milestoneId };
  });
}

export async function publishForm(app: App, milestoneId: unknown, payload: any) {
  const user = await requireAdmin(app, 'PUBLISH_FORM');
  await requireFormTemplate(app, text(milestoneId));
  const id = text(milestoneId);
  return audited(app, user, 'FORM_PUBLISH', { milestoneId: id }, async () => {
    const existing = await app.store.get(COLLECTIONS.formDefinitions, id);
    let definition = payload ? payloadToDefinition(id, payload) : null;
    if (!definition) {
      if (!existing) throw new HubError('Save the form before publishing.');
      const stored = definitionFrom(existing);
      definition = { milestoneId: stored.milestoneId, fields: stored.fields, html: stored.html, js: stored.js, submitCompletes: stored.submitCompletes };
    }
    const previousFields = existing ? definitionFrom(existing).fields.map((field) => field.name) : [];
    const responses = await responsesFor(app, id);
    assertAppendOnly(responses.length, previousFields, fieldNames(definition.fields));
    const version = (existing ? Number(existing.version) || 0 : 0) + 1;
    await writeDefinition(app, user.email, definition, 'Published', version);
    return { status: 'Published', version, sheetName: `FORM: ${id}` };
  });
}

function readResponse(record: Doc | null, fields: FormField[]) {
  if (!record) return null;
  const answers: Record<string, string> = {};
  fields.forEach((field) => {
    answers[field.name] = record[field.name] === undefined || record[field.name] === null ? '' : String(record[field.name]);
  });
  return { values: answers, status: text(record.Status), version: Number(record.FormVersion) || 0, lastUpdated: record.LastUpdated ? text(record.LastUpdated) : '' };
}

export async function publishedFormIds(app: App) {
  const records = await app.store.list(COLLECTIONS.formDefinitions);
  return records.filter((record) => text(record.status) === 'Published').map((record) => text(record.milestoneId));
}

export async function getStudentForm(app: App, milestoneId: unknown) {
  const user = await requireUser(app, 'VIEW_FORM');
  if (user.role !== 'student') return deny(app, user, 'VIEW_FORM', 'Student access required.');
  const record = await app.store.get(COLLECTIONS.formDefinitions, text(milestoneId));
  if (!record || text(record.status) !== 'Published') throw new HubError('This form is not published yet.');
  const definition = definitionFrom(record);
  const template = await app.store.get(COLLECTIONS.milestoneTemplates, definition.milestoneId);
  if (!template || text(template.type).toLowerCase() !== 'form') throw new HubError('Choose a form milestone.');
  const placement = await findPlacement(app, user.email);
  const response = await app.store.get(COLLECTIONS.formResponses, formResponseId(definition.milestoneId, user.email));
  const item = await findSystemActionItem(app, user.email, definition.milestoneId);
  const due = item ? item.DueDate : '';
  const formOpen = !formWritesClosed(due, new Date(), app.timeZone);
  const names = await subjectNames(app);
  return {
    milestoneId: definition.milestoneId,
    title: text(template.milestoneTitle),
    version: definition.version,
    html: definition.html,
    js: definition.js,
    fields: resolveOptions(definition.fields, names),
    response: readResponse(response, definition.fields),
    formOpen,
    submitCompletes: definition.submitCompletes !== false,
    closedMessage: formOpen ? '' : formClosedMessage(due, app.timeZone),
    student: { displayName: placement?.displayName || user.displayName, subject: placement?.subject || '' },
  };
}

export async function saveStudentForm(app: App, milestoneId: unknown, payload: any) {
  const user = await requireUser(app, 'SAVE_FORM');
  if (user.role !== 'student') return deny(app, user, 'SAVE_FORM', 'Student access required.');
  const source = payload || {};
  const submit = source.submit === true || text(source.submit).toLowerCase() === 'true';
  const record = await app.store.get(COLLECTIONS.formDefinitions, text(milestoneId));
  if (!record || text(record.status) !== 'Published') throw new HubError('This form is not published yet.');
  const definition = definitionFrom(record);
  const names = await subjectNames(app);
  const answers = validateFormAnswers(definition.fields, source.values || {}, submit, names);
  const clientToken = text(source.lastUpdated);
  return audited(app, user, submit ? 'FORM_SUBMIT' : 'FORM_DRAFT', {
    milestoneId: definition.milestoneId,
    studentId: user.email,
    version: definition.version,
    fields: fieldNames(definition.fields),
    hash: textHash(JSON.stringify(answers)),
  }, async () => {
    const fresh = await app.store.get(COLLECTIONS.formDefinitions, definition.milestoneId);
    if (!fresh || Number(fresh.version) !== definition.version || text(fresh.status) !== 'Published') {
      throw new HubError('This form was republished. Reload it and try again.');
    }
    const item = await findSystemActionItem(app, user.email, definition.milestoneId);
    const due = item ? item.DueDate : '';
    if (formWritesClosed(due, new Date(), app.timeZone)) throw new HubError(formClosedMessage(due, app.timeZone));
    const responseId = formResponseId(definition.milestoneId, user.email);
    const current = await app.store.get(COLLECTIONS.formResponses, responseId);
    if (current) {
      if (text(current.LastUpdated) !== clientToken) throw new HubError('This form changed in another tab. Reload it and try again.');
    } else if (clientToken) {
      throw new HubError('This form changed in another tab. Reload it and try again.');
    }
    const now = nowIso();
    const stored: Doc = {
      MilestoneId: definition.milestoneId,
      StudentId: user.email,
      FormVersion: definition.version,
      Status: submit ? 'Submitted' : 'Draft',
      SubmittedAt: submit ? now : '',
      LastUpdated: now,
    };
    definition.fields.forEach((field) => { stored[field.name] = answers[field.name]; });
    if (current && !submit && text(current.Status) === 'Submitted') stored.SubmittedAt = current.SubmittedAt;
    await app.store.set(COLLECTIONS.formResponses, responseId, stored);
    if (submit && definition.submitCompletes && item) {
      item.Status = 'Completed';
      item.LastUpdated = now;
      item.UpdatedBy = user.email;
      await app.store.set(COLLECTIONS.studentActionItems, text(item.TaskId), item);
    }
    return { status: stored.Status, lastUpdated: now };
  });
}

export async function getFormResponse(app: App, milestoneId: unknown, studentEmail: unknown) {
  const user = await requireStaff(app, 'VIEW_FORM_RESPONSE');
  const email = normalizeEmail(studentEmail);
  const record = await app.store.get(COLLECTIONS.formDefinitions, text(milestoneId));
  if (!record || text(record.status) !== 'Published') throw new HubError('This form is not published yet.');
  const definition = definitionFrom(record);
  const placement = await findPlacement(app, email);
  if (!placement) throw new HubError('Student was not found on a cohort roster.');
  const allowed = user.permissions?.canAdmin || placement.supervisorId === user.email || !placement.supervisorId;
  if (!allowed) return deny(app, user, 'VIEW_FORM_RESPONSE', 'Form answers are visible to the assigned supervisor.');
  const template = await requireFormTemplate(app, definition.milestoneId);
  const response = await app.store.get(COLLECTIONS.formResponses, formResponseId(definition.milestoneId, email));
  const names = await subjectNames(app);
  return {
    milestoneId: definition.milestoneId,
    title: text(template.milestoneTitle),
    fields: resolveOptions(definition.fields, names),
    response: readResponse(response, definition.fields),
  };
}
