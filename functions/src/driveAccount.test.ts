import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DRIVE_ACCOUNT_META,
  DRIVE_SCOPE,
  ESSAY_DRIVE_UNAVAILABLE,
  loadDriveServiceAccount,
  MISSING_ACTOR,
  MISSING_KEY,
  presentDriveAccount,
  requireDriveActor,
  impersonatedAuth,
} from './driveAccount';
import { DriveClient, getDriveAccount, saveDriveAccount, WRONG_ACCOUNT } from './drive';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const ADMIN = 'coordinator@vsa.example.edu';
const SUPERVISOR = 'supervisor@vsa.example.edu';
const ACTOR = 'admin@school.edu';
const SERVICE = 'ee-drive@project.iam.gserviceaccount.com';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  meta: Record<string, Doc> = {};
  audits: Doc[] = [];

  async get(name: string, id: string): Promise<Doc | null> {
    const row = (this.docs[name] || {})[id];
    return row ? { ...row } : null;
  }

  async set(name: string, id: string, data: Doc): Promise<void> {
    if (!this.docs[name]) this.docs[name] = {};
    this.docs[name][id] = { ...data };
  }

  async findBy(name: string, field: string, value: unknown): Promise<Doc | null> {
    return Object.values(this.docs[name] || {}).find((row) => row[field] === value) || null;
  }

  async getMeta(id: string): Promise<Doc | null> {
    return this.meta[id] ? { ...this.meta[id] } : null;
  }

  async setMeta(id: string, data: Doc): Promise<void> {
    this.meta[id] = { ...data };
  }

  async addAudit(entry: Doc): Promise<void> {
    this.audits.push({ ...entry });
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(store: MemoryStore) {
  await store.set('staffUsers', ADMIN, {
    EMAIL: ADMIN, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set('staffUsers', SUPERVISOR, {
    EMAIL: SUPERVISOR, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
}

function driveAs(email: string): DriveClient {
  return { aboutEmail: async () => email } as DriveClient;
}

function keyJson(clientEmail: string, privateKey = '-----BEGIN PRIVATE KEY-----\\nSECRET\\n-----END PRIVATE KEY-----') {
  return JSON.stringify({ client_email: clientEmail, private_key: privateKey });
}

test('the Drive scope is the full Drive scope used for folders and document history', () => {
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive');
  assert.match(ESSAY_DRIVE_UNAVAILABLE, /assigns the Google account/);
  assert.match(MISSING_ACTOR, /Admin → Google Drive/);
  assert.match(MISSING_KEY, /EE_DRIVE_SERVICE_ACCOUNT_JSON/);
});

test('the Drive key prefers its own env value, then the Gmail key, and never returns the private key', async () => {
  const driveJson = keyJson(SERVICE);
  const gmailJson = keyJson('gmail-bot@project.iam.gserviceaccount.com', 'gmail-secret');
  const preferred = loadDriveServiceAccount({ driveJson, gmailJson });
  assert.equal(preferred.client_email, SERVICE);
  assert.equal(preferred.private_key, '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----');
  assert.equal(JSON.stringify(preferred).includes('gmail-secret'), false);

  const fallback = loadDriveServiceAccount({ gmailJson });
  assert.equal(fallback.client_email, 'gmail-bot@project.iam.gserviceaccount.com');

  assert.throws(() => loadDriveServiceAccount({}), new RegExp(MISSING_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => loadDriveServiceAccount({ driveJson: '{' }), /service-account JSON/);
  assert.throws(() => loadDriveServiceAccount({ driveJson: '{}' }), /client_email and private_key/);

  const directory = await mkdtemp(path.join(tmpdir(), 'ee-drive-key-'));
  const file = path.join(directory, 'key.json');
  await writeFile(file, keyJson('file-bot@project.iam.gserviceaccount.com', 'file-secret'));
  try {
    const fromFile = loadDriveServiceAccount({ driveJson: file });
    assert.equal(fromFile.client_email, 'file-bot@project.iam.gserviceaccount.com');
    assert.equal(fromFile.private_key, 'file-secret');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an admin can save the Workspace account, and Drive is checked only when a key is configured', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, ADMIN);
  let calls = 0;
  const withoutKey = await saveDriveAccount(app, { actorEmail: 'Admin@School.edu' }, {
    keySource: {},
    driveForActor() {
      calls += 1;
      return Promise.resolve(driveAs(ACTOR));
    },
  });
  assert.equal(calls, 0);
  assert.equal(withoutKey.actorEmail, ACTOR);
  assert.equal(withoutKey.ready, false);
  assert.equal(withoutKey.keyConfigured, false);
  assert.equal(withoutKey.updatedBy, ADMIN);
  assert.equal(JSON.stringify(withoutKey).includes('SECRET'), false);
  assert.equal(JSON.stringify(store.meta[DRIVE_ACCOUNT_META]).includes('private_key'), false);

  const loaded = await getDriveAccount(app);
  assert.equal(loaded.actorEmail, ACTOR);
  assert.equal(JSON.stringify(loaded).includes('SECRET'), false);

  const withKey = await saveDriveAccount(app, { actorEmail: ACTOR }, {
    keySource: { driveJson: keyJson(SERVICE) },
    driveForActor(email) {
      calls += 1;
      assert.equal(email, ACTOR);
      return Promise.resolve(driveAs(email));
    },
  });
  assert.equal(calls, 1);
  assert.equal(withKey.ready, true);
  assert.equal(withKey.serviceAccountEmail, SERVICE);
  assert.equal(JSON.stringify(withKey).includes('SECRET'), false);
  assert.equal(JSON.stringify(store.audits).includes('SECRET'), false);
  assert.match(JSON.stringify(store.audits), /SAVE_DRIVE_ACCOUNT_SUCCEEDED/);

  await assert.rejects(
    () => saveDriveAccount(app, { actorEmail: ACTOR }, {
      keySource: { driveJson: keyJson(SERVICE) },
      driveForActor: () => Promise.resolve(driveAs('other@school.edu')),
    }),
    (error: unknown) => error instanceof Error && error.message === WRONG_ACCOUNT,
  );
  assert.equal((await store.getMeta(DRIVE_ACCOUNT_META))?.actorEmail, ACTOR);

  await assert.rejects(() => saveDriveAccount(app, { actorEmail: 'not-an-email' }, { keySource: {} }), /valid email/);
  await assert.rejects(() => saveDriveAccount(appFor(store, SUPERVISOR), { actorEmail: ACTOR }, { keySource: {} }), /Access denied/);
});

test('Drive provisioning refuses to run until both a key and an account are stored', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, ADMIN);
  const empty = await presentDriveAccount(app, {});
  assert.equal(empty.ready, false);
  assert.equal(empty.actorEmail, '');
  await assert.rejects(() => requireDriveActor(app, {}), new RegExp(MISSING_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(() => impersonatedAuth('', { driveJson: keyJson(SERVICE) }), new RegExp(MISSING_ACTOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await store.setMeta(DRIVE_ACCOUNT_META, { actorEmail: ACTOR, updatedBy: ADMIN, updatedAt: '2026-10-16T00:00:00.000Z' });
  const ready = await requireDriveActor(app, { driveJson: keyJson(SERVICE) });
  assert.deepEqual(ready, { actorEmail: ACTOR, serviceAccountEmail: SERVICE });
  const presented = await presentDriveAccount(app, { driveJson: keyJson(SERVICE) });
  assert.equal(presented.ready, true);
  assert.equal(presented.keyError, '');
  assert.equal(JSON.stringify(presented).includes('SECRET'), false);

  const broken = await presentDriveAccount(app, { driveJson: '{' });
  assert.equal(broken.keyConfigured, true);
  assert.equal(broken.ready, false);
  assert.match(broken.keyError, /service-account JSON/);
  await assert.rejects(
    () => saveDriveAccount(app, { actorEmail: ACTOR }, { keySource: { driveJson: '{' } }),
    /service-account JSON/,
  );
});
