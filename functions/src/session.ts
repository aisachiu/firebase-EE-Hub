import { HubUser } from './permissions';
import { COLLECTIONS } from './schema';
import { Store } from './store';
import { Doc, HubError, normalizeEmail, nowIso, text, toBoolean } from './util';

export interface App {
  store: Store;
  email: string;
  timeZone: string;
  user?: HubUser | null;
  userLoaded?: boolean;
}

export async function audit(app: App, action: string, payload: unknown, actorEmail: string): Promise<void> {
  const details = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  await app.store.addAudit({
    Timestamp: nowIso(),
    User: normalizeEmail(actorEmail),
    Action: String(action || 'UNKNOWN'),
    Payload: details,
  });
}

export async function currentUser(app: App): Promise<HubUser> {
  if (app.userLoaded) {
    if (!app.user) throw new HubError(app.email ? 'No active account is registered for this email.' : 'Google did not provide the signed-in email.');
    return app.user;
  }
  app.userLoaded = true;
  if (!app.email) {
    app.user = null;
    throw new HubError('Google did not provide the signed-in email.');
  }
  const staff = await app.store.get(COLLECTIONS.staffUsers, app.email);
  if (staff && toBoolean(staff.isStaff)) {
    app.user = {
      email: app.email,
      displayName: text(staff.DisplayName) || app.email,
      role: 'staff',
      permissions: {
        isStaff: toBoolean(staff.isStaff),
        isSupervisor: toBoolean(staff.isSupervisor),
        isLead: toBoolean(staff.isLead),
        isCoordinator: toBoolean(staff.isCoordinator),
        isAdmin: toBoolean(staff.isAdmin),
        canAdmin: toBoolean(staff.isAdmin) || toBoolean(staff.isCoordinator),
      },
    };
    return app.user;
  }
  const student = await app.store.findBy(COLLECTIONS.studentUsers, 'StudentId', app.email)
    || await app.store.findBy(COLLECTIONS.studentUsers, 'studentEmail', app.email);
  if (student) {
    app.user = { email: app.email, displayName: text(student.DisplayName) || app.email, role: 'student' };
    return app.user;
  }
  app.user = null;
  throw new HubError('No active account is registered for this email.');
}

export async function requireUser(app: App, operation: string): Promise<HubUser> {
  try {
    return await currentUser(app);
  } catch (error) {
    try {
      await audit(app, 'ACCESS_DENIED', { operation, reason: 'Unauthenticated' }, app.email);
    } catch (auditError) {
      console.error('Unable to audit denied access', auditError);
    }
    throw new HubError('Access denied.');
  }
}

export async function requireStaff(app: App, operation: string): Promise<HubUser> {
  const user = await requireUser(app, operation);
  if (user.role !== 'staff') return deny(app, user, operation, 'Staff access required.');
  return user;
}

export async function requireAdmin(app: App, operation: string): Promise<HubUser> {
  const user = await requireStaff(app, operation);
  if (!user.permissions?.canAdmin) return deny(app, user, operation, 'Administrator or coordinator access required.');
  return user;
}

export async function deny(app: App, user: HubUser | null, operation: string, reason: string): Promise<never> {
  try {
    await audit(app, 'ACCESS_DENIED', { operation, reason }, user ? user.email : app.email);
  } catch (error) {
    console.error('Unable to audit denied access', error);
  }
  throw new HubError('Access denied.');
}

export async function audited<T>(app: App, user: HubUser, action: string, detail: Doc, work: () => Promise<T>): Promise<T> {
  await audit(app, `${action}_REQUESTED`, detail, user.email);
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await audit(app, `${action}_FAILED`, { detail, reason: error instanceof Error ? error.message : String(error) }, user.email);
    } catch (auditError) {
      console.error('Unable to record failed mutation outcome', auditError);
    }
    throw error;
  }
  try {
    await audit(app, `${action}_SUCCEEDED`, detail, user.email);
  } catch (auditError) {
    console.error('Mutation succeeded but its completion audit row failed', auditError);
    if (result && typeof result === 'object') (result as Doc).auditWarning = true;
  }
  return result;
}
