import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commentDriveFromApi,
  CommentDrive,
  runDocCommentSweep,
  syncEssayDocComments,
} from './docComments';
import {
  commentDueAt,
  commentListArgs,
  commentSyncIsStale,
  DOC_COMMENT_STALE_MS,
  docCommentSyncRecord,
  dueCommentSyncRows,
  nextDocCommentSyncWrite,
  normalizeThreadRecord,
  pairRecordId,
  presentDocComment,
  staleCommentPairs,
  threadRecordId,
} from './docCommentsPure';
import { App } from './session';
import { Store } from './store';
import { Doc, HubError } from './util';

const studentEmail = 'student@vsa.example.edu';
const otherStudentEmail = 'other-student@vsa.example.edu';
const quietStudentEmail = 'quiet@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';
const coordinatorEmail = 'coordinator@vsa.example.edu';
const actorEmail = 'drive@vsa.example.edu';
const FILE_ID = 'essayDocId123456';
const OTHER_FILE_ID = 'otherEssayDoc654321';
const QUIET_FILE_ID = 'quietEssayDoc777777';
const DOC_URL = `https://docs.google.com/document/d/${FILE_ID}/edit`;
const OTHER_DOC_URL = `https://docs.google.com/document/d/${OTHER_FILE_ID}/edit`;
const QUIET_DOC_URL = `https://docs.google.com/document/d/${QUIET_FILE_ID}/edit`;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60 * 1000).toISOString();
const STALE = new Date(NOW.getTime() - DOC_COMMENT_STALE_MS - 60 * 60 * 1000).toISOString();

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};

  async list(name: string): Promise<Doc[]> {
    return Object.values(this.docs[name] || {}).map((row) => ({ ...row }));
  }

  async get(name: string, id: string): Promise<Doc | null> {
    const row = (this.docs[name] || {})[id];
    return row ? { ...row } : null;
  }

  async set(name: string, id: string, data: Doc): Promise<void> {
    if (!this.docs[name]) this.docs[name] = {};
    this.docs[name][id] = { ...data };
  }

  async whereEqual(name: string, field: string, value: unknown): Promise<Doc[]> {
    return (await this.list(name)).filter((row) => row[field] === value);
  }

  async listMembers(cohortId: string): Promise<Doc[]> {
    return Object.values(this.members[cohortId] || {}).map((row) => ({ ...row }));
  }

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const row = (this.members[cohortId] || {})[email];
    return row ? { ...row } : null;
  }

  async listMessages(): Promise<Doc[]> {
    return [];
  }

  async remove(name: string, id: string): Promise<void> {
    if (this.docs[name]) delete this.docs[name][id];
  }

  chats: Record<string, Record<string, Doc>> = {};
  entries: Record<string, Record<string, Doc>> = {};
  meta: Record<string, Doc> = {};
  chatLists = 0;
  chatReads = 0;

  async getChat(cohortId: string, studentId: string): Promise<Doc | null> {
    this.chatReads += 1;
    const row = (this.chats[cohortId] || {})[studentId];
    return row ? { ...row } : null;
  }

  async setChat(cohortId: string, studentId: string, data: Doc): Promise<void> {
    if (!this.chats[cohortId]) this.chats[cohortId] = {};
    this.chats[cohortId][studentId] = { ...data };
  }

  async listChats(cohortId: string): Promise<Doc[]> {
    return Object.values(this.chats[cohortId] || {}).map((row) => ({ ...row }));
  }

  async listChatEntries(cohortId: string, studentId: string): Promise<Doc[]> {
    this.chatLists += 1;
    const key = `${cohortId}\n${studentId}`;
    return Object.values(this.entries[key] || {}).map((row) => ({ ...row }));
  }

  async setChatEntry(cohortId: string, studentId: string, entryId: string, data: Doc): Promise<void> {
    const key = `${cohortId}\n${studentId}`;
    if (!this.entries[key]) this.entries[key] = {};
    this.entries[key][entryId] = { ...data };
  }

  async addAudit(): Promise<void> {}

  async getMeta(id: string): Promise<Doc | null> {
    return this.meta[id] ? { ...this.meta[id] } : null;
  }

  async setMeta(id: string, data: Doc): Promise<void> {
    this.meta[id] = { ...data };
  }

  async listDueDocCommentSync(nowMs: number, limit: number): Promise<Doc[]> {
    return dueCommentSyncRows(Object.values(this.docs.docCommentSync || {}), nowMs, limit).map((row) => ({ ...row }));
  }

  async countFreshDocCommentSync(nowMs: number): Promise<number> {
    return Object.values(this.docs.docCommentSync || {}).filter((row) => typeof row.DueAt === 'number' && row.DueAt > nowMs).length;
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(store: MemoryStore) {
  await store.set('cohorts', '2026', { Cohort: '2026', Status: 'Active' });
  await store.set('cohorts', '2025', { Cohort: '2025', Status: 'Inactive' });
  store.members['2026'] = {
    [studentEmail]: {
      StudentId: studentEmail,
      'Display Name': 'Jamie Wong',
      supervisorId: supervisorEmail,
      EEDoc: DOC_URL,
    },
    [otherStudentEmail]: {
      StudentId: otherStudentEmail,
      'Display Name': 'Alex Student',
      supervisorId: otherEmail,
      EEDoc: OTHER_DOC_URL,
    },
    [quietStudentEmail]: {
      StudentId: quietStudentEmail,
      'Display Name': 'Quiet Student',
      supervisorId: supervisorEmail,
      EEDoc: QUIET_DOC_URL,
    },
    'nodoc@vsa.example.edu': {
      StudentId: 'nodoc@vsa.example.edu',
      'Display Name': 'No Doc',
      supervisorId: supervisorEmail,
    },
  };
  store.members['2025'] = {
    'inactive@vsa.example.edu': {
      StudentId: 'inactive@vsa.example.edu',
      EEDoc: 'https://docs.google.com/document/d/inactiveDoc123456/edit',
    },
  };
  await store.set('staffUsers', supervisorEmail, {
    EMAIL: supervisorEmail, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set('staffUsers', otherEmail, {
    EMAIL: otherEmail, DisplayName: 'Other Supervisor', isStaff: true, isSupervisor: true,
  });
  await store.set('staffUsers', coordinatorEmail, {
    EMAIL: coordinatorEmail, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set('studentUsers', studentEmail, { StudentId: studentEmail, DisplayName: 'Jamie Wong' });
  await store.set('studentUsers', otherStudentEmail, { StudentId: otherStudentEmail, DisplayName: 'Alex Student' });
}

function thread(id: string, input: {
  authorName: string;
  authorEmail: string;
  content: string;
  quote?: string;
  modifiedTime: string;
  createdTime?: string;
  deleted?: boolean;
  resolved?: boolean;
  replies?: Array<{ id: string; authorName: string; authorEmail: string; content: string; modifiedTime: string }>;
}) {
  return {
    id,
    createdTime: input.createdTime || input.modifiedTime,
    modifiedTime: input.modifiedTime,
    deleted: !!input.deleted,
    resolved: !!input.resolved,
    content: input.content,
    quotedFileContent: { value: input.quote || '' },
    author: { displayName: input.authorName, emailAddress: input.authorEmail },
    replies: (input.replies || []).map((reply) => ({
      id: reply.id,
      createdTime: reply.modifiedTime,
      modifiedTime: reply.modifiedTime,
      content: reply.content,
      author: { displayName: reply.authorName, emailAddress: reply.authorEmail },
    })),
  };
}

function scriptedDrive(script: RawPages, email = actorEmail): { drive: CommentDrive; calls: Array<{ fileId: string; startModifiedTime: string }> } {
  const calls: Array<{ fileId: string; startModifiedTime: string }> = [];
  const queues = new Map<string, RawPages[string]>();
  Object.keys(script).forEach((fileId) => { queues.set(fileId, script[fileId].slice()); });
  const drive: CommentDrive = {
    async aboutEmail() { return email; },
    async listComments(fileId, startModifiedTime) {
      calls.push({ fileId, startModifiedTime });
      const queue = queues.get(fileId) || [];
      const next = queue.length ? queue.shift() : { comments: [], complete: true };
      if (!next) return { comments: [], complete: true };
      return next;
    },
  };
  return { drive, calls };
}

type RawPages = Record<string, Array<{ comments: ReturnType<typeof thread>[]; complete: boolean }>>;

function depsFor(drive: CommentDrive, now = NOW) {
  return {
    actorEmail,
    driveForActor: async () => drive,
    now,
  };
}

test('modified-time filter is omitted until a sync cursor exists', () => {
  const first = commentListArgs(FILE_ID, '');
  assert.equal(first.fileId, FILE_ID);
  assert.equal(first.includeDeleted, true);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'startModifiedTime'), false);
  const next = commentListArgs(FILE_ID, '2026-11-01T00:00:00.000Z', 'page-2');
  assert.equal(next.startModifiedTime, '2026-11-01T00:00:00.000Z');
  assert.equal(next.pageToken, 'page-2');
  assert.equal(commentSyncIsStale('', NOW), true);
  assert.equal(commentSyncIsStale(FRESH, NOW), false);
  assert.equal(commentSyncIsStale(STALE, NOW), true);
  const dayAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(commentSyncIsStale(dayAgo, NOW), false);
  assert.equal(commentDueAt(dayAgo) > NOW.getTime(), true);
  assert.equal(commentSyncIsStale(new Date(NOW.getTime() - DOC_COMMENT_STALE_MS).toISOString(), NOW), true);
  const kept = nextDocCommentSyncWrite({
    Id: 'a@vsa.example.edu__file',
    StudentId: 'a@vsa.example.edu',
    Cohort: '2026',
    FileId: 'file',
    DocUrl: 'https://docs.google.com/document/d/file/edit',
    DueAt: 10,
    LastSuccessAt: FRESH,
  }, {
    studentId: 'a@vsa.example.edu',
    cohortId: '2026',
    fileId: 'file',
    docUrl: 'https://docs.google.com/document/d/file/edit',
  });
  assert.equal(kept, null);
  const enrolled = nextDocCommentSyncWrite(null, {
    studentId: 'a@vsa.example.edu',
    cohortId: '2026',
    fileId: 'file',
    docUrl: 'https://docs.google.com/document/d/file/edit',
  });
  assert.equal(enrolled?.DueAt, 0);
  assert.equal(dueCommentSyncRows([
    { StudentId: 'a@vsa.example.edu', FileId: 'fresh', DueAt: NOW.getTime() + 1000, LastAttemptAt: '' },
    { StudentId: 'b@vsa.example.edu', FileId: 'due', DueAt: 0, LastAttemptAt: NOW.toISOString() },
    { StudentId: 'c@vsa.example.edu', FileId: 'older', DueAt: 0, LastAttemptAt: '' },
  ], NOW.getTime(), 1)[0].FileId, 'older');
  const picked = staleCommentPairs([
    { studentId: 'a@vsa.example.edu', cohortId: '2026', fileId: 'a', docUrl: '', lastSuccessAt: FRESH },
    { studentId: 'b@vsa.example.edu', cohortId: '2026', fileId: 'b', docUrl: '', lastSuccessAt: '', lastAttemptAt: NOW.toISOString() },
    { studentId: 'c@vsa.example.edu', cohortId: '2026', fileId: 'c', docUrl: '', lastSuccessAt: STALE, lastAttemptAt: '' },
  ], NOW, 1);
  assert.equal(picked.fresh, 1);
  assert.deepEqual(picked.stale.map((pair) => pair.fileId), ['c']);
});

test('a thread with replies is one record, and both authors are kept', () => {
  const record = normalizeThreadRecord({
    fileId: FILE_ID,
    studentId: studentEmail,
    cohortId: '2026',
    docUrl: DOC_URL,
    comment: thread('thread-1', {
      authorName: 'Priya Shah',
      authorEmail: supervisorEmail,
      content: 'Tighten this paragraph.',
      quote: 'the river',
      modifiedTime: '2026-11-01T01:00:00.000Z',
      replies: [
        { id: 'reply-1', authorName: 'Jamie Wong', authorEmail: studentEmail, content: 'I cut it.', modifiedTime: '2026-11-01T02:00:00.000Z' },
        { id: 'reply-2', authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Better.', modifiedTime: '2026-11-01T03:00:00.000Z' },
        { id: 'reply-3', authorName: 'Jamie Wong', authorEmail: studentEmail, content: 'Thanks.', modifiedTime: '2026-11-01T04:00:00.000Z' },
        { id: 'reply-4', authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Ship it.', modifiedTime: '2026-11-01T05:00:00.000Z' },
      ],
    }),
  });
  assert.ok(record);
  assert.equal(record?.Id, threadRecordId(FILE_ID, 'thread-1'));
  assert.equal(record?.AuthorEmail, supervisorEmail);
  assert.equal(record?.ReplyCount, 4);
  const replies = JSON.parse(String(record?.RepliesJson));
  assert.equal(replies.length, 4);
  assert.equal(replies.some((reply: { authorEmail: string }) => reply.authorEmail === studentEmail), true);
  const card = presentDocComment(record as Doc);
  assert.equal(card?.commentId, 'thread-1');
  assert.equal(card?.replyCount, 4);
  assert.equal(card?.replies.length, 3);
  assert.equal(card?.quote, 'the river');
  assert.equal(presentDocComment({ ...record, Deleted: true }), null);
});

test('Drive comment pages follow startModifiedTime and stop when the cap is reached', async () => {
  const calls: Record<string, unknown>[] = [];
  let page = 0;
  const drive = commentDriveFromApi({
    about: { async get() { return { data: { user: { emailAddress: actorEmail } } }; } },
    comments: {
      async list(args) {
        calls.push(args);
        page += 1;
        return { data: { comments: [{ id: `c${page}`, content: 'Note', modifiedTime: '2026-11-01T00:00:00.000Z' }], nextPageToken: `p${page}` } };
      },
    },
  });
  const listed = await drive.listComments(FILE_ID, '2026-10-01T00:00:00.000Z');
  assert.equal(calls.length, 10);
  assert.equal(listed.complete, false);
  assert.equal(listed.comments.length, 10);
  assert.equal(calls[0].startModifiedTime, '2026-10-01T00:00:00.000Z');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'pageToken'), false);
  assert.equal(calls[1].pageToken, 'p1');
  await assert.rejects(
    commentDriveFromApi({
      about: { async get() { return { data: { user: { emailAddress: actorEmail } } }; } },
      comments: { async list() { throw Object.assign(new Error('nope'), { response: { status: 403, data: { error: { message: 'The user does not have access' } } } }); } },
    }).listComments(FILE_ID, ''),
    /cannot read comments/,
  );
});

test('opening chat syncs both authors once per thread, then only comments modified since the cursor', async () => {
  const store = new MemoryStore();
  await seed(store);
  const first = scriptedDrive({
    [FILE_ID]: [{
      complete: true,
      comments: [
        thread('sup-1', {
          authorName: 'Priya Shah',
          authorEmail: supervisorEmail,
          content: 'Tighten this.',
          quote: 'the river',
          modifiedTime: '2026-11-01T01:00:00.000Z',
          replies: [
            { id: 'reply-1', authorName: 'Jamie Wong', authorEmail: studentEmail, content: 'I cut it.', modifiedTime: '2026-11-01T02:00:00.000Z' },
          ],
        }),
        thread('stu-1', {
          authorName: 'Jamie Wong',
          authorEmail: studentEmail,
          content: 'Is this clear?',
          quote: 'my question',
          modifiedTime: '2026-11-01T01:30:00.000Z',
        }),
      ],
    }, {
      complete: true,
      comments: [
        thread('sup-1', {
          authorName: 'Priya Shah',
          authorEmail: supervisorEmail,
          content: 'One more pass.',
          quote: 'the river',
          modifiedTime: '2026-11-01T06:00:00.000Z',
          resolved: true,
          replies: [
            { id: 'reply-1', authorName: 'Jamie Wong', authorEmail: studentEmail, content: 'I cut it.', modifiedTime: '2026-11-01T02:00:00.000Z' },
            { id: 'reply-2', authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Close.', modifiedTime: '2026-11-01T06:00:00.000Z' },
          ],
        }),
      ],
    }, {
      complete: true,
      comments: [
        thread('sup-1', {
          authorName: 'Priya Shah',
          authorEmail: supervisorEmail,
          content: 'One more pass.',
          modifiedTime: '2026-11-01T07:00:00.000Z',
          deleted: true,
        }),
      ],
    }],
  });
  const student = appFor(store, studentEmail);
  const opened = await syncEssayDocComments(student, otherStudentEmail, '2026', 'supervisor', depsFor(first.drive, NOW));
  assert.equal(opened.synced, true);
  assert.equal(opened.incremental, false);
  assert.equal(first.calls[0].fileId, FILE_ID);
  assert.equal(first.calls[0].startModifiedTime, '');
  assert.equal(opened.comments.length, 2);
  assert.deepEqual(opened.comments.map((comment) => comment.authorEmail).sort(), [studentEmail, supervisorEmail]);
  const storedThreads = await store.listChatEntries('2026', studentEmail);
  assert.equal(storedThreads.length, 2);
  const supervisorThread = storedThreads.find((row) => row.ThreadId === 'sup-1');
  assert.equal(supervisorThread?.ReplyCount, 1);
  assert.equal(storedThreads.some((row) => row.ThreadId === 'reply-1'), false);
  const cursor = await store.getChat('2026', studentEmail);
  assert.equal(cursor?.CommentCursor, NOW.toISOString());
  assert.equal(cursor?.CommentSyncStatus, 'ok');

  const later = new Date('2026-11-01T12:20:00.000Z');
  const again = await syncEssayDocComments(student, undefined, undefined, undefined, depsFor(first.drive, later));
  assert.equal(again.incremental, true);
  assert.equal(first.calls[1].startModifiedTime, NOW.toISOString());
  assert.equal((await store.listChatEntries('2026', studentEmail)).length, 2);
  assert.equal(again.comments.find((comment) => comment.threadId === 'sup-1')?.body, 'One more pass.');
  assert.equal(again.comments.find((comment) => comment.threadId === 'sup-1')?.resolved, true);
  assert.equal(again.comments.find((comment) => comment.threadId === 'sup-1')?.replyCount, 2);

  const removed = await syncEssayDocComments(student, undefined, undefined, undefined, depsFor(first.drive, new Date('2026-11-01T13:00:00.000Z')));
  assert.equal(removed.comments.some((comment) => comment.threadId === 'sup-1'), false);
  assert.equal(removed.comments.length, 1);
  assert.equal((await store.listChatEntries('2026', studentEmail)).find((row) => row.ThreadId === 'sup-1')?.Deleted, true);
});

test('a supervisor can sync their student, and another supervisor cannot', async () => {
  const store = new MemoryStore();
  await seed(store);
  const script = scriptedDrive({
    [FILE_ID]: [{ complete: true, comments: [thread('sup-1', { authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'See me.', modifiedTime: '2026-11-01T01:00:00.000Z' })] }],
  });
  const supervisor = appFor(store, supervisorEmail);
  const synced = await syncEssayDocComments(supervisor, studentEmail, '', 'supervisor', depsFor(script.drive));
  assert.equal(synced.synced, true);
  assert.equal(synced.studentId, studentEmail);
  assert.equal(script.calls[0].fileId, FILE_ID);

  const stranger = appFor(store, otherEmail);
  await assert.rejects(
    syncEssayDocComments(stranger, studentEmail, '2026', 'supervisor', depsFor(script.drive)),
    /Access denied/,
  );
  assert.equal(script.calls.length, 1);

  const coordinator = appFor(store, coordinatorEmail);
  const wide = await syncEssayDocComments(coordinator, studentEmail, '2026', 'coordinator', depsFor(script.drive, new Date('2026-11-01T12:10:00.000Z')));
  assert.equal(wide.incremental, true);
  assert.equal(wide.comments[0].commentId, 'sup-1');
});

test('a failed read keeps the previous cursor and still returns stored threads', async () => {
  const store = new MemoryStore();
  await seed(store);
  const calls: string[] = [];
  const drive: CommentDrive = {
    async aboutEmail() { return actorEmail; },
    async listComments(fileId, startModifiedTime) {
      calls.push(startModifiedTime);
      if (calls.length > 1) throw new HubError('The Google account assigned for Drive cannot read comments on this document.');
      return {
        comments: [thread('sup-1', { authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Kept.', modifiedTime: '2026-11-01T01:00:00.000Z' })],
        complete: true,
      };
    },
  };
  const student = appFor(store, studentEmail);
  const first = await syncEssayDocComments(student, undefined, undefined, undefined, depsFor(drive, NOW));
  assert.equal(first.comments.length, 1);
  const failed = await syncEssayDocComments(student, undefined, undefined, undefined, depsFor(drive, new Date('2026-11-01T18:00:00.000Z')));
  assert.equal(failed.synced, false);
  assert.equal(failed.reason, 'access');
  assert.equal(failed.comments.length, 1);
  assert.equal(failed.comments[0].body, 'Kept.');
  const cursor = await store.getChat('2026', studentEmail);
  assert.equal(cursor?.CommentCursor, NOW.toISOString());
  assert.equal(cursor?.CommentSyncStatus, 'error');
  assert.equal(calls[1], NOW.toISOString());
});

test('chat still shows stored comments when Drive is not connected', async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.set('docCommentThreads', threadRecordId(FILE_ID, 'sup-1'), normalizeThreadRecord({
    fileId: FILE_ID,
    studentId: studentEmail,
    cohortId: '2026',
    docUrl: DOC_URL,
    comment: thread('sup-1', { authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Stored.', modifiedTime: '2026-11-01T01:00:00.000Z' }),
  }) as Doc);
  let called = false;
  const drive: CommentDrive = {
    async aboutEmail() { called = true; return actorEmail; },
    async listComments() { called = true; return { comments: [], complete: true }; },
  };
  const result = await syncEssayDocComments(appFor(store, studentEmail), undefined, undefined, undefined, {
    actorEmail: '',
    keyConfigured: false,
    driveForActor: async () => drive,
    now: NOW,
  });
  assert.equal(result.synced, false);
  assert.equal(result.reason, 'config');
  assert.equal(result.comments.length, 1);
  assert.equal(called, false);
  assert.equal(await store.get('docCommentSync', pairRecordId(studentEmail, FILE_ID)), null);
  assert.equal(await store.get('docCommentThreads', threadRecordId(FILE_ID, 'sup-1')), null);
  assert.equal((await store.listChatEntries('2026', studentEmail)).find((row) => row.ThreadId === 'sup-1')?.Body, 'Stored.');
});

test('the daily sweep refreshes stale student files and leaves fresh ones alone', async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.setChat('2026', otherStudentEmail, {
    StudentId: otherStudentEmail,
    Cohort: '2026',
    DocFileId: OTHER_FILE_ID,
    DocUrl: OTHER_DOC_URL,
    CommentCursor: FRESH,
    CommentLastAttemptAt: FRESH,
  });
  await store.setChat('2026', quietStudentEmail, {
    StudentId: quietStudentEmail,
    Cohort: '2026',
    DocFileId: QUIET_FILE_ID,
    DocUrl: QUIET_DOC_URL,
    CommentCursor: STALE,
    CommentLastAttemptAt: STALE,
  });
  const script = scriptedDrive({
    [FILE_ID]: [{ complete: true, comments: [thread('stu-1', { authorName: 'Jamie Wong', authorEmail: studentEmail, content: 'From the sweep.', modifiedTime: '2026-11-01T03:00:00.000Z' })] }],
    [QUIET_FILE_ID]: [{ complete: true, comments: [thread('old-1', { authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Caught up.', modifiedTime: '2026-11-01T04:00:00.000Z' })] }],
    [OTHER_FILE_ID]: [{ complete: true, comments: [thread('fresh-1', { authorName: 'Other', authorEmail: otherEmail, content: 'Should not load.', modifiedTime: '2026-11-01T04:00:00.000Z' })] }],
  });
  store.chatLists = 0;
  const summary = await runDocCommentSweep(appFor(store, 'doc-comments@ee-hub'), depsFor(script.drive, NOW));
  assert.equal(store.chatLists, 0);
  assert.equal(summary.synced, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skippedFresh, 1);
  assert.deepEqual(script.calls.map((call) => call.fileId), [FILE_ID, QUIET_FILE_ID]);
  assert.equal(script.calls[0].startModifiedTime, '');
  assert.equal(script.calls[1].startModifiedTime, STALE);
  assert.equal((await store.listChatEntries('2026', studentEmail)).find((row) => row.ThreadId === 'stu-1')?.AuthorEmail, studentEmail);
  assert.equal((await store.listChatEntries('2026', otherStudentEmail)).some((row) => row.ThreadId === 'fresh-1'), false);
  assert.equal((await store.listChatEntries('2025', 'inactive@vsa.example.edu')).length, 0);

  const limited = scriptedDrive({
    [FILE_ID]: [{ complete: true, comments: [] }],
    [QUIET_FILE_ID]: [{ complete: true, comments: [] }],
  });
  await store.setChat('2026', studentEmail, { StudentId: studentEmail, Cohort: '2026', DocFileId: FILE_ID, CommentCursor: '', CommentLastAttemptAt: '' });
  await store.setChat('2026', quietStudentEmail, { StudentId: quietStudentEmail, Cohort: '2026', DocFileId: QUIET_FILE_ID, CommentCursor: STALE, CommentLastAttemptAt: STALE });
  await store.set('docCommentSync', pairRecordId(studentEmail, FILE_ID), docCommentSyncRecord({
    studentId: studentEmail, cohortId: '2026', fileId: FILE_ID, docUrl: DOC_URL, lastSuccessAt: '', lastAttemptAt: '',
  }));
  await store.set('docCommentSync', pairRecordId(quietStudentEmail, QUIET_FILE_ID), docCommentSyncRecord({
    studentId: quietStudentEmail, cohortId: '2026', fileId: QUIET_FILE_ID, docUrl: QUIET_DOC_URL, lastSuccessAt: STALE, lastAttemptAt: STALE,
  }));
  const capped = await runDocCommentSweep(appFor(store, 'doc-comments@ee-hub'), { ...depsFor(limited.drive, NOW), limit: 1 });
  assert.equal(capped.considered, 1);
  assert.deepEqual(limited.calls.map((call) => call.fileId), [FILE_ID]);
});

test('a warm sweep reads due sync rows and does not list chat history', async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.setMeta('docCommentSyncBackfill', { complete: true });
  await store.set('docCommentSync', pairRecordId(otherStudentEmail, OTHER_FILE_ID), docCommentSyncRecord({
    studentId: otherStudentEmail,
    cohortId: '2026',
    fileId: OTHER_FILE_ID,
    docUrl: OTHER_DOC_URL,
    lastSuccessAt: FRESH,
    lastAttemptAt: FRESH,
  }));
  await store.set('docCommentSync', pairRecordId(quietStudentEmail, QUIET_FILE_ID), docCommentSyncRecord({
    studentId: quietStudentEmail,
    cohortId: '2026',
    fileId: QUIET_FILE_ID,
    docUrl: QUIET_DOC_URL,
    lastSuccessAt: STALE,
    lastAttemptAt: STALE,
  }));
  await store.setChat('2026', quietStudentEmail, {
    StudentId: quietStudentEmail,
    Cohort: '2026',
    DocFileId: QUIET_FILE_ID,
    CommentCursor: STALE,
  });
  const script = scriptedDrive({
    [QUIET_FILE_ID]: [{ complete: true, comments: [thread('old-1', { authorName: 'Priya Shah', authorEmail: supervisorEmail, content: 'Caught up.', modifiedTime: '2026-11-01T04:00:00.000Z' })] }],
    [OTHER_FILE_ID]: [{ complete: true, comments: [thread('fresh-1', { authorName: 'Other', authorEmail: otherEmail, content: 'Should not load.', modifiedTime: '2026-11-01T04:00:00.000Z' })] }],
    [FILE_ID]: [{ complete: true, comments: [thread('stu-1', { authorName: 'Jamie Wong', authorEmail: studentEmail, content: 'Not indexed.', modifiedTime: '2026-11-01T03:00:00.000Z' })] }],
  });
  store.chatReads = 0;
  store.chatLists = 0;
  const summary = await runDocCommentSweep(appFor(store, 'doc-comments@ee-hub'), depsFor(script.drive, NOW));
  assert.equal(summary.synced, 1);
  assert.equal(summary.skippedFresh, 1);
  assert.equal(store.chatLists, 0);
  assert.deepEqual(script.calls.map((call) => call.fileId), [QUIET_FILE_ID]);
  assert.equal(script.calls[0].startModifiedTime, STALE);
  assert.ok(store.chatReads > 0);
  assert.ok(store.chatReads < 6);
  assert.equal((await store.listChatEntries('2026', otherStudentEmail)).length, 0);
});

test('opening chat keeps a live comment sync index and still lists stored comments', async () => {
  const store = new MemoryStore();
  await seed(store);
  const record = docCommentSyncRecord({
    studentId: studentEmail,
    cohortId: '2026',
    fileId: FILE_ID,
    docUrl: DOC_URL,
    lastSuccessAt: FRESH,
    lastAttemptAt: FRESH,
  });
  await store.set('docCommentSync', textId(record.Id), record);
  await store.setChatEntry('2026', studentEmail, 'doc-seed', {
    EntryId: 'doc-seed',
    Kind: 'doc-comment',
    FileId: FILE_ID,
    ThreadId: 'sup-1',
    Body: 'Stored.',
    Deleted: false,
    CreatedAt: '2026-11-01T01:00:00.000Z',
  });
  const result = await syncEssayDocComments(appFor(store, studentEmail), undefined, undefined, undefined, {
    actorEmail: '',
    keyConfigured: false,
    driveForActor: async () => ({
      async aboutEmail() { return actorEmail; },
      async listComments() { return { comments: [], complete: true }; },
    }),
    now: NOW,
  });
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].body, 'Stored.');
  const kept = await store.get('docCommentSync', textId(record.Id));
  assert.equal(typeof kept?.DueAt, 'number');
  assert.equal(kept?.LastSuccessAt, FRESH);
  const chat = await store.getChat('2026', studentEmail);
  assert.equal(chat?.CommentCursor, FRESH);
});

function textId(value: unknown): string {
  return String(value || '');
}

test('a missing essay doc does not call Drive', async () => {
  const store = new MemoryStore();
  await seed(store);
  store.members['2026'][studentEmail].EEDoc = '';
  let called = false;
  const drive: CommentDrive = {
    async aboutEmail() { called = true; return actorEmail; },
    async listComments() { called = true; return { comments: [], complete: true }; },
  };
  const result = await syncEssayDocComments(appFor(store, studentEmail), undefined, undefined, undefined, depsFor(drive));
  assert.equal(result.reason, 'missing');
  assert.equal(result.comments.length, 0);
  assert.equal(called, false);
});
