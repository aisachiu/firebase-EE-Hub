import { connectedEmail, GMAIL_SEND_SCOPE, getGoogleAuth, googleOAuthConfigured, GoogleOAuthSource, legacyOAuthNote } from './googleAuth';
import { HubError, normalizeEmail } from './util';

export const GMAIL_NOT_CONFIGURED = 'Gmail is not configured. Set EE_GOOGLE_OAUTH_CLIENT_ID, EE_GOOGLE_OAUTH_CLIENT_SECRET, and EE_GOOGLE_OAUTH_REFRESH_TOKEN.';

export interface OutboundMail {
  to: string[];
  subject: string;
  body: string;
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
}

interface GmailSendClient {
  users: {
    messages: {
      send(args: { userId: string; requestBody: { raw: string } }): Promise<unknown>;
    };
  };
}

export interface GmailMailerDeps {
  source?: GoogleOAuthSource;
  sender?: string;
  gmail?: GmailSendClient;
}

export function gmailConfigured(source?: GoogleOAuthSource): boolean {
  return googleOAuthConfigured(source);
}

export function gmailNotConfiguredMessage(): string {
  const legacy = legacyOAuthNote();
  return legacy ? `${GMAIL_NOT_CONFIGURED} ${legacy}` : GMAIL_NOT_CONFIGURED;
}

export function sanitizeHeader(value: string): string {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

export function buildRawMessage(from: string, mail: OutboundMail): string {
  const sender = sanitizeHeader(from);
  const to = mail.to.map((email) => sanitizeHeader(email)).filter(Boolean);
  if (!sender || !to.length) throw new HubError('A sender and at least one recipient are required.');
  const subject = sanitizeHeader(mail.subject) || 'EE Hub reminder';
  const encodedSubject = /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const body = String(mail.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  const message = [
    `From: ${sender}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

export async function createGmailMailer(deps?: GmailMailerDeps): Promise<Mailer> {
  if (!deps?.gmail && !gmailConfigured(deps?.source)) throw new HubError(gmailNotConfiguredMessage());
  const auth = deps?.gmail ? null : await getGoogleAuth(deps?.source);
  let sender = normalizeEmail(deps?.sender);
  if (!sender) sender = await connectedEmail(auth || undefined, deps?.source);
  if (!sender) throw new HubError(gmailNotConfiguredMessage());
  const gmail = deps?.gmail || await gmailClient(auth);
  return {
    async send(mail: OutboundMail): Promise<void> {
      const raw = buildRawMessage(sender, mail);
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    },
  };
}

async function gmailClient(auth: unknown): Promise<GmailSendClient> {
  const { google } = await import('googleapis');
  return google.gmail({ version: 'v1', auth: auth as never });
}

export { GMAIL_SEND_SCOPE };
