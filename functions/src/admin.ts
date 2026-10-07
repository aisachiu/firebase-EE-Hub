import { validatePhasePrerequisites } from './phaseRules';
import { listCohorts, placementFromMember, requireCohort } from './roster';
import { adminSchema, cohortSheetName, COLLECTIONS, docIdFor, fieldConfig, staffHasAdminAccess, tableConfig, tableHeaders, tableKey, validateRecordFields } from './schema';
import { App, audited, requireAdmin } from './session';
import { validateTicketCategory } from './messaging';
import { assertSafeResourceHtml } from './formsPure';
import { Doc, driveNamePart, HubError, normalizeEmail, text, toBoolean, uuid, validateEmail } from './util';

const BUILTIN_QUOTES = [
  'A clear question is the start of a strong essay.',
  'Write the next sentence. The essay grows one line at a time.',
  'Revision is where good thinking becomes clear writing.',
  'Small steady steps finish a long project.',
  'Read closely, then write in your own words.',
  'A draft is a place to think, not a final verdict.',
  'Keep your sources close and your claims careful.',
  'Progress is a page, a note, or a better question.',
  'Perseverance turns a rough idea into a finished essay.',
  'Ask for feedback, then make the work more precise.',
];

function coerce(entity: string, values: Doc) {
  tableConfig(entity).fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(values, field.name)) return;
    const value = values[field.name];
    if (value === '' || value === undefined || value === null) return;
    if (field.type === 'number' && isFinite(Number(value))) values[field.name] = Number(value);
    if (field.type === 'checkbox') values[field.name] = toBoolean(value);
  });
  return values;
}

async function phases(app: App) {
  return app.store.list(COLLECTIONS.phases);
}

export async function getAdminRecords(app: App, entity: string) {
  await requireAdmin(app, `LIST_${String(entity || '').toUpperCase()}`);
  if (entity === 'cohortMembers') throw new HubError('Choose a cohort to manage its students.');
  const config = tableConfig(entity);
  if (config.internal) throw new HubError('Internal sheets cannot be managed through Admin.');
  const schema = adminSchema(entity, await phases(app));
  const headers = tableHeaders(entity);
  if (entity === 'cohorts') {
    return {
      schema,
      headers,
      records: (await listCohorts(app, true)).map((item) => ({ Cohort: item.id, SheetName: item.sheetName, Status: item.status || 'Active' })),
    };
  }
  let records = await app.store.list(COLLECTIONS[entity]);
  if (entity === 'phases') records = records.sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (entity === 'milestoneTemplates') records = records.sort((left, right) => Number(left.position || 0) - Number(right.position || 0));
  return { schema, headers, records };
}

export async function getCohortMembersForAdmin(app: App, cohortId: unknown) {
  await requireAdmin(app, 'LIST_COHORT_MEMBERS');
  const cohort = await requireCohort(app, text(cohortId), true);
  const records = (await app.store.listMembers(cohort.id)).map((record) => ({ ...record, hasStudentIdConflict: false }));
  return { schema: adminSchema('cohortMembers', await phases(app)), headers: tableHeaders('cohortMembers'), records };
}

async function assertAnotherAdmin(app: App, excludedEmail: string) {
  const staff = await app.store.list(COLLECTIONS.staffUsers);
  const hasAnother = staff.some((row) => normalizeEmail(row.EMAIL) !== normalizeEmail(excludedEmail) && toBoolean(row.isStaff) && staffHasAdminAccess(row));
  if (!hasAnother) throw new HubError('Keep at least one active admin or coordinator account.');
}

