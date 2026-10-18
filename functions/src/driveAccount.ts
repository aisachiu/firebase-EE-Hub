// The Google account that creates Drive folders, reads essay history,
// exports Sheets, and sends reminder mail. The refresh token stays in
// Secret Manager. Firestore stores only the mailbox confirmed from that token.

import type { App } from './session';
import {
  connectedEmail,
  googleConsentUrl,
  GOOGLE_SCOPES,
  googleNotConfiguredMessage,
  googleOAuthParts,
  GoogleOAuthSource,
  legacyOAuthNote,
  loadGoogleOAuth,
} from './googleAuth';
import { HubError, normalizeEmail, nowIso, text, validateEmail } from './util';

export const DRIVE_ACCOUNT_META = 'driveAccount';

export const MISSING_ACTOR = 'Connect Google in Admin → Google account. Drive, Sheets, and Gmail use that one mailbox.';
export const ESSAY_DRIVE_UNAVAILABLE = 'Word count and edit history are not available until an admin connects the Google account in Admin → Google account.';
export const ESSAY_DRIVE_NOT_CONFIGURED = 'Word count and edit history are not available until Google is configured for the assigned account.';

export interface DriveAccountStatus {
  actorEmail: string;
  configured: boolean;
  confirmed: boolean;
  ready: boolean;
  missing: string[];
  error: string;
  consentUrl: string;
  scopes: string[];
  legacyNote: string;
  updatedBy: string;
  updatedAt: string;
}

export async function presentDriveAccount(app: App, source?: GoogleOAuthSource): Promise<DriveAccountStatus> {
  const record = await app.store.getMeta(DRIVE_ACCOUNT_META);
  const actorEmail = normalizeEmail(record?.actorEmail);
  const updatedBy = normalizeEmail(record?.updatedBy);
  const updatedAt = text(record?.updatedAt);
  const parts = googleOAuthParts(source);
  const configured = parts.missing.length === 0;
  const legacyNote = legacyOAuthNote();
  const error = configured ? '' : (parts.missing.length === 3 ? googleNotConfiguredMessage() : `Google is not connected. Set ${parts.missing.join(', ')}.${legacyNote ? ` ${legacyNote}` : ''}`);
  return {
    actorEmail,
    configured,
    confirmed: configured && !!actorEmail,
    ready: configured,
    missing: parts.missing,
    error,
    consentUrl: googleConsentUrl(source),
    scopes: [...GOOGLE_SCOPES],
    legacyNote,
    updatedBy,
    updatedAt,
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

export async function requireDriveActor(
  app: App,
  source?: GoogleOAuthSource,
  lookup?: () => Promise<string>,
): Promise<{ actorEmail: string }> {
  loadGoogleOAuth(source);
  const cached = normalizeEmail((await app.store.getMeta(DRIVE_ACCOUNT_META))?.actorEmail);
  if (cached) return { actorEmail: cached };
  const email = normalizeEmail(await (lookup || (() => connectedEmail(undefined, source)))());
  if (!email) throw new HubError(MISSING_ACTOR);
  return { actorEmail: email };
}

