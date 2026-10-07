import { APP_TABLES, COLLECTIONS, FieldDef, tableFields } from './schema';
import { dateOnlyValue, Doc, driveNamePart, normalizeEmail, serializeDateOnly, text, toBoolean } from './util';

export interface SheetGrid {
  title: string;
  rows: unknown[][];
}

export interface PlannedDoc {
  id: string;
  data: Doc;
}

export interface SheetImportPlan {
  docs: Record<string, PlannedDoc[]>;
  members: { cohortId: string; id: string; data: Doc }[];
  messages: { ticketId: string; id: string; data: Doc }[];
  audits: Doc[];
  warnings: string[];
  warningCount: number;
}

const SHEET_ALIASES: Record<string, string> = {
  milestones: 'milestoneTemplates',
};

const FORM_SYSTEM: Record<string, FieldDef> = {
  StudentId: { name: 'StudentId', type: 'email', required: true, key: true },
  FormVersion: { name: 'FormVersion', type: 'number' },
  Status: { name: 'Status', type: 'text' },
  SubmittedAt: { name: 'SubmittedAt', type: 'datetime' },
  LastUpdated: { name: 'LastUpdated', type: 'datetime' },
};

const WARNING_LIMIT = 40;

export function spreadsheetIdFrom(input: string): string {
  const trimmed = text(input);
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new Error('Pass a Google Sheet URL or spreadsheet id.');
}

export function sheetSerialToUtc(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
}

export function emptyPlan(): SheetImportPlan {
  return { docs: {}, members: [], messages: [], audits: [], warnings: [], warningCount: 0 };
}

export function planSheetImport(grids: SheetGrid[]): SheetImportPlan {
  const plan = emptyPlan();
  const byTitle = new Map<string, SheetGrid>();
  grids.forEach((grid) => byTitle.set(normalizeTitle(grid.title), grid));

  Object.keys(APP_TABLES).forEach((entity) => {
    if (entity === 'cohortMembers' || entity === 'auditLogs') return;
    const grid = byTitle.get(normalizeTitle(APP_TABLES[entity].sheet));
    if (!grid) return;
    byTitle.delete(normalizeTitle(grid.title));
    if (entity === 'ticketMessages') readMessages(plan, grid);
    else readTable(plan, entity, grid);
  });

  const legacyMilestones = byTitle.get('milestones');
  if (legacyMilestones && !plan.docs[COLLECTIONS.milestoneTemplates]) {
    byTitle.delete('milestones');
    readTable(plan, SHEET_ALIASES.milestones, legacyMilestones);
  }

  const pages = byTitle.get('content_pages');
  if (pages) {
    byTitle.delete('content_pages');
    mergeContentPages(plan, pages);
  }

  grids.forEach((grid) => {
    const cohort = /^cohort:\s*(\d{4})$/i.exec(grid.title.trim());
    if (cohort) {
      byTitle.delete(normalizeTitle(grid.title));
      readCohortMembers(plan, cohort[1], grid);
      return;
    }
    const form = /^form:\s*([a-z][a-z0-9_-]*)$/i.exec(grid.title.trim());
    if (form) {
      byTitle.delete(normalizeTitle(grid.title));
      readFormResponses(plan, form[1], grid);
    }
  });

  const audits = grids.find((grid) => normalizeTitle(grid.title) === 'audit_logs');
  if (audits) {
    byTitle.delete('audit_logs');
    readAudits(plan, audits);
  }

  byTitle.forEach((grid) => warn(plan, `Skipped sheet "${grid.title}". It is not an EE Hub table.`));
  assignMilestonePositions(plan);
  ensureCohortsForMembers(plan);
  fillStudentEmails(plan);
  return plan;
}

function readTable(plan: SheetImportPlan, entity: string, grid: SheetGrid): void {
  const fields = tableFields(entity);
  const keyName = fields.find((field) => field.key)?.name || '';
  const collection = COLLECTIONS[entity];
  const seen = new Set<string>();
    recordsFrom(plan, grid, fields, true).forEach((record) => {
    const rawKey = record[keyName];
    const id = docId(keyName.toLowerCase().includes('email') || fields.find((field) => field.name === keyName)?.type === 'email'
      ? normalizeEmail(rawKey)
      : text(rawKey));
    if (!id) {
      warn(plan, `${grid.title} row is missing ${keyName}.`);
      return;
    }
    if (seen.has(id)) warn(plan, `${grid.title} has more than one row for ${id}. The last row is kept.`);
    seen.add(id);
    pushDoc(plan, collection, id, record);
  });
}

