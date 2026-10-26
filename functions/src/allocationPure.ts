import { Doc, HubError, normalizeEmail, text, toBoolean } from './util';

export type TokenStatus = 'available' | 'draft' | 'committed';
export type MatchFlag = 'none' | 'match' | 'miss';

export interface Grid {
  title: string;
  rows: unknown[][];
}

export interface TokenRecord {
  id: string;
  cohortId: string;
  staffId: string;
  eligibleSubjects: string[];
  allocatedTo: string;
  assignedSubject: string;
  status: TokenStatus;
  createdAt: string;
}

export interface WorkspaceRecord {
  studentId: string;
  subjectChoices: Record<string, string | number | boolean>;
  dynamicData: Record<string, string | number | boolean>;
  pendingClear: boolean;
  updatedAt: string;
}

export interface ColumnFlag {
  key: string;
  showOnCard: boolean;
  filterable: boolean;
  sortable: boolean;
  /** Sequential blue fill for numeric cells. Off until a coordinator turns it on. */
  colorScale: boolean;
}

export interface AllocationSettings {
  primaryChoiceKey: string;
  secondaryChoiceKey: string;
  interdisciplinaryKey: string;
  hlColumn: string;
  supportColumn: string;
  columns: ColumnFlag[];
  detectedChoiceKeys: string[];
  detectedDynamicKeys: string[];
  lastWorkspaceSync: string;
  lastTokenSync: string;
  lastExport: string;
}

export interface ParsedWorkspaceRow {
  studentId: string;
  subjectChoices: Record<string, string | number | boolean>;
  dynamicData: Record<string, string | number | boolean>;
  eeActive: boolean | null;
}

export interface ParsedTokenRow {
  staffId: string;
  quota: number;
  eligibleSubjects: string[];
}

export interface TokenTopUp {
  create: TokenRecord[];
  eligibleUpdates: { id: string; eligibleSubjects: string[] }[];
  warnings: string[];
}

export interface DraftPlan {
  tokens: TokenRecord[];
  pendingClear: boolean;
  changed: boolean;
  error: string;
  code: '' | 'capacity' | 'conflict';
}

export interface BatchDraftPlan {
  tokenWrites: TokenRecord[];
  pendingClears: Record<string, boolean>;
  assigned: string[];
  skipped: { studentId: string; reason: string }[];
}

export interface CommitPlan {
  assignments: { studentId: string; staffId: string; subject: string; tokenId: string }[];
  clears: string[];
  warnings: string[];
}

export interface DeskToken {
  id: string;
  staffId: string;
  staffName: string;
  eligibleSubjects: string[];
  assignedSubject: string;
  status: 'draft' | 'committed';
}

export interface DeskStudent {
  studentId: string;
  displayName: string;
  sortName: string;
  liveSupervisorId: string;
  liveSubject: string;
  subjectChoices: Record<string, string | number | boolean>;
  dynamicData: Record<string, string | number | boolean>;
  pendingClear: boolean;
  token: DeskToken | null;
  choices: { primary: string; secondary: string; interdisciplinary: boolean };
  flags: {
    drafted: boolean;
    committed: boolean;
    subjectMatch: MatchFlag;
    hlMatch: MatchFlag;
    needsSupport: boolean;
  };
}

export interface DeskSupervisor {
  staffId: string;
  displayName: string;
  eligibleSubjects: string[];
  total: number;
  used: number;
  available: number;
  draft: number;
  committed: number;
}

export interface AllocationDesk {
  cohortId: string;
  students: DeskStudent[];
  supervisors: DeskSupervisor[];
  /** Same cohort tokens the supervisor load is built from, without student assignment. */
  tokenSlots: { status: TokenStatus; eligibleSubjects: string[] }[];
  settings: AllocationSettings;
  summary: { staffCount: number; tokenCount: number; activeStudents: number; buffer: number };
  publish: { drafts: number; clears: number; blocked: number };
  warnings: string[];
}

export function emptySettings(): AllocationSettings {
  return {
    primaryChoiceKey: '',
    secondaryChoiceKey: '',
    interdisciplinaryKey: '',
    hlColumn: '',
    supportColumn: '',
    columns: [],
    detectedChoiceKeys: [],
    detectedDynamicKeys: [],
    lastWorkspaceSync: '',
    lastTokenSync: '',
    lastExport: '',
  };
}

export function isEeActive(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return toBoolean(value);
}

export function preserveEeActive(incoming: Doc, previous: Doc | undefined): Doc {
  if (!previous) return incoming;
  const present = Object.prototype.hasOwnProperty.call(incoming, 'eeActive')
    && incoming.eeActive !== ''
    && incoming.eeActive !== undefined
    && incoming.eeActive !== null;
  if (present) return incoming;
  if (previous.eeActive === undefined || previous.eeActive === '') return incoming;
  return { ...incoming, eeActive: previous.eeActive };
}

export function allocationTab(title: string): { kind: 'workspace' | 'tokens'; cohortId: string } | null {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  const data = /^cohortdata\s*:?\s*(\d{4})$/i.exec(trimmed);
  if (data) return { kind: 'workspace', cohortId: data[1] };
  const tokens = /^supervisortokens\s*:?\s*(\d{4})$/i.exec(trimmed);
  if (tokens) return { kind: 'tokens', cohortId: tokens[1] };
  return null;
}

