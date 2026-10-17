import assert from 'node:assert/strict';
import test from 'node:test';
import { DRIVE_DOCUMENT_MIME, DRIVE_FOLDER_MIME, driveClientFromApi, parseDriveId, provisionStudents } from './drive';
import { Doc } from './util';

const ROOT = 'rootFolderId1';
const TEMPLATE = 'templateDocId1';
const ACTOR = 'coordinator@vsa.example.edu';
const STUDENT = 'jamie.wong@vsa.example.edu';

interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  parents: string[];
}

function harness(actorEmail = ACTOR) {
  const files = new Map<string, StoredFile>();
  files.set(ROOT, { id: ROOT, name: 'Cohort 2026', mimeType: DRIVE_FOLDER_MIME, trashed: false, parents: ['mine'] });
  files.set(TEMPLATE, { id: TEMPLATE, name: 'EE template', mimeType: DRIVE_DOCUMENT_MIME, trashed: false, parents: [ROOT] });
  const calls: Array<Record<string, unknown>> = [];
  let seq = 1;
  let notify = false;
  const api = {
    about: {
      get: async () => ({ data: { user: { emailAddress: actorEmail } } }),
    },
    files: {
      get: async (args: Record<string, unknown>) => {
        const file = files.get(String(args.fileId || ''));
        if (!file) {
          const error = new Error('File not found') as Error & { response?: { status: number } };
          error.response = { status: 404 };
          throw error;
        }
        return { data: file };
      },
      list: async (args: Record<string, unknown>) => {
        const q = String(args.q || '');
        calls.push({ op: 'list', q });
        const parent = /'([^']+)' in parents/.exec(q)?.[1] || '';
        const name = (/name = '((?:\\'|[^'])*)'/.exec(q)?.[1] || '').replace(/\\'/g, "'");
        const matches = [...files.values()].filter((file) => file.parents.includes(parent) && file.name === name && file.mimeType === DRIVE_FOLDER_MIME && !file.trashed);
        return { data: { files: matches.map((file) => ({ id: file.id, name: file.name })) } };
      },
      create: async (args: Record<string, unknown>) => {
        const body = args.requestBody as { name: string; mimeType: string; parents: string[] };
        calls.push({ op: 'create', body });
        const id = `folder-${seq++}`;
        const file = { id, name: body.name, mimeType: body.mimeType, trashed: false, parents: body.parents };
        files.set(id, file);
        return { data: file };
      },
      update: async () => ({ data: {} }),
      copy: async (args: Record<string, unknown>) => {
        const body = args.requestBody as { name: string; parents: string[] };
        calls.push({ op: 'copy', fileId: args.fileId, body });
        const id = `doc-${seq++}`;
        const file = { id, name: body.name, mimeType: DRIVE_DOCUMENT_MIME, trashed: false, parents: body.parents };
        files.set(id, file);
        return { data: file };
      },
    },
    permissions: {
      create: async (args: Record<string, unknown>) => {
        calls.push({ op: 'share', args });
        if (notify) throw new Error('You must notify the user of this share');
        return { data: {} };
      },
    },
  };
  return {
    api,
    calls,
    files,
    requireNotify() { notify = true; },
  };
}

function member(): Doc {
  return {
    StudentId: STUDENT,
    'Display Name': 'Jamie Wong',
    'Student ID': '20260001',
    'Student Email': STUDENT,
    'Family Email': 'family.wong@vsa.example.edu',
    EEFolder: '',
    EEDoc: '',
  };
}

function input(drive: ReturnType<typeof harness>['api'], roster: Doc[], dryRun = false) {
  return {
    actorEmail: ACTOR,
    dryRun,
    roster,
    studentIds: [STUDENT],
    rootFolderId: ROOT,
    templateId: TEMPLATE,
    prefix: 'EE ',
    suffix: '',
    shareStudent: true,
    shareParent: true,
    drive: driveClientFromApi(drive),
  };
}

test('drive ids come from folder links, doc links, and bare ids', () => {
  assert.equal(parseDriveId('https://drive.google.com/drive/folders/folderId_1234567890?usp=sharing'), 'folderId_1234567890');
  assert.equal(parseDriveId('https://docs.google.com/document/d/docId_1234567890/edit'), 'docId_1234567890');
  assert.equal(parseDriveId('https://drive.google.com/open?id=openId_1234567890'), 'openId_1234567890');
  assert.equal(parseDriveId('bareId_1234567890'), 'bareId_1234567890');
  assert.equal(parseDriveId('not a link'), '');
});

