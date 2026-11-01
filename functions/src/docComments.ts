// Essay Doc comments join the student–supervisor chat.
// Opening the chat panel syncs one student's file with Drive's modified-time
// filter. A half-hourly sweep retries pairs that open path missed.
// The school Google account reads comments. Students and staff do not consent.

import { presentDriveAccount } from './driveAccount';
import { parseDriveId, RECONNECT, WRONG_ACCOUNT } from './drive';
import {
  CommentPair,
  commentListArgs,
  DOC_COMMENT_PAGE_CAP,
  DOC_COMMENT_SWEEP_LIMIT,
  normalizeThreadRecord,
  pairRecordId,
  presentDocComment,
  PublicDocComment,
  RawDriveComment,
  staleCommentPairs,
  threadRecordId,
} from './docCommentsPure';
import { DRIVE_SCOPE, getGoogleAuth, GoogleOAuthSource } from './googleAuth';
import { findPlacement, listCohorts, staffStudentContext } from './roster';
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
  const rows = await app.store.whereEqual(COLLECTIONS.docCommentThreads, 'StudentId', target.studentId);
  return rows
    .filter((row) => text(row.FileId) === target.fileId)
    .map((row) => presentDocComment(row))
    .filter((row): row is PublicDocComment => !!row)
    .sort((left, right) => left.at.localeCompare(right.at) || left.threadId.localeCompare(right.threadId));
}

async function readCursor(app: App, target: SyncTarget): Promise<Doc | null> {
  return app.store.get(COLLECTIONS.docCommentSync, pairRecordId(target.studentId, target.fileId));
}

async function writeCursor(app: App, target: SyncTarget, input: { lastSuccessAt: string; status: string; error: string; attempt: string }): Promise<void> {
  await app.store.set(COLLECTIONS.docCommentSync, pairRecordId(target.studentId, target.fileId), {
    Id: pairRecordId(target.studentId, target.fileId),
    StudentId: target.studentId,
    FileId: target.fileId,
    Cohort: target.cohortId,
    DocUrl: target.docUrl,
    LastSuccessAt: input.lastSuccessAt,
    LastAttemptAt: input.attempt,
    Status: input.status,
    Error: text(input.error).slice(0, 300),
  });
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

async function syncTarget(app: App, target: SyncTarget, drive: CommentDrive, now: Date): Promise<DocCommentSyncResult> {
  const started = now.toISOString();
  const existing = await readCursor(app, target);
  const cursor = text(existing?.LastSuccessAt);
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
      await app.store.set(COLLECTIONS.docCommentThreads, text(record.Id), record);
    }
    if (!listed.complete) {
      await writeCursor(app, target, { lastSuccessAt: cursor, status: 'partial', error: 'Comment list was incomplete.', attempt: started });
      return emptyResult(target, {
        synced: false,
        incremental: !!cursor,
        cursor,
        comments: await storedComments(app, target),
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
      comments: await storedComments(app, target),
    };
  } catch (error) {
    const message = accessMessage(error);
    await writeCursor(app, target, { lastSuccessAt: cursor, status: 'error', error: message, attempt: started });
    return emptyResult(target, {
      ok: false,
      incremental: !!cursor,
      cursor,
      comments: await storedComments(app, target),
      reason: isDriveAuthProblem(error) ? 'auth' : 'access',
      message,
    });
  }
}

async function resolveTarget(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown): Promise<SyncTarget> {
  const user = await requireUser(app, 'SYNC_DOC_COMMENTS');
  if (user.role === 'student') {
    const placement = await findPlacement(app, user.email);
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
  const prepared = await prepareDrive(app, deps);
  if (!prepared.drive) {
    return emptyResult(target, {
      ok: prepared.reason === 'config',
      reason: prepared.reason,
      message: prepared.message,
      cursor: text((await readCursor(app, target))?.LastSuccessAt),
      comments: await storedComments(app, target),
    });
  }
  return syncTarget(app, target, prepared.drive, deps?.now || new Date());
}

async function commentPairs(app: App): Promise<CommentPair[]> {
  const cohorts = await listCohorts(app, false);
  const pairs: CommentPair[] = [];
  for (const cohort of cohorts) {
    const members = await app.store.listMembers(cohort.id);
    for (const member of members) {
      const studentId = normalizeEmail(member.StudentId);
      const docUrl = text(member.EEDoc);
      const fileId = parseDriveId(docUrl);
      if (!studentId || !fileId) continue;
      const cursor = await app.store.get(COLLECTIONS.docCommentSync, pairRecordId(studentId, fileId));
      pairs.push({
        studentId,
        cohortId: cohort.id,
        fileId,
        docUrl,
        lastSuccessAt: text(cursor?.LastSuccessAt),
        lastAttemptAt: text(cursor?.LastAttemptAt),
      });
    }
  }
  return pairs;
}

export async function runDocCommentSweep(app: App, deps?: DocCommentDeps): Promise<DocCommentSweepResult> {
  const now = deps?.now || new Date();
  const pairs = await commentPairs(app);
  const picked = staleCommentPairs(pairs, now, deps?.limit === undefined ? DOC_COMMENT_SWEEP_LIMIT : deps.limit);
  if (!picked.stale.length) {
    return { considered: 0, synced: 0, failed: 0, skippedFresh: picked.fresh };
  }
  const prepared = await prepareDrive(app, deps);
  if (!prepared.drive) {
    return { considered: 0, synced: 0, failed: 0, skippedFresh: picked.fresh, reason: prepared.reason };
  }
  let synced = 0;
  let failed = 0;
  for (const pair of picked.stale) {
    const result = await syncTarget(app, pair, prepared.drive, now);
    if (result.synced) synced += 1;
    else failed += 1;
  }
  return { considered: picked.stale.length, synced, failed, skippedFresh: picked.fresh };
}