export function findAllocationTab(grids: Grid[], cohortId: string, kind: 'workspace' | 'tokens'): Grid | null {
  return grids.find((grid) => {
    const parsed = allocationTab(grid.title);
    return !!parsed && parsed.kind === kind && parsed.cohortId === cohortId;
  }) || null;
}

export function parseWorkspaceGrid(grid: Grid): { rows: ParsedWorkspaceRow[]; warnings: string[]; choiceKeys: string[]; dynamicKeys: string[] } {
  const headers = headerRow(grid);
  const studentIndex = headerIndex(headers, ['studentid']);
  if (studentIndex < 0) throw new HubError(`${grid.title} needs a StudentId column.`);
  const choiceIndex = headerIndex(headers, ['subjectchoice', 'subjectchoices']);
  const activeIndex = headerIndex(headers, ['eeactive', 'ee active']);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const rows: ParsedWorkspaceRow[] = [];
  const choiceKeys = new Set<string>();
  const dynamicKeys = new Set<string>();
  grid.rows.slice(1).filter(rowHasValue).forEach((row, index) => {
    const line = index + 2;
    const studentId = normalizeEmail(row[studentIndex]);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentId)) {
      warnings.push(`${grid.title} row ${line} needs a student email.`);
      return;
    }
    const subjectChoices: Record<string, string | number | boolean> = {};
    if (choiceIndex >= 0) Object.assign(subjectChoices, choiceObject(row[choiceIndex], warnings, `${grid.title} row ${line} SubjectChoice`));
    const dynamicData: Record<string, string | number | boolean> = {};
    headers.forEach((header, column) => {
      if (!header || column === studentIndex || column === choiceIndex || column === activeIndex) return;
      const choiceKey = choiceColumn(header);
      const value = plainCell(row[column]);
      if (value === '') return;
      if (choiceKey) {
        subjectChoices[choiceKey] = value;
        return;
      }
      dynamicData[header] = value;
    });
    if (seen.has(studentId)) warnings.push(`${grid.title} repeats ${studentId}. The last row is kept.`);
    seen.add(studentId);
    const activeCell = activeIndex < 0 ? '' : row[activeIndex];
    const entry: ParsedWorkspaceRow = {
      studentId,
      subjectChoices,
      dynamicData,
      eeActive: activeIndex < 0 || text(activeCell) === '' ? null : toBoolean(activeCell),
    };
    const existing = rows.findIndex((item) => item.studentId === studentId);
    if (existing >= 0) rows[existing] = entry;
    else rows.push(entry);
  });
  rows.forEach((row) => {
    Object.keys(row.subjectChoices).forEach((key) => choiceKeys.add(key));
    Object.keys(row.dynamicData).forEach((key) => dynamicKeys.add(key));
  });
  return {
    rows,
    warnings,
    choiceKeys: [...choiceKeys].sort(),
    dynamicKeys: [...dynamicKeys].sort(),
  };
}

export function parseTokenGrid(grid: Grid): { rows: ParsedTokenRow[]; warnings: string[] } {
  const headers = headerRow(grid);
  const staffIndex = headerIndex(headers, ['staffemail', 'staff email', 'email']);
  const quotaIndex = headerIndex(headers, ['quota']);
  const subjectIndex = headerIndex(headers, ['eligiblesubjects', 'eligible subjects', 'subjects']);
  if (staffIndex < 0 || quotaIndex < 0) throw new HubError(`${grid.title} needs StaffEmail and Quota columns.`);
  const warnings: string[] = [];
  const rows: ParsedTokenRow[] = [];
  const seen = new Set<string>();
  grid.rows.slice(1).filter(rowHasValue).forEach((row, index) => {
    const line = index + 2;
    const staffId = normalizeEmail(row[staffIndex]);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staffId)) {
      warnings.push(`${grid.title} row ${line} (${text(row[staffIndex]) || 'blank'}) needs a staff email.`);
      return;
    }
    const quotaValue = typeof row[quotaIndex] === 'number' ? row[quotaIndex] : Number(text(row[quotaIndex]));
    if (!Number.isInteger(quotaValue) || quotaValue < 0) {
      warnings.push(`${grid.title} row ${line} quota must be a whole number.`);
      return;
    }
    const eligibleSubjects = splitList(subjectIndex < 0 ? '' : row[subjectIndex]);
    if (!eligibleSubjects.length) warnings.push(`${grid.title} row ${line} lists no eligible subjects for ${staffId}.`);
    if (seen.has(staffId)) {
      warnings.push(`${grid.title} repeats ${staffId}. The last row is kept.`);
      const previous = rows.findIndex((item) => item.staffId === staffId);
      if (previous >= 0) rows.splice(previous, 1);
    }
    seen.add(staffId);
    rows.push({ staffId, quota: quotaValue, eligibleSubjects });
  });
  return { rows, warnings };
}

