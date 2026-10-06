import { requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, requireAdmin } from './session';
import { Doc, HubError, normalizeEmail, text, toBoolean, validateEmail } from './util';

const NAME_LIMIT = 80;
const BATCH_LIMIT = 8;

export function driveConfigured(): boolean {
  return !!process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
}

export function parseDriveFolderId(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const folderMatch = /\/folders\/([a-zA-Z0-9_-]+)/.exec(raw);
  if (folderMatch) return folderMatch[1];
  const idMatch = /[?&]id=([a-zA-Z0-9_-]+)/.exec(raw);
  if (idMatch) return idMatch[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;
  return '';
}

function sanitizeName(value: string): string {
  return String(value || '').replace(/[/\\]/g, '').replace(/[\u0000-\u001f]/g, '').trim();
}

function displayName(record: Doc): string {
  return text(record['Display Name']) || text(record.DisplayName) || text(record['Preferred Name'])
    || [text(record['First Name']), text(record.Surname)].filter(Boolean).join(' ')
    || normalizeEmail(record.StudentId);
}

function expectedNames(records: Doc[], prefix: string, suffix: string) {
  const prepared = records.map((record) => ({
    studentId: normalizeEmail(record.StudentId),
    baseName: sanitizeName(String(prefix) + displayName(record) + String(suffix)),
    token: text(record['Student ID']) || normalizeEmail(record.StudentId),
  }));
  const counts: Record<string, number> = {};
  prepared.forEach((item) => { if (item.baseName) counts[item.baseName] = (counts[item.baseName] || 0) + 1; });
  const names: Record<string, string> = {};
  const used: Record<string, boolean> = {};
  prepared.forEach((item) => {
    if (!item.baseName) { names[item.studentId] = ''; return; }
    let name = counts[item.baseName] > 1 ? sanitizeName(`${item.baseName} (${item.token})`) : item.baseName;
    if (used[name]) name = sanitizeName(`${name} ${item.studentId}`);
    used[name] = true;
    names[item.studentId] = name;
  });
  return names;
}

function normalizeOptions(options: any) {
  const source = options || {};
  const prefix = source.prefix === undefined || source.prefix === null ? '' : String(source.prefix);
  const suffix = source.suffix === undefined || source.suffix === null ? '' : String(source.suffix);
  if (prefix.length > NAME_LIMIT || suffix.length > NAME_LIMIT) throw new HubError('Prefix and suffix must be 80 characters or fewer.');
  return {
    rootFolderId: parseDriveFolderId(source.rootFolderId) || text(source.rootFolderId),
    prefix,
    suffix,
    shareStudent: toBoolean(source.shareStudent),
    shareParent: toBoolean(source.shareParent),
  };
}

async function present(app: App, cohortId: string) {
  const cohort = await requireCohort(app, cohortId, true);
  const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
  const rootId = text(record?.DriveRootFolderId);
  let rootName = '';
  let rootProblem = '';
  if (!driveConfigured()) rootProblem = 'Drive sync is not configured on this server.';
  else if (rootId) {
    try {
      const folder = await openFolder(rootId);
      rootName = folder.name || '';
    } catch (error) {
      rootProblem = error instanceof Error ? error.message : 'The saved cohort folder could not be opened.';
    }
  }
  return {
    cohortId: cohort.id,
    rootFolderId: rootId,
    rootName,
    rootUrl: rootId ? `https://drive.google.com/drive/folders/${rootId}` : '',
    rootProblem,
    prefix: text(record?.FolderPrefix),
    suffix: text(record?.FolderSuffix),
  };
}

export async function getCohortDriveSettings(app: App, cohortId: unknown) {
  await requireAdmin(app, 'GET_COHORT_DRIVE_SETTINGS');
  return present(app, text(cohortId));
}

export async function saveCohortDriveSettings(app: App, cohortId: unknown, settings: any) {
  const user = await requireAdmin(app, 'SAVE_COHORT_DRIVE_SETTINGS');
  const options = normalizeOptions(settings);
  if (!options.rootFolderId) throw new HubError('Choose a cohort root folder.');
  return audited(app, user, 'SAVE_COHORT_DRIVE_SETTINGS', { cohort: text(cohortId) }, async () => {
    const cohort = await requireCohort(app, text(cohortId), true);
    if (driveConfigured()) await openFolder(options.rootFolderId);
    const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
    if (!record) throw new HubError('Save this cohort in the Cohorts section before creating Drive folders.');
    record.DriveRootFolderId = options.rootFolderId;
    record.FolderPrefix = options.prefix;
    record.FolderSuffix = options.suffix;
    await app.store.set(COLLECTIONS.cohorts, cohort.id, record);
    return present(app, cohort.id);
  });
}

function selectedIds(values: unknown): string[] {
  if (!Array.isArray(values) || !values.length) throw new HubError('Select at least one student.');
  if (values.length > BATCH_LIMIT) throw new HubError('Work on 8 students at a time.');
  const seen: Record<string, boolean> = {};
  return values.map((value) => {
    const studentId = validateEmail(value, 'StudentId');
    if (seen[studentId]) throw new HubError('A student was selected more than once.');
    seen[studentId] = true;
    return studentId;
  });
}

export async function checkCohortDriveFolders(app: App, cohortId: unknown, selectedStudentIds: unknown, options: any) {
  return runDrive(app, cohortId, selectedStudentIds, options, true);
}

export async function syncCohortDriveFolders(app: App, cohortId: unknown, selectedStudentIds: unknown, options: any) {
  return runDrive(app, cohortId, selectedStudentIds, options, false);
}

async function runDrive(app: App, cohortId: unknown, selectedStudentIds: unknown, options: any, dryRun: boolean) {
  const user = await requireAdmin(app, dryRun ? 'CHECK_COHORT_DRIVE_FOLDERS' : 'SYNC_COHORT_DRIVE_FOLDERS');
  const driveOptions = normalizeOptions(options);
  const studentIds = selectedIds(selectedStudentIds);
  const action = dryRun ? 'CHECK_COHORT_DRIVE_FOLDERS' : 'SYNC_COHORT_DRIVE_FOLDERS';
  return audited(app, user, action, { cohort: text(cohortId), studentCount: studentIds.length, shareStudent: driveOptions.shareStudent, shareParent: driveOptions.shareParent }, async () => {
    if (!driveConfigured()) throw new HubError('Drive sync is not configured.');
    const cohort = await requireCohort(app, text(cohortId), true);
    const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
    const rootId = driveOptions.rootFolderId || text(record?.DriveRootFolderId);
    if (!rootId) throw new HubError('Choose a cohort root folder.');
    await openFolder(rootId);
    if (!dryRun && record) {
      record.DriveRootFolderId = rootId;
      record.FolderPrefix = driveOptions.prefix;
      record.FolderSuffix = driveOptions.suffix;
      await app.store.set(COLLECTIONS.cohorts, cohort.id, record);
    }
    const roster = await app.store.listMembers(cohort.id);
    const names = expectedNames(roster, driveOptions.prefix, driveOptions.suffix);
    const byId: Record<string, Doc> = {};
    roster.forEach((member) => { byId[normalizeEmail(member.StudentId)] = member; });
    const students = [];
    for (const studentId of studentIds) {
      const member = byId[studentId];
      if (!member) {
        students.push({ studentId, displayName: studentId, folderName: '', status: 'error', url: '', message: `Student is not in this cohort: ${studentId}`, shares: [] });
        continue;
      }
      students.push(await syncOne(app, cohort.id, member, names, rootId, driveOptions, dryRun));
    }
    const result: Doc = { students, dryRun };
    if (!dryRun) result.settings = await present(app, cohort.id);
    return result;
  });
}

async function syncOne(app: App, cohortId: string, member: Doc, names: Record<string, string>, rootId: string, options: ReturnType<typeof normalizeOptions>, dryRun: boolean) {
  const studentId = normalizeEmail(member.StudentId);
  const folderName = names[studentId] || '';
  const base = { studentId, displayName: displayName(member), folderName, url: '', shares: [] as any[] };
  if (!folderName) return { ...base, status: 'error', message: 'The folder name is empty. Enter a prefix, suffix, or display name.' };
  if (folderName.length > 200) return { ...base, status: 'error', message: 'The folder name is too long.' };
  const drive = await client();
  const existingId = parseDriveFolderId(member.EEFolder);
  let folderId = existingId;
  let created = false;
  let relinked = false;
  if (!folderId) {
    const matches = await childFolders(drive, rootId, folderName);
    if (matches.length > 1) return { ...base, status: 'ambiguous', message: `More than one folder in the cohort folder is named ${folderName}.` };
    if (matches.length === 1) { folderId = matches[0].id; relinked = true; }
    else if (dryRun) {
      return { ...base, status: 'would_create', message: `Would create ${folderName}.`, shares: previewShares(member, options) };
    } else {
      const createdFolder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] },
        fields: 'id,name',
        supportsAllDrives: true,
      });
      folderId = createdFolder.data.id || '';
      created = true;
    }
  }
  if (!folderId) return { ...base, status: 'error', message: 'The student folder could not be created.' };
  if (folderId === rootId) return { ...base, status: 'error', message: 'The student folder cannot be the cohort folder itself.' };
  const folder = await openFolder(folderId);
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  if (!dryRun) {
    const parents = folder.parents || [];
    const moved = !parents.includes(rootId);
    const renamed = folder.name !== folderName;
    if (moved || renamed) {
      await drive.files.update({
        fileId: folderId,
        addParents: moved ? rootId : undefined,
        removeParents: moved ? parents.join(',') : undefined,
        requestBody: renamed ? { name: folderName } : undefined,
        supportsAllDrives: true,
      });
    }
    member.EEFolder = url;
    await app.store.setMember(cohortId, studentId, member);
  }
  const shares = dryRun ? previewShares(member, options) : await applyShares(drive, folderId, member, options);
  let status = 'unchanged';
  let message = 'Folder is already in place.';
  if (dryRun && relinked) { status = 'would_relink'; message = 'Would relink the existing folder.'; }
  else if (created) { status = 'created'; message = 'Created the folder.'; }
  else if (relinked) { status = 'relinked'; message = 'Relinked the existing folder.'; }
  return { ...base, status, url, message, shares };
}

