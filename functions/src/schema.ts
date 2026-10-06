import { HubError, text, toBoolean } from './util';

export interface FieldDef {
  name: string;
  type: string;
  required?: boolean;
  key?: boolean;
  options?: string[];
  optionLabels?: string[];
  optionsFrom?: string;
  optionValue?: string;
  optionLabel?: string;
  allowBlank?: boolean;
  table?: boolean;
  form?: boolean;
  editable?: boolean;
  label?: string;
  errorMessage?: string;
  defaultValue?: unknown;
  validator?: string;
  generated?: boolean;
  serverDerived?: boolean;
}

export interface TableDef {
  sheet: string;
  fields: FieldDef[];
  internal?: boolean;
  sheetPattern?: string;
}

export const APP_TABLES: Record<string, TableDef> = {
  cohorts: {
    sheet: 'COHORTS',
    fields: [
      { name: 'Cohort', type: 'text', required: true, key: true },
      { name: 'SheetName', type: 'text', editable: false },
      { name: 'Status', type: 'select', options: ['Active', 'Inactive'] },
      { name: 'DriveRootFolderId', type: 'text', editable: false, table: false, form: false },
      { name: 'FolderPrefix', type: 'text', editable: false, table: false, form: false },
      { name: 'FolderSuffix', type: 'text', editable: false, table: false, form: false },
    ],
  },
  milestoneTemplates: {
    sheet: 'MILESTONE_TEMPLATES',
    fields: [
      { name: 'milestoneId', type: 'text', required: true, key: true },
      { name: 'type', type: 'select', required: true, options: ['form', 'upload', 'doc', 'approval', 'meeting'] },
      { name: 'milestoneTitle', type: 'text', required: true },
      { name: 'offsetDays', type: 'number' },
      { name: 'milestoneDescription', type: 'textarea', table: false },
      { name: 'phase', type: 'select', required: true, optionsFrom: 'phases', optionValue: 'phaseId', optionLabel: 'phaseTitle' },
      { name: 'mOwner', type: 'select', required: true, options: ['student', 'supervisor', 'lead', 'coordinator'], errorMessage: 'Owner must be student, supervisor, lead, or coordinator.' },
    ],
  },
  phases: {
    sheet: 'PHASES',
    fields: [
      { name: 'phaseId', type: 'text', required: true, key: true, validator: 'phaseId' },
      { name: 'phaseTitle', type: 'text', required: true },
      { name: 'phaseDescription', type: 'textarea', table: false },
      { name: 'sequence', type: 'number', required: true },
      { name: 'prerequisitePhaseId', type: 'select', optionsFrom: 'phases', optionValue: 'phaseId', optionLabel: 'phaseTitle', allowBlank: true },
      { name: 'active', type: 'checkbox', defaultValue: true },
    ],
  },
  studentUsers: {
    sheet: 'USERS-STUDENTS',
    fields: [
      { name: 'StudentId', type: 'email', required: true, key: true, validator: 'email' },
      { name: 'DisplayName', type: 'text', required: true },
      { name: 'Cohort', type: 'text' },
      { name: 'studentEmail', type: 'email', editable: false, serverDerived: true, table: false },
      { name: 'parentEmail', type: 'email' },
    ],
  },
  staffUsers: {
    sheet: 'USERS-STAFF',
    fields: [
      { name: 'EMAIL', type: 'email', required: true, key: true, validator: 'email' },
      { name: 'DisplayName', type: 'text', required: true },
      { name: 'Primary Department', type: 'text' },
      { name: 'StaffCode', type: 'text' },
      { name: 'isStaff', type: 'checkbox', defaultValue: true },
      { name: 'isSupervisor', type: 'checkbox' },
      { name: 'isLead', type: 'checkbox' },
      { name: 'isCoordinator', type: 'checkbox' },
      { name: 'isAdmin', type: 'checkbox' },
      { name: 'EEQuota', type: 'number' },
      { name: 'EESubjects', type: 'text' },
    ],
  },
  subjects: {
    sheet: 'SUBJECTS',
    fields: [
      { name: 'Subject ID', type: 'text', key: true, generated: true },
      { name: 'Name', type: 'text', required: true },
      { name: 'Department', type: 'text' },
      { name: 'Active', type: 'checkbox', defaultValue: true },
    ],
  },
  resources: {
    sheet: 'RESOURCES',
    fields: [
      { name: 'Resource ID', type: 'text', key: true, generated: true },
      { name: 'Title', type: 'text', required: true },
      { name: 'Category', type: 'text' },
      { name: 'Description', type: 'textarea', table: false },
      { name: 'URL', type: 'url' },
      { name: 'Audience', type: 'select', options: ['all', 'student', 'staff'] },
      { name: 'Published', type: 'checkbox' },
      { name: 'Sort Order', type: 'number' },
      { name: 'Slug', type: 'text', table: false },
      { name: 'Body', type: 'textarea', table: false },
      { name: 'Body Format', type: 'select', options: ['plain', 'markdown', 'html'], defaultValue: 'plain' },
    ],
  },
  faqs: {
    sheet: 'FAQS',
    fields: [
      { name: 'FaqId', type: 'text', key: true, generated: true },
      { name: 'Question', type: 'text', required: true },
      { name: 'Answer', type: 'textarea', required: true, table: false },
      { name: 'Audience', type: 'select', options: ['all', 'student', 'staff'] },
      { name: 'Published', type: 'checkbox', defaultValue: true },
      { name: 'SortOrder', type: 'number' },
    ],
  },
  ticketCategories: {
    sheet: 'TICKET_CATEGORIES',
    fields: [
      { name: 'CategoryId', type: 'text', key: true, generated: true },
      { name: 'Name', type: 'text', required: true },
      { name: 'Route', type: 'select', required: true, label: 'Who they message', options: ['supervisor', 'coordinator'], optionLabels: ["The student's supervisor", 'EE Coordinator'] },
      { name: 'SortOrder', type: 'number', label: 'Sort order' },
      { name: 'Active', type: 'checkbox', defaultValue: true },
    ],
  },
  cohortMembers: {
    sheet: 'COHORT: [Cohort]',
    sheetPattern: 'COHORT: [Cohort]',
    fields: [
      { name: 'StudentId', type: 'email', required: true, key: true, validator: 'email' },
      { name: 'Display Name', type: 'text', required: true },
      { name: 'HRM', type: 'text', table: false },
      { name: 'Surname', type: 'text' },
      { name: 'First Name', type: 'text' },
      { name: 'Preferred Name', type: 'text', table: false },
      { name: 'Chinese Name', type: 'text', table: false },
      { name: 'Student ID', type: 'text', required: true, validator: 'studentId' },
      { name: 'Family Email', type: 'email', table: false },
      { name: 'Student Email', type: 'email', required: true, validator: 'email' },
      { name: 'Date of Birth', type: 'date', table: false },
      { name: 'House', type: 'text', table: false },
      { name: 'Gender', type: 'text', table: false },
      { name: 'Year Group', type: 'number', required: true, validator: 'yearGroup' },
      { name: 'Anchor_Date', type: 'date', table: false },
      { name: 'supervisorId', type: 'email' },
      { name: 'subject', type: 'text' },
      { name: 'latestMilestone', type: 'text' },
      { name: 'EEFolder', type: 'text', table: false },
      { name: 'EEDoc', type: 'text', table: false },
      { name: 'RPPFDoc', type: 'text', table: false },
      { name: 'EEPoster', type: 'text', table: false },
    ],
  },
  studentActionItems: {
    sheet: 'STUDENT_ACTION_ITEMS',
    internal: true,
    fields: [
      { name: 'TaskId', type: 'text', required: true, key: true },
      { name: 'StudentId', type: 'email', required: true, validator: 'email' },
      { name: 'CreatorType', type: 'select', required: true, options: ['System', 'Supervisor', 'Student'] },
      { name: 'TemplateId', type: 'text' },
      { name: 'PhaseId', type: 'text' },
      { name: 'Title', type: 'text', required: true },
      { name: 'Description', type: 'textarea', table: false },
      { name: 'DueDate', type: 'date' },
      { name: 'Status', type: 'select', required: true, options: ['Pending', 'In Progress', 'Completed'] },
      { name: 'LastUpdated', type: 'datetime', required: true },
      { name: 'CreatedBy', type: 'email', validator: 'email' },
      { name: 'UpdatedBy', type: 'email', validator: 'email' },
    ],
  },
  auditLogs: {
    sheet: 'AUDIT_LOGS',
    internal: true,
    fields: [
      { name: 'Timestamp', type: 'datetime', required: true },
      { name: 'User', type: 'email', required: true, validator: 'email' },
      { name: 'Action', type: 'text', required: true },
      { name: 'Payload', type: 'text' },
    ],
  },
  formDefinitions: {
    sheet: 'FORM_DEFINITIONS',
    internal: true,
    fields: [
      { name: 'milestoneId', type: 'text', required: true, key: true },
      { name: 'status', type: 'select', required: true, options: ['Draft', 'Published'] },
      { name: 'version', type: 'number', required: true },
      { name: 'fieldsJson', type: 'textarea', table: false },
      { name: 'html', type: 'textarea', table: false },
      { name: 'js', type: 'textarea', table: false },
      { name: 'submitCompletes', type: 'checkbox', defaultValue: true },
      { name: 'LastUpdated', type: 'datetime', required: true },
      { name: 'UpdatedBy', type: 'email', required: true },
    ],
  },
  milestoneEvents: {
    sheet: 'MILESTONE_EVENTS',
    internal: true,
    fields: [
      { name: 'EventId', type: 'text', required: true, key: true },
      { name: 'TaskId', type: 'text', required: true },
      { name: 'StudentId', type: 'email', required: true },
      { name: 'MilestoneId', type: 'text', required: true },
      { name: 'EventType', type: 'select', required: true, options: ['returned', 'approved', 'session_logged', 'note'] },
      { name: 'Comment', type: 'textarea' },
      { name: 'Actor', type: 'email', required: true },
      { name: 'CreatedAt', type: 'datetime', required: true },
    ],
  },
  tickets: {
    sheet: 'TICKETS',
    internal: true,
    fields: [
      { name: 'TicketId', type: 'text', required: true, key: true },
      { name: 'StudentId', type: 'email', required: true, validator: 'email' },
      { name: 'Cohort', type: 'text' },
      { name: 'Category', type: 'text', required: true },
      { name: 'Title', type: 'text', required: true },
      { name: 'Status', type: 'select', required: true, options: ['Open', 'In Progress', 'Resolved', 'Closed'] },
      { name: 'Route', type: 'select', required: true, options: ['supervisor', 'coordinator'] },
      { name: 'Assignee', type: 'email' },
      { name: 'CreatedAt', type: 'datetime', required: true },
      { name: 'LastUpdated', type: 'datetime', required: true },
      { name: 'LastActor', type: 'email', required: true },
      { name: 'StudentUnread', type: 'checkbox' },
      { name: 'StaffUnread', type: 'checkbox' },
      { name: 'Shared', type: 'checkbox', defaultValue: true },
    ],
  },
  todoTemplates: {
    sheet: 'TODO_TEMPLATES',
    internal: true,
    fields: [
      { name: 'TemplateId', type: 'text', required: true, key: true },
      { name: 'Title', type: 'text', required: true },
      { name: 'Description', type: 'textarea', table: false },
      { name: 'PhaseId', type: 'text' },
      { name: 'Owner', type: 'email', required: true, validator: 'email' },
      { name: 'SortOrder', type: 'number' },
      { name: 'Active', type: 'checkbox', defaultValue: true },
    ],
  },
  ticketMessages: {
    sheet: 'TICKET_MESSAGES',
    internal: true,
    fields: [
      { name: 'MessageId', type: 'text', required: true, key: true },
      { name: 'TicketId', type: 'text', required: true },
      { name: 'AuthorEmail', type: 'email', required: true },
      { name: 'AuthorRole', type: 'select', required: true, options: ['student', 'staff'] },
      { name: 'Body', type: 'textarea', required: true },
      { name: 'CreatedAt', type: 'datetime', required: true },
    ],
  },
  quotations: {
    sheet: 'Quotations',
    fields: [
      { name: 'QuoteId', type: 'text', required: true, key: true },
      { name: 'Display', type: 'text', required: true },
      { name: 'Quote', type: 'text' },
      { name: 'Author', type: 'text' },
    ],
  },
};