export function planTokenTopUp(existing: TokenRecord[], rows: ParsedTokenRow[], cohortId: string, now: string, idFactory: () => string): TokenTopUp {
  const warnings: string[] = [];
  const create: TokenRecord[] = [];
  const eligibleUpdates: { id: string; eligibleSubjects: string[] }[] = [];
  rows.forEach((row) => {
    const owned = existing.filter((token) => token.staffId === row.staffId);
    const gap = row.quota - owned.length;
    if (gap > 0) {
      for (let index = 0; index < gap; index += 1) {
        create.push({
          id: idFactory(),
          cohortId,
          staffId: row.staffId,
          eligibleSubjects: row.eligibleSubjects.slice(),
          allocatedTo: '',
          assignedSubject: '',
          status: 'available',
          createdAt: now,
        });
      }
    } else if (gap < 0) {
      warnings.push(`${row.staffId} has ${owned.length} tokens and the sheet quota is ${row.quota}. Draft and committed tokens were left in place.`);
    }
    const sameList = (left: string[], right: string[]) => left.join('\n') === right.join('\n');
    owned.forEach((token) => {
      if (sameList(token.eligibleSubjects, row.eligibleSubjects)) return;
      if (token.status === 'available') eligibleUpdates.push({ id: token.id, eligibleSubjects: row.eligibleSubjects.slice() });
    });
    const locked = owned.filter((token) => token.status !== 'available' && !sameList(token.eligibleSubjects, row.eligibleSubjects)).length;
    if (locked) warnings.push(`${locked} draft or committed token${locked === 1 ? '' : 's'} for ${row.staffId} kept the previous subject list.`);
  });
  return { create, eligibleUpdates, warnings };
}

export function planDraft(input: {
  studentId: string;
  staffId: string;
  subject: string;
  tokens: TokenRecord[];
  memberSupervisorId: string;
  pendingClear: boolean;
}): DraftPlan {
  const studentId = normalizeEmail(input.studentId);
  const staffId = normalizeEmail(input.staffId);
  const subject = text(input.subject);
  const mine = input.tokens.filter((token) => token.allocatedTo === studentId && token.status !== 'available');
  if (mine.length > 1) {
    return { tokens: [], pendingClear: input.pendingClear, changed: false, error: `${studentId} has more than one token.`, code: 'conflict' };
  }
  const current = mine[0];
  if (!staffId) {
    if (!current) return { tokens: [], pendingClear: input.pendingClear, changed: false, error: '', code: '' };
    const published = current.status === 'committed' || (!!input.memberSupervisorId && input.memberSupervisorId === current.staffId);
    return {
      tokens: [{ ...current, allocatedTo: '', assignedSubject: '', status: 'available' }],
      pendingClear: published ? true : input.pendingClear,
      changed: true,
      error: '',
      code: '',
    };
  }
  if (current && current.staffId === staffId) {
    if (current.assignedSubject === subject && current.status !== 'committed') {
      return { tokens: [], pendingClear: input.pendingClear, changed: false, error: '', code: '' };
    }
    if (current.assignedSubject === subject && current.status === 'committed') {
      return { tokens: [], pendingClear: input.pendingClear, changed: false, error: '', code: '' };
    }
    return {
      tokens: [{ ...current, assignedSubject: subject, status: 'draft' }],
      pendingClear: false,
      changed: true,
      error: '',
      code: '',
    };
  }
  const available = input.tokens.filter((token) => token.staffId === staffId && token.status === 'available');
  if (!available.length) {
    return { tokens: [], pendingClear: input.pendingClear, changed: false, error: `${staffId} has no available slots.`, code: 'capacity' };
  }
  const preferred = available.find((token) => subjectsOverlap(subject, token.eligibleSubjects)) || available[0];
  const updates: TokenRecord[] = [{ ...preferred, allocatedTo: studentId, assignedSubject: subject, status: 'draft' }];
  if (current) updates.push({ ...current, allocatedTo: '', assignedSubject: '', status: 'available' });
  return { tokens: updates, pendingClear: false, changed: true, error: '', code: '' };
}

export function planBatchDraft(input: {
  studentIds: string[];
  staffId: string;
  subjects: Record<string, string>;
  tokens: TokenRecord[];
  supervisorByStudent: Record<string, string>;
  pendingClearByStudent: Record<string, boolean>;
}): BatchDraftPlan {
  const working = input.tokens.map((token) => ({ ...token, eligibleSubjects: token.eligibleSubjects.slice() }));
  const writes = new Map<string, TokenRecord>();
  const pendingClears: Record<string, boolean> = {};
  const assigned: string[] = [];
  const skipped: { studentId: string; reason: string }[] = [];
  let stopped = '';
  input.studentIds.forEach((rawId) => {
    const studentId = normalizeEmail(rawId);
    if (!studentId) return;
    if (stopped) {
      skipped.push({ studentId, reason: stopped });
      return;
    }
    const plan = planDraft({
      studentId,
      staffId: input.staffId,
      subject: text(input.subjects[studentId]),
      tokens: working,
      memberSupervisorId: normalizeEmail(input.supervisorByStudent[studentId]),
      pendingClear: !!input.pendingClearByStudent[studentId],
    });
    if (plan.error) {
      skipped.push({ studentId, reason: plan.error });
      if (plan.code === 'capacity') stopped = plan.error;
      return;
    }
    if (!plan.changed) return;
    plan.tokens.forEach((token) => {
      const index = working.findIndex((item) => item.id === token.id);
      if (index >= 0) working[index] = token;
      writes.set(token.id, token);
    });
    pendingClears[studentId] = plan.pendingClear;
    assigned.push(studentId);
  });
  return { tokenWrites: [...writes.values()], pendingClears, assigned, skipped };
}