function readCohortMembers(plan: SheetImportPlan, cohortId: string, grid: SheetGrid): void {
  const seen = new Set<string>();
  recordsFrom(plan, grid, tableFields('cohortMembers'), true).forEach((record) => {
    const id = docId(normalizeEmail(record.StudentId));
    if (!id) {
      warn(plan, `${grid.title} row is missing StudentId.`);
      return;
    }
    if (seen.has(id)) warn(plan, `${grid.title} has more than one row for ${id}. The last row is kept.`);
    seen.add(id);
    const index = plan.members.findIndex((member) => member.cohortId === cohortId && member.id === id);
    const entry = { cohortId, id, data: record };
    if (index >= 0) plan.members[index] = entry;
    else plan.members.push(entry);
  });
}

function readFormResponses(plan: SheetImportPlan, milestoneId: string, grid: SheetGrid): void {
  const custom = formFieldTypes(plan, milestoneId);
  const fields = Object.values(FORM_SYSTEM).concat(custom);
  const seen = new Set<string>();
  recordsFrom(plan, grid, fields, true).forEach((record) => {
    const email = normalizeEmail(record.StudentId);
    const id = docId(`${milestoneId}__${encodeURIComponent(email)}`);
    if (!email || !id) {
      warn(plan, `${grid.title} row is missing StudentId.`);
      return;
    }
    record.MilestoneId = milestoneId;
    record.StudentId = email;
    if (seen.has(id)) warn(plan, `${grid.title} has more than one response for ${email}. The last row is kept.`);
    seen.add(id);
    pushDoc(plan, COLLECTIONS.formResponses, id, record);
  });
}

function readMessages(plan: SheetImportPlan, grid: SheetGrid): void {
  const seen = new Set<string>();
  recordsFrom(plan, grid, tableFields('ticketMessages')).forEach((record) => {
    const ticketId = docId(text(record.TicketId));
    const id = docId(text(record.MessageId));
    if (!ticketId || !id) {
      warn(plan, `${grid.title} row is missing TicketId or MessageId.`);
      return;
    }
    const key = `${ticketId}\u0000${id}`;
    if (seen.has(key)) warn(plan, `${grid.title} has more than one row for ${id}. The last row is kept.`);
    seen.add(key);
    const index = plan.messages.findIndex((message) => message.ticketId === ticketId && message.id === id);
    const entry = { ticketId, id, data: record };
    if (index >= 0) plan.messages[index] = entry;
    else plan.messages.push(entry);
  });
}

function readAudits(plan: SheetImportPlan, grid: SheetGrid): void {
  recordsFrom(plan, grid, tableFields('auditLogs')).forEach((record) => {
    if (!text(record.Action) && !text(record.User)) return;
    plan.audits.push(record);
  });
}

function mergeContentPages(plan: SheetImportPlan, grid: SheetGrid): void {
  const existing = new Set((plan.docs[COLLECTIONS.resources] || []).map((doc) => doc.id));
  recordsFrom(plan, grid, []).forEach((page) => {
    const id = docId(text(page['Page ID']));
    if (!id || existing.has(id)) return;
    const body = page.Body === null || page.Body === undefined ? '' : String(page.Body);
    existing.add(id);
    pushDoc(plan, COLLECTIONS.resources, id, {
      'Resource ID': id,
      Title: text(page.Title),
      Category: 'Guide',
      Description: '',
      URL: '',
      Audience: text(page.Audience) || 'all',
      Published: toBoolean(page.Published),
      'Sort Order': page['Sort Order'] === '' || page['Sort Order'] === undefined || page['Sort Order'] === null ? '' : Number(page['Sort Order']),
      Slug: text(page.Slug),
      Body: body,
      'Body Format': /<[a-z!/][^>]*>/i.test(body) ? 'html' : 'plain',
    });
  });
}