export const COLLECTIONS: Record<string, string> = {
  cohorts: 'cohorts',
  milestoneTemplates: 'milestoneTemplates',
  phases: 'phases',
  studentUsers: 'studentUsers',
  staffUsers: 'staffUsers',
  subjects: 'subjects',
  resources: 'resources',
  faqs: 'faqs',
  ticketCategories: 'ticketCategories',
  studentActionItems: 'studentActionItems',
  auditLogs: 'auditLogs',
  formDefinitions: 'formDefinitions',
  milestoneEvents: 'milestoneEvents',
  tickets: 'tickets',
  todoTemplates: 'todoTemplates',
  quotations: 'quotations',
  formResponses: 'formResponses',
};

export function tableConfig(entity: string): TableDef {
  const config = APP_TABLES[entity];
  if (!config) throw new HubError('Unknown Admin section.');
  return config;
}

export function tableFields(entity: string): FieldDef[] {
  return tableConfig(entity).fields;
}

export function tableKey(entity: string): string {
  const keyFields = tableFields(entity).filter((field) => field.key);
  if (keyFields.length !== 1) throw new HubError(`Schema for ${entity} must define exactly one key field.`);
  return keyFields[0].name;
}

export function fieldConfig(entity: string, fieldName: string): FieldDef | null {
  return tableFields(entity).find((field) => field.name === fieldName) || null;
}

