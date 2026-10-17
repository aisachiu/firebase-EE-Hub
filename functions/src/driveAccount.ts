// The Google account that creates Drive folders and reads essay history.
// The private key stays in the function environment. Firestore stores only
// the Workspace user that key is allowed to impersonate.

import { readFileSync } from 'node:fs';
import type { App } from './session';
import { HubError, normalizeEmail, nowIso, text, validateEmail } from './util';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DRIVE_ACCOUNT_META = 'driveAccount';

export const MISSING_ACTOR = 'Assign the Google account used for Drive in Admin → Google Drive.';
export const MISSING_KEY = 'Google Drive is not configured. Set EE_DRIVE_SERVICE_ACCOUNT_JSON, or reuse the Gmail service account and grant it the Drive scope.';
export const ESSAY_DRIVE_UNAVAILABLE = 'Word count and edit history are not available until an admin assigns the Google account used for Drive.';
export const ESSAY_DRIVE_NOT_CONFIGURED = 'Word count and edit history are not available until Google Drive is configured for the assigned account.';

const KEY_INVALID = 'The Drive service account value must be service-account JSON or a path to that file.';
const KEY_FIELDS = 'The Drive service account JSON needs client_email and private_key.';

export interface DriveServiceAccount {
  client_email: string;
  private_key: string;
}

export interface DriveKeySource {
  driveJson?: string;
  gmailJson?: string;
}

export interface DriveAccountStatus {
  actorEmail: string;
  serviceAccountEmail: string;
  keyConfigured: boolean;
  keyError: string;
  updatedBy: string;
  updatedAt: string;
  ready: boolean;
}

export function driveKeyRaw(source?: DriveKeySource): string {
  if (source) return text(source.driveJson) || text(source.gmailJson);
  return text(process.env.EE_DRIVE_SERVICE_ACCOUNT_JSON) || text(process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON);
}

export function loadDriveServiceAccount(source?: DriveKeySource): DriveServiceAccount {
  const raw = driveKeyRaw(source);
  if (!raw) throw new HubError(MISSING_KEY);
  let parsed: DriveServiceAccount;
  try {
    parsed = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(readFileSync(raw, 'utf8'));
  } catch {
    throw new HubError(KEY_INVALID);
  }
  if (!parsed.client_email || !parsed.private_key) throw new HubError(KEY_FIELDS);
  const privateKey = !parsed.private_key.includes('\n') && parsed.private_key.includes('\\n')
    ? parsed.private_key.replace(/\\n/g, '\n')
    : parsed.private_key;
  return { client_email: parsed.client_email, private_key: privateKey };
}

export async function presentDriveAccount(app: App, source?: DriveKeySource): Promise<DriveAccountStatus> {
  const record = await app.store.getMeta(DRIVE_ACCOUNT_META);
  const actorEmail = normalizeEmail(record?.actorEmail);
  const updatedBy = normalizeEmail(record?.updatedBy);
  const updatedAt = text(record?.updatedAt);
  let serviceAccountEmail = '';
  let keyConfigured = false;
  let keyError = '';
  if (driveKeyRaw(source)) {
    keyConfigured = true;
    try {
      serviceAccountEmail = loadDriveServiceAccount(source).client_email;
    } catch (error) {
      keyError = error instanceof Error ? error.message : KEY_INVALID;
    }
  }
  return {
    actorEmail,
    serviceAccountEmail,
    keyConfigured,
    keyError,
    updatedBy,
    updatedAt,
    ready: !!(keyConfigured && serviceAccountEmail && actorEmail && !keyError),
  };
}

export async function writeDriveActor(app: App, actorEmail: string, updatedBy: string): Promise<void> {
  const email = validateEmail(actorEmail, 'Google account');
  await app.store.setMeta(DRIVE_ACCOUNT_META, {
    actorEmail: email,
    updatedBy: normalizeEmail(updatedBy),
    updatedAt: nowIso(),
  });
}

export async function requireDriveActor(app: App, source?: DriveKeySource): Promise<{ actorEmail: string; serviceAccountEmail: string }> {
  const account = loadDriveServiceAccount(source);
  const record = await app.store.getMeta(DRIVE_ACCOUNT_META);
  const actorEmail = normalizeEmail(record?.actorEmail);
  if (!actorEmail) throw new HubError(MISSING_ACTOR);
  return { actorEmail, serviceAccountEmail: account.client_email };
}

export async function impersonatedAuth(actorEmail: string, source?: DriveKeySource) {
  const email = normalizeEmail(actorEmail);
  if (!email) throw new HubError(MISSING_ACTOR);
  const account = loadDriveServiceAccount(source);
  const { google } = await import('googleapis');
  return new google.auth.JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: [DRIVE_SCOPE],
    subject: email,
  });
}