export function planReopen(tokens: TokenRecord[], studentId: string): { token: TokenRecord | null; error: string } {
  const email = normalizeEmail(studentId);
  const mine = tokens.filter((token) => token.allocatedTo === email && token.status !== 'available');
  if (mine.length !== 1) {
    return { token: null, error: mine.length ? `${email} has more than one token.` : 'This student has no allocation to reopen.' };
  }
  if (mine[0].status === 'draft') return { token: mine[0], error: '' };
  return { token: { ...mine[0], status: 'draft' }, error: '' };
}

export function planCommit(tokens: TokenRecord[], workspaces: WorkspaceRecord[]): CommitPlan {
  const drafts = tokens.filter((token) => token.status === 'draft' && token.allocatedTo);
  const byStudent = new Map<string, TokenRecord[]>();
  drafts.forEach((token) => {
    const list = byStudent.get(token.allocatedTo) || [];
    list.push(token);
    byStudent.set(token.allocatedTo, list);
  });
  const warnings: string[] = [];
  const assignments: CommitPlan['assignments'] = [];
  byStudent.forEach((list, studentId) => {
    if (list.length > 1) {
      warnings.push(`${studentId} has more than one draft token.`);
      return;
    }
    const token = list[0];
    assignments.push({ studentId, staffId: token.staffId, subject: token.assignedSubject, tokenId: token.id });
  });
  const blocked = new Set(byStudent.keys());
  const clears = workspaces
    .filter((workspace) => workspace.pendingClear && !blocked.has(workspace.studentId))
    .map((workspace) => workspace.studentId);
  return { assignments, clears, warnings };
}

export function subjectsOverlap(subject: string, eligible: string[]): boolean {
  const needle = normalizeSubject(subject);
  if (!needle) return false;
  return eligible.some((item) => phrasesOverlap(needle, normalizeSubject(item)));
}

export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  return text(value).split(/[,;/|]/).map((part) => part.trim()).filter(Boolean);
}

export function uniqueSubjects(value: unknown): string[] {
  const seen = new Set<string>();
  const subjects: string[] = [];
  splitList(value).forEach((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    subjects.push(item);
  });
  return subjects;
}

/** Active subject names, one each, in alphabetical order. Blank Active counts as active. */
export function activeSubjectNamesFrom(subjects: Doc[]): string[] {
  const names: string[] = [];
  subjects.forEach((subject) => {
    const active = subject.Active === '' || subject.Active === undefined || toBoolean(subject.Active);
    const name = text(subject.Name);
    if (!active || !name) return;
    if (names.some((item) => item.toLowerCase() === name.toLowerCase())) return;
    names.push(name);
  });
  return names.sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
}

/**
 * Read EE subjects from a staff record or a sheet cell.
 * Arrays stay intact, so a name like "History / Geography" is one subject.
 * A JSON array string does too. Older comma-separated text still splits.
 */
export function parseSubjectCell(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueSubjects(value);
  const raw = text(value);
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return uniqueSubjects(parsed);
    } catch {
      // Not JSON. Fall through to the legacy comma-separated list.
    }
  }
  return uniqueSubjects(raw);
}

/** Sheet cell for a subject list. Names that contain a list delimiter are written as JSON. */
export function formatSubjectCell(value: unknown): string {
  const subjects = parseSubjectCell(value);
  if (subjects.some((name) => /[,;/|]/.test(name))) return JSON.stringify(subjects);
  return subjects.join(', ');
}

/** Keep active subjects, plus names already stored so an inactive subject is not dropped by accident. */
export function canonicalSubjectAssignment(incoming: unknown, active: string[], previous: string[] = []): string[] {
  const activeMap = new Map(active.map((name) => [name.toLowerCase(), name]));
  const previousMap = new Map(previous.map((name) => [name.toLowerCase(), name]));
  return parseSubjectCell(incoming).map((name) => {
    const canonical = activeMap.get(name.toLowerCase()) || previousMap.get(name.toLowerCase());
    if (!canonical) throw new HubError(`${name} is not an active subject.`);
    return canonical;
  });
}

export interface QuotaCapacity {
  totalQuota: number;
  untiedQuota: number;
  subjects: { subject: string; capacity: number }[];
}

export interface SubjectTokenLoad {
  subjects: { subject: string; remaining: number }[];
  /** Available tokens with no eligible subject. */
  untied: number;
  /** An available token can be taken in more than one subject, so those remaining counts overlap. */
  overlaps: boolean;
}

/** Remaining slots for each subject on the tokens that feed supervisor load. An open token counts once per subject it can take. */
export function subjectTokenLoad(tokens: { status: string; eligibleSubjects?: unknown }[]): SubjectTokenLoad {
  let untied = 0;
  let overlaps = false;
  const groups = new Map<string, { subject: string; remaining: number }>();
  tokens.forEach((token) => {
    const subjects = uniqueSubjects(token.eligibleSubjects);
    const open = token.status === 'available';
    if (!subjects.length) {
      if (open) untied += 1;
      return;
    }
    if (open && subjects.length > 1) overlaps = true;
    subjects.forEach((subject) => {
      const key = subject.toLowerCase();
      const current = groups.get(key);
      const add = open ? 1 : 0;
      if (current) current.remaining += add;
      else groups.set(key, { subject, remaining: add });
    });
  });
  return {
    untied,
    overlaps,
    subjects: [...groups.values()].sort((left, right) => left.subject.localeCompare(right.subject, undefined, { sensitivity: 'base' })),
  };
}

