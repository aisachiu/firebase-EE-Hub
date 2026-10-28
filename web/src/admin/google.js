import { driveStudentNeedsAttention, provisioningModalHtml } from './provisioning.js';
import { refreshAdminSectionSilently } from './sections.js';
import { callServer, runMutation } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml, safeUrl } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { state } from '../shared/state.js';
import { installProvisioningLeaveGuard } from '../router.js';
import { bindCollapsibleHeaders, collapsibleHeader, updateSelectedCount } from '../shared/tables.js';

export function renderDriveAccount(target) {
  target.innerHTML = loadingLine('Loading Google account...');
  callServer('getDriveAccount').then(paintDriveAccount).catch(showError);
}

export function paintDriveAccount(account) {
  const target = document.getElementById('admin-content');
  if (!target || state.adminEntity !== 'driveAccount') return;
  const consent = safeUrl(account.consentUrl);
  const status = account.confirmed && account.actorEmail
    ? 'Connected as ' + account.actorEmail + (account.updatedAt ? ' · confirmed ' + account.updatedAt : '') + '.'
    : account.configured
      ? 'The OAuth refresh token is set. Check the connection to confirm the mailbox.'
      : (account.error || 'Google is not connected.');
  const legacy = account.legacyNote
    ? `<p class="notice">${escapeHtml(account.legacyNote)}</p>`
    : '';
  const consentLine = consent
    ? `<p class="muted"><a href="${escapeHtml(consent)}" target="_blank" rel="noopener">Open the one-time consent page</a> while signed in as the school account, then exchange the code with <code>npm run mint-google-oauth -- --code=...</code>.</p>`
    : '';
  const scopes = (account.scopes || []).map(function(scope) { return `<li><code>${escapeHtml(scope)}</code></li>`; }).join('');
  target.innerHTML = `<section class="editor"><h2>Connect Google</h2>
    <p class="muted">Drive folders, copied EE documents, essay edit history, spreadsheet export, and reminder email all use one Google account. Students and staff are not asked to connect Google.</p>
    <p class="${account.configured ? 'muted' : 'notice'}" id="drive-account-saved">${escapeHtml(status)}</p>
    ${legacy}
    <ol class="muted">
      <li>In Google Cloud Console, create an OAuth client (Desktop, or Web with redirect <code>http://127.0.0.1:8765/oauth/callback</code>). Set the consent screen to Internal and add the scopes below.</li>
      <li>On a computer that can sign in as the school account, run <code>npm run mint-google-oauth</code>.</li>
      <li>Store the printed values with <code>firebase functions:secrets:set</code> for <code>EE_GOOGLE_OAUTH_CLIENT_ID</code>, <code>EE_GOOGLE_OAUTH_CLIENT_SECRET</code>, and <code>EE_GOOGLE_OAUTH_REFRESH_TOKEN</code>, then redeploy. Do not put the refresh token in <code>functions/.env</code>.</li>
      <li>Check the connection. The mailbox shown here is the account that owns the refresh token.</li>
    </ol>
    ${scopes ? `<ul>${scopes}</ul>` : ''}
    ${consentLine}
    <div class="toolbar">
      <button type="button" class="button" id="save-drive-account">Check connection</button>
    </div></section>`;
  document.getElementById('save-drive-account').addEventListener('click', function() {
    const button = document.getElementById('save-drive-account');
    if (button) button.disabled = true;
    runMutation('saveDriveAccount', [{}], { key: 'drive-account' }).then(function(savedAccount) {
      if (button) button.disabled = false;
      paintDriveAccount(savedAccount);
      showSuccess('Connected as ' + savedAccount.actorEmail + '.');
    }).catch(function(error) {
      if (button) button.disabled = false;
      showError(error);
    });
  });
}

