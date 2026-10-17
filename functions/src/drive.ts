import {
  DriveAccountStatus,
  presentDriveAccount,
  requireDriveActor,
  writeDriveActor,
} from './driveAccount';
import { getGoogleAuth, GOOGLE_AUTH_REJECTED, GoogleOAuthSource } from './googleAuth';
import { requireCohort } from './roster';
import { COLLECTIONS } from './schema';
import { App, audited, requireAdmin } from './session';
import { Doc, driveNamePart, HubError, normalizeEmail, text, toBoolean, validateEmail } from './util';

const NAME_LIMIT = 80;
const BATCH_LIMIT = 8;
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_DOCUMENT_MIME = 'application/vnd.google-apps.document';

export const RECONNECT = GOOGLE_AUTH_REJECTED;
export const WRONG_ACCOUNT = 'Drive is not running as the connected Google account.';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  trashed: boolean;
  parents: string[];
}

export interface DriveClient {
  aboutEmail(): Promise<string>;
  getFile(fileId: string): Promise<DriveFile>;
  listChildFolders(parentId: string, name: string): Promise<Array<{ id: string; name: string }>>;
  createFolder(name: string, parentId: string): Promise<{ id: string; name: string }>;
  updateFile(fileId: string, changes: { name?: string; addParents?: string[]; removeParents?: string[] }): Promise<void>;
  copyFile(fileId: string, name: string, parentId: string): Promise<{ id: string; name: string }>;
  share(fileId: string, email: string, role: string): Promise<'shared' | 'already' | 'notify_required'>;
}

interface DriveApiFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  trashed?: boolean | null;
  parents?: string[] | null;
}

interface DriveApi {
  about: {
    get(args: { fields: string }): Promise<{ data: { user?: { emailAddress?: string | null } | null } }>;
  };
  files: {
    get(args: Record<string, unknown>): Promise<{ data: DriveApiFile }>;
    list(args: Record<string, unknown>): Promise<{ data: { files?: DriveApiFile[] | null } }>;
    create(args: Record<string, unknown>): Promise<{ data: DriveApiFile }>;
    update(args: Record<string, unknown>): Promise<{ data: DriveApiFile }>;
    copy(args: Record<string, unknown>): Promise<{ data: DriveApiFile }>;
  };
  permissions: {
    create(args: Record<string, unknown>): Promise<{ data: Record<string, unknown> }>;
  };
}

interface DriveOptions {
  rootFolderId: string;
  templateId: string;
  prefix: string;
  suffix: string;
  shareStudent: boolean;
  shareParent: boolean;
}

interface ShareResult {
  who: string;
  email: string;
  role: string;
  status: string;
  reason: string;
}

interface DocResult {
  status: string;
  url: string;
  message: string;
  id: string;
}

export interface ProvisionInput {
  actorEmail: string;
  dryRun: boolean;
  roster: Doc[];
  studentIds: string[];
  rootFolderId: string;
  templateId: string;
  prefix: string;
  suffix: string;
  shareStudent: boolean;
  shareParent: boolean;
  drive: DriveClient;
  persistMember?: (member: Doc) => Promise<void>;
}

export function parseDriveId(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (match) return match[1];
  }
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;
  return '';
}

export function parseDriveFolderId(value: unknown): string {
  return parseDriveId(value);
}

function folderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

function documentUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
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

function isNotFound(error: unknown): boolean {
  return statusCode(error) === 404 || /not found/i.test(googleMessage(error));
}

function isAuthFailure(error: unknown): boolean {
  return statusCode(error) === 401 || /invalid credentials|invalid authentication|unauthorized/i.test(googleMessage(error));
}

function asHub(error: unknown, fallback: string): HubError {
  if (error instanceof HubError) return error;
  if (isAuthFailure(error)) return new HubError(RECONNECT);
  return new HubError(fallback);
}

