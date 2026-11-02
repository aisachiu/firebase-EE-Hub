// One stored row per Drive comment thread. Replies stay inside that row.
// Chat reads the row as a single card. Drive's startModifiedTime is the
// cursor from the last successful sync, so a later open is not a full rescan.

import { Doc, normalizeEmail, text, toBoolean } from './util';

export const DOC_COMMENT_STALE_MS = 30 * 60 * 1000;
export const DOC_COMMENT_SWEEP_LIMIT = 40;
export const DOC_COMMENT_PAGE_SIZE = 100;
export const DOC_COMMENT_PAGE_CAP = 10;

const BODY_LIMIT = 4000;
const REPLY_STORE_LIMIT = 30;
const REPLY_CARD_LIMIT = 3;

export const COMMENT_FIELDS = 'nextPageToken,comments(id,createdTime,modifiedTime,deleted,resolved,content,anchor,quotedFileContent(value),author(displayName,emailAddress),replies(id,createdTime,modifiedTime,deleted,content,author(displayName,emailAddress)))';

export interface RawDriveReply {
  id?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  deleted?: boolean | null;
  content?: string | null;
  author?: { displayName?: string | null; emailAddress?: string | null } | null;
}

export interface RawDriveComment {
  id?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  deleted?: boolean | null;
  resolved?: boolean | null;
  content?: string | null;
  anchor?: string | null;
  quotedFileContent?: { value?: string | null } | null;
  author?: { displayName?: string | null; emailAddress?: string | null } | null;
  replies?: RawDriveReply[] | null;
}

export interface StoredReply {
  author: string;
  authorEmail: string;
  at: string;
  body: string;
}

export interface PublicDocComment {
  threadId: string;
  fileId: string;
  author: string;
  authorEmail: string;
  at: string;
  createdAt: string;
  quote: string;
  body: string;
  replyCount: number;
  replies: Array<{ author: string; at: string; body: string }>;
  docUrl: string;
  commentId: string;
  resolved: boolean;
}

export interface CommentPair {
  studentId: string;
  cohortId: string;
  fileId: string;
  docUrl: string;
  lastSuccessAt: string;
  lastAttemptAt?: string;
}

export function threadRecordId(fileId: string, threadId: string): string {
  return `${text(fileId)}__${text(threadId)}`;
}

export function pairRecordId(studentId: string, fileId: string): string {
  return `${normalizeEmail(studentId)}__${text(fileId)}`;
}

/** Omit startModifiedTime on the first sync. Later syncs pass the last success time. */
export function commentListArgs(fileId: string, startModifiedTime: string, pageToken = ''): Record<string, unknown> {
  const args: Record<string, unknown> = {
    fileId: text(fileId),
    pageSize: DOC_COMMENT_PAGE_SIZE,
    includeDeleted: true,
    fields: COMMENT_FIELDS,
  };
  const cursor = text(startModifiedTime);
  if (cursor) args.startModifiedTime = cursor;
  const token = text(pageToken);
  if (token) args.pageToken = token;
  return args;
}

export function commentSyncIsStale(lastSuccessAt: string, now: Date, staleMs = DOC_COMMENT_STALE_MS): boolean {
  const stamp = text(lastSuccessAt);
  if (!stamp) return true;
  const parsed = Date.parse(stamp);
  if (Number.isNaN(parsed)) return true;
  return now.getTime() - parsed >= staleMs;
}

