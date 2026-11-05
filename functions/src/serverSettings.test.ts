import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from './session';
import { Store } from './store';
import {
  getServerSettings,
  MAINTENANCE_NOTE_LIMIT,
  normalizeServerSettings,
  readServerSettings,
  saveServerSettings,
  scheduledJobEnabled,
  SERVER_SETTINGS_ID,
} from './serverSettings';
import { COLLECTIONS } from './schema';
import { Doc } from './util';

const STUDENT = 'student@vsa.example.edu';
const SUPERVISOR = 'supervisor@vsa.example.edu';
const COORDINATOR = 'coordinator@vsa.example.edu';

class MemoryStore {
  docs: Record<string, Record<string, Doc>> = {};
  settings: Record<string, Doc> = {};
  audits: Doc[] = [];

  async get(name: string, id: string): Promise<Doc | null> {
    const row = (this.docs[name] || {})[id];
    return row ? { ...row } : null;
  }

  async set(name: string, id: string, data: Doc): Promise<void> {
    if (!this.docs[name]) this.docs[name] = {};
    this.docs[name][id] = { ...data };
  }

  async getSettings(id: string): Promise<Doc | null> {
    return this.settings[id] ? { ...this.settings[id] } : null;
  }

  async setSettings(id: string, data: Doc): Promise<void> {
    this.settings[id] = { ...data };
  }

  async addAudit(entry: Doc): Promise<void> {
    this.audits.push(entry);
  }
}

function appFor(store: MemoryStore, email: string): App {
  return { store: store as unknown as Store, email, timeZone: 'Asia/Hong_Kong' };
}

async function seed(store: MemoryStore) {
  await store.set(COLLECTIONS.staffUsers, COORDINATOR, {
    EMAIL: COORDINATOR, DisplayName: 'Alex Chen', isStaff: true, isCoordinator: true, isAdmin: true,
  });
  await store.set(COLLECTIONS.staffUsers, SUPERVISOR, {
    EMAIL: SUPERVISOR, DisplayName: 'Priya Shah', isStaff: true, isSupervisor: true,
  });
  await store.set(COLLECTIONS.studentUsers, STUDENT, { StudentId: STUDENT, DisplayName: 'Jamie Wong' });
}

const savedShape = {
  emailNotificationEnabled: false,
  commentsSweepEnabled: true,
  maintenanceMode: true,
  maintenanceNote: 'Back in one hour.',
};

test('missing server settings leave both daily jobs on and maintenance off', async () => {
  const store = new MemoryStore();
  assert.deepEqual(normalizeServerSettings(null), {
    emailNotificationEnabled: true,
    commentsSweepEnabled: true,
    maintenanceMode: false,
    maintenanceNote: '',
  });
  assert.equal(normalizeServerSettings({ emailNotificationEnabled: false, commentsSweepEnabled: 'no' }).emailNotificationEnabled, false);
  assert.equal(normalizeServerSettings({ emailNotificationEnabled: false, commentsSweepEnabled: 'no' }).commentsSweepEnabled, false);
  assert.equal(normalizeServerSettings({ maintenanceMode: 'yes' }).maintenanceMode, true);
  assert.equal(normalizeServerSettings({ maintenanceNote: '  Hello  ' }).maintenanceNote, 'Hello');

  const app = appFor(store, 'notifications@ee-hub');
  assert.equal(await scheduledJobEnabled(app, 'notificationSweep'), true);
  assert.equal(await scheduledJobEnabled(app, 'docCommentSweep'), true);
  assert.deepEqual(await readServerSettings(app), normalizeServerSettings(null));
});

test('coordinators save settings/server and the daily jobs follow those flags', async () => {
  const store = new MemoryStore();
  await seed(store);
  const admin = appFor(store, COORDINATOR);
  assert.deepEqual(await getServerSettings(admin), normalizeServerSettings(null));

  const saved = await saveServerSettings(admin, savedShape);
  assert.deepEqual(saved, savedShape);
  assert.equal(store.settings[SERVER_SETTINGS_ID].emailNotificationEnabled, false);
  assert.equal(store.settings[SERVER_SETTINGS_ID].commentsSweepEnabled, true);
  assert.equal(store.settings[SERVER_SETTINGS_ID].maintenanceMode, true);
  assert.equal(store.settings[SERVER_SETTINGS_ID].maintenanceNote, 'Back in one hour.');
  assert.equal(typeof store.settings[SERVER_SETTINGS_ID].updatedAt, 'string');
  assert.equal(store.settings[SERVER_SETTINGS_ID].updatedBy, undefined);
  assert.deepEqual(await getServerSettings(admin), savedShape);

  const worker = appFor(store, 'notifications@ee-hub');
  assert.equal(await scheduledJobEnabled(worker, 'notificationSweep'), false);
  assert.equal(await scheduledJobEnabled(worker, 'docCommentSweep'), true);

  await saveServerSettings(admin, {
    emailNotificationEnabled: true,
    commentsSweepEnabled: false,
    maintenanceMode: false,
    maintenanceNote: '',
  });
  assert.equal(await scheduledJobEnabled(worker, 'notificationSweep'), true);
  assert.equal(await scheduledJobEnabled(worker, 'docCommentSweep'), false);
});

test('students and supervisors cannot read or write server settings', async () => {
  const store = new MemoryStore();
  await seed(store);
  await assert.rejects(getServerSettings(appFor(store, STUDENT)), /Access denied/);
  await assert.rejects(saveServerSettings(appFor(store, SUPERVISOR), savedShape), /Access denied/);
  assert.equal(store.settings[SERVER_SETTINGS_ID], undefined);
});

test('a save must include every field and a short note', async () => {
  const store = new MemoryStore();
  await seed(store);
  const admin = appFor(store, COORDINATOR);
  await assert.rejects(saveServerSettings(admin, { maintenanceMode: true }), /maintenance note/);
  await assert.rejects(saveServerSettings(admin, { ...savedShape, maintenanceNote: 12 }), /must be text/);
  await assert.rejects(
    saveServerSettings(admin, { ...savedShape, maintenanceNote: 'x'.repeat(MAINTENANCE_NOTE_LIMIT + 1) }),
    /500 characters/,
  );
  assert.equal(store.settings[SERVER_SETTINGS_ID], undefined);
  const blank = await saveServerSettings(admin, { ...savedShape, maintenanceNote: '   ' });
  assert.equal(blank.maintenanceNote, '');
});

test('a settings read error does not skip the daily job', async () => {
  const store = new MemoryStore();
  store.getSettings = async () => {
    throw new Error('firestore unavailable');
  };
  assert.equal(await scheduledJobEnabled(appFor(store, 'notifications@ee-hub'), 'docCommentSweep'), true);
});
