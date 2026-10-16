// Essay document stats for the student page. The Drive call uses the access
// token of the person who has the page open. The file id comes from that
// student's saved EE document, not from the browser. Word-count samples are
// stored one row per file in docWordLogs. Edit squares come from Drive revisions.

import { DRIVE_DOCUMENT_MIME, parseDriveId, readAccessToken, RECONNECT, WRONG_ACCOUNT } from './drive';
import {
  buildEditHeatmap,
  countRevisionDays,
  countWords,
  DAY_MS,
  dayKeyInZone,
  DOC_HEATMAP_WEEKS,
  editStreak,
  normalizeWordSamples,
  rememberWordSample,
  WordSample,
  wordsTypedSince,
  wordSamplesChanged,
} from './docAnalyticsPure';
import { findPlacement, staffStudentContext } from './roster';
import { COLLECTIONS } from './schema';
import { App, deny, requireStaff, requireUser } from './session';
import { HubError, normalizeEmail, nowIso, text } from './util';

const NEEDS_DRIVE = 'Connect Google Drive to read this document. The hub uses your Google account, and only a document you can already open is included.';
const NEEDS_SCOPE = 'Allow Google Drive access to read this document. The hub uses your Google account, and only a document you can already open is included.';
const ACCESS_DENIED_DOC = 'You do not have access to this document.';
const OPEN_FAILED = 'The EE Hub could not open this document.';
const WORD_HINT_DOC = 'Word count is available for a Google Doc.';
const WORD_HINT_LATER = 'Daily and weekly word changes appear after this document is checked again on a later day.';

export interface EssayFile {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  modifiedTime: string;
}

export interface EssayDrive {
  aboutEmail(): Promise<string>;
  getFile(fileId: string): Promise<EssayFile>;
  exportPlainText(fileId: string): Promise<string>;
  listRevisionTimes(fileId: string): Promise<string[]>;
}

export interface WordLog {
  read(fileId: string): Promise<WordSample[]>;
  write(fileId: string, samples: WordSample[]): Promise<void>;
}

export interface EssayAnalytics {
  ok: boolean;
  reason?: string;
  message?: string;
  fileId?: string;
  title?: string;
  wordCount?: number | null;
  wordsDay?: number | null;
  wordsWeek?: number | null;
  wordsHint?: string;
  opens?: number | null;
  lastEdit?: string;
  streak?: number | null;
  revisionsLoaded?: boolean;
  months?: { column: number; label: string }[];
  days?: { date: string; count: number; level: number; future: boolean }[];
}

export interface AnalyticsDeps {
  driveForToken(token: string): Promise<EssayDrive>;
  now?: Date;
}

interface EssayApiFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  trashed?: boolean | null;
  modifiedTime?: string | null;
}