export function staleCommentPairs(pairs: CommentPair[], now: Date, limit = DOC_COMMENT_SWEEP_LIMIT, staleMs = DOC_COMMENT_STALE_MS): { stale: CommentPair[]; fresh: number } {
  const stale = pairs.filter((pair) => pair.fileId && pair.studentId && commentSyncIsStale(pair.lastSuccessAt, now, staleMs));
  // Oldest attempt first, so a file that just failed does not block the rest.
  stale.sort((left, right) => text(left.lastAttemptAt).localeCompare(text(right.lastAttemptAt)) || text(left.lastSuccessAt).localeCompare(text(right.lastSuccessAt)) || left.studentId.localeCompare(right.studentId));
  const cap = Math.max(0, limit);
  return { stale: stale.slice(0, cap), fresh: pairs.length - stale.length };
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

export function normalizeReplies(replies: RawDriveReply[]): StoredReply[] {
  const rows: StoredReply[] = [];
  (replies || []).forEach((reply) => {
    if (!reply || reply.deleted) return;
    const body = clip(text(reply.content), BODY_LIMIT);
    const author = text(reply.author?.displayName);
    const authorEmail = normalizeEmail(reply.author?.emailAddress);
    if (!body && !author && !authorEmail) return;
    rows.push({
      author,
      authorEmail,
      at: text(reply.modifiedTime) || text(reply.createdTime),
      body,
    });
  });
  rows.sort((left, right) => left.at.localeCompare(right.at) || left.author.localeCompare(right.author));
  return rows;
}

/** Anchor comment plus its replies, keyed later by file id and thread id. */
export function normalizeThreadRecord(input: {
  fileId: string;
  studentId: string;
  cohortId: string;
  docUrl: string;
  comment: RawDriveComment;
}): Doc | null {
  const threadId = text(input.comment?.id);
  const fileId = text(input.fileId);
  if (!threadId || !fileId) return null;
  const replies = normalizeReplies(input.comment.replies || []);
  const stored = replies.slice(-REPLY_STORE_LIMIT);
  return {
    Id: threadRecordId(fileId, threadId),
    FileId: fileId,
    ThreadId: threadId,
    StudentId: normalizeEmail(input.studentId),
    Cohort: text(input.cohortId),
    AuthorName: text(input.comment.author?.displayName),
    AuthorEmail: normalizeEmail(input.comment.author?.emailAddress),
    CreatedAt: text(input.comment.createdTime),
    ModifiedAt: text(input.comment.modifiedTime) || text(input.comment.createdTime),
    Quote: clip(text(input.comment.quotedFileContent?.value), BODY_LIMIT),
    Body: clip(text(input.comment.content), BODY_LIMIT),
    ReplyCount: replies.length,
    RepliesJson: JSON.stringify(stored),
    DocUrl: text(input.docUrl),
    Deleted: !!input.comment.deleted,
    Resolved: !!input.comment.resolved,
  };
}

export function storedReplies(record: Doc): StoredReply[] {
  const raw = text(record?.RepliesJson);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((reply) => ({
      author: text(reply?.author),
      authorEmail: normalizeEmail(reply?.authorEmail),
      at: text(reply?.at),
      body: text(reply?.body),
    })).filter((reply) => reply.body || reply.author || reply.authorEmail);
  } catch {
    return [];
  }
}

export function presentDocComment(record: Doc): PublicDocComment | null {
  if (!record || toBoolean(record.Deleted)) return null;
  const threadId = text(record.ThreadId);
  const fileId = text(record.FileId);
  if (!threadId || !fileId) return null;
  const replies = storedReplies(record);
  const shown = replies.slice(-REPLY_CARD_LIMIT);
  return {
    threadId,
    fileId,
    author: text(record.AuthorName) || text(record.AuthorEmail) || 'Comment',
    authorEmail: normalizeEmail(record.AuthorEmail),
    at: text(record.ModifiedAt) || text(record.CreatedAt),
    createdAt: text(record.CreatedAt),
    quote: text(record.Quote),
    body: text(record.Body),
    replyCount: Number(record.ReplyCount) || replies.length,
    replies: shown.map((reply) => ({ author: reply.author || reply.authorEmail || 'Reply', at: reply.at, body: reply.body })),
    docUrl: text(record.DocUrl),
    commentId: threadId,
    resolved: toBoolean(record.Resolved),
  };
}
