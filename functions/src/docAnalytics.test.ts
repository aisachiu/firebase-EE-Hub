import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEssayAnalytics,
  EssayDrive,
  essayDriveFromApi,
  getMyEssayAnalytics,
  getStudentEssayAnalytics,
} from './docAnalytics';
import {
  addDays,
  buildEditHeatmap,
  countWords,
  dayKeyInZone,
  DOC_HEATMAP_WEEKS,
  DOC_WORD_SAMPLE_LIMIT,
  editHeatLevel,
  editStreak,
  mondayOnOrBefore,
  rememberWordSample,
  wordsTypedSince,
} from './docAnalyticsPure';
import { DRIVE_DOCUMENT_MIME, RECONNECT, WRONG_ACCOUNT } from './drive';
import { App } from './session';
import { Store } from './store';
import { Doc, HubError } from './util';

const studentEmail = 'student@vsa.example.edu';
const supervisorEmail = 'supervisor@vsa.example.edu';
const otherEmail = 'other@vsa.example.edu';
const coordinatorEmail = 'coordinator@vsa.example.edu';
const FILE_ID = 'essayDocId123456';
const DOC_URL = `https://docs.google.com/document/d/${FILE_ID}/edit`;
const ACTOR = 'coordinator@vsa.example.edu';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const DRIVE_KEY = {
  clientId: 'ee-hub.apps.googleusercontent.com',
  clientSecret: 'oauth-client-secret',
  refreshToken: 'oauth-refresh-token',
};

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  members: Record<string, Record<string, Doc>> = {};
  meta: Record<string, Doc> = {};

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

  async findBy(name: string, field: string, value: unknown): Promise<Doc | null> {
    return (await this.list(name)).find((row) => row[field] === value) || null;
  }

  async listMembers(cohortId: string): Promise<Doc[]> {
    return Object.values(this.members[cohortId] || {}).map((row) => ({ ...row }));
  }

  async getMember(cohortId: string, email: string): Promise<Doc | null> {
    const row = (this.members[cohortId] || {})[email];
    return row ? { ...row } : null;
  }

  async addAudit(): Promise<void> {}

  async getMeta(id: string): Promise<Doc | null> {
    return this.meta[id] ? { ...this.meta[id] } : null;
  }

  async setMeta(id: string, data: Doc): Promise<void> {
    this.meta[id] = { ...data };
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(store: MemoryStore, doc = DOC_URL) {
  await store.set('cohorts', '2026', { Cohort: '2026', Status: 'Active' });
  store.members['2026'] = {
    [studentEmail]: {
      StudentId: studentEmail,
      'Display Name': 'Jamie Wong',
      supervisorId: supervisorEmail,
      EEDoc: doc,
      EEFolder: 'https://drive.google.com/drive/folders/folderId1234567890',
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
}

function memoryLog() {
  const saved: WordSampleStore = { samples: [] };
  return {
    saved,
    log: {
      async read() { return saved.samples.map((sample) => ({ ...sample })); },
      async write(_fileId: string, samples: { d: string; w: number; t?: number }[]) { saved.samples = samples.map((sample) => ({ ...sample })); },
    },
  };
}

interface WordSampleStore { samples: { d: string; w: number; t?: number }[] }

function driveFor(email: string, file: {
  name?: string;
  mimeType?: string;
  text?: string;
  trashed?: boolean;
  modifiedTime?: string;
  revisions?: string[];
  failExport?: boolean;
  failRevisions?: boolean;
  missing?: boolean;
}) : { drive: EssayDrive; reads: string[]; exports: string[] } {
  const reads: string[] = [];
  const exports: string[] = [];
  const drive: EssayDrive = {
    async aboutEmail() { return email; },
    async getFile(fileId) {
      reads.push(fileId);
      if (file.missing) throw new HubError('The Google account assigned for Drive cannot open this document.');
      return {
        id: fileId,
        name: file.name || 'Extended Essay',
        mimeType: file.mimeType || DRIVE_DOCUMENT_MIME,
        trashed: !!file.trashed,
        modifiedTime: file.modifiedTime || '2026-10-16T11:00:00.000Z',
      };
    },
    async exportPlainText(fileId) {
      exports.push(fileId);
      if (file.failExport) throw new HubError('The document text could not be read.');
      return file.text || '';
    },
    async listRevisionTimes() {
      if (file.failRevisions) throw new HubError('Edit history could not be read.');
      return file.revisions || [];
    },
  };
  return { drive, reads, exports };
}

test('word counts ignore a byte-order mark and blank lines', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('\uFEFFone\u00a0two   three'), 3);
  assert.equal(countWords('   '), 0);
});

test('day keys follow the hub timezone', () => {
  assert.equal(dayKeyInZone(new Date('2026-10-16T16:30:00.000Z'), 'Asia/Hong_Kong'), '2026-10-17');
  assert.equal(dayKeyInZone(new Date('2026-10-16T15:30:00.000Z'), 'Asia/Hong_Kong'), '2026-10-16');
  assert.equal(mondayOnOrBefore('2026-10-16'), '2026-10-12');
  assert.equal(mondayOnOrBefore('2026-10-12'), '2026-10-12');
  assert.equal(addDays('2026-10-16', -1), '2026-10-15');
});

test('heatmap levels, streaks, and month labels follow edit days', () => {
  assert.equal(editHeatLevel(0), 0);
  assert.equal(editHeatLevel(1), 1);
  assert.equal(editHeatLevel(3), 2);
  assert.equal(editHeatLevel(6), 3);
  assert.equal(editHeatLevel(7), 4);
  assert.equal(editStreak(['2026-10-16', '2026-10-15', '2026-10-14'], '2026-10-16'), 3);
  assert.equal(editStreak(['2026-10-15'], '2026-10-16'), 1);
  assert.equal(editStreak(['2026-10-13'], '2026-10-16'), 0);
  const heatmap = buildEditHeatmap({ '2026-11-01': 4, '2026-11-03': 1 }, '2026-11-02', 3);
  assert.equal(heatmap.days.length, 21);
  assert.deepEqual(heatmap.months.map((month) => month.label), ['Oct', 'Nov']);
  const edited = heatmap.days.find((day) => day.date === '2026-11-01');
  const future = heatmap.days.find((day) => day.date === '2026-11-03');
  assert.equal(edited && edited.level, 3);
  assert.equal(future && future.future, true);
  assert.equal(future && future.count, 0);
  assert.equal(buildEditHeatmap({}, '2026-10-16').days.length, DOC_HEATMAP_WEEKS * 7);
});

test('word deltas use the nearest earlier sample and keep the first reading of a day', () => {
  const now = NOW.getTime();
  const samples = [
    { d: '2026-10-15', w: 1000, t: now - 20 * 3600000 },
    { d: '2026-10-09', w: 400, t: now - 7 * 86400000 },
  ];
  assert.equal(wordsTypedSince(samples, 1250, now, now - 86400000, 12 * 3600000), 250);
  assert.equal(wordsTypedSince(samples, 1250, now, now - 7 * 86400000, 36 * 3600000), 850);
  assert.equal(wordsTypedSince([{ d: '2026-09-01', w: 10, t: now - 40 * 86400000 }], 20, now, now - 86400000, 12 * 3600000), null);
  const kept = rememberWordSample(samples, 1300, NOW, '2026-10-16');
  const again = rememberWordSample(kept, 1800, NOW, '2026-10-16');
  assert.equal(again.find((sample) => sample.d === '2026-10-16')?.w, 1300);
  const overflow = rememberWordSample(Array.from({ length: DOC_WORD_SAMPLE_LIMIT }, (_item, index) => ({
    d: addDays('2020-01-01', index),
    w: index,
    t: index,
  })), 9, NOW, '2026-10-16');
  assert.equal(overflow.length, DOC_WORD_SAMPLE_LIMIT);
  assert.equal(overflow[overflow.length - 1].d, '2026-10-16');
});

function assigned(drive: EssayDrive, extra: { now?: Date; actorEmail?: string } = {}) {
  return {
    now: extra.now || NOW,
    keyConfigured: true,
    actorEmail: extra.actorEmail || ACTOR,
    driveForActor() { return Promise.resolve(drive); },
  };
}

test('a student read uses the assigned Drive account and the saved document, then stores the word sample', async () => {
  const store = new MemoryStore();
  await seed(store);
  const opened = driveFor(ACTOR, {
    name: 'Jamie Wong EE',
    text: 'one two three four',
    revisions: ['2026-10-16T01:00:00.000Z', '2026-10-16T02:00:00.000Z', '2026-10-15T03:00:00.000Z', 'not-a-date'],
  });
  let seenActor = '';
  const stats = await getMyEssayAnalytics(appFor(store, studentEmail), {
    now: NOW,
    keyConfigured: true,
    actorEmail: ACTOR,
    driveForActor(actorEmail) {
      seenActor = actorEmail;
      return Promise.resolve(opened.drive);
    },
  });
  assert.equal(seenActor, ACTOR);
  assert.deepEqual(opened.reads, [FILE_ID]);
  assert.equal(stats.ok, true);
  assert.equal(stats.wordCount, 4);
  assert.equal(stats.title, 'Jamie Wong EE');
  assert.equal(stats.streak, 2);
  assert.equal(stats.opens, null);
  assert.equal(stats.wordsDay, null);
  assert.equal(stats.wordsHint, 'Daily and weekly word changes appear after this document is checked again on a later day.');
  assert.equal(stats.days && stats.days.length, DOC_HEATMAP_WEEKS * 7);
  const today = (stats.days || []).find((day) => day.date === '2026-10-16');
  assert.equal(today && today.count, 2);
  assert.equal(today && today.level, 2);
  const saved = await store.get('docWordLogs', FILE_ID);
  const samples = JSON.parse(String(saved && saved.SamplesJson));
  assert.equal(samples[0].w, 4);
  assert.equal(JSON.stringify(saved).includes('oauth-refresh-token'), false);

  opened.drive.exportPlainText = async () => 'one two three four five six';
  const later = await getMyEssayAnalytics(appFor(store, studentEmail), assigned(opened.drive, { now: new Date('2026-10-16T13:00:00.000Z') }));
  assert.equal(later.wordCount, 6);
  const reread = JSON.parse(String((await store.get('docWordLogs', FILE_ID))?.SamplesJson));
  assert.equal(reread.length, 1);
  assert.equal(reread[0].w, 4);
});

test('essay stats follow the account saved by an admin', async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.setMeta('driveAccount', { actorEmail: ACTOR, updatedBy: coordinatorEmail, updatedAt: '2026-10-16T00:00:00.000Z' });
  const opened = driveFor(ACTOR, { text: 'from the assigned account' });
  let seenActor = '';
  const stats = await getMyEssayAnalytics(appFor(store, studentEmail), {
    now: NOW,
    keySource: DRIVE_KEY,
    driveForActor(actorEmail) {
      seenActor = actorEmail;
      return Promise.resolve(opened.drive);
    },
  });
  assert.equal(seenActor, ACTOR);
  assert.equal(stats.ok, true);
  assert.equal(stats.wordCount, 4);
  assert.deepEqual(opened.reads, [FILE_ID]);
});

