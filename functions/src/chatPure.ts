import { presentDocComment } from './docCommentsPure';
import { Doc, normalizeEmail, text, toBoolean } from './util';

export interface ChatEntryView {
  entryId: string;
  kind: 'chat' | 'doc-comment';
  authorEmail: string;
  authorRole: string;
  authorName: string;
  body: string;
  createdAt: string;
  at: string;
  quote: string;
  replyCount: number;
  replies: Array<{ author: string; at: string; body: string }>;
  docUrl: string;
  commentId: string;
  fileId: string;
  resolved: boolean;
}

export function docCommentEntryId(fileId: string, threadId: string): string {
  return `doc__${text(fileId)}__${text(threadId)}`;
}

export function legacyDocEntryId(ticketId: string): string {
  return `legacy__${text(ticketId)}`;
}

export function isDocCommentCategory(category: unknown): boolean {
  return /doc(ument)? comment/i.test(text(category));
}

export function uniqueEmails(values: unknown[]): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  values.forEach((value) => {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) return;
    seen.add(email);
    emails.push(email);
  });
  return emails;
}

export function emailsOf(value: unknown): string[] {
  return Array.isArray(value) ? uniqueEmails(value) : [];
}

export type ChatAuthorKind = 'student' | 'supervisor' | 'lead' | 'coordinator';

/** People who should open the chat after this post. The author is left off. */
export function unreadAfterPost(author: ChatAuthorKind, studentId: string, supervisorId: string, leadId: string): string[] {
  const student = normalizeEmail(studentId);
  const supervisor = normalizeEmail(supervisorId);
  const lead = normalizeEmail(leadId);
  if (author === 'student') return uniqueEmails([supervisor, lead]);
  if (author === 'supervisor') return uniqueEmails([student]);
  if (author === 'lead') return uniqueEmails([student, supervisor]);
  return uniqueEmails([student, supervisor, lead]);
}

/** Move attention from one person to another. An empty replacement drops the old email. */
export function swapUnread(unread: string[], from: string, to: string): string[] {
  const source = normalizeEmail(from);
  const target = normalizeEmail(to);
  if (!source || source === target) return uniqueEmails(unread);
  return uniqueEmails(unread.map((email) => (email === source ? target : email)));
}

export function presentChatEntry(record: Doc, names: Record<string, string>, studentName: string): ChatEntryView | null {
  if (!record) return null;
  const kind = text(record.Kind) === 'doc-comment' ? 'doc-comment' : 'chat';
  if (kind === 'doc-comment') {
    if (toBoolean(record.Deleted)) return null;
    const drive = text(record.FileId) && text(record.ThreadId) ? presentDocComment(record) : null;
    const authorEmail = normalizeEmail(record.AuthorEmail);
    const authorName = text(record.AuthorName) || (drive ? drive.author : '') || names[authorEmail] || authorEmail || 'Comment';
    return {
      entryId: text(record.EntryId),
      kind,
      authorEmail,
      authorRole: '',
      authorName,
      body: drive ? drive.body : text(record.Body),
      createdAt: text(record.CreatedAt),
      at: text(record.ModifiedAt) || text(record.CreatedAt),
      quote: drive ? drive.quote : text(record.Quote),
      replyCount: drive ? drive.replyCount : Number(record.ReplyCount) || 0,
      replies: drive ? drive.replies : [],
      docUrl: text(record.DocUrl),
      commentId: text(record.CommentId) || text(record.ThreadId),
      fileId: text(record.FileId),
      resolved: toBoolean(record.Resolved),
    };
  }
  const authorEmail = normalizeEmail(record.AuthorEmail);
  const authorRole = text(record.AuthorRole) || 'staff';
  const storedName = text(record.AuthorName);
  const authorName = storedName || (authorRole === 'student' ? (studentName || authorEmail || 'Student') : (names[authorEmail] || authorEmail || 'Staff'));
  return {
    entryId: text(record.EntryId),
    kind,
    authorEmail,
    authorRole,
    authorName,
    body: text(record.Body),
    createdAt: text(record.CreatedAt),
    at: text(record.CreatedAt),
    quote: '',
    replyCount: 0,
    replies: [],
    docUrl: '',
    commentId: '',
    fileId: '',
    resolved: false,
  };
}