export async function saveAdminRecord(app: App, entity: string, record: Doc, originalKey: unknown) {
  const user = await requireAdmin(app, `SAVE_${String(entity || '').toUpperCase()}`);
  const config = tableConfig(entity);
  if (config.internal) throw new HubError('Internal sheets cannot be managed through Admin.');
  if (entity === 'cohortMembers') throw new HubError('Use the cohort student editor.');
  const keyName = originalKey ? text(originalKey) : '';
  if (entity === 'cohorts') return saveCohort(app, user.email, record || {}, keyName);
  const values = coerce(entity, { ...(record || {}) });
  validateRecordFields(entity, values, keyName);
  if (entity === 'studentUsers') values.studentEmail = normalizeEmail(values.StudentId);
  if (entity === 'milestoneTemplates') {
    values.type = text(values.type).toLowerCase();
    values.mOwner = text(values.mOwner).toLowerCase();
    const milestonePhase = await app.store.get(COLLECTIONS.phases, text(values.phase));
    if (!milestonePhase || !toBoolean(milestonePhase.active)) throw new HubError('Choose an active phase before saving this milestone.');
  }
  if (entity === 'phases') {
    values.phaseId = text(values.phaseId).toLowerCase();
    values.sequence = Number(values.sequence);
    values.active = values.active === undefined || values.active === '' ? true : toBoolean(values.active);
    const existing = await phases(app);
    validatePhasePrerequisites(existing.map((phase) => ({ phaseId: text(phase.phaseId), prerequisitePhaseId: text(phase.prerequisitePhaseId) })), values.phaseId, text(values.prerequisitePhaseId), keyName);
  }
  if (entity === 'staffUsers') {
    validateEmail(values.EMAIL, 'Staff email');
    if (!toBoolean(values.isStaff) && !toBoolean(values.isSupervisor) && !toBoolean(values.isLead) && !toBoolean(values.isCoordinator) && !toBoolean(values.isAdmin)) {
      throw new HubError('Select at least one staff role.');
    }
    values.isStaff = true;
  }
  if (entity === 'resources') {
    if (text(values.Body).length > 40000) throw new HubError('Body must be 40,000 characters or fewer.');
    values['Body Format'] = text(values['Body Format']).toLowerCase() || 'plain';
    if (values['Body Format'] === 'html') assertSafeResourceHtml(text(values.Body));
    if (toBoolean(values.Published) && !text(values.URL) && !text(values.Body)) throw new HubError('A published resource needs a URL or a body.');
  }
  if (entity === 'ticketCategories') await validateTicketCategory(app, values, keyName);
  const key = tableKey(entity);
  const keyField = fieldConfig(entity, key);
  if (!text(values[key]) && !keyName && keyField?.generated) values[key] = uuid();
  if (!text(values[key])) throw new HubError(`${key} is required.`);
  if (keyName && text(values[key]) !== keyName) throw new HubError(`${key} cannot be changed.`);
  const id = docIdFor(entity, values);
  return audited(app, user, keyName ? `UPDATE_${entity.toUpperCase()}` : `CREATE_${entity.toUpperCase()}`, { entity, key: keyName || id }, async () => {
    const existing = await app.store.get(COLLECTIONS[entity], keyName || id);
    if (keyName && !existing) throw new HubError('Record no longer exists. Refresh and try again.');
    if (!keyName && await app.store.get(COLLECTIONS[entity], id)) throw new HubError(`A record with this ${key} already exists.`);
    if (entity === 'staffUsers' && keyName && existing && staffHasAdminAccess(existing) && !staffHasAdminAccess(values)) {
      await assertAnotherAdmin(app, keyName);
    }
    if (entity === 'milestoneTemplates' && !existing) {
      const all = await app.store.list(COLLECTIONS.milestoneTemplates);
      values.position = all.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0) + 1;
    }
    const stored = existing ? { ...existing, ...values } : values;
    await app.store.set(COLLECTIONS[entity], id, stored);
    return { key: id };
  });
}

async function saveCohort(app: App, _actor: string, record: Doc, originalKey: string) {
  const user = await requireAdmin(app, originalKey ? 'UPDATE_COHORT' : 'CREATE_COHORT');
  const values = record || {};
  validateRecordFields('cohorts', values, originalKey);
  const cohortId = text(values.Cohort);
  if (!/^\d{4}$/.test(cohortId)) throw new HubError('Cohort must be a four-digit year.');
  const sheetName = cohortSheetName(cohortId);
  return audited(app, user, originalKey ? 'UPDATE_COHORT' : 'CREATE_COHORT', { cohort: cohortId }, async () => {
    const existing = await app.store.get(COLLECTIONS.cohorts, cohortId);
    if (!originalKey && existing) throw new HubError('This cohort already exists.');
    await app.store.set(COLLECTIONS.cohorts, cohortId, {
      Cohort: cohortId,
      SheetName: sheetName,
      Status: text(values.Status) || 'Active',
      DriveRootFolderId: existing ? text(existing.DriveRootFolderId) : '',
      FolderPrefix: existing ? driveNamePart(existing.FolderPrefix) : '',
      FolderSuffix: existing ? driveNamePart(existing.FolderSuffix) : '',
    });
    return { key: cohortId };
  });
}