interface EssayApi {
  about: {
    get(args: { fields: string }): Promise<{ data: { user?: { emailAddress?: string | null } | null } }>;
  };
  files: {
    get(args: Record<string, unknown>): Promise<{ data: EssayApiFile }>;
    export(args: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  revisions: {
    list(args: Record<string, unknown>): Promise<{ data: { nextPageToken?: string | null; revisions?: Array<{ modifiedTime?: string | null }> | null } }>;
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

export function isDriveAuthProblem(error: unknown): boolean {
  return error instanceof HubError && (error.message === RECONNECT || error.message === WRONG_ACCOUNT || error.message === NEEDS_SCOPE || error.message === NEEDS_DRIVE);
}

function accessMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message === ACCESS_DENIED_DOC || message === OPEN_FAILED || message === 'This document could not be opened.') return message;
  const combined = `${message} ${googleMessage(error)}`;
  if (/access|permission|forbidden|403|not found|404/i.test(combined)) return ACCESS_DENIED_DOC;
  return OPEN_FAILED;
}

async function readBody(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (data && typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of data as AsyncIterable<Buffer | string | Uint8Array>) {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

export function essayDriveFromApi(api: EssayApi): EssayDrive {
  return {
    async aboutEmail() {
      try {
        const about = await api.about.get({ fields: 'user(emailAddress)' });
        return about.data.user?.emailAddress || '';
      } catch (error) {
        throw asHub(error, RECONNECT);
      }
    },
    async getFile(fileId) {
      try {
        const file = await api.files.get({
          fileId,
          fields: 'id,name,mimeType,trashed,modifiedTime',
          supportsAllDrives: true,
        });
        return {
          id: file.data.id || fileId,
          name: file.data.name || '',
          mimeType: file.data.mimeType || '',
          trashed: !!file.data.trashed,
          modifiedTime: file.data.modifiedTime || '',
        };
      } catch (error) {
        if (isAuthFailure(error) || isScopeFailure(error)) throw asHub(error, RECONNECT);
        throw new HubError(accessMessage(error));
      }
    },
    async exportPlainText(fileId) {
      try {
        const exported = await api.files.export(
          { fileId, mimeType: 'text/plain' },
          { responseType: 'text' },
        );
        return readBody(exported.data);
      } catch (error) {
        throw asHub(error, 'The document text could not be read.');
      }
    },
    async listRevisionTimes(fileId) {
      const stamps: string[] = [];
      let token = '';
      for (let page = 0; page < 10 && stamps.length < 2000; page += 1) {
        let response: { data: { nextPageToken?: string | null; revisions?: Array<{ modifiedTime?: string | null }> | null } };
        try {
          response = await api.revisions.list({
            fileId,
            pageSize: 200,
            pageToken: token || undefined,
            fields: 'nextPageToken,revisions(modifiedTime)',
            supportsAllDrives: true,
          });
        } catch (error) {
          if (!stamps.length) throw asHub(error, 'Edit history could not be read.');
          break;
        }
        (response.data.revisions || []).forEach((row) => {
          if (row.modifiedTime) stamps.push(String(row.modifiedTime));
        });
        token = response.data.nextPageToken ? String(response.data.nextPageToken) : '';
        if (!token) break;
      }
      return stamps;
    },
  };
}

export async function essayDriveFromToken(accessToken: string): Promise<EssayDrive> {
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return essayDriveFromApi(google.drive({ version: 'v3', auth }) as unknown as EssayApi);
}

async function assertViewer(drive: EssayDrive, email: string): Promise<void> {
  let owner = '';
  try {
    owner = normalizeEmail(await drive.aboutEmail());
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError(RECONNECT);
  }
  if (!owner || owner !== normalizeEmail(email)) throw new HubError(WRONG_ACCOUNT);
}

function wordLog(app: App): WordLog {
  return {
    async read(fileId) {
      const row = await app.store.get(COLLECTIONS.docWordLogs, fileId);
      if (!row || row.SamplesJson === undefined || row.SamplesJson === null || row.SamplesJson === '') return [];
      try {
        return normalizeWordSamples(JSON.parse(String(row.SamplesJson)));
      } catch {
        return [];
      }
    },
    async write(fileId, samples) {
      await app.store.set(COLLECTIONS.docWordLogs, fileId, {
        FileId: fileId,
        SamplesJson: JSON.stringify(samples),
        UpdatedAt: nowIso(),
      });
    },
  };
}

export async function collectEssayAnalytics(input: {
  fileId: string;
  drive: EssayDrive;
  log: WordLog;
  now: Date;
  timeZone: string;
}): Promise<EssayAnalytics> {
  const file = await input.drive.getFile(input.fileId);
  if (!file || file.trashed) throw new HubError('This document could not be opened.');
  let wordCount: number | null = null;
  if (file.mimeType === DRIVE_DOCUMENT_MIME) {
    try {
      wordCount = countWords(await input.drive.exportPlainText(input.fileId));
    } catch (error) {
      if (isDriveAuthProblem(error)) throw error;
      wordCount = null;
    }
  }
  let revisionsLoaded = true;
  let stamps: string[] = [];
  try {
    stamps = await input.drive.listRevisionTimes(input.fileId);
  } catch (error) {
    if (isDriveAuthProblem(error)) throw error;
    revisionsLoaded = false;
  }
  const timeZone = input.timeZone || 'UTC';
  const now = input.now;
  const todayKey = dayKeyInZone(now, timeZone);
  const dayCounts = countRevisionDays(stamps, timeZone);
  let wordsDay: number | null = null;
  let wordsWeek: number | null = null;
  if (wordCount !== null) {
    try {
      const samples = await input.log.read(input.fileId);
      wordsDay = wordsTypedSince(samples, wordCount, now.getTime(), now.getTime() - DAY_MS, 12 * 3600000);
      wordsWeek = wordsTypedSince(samples, wordCount, now.getTime(), now.getTime() - (7 * DAY_MS), 36 * 3600000);
      const nextSamples = rememberWordSample(samples, wordCount, now, todayKey);
      if (wordSamplesChanged(samples, nextSamples)) await input.log.write(input.fileId, nextSamples);
    } catch (error) {
      if (isDriveAuthProblem(error)) throw error;
    }
  }
  const heatmap = buildEditHeatmap(dayCounts, todayKey, DOC_HEATMAP_WEEKS);
  const activeDays = Object.keys(dayCounts);
  return {
    ok: true,
    fileId: input.fileId,
    title: file.name || 'Extended Essay',
    wordCount,
    wordsDay,
    wordsWeek,
    wordsHint: wordCount === null ? WORD_HINT_DOC : (wordsDay === null && wordsWeek === null ? WORD_HINT_LATER : ''),
    opens: null,
    lastEdit: file.modifiedTime || '',
    streak: revisionsLoaded ? editStreak(activeDays, todayKey) : null,
    revisionsLoaded,
    months: heatmap.months,
    days: heatmap.days,
  };
}

function authResult(error?: unknown): EssayAnalytics {
  const message = error instanceof Error && error.message ? error.message : RECONNECT;
  return { ok: false, reason: 'auth', message };
}

async function loadEssayAnalytics(app: App, viewerEmail: string, docUrl: string, request: unknown, deps?: AnalyticsDeps): Promise<EssayAnalytics> {
  const fileId = parseDriveId(docUrl);
  if (!fileId) return { ok: false, reason: 'missing' };
  let token = '';
  try {
    token = readAccessToken(request);
  } catch (error) {
    return authResult(error);
  }
  if (!token) return { ok: false, reason: 'auth', message: NEEDS_DRIVE };
  try {
    const drive = await (deps?.driveForToken || essayDriveFromToken)(token);
    await assertViewer(drive, viewerEmail);
    return await collectEssayAnalytics({
      fileId,
      drive,
      log: wordLog(app),
      now: deps?.now || new Date(),
      timeZone: app.timeZone || 'UTC',
    });
  } catch (error) {
    if (isDriveAuthProblem(error)) return authResult(error);
    return { ok: false, reason: 'access', message: error instanceof HubError ? error.message : accessMessage(error) };
  }
}

export async function getMyEssayAnalytics(app: App, request?: unknown, deps?: AnalyticsDeps): Promise<EssayAnalytics> {
  const user = await requireUser(app, 'VIEW_ESSAY_ANALYTICS');
  if (user.role !== 'student') return deny(app, user, 'VIEW_ESSAY_ANALYTICS', 'Student access required.');
  const placement = await findPlacement(app, user.email);
  return loadEssayAnalytics(app, user.email, placement?.doc || '', request, deps);
}

export async function getStudentEssayAnalytics(app: App, studentEmail: unknown, cohortId: unknown, viewAs: unknown, request?: unknown, deps?: AnalyticsDeps): Promise<EssayAnalytics> {
  const user = await requireStaff(app, 'VIEW_STUDENT_ESSAY_ANALYTICS');
  const context = await staffStudentContext(app, user, text(studentEmail), text(cohortId), 'VIEW_STUDENT_ESSAY_ANALYTICS', viewAs);
  return loadEssayAnalytics(app, user.email, context.roster.doc || '', request, deps);
}