export function renderDriveFolderPanel() {
  const panel = document.getElementById('drive-folder-panel');
  if (!panel) return;
  panel.innerHTML = collapsibleHeader('drive-folders', 'Drive folders', `<p class="muted">Create one folder per selected student inside the cohort folder. Folders and copied documents are created by the Google account connected in Admin → Google account. Keep the cohort folder where that account can edit. The folder and EE document are shared with the Student Email on the cohort record. No email is sent. A copy of the EE document template is placed in each folder and saved on that student.</p>
    <p class="muted" id="drive-actor-label">Checking the connected Google account…</p>
    <div class="form-grid">
      <div class="field wide"><label for="drive-root-url">Cohort folder</label>
        <div class="toolbar"><button type="button" class="button secondary" id="save-drive-root">Save folder and template</button><strong id="drive-root-label">No folder selected</strong></div>
        <input id="drive-root-url" placeholder="Paste a Google Drive folder link">
        <p class="notice" id="drive-root-problem" hidden></p>
      </div>
      <div class="field wide"><label for="drive-template-url">EE document template</label>
        <strong id="drive-template-label">No template yet</strong>
        <input id="drive-template-url" placeholder="Paste a Google Doc template link">
        <p class="notice" id="drive-template-problem" hidden></p>
      </div>
      <div class="field"><label for="drive-prefix">Prefix</label><input id="drive-prefix" maxlength="80"></div>
      <div class="field"><label for="drive-suffix">Suffix</label><input id="drive-suffix" maxlength="80"></div>
    </div>
    <p class="muted" id="drive-name-preview"></p>
    <label class="field check"><input type="checkbox" id="drive-share-student" checked> Share with the Student Email as editor</label>
    <label class="field check"><input type="checkbox" id="drive-share-parent"> Share with the parent as viewer</label>
    <div class="toolbar"><button type="button" class="button secondary" id="check-drive-folders" disabled>Check selected</button><button type="button" class="button" id="update-drive-folders" disabled>Create or update selected</button></div>
    <div id="drive-folder-results"></div>`);
  bindCollapsibleHeaders(panel);
  document.getElementById('save-drive-root').addEventListener('click', saveDriveRootFromForm);
  document.getElementById('check-drive-folders').addEventListener('click', function() { runDriveFolderJob(true); });
  document.getElementById('update-drive-folders').addEventListener('click', function() { runDriveFolderJob(false); });
  ['drive-prefix', 'drive-suffix'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', updateDriveNamePreview);
  });
  state.driveSettingsLoaded = false;
  loadDriveSettings();
}

export function setDriveFormLocked(locked) {
  ['save-drive-root', 'drive-root-url', 'drive-template-url', 'drive-prefix', 'drive-suffix', 'drive-share-student', 'drive-share-parent'].forEach(function(id) {
    const node = document.getElementById(id);
    if (node) node.disabled = locked;
  });
}

export function driveActorLabel(settings) {
  if (settings && settings.driveProblem) return settings.driveProblem;
  if (settings && settings.driveReady && settings.driveActor) return 'Using ' + settings.driveActor + ' for new folders and copied documents.';
  if (settings && settings.driveReady) return 'Using the connected Google account for new folders and copied documents.';
  return 'Connect Google in Admin → Google account before creating folders.';
}

export function loadDriveSettings() {
  setDriveFormLocked(true);
  return callServer('getCohortDriveSettings', state.cohortId).then(function(settings) {
    state.driveSettings = settings;
    state.driveSettingsLoaded = true;
    applyDriveFolderSettings(settings);
    setDriveFormLocked(false);
    updateSelectedCount();
    return settings;
  }).catch(function(error) {
    state.driveSettingsLoaded = true;
    setDriveFormLocked(false);
    updateSelectedCount();
    showError(error);
  });
}

export function applyDriveFolderSettings(settings) {
  const prefix = document.getElementById('drive-prefix');
  const suffix = document.getElementById('drive-suffix');
  const url = document.getElementById('drive-root-url');
  const label = document.getElementById('drive-root-label');
  const problem = document.getElementById('drive-root-problem');
  const template = document.getElementById('drive-template-url');
  const templateLabel = document.getElementById('drive-template-label');
  const templateProblem = document.getElementById('drive-template-problem');
  if (!prefix || !settings) return;
  prefix.value = settings.prefix || '';
  suffix.value = settings.suffix || '';
  if (url) url.value = settings.rootUrl || settings.rootFolderId || '';
  if (label) label.textContent = settings.rootName ? settings.rootName : (settings.rootFolderId ? 'Folder linked' : 'No folder selected');
  if (problem) {
    problem.hidden = !settings.rootProblem;
    problem.textContent = settings.rootProblem || '';
  }
  if (template) template.value = settings.templateUrl || settings.templateId || '';
  if (templateLabel) templateLabel.textContent = settings.templateName ? settings.templateName : (settings.templateId ? 'Template linked' : 'No template yet');
  if (templateProblem) {
    templateProblem.hidden = !settings.templateProblem;
    templateProblem.textContent = settings.templateProblem || '';
  }
  const actor = document.getElementById('drive-actor-label');
  if (actor) actor.textContent = driveActorLabel(settings);
  updateDriveNamePreview();
}