function isReconnect(error: unknown): boolean {
  return error instanceof HubError && (error.message === RECONNECT || error.message === WRONG_ACCOUNT);
}

export function driveClientFromApi(api: DriveApi): DriveClient {
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
          fields: 'id,name,mimeType,trashed,parents',
          supportsAllDrives: true,
        });
        return {
          id: file.data.id || fileId,
          name: file.data.name || '',
          mimeType: file.data.mimeType || '',
          trashed: !!file.data.trashed,
          parents: file.data.parents || [],
        };
      } catch (error) {
        if (isNotFound(error)) throw new HubError('Drive file not found.');
        throw asHub(error, 'That Drive file could not be opened.');
      }
    },
    async listChildFolders(parentId, name) {
      const escaped = name.replace(/'/g, "\\'");
      try {
        const listed = await api.files.list({
          q: `'${parentId}' in parents and name = '${escaped}' and mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
          fields: 'files(id,name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageSize: 10,
        });
        return (listed.data.files || []).map((file) => ({ id: file.id || '', name: file.name || '' }));
      } catch (error) {
        throw asHub(error, 'The cohort folder could not be searched.');
      }
    },
    async createFolder(name, parentId) {
      try {
        const created = await api.files.create({
          requestBody: { name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] },
          fields: 'id,name',
          supportsAllDrives: true,
        });
        if (!created.data.id) throw new HubError('The student folder could not be created.');
        return { id: created.data.id, name: created.data.name || name };
      } catch (error) {
        throw asHub(error, 'The student folder could not be created.');
      }
    },
    async updateFile(fileId, changes) {
      try {
        await api.files.update({
          fileId,
          addParents: changes.addParents && changes.addParents.length ? changes.addParents.join(',') : undefined,
          removeParents: changes.removeParents && changes.removeParents.length ? changes.removeParents.join(',') : undefined,
          requestBody: changes.name ? { name: changes.name } : undefined,
          supportsAllDrives: true,
        });
      } catch (error) {
        throw asHub(error, 'The student folder could not be updated.');
      }
    },
    async copyFile(fileId, name, parentId) {
      try {
        const copied = await api.files.copy({
          fileId,
          requestBody: { name, parents: [parentId] },
          fields: 'id,name',
          supportsAllDrives: true,
        });
        if (!copied.data.id) throw new HubError('The EE document could not be copied.');
        return { id: copied.data.id, name: copied.data.name || name };
      } catch (error) {
        throw asHub(error, 'The EE document could not be copied.');
      }
    },
    async share(fileId, email, role) {
      try {
        await api.permissions.create({
          fileId,
          sendNotificationEmail: false,
          supportsAllDrives: true,
          requestBody: { type: 'user', role, emailAddress: email },
        });
        return 'shared';
      } catch (error) {
        const message = googleMessage(error);
        if (/already has access|already exists|duplicate/i.test(message)) return 'already';
        if (/notif/i.test(message)) return 'notify_required';
        throw asHub(error, 'Could not share this file.');
      }
    },
  };
}

export async function driveClient(source?: GoogleOAuthSource): Promise<DriveClient> {
  const auth = await getGoogleAuth(source);
  const { google } = await import('googleapis');
  return driveClientFromApi(google.drive({ version: 'v3', auth }) as unknown as DriveApi);
}

export async function assertDriveAccount(drive: DriveClient, email: string): Promise<string> {
  let owner = '';
  try {
    owner = normalizeEmail(await drive.aboutEmail());
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError(RECONNECT);
  }
  const expected = normalizeEmail(email);
  if (!owner) throw new HubError(RECONNECT);
  if (expected && owner !== expected) throw new HubError(WRONG_ACCOUNT);
  return owner;
}

function driveIdentity(account: DriveAccountStatus, problem = '') {
  return {
    driveActor: account.actorEmail,
    driveReady: account.configured && !problem,
    driveProblem: problem,
  };
}

export async function getDriveAccount(app: App): Promise<DriveAccountStatus> {
  await requireAdmin(app, 'GET_DRIVE_ACCOUNT');
  return presentDriveAccount(app);
}

export async function saveDriveAccount(
  app: App,
  settings: unknown,
  deps?: { driveForActor?: (actorEmail: string) => Promise<DriveClient>; oauth?: GoogleOAuthSource },
): Promise<DriveAccountStatus> {
  const user = await requireAdmin(app, 'SAVE_DRIVE_ACCOUNT');
  const requested = text((settings as Doc | null)?.actorEmail);
  if (requested) validateEmail(requested, 'Google account');
  const detail: Doc = requested ? { actorEmail: requested } : {};
  return audited(app, user, 'SAVE_DRIVE_ACCOUNT', detail, async () => {
    const current = await presentDriveAccount(app, deps?.oauth);
    if (!current.configured) throw new HubError(current.error);
    const drive = await (deps?.driveForActor || (() => driveClient(deps?.oauth)))(requested);
    const owner = await assertDriveAccount(drive, requested);
    detail.actorEmail = owner;
    await writeDriveActor(app, owner, user.email);
    return presentDriveAccount(app, deps?.oauth);
  });
}

function normalizeOptions(options: unknown): DriveOptions {
  const source = (options || {}) as Doc;
  const prefix = source.prefix === undefined || source.prefix === null ? '' : String(source.prefix);
  const suffix = source.suffix === undefined || source.suffix === null ? '' : String(source.suffix);
  if (prefix.length > NAME_LIMIT || suffix.length > NAME_LIMIT) throw new HubError('Prefix and suffix must be 80 characters or fewer.');
  const rootRaw = text(source.rootFolderId);
  const rootFolderId = parseDriveId(rootRaw);
  if (rootRaw && !rootFolderId) throw new HubError('Paste a Google Drive folder link.');
  const templateRaw = text(source.templateId || source.templateUrl);
  const templateId = parseDriveId(templateRaw);
  if (templateRaw && !templateId) throw new HubError('Paste a Google Doc template link.');
  return {
    rootFolderId,
    templateId,
    prefix,
    suffix,
    shareStudent: toBoolean(source.shareStudent),
    shareParent: toBoolean(source.shareParent),
  };
}

function presentRecord(cohortId: string, record: Doc | null) {
  const rootId = text(record?.DriveRootFolderId);
  const templateId = text(record?.EEDocTemplateId);
  return {
    cohortId,
    rootFolderId: rootId,
    rootName: '',
    rootUrl: rootId ? folderUrl(rootId) : '',
    rootProblem: '',
    prefix: driveNamePart(record?.FolderPrefix),
    suffix: driveNamePart(record?.FolderSuffix),
    templateId,
    templateName: '',
    templateUrl: templateId ? documentUrl(templateId) : '',
    templateProblem: '',
  };
}

async function present(app: App, cohortId: string) {
  const cohort = await requireCohort(app, cohortId, true);
  const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
  return presentRecord(cohort.id, record);
}

async function requireFolder(drive: DriveClient, folderId: string, missingMessage: string): Promise<DriveFile> {
  let file: DriveFile;
  try {
    file = await drive.getFile(folderId);
  } catch (error) {
    if (error instanceof HubError && error.message === 'Drive file not found.') throw new HubError(missingMessage);
    throw error;
  }
  if (file.trashed) throw new HubError(missingMessage);
  if (file.mimeType !== DRIVE_FOLDER_MIME) throw new HubError('Choose a Google Drive folder.');
  return file;
}

async function requireTemplate(drive: DriveClient, fileId: string): Promise<DriveFile> {
  let file: DriveFile;
  try {
    file = await drive.getFile(fileId);
  } catch (error) {
    if (error instanceof HubError && error.message === 'Drive file not found.') throw new HubError('The EE document template could not be opened.');
    throw error;
  }
  if (file.trashed) throw new HubError('The EE document template is in the trash.');
  if (file.mimeType !== DRIVE_DOCUMENT_MIME) throw new HubError('The EE template must be a Google Doc.');
  return file;
}

async function describeAccess(drive: DriveClient, rootId: string, templateId: string) {
  const described = { rootName: '', rootProblem: '', templateName: '', templateProblem: '' };
  if (rootId) {
    try {
      described.rootName = (await requireFolder(drive, rootId, 'The cohort root folder could not be opened. Choose a folder that is not in the trash.')).name;
    } catch (error) {
      if (isReconnect(error)) throw error;
      described.rootProblem = error instanceof Error ? error.message : 'The cohort root folder could not be opened.';
    }
  }
  if (templateId) {
    try {
      described.templateName = (await requireTemplate(drive, templateId)).name;
    } catch (error) {
      if (isReconnect(error)) throw error;
      described.templateProblem = error instanceof Error ? error.message : 'The EE document template could not be opened.';
    }
  }
  return described;
}

export async function getCohortDriveSettings(app: App, cohortId: unknown, settings?: unknown) {
  await requireAdmin(app, 'GET_COHORT_DRIVE_SETTINGS');
  void settings;
  const presented = await present(app, text(cohortId));
  const account = await presentDriveAccount(app);
  if (!account.configured) return { ...presented, ...driveIdentity(account, account.error) };
  try {
    const drive = await driveClient();
    const owner = await assertDriveAccount(drive, account.actorEmail);
    const described = await describeAccess(drive, presented.rootFolderId, presented.templateId);
    return { ...presented, ...described, ...driveIdentity({ ...account, actorEmail: owner }) };
  } catch (error) {
    const problem = error instanceof Error ? error.message : account.error;
    return { ...presented, ...driveIdentity(account, problem) };
  }
}

export async function saveCohortDriveSettings(app: App, cohortId: unknown, settings: unknown) {
  const user = await requireAdmin(app, 'SAVE_COHORT_DRIVE_SETTINGS');
  const options = normalizeOptions(settings);
  if (!options.rootFolderId) throw new HubError('Paste a Google Drive folder link.');
  const account = await presentDriveAccount(app);
  return audited(app, user, 'SAVE_COHORT_DRIVE_SETTINGS', { cohort: text(cohortId) }, async () => {
    const cohort = await requireCohort(app, text(cohortId), true);
    const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
    if (!record) throw new HubError('Save this cohort in the Cohorts section before creating Drive folders.');
    let rootName = '';
    let templateName = '';
    let actorEmail = account.actorEmail;
    if (account.configured) {
      const drive = await driveClient();
      actorEmail = await assertDriveAccount(drive, account.actorEmail);
      rootName = (await requireFolder(drive, options.rootFolderId, 'The cohort root folder could not be opened. Choose a folder that is not in the trash.')).name;
      if (options.templateId) templateName = (await requireTemplate(drive, options.templateId)).name;
    }
    record.DriveRootFolderId = options.rootFolderId;
    record.FolderPrefix = options.prefix;
    record.FolderSuffix = options.suffix;
    record.EEDocTemplateId = options.templateId;
    await app.store.set(COLLECTIONS.cohorts, cohort.id, record);
    return { ...presentRecord(cohort.id, record), rootName, templateName, ...driveIdentity({ ...account, actorEmail }) };
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

export async function checkCohortDriveFolders(app: App, cohortId: unknown, selectedStudentIds: unknown, options: unknown) {
  return runDrive(app, cohortId, selectedStudentIds, options, true);
}

export async function syncCohortDriveFolders(app: App, cohortId: unknown, selectedStudentIds: unknown, options: unknown) {
  return runDrive(app, cohortId, selectedStudentIds, options, false);
}

async function runDrive(app: App, cohortId: unknown, selectedStudentIds: unknown, options: unknown, dryRun: boolean) {
  const user = await requireAdmin(app, dryRun ? 'CHECK_COHORT_DRIVE_FOLDERS' : 'SYNC_COHORT_DRIVE_FOLDERS');
  const driveOptions = normalizeOptions(options);
  const studentIds = selectedIds(selectedStudentIds);
  const account = await requireDriveActor(app);
  const action = dryRun ? 'CHECK_COHORT_DRIVE_FOLDERS' : 'SYNC_COHORT_DRIVE_FOLDERS';
  return audited(app, user, action, {
    cohort: text(cohortId),
    studentCount: studentIds.length,
    shareStudent: driveOptions.shareStudent,
    shareParent: driveOptions.shareParent,
    copyTemplate: !!driveOptions.templateId,
  }, async () => {
    const cohort = await requireCohort(app, text(cohortId), true);
    const record = await app.store.get(COLLECTIONS.cohorts, cohort.id);
    const rootId = driveOptions.rootFolderId || text(record?.DriveRootFolderId);
    const templateId = driveOptions.templateId || text(record?.EEDocTemplateId);
    if (!rootId) throw new HubError('Choose a cohort root folder.');
    if (!dryRun && record) {
      record.DriveRootFolderId = rootId;
      record.FolderPrefix = driveOptions.prefix;
      record.FolderSuffix = driveOptions.suffix;
      if (driveOptions.templateId) record.EEDocTemplateId = driveOptions.templateId;
      await app.store.set(COLLECTIONS.cohorts, cohort.id, record);
    }
    const roster = await app.store.listMembers(cohort.id);
    const drive = await driveClient();
    const result = await provisionStudents({
      actorEmail: account.actorEmail,
      dryRun,
      roster,
      studentIds,
      rootFolderId: rootId,
      templateId,
      prefix: driveOptions.prefix,
      suffix: driveOptions.suffix,
      shareStudent: driveOptions.shareStudent,
      shareParent: driveOptions.shareParent,
      drive,
      persistMember: dryRun ? undefined : async (member) => {
        await app.store.setMember(cohort.id, normalizeEmail(member.StudentId), member);
      },
    });
    const payload: Doc = { students: result.students, dryRun };
    if (!dryRun) {
      const saved = await app.store.get(COLLECTIONS.cohorts, cohort.id);
      payload.settings = { ...presentRecord(cohort.id, saved), rootName: result.rootName, templateName: result.templateName };
    }
    return payload;
  });
}

export async function provisionStudents(input: ProvisionInput) {
  await assertDriveAccount(input.drive, input.actorEmail);
  const root = await requireFolder(input.drive, input.rootFolderId, 'The cohort root folder could not be opened. Choose a folder that is not in the trash.');
  let templateName = '';
  if (input.templateId) templateName = (await requireTemplate(input.drive, input.templateId)).name;
  const names = expectedNames(input.roster, input.prefix, input.suffix);
  const byId: Record<string, Doc> = {};
  input.roster.forEach((member) => { byId[normalizeEmail(member.StudentId)] = member; });
  const shareOptions = { shareStudent: input.shareStudent, shareParent: input.shareParent };
  const students = [];
  for (const studentId of input.studentIds) {
    const member = byId[normalizeEmail(studentId)];
    if (!member) {
      students.push(studentResult(studentId, studentId, '', 'error', '', `Student is not in this cohort: ${studentId}`, [], skippedDoc()));
      continue;
    }
    const outcome = await syncOne(input, member, names[normalizeEmail(studentId)] || '', shareOptions);
    students.push(outcome);
  }
  return { students, rootName: root.name, templateName };
}

function studentResult(studentId: string, display: string, folderName: string, status: string, url: string, message: string, shares: ShareResult[], doc: DocResult) {
  return {
    studentId,
    displayName: display,
    folderName,
    status,
    url,
    message,
    shares,
    doc: { status: doc.status, url: doc.url, message: doc.message },
  };
}

function skippedDoc(): DocResult {
  return { status: 'skipped', url: '', message: '', id: '' };
}

async function syncOne(input: ProvisionInput, member: Doc, folderName: string, options: { shareStudent: boolean; shareParent: boolean }) {
  const studentId = normalizeEmail(member.StudentId);
  const baseDisplay = displayName(member);
  if (!folderName) return studentResult(studentId, baseDisplay, '', 'error', '', 'The folder name is empty. Enter a prefix, suffix, or display name.', [], skippedDoc());
  if (folderName.length > 200) return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The folder name is too long.', [], skippedDoc());
  let folderId = parseDriveId(member.EEFolder);
  let created = false;
  let relinked = false;
  if (!folderId) {
    let matches: Array<{ id: string; name: string }> = [];
    try {
      matches = await input.drive.listChildFolders(input.rootFolderId, folderName);
    } catch (error) {
      if (isReconnect(error)) throw error;
      return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The cohort folder could not be searched.', [], skippedDoc());
    }
    if (matches.length > 1) {
      return studentResult(studentId, baseDisplay, folderName, 'ambiguous', '', `More than one folder in the cohort folder is named ${folderName}.`, [], skippedDoc());
    }
    if (matches.length === 1) {
      folderId = matches[0].id;
      relinked = true;
    } else if (input.dryRun) {
      const doc = await placeDoc(input.drive, member, '', folderName, input.templateId, true);
      return studentResult(studentId, baseDisplay, folderName, 'would_create', '', `Would create ${folderName}.`, previewShares(member, options), doc);
    } else {
      try {
        const createdFolder = await input.drive.createFolder(folderName, input.rootFolderId);
        folderId = createdFolder.id;
        created = true;
      } catch (error) {
        if (isReconnect(error)) throw error;
        return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The student folder could not be created.', [], skippedDoc());
      }
    }
  }
  if (!folderId) return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The student folder could not be created.', [], skippedDoc());
  if (folderId === input.rootFolderId) return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The student folder cannot be the cohort folder itself.', [], skippedDoc());
  let folder: DriveFile;
  try {
    folder = await input.drive.getFile(folderId);
  } catch (error) {
    if (isReconnect(error)) throw error;
    return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The student folder could not be opened.', [], skippedDoc());
  }
  if (folder.trashed || folder.mimeType !== DRIVE_FOLDER_MIME) {
    return studentResult(studentId, baseDisplay, folderName, 'error', '', 'The student folder could not be opened.', [], skippedDoc());
  }
  const parents = folder.parents || [];
  const moved = !parents.includes(input.rootFolderId);
  const renamed = folder.name !== folderName;
  const url = folderUrl(folderId);
  if (!input.dryRun && (moved || renamed)) {
    try {
      await input.drive.updateFile(folderId, {
        name: renamed ? folderName : undefined,
        addParents: moved ? [input.rootFolderId] : undefined,
        removeParents: moved ? parents : undefined,
      });
    } catch (error) {
      if (isReconnect(error)) throw error;
      return studentResult(studentId, baseDisplay, folderName, 'error', url, 'The student folder could not be updated.', [], skippedDoc());
    }
  }
  const shares = input.dryRun ? previewShares(member, options) : await applyShares(input.drive, folderId, member, options);
  const doc = await placeDoc(input.drive, member, input.dryRun ? '' : folderId, folderName, input.templateId, input.dryRun);
  if (!input.dryRun && doc.id && (options.shareStudent || options.shareParent)) {
    const docShares = await applyShares(input.drive, doc.id, member, options);
    docShares.filter((share) => share.status === 'failed').forEach((share) => {
      shares.push({ ...share, who: `${share.who} document` });
    });
  }
  if (!input.dryRun) {
    member.EEFolder = url;
    if (doc.status === 'copied' && doc.url) member.EEDoc = doc.url;
    if (input.persistMember) await input.persistMember(member);
  }
  let status = 'unchanged';
  let message = 'Folder is already in place.';
  if (input.dryRun && !relinked && (moved || renamed)) {
    status = 'would_update';
    message = 'Would update the folder.';
  } else if (input.dryRun && relinked) {
    status = 'would_relink';
    message = 'Would relink the existing folder.';
  } else if (created) {
    status = 'created';
    message = 'Created the folder.';
  } else if (relinked) {
    status = 'relinked';
    message = 'Relinked the existing folder.';
  } else if (!input.dryRun && (moved || renamed)) {
    status = 'updated';
    message = 'Updated the folder.';
  }
  return studentResult(studentId, baseDisplay, folderName, status, url, message, shares, doc);
}

async function placeDoc(drive: DriveClient, member: Doc, folderId: string, docName: string, templateId: string, dryRun: boolean): Promise<DocResult> {
  if (!templateId) return { status: 'skipped', url: text(member.EEDoc), message: '', id: '' };
  const existingId = parseDriveId(member.EEDoc);
  if (existingId) {
    try {
      const file = await drive.getFile(existingId);
      if (!file.trashed && file.mimeType === DRIVE_DOCUMENT_MIME) {
        return { status: 'in_place', url: documentUrl(existingId), message: 'EE document is already saved for this student.', id: existingId };
      }
    } catch (error) {
      if (!(error instanceof HubError) || error.message !== 'Drive file not found.') {
        if (isReconnect(error)) throw error;
        return { status: 'error', url: '', message: 'The saved EE document could not be opened.', id: '' };
      }
    }
  }
  if (dryRun || !folderId) return { status: 'would_copy', url: '', message: 'Would copy the EE document into the folder.', id: '' };
  try {
    const copied = await drive.copyFile(templateId, docName, folderId);
    return { status: 'copied', url: documentUrl(copied.id), message: 'Copied the EE document.', id: copied.id };
  } catch (error) {
    if (isReconnect(error)) throw error;
    return { status: 'error', url: '', message: 'The EE document could not be copied.', id: '' };
  }
}

function previewShares(member: Doc, options: { shareStudent: boolean; shareParent: boolean }): ShareResult[] {
  const shares: ShareResult[] = [];
  if (options.shareStudent) shares.push(previewShare(member.StudentId, 'writer', 'student'));
  if (options.shareParent) shares.push(previewShare(member['Family Email'], 'reader', 'parent'));
  return shares;
}

function previewShare(email: unknown, role: string, who: string): ShareResult {
  const normalized = normalizeEmail(email);
  if (!normalized) return { who, email: '', role, status: 'skipped', reason: 'No email address.' };
  return { who, email: normalized, role, status: 'would_share', reason: '' };
}

async function applyShares(drive: DriveClient, fileId: string, member: Doc, options: { shareStudent: boolean; shareParent: boolean }): Promise<ShareResult[]> {
  const shares: ShareResult[] = [];
  if (options.shareStudent) shares.push(await share(drive, fileId, member.StudentId, 'writer', 'student'));
  if (options.shareParent) shares.push(await share(drive, fileId, member['Family Email'], 'reader', 'parent'));
  return shares;
}

async function share(drive: DriveClient, fileId: string, email: unknown, role: string, who: string): Promise<ShareResult> {
  const normalized = normalizeEmail(email);
  if (!normalized) return { who, email: '', role, status: 'skipped', reason: 'No email address.' };
  try {
    const outcome = await drive.share(fileId, normalized, role);
    if (outcome === 'already') return { who, email: normalized, role, status: 'already', reason: '' };
    if (outcome === 'notify_required') {
      return { who, email: normalized, role, status: 'failed', reason: 'Google would not share this address without sending an email.' };
    }
    return { who, email: normalized, role, status: 'shared', reason: '' };
  } catch (error) {
    if (isReconnect(error)) throw error;
    return { who, email: normalized, role, status: 'failed', reason: 'Could not share this file.' };
  }
}