function formFieldTypes(plan: SheetImportPlan, milestoneId: string): FieldDef[] {
  const definition = (plan.docs[COLLECTIONS.formDefinitions] || []).find((doc) => doc.id === milestoneId);
  if (!definition) return [];
  try {
    const parsed = JSON.parse(text(definition.data.fieldsJson) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((field) => ({ name: text(field?.name), type: text(field?.type) || 'text' }))
      .filter((field) => field.name && !FORM_SYSTEM[field.name]);
  } catch {
    warn(plan, `Form ${milestoneId} has field JSON that could not be read. Answer columns are kept as text.`);
    return [];
  }
}

function recordsFrom(plan: SheetImportPlan, grid: SheetGrid, fields: FieldDef[], keepUnknown = false): Doc[] {
  if (!grid.rows.length) {
    warn(plan, `${grid.title} has no header row.`);
    return [];
  }
  const headers = grid.rows[0].map((cell) => text(cell));
  const seenHeaders = new Set<string>();
  headers.forEach((header, index) => {
    if (!header || !seenHeaders.has(header)) {
      if (header) seenHeaders.add(header);
      return;
    }
    warn(plan, `${grid.title} repeats column ${header}. The first column is used.`);
    headers[index] = '';
  });
  const known = new Map(fields.map((field) => [field.name, field]));
  return grid.rows.slice(1).filter(rowHasValue).map((row) => {
    const record: Doc = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const field = known.get(header);
      if (!field && fields.length && !keepUnknown) return;
      record[header] = coerceCell(field, header, row[index]);
    });
    return record;
  });
}

function coerceCell(field: FieldDef | undefined, header: string, value: unknown): unknown {
  if (header === 'FolderPrefix' || header === 'FolderSuffix') return driveNamePart(value);
  if (value === null || value === undefined || value === '') return '';
  if (field?.type === 'checkbox') return toBoolean(value);
  if (field?.type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(text(value));
    return Number.isFinite(numeric) ? numeric : '';
  }
  if (field?.type === 'date') return dateOnlyFromSheet(value);
  if (field?.type === 'datetime') return dateTimeFromSheet(value);
  if (field?.type === 'email' || field?.validator === 'email') return normalizeEmail(value);
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  return text(value);
}

export function dateOnlyFromSheet(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return serializeDateOnly(sheetSerialToUtc(value));
  if (value instanceof Date && !isNaN(value.getTime())) return serializeDateOnly(value);
  return dateOnlyValue(value);
}

export function dateTimeFromSheet(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return sheetSerialToUtc(value).toISOString();
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();
  const raw = text(value);
  if (!raw) return '';
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function assignMilestonePositions(plan: SheetImportPlan): void {
  const docs = plan.docs[COLLECTIONS.milestoneTemplates] || [];
  docs.forEach((doc, index) => {
    if (doc.data.position === '' || doc.data.position === undefined || doc.data.position === null) {
      doc.data.position = index + 1;
    }
  });
}

function ensureCohortsForMembers(plan: SheetImportPlan): void {
  const cohorts = plan.docs[COLLECTIONS.cohorts] || [];
  const known = new Set(cohorts.map((doc) => doc.id));
  plan.members.forEach((member) => {
    if (known.has(member.cohortId)) return;
    known.add(member.cohortId);
    pushDoc(plan, COLLECTIONS.cohorts, member.cohortId, {
      Cohort: member.cohortId,
      SheetName: `COHORT: ${member.cohortId}`,
      Status: 'Active',
      DriveRootFolderId: '',
      FolderPrefix: '',
      FolderSuffix: '',
    });
    warn(plan, `Cohort ${member.cohortId} has a roster sheet and no COHORTS row. It was added as Active.`);
  });
}

function fillStudentEmails(plan: SheetImportPlan): void {
  (plan.docs[COLLECTIONS.studentUsers] || []).forEach((doc) => {
    if (!text(doc.data.studentEmail)) doc.data.studentEmail = doc.id;
  });
}

function pushDoc(plan: SheetImportPlan, collection: string, id: string, data: Doc): void {
  if (!plan.docs[collection]) plan.docs[collection] = [];
  const docs = plan.docs[collection];
  const index = docs.findIndex((doc) => doc.id === id);
  if (index >= 0) docs[index] = { id, data };
  else docs.push({ id, data });
}

function rowHasValue(row: unknown[]): boolean {
  return row.some((value) => value !== '' && value !== null && value !== undefined);
}

function docId(value: string): string {
  const id = value.trim();
  if (!id || id === '.' || id === '..' || id.includes('/')) return '';
  return id.slice(0, 700);
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase();
}

function warn(plan: SheetImportPlan, message: string): void {
  plan.warningCount += 1;
  if (plan.warnings.length < WARNING_LIMIT) plan.warnings.push(message);
}