function previewShares(member: Doc, options: ReturnType<typeof normalizeOptions>) {
  const shares = [];
  if (options.shareStudent) shares.push(previewShare(member.StudentId, 'writer', 'student'));
  if (options.shareParent) shares.push(previewShare(member['Family Email'], 'reader', 'parent'));
  return shares;
}

function previewShare(email: unknown, role: string, who: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { who, email: '', role, status: 'skipped', reason: 'No email address.' };
  return { who, email: normalized, role, status: 'would_share', reason: '' };
}

async function applyShares(drive: any, folderId: string, member: Doc, options: ReturnType<typeof normalizeOptions>) {
  const shares = [];
  if (options.shareStudent) shares.push(await share(drive, folderId, member.StudentId, 'writer', 'student'));
  if (options.shareParent) shares.push(await share(drive, folderId, member['Family Email'], 'reader', 'parent'));
  return shares;
}

async function share(drive: any, fileId: string, email: unknown, role: string, who: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { who, email: '', role, status: 'skipped', reason: 'No email address.' };
  try {
    await drive.permissions.create({
      fileId,
      sendNotificationEmail: false,
      supportsAllDrives: true,
      requestBody: { type: 'user', role, emailAddress: normalized },
    });
    return { who, email: normalized, role, status: 'shared' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already has access|already exists|duplicate/i.test(message)) return { who, email: normalized, role, status: 'already' };
    return { who, email: normalized, role, status: 'failed', reason: 'Could not share this folder.' };
  }
}

async function client() {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '';
  let credentials: any;
  try { credentials = JSON.parse(raw); }
  catch { throw new HubError('Drive service account JSON is invalid.'); }
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

async function openFolder(folderId: string) {
  const drive = await client();
  try {
    const file = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType,trashed,parents', supportsAllDrives: true });
    if (file.data.trashed) throw new HubError('The cohort root folder could not be opened. Choose a folder that is not in the trash.');
    if (file.data.mimeType !== 'application/vnd.google-apps.folder') throw new HubError('Choose a Google Drive folder.');
    return { id: file.data.id || folderId, name: file.data.name || '', parents: file.data.parents || [] };
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError('The cohort root folder could not be opened. Choose a folder that is not in the trash.');
  }
}

async function childFolders(drive: any, rootId: string, name: string) {
  const escaped = name.replace(/'/g, "\\'");
  const listed = await drive.files.list({
    q: `'${rootId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return listed.data.files || [];
}
