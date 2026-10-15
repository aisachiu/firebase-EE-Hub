import { readFileSync } from 'node:fs';
import { HubError, normalizeEmail, text } from './util';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export interface OutboundMail {
  to: string[];
  subject: string;
  body: string;
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export function gmailSender(): string {
  return normalizeEmail(process.env.EE_GMAIL_SENDER);
}

export function gmailConfigured(): boolean {
  return !!gmailSender() && !!text(process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON);
}

export function loadGmailAccount(): ServiceAccount {
  const raw = text(process.env.EE_GMAIL_SERVICE_ACCOUNT_JSON);
  if (!raw) throw new HubError('Gmail is not configured. Set EE_GMAIL_SENDER and EE_GMAIL_SERVICE_ACCOUNT_JSON.');
  let parsed: ServiceAccount;
  try {
    parsed = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(readFileSync(raw, 'utf8'));
  } catch {
    throw new HubError('EE_GMAIL_SERVICE_ACCOUNT_JSON must be service-account JSON or a path to that file.');
  }
  if (!parsed.client_email || !parsed.private_key) throw new HubError('The Gmail service account JSON needs client_email and private_key.');
  if (!parsed.private_key.includes('\n') && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
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

export async function createGmailMailer(): Promise<Mailer> {
  const sender = gmailSender();
  if (!sender) throw new HubError('Gmail is not configured. Set EE_GMAIL_SENDER and EE_GMAIL_SERVICE_ACCOUNT_JSON.');
  const account = loadGmailAccount();
  const { google } = await import('googleapis');
  const auth = new google.auth.JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: [GMAIL_SEND_SCOPE],
    subject: sender,
  });
  const gmail = google.gmail({ version: 'v1', auth });
  return {
    async send(mail: OutboundMail): Promise<void> {
      const raw = buildRawMessage(sender, mail);
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    },
  };
}