export async function deleteAdminRecord(app: App, entity: string, keyValue: unknown) {
  const user = await requireAdmin(app, `DELETE_${String(entity || '').toUpperCase()}`);
  const config = tableConfig(entity);
  if (config.internal) throw new HubError('Internal sheets cannot be managed through Admin.');
  if (entity === 'cohortMembers') throw new HubError('Use the cohort student editor.');
  const key = text(keyValue);
  if (!key) throw new HubError('A record key is required.');
  return audited(app, user, `DELETE_${entity.toUpperCase()}`, { entity, key, mode: entity === 'cohorts' ? 'archive' : 'delete' }, async () => {
    if (entity === 'cohorts') {
      const cohortId = /^\d{4}$/.test(key) ? key : key;
      const existing = await app.store.get(COLLECTIONS.cohorts, cohortId);
      if (!existing) {
        await app.store.set(COLLECTIONS.cohorts, cohortId, { Cohort: cohortId, SheetName: cohortSheetName(cohortId), Status: 'Inactive', DriveRootFolderId: '', FolderPrefix: '', FolderSuffix: '' });
      } else {
        existing.Status = 'Inactive';
        await app.store.set(COLLECTIONS.cohorts, cohortId, existing);
      }
      return { archived: true };
    }
    const existing = await app.store.get(COLLECTIONS[entity], key);
    if (!existing) throw new HubError('Record not found.');
    if (entity === 'phases') {
      const milestones = await app.store.list(COLLECTIONS.milestoneTemplates);
      if (milestones.some((milestone) => text(milestone.phase) === key)) throw new HubError('Move or delete this phase’s milestones before deleting the phase.');
      const phaseRecords = await phases(app);
      if (phaseRecords.some((phase) => text(phase.phaseId) !== key && text(phase.prerequisitePhaseId) === key)) {
        throw new HubError('Update dependent phases before deleting this phase.');
      }
    }
    if (entity === 'milestoneTemplates') {
      const items = await app.store.list(COLLECTIONS.studentActionItems);
      if (items.some((item) => text(item.CreatorType) === 'System' && text(item.TemplateId) === key)) {
        throw new HubError('This template has assigned action items and cannot be deleted.');
      }
    }
    if (entity === 'staffUsers' && staffHasAdminAccess(existing)) await assertAnotherAdmin(app, key);
    await app.store.remove(COLLECTIONS[entity], key);
    return { deleted: true };
  });
}

export async function saveCohortMember(app: App, cohortId: unknown, record: Doc, originalStudentId: unknown) {
  const user = await requireAdmin(app, 'SAVE_COHORT_MEMBER');
  const cohort = text(cohortId);
  await requireCohort(app, cohort, true);
  const values = coerce('cohortMembers', { ...(record || {}) });
  const original = text(originalStudentId);
  validateRecordFields('cohortMembers', values, original);
  values.StudentId = normalizeEmail(values.StudentId);
  values['Student Email'] = normalizeEmail(values['Student Email']);
  values['Year Group'] = Number(values['Year Group']);
  return audited(app, user, original ? 'UPDATE_COHORT_MEMBER' : 'CREATE_COHORT_MEMBER', { cohort, studentId: normalizeEmail(original || values.StudentId) }, async () => {
    const currentId = normalizeEmail(original || values.StudentId);
    const existing = await app.store.getMember(cohort, currentId);
    if (original && !existing) throw new HubError('Cohort student not found. Refresh and try again.');
    if (!original && existing) throw new HubError('This student is already in the cohort.');
    const stored = { ...(existing || {}), ...values, StudentId: values.StudentId };
    if (original && original !== values.StudentId) await app.store.removeMember(cohort, original);
    await app.store.setMember(cohort, values.StudentId, stored);
    return { studentId: values.StudentId };
  });
}

export async function deleteCohortMember(app: App, cohortId: unknown, studentId: unknown) {
  const user = await requireAdmin(app, 'DELETE_COHORT_MEMBER');
  const email = validateEmail(studentId, 'StudentId');
  const cohort = text(cohortId);
  return audited(app, user, 'DELETE_COHORT_MEMBER', { cohort, studentId: email }, async () => {
    await requireCohort(app, cohort, true);
    const existing = await app.store.getMember(cohort, email);
    if (!existing) throw new HubError('Cohort student not found.');
    await app.store.removeMember(cohort, email);
    return { deleted: true };
  });
}

