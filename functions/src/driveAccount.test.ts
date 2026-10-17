import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRIVE_ACCOUNT_META,
  ESSAY_DRIVE_UNAVAILABLE,
  MISSING_ACTOR,
  presentDriveAccount,
  requireDriveActor,
} from './driveAccount';
import { DriveClient, getDriveAccount, saveDriveAccount, WRONG_ACCOUNT } from './drive';
import { DRIVE_SCOPE, GOOGLE_SCOPES } from './googleAuth';
import { App } from './session';
import { Store } from './store';
import { Doc } from './util';

const ADMIN = 'coordinator@vsa.example.edu';
const SUPERVISOR = 'supervisor@vsa.example.edu';
const ACTOR = 'sec-ict@vsa.edu.hk';
const CLIENT_ID = 'ee-hub.apps.googleusercontent.com';
const CLIENT_SECRET = 'oauth-client-secret-value';
const REFRESH_TOKEN = 'oauth-refresh-token-value';
const OAUTH = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN };

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

test('Drive still uses the full Drive scope, and the connect copy points at Admin', () => {
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive');
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/gmail.send'));
  assert.match(ESSAY_DRIVE_UNAVAILABLE, /connects the Google account/);
  assert.match(MISSING_ACTOR, /Admin → Google account/);
});

test('checking the connection stores the token mailbox and never the refresh token', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, ADMIN);
  let calls = 0;
  await assert.rejects(
    () => saveDriveAccount(app, {}, {
      oauth: {},
      driveForActor() {
        calls += 1;
        return Promise.resolve(driveAs(ACTOR));
      },
    }),
    /EE_GOOGLE_OAUTH_CLIENT_ID/,
  );
  assert.equal(calls, 0);
  assert.equal(store.meta[DRIVE_ACCOUNT_META], undefined);

  const saved = await saveDriveAccount(app, {}, {
    oauth: OAUTH,
    driveForActor() {
      calls += 1;
      return Promise.resolve(driveAs(` ${ACTOR.toUpperCase()} `));
    },
  });
  assert.equal(calls, 1);
  assert.equal(saved.actorEmail, ACTOR);
  assert.equal(saved.configured, true);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.ready, true);
  assert.equal(saved.updatedBy, ADMIN);
  assert.deepEqual(saved.scopes, [...GOOGLE_SCOPES]);
  assert.match(saved.consentUrl, /client_id=/);
  assert.equal(saved.consentUrl.includes(CLIENT_SECRET), false);
  assert.equal(saved.consentUrl.includes(REFRESH_TOKEN), false);
  assert.equal(JSON.stringify(saved).includes(CLIENT_SECRET), false);
  assert.equal(JSON.stringify(saved).includes(REFRESH_TOKEN), false);
  assert.equal(JSON.stringify(store.meta[DRIVE_ACCOUNT_META]).includes(REFRESH_TOKEN), false);
  assert.equal(JSON.stringify(store.audits).includes(REFRESH_TOKEN), false);
  assert.match(JSON.stringify(store.audits), /SAVE_DRIVE_ACCOUNT_SUCCEEDED/);

  const loaded = await getDriveAccount(app);
  assert.equal(loaded.actorEmail, ACTOR);
  assert.equal(JSON.stringify(loaded).includes(CLIENT_SECRET), false);

  await assert.rejects(
    () => saveDriveAccount(app, { actorEmail: 'other@school.edu' }, {
      oauth: OAUTH,
      driveForActor: () => Promise.resolve(driveAs(ACTOR)),
    }),
    (error: unknown) => error instanceof Error && error.message === WRONG_ACCOUNT,
  );
  assert.equal((await store.getMeta(DRIVE_ACCOUNT_META))?.actorEmail, ACTOR);

  await assert.rejects(() => saveDriveAccount(app, { actorEmail: 'not-an-email' }, { oauth: OAUTH }), /valid email/);
  await assert.rejects(() => saveDriveAccount(appFor(store, SUPERVISOR), {}, { oauth: OAUTH }), /Access denied/);
});

test('Drive calls run from the OAuth token and do not need a pasted actor', async () => {
  const store = new MemoryStore();
  await seed(store);
  const app = appFor(store, ADMIN);
  const empty = await presentDriveAccount(app, {});
  assert.equal(empty.ready, false);
  assert.equal(empty.configured, false);
  assert.equal(empty.actorEmail, '');
  assert.match(empty.error, /EE_GOOGLE_OAUTH_REFRESH_TOKEN/);
  await assert.rejects(() => requireDriveActor(app, {}), /EE_GOOGLE_OAUTH_CLIENT_ID/);

  await store.setMeta(DRIVE_ACCOUNT_META, { actorEmail: ACTOR, updatedBy: ADMIN, updatedAt: '2026-10-16T00:00:00.000Z' });
  const cached = await requireDriveActor(app, OAUTH, async () => {
    throw new Error('cached mailbox should not call Google');
  });
  assert.deepEqual(cached, { actorEmail: ACTOR });
  const presented = await presentDriveAccount(app, OAUTH);
  assert.equal(presented.ready, true);
  assert.equal(presented.confirmed, true);
  assert.equal(presented.error, '');
  assert.equal(JSON.stringify(presented).includes(CLIENT_SECRET), false);

  await store.setMeta(DRIVE_ACCOUNT_META, {});
  let lookups = 0;
  const discovered = await requireDriveActor(app, OAUTH, async () => {
    lookups += 1;
    return 'Sec-ICT@vsa.edu.hk';
  });
  assert.equal(lookups, 1);
  assert.deepEqual(discovered, { actorEmail: ACTOR });
});