test('missing documents, a missing Drive account, and the wrong Google account do not read a file', async () => {
  const store = new MemoryStore();
  await seed(store, '');
  let calls = 0;
  const missing = await getMyEssayAnalytics(appFor(store, studentEmail), assigned(driveFor(ACTOR, {}).drive));
  assert.deepEqual(missing, { ok: false, reason: 'missing' });

  await seed(store);
  const needsAccount = await getMyEssayAnalytics(appFor(store, studentEmail), {
    keySource: {},
    driveForActor() { calls += 1; return Promise.resolve(driveFor(ACTOR, {}).drive); },
  });
  assert.equal(needsAccount.ok, false);
  assert.equal(needsAccount.reason, 'config');
  assert.match(needsAccount.message || '', /connects the Google account/);
  assert.equal(calls, 0);

  const noKey = await getMyEssayAnalytics(appFor(store, studentEmail), {
    keyConfigured: false,
    actorEmail: ACTOR,
    driveForActor() { calls += 1; return Promise.resolve(driveFor(ACTOR, {}).drive); },
  });
  assert.equal(noKey.reason, 'config');
  assert.match(noKey.message || '', /configured for the assigned account/);
  assert.equal(calls, 0);

  const wrong = await getMyEssayAnalytics(appFor(store, studentEmail), {
    keyConfigured: true,
    actorEmail: ACTOR,
    driveForActor() { return Promise.resolve(driveFor(otherEmail, {}).drive); },
  });
  assert.equal(wrong.reason, 'auth');
  assert.equal(wrong.message, WRONG_ACCOUNT);
});