/** Per-subject capacity counts a teacher's full quota once for every subject they can take. */
export function quotaCapacity(rows: { quota: number; eligibleSubjects: string[] }[]): QuotaCapacity {
  let totalQuota = 0;
  let untiedQuota = 0;
  const groups = new Map<string, { subject: string; capacity: number }>();
  rows.forEach((row) => {
    const quota = Number.isInteger(row.quota) && row.quota > 0 ? row.quota : 0;
    totalQuota += quota;
    const subjects = uniqueSubjects(row.eligibleSubjects);
    if (quota && !subjects.length) untiedQuota += quota;
    if (!quota) return;
    subjects.forEach((subject) => {
      const key = subject.toLowerCase();
      const current = groups.get(key);
      if (current) current.capacity += quota;
      else groups.set(key, { subject, capacity: quota });
    });
  });
  return {
    totalQuota,
    untiedQuota,
    subjects: [...groups.values()].sort((left, right) => left.subject.localeCompare(right.subject)),
  };
}

export function staffQuotaTokenRows(staff: Doc[]): { rows: ParsedTokenRow[]; warnings: string[] } {
  const rows: ParsedTokenRow[] = [];
  const warnings: string[] = [];
  staff.forEach((person) => {
    const staffId = normalizeEmail(person.EMAIL);
    if (!staffId) return;
    const raw = person.EEQuota;
    if (raw === '' || raw === undefined || raw === null) return;
    const quota = typeof raw === 'number' ? raw : Number(text(raw));
    if (!Number.isInteger(quota) || quota < 0) {
      warnings.push(`${staffId} quota must be a whole number.`);
      return;
    }
    const eligibleSubjects = parseSubjectCell(person.EESubjects);
    if (!quota && !eligibleSubjects.length) return;
    rows.push({ staffId, quota, eligibleSubjects });
  });
  return { rows, warnings };
}

export function tokenSheetRows(rows: ParsedTokenRow[]): (string | number)[][] {
  return [
    ['StaffEmail', 'Quota', 'EligibleSubjects'],
    ...rows.map((row) => [row.staffId, row.quota, row.eligibleSubjects.join(', ')]),
  ];
}

export function isSupportFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return /^(yes|y|true|1|flagged|needs support)$/i.test(text(value));
}

export function tokenFromDoc(doc: Doc): TokenRecord | null {
  const id = text(doc.id);
  const staffId = normalizeEmail(doc.staffId);
  if (!id || !staffId) return null;
  const raw = text(doc.status).toLowerCase();
  const allocatedTo = normalizeEmail(doc.allocatedTo);
  const status: TokenStatus = (raw === 'draft' || raw === 'committed') && allocatedTo ? raw : 'available';
  return {
    id,
    cohortId: text(doc.cohortId),
    staffId,
    eligibleSubjects: splitList(doc.eligibleSubjects),
    allocatedTo: status === 'available' ? '' : allocatedTo,
    assignedSubject: status === 'available' ? '' : text(doc.assignedSubject),
    status,
    createdAt: text(doc.createdAt),
  };
}

export function workspaceFromDoc(doc: Doc, id: string): WorkspaceRecord {
  return {
    studentId: normalizeEmail(doc.studentId || id),
    subjectChoices: plainMap(doc.subjectChoices),
    dynamicData: plainMap(doc.dynamicData),
    pendingClear: doc.pendingClear === true,
    updatedAt: text(doc.updatedAt),
  };
}

export function settingsFromDoc(doc: Doc | null): AllocationSettings {
  const base = emptySettings();
  if (!doc) return base;
  const detectedDynamicKeys = stringList(doc.detectedDynamicKeys);
  const detectedChoiceKeys = stringList(doc.detectedChoiceKeys);
  return {
    primaryChoiceKey: text(doc.primaryChoiceKey),
    secondaryChoiceKey: text(doc.secondaryChoiceKey),
    interdisciplinaryKey: text(doc.interdisciplinaryKey),
    hlColumn: text(doc.hlColumn),
    supportColumn: text(doc.supportColumn),
    columns: columnFlags(doc.columns, detectedDynamicKeys),
    detectedChoiceKeys,
    detectedDynamicKeys,
    lastWorkspaceSync: text(doc.lastWorkspaceSync),
    lastTokenSync: text(doc.lastTokenSync),
    lastExport: text(doc.lastExport),
  };
}

export function mergeDetected(settings: AllocationSettings, choiceKeys: string[], dynamicKeys: string[]): AllocationSettings {
  const columns = dynamicKeys.map((key) => {
    const prior = settings.columns.find((column) => column.key === key);
    if (prior) return { ...prior, colorScale: prior.colorScale === true };
    return {
      key,
      showOnCard: true,
      filterable: false,
      sortable: true,
      colorScale: false,
    };
  });
  const next: AllocationSettings = {
    ...settings,
    columns,
    detectedChoiceKeys: choiceKeys.slice(),
    detectedDynamicKeys: dynamicKeys.slice(),
  };
  if (!next.primaryChoiceKey && choiceKeys.includes('choice1')) next.primaryChoiceKey = 'choice1';
  if (!next.secondaryChoiceKey && choiceKeys.includes('choice2')) next.secondaryChoiceKey = 'choice2';
  if (!next.interdisciplinaryKey && choiceKeys.includes('interdisciplinary')) next.interdisciplinaryKey = 'interdisciplinary';
  return next;
}

export type AllocationPreviewAction = 'Add' | 'Update' | 'Unchanged' | 'Skip';

