// Essay Doc comments join the student–supervisor chat.
// Opening the chat panel syncs one student's file with Drive's modified-time
// filter. That on-open sync is the incremental path. A daily 04:00
// Asia/Hong_Kong sweep is the safety net for pairs the open path missed.
// The sweep queries docCommentSync and does not list chat history.
// The school Google account reads comments. Students and staff do not consent.

import { ensureCohortChat } from './chat';
import { docCommentEntryId } from './chatPure';
import { presentDriveAccount } from './driveAccount';
import { parseDriveId, RECONNECT, WRONG_ACCOUNT } from './drive';
import {
  CommentPair,
  commentListArgs,
  docCommentSyncRecord,
  DOC_COMMENT_PAGE_CAP,
  DOC_COMMENT_SWEEP_LIMIT,
  dueCommentSyncRows,
  normalizeThreadRecord,
  pairRecordId,
  presentDocComment,
  PublicDocComment,
  RawDriveComment,
} from './docCommentsPure';
import { DRIVE_SCOPE, getGoogleAuth, GoogleOAuthSource } from './googleAuth';
import { findCurrentPlacement, findPlacement, listCohorts, staffStudentContext } from './roster';
import { COLLECTIONS } from './schema';
import { App, requireStaff, requireUser } from './session';
import { Doc, HubError, normalizeEmail, text } from './util';

const NEEDS_SCOPE = `The connected Google account is missing the Google Drive scope. An admin needs to grant ${DRIVE_SCOPE} and mint a new refresh token.`;
const COMMENT_ACCESS = 'The Google account assigned for Drive cannot read comments on this document.';
const COMMENT_FAILED = 'Doc comments could not be read.';

export interface CommentPage {
  comments: RawDriveComment[];
  complete: boolean;
}

export interface CommentDrive {
  aboutEmail(): Promise<string>;
  listComments(fileId: string, startModifiedTime: string): Promise<CommentPage>;
}

export interface DocCommentDeps {
  actorEmail?: string;
  keyConfigured?: boolean;
  oauth?: GoogleOAuthSource;
  driveForActor?: (actorEmail: string) => Promise<CommentDrive>;
  now?: Date;
  limit?: number;
}

export interface DocCommentSyncResult {
  ok: boolean;
  synced: boolean;
  incremental: boolean;
  cursor: string;
  fileId: string;
  docUrl: string;
  studentId: string;
  comments: PublicDocComment[];
  reason?: string;
  message?: string;
}

export interface DocCommentSweepResult {
  considered: number;
  synced: number;
  failed: number;
  skippedFresh: number;
  reason?: string;
}

interface SyncTarget {
  studentId: string;
  cohortId: string;
  fileId: string;
  docUrl: string;
}

interface CommentsApi {
  about: {
    get(args: { fields: string }): Promise<{ data: { user?: { emailAddress?: string | null } | null } }>;
  };
  comments: {
    list(args: Record<string, unknown>): Promise<{ data: { nextPageToken?: string | null; comments?: RawDriveComment[] | null } }>;
  };
}

function googleMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const details = error as { message?: string; response?: { data?: { error?: { message?: string } } } };
  return `${details.message || ''} ${details.response?.data?.error?.message || ''}`.trim();
}

function statusCode(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const details = error as { code?: number; response?: { status?: number } };
  return Number(details.response?.status || details.code || 0);
}

function isAuthFailure(error: unknown): boolean {
  return statusCode(error) === 401 || /invalid credentials|invalid authentication|unauthorized/i.test(googleMessage(error));
}

function isScopeFailure(error: unknown): boolean {
  return /insufficient authentication scopes|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(googleMessage(error));
}

function asHub(error: unknown, fallback: string): HubError {
  if (error instanceof HubError) return error;
  if (isScopeFailure(error)) return new HubError(NEEDS_SCOPE);
  if (isAuthFailure(error)) return new HubError(RECONNECT);
  return new HubError(fallback);
}

function isDriveAuthProblem(error: unknown): boolean {
  return error instanceof HubError && (error.message === RECONNECT || error.message === WRONG_ACCOUNT || error.message === NEEDS_SCOPE);
}

function accessMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message === COMMENT_ACCESS || message === COMMENT_FAILED) return message;
  const combined = `${message} ${googleMessage(error)}`;
  if (/access|permission|forbidden|403|not found|404/i.test(combined)) return COMMENT_ACCESS;
  return COMMENT_FAILED;
}

export function commentDriveFromApi(api: CommentsApi): CommentDrive {
  return {
    async aboutEmail() {
      try {
        const about = await api.about.get({ fields: 'user(emailAddress)' });
        return about.data.user?.emailAddress || '';
      } catch (error) {
        throw asHub(error, RECONNECT);
      }
    },
    async listComments(fileId, startModifiedTime) {
      const comments: RawDriveComment[] = [];
      let token = '';
      for (let page = 0; page < DOC_COMMENT_PAGE_CAP; page += 1) {
        let response: { data: { nextPageToken?: string | null; comments?: RawDriveComment[] | null } };
        try {
          response = await api.comments.list(commentListArgs(fileId, startModifiedTime, token));
        } catch (error) {
          throw asHub(error, accessMessage(error));
        }
        (response.data.comments || []).forEach((row) => { if (row) comments.push(row); });
        token = response.data.nextPageToken ? String(response.data.nextPageToken) : '';
        if (!token) return { comments, complete: true };
      }
      return { comments, complete: !token };
    },
  };
}

export async function commentDriveForActor(_actorEmail: string, source?: GoogleOAuthSource): Promise<CommentDrive> {
  const auth = await getGoogleAuth(source);
  const { google } = await import('googleapis');
  return commentDriveFromApi(google.drive({ version: 'v3', auth }) as unknown as CommentsApi);
}

async function assignedAccount(app: App, deps?: DocCommentDeps): Promise<{ actorEmail: string; ready: boolean }> {
  if (deps && (deps.actorEmail !== undefined || deps.keyConfigured !== undefined)) {
    const actorEmail = normalizeEmail(deps.actorEmail);
    const keyConfigured = deps.keyConfigured !== false;
    return { actorEmail, ready: keyConfigured && !!actorEmail };
  }
  const account = await presentDriveAccount(app, deps?.oauth);
  return { actorEmail: account.actorEmail, ready: account.ready };
}

async function prepareDrive(app: App, deps?: DocCommentDeps): Promise<{ drive: CommentDrive | null; reason: string; message: string }> {
  const account = await assignedAccount(app, deps);
  if (!account.ready) {
    return {
      drive: null,
      reason: 'config',
      message: 'Doc comments sync after an admin connects the Google account.',
    };
  }
  try {
    const drive = await (deps?.driveForActor || ((actorEmail: string) => commentDriveForActor(actorEmail, deps?.oauth)))(account.actorEmail);
    const owner = normalizeEmail(await drive.aboutEmail());
    if (!owner || owner !== account.actorEmail) {
      return { drive: null, reason: 'auth', message: owner ? WRONG_ACCOUNT : RECONNECT };
    }
    return { drive, reason: '', message: '' };
  } catch (error) {
    if (isDriveAuthProblem(error)) {
      return { drive: null, reason: 'auth', message: error instanceof Error ? error.message : RECONNECT };
    }
    return { drive: null, reason: 'access', message: accessMessage(error) };
  }
}

async function storedComments(app: App, target: SyncTarget): Promise<PublicDocComment[]> {
  if (typeof app.store.listChatEntries !== 'function') return [];
  const rows = await app.store.listChatEntries(target.cohortId, target.studentId);
  return rows
    .filter((row) => text(row.Kind) === 'doc-comment' && text(row.FileId) === target.fileId)
    .map((row) => presentDocComment(row))
    .filter((row): row is PublicDocComment => !!row)
    .sort((left, right) => left.at.localeCompare(right.at) || left.threadId.localeCompare(right.threadId));
}

async function readCursor(app: App, target: SyncTarget): Promise<string> {
  if (typeof app.store.getChat !== 'function') return '';
  const chat = await app.store.getChat(target.cohortId, target.studentId);
  return text(chat?.CommentCursor);
}

