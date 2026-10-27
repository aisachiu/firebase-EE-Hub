import { HubUser, normalizeStaffView } from './permissions';
import { cohortSheetName, COLLECTIONS, normalizePhaseColor } from './schema';
import { App, deny } from './session';
import { canonicalStudentEmail, canonicalStudentNumber, studentLoginId } from './studentIdentity';
import { dateOnlyValue, Doc, driveNamePart, HubError, normalizeEmail, text, toBoolean } from './util';

export interface CohortEntry {
  id: string;
  name: string;
  sheetName: string;
  status: string;
  driveRootFolderId: string;
  prefix: string;
  suffix: string;
}

export interface Placement {
  cohortId: string;
  email: string;
  studentEmail: string;
  displayName: string;
  surname: string;
  firstName: string;
  studentNumber: string;
  hrm: string;
  subject: string;
  supervisorId: string;
  anchor: string;
  folder: string;
  doc: string;
  rppf: string;
  poster: string;
}

export async function listCohorts(app: App, includeInactive = false): Promise<CohortEntry[]> {
  const records = await app.store.list(COLLECTIONS.cohorts);
  return records
    .map((record) => {
      const id = text(record.Cohort);
      return {
        id,
        name: id,
        sheetName: text(record.SheetName) || cohortSheetName(id),
        status: text(record.Status) || 'Active',
        driveRootFolderId: text(record.DriveRootFolderId),
        prefix: driveNamePart(record.FolderPrefix),
        suffix: driveNamePart(record.FolderSuffix),
      };
    })
    .filter((entry) => entry.id && (includeInactive || entry.status.toLowerCase() !== 'inactive'))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function requireCohort(app: App, cohortId: string, includeInactive = false): Promise<CohortEntry> {
  const id = text(cohortId);
  const cohorts = await listCohorts(app, true);
  const cohort = cohorts.find((entry) => entry.id === id || entry.sheetName === id);
  if (!cohort || (!includeInactive && cohort.status.toLowerCase() === 'inactive')) {
    throw new HubError('Cohort not found or inactive.');
  }
  return cohort;
}

/** Roster subject wins. The student profile is the fallback My Students and /my-ee use. */
export function allocatedSubject(member: Doc | null | undefined, profile?: Doc | null): string {
  return text(member?.subject) || text(profile?.subject);
}

export function placementFromMember(cohortId: string, record: Doc, profile?: Doc | null): Placement {
  const email = studentLoginId(record);
  return {
    cohortId,
    email,
    studentEmail: canonicalStudentEmail(record),
    displayName: text(record['Display Name']) || email,
    surname: text(record.Surname),
    firstName: text(record['First Name']),
    studentNumber: canonicalStudentNumber(record),
    hrm: text(record.HRM),
    subject: allocatedSubject(record, profile),
    supervisorId: normalizeEmail(record.supervisorId),
    anchor: dateOnlyValue(record.Anchor_Date),
    folder: text(record.EEFolder),
    doc: text(record.EEDoc),
    rppf: text(record.RPPFDoc),
    poster: text(record.EEPoster),
  };
}

async function profilesByLogin(app: App): Promise<Map<string, Doc>> {
  const map = new Map<string, Doc>();
  const rows = await app.store.list(COLLECTIONS.studentUsers);
  rows.forEach((row) => {
    const id = studentLoginId(row);
    if (id) map.set(id, row);
  });
  return map;
}

export async function findPlacement(app: App, studentEmail: string): Promise<Placement | null> {
  const email = normalizeEmail(studentEmail);
  if (!email) return null;
  const cohorts = await listCohorts(app, false);
  const profile = await app.store.get(COLLECTIONS.studentUsers, email);
  for (const cohort of cohorts) {
    const record = await app.store.getMember(cohort.id, email);
    if (!record || !normalizeEmail(record.StudentId)) continue;
    return placementFromMember(cohort.id, record, profile);
  }
  return null;
}

export async function readRoster(app: App, cohortId: string): Promise<Placement[]> {
  await requireCohort(app, cohortId);
  const id = text(cohortId);
  const [records, profiles] = await Promise.all([
    app.store.listMembers(id),
    profilesByLogin(app),
  ]);
  return records
    .filter((record) => normalizeEmail(record.StudentId))
    .map((record) => placementFromMember(id, record, profiles.get(normalizeEmail(record.StudentId))));
}

export interface StaffTables {
  activeCohorts: CohortEntry[];
  byEmail: Record<string, Placement>;
  byCohort: Record<string, Placement[]>;
}

export async function readStaffTables(app: App): Promise<StaffTables> {
  const all = await listCohorts(app, true);
  const activeCohorts = all.filter((cohort) => cohort.status.toLowerCase() !== 'inactive');
  const byEmail: Record<string, Placement> = {};
  const byCohort: Record<string, Placement[]> = {};
  const profiles = await profilesByLogin(app);
  for (const cohort of all) {
    const records = await app.store.listMembers(cohort.id);
    const roster: Placement[] = [];
    records.forEach((record) => {
      const student = placementFromMember(cohort.id, record, profiles.get(studentLoginId(record)));
      if (!student.email) return;
      roster.push(student);
      if (!byEmail[student.email]) byEmail[student.email] = student;
    });
    byCohort[cohort.id] = roster;
  }
  return { activeCohorts, byEmail, byCohort };
}

export function staffMayViewPlacement(user: HubUser, view: string, roster: { supervisorId?: string } | null | undefined): boolean {
  if (!user || user.role !== 'staff' || !roster) return false;
  if (view === 'supervisor' && roster.supervisorId && normalizeEmail(roster.supervisorId) !== user.email && !user.permissions?.canAdmin) {
    return false;
  }
  return true;
}

export async function staffStudentContext(app: App, user: HubUser, studentEmail: string, cohortId: string, operation: string, viewAs?: unknown) {
  const email = normalizeEmail(studentEmail);
  await requireCohort(app, cohortId);
  const roster = (await readRoster(app, cohortId)).find((student) => student.email === email);
  if (!roster) throw new HubError('Student is not in the selected cohort.');
  const requested = viewAs === undefined
    ? (user.permissions?.canAdmin ? 'coordinator' : (user.permissions?.isSupervisor ? 'supervisor' : 'staff'))
    : viewAs;
  const view = normalizeStaffView(user, requested);
  if (!staffMayViewPlacement(user, view, roster)) {
    return deny(app, user, operation, 'This student is assigned to another supervisor.');
  }
  return { email, roster, view };
}

export function staffMayAddStudentTodo(user: HubUser, context: { view: string; roster: Placement }): boolean {
  if (!user || user.role !== 'staff' || !context || context.view === 'staff') return false;
  if (user.permissions?.canAdmin) return true;
  return context.view === 'supervisor' && !!user.permissions?.isSupervisor && normalizeEmail(context.roster.supervisorId) === user.email;
}

export function staffMayUpdateAllMilestones(user: HubUser, roster: Placement | null, view: string): boolean {
  if (!user || user.role !== 'staff' || view === 'staff' || !roster) return false;
  return coordinatorOrAdmin(user);
}

export function coordinatorOrAdmin(user: HubUser | null | undefined): boolean {
  const permissions = user?.permissions;
  return !!(permissions && (permissions.canAdmin || permissions.isCoordinator || permissions.isAdmin));
}

/** Login StudentId plus Student Email, so a task stored under either id still belongs to the student. */
export function identityAliases(roster: { email?: string; studentEmail?: string } | null | undefined, email: string): string[] {
  const ids = new Set<string>();
  [email, roster?.email, roster?.studentEmail].forEach((value) => {
    const id = normalizeEmail(value);
    if (id) ids.add(id);
  });
  return [...ids];
}

/** Map a login id or Student Email onto the roster login id. */
export function loginAliasMap(students: { email?: string; studentEmail?: string }[]): Record<string, string> {
  const map: Record<string, string> = {};
  students.forEach((student) => {
    const login = normalizeEmail(student.email);
    if (!login) return;
    map[login] = login;
    const mail = normalizeEmail(student.studentEmail);
    if (mail) map[mail] = login;
  });
  return map;
}

export async function cohortPathwaySeeded(app: App, cohortId: unknown): Promise<boolean> {
  const id = text(cohortId);
  if (!id) return false;
  const cohort = await app.store.get(COLLECTIONS.cohorts, id);
  return !!(cohort && toBoolean(cohort.PathwaySeeded));
}

export async function phaseDocsFor(app: App, cohortId?: unknown): Promise<Doc[]> {
  const id = text(cohortId);
  if (id && await cohortPathwaySeeded(app, id) && typeof app.store.listCohortPhases === 'function') {
    return app.store.listCohortPhases(id);
  }
  return app.store.list(COLLECTIONS.phases);
}

export async function milestoneDocsFor(app: App, cohortId?: unknown): Promise<Doc[]> {
  const id = text(cohortId);
  if (id && await cohortPathwaySeeded(app, id) && typeof app.store.listCohortMilestones === 'function') {
    return app.store.listCohortMilestones(id);
  }
  return app.store.list(COLLECTIONS.milestoneTemplates);
}

export async function readPhases(app: App, cohortId?: unknown) {
  const records = await phaseDocsFor(app, cohortId);
  return records
    .filter((phase) => toBoolean(phase.active))
    .map((phase) => ({
      phaseId: text(phase.phaseId),
      phaseTitle: text(phase.phaseTitle),
      sequence: Number(phase.sequence) || 0,
      phaseColor: normalizePhaseColor(phase.phaseColor),
    }))
    .sort((left, right) => left.sequence - right.sequence);
}

export async function readTemplates(app: App, cohortId?: unknown) {
  const records = await milestoneDocsFor(app, cohortId);
  return records
    .map((template) => ({
      milestoneId: text(template.milestoneId),
      type: text(template.type).toLowerCase(),
      title: text(template.milestoneTitle),
      phase: text(template.phase),
      mOwner: text(template.mOwner).toLowerCase(),
      offsetDays: Number(template.offsetDays) || 0,
      description: text(template.milestoneDescription),
      position: Number(template.position) || 0,
    }))
    .sort((left, right) => left.position - right.position || left.milestoneId.localeCompare(right.milestoneId));
}

export function orderTemplates<T extends { phase: string; offsetDays: number }>(templates: T[], phases: { phaseId: string; sequence: number }[]): T[] {
  const sequence: Record<string, number> = {};
  phases.forEach((phase) => { sequence[phase.phaseId] = phase.sequence; });
  return templates.slice().sort((left, right) => {
    const phaseOrder = (sequence[left.phase] || 0) - (sequence[right.phase] || 0);
    if (phaseOrder) return phaseOrder;
    return right.offsetDays - left.offsetDays;
  });
}