export async function importCohortMembers(app: App, cohortId: unknown, records: unknown) {
  const user = await requireAdmin(app, 'IMPORT_COHORT_MEMBERS');
  if (!Array.isArray(records) || records.length === 0) throw new HubError('No roster rows were provided.');
  if (records.length > 1000) throw new HubError('Import is limited to 1,000 students at a time.');
  const cohort = text(cohortId);
  return audited(app, user, 'IMPORT_COHORT_MEMBERS', { cohort, rowCount: records.length }, async () => {
    await requireCohort(app, cohort, true);
    const existingRows = await app.store.listMembers(cohort);
    const existing: Record<string, boolean> = {};
    existingRows.forEach((row) => { const id = normalizeEmail(row.StudentId); if (id) existing[id] = true; });
    const seen: Record<string, boolean> = {};
    for (const record of records) {
      const values = coerce('cohortMembers', { ...(record || {}) });
      validateRecordFields('cohortMembers', values);
      const studentId = normalizeEmail(values.StudentId);
      values.StudentId = studentId;
      values['Student Email'] = normalizeEmail(values['Student Email']);
      values['Year Group'] = Number(values['Year Group']);
      if (seen[studentId]) throw new HubError(`StudentId appears more than once in the import: ${studentId}`);
      if (existing[studentId]) throw new HubError(`StudentId is already in this cohort: ${studentId}`);
      seen[studentId] = true;
      await app.store.setMember(cohort, studentId, values);
    }
    return { imported: records.length };
  });
}

export async function createStudentUsersFromCohort(app: App, cohortId: unknown, selectedStudentIds: unknown) {
  const user = await requireAdmin(app, 'CREATE_STUDENT_USERS_FROM_COHORT');
  if (!Array.isArray(selectedStudentIds) || !selectedStudentIds.length) throw new HubError('Select at least one student.');
  if (selectedStudentIds.length > 1000) throw new HubError('Select no more than 1,000 students at a time.');
  const cohort = text(cohortId);
  return audited(app, user, 'CREATE_STUDENT_USERS_FROM_COHORT', { cohort, selectedCount: selectedStudentIds.length }, async () => {
    const members = await app.store.listMembers(cohort);
    const byId: Record<string, Doc> = {};
    members.forEach((record) => { byId[normalizeEmail(record.StudentId)] = record; });
    const selected: Record<string, boolean> = {};
    selectedStudentIds.forEach((value) => {
      const studentId = validateEmail(value, 'StudentId');
      if (selected[studentId]) throw new HubError('A student was selected more than once.');
      selected[studentId] = true;
    });
    let created = 0;
    let alreadyExists = 0;
    for (const studentId of Object.keys(selected)) {
      const member = byId[studentId];
      if (!member) throw new HubError(`Student is not in this cohort: ${studentId}`);
      if (member.hasStudentIdConflict) throw new HubError(`Resolve the duplicate Student ID values before creating a user for ${studentId}.`);
      const displayName = text(member['Display Name'] || member.DisplayName || member['Preferred Name'] || studentId);
      const existing = await app.store.get(COLLECTIONS.studentUsers, studentId);
      if (existing) { alreadyExists += 1; continue; }
      await app.store.set(COLLECTIONS.studentUsers, studentId, {
        StudentId: studentId,
        DisplayName: displayName,
        Cohort: cohort,
        studentEmail: studentId,
        parentEmail: text(member['Family Email']),
      });
      created += 1;
    }
    return { created, alreadyExists };
  });
}

export async function getCohorts(app: App) {
  await requireAdminOrStaff(app);
  return (await listCohorts(app, false)).map((cohort) => ({ id: cohort.id, name: cohort.name, sheetName: cohort.sheetName }));
}

async function requireAdminOrStaff(app: App) {
  const { requireStaff } = await import('./session');
  return requireStaff(app, 'LIST_COHORTS');
}

export async function getContentHub(app: App) {
  const user = await (await import('./session')).requireUser(app, 'GET_CONTENT_HUB');
  const records = await app.store.list(COLLECTIONS.resources);
  const resources = records.filter((record) => {
    if (!toBoolean(record.Published)) return false;
    const audience = text(record.Audience).toLowerCase();
    return !audience || audience === 'all' || audience === 'both' || audience === user.role || (user.role === 'staff' && audience === 'staff');
  }).sort((left, right) => Number(left['Sort Order'] || 0) - Number(right['Sort Order'] || 0));
  return { resources };
}

export function builtinQuotes() {
  return BUILTIN_QUOTES.slice();
}

export async function readQuotePool(app: App) {
  const records = await app.store.list(COLLECTIONS.quotations);
  const pool = records.map((row) => text(row.Display || row.Quote || row.quote || row.Quotation)).filter(Boolean);
  return pool.length ? pool : builtinQuotes();
}

void placementFromMember;