async function writeSyncIndex(app: App, target: SyncTarget, input: { lastSuccessAt: string; status: string; error: string; attempt: string }): Promise<void> {
  if (typeof app.store.set !== 'function') return;
  const record = docCommentSyncRecord({
    studentId: target.studentId,
    cohortId: target.cohortId,
    fileId: target.fileId,
    docUrl: target.docUrl,
    lastSuccessAt: input.lastSuccessAt,
    lastAttemptAt: input.attempt,
    status: input.status,
    error: input.error,
  });
  await app.store.set(COLLECTIONS.docCommentSync, text(record.Id), record);
}

async function writeCursor(app: App, target: SyncTarget, input: { lastSuccessAt: string; status: string; error: string; attempt: string }): Promise<void> {
  if (typeof app.store.getChat === 'function') {
    const chat = await app.store.getChat(target.cohortId, target.studentId);
    if (chat) {
      chat.DocFileId = target.fileId;
      chat.DocUrl = target.docUrl;
      chat.CommentCursor = input.lastSuccessAt;
      chat.CommentLastAttemptAt = input.attempt;
      chat.CommentSyncStatus = input.status;
      chat.CommentSyncError = text(input.error).slice(0, 300);
      await app.store.setChat(target.cohortId, target.studentId, chat);
    }
  }
  await writeSyncIndex(app, target, input);
}

function emptyResult(target: SyncTarget | null, extra: Partial<DocCommentSyncResult>): DocCommentSyncResult {
  return {
    ok: extra.ok !== undefined ? extra.ok : true,
    synced: false,
    incremental: false,
    cursor: extra.cursor || '',
    fileId: target?.fileId || '',
    docUrl: target?.docUrl || '',
    studentId: target?.studentId || '',
    comments: extra.comments || [],
    reason: extra.reason,
    message: extra.message,
  };
}

async function syncDriveComments(app: App, target: SyncTarget, drive: CommentDrive, now: Date): Promise<DocCommentSyncResult> {
  const started = now.toISOString();
  await ensureCohortChat(app, target.cohortId, target.studentId);
  const cursor = await readCursor(app, target);
  try {
    const listed = await drive.listComments(target.fileId, cursor);
    for (const comment of listed.comments) {
      const record = normalizeThreadRecord({
        fileId: target.fileId,
        studentId: target.studentId,
        cohortId: target.cohortId,
        docUrl: target.docUrl,
        comment,
      });
      if (!record) continue;
      const entryId = docCommentEntryId(target.fileId, text(record.ThreadId));
      await app.store.setChatEntry(target.cohortId, target.studentId, entryId, {
        ...record,
        EntryId: entryId,
        Kind: 'doc-comment',
        CommentId: text(record.ThreadId),
      });
    }
    if (!listed.complete) {
      await writeCursor(app, target, { lastSuccessAt: cursor, status: 'partial', error: 'Comment list was incomplete.', attempt: started });
      return emptyResult(target, {
        synced: false,
        incremental: !!cursor,
        cursor,
        reason: 'partial',
        message: 'Comment list was incomplete.',
      });
    }
    await writeCursor(app, target, { lastSuccessAt: started, status: 'ok', error: '', attempt: started });
    return {
      ok: true,
      synced: true,
      incremental: !!cursor,
      cursor: started,
      fileId: target.fileId,
      docUrl: target.docUrl,
      studentId: target.studentId,
      comments: [],
    };
  } catch (error) {
    const message = accessMessage(error);
    await writeCursor(app, target, { lastSuccessAt: cursor, status: 'error', error: message, attempt: started });
    return emptyResult(target, {
      ok: false,
      incremental: !!cursor,
      cursor,
      reason: isDriveAuthProblem(error) ? 'auth' : 'access',
      message,
    });
  }
}

async function syncTarget(app: App, target: SyncTarget, drive: CommentDrive, now: Date): Promise<DocCommentSyncResult> {
  const result = await syncDriveComments(app, target, drive, now);
  return { ...result, comments: await storedComments(app, target) };
}

