import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { loadingLine } from '../shared/loading.js';
import { MAINTENANCE_NOTE_LIMIT } from '../shared/serverSettings.js';
import { state } from '../shared/state.js';

export function renderServerSettings(target) {
  if (!target) return;
  target.innerHTML = loadingLine('Loading server settings...');
  callServer('getServerSettings').then(function(settings) {
    if (state.adminEntity !== 'serverSettings') return;
    paintServerSettings(target, settings);
  }).catch(function(error) {
    showError(error);
    if (target && state.adminEntity === 'serverSettings') target.innerHTML = '<div class="empty">Server settings could not be loaded.</div>';
  });
}

function paintServerSettings(target, settings) {
  const emailOn = !settings || settings.emailNotificationEnabled !== false;
  const commentsOn = !settings || settings.commentsSweepEnabled !== false;
  const maintenanceOn = !!(settings && settings.maintenanceMode);
  target.innerHTML = `<section class="editor server-settings"><h2>Scheduled jobs</h2>
    <p class="muted">Both jobs run once a day at 04:00 Hong Kong time. Turning a switch off skips that run until you turn it back on. If this document has not been saved yet, both jobs stay on.</p>
    <ul class="student-page-list">
      <li class="server-setting"><div><strong>Email notifications</strong><p class="muted">Daily <code>notificationSweep</code>. Sending today's emails from Email notifications still sends.</p></div><label class="check-option"><input type="checkbox" id="server-email-notification" ${emailOn ? 'checked' : ''}> On</label></li>
      <li class="server-setting"><div><strong>Comment sweep</strong><p class="muted">Daily <code>docCommentSweep</code>. Opening a student's chat still syncs that document.</p></div><label class="check-option"><input type="checkbox" id="server-comments-sweep" ${commentsOn ? 'checked' : ''}> On</label></li>
    </ul>
    <h2>Maintenance mode</h2>
    <ul class="student-page-list">
      <li class="server-setting"><div><strong>Maintenance mode</strong><p class="muted">Students, supervisors, and other staff are sent to the maintenance page. Coordinators and admins can still use the Hub, including this page.</p></div><label class="check-option"><input type="checkbox" id="server-maintenance-mode" ${maintenanceOn ? 'checked' : ''}> On</label></li>
    </ul>
    <p class="notice" id="server-maintenance-warning" ${maintenanceOn ? '' : 'hidden'}>Maintenance mode is on. Save to send everyone except coordinators and admins to the maintenance page.</p>
    <div class="field wide"><label for="server-maintenance-note">Maintenance note</label>
      <textarea id="server-maintenance-note" maxlength="${MAINTENANCE_NOTE_LIMIT}" rows="4"></textarea>
      <p class="muted">Shown on the maintenance page. Leave this blank for a short default message. ${MAINTENANCE_NOTE_LIMIT} characters at most.</p>
    </div>
    <div class="toolbar"><button type="button" class="button" id="save-server-settings">Save changes</button></div>
    </section>`;
  const note = document.getElementById('server-maintenance-note');
  if (note) note.value = settings && settings.maintenanceNote ? settings.maintenanceNote : '';
  const maintenance = document.getElementById('server-maintenance-mode');
  if (maintenance) maintenance.addEventListener('change', syncMaintenanceWarning);
  const save = document.getElementById('save-server-settings');
  if (save) save.addEventListener('click', function() { saveServerSettings(target); });
}

function syncMaintenanceWarning() {
  const box = document.getElementById('server-maintenance-mode');
  const warning = document.getElementById('server-maintenance-warning');
  if (warning) warning.hidden = !(box && box.checked);
}

function readServerForm() {
  return {
    emailNotificationEnabled: !!(document.getElementById('server-email-notification') && document.getElementById('server-email-notification').checked),
    commentsSweepEnabled: !!(document.getElementById('server-comments-sweep') && document.getElementById('server-comments-sweep').checked),
    maintenanceMode: !!(document.getElementById('server-maintenance-mode') && document.getElementById('server-maintenance-mode').checked),
    maintenanceNote: document.getElementById('server-maintenance-note') ? document.getElementById('server-maintenance-note').value : '',
  };
}

function setServerFormLocked(locked) {
  ['server-email-notification', 'server-comments-sweep', 'server-maintenance-mode', 'server-maintenance-note', 'save-server-settings'].forEach(function(id) {
    const node = document.getElementById(id);
    if (node) node.disabled = locked;
  });
}

function saveServerSettings(target) {
  const payload = readServerForm();
  setServerFormLocked(true);
  callServer('saveServerSettings', payload).then(function(saved) {
    if (state.adminEntity !== 'serverSettings') return;
    paintServerSettings(target, saved);
    showSuccess('Server settings saved.');
  }).catch(function(error) {
    setServerFormLocked(false);
    showError(error);
  });
}