test('staff read the saved document through the assigned Drive account', async () => {
  const store = new MemoryStore();
  await seed(store);
  const opened = driveFor(ACTOR, {
    text: 'draft words here',
    revisions: ['2026-10-14T01:00:00.000Z'],
  });
  let calls = 0;
  const stats = await getStudentEssayAnalytics(appFor(store, supervisorEmail), studentEmail, '2026', 'supervisor', assigned(opened.drive));
  assert.equal(stats.ok, true);
  assert.deepEqual(opened.reads, [FILE_ID]);
  assert.equal(stats.wordCount, 3);

  await assert.rejects(
    getStudentEssayAnalytics(appFor(store, otherEmail), studentEmail, '2026', 'supervisor', {
      ...assigned(opened.drive),
      driveForActor() { calls += 1; return Promise.resolve(opened.drive); },
    }),
    /Access denied/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    getStudentEssayAnalytics(appFor(store, studentEmail), studentEmail, '2026', 'supervisor', assigned(opened.drive)),
    /Access denied/,
  );
  await assert.rejects(getMyEssayAnalytics(appFor(store, supervisorEmail), assigned(opened.drive)), /Access denied/);

  const coordinator = driveFor(ACTOR, { text: 'owned by the assigned account' });
  const owned = await getStudentEssayAnalytics(appFor(store, coordinatorEmail), studentEmail, '2026', 'coordinator', assigned(coordinator.drive));
  assert.equal(owned.ok, true);
  assert.deepEqual(coordinator.reads, [FILE_ID]);
});

