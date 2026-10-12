import { HubError, normalizeEmail } from './util';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function verifiedGoogleEmail(auth: unknown): string {
  const authData = asRecord(auth);
  if (!authData) throw new HubError('Sign in with Google to continue.');

  const token = asRecord(authData.token);
  const firebase = asRecord(token?.firebase);
  const email = normalizeEmail(token?.email);
  if (!token || !firebase || !email || token.email_verified !== true || firebase.sign_in_provider !== 'google.com') {
    throw new HubError('Use a verified Google account to continue.');
  }

  return email;
}