export function readDriveFolderForm() {
  const url = document.getElementById('drive-root-url');
  const saved = state.driveSettings || {};
  return {
    rootFolderId: (url && url.value.trim()) || saved.rootFolderId || '',
    prefix: document.getElementById('drive-prefix') ? document.getElementById('drive-prefix').value : '',
    suffix: document.getElementById('drive-suffix') ? document.getElementById('drive-suffix').value : '',
    templateId: document.getElementById('drive-template-url') ? document.getElementById('drive-template-url').value : '',
    shareStudent: !!(document.getElementById('drive-share-student') && document.getElementById('drive-share-student').checked),
    shareParent: !!(document.getElementById('drive-share-parent') && document.getElementById('drive-share-parent').checked)
  };
}

export function updateDriveNamePreview() {
  const node = document.getElementById('drive-name-preview');
  const prefixInput = document.getElementById('drive-prefix');
  if (!node || !prefixInput) return;
  const records = state.adminData && state.adminData.records ? state.adminData.records : [];
  const selectedId = state.selectedMemberIds[0];
  const record = records.filter(function(item) { return item.StudentId === selectedId; })[0] || records[0];
  const displayName = record ? (record['Display Name'] || record.StudentId || 'Student') : 'Student';
  const prefix = prefixInput.value;
  const suffix = document.getElementById('drive-suffix') ? document.getElementById('drive-suffix').value : '';
  const name = String(prefix + displayName + suffix).replace(/[\/\\]/g, '').replace(/[\u0000-\u001f]/g, '').trim();
  node.textContent = name ? 'Example folder name: ' + name : 'Enter a prefix, suffix, or choose a student with a display name.';
}