test('a document the assigned account cannot open returns no history, and a failed revision list still returns the word count', async () => {
  const store = new MemoryStore();
  await seed(store);
  const blocked = await getMyEssayAnalytics(appFor(store, studentEmail), assigned(driveFor(ACTOR, { missing: true }).drive));
  assert.equal(blocked.reason, 'access');
  assert.equal(blocked.message, 'The Google account assigned for Drive cannot open this document.');
  assert.equal(blocked.days, undefined);

  const partial = driveFor(studentEmail, { text: 'still readable', failRevisions: true });
  const stats = await collectEssayAnalytics({
    fileId: FILE_ID,
    drive: partial.drive,
    log: memoryLog().log,
    now: NOW,
    timeZone: 'UTC',
  });
  assert.equal(stats.wordCount, 2);
  assert.equal(stats.revisionsLoaded, false);
  assert.equal(stats.streak, null);
  assert.equal(stats.days && stats.days.length, DOC_HEATMAP_WEEKS * 7);

  const pdf = driveFor(studentEmail, { mimeType: 'application/pdf', text: 'should not export' });
  const otherFile = await collectEssayAnalytics({
    fileId: FILE_ID,
    drive: pdf.drive,
    log: memoryLog().log,
    now: NOW,
    timeZone: 'UTC',
  });
  assert.equal(otherFile.wordCount, null);
  assert.equal(pdf.exports.length, 0);
  assert.match(otherFile.wordsHint || '', /Google Doc/);
});

test('Drive revision pages and a rejected credential stay on the API adapter', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    about: { get: async () => ({ data: { user: { emailAddress: studentEmail } } }) },
    files: {
      get: async () => ({ data: { id: FILE_ID, name: 'Essay', mimeType: DRIVE_DOCUMENT_MIME, trashed: false, modifiedTime: '2026-10-16T01:00:00.000Z' } }),
      export: async (args: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ op: 'export', args, options });
        return { data: Buffer.from('alpha  beta') };
      },
    },
    revisions: {
      list: async (args: Record<string, unknown>) => {
        calls.push({ op: 'revisions', args });
        if (!args.pageToken) return { data: { nextPageToken: 'next', revisions: [{ modifiedTime: '2026-10-15T00:00:00.000Z' }] } };
        return { data: { revisions: [{ modifiedTime: '2026-10-16T00:00:00.000Z' }] } };
      },
    },
  };
  const drive = essayDriveFromApi(api);
  assert.equal(await drive.exportPlainText(FILE_ID), 'alpha  beta');
  assert.deepEqual(await drive.listRevisionTimes(FILE_ID), ['2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z']);
  assert.equal((calls[0].options as { responseType?: string }).responseType, 'text');
  assert.equal((calls[2].args as { pageToken?: string }).pageToken, 'next');

  const expired = Object.assign(new Error('Invalid Credentials'), { response: { status: 401, data: { error: { message: 'Invalid Credentials' } } } });
  const denied = essayDriveFromApi({
    ...api,
    about: { get: async () => { throw expired; } },
  });
  await assert.rejects(denied.aboutEmail(), (error: unknown) => error instanceof HubError && error.message === RECONNECT);

  const hidden = Object.assign(new Error('File not found'), { response: { status: 404, data: { error: { message: 'File not found' } } } });
  const missing = essayDriveFromApi({
    ...api,
    files: { ...api.files, get: async () => { throw hidden; } },
  });
  await assert.rejects(missing.getFile(FILE_ID), /assigned for Drive cannot open/);
});
