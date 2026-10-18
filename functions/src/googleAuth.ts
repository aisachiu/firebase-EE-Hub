// One school Google account, signed in with an OAuth refresh token.
// Drive folders, Sheets export, and Gmail send all use this client.
// Students and staff are never asked to consent.
// The client id, client secret, and refresh token are Secret Manager values.
// EE_TIMEZONE stays a normal environment variable.

import { defineSecret } from 'firebase-functions/params';
import { HubError, normalizeEmail, text } from './util';

type OAuthSecret = ReturnType<typeof defineSecret>;

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GOOGLE_SCOPES = [DRIVE_SCOPE, SHEETS_SCOPE, GMAIL_SEND_SCOPE];

export const OAUTH_CLIENT_ID = 'EE_GOOGLE_OAUTH_CLIENT_ID';
export const OAUTH_CLIENT_SECRET = 'EE_GOOGLE_OAUTH_CLIENT_SECRET';
export const OAUTH_REFRESH_TOKEN = 'EE_GOOGLE_OAUTH_REFRESH_TOKEN';
export const OAUTH_REDIRECT_URI = 'EE_GOOGLE_OAUTH_REDIRECT_URI';
export const DEFAULT_OAUTH_REDIRECT = 'http://127.0.0.1:8765/oauth/callback';

export const GOOGLE_NOT_CONFIGURED = `Google is not connected. Set ${OAUTH_CLIENT_ID}, ${OAUTH_CLIENT_SECRET}, and ${OAUTH_REFRESH_TOKEN}.`;
export const GOOGLE_AUTH_REJECTED = 'Google rejected the connected account. Check the OAuth client and refresh token.';
export const TOKEN_EMAIL_UNKNOWN = 'The connected Google account did not return an email address.';

export const googleOAuthClientId = defineSecret(OAUTH_CLIENT_ID);
export const googleOAuthClientSecret = defineSecret(OAUTH_CLIENT_SECRET);
export const googleOAuthRefreshToken = defineSecret(OAUTH_REFRESH_TOKEN);
export const googleOAuthSecrets: OAuthSecret[] = [
  googleOAuthClientId,
  googleOAuthClientSecret,
  googleOAuthRefreshToken,
];

const LEGACY_ENVS = ['EE_DRIVE_SERVICE_ACCOUNT_JSON', 'EE_GMAIL_SERVICE_ACCOUNT_JSON', 'EE_GMAIL_SENDER'];

export interface GoogleOAuthSource {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  redirectUri?: string;
}

export interface GoogleOAuthParts {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
  missing: string[];
}

export function legacyOAuthNote(): string {
  const set = LEGACY_ENVS.filter((name) => text(process.env[name]));
  if (!set.length) return '';
  const verb = set.length === 1 ? 'is' : 'are';
  return `${set.join(', ')} ${verb} no longer used. Domain-wide delegation is not required.`;
}

export function googleNotConfiguredMessage(): string {
  const legacy = legacyOAuthNote();
  return legacy ? `${GOOGLE_NOT_CONFIGURED} ${legacy}` : GOOGLE_NOT_CONFIGURED;
}

// Prefer the bound secret. .value() throws while Firebase loads the function
// for deploy, and returns an empty string when the secret is not mounted.
// The emulator can still supply process.env.
function readOAuthSecret(secret: OAuthSecret, name: string): string {
  try {
    const bound = text(secret.value());
    if (bound) return bound;
  } catch {
    // Unit tests and the emulator do not have the secret mounted.
  }
  return text(process.env[name]);
}

function runtimeGoogleOAuth(): GoogleOAuthSource {
  return {
    clientId: readOAuthSecret(googleOAuthClientId, OAUTH_CLIENT_ID),
    clientSecret: readOAuthSecret(googleOAuthClientSecret, OAUTH_CLIENT_SECRET),
    refreshToken: readOAuthSecret(googleOAuthRefreshToken, OAUTH_REFRESH_TOKEN),
    redirectUri: text(process.env[OAUTH_REDIRECT_URI]),
  };
}

export function googleOAuthParts(source?: GoogleOAuthSource): GoogleOAuthParts {
  const resolved = source !== undefined ? source : runtimeGoogleOAuth();
  const clientId = text(resolved.clientId);
  const clientSecret = text(resolved.clientSecret);
  const refreshToken = text(resolved.refreshToken);
  const redirectUri = text(resolved.redirectUri) || DEFAULT_OAUTH_REDIRECT;
  const missing: string[] = [];
  if (!clientId) missing.push(OAUTH_CLIENT_ID);
  if (!clientSecret) missing.push(OAUTH_CLIENT_SECRET);
  if (!refreshToken) missing.push(OAUTH_REFRESH_TOKEN);
  return { clientId, clientSecret, refreshToken, redirectUri, missing };
}

export function googleOAuthConfigured(source?: GoogleOAuthSource): boolean {
  return googleOAuthParts(source).missing.length === 0;
}

export function loadGoogleOAuth(source?: GoogleOAuthSource): GoogleOAuthParts {
  const parts = googleOAuthParts(source);
  if (parts.missing.length) {
    const listed = parts.missing.join(', ');
    const legacy = legacyOAuthNote();
    const message = `Google is not connected. Set ${listed}.`;
    throw new HubError(legacy ? `${message} ${legacy}` : message);
  }
  return parts;
}

export function googleConsentUrl(source?: GoogleOAuthSource): string {
  const parts = googleOAuthParts(source);
  if (!parts.clientId) return '';
  const params = new URLSearchParams({
    client_id: parts.clientId,
    redirect_uri: parts.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES.join(' '),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function getGoogleAuth(source?: GoogleOAuthSource) {
  const parts = loadGoogleOAuth(source);
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(parts.clientId, parts.clientSecret, parts.redirectUri);
  auth.setCredentials({ refresh_token: parts.refreshToken });
  return auth;
}

export async function connectedEmail(auth?: Awaited<ReturnType<typeof getGoogleAuth>>, source?: GoogleOAuthSource): Promise<string> {
  const client = auth || await getGoogleAuth(source);
  const { google } = await import('googleapis');
  try {
    const about = await google.drive({ version: 'v3', auth: client }).about.get({ fields: 'user(emailAddress)' });
    const email = normalizeEmail(about.data.user?.emailAddress);
    if (!email) throw new HubError(TOKEN_EMAIL_UNKNOWN);
    return email;
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError(GOOGLE_AUTH_REJECTED);
  }
}
