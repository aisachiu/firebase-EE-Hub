import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cohortProvisionFilterControl,
  cohortProvisionSelectionActions,
  driveStudentNeedsAttention,
  matchesProvisionFilter,
  memberIdsForProvision,
  provisioningCounter,
  provisioningModalHtml,
  provisioningSortValue,
  workspaceCellHtml,
} from './provisioning.js';
import {
  PROVISIONING_LEAVE_WARNING,
  confirmProvisioningLeave,
  provisioningBeforeUnload,
  requestPush,
} from '../router.js';
import { state } from '../shared/state.js';

const folder = 'https://drive.google.com/drive/folders/folder-amy';
const doc = 'https://docs.google.com/document/d/doc-amy/edit';

test('workspace cells link folder and doc in a new tab when both are set', () => {
  const html = workspaceCellHtml({ EEFolder: folder, EEDoc: doc });
  assert.match(html, new RegExp('href="' + folder + '"'));
  assert.match(html, new RegExp('href="' + doc + '"'));
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Open EE folder/);
  assert.match(html, /Open EE document/);
  assert.match(html, /Has folder and doc/);
  assert.equal(provisioningSortValue({ EEFolder: folder, EEDoc: doc }), 2);
});

test('missing workspace fields stay unlinked and sort below provisioned students', () => {
  const unsafe = workspaceCellHtml({ EEFolder: 'javascript:alert(1)', EEDoc: '  ' });
  assert.equal(unsafe.includes('href='), false);
  assert.match(unsafe, /Missing folder and doc/);
  const html = workspaceCellHtml({ EEFolder: '', EEDoc: '  ' });
  assert.equal(html.includes('href='), false);
  assert.match(html, /Missing folder and doc/);
  assert.equal(provisioningSortValue({ EEFolder: '', EEDoc: '' }), 0);
  assert.equal(provisioningSortValue({ EEFolder: folder, EEDoc: '' }), 1);
  assert.equal(matchesProvisionFilter({ EEFolder: folder, EEDoc: '' }, 'missing'), true);
  assert.equal(matchesProvisionFilter({ EEFolder: folder, EEDoc: '' }, 'missing-folder'), false);
  assert.equal(matchesProvisionFilter({ EEFolder: folder, EEDoc: '' }, 'missing-doc'), true);
  assert.equal(matchesProvisionFilter({ EEFolder: folder, EEDoc: doc }, 'ready'), true);
  assert.equal(matchesProvisionFilter({ EEFolder: folder, EEDoc: doc }, 'missing'), false);
});

test('bulk selection can target students missing a folder or already provisioned', () => {
  const records = [
    { StudentId: 'amy@school.edu', EEFolder: folder, EEDoc: doc },
    { StudentId: 'ben@school.edu', EEFolder: '', EEDoc: doc },
    { StudentId: 'cia@school.edu', EEFolder: '', EEDoc: '', hasStudentIdConflict: true },
  ];
  assert.deepEqual(memberIdsForProvision(records, 'missing-folder'), ['ben@school.edu']);
  assert.deepEqual(memberIdsForProvision(records, 'ready'), ['amy@school.edu']);
  const actions = cohortProvisionSelectionActions();
  assert.match(actions, /Clear Google Workspace Data/);
  assert.match(actions, /id="select-missing-folder"/);
  assert.match(actions, /id="select-provisioned"/);
  const filter = cohortProvisionFilterControl('missing');
  assert.match(filter, /id="member-provision-filter"/);
  assert.match(filter, /value="missing" selected/);
  assert.match(filter, /Missing folder or doc/);
  assert.match(filter, /Has folder and doc/);
});

test('provisioning modal counts progress and lists successes and failures', () => {
  assert.equal(provisioningCounter(4, 24, true), 'Provisioning 5 of 24...');
  assert.equal(provisioningCounter(24, 24, false), 'Provisioned 24 of 24.');
  const html = provisioningModalHtml({
    completed: 4,
    total: 24,
    running: true,
    students: [
      { displayName: 'Amy Chen', status: 'created', message: 'Created the folder.' },
      { displayName: 'Ben Ortiz', status: 'error', message: 'The student folder could not be created.' },
    ],
  });
  assert.match(html, /Provisioning 5 of 24\.\.\./);
  assert.match(html, /1 succeeded/);
  assert.match(html, /1 failed/);
  assert.match(html, /Amy Chen/);
  assert.match(html, /Succeeded/);
  assert.match(html, /Ben Ortiz/);
  assert.match(html, /Failed/);
  assert.match(html, /id="provision-close" disabled/);
  assert.equal(driveStudentNeedsAttention({ status: 'created', doc: { status: 'copied' }, shares: [] }), false);
  assert.equal(driveStudentNeedsAttention({ status: 'updated', doc: { status: 'error' }, shares: [] }), true);
});

test('leaving is blocked with the provisioning warning until the admin confirms', () => {
  const previous = globalThis.confirm;
  const prompts = [];
  state.isProvisioning = true;
  state.provisionRun = 4;
  state.driveBusy = true;
  globalThis.confirm = function(message) {
    prompts.push(message);
    return false;
  };
  try {
    assert.equal(confirmProvisioningLeave(), false);
    assert.equal(prompts[0], PROVISIONING_LEAVE_WARNING);
    assert.equal(state.isProvisioning, true);
    assert.equal(state.provisionRun, 4);
    assert.equal(requestPush(), false);
    globalThis.confirm = function() { return true; };
    assert.equal(confirmProvisioningLeave(), true);
    assert.equal(state.isProvisioning, false);
    assert.equal(state.driveBusy, false);
    assert.equal(state.provisionRun, 5);
    const event = { preventDefault() { this.prevented = true; } };
    state.isProvisioning = true;
    assert.equal(provisioningBeforeUnload(event), PROVISIONING_LEAVE_WARNING);
    assert.equal(event.returnValue, PROVISIONING_LEAVE_WARNING);
    assert.equal(event.prevented, true);
    state.isProvisioning = false;
    assert.equal(provisioningBeforeUnload(event), undefined);
    assert.equal(confirmProvisioningLeave(), true);
    assert.equal(requestPush(), true);
  } finally {
    state.isProvisioning = false;
    state.driveBusy = false;
    globalThis.confirm = previous;
  }
});