export interface AllocationPreviewRow {
  id: string;
  action: AllocationPreviewAction;
  incoming: string;
  hub: string;
}

/** Light blue → deep blue (ColorBrewer Blues). Luminance carries the value, so the scale stays distinct without red and green. */
export const COLOR_SCALE_STOPS: { background: string; color: string }[] = [
  { background: '#f7fbff', color: '#263746' },
  { background: '#c6dbef', color: '#263746' },
  { background: '#6baed6', color: '#263746' },
  { background: '#2171b5', color: '#ffffff' },
  { background: '#08306b', color: '#ffffff' },
];

const ORDINAL_WORDS: Record<string, number> = {
  weak: 0,
  low: 1,
  avg: 2,
  average: 2,
  strong: 3,
  high: 4,
};

export function scaleNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return null;
  const raw = text(value);
  if (!raw) return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const word = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ORDINAL_WORDS, word)) return ORDINAL_WORDS[word];
  return null;
}

export function columnScaleExtent(values: unknown[]): { min: number; max: number } | null {
  const nums = values.map(scaleNumber).filter((value): value is number => value !== null);
  if (!nums.length) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return null;
  return { min, max };
}

export function colorScaleFill(value: unknown, extent: { min: number; max: number } | null): { background: string; color: string } | null {
  if (!extent) return null;
  const number = scaleNumber(value);
  if (number === null) return null;
  const span = extent.max - extent.min;
  if (span <= 0) return null;
  const t = Math.min(1, Math.max(0, (number - extent.min) / span));
  const index = Math.round(t * (COLOR_SCALE_STOPS.length - 1));
  return COLOR_SCALE_STOPS[index];
}

export function workspacePreviewRows(
  parsedRows: ParsedWorkspaceRow[],
  roster: { studentId: string; eeActive?: unknown }[],
  existing: WorkspaceRecord[],
): AllocationPreviewRow[] {
  const onRoster = new Map(roster.map((member) => [normalizeEmail(member.studentId), member]));
  const hub = new Map(existing.map((row) => [normalizeEmail(row.studentId), row]));
  return parsedRows.map((row) => {
    const incoming = summarizeWorkspace(row.subjectChoices, row.dynamicData, row.eeActive) || '—';
    const member = onRoster.get(row.studentId);
    if (!member) return { id: row.studentId, action: 'Skip', incoming, hub: 'Not on the roster' };
    const prior = hub.get(row.studentId);
    const hubActive = text(member.eeActive) === '' ? null : toBoolean(member.eeActive);
    const activeSame = row.eeActive === null || row.eeActive === (hubActive === null ? true : hubActive);
    const hubSummary = summarizeWorkspace(
      prior?.subjectChoices || {},
      prior?.dynamicData || {},
      row.eeActive === null ? null : (hubActive === null ? true : hubActive),
    );
    if (!prior) return { id: row.studentId, action: 'Add', incoming, hub: '—' };
    const same = sameRecord(row.subjectChoices, prior.subjectChoices) && sameRecord(row.dynamicData, prior.dynamicData) && activeSame;
    return { id: row.studentId, action: same ? 'Unchanged' : 'Update', incoming, hub: hubSummary || '—' };
  });
}

export function tokenPreviewRows(parsedRows: ParsedTokenRow[], existing: TokenRecord[]): AllocationPreviewRow[] {
  return parsedRows.map((row) => {
    const owned = existing.filter((token) => token.staffId === row.staffId);
    const open = owned.filter((token) => token.status === 'available');
    const draft = owned.filter((token) => token.status === 'draft').length;
    const committed = owned.filter((token) => token.status === 'committed').length;
    const gap = row.quota - owned.length;
    const creates = Math.max(0, gap);
    const subjects = row.eligibleSubjects.join(', ') || 'No subjects';
    const incoming = `Quota ${row.quota} · ${subjects}`;
    const hub = owned.length
      ? `${owned.length} token${owned.length === 1 ? '' : 's'} · ${open.length} open, ${draft} draft, ${committed} committed · ${uniqueSubjectLists(owned)}`
      : 'No tokens yet';
    const subjectUpdates = open.filter((token) => token.eligibleSubjects.join('\n') !== row.eligibleSubjects.join('\n')).length;
    let action: AllocationPreviewAction = 'Unchanged';
    if (creates > 0 && owned.length === 0) action = 'Add';
    else if (creates > 0 || subjectUpdates > 0) action = 'Update';
    return { id: row.staffId, action, incoming, hub };
  });
}

function summarizeWorkspace(
  choices: Record<string, string | number | boolean>,
  dynamicData: Record<string, string | number | boolean>,
  eeActive: boolean | null,
): string {
  const parts: string[] = [];
  const choiceText = summarizePairs(choices);
  const dynamicText = summarizePairs(dynamicData);
  if (choiceText) parts.push(choiceText);
  if (dynamicText) parts.push(dynamicText);
  if (eeActive === true || eeActive === false) parts.push(`EEActive: ${eeActive ? 'yes' : 'no'}`);
  return parts.join(' · ');
}

function summarizePairs(record: Record<string, string | number | boolean>): string {
  return Object.keys(record).sort().map((key) => `${key}: ${formatPreviewValue(record[key])}`).join(', ');
}

function formatPreviewValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function sameRecord(left: Record<string, string | number | boolean>, right: Record<string, string | number | boolean>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function uniqueSubjectLists(tokens: TokenRecord[]): string {
  const lists: string[] = [];
  tokens.forEach((token) => {
    const label = token.eligibleSubjects.join(', ') || 'No subjects';
    if (!lists.includes(label)) lists.push(label);
  });
  return lists.join(' / ') || 'No subjects';
}

export function applySavedConfig(current: AllocationSettings, incoming: Doc): AllocationSettings {
  const choiceKeys = new Set(current.detectedChoiceKeys);
  const dynamicKeys = new Set(current.detectedDynamicKeys);
  const columns = Array.isArray(incoming.columns) ? incoming.columns : [];
  const nextColumns = current.detectedDynamicKeys.length
    ? current.detectedDynamicKeys.map((key) => flagFrom(key, columns.find((column) => text(column?.key) === key) || current.columns.find((column) => column.key === key)))
    : columns.map((column) => flagFrom(text(column?.key), column)).filter((column) => column.key);
  return {
    ...current,
    primaryChoiceKey: allowedKey(incoming.primaryChoiceKey, choiceKeys),
    secondaryChoiceKey: allowedKey(incoming.secondaryChoiceKey, choiceKeys),
    interdisciplinaryKey: allowedKey(incoming.interdisciplinaryKey, choiceKeys),
    hlColumn: allowedKey(incoming.hlColumn, dynamicKeys),
    supportColumn: allowedKey(incoming.supportColumn, dynamicKeys),
    columns: nextColumns,
  };
}

export function studentLabel(member: Doc): string {
  const surname = text(member.Surname);
  const first = text(member['Preferred Name']) || text(member['First Name']);
  if (surname && first) return `${surname}, ${first}`;
  return text(member['Display Name']) || normalizeEmail(member.StudentId);
}

export function buildDesk(input: {
  cohortId: string;
  members: Doc[];
  workspaces: WorkspaceRecord[];
  tokens: TokenRecord[];
  staff: { email: string; displayName: string }[];
  settings: AllocationSettings;
}): AllocationDesk {
  const names = new Map(input.staff.map((person) => [normalizeEmail(person.email), person.displayName || person.email]));
  const workspaceByStudent = new Map(input.workspaces.map((workspace) => [workspace.studentId, workspace]));
  const warnings: string[] = [];
  const tokensByStudent = new Map<string, TokenRecord[]>();
  input.tokens.forEach((token) => {
    if (!token.allocatedTo || token.status === 'available') return;
    const list = tokensByStudent.get(token.allocatedTo) || [];
    list.push(token);
    tokensByStudent.set(token.allocatedTo, list);
  });
  const activeIds = new Set<string>();
  const students = input.members
    .filter((member) => normalizeEmail(member.StudentId) && isEeActive(member.eeActive))
    .map((member) => {
      const studentId = normalizeEmail(member.StudentId);
      activeIds.add(studentId);
      const workspace = workspaceByStudent.get(studentId);
      const held = tokensByStudent.get(studentId) || [];
      if (held.length > 1) warnings.push(`${studentId} has more than one token.`);
      const token = held.find((item) => item.status === 'draft') || held[0] || null;
      const choices = {
        primary: choiceText(workspace?.subjectChoices, input.settings.primaryChoiceKey),
        secondary: choiceText(workspace?.subjectChoices, input.settings.secondaryChoiceKey),
        interdisciplinary: !!input.settings.interdisciplinaryKey && toBoolean(workspace?.subjectChoices[input.settings.interdisciplinaryKey]),
      };
      const assignedSubject = token?.assignedSubject || '';
      const eligible = token?.eligibleSubjects || [];
      const allocated = !!token;
      const hlValue = input.settings.hlColumn ? workspace?.dynamicData[input.settings.hlColumn] : undefined;
      const supportValue = input.settings.supportColumn ? workspace?.dynamicData[input.settings.supportColumn] : undefined;
      return {
        studentId,
        displayName: studentLabel(member),
        sortName: studentLabel(member).toLowerCase(),
        liveSupervisorId: normalizeEmail(member.supervisorId),
        liveSubject: text(member.subject),
        subjectChoices: workspace?.subjectChoices || {},
        dynamicData: workspace?.dynamicData || {},
        pendingClear: !!workspace?.pendingClear,
        token: token ? {
          id: token.id,
          staffId: token.staffId,
          staffName: names.get(token.staffId) || token.staffId,
          eligibleSubjects: token.eligibleSubjects.slice(),
          assignedSubject: token.assignedSubject,
          status: token.status as 'draft' | 'committed',
        } : null,
        choices,
        flags: {
          drafted: token?.status === 'draft',
          committed: token?.status === 'committed',
          subjectMatch: !allocated ? 'none' : subjectsOverlap(assignedSubject, eligible) ? 'match' : 'miss',
          hlMatch: !allocated || !input.settings.hlColumn ? 'none' : splitList(hlValue).some((part) => subjectsOverlap(part, eligible)) ? 'match' : 'miss',
          needsSupport: !!input.settings.supportColumn && isSupportFlag(supportValue),
        },
      } satisfies DeskStudent;
    })
    .sort((left, right) => left.sortName.localeCompare(right.sortName));

  tokensByStudent.forEach((_held, studentId) => {
    if (!activeIds.has(studentId)) warnings.push(`${studentId} is inactive and still holds a token.`);
  });

  const groups = new Map<string, TokenRecord[]>();
  input.tokens.forEach((token) => {
    const list = groups.get(token.staffId) || [];
    list.push(token);
    groups.set(token.staffId, list);
  });
  const supervisors = [...groups.entries()].map(([staffId, tokens]) => {
    const subjects = [...new Set(tokens.flatMap((token) => token.eligibleSubjects))].sort();
    const draft = tokens.filter((token) => token.status === 'draft').length;
    const committed = tokens.filter((token) => token.status === 'committed').length;
    const available = tokens.filter((token) => token.status === 'available').length;
    return {
      staffId,
      displayName: names.get(staffId) || staffId,
      eligibleSubjects: subjects,
      total: tokens.length,
      used: draft + committed,
      available,
      draft,
      committed,
    };
  }).sort((left, right) => left.displayName.localeCompare(right.displayName));

  const commit = planCommit(input.tokens, input.workspaces);
  return {
    cohortId: input.cohortId,
    students,
    supervisors,
    tokenSlots: input.tokens.map((token) => ({
      status: token.status,
      eligibleSubjects: token.eligibleSubjects.slice(),
    })),
    settings: input.settings,
    summary: {
      staffCount: supervisors.length,
      tokenCount: input.tokens.length,
      activeStudents: students.length,
      buffer: input.tokens.length - students.length,
    },
    publish: { drafts: commit.assignments.length, clears: commit.clears.length, blocked: commit.warnings.length },
    warnings: warnings.concat(commit.warnings),
  };
}

export function allocationExportRows(students: DeskStudent[], settings: AllocationSettings): (string | number | boolean)[][] {
  const cards = settings.columns.filter((column) => column.showOnCard).map((column) => column.key);
  const header = ['StudentId', 'Display Name', 'Status', 'SupervisorEmail', 'AssignedSubject', ...cards];
  const body = students.map((student) => {
    const status = student.flags.committed ? 'Committed' : student.flags.drafted ? 'Draft' : 'Unallocated';
    const row: (string | number | boolean)[] = [
      student.studentId,
      student.displayName,
      status,
      student.token?.staffId || '',
      student.token?.assignedSubject || '',
    ];
    cards.forEach((key) => {
      const value = student.dynamicData[key];
      row.push(value === undefined ? '' : value);
    });
    return row;
  });
  return [header, ...body];
}

function headerRow(grid: Grid): string[] {
  if (!grid.rows.length) throw new HubError(`${grid.title} has no header row.`);
  const headers = grid.rows[0].map((cell) => text(cell));
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    const key = header.toLowerCase();
    if (!header || !seen.has(key)) {
      if (header) seen.add(key);
      return;
    }
    headers[index] = '';
  });
  return headers;
}