export function tableHeaders(entity: string): string[] {
  return tableFields(entity).map((field) => field.name);
}

/** Append-only tables. Rows are written with Firestore auto-ids, matching the sheet. */
const KEYLESS_TABLES = new Set(['auditLogs']);
/** Nested under a parent document rather than a top-level collection. */
const SUBCOLLECTIONS = new Set(['cohortMembers', 'ticketMessages']);

export function assertAppSchema(): string[] {
  const problems: string[] = [];
  Object.keys(APP_TABLES).forEach((entity) => {
    const keys = APP_TABLES[entity].fields.filter((field) => field.key);
    const expectKey = !KEYLESS_TABLES.has(entity);
    if (expectKey && keys.length !== 1) problems.push(`${entity} has ${keys.length} key fields`);
    if (!expectKey && keys.length) problems.push(`${entity} should stay append-only`);
    const names = APP_TABLES[entity].fields.map((field) => field.name);
    names.forEach((name, index) => {
      if (names.indexOf(name) !== index) problems.push(`${entity} duplicates ${name}`);
    });
    if (!SUBCOLLECTIONS.has(entity) && !COLLECTIONS[entity]) problems.push(`${entity} has no Firestore collection`);
  });
  if (!COLLECTIONS.formResponses) problems.push('formResponses collection is missing');
  if (problems.length) throw new HubError(problems.join('; '));
  return Object.keys(APP_TABLES);
}