test('provisioning creates a folder, shares it silently, and copies the EE document', async () => {
  const drive = harness();
  const record = member();
  const result = await provisionStudents(input(drive.api, [record]));
  const student = result.students[0];
  assert.equal(student.status, 'created');
  assert.equal(student.folderName, 'EE Jamie Wong');
  assert.equal(student.doc.status, 'copied');
  assert.equal(record.EEFolder, student.url);
  assert.equal(record.EEDoc, student.doc.url);
  assert.match(record.EEDoc, /^https:\/\/docs\.google\.com\/document\/d\/doc-/);
  const created = drive.calls.find((call) => call.op === 'create');
  assert.equal((created?.body as { name: string }).name, 'EE Jamie Wong');
  assert.deepEqual((created?.body as { parents: string[] }).parents, [ROOT]);
  const copied = drive.calls.find((call) => call.op === 'copy');
  assert.equal(copied?.fileId, TEMPLATE);
  assert.equal((copied?.body as { name: string }).name, 'EE Jamie Wong');
  assert.deepEqual((copied?.body as { parents: string[] }).parents, [record.EEFolder.split('/').pop()]);
  const shares = drive.calls.filter((call) => call.op === 'share');
  assert.equal(shares.length, 4);
  assert.ok(shares.every((call) => (call.args as { sendNotificationEmail: boolean }).sendNotificationEmail === false));
  assert.equal((shares[0].args as { requestBody: { role: string; emailAddress: string } }).requestBody.role, 'writer');
  assert.equal((shares[0].args as { requestBody: { emailAddress: string } }).requestBody.emailAddress, STUDENT);

  const again = await provisionStudents(input(drive.api, [record]));
  assert.equal(again.students[0].status, 'unchanged');
  assert.equal(again.students[0].doc.status, 'in_place');
  assert.equal(drive.calls.filter((call) => call.op === 'copy').length, 1);
  assert.equal(drive.calls.filter((call) => call.op === 'create').length, 1);
  assert.equal(record.EEDoc, student.doc.url);
});

test('a check does not create folders or documents', async () => {
  const drive = harness();
  const record = member();
  const result = await provisionStudents(input(drive.api, [record], true));
  assert.equal(result.students[0].status, 'would_create');
  assert.equal(result.students[0].doc.status, 'would_copy');
  assert.equal(result.students[0].doc.message, 'Would copy the EE document into the folder.');
  assert.equal(record.EEFolder, '');
  assert.equal(record.EEDoc, '');
  assert.equal(drive.calls.some((call) => call.op === 'create' || call.op === 'copy' || call.op === 'share'), false);
});

test('a Drive account that is not the connected account creates nothing', async () => {
  const drive = harness('other@vsa.example.edu');
  await assert.rejects(() => provisionStudents(input(drive.api, [member()])), /connected Google account/);
  assert.equal(drive.calls.some((call) => call.op === 'create' || call.op === 'copy'), false);
});

test('the template must be a Google Doc', async () => {
  const drive = harness();
  drive.files.get(TEMPLATE)!.mimeType = 'application/vnd.google-apps.spreadsheet';
  await assert.rejects(() => provisionStudents(input(drive.api, [member()])), /Google Doc/);
  assert.equal(drive.calls.some((call) => call.op === 'create'), false);
});

test('a missing saved document is copied, and a silent share that Google refuses is reported', async () => {
  const drive = harness();
  drive.requireNotify();
  const record = member();
  record.EEDoc = 'https://docs.google.com/document/d/missingDocId123/edit';
  const result = await provisionStudents(input(drive.api, [record]));
  assert.equal(result.students[0].doc.status, 'copied');
  assert.notEqual(record.EEDoc, 'https://docs.google.com/document/d/missingDocId123/edit');
  assert.ok(result.students[0].shares.some((share) => share.status === 'failed' && /without sending an email/.test(share.reason)));
  assert.equal((drive.calls.find((call) => call.op === 'share')?.args as { sendNotificationEmail: boolean }).sendNotificationEmail, false);
});

test('provisioning shares the cohort Student Email, not the StudentId', async () => {
  const record = member();
  record.StudentId = 'hub.login@vsa.example.edu';
  record['Student Email'] = 'jamie.drive@vsa.example.edu';
  const drive = harness();
  const result = await provisionStudents({
    ...input(drive.api, [record]),
    studentIds: ['hub.login@vsa.example.edu'],
  });
  const shares = drive.calls.filter((call) => call.op === 'share');
  const writers = shares.filter((call) => (call.args as { requestBody: { role: string } }).requestBody.role === 'writer');
  assert.equal(writers.length, 2);
  writers.forEach((call) => {
    assert.equal((call.args as { requestBody: { emailAddress: string } }).requestBody.emailAddress, 'jamie.drive@vsa.example.edu');
  });
  assert.equal(shares.some((call) => (call.args as { requestBody: { emailAddress: string } }).requestBody.emailAddress === 'hub.login@vsa.example.edu'), false);
  assert.equal(result.students[0].shares.find((share) => share.who === 'student')?.email, 'jamie.drive@vsa.example.edu');

  const previewDrive = harness();
  const previewRecord = member();
  previewRecord.StudentId = 'hub.login@vsa.example.edu';
  previewRecord['Student Email'] = 'jamie.drive@vsa.example.edu';
  const preview = await provisionStudents({
    ...input(previewDrive.api, [previewRecord], true),
    studentIds: ['hub.login@vsa.example.edu'],
  });
  const studentShare = preview.students[0].shares.find((share) => share.who === 'student');
  assert.equal(studentShare?.email, 'jamie.drive@vsa.example.edu');
  assert.equal(studentShare?.status, 'would_share');
  assert.equal(previewDrive.calls.some((call) => call.op === 'share'), false);

  const missingDrive = harness();
  const missingRecord = member();
  missingRecord.StudentId = 'hub.login@vsa.example.edu';
  missingRecord['Student Email'] = '';
  const missing = await provisionStudents({
    ...input(missingDrive.api, [missingRecord]),
    studentIds: ['hub.login@vsa.example.edu'],
  });
  const missingShares = missingDrive.calls.filter((call) => call.op === 'share');
  assert.equal(missingShares.length, 2);
  assert.equal(missingShares.some((call) => (call.args as { requestBody: { emailAddress: string } }).requestBody.emailAddress === 'hub.login@vsa.example.edu'), false);
  assert.equal(missing.students[0].shares.find((share) => share.who === 'student')?.status, 'skipped');
});