function headerIndex(headers: string[], names: string[]): number {
  for (const name of names) {
    const index = headers.findIndex((header) => header.toLowerCase().replace(/\s+/g, ' ') === name);
    if (index >= 0) return index;
  }
  return -1;
}

function choiceColumn(header: string): string {
  const match = /^choice[_:\s-]+(.+)$/i.exec(header.trim());
  return match ? text(match[1]) : '';
}

function choiceObject(value: unknown, warnings: string[], label: string): Record<string, string | number | boolean> {
  if (value === null || value === undefined || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return {};
    if (!/^[[{]/.test(raw)) {
      warnings.push(`${label} is not a JSON object.`);
      return {};
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`${label} is not valid JSON.`);
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`${label} should be a JSON object.`);
    return {};
  }
  return plainMap(parsed);
}

function plainCell(value: unknown): string | number | boolean | '' {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value;
  return text(value);
}

function plainMap(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    const name = text(key);
    const cell = plainCell(item);
    if (!name || cell === '') return;
    out[name] = cell;
  });
  return out;
}

function rowHasValue(row: unknown): boolean {
  return Array.isArray(row) && row.some((cell) => text(cell) !== '');
}

function normalizeSubject(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function phrasesOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftWords = left.split(' ');
  const rightWords = right.split(' ');
  if (leftWords.length === 1 && rightWords.length === 1) return wordOverlap(left, right);
  const shorter = leftWords.length <= rightWords.length ? leftWords : rightWords;
  const longer = shorter === leftWords ? rightWords : leftWords;
  return shorter.every((word) => longer.some((other) => wordOverlap(word, other)));
}

function wordOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return left.length >= 3 && right.length >= 3 && (left.includes(right) || right.includes(left));
}

function choiceText(choices: Record<string, string | number | boolean> | undefined, key: string): string {
  if (!choices || !key || choices[key] === undefined || typeof choices[key] === 'boolean') return '';
  return text(choices[key]);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function columnFlags(value: unknown, keys: string[]): ColumnFlag[] {
  const rows = Array.isArray(value) ? value : [];
  return keys.map((key) => flagFrom(key, rows.find((row) => text(row?.key) === key)));
}

function flagFrom(key: string, row: Doc | undefined): ColumnFlag {
  return {
    key,
    showOnCard: row ? row.showOnCard === true : false,
    filterable: row ? row.filterable === true : false,
    sortable: row ? row.sortable === true : false,
    colorScale: row ? row.colorScale === true : false,
  };
}

function allowedKey(value: unknown, allowed: Set<string>): string {
  const key = text(value).slice(0, 80);
  if (!key) return '';
  if (allowed.size && !allowed.has(key)) return '';
  return key;
}