export function saveDriveRootFromForm() {
  const form = readDriveFolderForm();
  if (!form.rootFolderId) {
    showError(new Error('Paste a Google Drive folder link.'));
    return;
  }
  const button = document.getElementById('save-drive-root');
  if (button) button.disabled = true;
  runMutation('saveCohortDriveSettings', [state.cohortId, form], { key: 'drive-settings:' + state.cohortId }).then(function(settings) {
    state.driveSettings = settings;
    applyDriveFolderSettings(settings);
    if (button) button.disabled = false;
    showSuccess(form.templateId ? 'Cohort folder and EE template saved.' : 'Cohort folder saved.');
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

function ensureProvisioningModal() {
  let modal = document.getElementById('provision-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'provision-modal';
  modal.className = 'form-dialog';
  modal.hidden = true;
  document.body.appendChild(modal);
  return modal;
}

export function closeProvisioningModal() {
  const modal = document.getElementById('provision-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.innerHTML = '';
  modal.onclick = null;
}

export function paintProvisioningModal(view) {
  const modal = ensureProvisioningModal();
  const focusNow = modal.hidden;
  modal.hidden = false;
  modal.innerHTML = provisioningModalHtml(view);
  const close = document.getElementById('provision-close');
  if (close) close.addEventListener('click', function() {
    if (state.isProvisioning) return;
    closeProvisioningModal();
  });
  modal.onclick = function(event) {
    if (event.target === modal && !state.isProvisioning) closeProvisioningModal();
  };
  if (focusNow) {
    const title = document.getElementById('provision-title');
    if (title) title.focus();
  } else if (!view.running) {
    const close = document.getElementById('provision-close');
    if (close && !close.disabled) close.focus();
  }
}

export function runDriveFolderJob(dryRun) {
  if (!state.selectedMemberIds.length || state.driveBusy || state.isProvisioning) return;
  const cohortId = state.cohortId;
  const ids = state.selectedMemberIds.slice();
  const results = [];
  const form = readDriveFolderForm();
  if (!form.rootFolderId) {
    showError(new Error('Choose a cohort folder or paste its link.'));
    return;
  }
  const runId = ++state.provisionRun;
  state.driveBusy = true;
  if (!dryRun) {
    state.isProvisioning = true;
    installProvisioningLeaveGuard();
  }
  updateSelectedCount();
  step(0, form);
  function stillRunning() {
    return runId === state.provisionRun && state.cohortId === cohortId && !!document.getElementById('drive-folder-panel');
  }
  function stopJob() {
    if (runId !== state.provisionRun) return;
    state.driveBusy = false;
    state.isProvisioning = false;
    if (!dryRun) closeProvisioningModal();
    updateSelectedCount();
  }
  function finish(error) {
    if (!stillRunning()) {
      stopJob();
      return;
    }
    state.driveBusy = false;
    state.isProvisioning = false;
    updateSelectedCount();
    const resultsNode = document.getElementById('drive-folder-results');
    if (resultsNode && state.cohortId === cohortId) resultsNode.innerHTML = renderDriveFolderResults(results);
    if (!dryRun) {
      paintProvisioningModal({
        completed: results.length,
        total: ids.length,
        running: false,
        students: results,
        error: error && error.message ? error.message : '',
      });
    }
    const problemCount = results.filter(driveStudentNeedsAttention).length;
    const countLabel = results.length + ' student' + (results.length === 1 ? '' : 's');
    if (error) showError(error);
    else if (problemCount) showSuccess((dryRun ? 'Checked ' : 'Updated ') + countLabel + '. ' + problemCount + ' need attention.');
    else if (!dryRun) showSuccess('Drive folders updated for ' + countLabel + '.');
    else showSuccess('Checked ' + countLabel + '.');
    if (!dryRun && !error) refreshAdminSectionSilently();
  }
  function step(offset, form) {
    if (!stillRunning()) {
      stopJob();
      return;
    }
    if (offset >= ids.length) {
      finish();
      return;
    }
    form = form || readDriveFolderForm();
    const batch = ids.slice(offset, offset + 8);
    const resultsNode = document.getElementById('drive-folder-results');
    if (resultsNode) {
      resultsNode.innerHTML = '<p class="muted">Working on ' + (offset + 1) + '–' + Math.min(offset + batch.length, ids.length) + ' of ' + ids.length + '...</p>' + renderDriveFolderResults(results);
    }
    if (!dryRun) paintProvisioningModal({ completed: offset, total: ids.length, running: true, students: results });
    const method = dryRun ? 'checkCohortDriveFolders' : 'syncCohortDriveFolders';
    runMutation(method, [cohortId, batch, form], { key: 'drive-folders:' + cohortId }).then(function(result) {
      if (!result || result.stale || !stillRunning()) {
        stopJob();
        return;
      }
      (result.students || []).forEach(function(student) { results.push(student); });
      if (result.settings) {
        state.driveSettings = result.settings;
        applyDriveFolderSettings(result.settings);
      }
      step(offset + batch.length, form);
    }).catch(function(error) { finish(error); });
  }
}

export function renderDriveFolderResults(students) {
  if (!students.length) return '';
  return '<ul class="drive-results">' + students.map(function(student) {
    const url = safeUrl(student.url);
    const shares = (student.shares || []).map(driveShareLabel).filter(Boolean).join(' · ');
    const docUrl = safeUrl(student.doc && student.doc.url);
    const docLine = student.doc && student.doc.message ? student.doc.message : '';
    return '<li><strong>' + escapeHtml(student.displayName || student.studentId) + '</strong> · ' + escapeHtml(driveStatusLabel(student.status)) +
      (student.folderName ? ' · ' + escapeHtml(student.folderName) : '') +
      (student.message ? '<div class="muted">' + escapeHtml(student.message) + '</div>' : '') +
      (docLine ? '<div class="muted">' + escapeHtml(docLine) + '</div>' : '') +
      (shares ? '<div class="muted">' + escapeHtml(shares) + '</div>' : '') +
      (url ? '<div><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Open folder</a></div>' : '') +
      (docUrl ? '<div><a href="' + escapeHtml(docUrl) + '" target="_blank" rel="noopener noreferrer">Open EE document</a></div>' : '') +
      '</li>';
  }).join('') + '</ul>';
}

export function driveStatusLabel(status) {
  const labels = {
    created: 'Created',
    relinked: 'Relinked',
    renamed: 'Renamed',
    moved: 'Moved',
    updated: 'Updated',
    unchanged: 'Already in place',
    would_create: 'Would create',
    would_relink: 'Would relink',
    would_rename: 'Would rename',
    would_move: 'Would move',
    would_update: 'Would update',
    ambiguous: 'Needs a choice',
    error: 'Needs attention'
  };
  return labels[status] || status || 'Needs attention';
}

export function driveShareLabel(share) {
  const who = share.who === 'parent' ? 'Parent' : (share.who === 'parent document' ? 'Parent document' : (share.who === 'student document' ? 'Student document' : 'Student'));
  if (share.status === 'shared') return who + ' shared';
  if (share.status === 'already') return who + ' already had access';
  if (share.status === 'updated') return who + ' access updated';
  if (share.status === 'would_share') return who + ' would be shared';
  if (share.status === 'skipped') return who + ' skipped' + (share.reason ? ': ' + share.reason : '');
  if (share.status === 'failed') return who + ' not shared' + (share.reason ? ': ' + share.reason : '');
  return '';
}