async function resolveTarget(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown): Promise<SyncTarget> {
  const user = await requireUser(app, 'SYNC_DOC_COMMENTS');
  if (user.role === 'student') {
    const placement = await findCurrentPlacement(app, user.email);
    const docUrl = placement?.doc || '';
    return {
      studentId: user.email,
      cohortId: placement?.cohortId || '',
      fileId: parseDriveId(docUrl),
      docUrl,
    };
  }
  const staff = await requireStaff(app, 'SYNC_DOC_COMMENTS');
  let email = normalizeEmail(studentEmail);
  let cohort = text(cohortId);
  if (!email) throw new HubError('Student is not in the selected cohort.');
  if (!cohort) {
    const placement = await findPlacement(app, email);
    if (!placement) throw new HubError('Student is not in the selected cohort.');
    cohort = placement.cohortId;
  }
  const context = await staffStudentContext(app, staff, email, cohort, 'SYNC_DOC_COMMENTS', viewAs);
  const docUrl = context.roster.doc || '';
  return {
    studentId: context.email,
    cohortId: cohort,
    fileId: parseDriveId(docUrl),
    docUrl,
  };
}

export async function syncEssayDocComments(app: App, studentEmail?: unknown, cohortId?: unknown, viewAs?: unknown, deps?: DocCommentDeps): Promise<DocCommentSyncResult> {
  const target = await resolveTarget(app, studentEmail, cohortId, viewAs);
  if (!target.fileId) {
    return emptyResult(target, { reason: 'missing', message: 'This student has no essay Google Doc yet.', comments: [] });
  }
  await ensureCohortChat(app, target.cohortId, target.studentId);
  const prepared = await prepareDrive(app, deps);
  if (!prepared.drive) {
    return emptyResult(target, {
      ok: prepared.reason === 'config',
      reason: prepared.reason,
      message: prepared.message,
      cursor: await readCursor(app, target),
      comments: await storedComments(app, target),
    });
  }
  return syncTarget(app, target, prepared.drive, deps?.now || new Date());
}

const SYNC_BACKFILL_META = 'docCommentSyncBackfill';

function cursorFromChat(chat: Doc | null, fileId: string): { lastSuccessAt: string; lastAttemptAt: string; status: string; error: string } {
  const empty = { lastSuccessAt: '', lastAttemptAt: '', status: '', error: '' };
  if (!chat) return empty;
  const chatFile = text(chat.DocFileId);
  if (chatFile && chatFile !== fileId) return empty;
  return {
    lastSuccessAt: text(chat.CommentCursor),
    lastAttemptAt: text(chat.CommentLastAttemptAt),
    status: text(chat.CommentSyncStatus),
    error: text(chat.CommentSyncError),
  };
}

/** One-time copy of chat cursors into docCommentSync. Later sweeps query due rows only. */
async function ensureSyncIndex(app: App, now: Date): Promise<void> {
  if (typeof app.store.getMeta !== 'function' || typeof app.store.setMeta !== 'function') return;
  const meta = await app.store.getMeta(SYNC_BACKFILL_META);
  if (meta?.complete === true) return;
  const cohorts = await listCohorts(app, false);
  for (const cohort of cohorts) {
    const members = await app.store.listMembers(cohort.id);
    for (const member of members) {
      const studentId = normalizeEmail(member.StudentId);
      const docUrl = text(member.EEDoc);
      const fileId = parseDriveId(docUrl);
      if (!studentId || !fileId || typeof app.store.set !== 'function') continue;
      const id = pairRecordId(studentId, fileId);
      const existing = typeof app.store.get === 'function' ? await app.store.get(COLLECTIONS.docCommentSync, id) : null;
      const chat = typeof app.store.getChat === 'function' ? await app.store.getChat(cohort.id, studentId) : null;
      const fromChat = cursorFromChat(chat, fileId);
      if (existing && typeof existing.DueAt === 'number' && (text(existing.LastSuccessAt) || !fromChat.lastSuccessAt)) continue;
      await app.store.set(COLLECTIONS.docCommentSync, id, docCommentSyncRecord({
        studentId,
        cohortId: cohort.id,
        fileId,
        docUrl,
        lastSuccessAt: fromChat.lastSuccessAt || text(existing?.LastSuccessAt),
        lastAttemptAt: fromChat.lastAttemptAt || text(existing?.LastAttemptAt),
        status: fromChat.status || text(existing?.Status),
        error: fromChat.error || text(existing?.Error),
      }));
    }
  }
  await app.store.setMeta(SYNC_BACKFILL_META, { complete: true, at: now.toISOString() });
}