export function validateRecordFields(entity: string, values: Record<string, any>, originalKey?: string): void {
  tableFields(entity).forEach((field) => {
    const value = values[field.name];
    if (field.required && !text(value)) throw new HubError(`${field.name} is required.`);
    if (field.key && originalKey && text(value) !== text(originalKey)) throw new HubError(`${field.name} cannot be changed.`);
    if (value === '' || value === undefined || value === null) return;
    if (field.options && field.options.length && !field.options.some((option) => String(option).toLowerCase() === String(value).toLowerCase())) {
      throw new HubError(field.errorMessage || `${field.name} must be one of: ${field.options.join(', ')}.`);
    }
    if (field.type === 'number' && !isFinite(Number(value))) throw new HubError(`${field.name} must be a number.`);
    if (field.type === 'date' && isNaN(Date.parse(String(value)))) throw new HubError(`${field.name} must be a valid date.`);
    if (field.type === 'url' && !/^https:\/\/\S+$/i.test(text(value))) throw new HubError(`${field.name} must be an HTTPS URL.`);
    if (field.type === 'checkbox' && typeof value !== 'boolean' && !['true', 'false', '1', '0', 'yes', 'no'].includes(String(value).toLowerCase())) {
      throw new HubError(`${field.name} must be checked or unchecked.`);
    }
    if (field.validator === 'email') validateEmailLoose(value, field.name);
    if (field.validator === 'studentId' && !/^\d{8}$/.test(text(value))) throw new HubError(`${field.name} must be an 8-digit number.`);
    if (field.validator === 'yearGroup' && (!Number.isInteger(Number(value)) || Number(value) <= 0)) {
      throw new HubError(`${field.name} must be a positive whole number.`);
    }
    if (field.validator === 'phaseId' && !/^[a-z][a-z0-9_-]*$/i.test(text(value))) {
      throw new HubError(`${field.name} must start with a letter and contain only letters, numbers, hyphens, or underscores.`);
    }
  });
}

function validateEmailLoose(value: unknown, label: string): void {
  const email = text(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HubError(`${label} must be a valid email address.`);
}

export function adminSchema(entity: string, phases: Record<string, any>[]): { entity: string; sheet: string; fields: any[] } {
  const config = tableConfig(entity);
  const fields = config.fields.map((field) => {
    const result: Record<string, any> = {};
    Object.keys(field).forEach((key) => {
      if (key !== 'validator' && key !== 'generated' && key !== 'serverDerived') result[key] = (field as any)[key];
    });
    if (field.options) {
      result.options = field.options.map((option, index) => ({
        value: option,
        label: field.optionLabels && field.optionLabels[index] ? field.optionLabels[index] : option,
      }));
    }
    if (field.optionsFrom === 'phases') {
      result.options = phases
        .filter((phase) => field.name === 'prerequisitePhaseId' || toBoolean(phase.active))
        .map((phase) => ({
          value: text(phase[field.optionValue || 'phaseId']),
          label: `${text(phase.phaseId)} · ${text(phase[field.optionLabel || 'phaseTitle'])}`,
        }));
    }
    return result;
  });
  return { entity, sheet: config.sheet || config.sheetPattern || '', fields };
}

export function staffHasAdminAccess(staff: Record<string, any>): boolean {
  return toBoolean(staff.isAdmin) || toBoolean(staff.isCoordinator);
}

export function cohortSheetName(cohortId: unknown): string {
  const value = text(cohortId);
  const match = /^COHORT\s*:\s*(\d{4})$/i.exec(value);
  if (match) return `COHORT: ${match[1]}`;
  if (!/^\d{4}$/.test(value)) throw new HubError('Cohort must be a four-digit year.');
  return `COHORT: ${value}`;
}

export function docIdFor(entity: string, values: Record<string, any>): string {
  return text(values[tableKey(entity)]);
}
