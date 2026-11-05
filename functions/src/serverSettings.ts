import { App, audited, requireAdmin } from './session';
import { Doc, HubError, nowIso, text, toBoolean } from './util';

/** Firestore document `settings/server`. */
export const SERVER_SETTINGS_ID = 'server';

export const MAINTENANCE_NOTE_LIMIT = 500;

export type ScheduledJobName = 'notificationSweep' | 'docCommentSweep';

export interface ServerSettings {
  emailNotificationEnabled: boolean;
  commentsSweepEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceNote: string;
}

const SAVE_KEYS = ['emailNotificationEnabled', 'commentsSweepEnabled', 'maintenanceMode', 'maintenanceNote'] as const;

/**
 * Missing sweep flags stay enabled so a deployment with no settings document
 * keeps the daily jobs. Maintenance stays off until an admin turns it on.
 */
export function normalizeServerSettings(value: unknown): ServerSettings {
  const record = value && typeof value === 'object' ? value as Doc : {};
  return {
    emailNotificationEnabled: flagOrDefault(record, 'emailNotificationEnabled', true),
    commentsSweepEnabled: flagOrDefault(record, 'commentsSweepEnabled', true),
    maintenanceMode: flagOrDefault(record, 'maintenanceMode', false),
    maintenanceNote: text(record.maintenanceNote).slice(0, MAINTENANCE_NOTE_LIMIT),
  };
}

export async function readServerSettings(app: App): Promise<ServerSettings> {
  if (typeof app.store.getSettings !== 'function') return normalizeServerSettings(null);
  const saved = await app.store.getSettings(SERVER_SETTINGS_ID);
  return normalizeServerSettings(saved);
}

export async function getServerSettings(app: App): Promise<ServerSettings> {
  await requireAdmin(app, 'VIEW_SERVER_SETTINGS');
  return readServerSettings(app);
}

export async function saveServerSettings(app: App, input: unknown): Promise<ServerSettings> {
  const user = await requireAdmin(app, 'SAVE_SERVER_SETTINGS');
  const next = serverSettingsForSave(input);
  return audited(app, user, 'SAVE_SERVER_SETTINGS', next, async () => {
    await app.store.setSettings(SERVER_SETTINGS_ID, {
      emailNotificationEnabled: next.emailNotificationEnabled,
      commentsSweepEnabled: next.commentsSweepEnabled,
      maintenanceMode: next.maintenanceMode,
      maintenanceNote: next.maintenanceNote,
      updatedAt: nowIso(),
    });
    return next;
  });
}

/** False only when the admin has turned that daily job off. A read error runs the job. */
export async function scheduledJobEnabled(app: App, job: ScheduledJobName): Promise<boolean> {
  try {
    const settings = await readServerSettings(app);
    return job === 'notificationSweep' ? settings.emailNotificationEnabled : settings.commentsSweepEnabled;
  } catch (error) {
    console.error(job + ' could not read settings/server; running the job.', error);
    return true;
  }
}

export function serverSettingsForSave(input: unknown): ServerSettings {
  const record = input && typeof input === 'object' ? input as Doc : {};
  const missing = SAVE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing.length) throw new HubError('Server settings need email notifications, the comment sweep, maintenance mode, and a maintenance note.');
  if (record.maintenanceNote !== null && record.maintenanceNote !== undefined && typeof record.maintenanceNote !== 'string') {
    throw new HubError('Maintenance note must be text.');
  }
  const maintenanceNote = text(record.maintenanceNote);
  if (maintenanceNote.length > MAINTENANCE_NOTE_LIMIT) {
    throw new HubError(`Maintenance note must be ${MAINTENANCE_NOTE_LIMIT} characters or fewer.`);
  }
  return {
    emailNotificationEnabled: toBoolean(record.emailNotificationEnabled),
    commentsSweepEnabled: toBoolean(record.commentsSweepEnabled),
    maintenanceMode: toBoolean(record.maintenanceMode),
    maintenanceNote,
  };
}

function flagOrDefault(record: Doc, key: string, fallback: boolean): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return fallback;
  const value = record[key];
  if (value === '' || value === null || value === undefined) return fallback;
  return toBoolean(value);
}