async function dueIndexRows(app: App, nowMs: number, limit: number): Promise<Doc[]> {
  if (typeof app.store.listDueDocCommentSync === 'function') {
    try {
      return await app.store.listDueDocCommentSync(nowMs, limit);
    } catch (error) {
      console.warn('docCommentSweep due query failed; reading the sync index without the composite order.', error);
    }
  }
  if (typeof app.store.list !== 'function') return [];
  return dueCommentSyncRows(await app.store.list(COLLECTIONS.docCommentSync), nowMs, limit);
}

async function freshIndexCount(app: App, nowMs: number): Promise<number> {
  if (typeof app.store.countFreshDocCommentSync === 'function') {
    try {
      return await app.store.countFreshDocCommentSync(nowMs);
    } catch (error) {
      console.warn('docCommentSweep fresh count failed; counting the sync index in memory.', error);
    }
  }
  if (typeof app.store.list !== 'function') return 0;
  const rows = await app.store.list(COLLECTIONS.docCommentSync);
  return rows.filter((row) => typeof row.DueAt === 'number' && row.DueAt > nowMs).length;
}

async function liveDuePairs(app: App, rows: Doc[]): Promise<CommentPair[]> {
  const active = new Set((await listCohorts(app, false)).map((cohort) => cohort.id));
  const stale: CommentPair[] = [];
  for (const row of rows) {
    const studentId = normalizeEmail(row.StudentId);
    const cohortId = text(row.Cohort);
    const id = text(row.Id) || pairRecordId(studentId, text(row.FileId));
    if (!active.has(cohortId)) {
      if (id && typeof app.store.remove === 'function') await app.store.remove(COLLECTIONS.docCommentSync, id);
      continue;
    }
    const member = await app.store.getMember(cohortId, studentId);
    const docUrl = text(member?.EEDoc);
    const fileId = parseDriveId(docUrl);
    if (!member || !fileId || fileId !== text(row.FileId)) {
      if (id && typeof app.store.remove === 'function') await app.store.remove(COLLECTIONS.docCommentSync, id);
      continue;
    }
    stale.push({
      studentId,
      cohortId,
      fileId,
      docUrl,
      lastSuccessAt: text(row.LastSuccessAt),
      lastAttemptAt: text(row.LastAttemptAt),
    });
  }
  return stale;
}

export async function runDocCommentSweep(app: App, deps?: DocCommentDeps): Promise<DocCommentSweepResult> {
  const now = deps?.now || new Date();
  const limit = deps?.limit === undefined ? DOC_COMMENT_SWEEP_LIMIT : deps.limit;
  await ensureSyncIndex(app, now);
  const due = await dueIndexRows(app, now.getTime(), limit);
  const fresh = await freshIndexCount(app, now.getTime());
  const stale = await liveDuePairs(app, due);
  if (!stale.length) {
    return { considered: 0, synced: 0, failed: 0, skippedFresh: fresh };
  }
  const prepared = await prepareDrive(app, deps);
  if (!prepared.drive) {
    return { considered: 0, synced: 0, failed: 0, skippedFresh: fresh, reason: prepared.reason };
  }
  let synced = 0;
  let failed = 0;
  for (const pair of stale) {
    const result = await syncDriveComments(app, pair, prepared.drive, now);
    if (result.synced) synced += 1;
    else failed += 1;
  }
  return { considered: stale.length, synced, failed, skippedFresh: fresh };
}
