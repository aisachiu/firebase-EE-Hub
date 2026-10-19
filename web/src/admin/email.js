import { adminDialogKind, closeAdminDialog, listingDialogKind, openAdminDialog } from './records.js';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { cssEscape, escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { isStale } from '../shared/scene.js';
import { state } from '../shared/state.js';
import {
  bindCollapsibleHeaders,
  bindSortableHeaders,
  collapsibleHeader,
  sortableHeader,
  sortedRows,
} from '../shared/tables.js';
import { renderStaffHome } from '../staff/students.js';
import { formatActivityWhen } from '../student/activity.js';

export let noticeToken = 0;

export function renderEmailDesk(target, options) {
  const token = ++noticeToken;
  const back = !!(options && options.back);
  if (!target) return;
  target.innerHTML = loadingLine('Loading email notifications...');
  callServer('listNotificationDesk', state.noticeCohortId || '', state.noticeMilestoneId || '').then(function(desk) {
    if (token !== noticeToken) return;
    state.noticeDesk = desk;
    state.noticeCohortId = desk.cohortId || '';
    state.noticeMilestoneId = desk.milestoneId || '';
    paintEmailDesk(target, back);
  }).catch(function(error) {
    if (isStale(error)) return;
    showError(error);
    if (target) target.innerHTML = '<div class="empty">Email notifications could not be loaded.</div>';
  });
}

export function noticeMilestone(id) {
  const milestones = (state.noticeDesk && state.noticeDesk.milestones) || [];
  return milestones.filter(function(milestone) { return milestone.milestoneId === id; })[0] || null;
}

export function noticeHint(audience, mOwner) {
  if (audience === 'coordinator') return 'The email goes only to coordinators and admins. The milestone owner is not copied.';
  if (mOwner === 'supervisor') return 'The email goes to the supervisor assigned on the cohort roster.';
  if (mOwner === 'lead') return 'The email goes to staff marked as EE lead.';
  if (mOwner === 'coordinator') return 'The email goes to coordinators and admins, because they own this milestone.';
  return 'The email goes to the student on the cohort roster.';
}

export function noticeOptions(items, value, valueKey, labelKey) {
  return items.map(function(item) {
    const itemValue = item[valueKey];
    return `<option value="${escapeHtml(itemValue)}" ${itemValue === value ? 'selected' : ''}>${escapeHtml(item[labelKey])}</option>`;
  }).join('');
}

export function noticeStudentName(studentId) {
  if (!studentId) return 'All of their students';
  const students = (state.noticeDesk && state.noticeDesk.students) || [];
  const match = students.filter(function(student) { return student.email === studentId; })[0];
  return match ? match.displayName : studentId;
}

export function paintEmailDesk(target, back) {
  const desk = state.noticeDesk;
  if (!target || !desk) return;
  const browsing = back && state.actingAs === 'staff';
  const editRules = !!(desk.access && desk.access.editRules) && !browsing;
  const editOverlays = !!(desk.access && desk.access.editOwnOverlays) && !browsing;
  const actor = desk.actorEmail || '';
  const gmail = desk.gmail || {};
  const canSend = !!(gmail.configured && !gmail.dryRun);
  const milestones = desk.milestones || [];
  const milestoneKnown = !state.noticeMilestoneId || milestones.some(function(milestone) { return milestone.milestoneId === state.noticeMilestoneId; });
  const mailLine = gmail.dryRun
    ? '<p class="notice">Dry run is on. The morning job checks these rules and does not send email.</p>'
    : gmail.configured
      ? `<p class="muted">Sent each morning as ${escapeHtml(gmail.sender || 'the connected Google account')}.</p>`
      : '<p class="notice">Gmail is not connected yet. Rules can be saved, and nothing is emailed until the school account is connected in Admin → Google account.</p>';
  const head = back
    ? `<div class="page-head"><div><p class="eyebrow">My Students</p><h1>Email reminders</h1><p class="lede">Cohort rules belong to the coordinator. Add an extra reminder here for your own students.</p></div><div class="page-actions"><button type="button" class="button secondary" id="email-desk-back">Back to students</button></div></div>`
    : '<p class="lede">Cohort rules belong to the coordinator. A supervisor can add an extra reminder for their own students. Each reminder is sent once, on its trigger day.</p>';
  const sendToday = editRules && canSend
    ? '<button type="button" class="button" id="notice-send-today">Send today’s emails</button>'
    : '';
  target.innerHTML = `<div class="notify-desk">${head}${mailLine}
    ${collapsibleHeader('notice-filters', 'Filters', `<div class="toolbar">
      <label for="notice-cohort">Cohort</label><select id="notice-cohort">${noticeOptions(desk.cohorts || [], state.noticeCohortId, 'id', 'name')}</select>
      <label for="notice-milestone">Milestone</label><select id="notice-milestone"><option value="">All milestones</option>${noticeOptions(milestones, state.noticeMilestoneId, 'milestoneId', 'title')}${milestoneKnown ? '' : `<option value="${escapeHtml(state.noticeMilestoneId)}" selected>${escapeHtml(state.noticeMilestoneId)}</option>`}</select>
      <button type="button" class="button secondary" id="notice-preview">Preview today</button>${sendToday}
    </div>`)}
    ${noticeSectionMarkup('rule', editRules, editOverlays, actor, canSend)}
    ${noticeSectionMarkup('overlay', editRules, editOverlays, actor, canSend)}
    ${noticeLogMarkup()}
    <div id="notice-preview-result"></div>
  </div>`;
  bindCollapsibleHeaders(target);
  bindSortableHeaders(target, function() { paintEmailDesk(target, back); });
  bindEmailDesk(target, back);
}

export function noticeStatusLabel(status) {
  if (status === 'sent') return 'Sent';
  if (status === 'failed') return 'Failed';
  if (status === 'dry-run') return 'Dry run';
  if (status === 'test') return 'Test';
  if (status === 'sending') return 'Sending';
  return status || 'Sent';
}

export function noticeSortValue(row, key) {
  if (key === 'milestone') return row.milestoneTitle || '';
  if (key === 'when') {
    if (row.when === 'before') return -(Number(row.days) || 0);
    if (row.when === 'after') return Number(row.days) || 0;
    if (row.when === 'on') return 0;
    return row.timingLabel || row.timing || '';
  }
  if (key === 'who') return row.audienceLabel || '';
  if (key === 'students') return noticeStudentName(row.studentId);
  if (key === 'on') return row.enabled ? 1 : 0;
  if (key === 'sent') return row.sentAt || '';
  if (key === 'student') return row.studentName || row.studentId || '';
  if (key === 'to') return (row.recipients || []).join(', ');
  if (key === 'status') return row.status || '';
  return '';
}

export function noticeLogMarkup() {
  const rows = sortedRows('notice-log', (state.noticeDesk && state.noticeDesk.sends) || [], noticeSortValue);
  const body = rows.length ? `<div class="table-wrap"><table class="notify-table"><thead><tr>${sortableHeader('notice-log', 'sent', 'When')}${sortableHeader('notice-log', 'student', 'Student')}${sortableHeader('notice-log', 'milestone', 'Milestone')}${sortableHeader('notice-log', 'to', 'To')}${sortableHeader('notice-log', 'status', 'Status')}</tr></thead><tbody>${rows.map(function(row) {
    const who = row.ruleKind === 'overlay' ? 'Supervisor reminder' : 'Cohort rule';
    const detail = [who, row.timing, row.audienceLabel, row.subject].filter(Boolean).join(' · ');
    return `<tr><td>${escapeHtml(formatActivityWhen(row.sentAt))}</td><td>${escapeHtml(row.studentName || row.studentId || '—')}</td><td><strong>${escapeHtml(row.milestoneTitle || row.milestoneId)}</strong><div class="notify-meta">${escapeHtml(detail)}</div>${row.error ? `<div class="notify-meta">${escapeHtml(row.error)}</div>` : ''}</td><td>${escapeHtml((row.recipients || []).join(', ') || '—')}</td><td>${escapeHtml(noticeStatusLabel(row.status))}</td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="empty">No reminders have been emailed for this filter.</div>';
  return `<section class="notify-card" aria-labelledby="notice-log-heading"><div class="toolbar"><h2 id="notice-log-heading">Email log</h2></div><p class="muted">Coordinators see every reminder for this cohort. A supervisor sees mail from their own reminders. A sent reminder also appears on the student’s activity.</p>${body}</section>`;
}

export function noticeSectionMarkup(kind, editRules, editOverlays, actor, canSend) {
  const overlay = kind === 'overlay';
  const rows = overlay ? (state.noticeDesk.overlays || []) : (state.noticeDesk.rules || []);
  const canCreate = (overlay ? editOverlays : editRules) && (state.noticeDesk.milestones || []).length > 0;
  const title = overlay ? 'Supervisor reminders' : 'Cohort rules';
  const intro = overlay
    ? (editRules
      ? 'Supervisors add these on top of the cohort rules, for their own students. You can turn one off or remove it.'
      : editOverlays
        ? 'Extra reminders for your students. They are sent in addition to the cohort rules.'
        : 'Extra reminders from supervisors. This view is read-only.')
    : (editRules
      ? 'These apply to every student in the cohort. Choose the days before or after the due date, and who receives the email.'
      : 'Cohort rules are set by the coordinator. This view is read-only.');
  const empty = overlay
    ? 'No extra reminders for this filter.'
    : 'No cohort rules for this filter.';
  const tableId = overlay ? 'notice-overlay' : 'notice-rule';
  const sorted = sortedRows(tableId, rows, noticeSortValue);
  return `<section class="notify-card${overlay ? ' overlay' : ''}" aria-labelledby="notice-${kind}-heading">
    <div class="toolbar"><h2 id="notice-${kind}-heading">${title}</h2>${canCreate ? `<button type="button" class="button" data-notice-new="${kind}">${overlay ? 'New reminder' : 'New rule'}</button>` : ''}</div>
    <p class="muted">${intro}</p>
    ${sorted.length ? `<div class="table-wrap"><table class="notify-table"><thead><tr>${sortableHeader(tableId, 'milestone', 'Milestone')}${sortableHeader(tableId, 'when', 'When')}${sortableHeader(tableId, 'who', 'Who receives it')}${overlay ? sortableHeader(tableId, 'students', 'Students') : ''}${sortableHeader(tableId, 'on', 'On')}<th></th></tr></thead><tbody>${sorted.map(function(row) { return noticeRowMarkup(row, kind, editRules, editOverlays, actor, canSend); }).join('')}</tbody></table></div>` : `<div class="empty">${empty}</div>`}
  </section>`;
}

export function noticeRowMarkup(row, kind, editRules, editOverlays, actor, canSend) {
  const ownOverlay = kind === 'overlay' && row.supervisorId === actor;
  const canEdit = kind === 'rule' ? editRules : (editOverlays && ownOverlay);
  const canDelete = kind === 'rule' ? editRules : (canEdit || editRules);
  const canToggle = canDelete;
  const canTest = canSend && (kind === 'rule' ? editRules : (ownOverlay || editRules));
  const toggle = canToggle
    ? `<label class="notify-switch"><input type="checkbox" data-notice-toggle="${kind}" data-notice-id="${escapeHtml(row.ruleId)}" ${row.enabled ? 'checked' : ''} aria-label="Turn ${escapeHtml(row.milestoneTitle)} ${row.enabled ? 'off' : 'on'}"> ${row.enabled ? 'On' : 'Off'}</label>`
    : escapeHtml(row.enabled ? 'On' : 'Off');
  const actions = [
    editRules ? `<button type="button" class="link-button" data-notice-run="${kind}" data-notice-id="${escapeHtml(row.ruleId)}">Preview and send</button>` : '',
    canEdit ? `<button type="button" class="link-button" data-notice-edit="${kind}" data-notice-id="${escapeHtml(row.ruleId)}">Edit</button>` : '',
    canTest ? `<button type="button" class="link-button" data-notice-test="${kind}" data-notice-id="${escapeHtml(row.ruleId)}">Send test</button>` : '',
    canDelete ? `<button type="button" class="link-button" data-notice-delete="${kind}" data-notice-id="${escapeHtml(row.ruleId)}">Delete</button>` : ''
  ].filter(Boolean).join('');
  const note = row.note ? `<div class="notify-meta">${escapeHtml(row.note.length > 90 ? row.note.slice(0, 87) + '…' : row.note)}</div>` : '';
  return `<tr><td><strong>${escapeHtml(row.milestoneTitle)}</strong>${note}</td><td>${escapeHtml(row.timingLabel)}</td><td>${escapeHtml(row.audienceLabel)}<div class="notify-meta">${escapeHtml(row.audienceHint)}</div></td>${kind === 'overlay' ? `<td>${escapeHtml(noticeStudentName(row.studentId))}</td>` : ''}<td>${toggle}</td><td class="actions">${actions}</td></tr>`;
}

export function noticeEditorMarkup(kind, actor) {
  const edit = state.noticeEdit || { kind: kind, id: 'new' };
  const rows = kind === 'overlay' ? state.noticeDesk.overlays : state.noticeDesk.rules;
  const current = (rows || []).filter(function(row) { return row.ruleId === edit.id; })[0] || {
    milestoneId: state.noticeMilestoneId || ((state.noticeDesk.milestones[0] || {}).milestoneId) || '',
    when: 'before',
    days: 7,
    audience: 'owner',
    enabled: true,
    note: '',
    studentId: ''
  };
  const students = (state.noticeDesk.students || []).filter(function(student) { return student.supervisorId === actor; });
  const studentField = kind === 'overlay'
    ? `<div class="field"><label for="notice-student">Students</label><select id="notice-student"><option value="">All of my students</option>${students.map(function(student) {
      return `<option value="${escapeHtml(student.email)}" ${student.email === current.studentId ? 'selected' : ''}>${escapeHtml(student.displayName)}</option>`;
    }).join('')}</select></div>`
    : '';
  const milestone = noticeMilestone(current.milestoneId);
  return `<div class="form-grid">
      <div class="field"><label for="notice-form-milestone">Milestone</label><select id="notice-form-milestone">${noticeOptions(state.noticeDesk.milestones || [], current.milestoneId, 'milestoneId', 'title')}</select></div>
      <div class="field"><label for="notice-when">When</label><select id="notice-when">
        <option value="before" ${current.when === 'before' ? 'selected' : ''}>Before the due date</option>
        <option value="on" ${current.when === 'on' ? 'selected' : ''}>On the due date</option>
        <option value="after" ${current.when === 'after' ? 'selected' : ''}>After the due date</option>
      </select></div>
      <div class="field"><label for="notice-days">Days</label><input id="notice-days" type="number" min="0" max="365" value="${escapeHtml(String(current.when === 'on' ? 0 : current.days))}"></div>
      <div class="field"><label for="notice-audience">Who receives it</label><select id="notice-audience">
        <option value="owner" ${current.audience === 'owner' ? 'selected' : ''}>Milestone owner</option>
        <option value="coordinator" ${current.audience === 'coordinator' ? 'selected' : ''}>Coordinator only</option>
      </select></div>
      ${studentField}
      <label class="field check"><input type="checkbox" id="notice-enabled" ${current.enabled ? 'checked' : ''}> On</label>
      <div class="field wide"><label for="notice-note">Note in the email</label><textarea id="notice-note" maxlength="1000">${escapeHtml(current.note || '')}</textarea><p class="muted" id="notice-hint">${escapeHtml(noticeHint(current.audience, milestone ? milestone.mOwner : 'student'))}</p></div>
    </div>
    <div class="toolbar"><button type="button" class="button" id="notice-save">Save</button><button type="button" class="button secondary" id="notice-cancel">Cancel</button></div>`;
}

export function openNoticeEditor(target, back) {
  const edit = state.noticeEdit;
  if (!edit || !state.noticeDesk) return;
  const actor = state.noticeDesk.actorEmail || '';
  const title = edit.id === 'new' ? (edit.kind === 'overlay' ? 'New reminder' : 'New rule') : 'Edit reminder';
  openAdminDialog('notice-rule', `<div class="form-panel member-editor" role="dialog" aria-modal="true" aria-labelledby="notice-editor-title"><div class="toolbar"><h2 id="notice-editor-title">${escapeHtml(title)}</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>${noticeEditorMarkup(edit.kind, actor)}</div>`);
  const cancel = document.getElementById('notice-cancel');
  if (cancel) cancel.addEventListener('click', closeAdminDialog);
  const save = document.getElementById('notice-save');
  if (save) save.addEventListener('click', function() { saveNoticeEditor(target, back, save); });
  syncNoticeDays();
  const when = document.getElementById('notice-when');
  const audience = document.getElementById('notice-audience');
  const formMilestone = document.getElementById('notice-form-milestone');
  if (when) when.addEventListener('change', syncNoticeDays);
  function refreshHint() {
    const hint = document.getElementById('notice-hint');
    const selected = formMilestone ? noticeMilestone(formMilestone.value) : null;
    if (hint && audience) hint.textContent = noticeHint(audience.value, selected ? selected.mOwner : 'student');
  }
  if (audience) audience.addEventListener('change', refreshHint);
  if (formMilestone) formMilestone.addEventListener('change', refreshHint);
}

export function bindEmailDesk(target, back) {
  const cohort = document.getElementById('notice-cohort');
  const milestone = document.getElementById('notice-milestone');
  if (cohort) cohort.addEventListener('change', function() {
    if (adminDialogKind() === 'notice-rule') closeAdminDialog();
    state.noticeCohortId = cohort.value;
    state.noticeEdit = null;
    renderEmailDesk(target, { back: back });
  });
  if (milestone) milestone.addEventListener('change', function() {
    if (adminDialogKind() === 'notice-rule') closeAdminDialog();
    state.noticeMilestoneId = milestone.value;
    state.noticeEdit = null;
    renderEmailDesk(target, { back: back });
  });
  const backButton = document.getElementById('email-desk-back');
  if (backButton) backButton.addEventListener('click', function() {
    if (adminDialogKind() === 'notice-rule') closeAdminDialog();
    state.emailDesk = false;
    state.noticeEdit = null;
    renderStaffHome();
  });
  target.querySelectorAll('[data-notice-new]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.noticeEdit = { kind: button.dataset.noticeNew, id: 'new' };
      openNoticeEditor(target, back);
    });
  });
  target.querySelectorAll('[data-notice-edit]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.noticeEdit = { kind: button.dataset.noticeEdit, id: button.dataset.noticeId };
      openNoticeEditor(target, back);
    });
  });
  target.querySelectorAll('[data-notice-delete]').forEach(function(button) {
    button.addEventListener('click', function() {
      const kind = button.dataset.noticeDelete;
      const noun = kind === 'overlay' ? 'reminder' : 'rule';
      if (!window.confirm('Delete this ' + noun + '?')) return;
      const method = kind === 'overlay' ? 'deleteNotificationOverlay' : 'deleteNotificationRule';
      callServer(method, button.dataset.noticeId).then(function() {
        showSuccess('Deleted.');
        if (adminDialogKind() === 'notice-rule') closeAdminDialog();
        state.noticeEdit = null;
        renderEmailDesk(target, { back: back });
      }).catch(showError);
    });
  });
  target.querySelectorAll('[data-notice-toggle]').forEach(function(box) {
    box.addEventListener('change', function() {
      const method = box.dataset.noticeToggle === 'overlay' ? 'setNotificationOverlayEnabled' : 'setNotificationRuleEnabled';
      callServer(method, box.dataset.noticeId, box.checked).then(function() {
        renderEmailDesk(target, { back: back });
      }).catch(function(error) {
        showError(error);
        renderEmailDesk(target, { back: back });
      });
    });
  });
  target.querySelectorAll('[data-notice-run]').forEach(function(button) {
    button.addEventListener('click', function() {
      openNoticeSend(button.dataset.noticeRun, button.dataset.noticeId, target, back);
    });
  });
  target.querySelectorAll('[data-notice-test]').forEach(function(button) {
    button.addEventListener('click', function() {
      button.disabled = true;
      callServer('sendNotificationTest', button.dataset.noticeTest === 'overlay' ? 'overlay' : 'cohort', button.dataset.noticeId).then(function(result) {
        showSuccess('Test sent to ' + (result && result.to ? result.to : 'you') + '.');
        button.disabled = false;
      }).catch(function(error) {
        button.disabled = false;
        showError(error);
      });
    });
  });
  const preview = document.getElementById('notice-preview');
  if (preview) preview.addEventListener('click', function() {
    preview.disabled = true;
    callServer('previewNotificationSweep', state.noticeCohortId).then(function(result) {
      preview.disabled = false;
      paintNoticePreview(result);
    }).catch(function(error) {
      preview.disabled = false;
      showError(error);
    });
  });
  const sendToday = document.getElementById('notice-send-today');
  if (sendToday) sendToday.addEventListener('click', function() {
    if (!window.confirm('Send today’s reminder emails for this cohort?')) return;
    sendToday.disabled = true;
    callServer('runNotificationSweep', { dryRun: false, cohortId: state.noticeCohortId }).then(function(result) {
      sendToday.disabled = false;
      showSuccess('Sent ' + (result.sent || 0) + '. Failed ' + (result.failed || 0) + '.');
      paintNoticePreview(result);
    }).catch(function(error) {
      sendToday.disabled = false;
      showError(error);
    });
  });
}

export function syncNoticeDays() {
  const when = document.getElementById('notice-when');
  const days = document.getElementById('notice-days');
  if (!when || !days) return;
  const onDate = when.value === 'on';
  days.disabled = onDate;
  if (onDate) days.value = '0';
  else if (!days.value || days.value === '0') days.value = '7';
}

export function saveNoticeEditor(target, back, button) {
  const edit = state.noticeEdit || { kind: 'rule', id: 'new' };
  const milestone = document.getElementById('notice-form-milestone');
  if (!milestone || !milestone.value) {
    showError(new Error('Choose a milestone.'));
    return;
  }
  const payload = {
    ruleId: edit.id === 'new' ? '' : edit.id,
    cohortId: state.noticeCohortId,
    milestoneId: milestone.value,
    when: document.getElementById('notice-when').value,
    days: document.getElementById('notice-days').value,
    audience: document.getElementById('notice-audience').value,
    enabled: document.getElementById('notice-enabled').checked,
    note: document.getElementById('notice-note').value,
    studentId: document.getElementById('notice-student') ? document.getElementById('notice-student').value : ''
  };
  button.disabled = true;
  const method = edit.kind === 'overlay' ? 'saveNotificationOverlay' : 'saveNotificationRule';
  callServer(method, payload).then(function() {
    showSuccess('Saved.');
    closeAdminDialog();
    renderEmailDesk(target, { back: back });
  }).catch(function(error) {
    button.disabled = false;
    showError(error);
  });
}

export function closeNoticeSend() {
  const dialog = document.getElementById('form-dialog');
  if (!dialog) return;
  dialog.hidden = true;
  dialog.innerHTML = '';
}

export function noticeSendCount(dialog) {
  const selected = dialog.querySelectorAll('[data-send-id]:checked').length;
  const button = dialog.querySelector('#notice-send-selected');
  if (button) button.textContent = selected ? 'Send selected (' + selected + ')' : 'Send selected';
  if (button && !button.dataset.blocked) button.disabled = selected === 0;
  const all = dialog.querySelector('#notice-send-all');
  const boxes = dialog.querySelectorAll('[data-send-id]');
  if (all && boxes.length) all.checked = selected === boxes.length;
}

export function openNoticeSend(kind, ruleId, target, back) {
  if (listingDialogKind(adminDialogKind())) closeAdminDialog();
  const dialog = document.getElementById('form-dialog');
  if (!dialog) return;
  dialog.hidden = false;
  delete dialog.dataset.editor;
  dialog.innerHTML = '<div class="form-panel notify-send-panel" role="dialog" aria-modal="true" aria-labelledby="notice-send-title"><div class="toolbar"><h2 id="notice-send-title">Preview and send</h2><button type="button" class="button secondary" id="notice-send-close">Close</button></div><p class="muted">Checking who would be emailed today…</p></div>';
  const close = document.getElementById('notice-send-close');
  if (close) close.addEventListener('click', closeNoticeSend);
  dialog.onkeydown = function(event) { if (event.key === 'Escape') closeNoticeSend(); };
  if (close) close.focus();
  callServer('previewNotificationRule', kind === 'overlay' ? 'overlay' : 'cohort', ruleId).then(function(preview) {
    if (dialog.hidden) return;
    paintNoticeSend(dialog, preview, kind, ruleId, target, back);
  }).catch(function(error) {
    closeNoticeSend();
    showError(error);
  });
}

export function paintNoticeSend(dialog, preview, kind, ruleId, target, back) {
  const messages = preview.messages || [];
  const gmail = state.noticeDesk && state.noticeDesk.gmail ? state.noticeDesk.gmail : {};
  const canSend = !!(preview.enabled && (preview.gmailConfigured || gmail.configured) && !(preview.dryRun || gmail.dryRun));
  const blocked = !preview.enabled
    ? 'This reminder is off. Turn it on before sending. The messages below are what today’s check would send.'
    : preview.dryRun || gmail.dryRun
      ? 'Dry run is on. You can read the messages, and nothing is emailed.'
      : !(preview.gmailConfigured || gmail.configured)
        ? 'Gmail is not connected yet. You can read the messages, and nothing is emailed.'
        : '';
  const choices = messages.length ? `<label class="notify-switch"><input type="checkbox" id="notice-send-all" checked> Select all</label><div class="notify-send-list">${messages.map(function(message) {
    return `<label class="notify-send-choice" data-send-row="${escapeHtml(message.sendId)}"><input type="checkbox" data-send-id="${escapeHtml(message.sendId)}" checked><span><strong>${escapeHtml(message.studentName || message.studentId)}</strong><div class="notify-meta">To ${escapeHtml((message.recipients || []).join(', ') || '—')}${message.dueDate ? ' · Due ' + escapeHtml(message.dueDate) : ''}</div><div>${escapeHtml(message.subject || '')}</div><pre class="notify-mail">${escapeHtml(message.body || '')}</pre><div class="notify-meta" data-send-status hidden></div></span></label>`;
  }).join('')}</div>` : '<div class="empty">Nothing is due to send today for this reminder.</div>';
  const skipped = (preview.skipped || []).map(function(group) {
    const names = group.students || [];
    const shown = names.slice(0, 8).join(', ');
    const more = names.length > 8 ? ' and ' + (names.length - 8) + ' more' : '';
    return `<li>${escapeHtml(group.reason)} ${escapeHtml(shown)}${escapeHtml(more)}</li>`;
  }).join('');
  const skipBlock = skipped ? `<h3>Not included</h3><ul class="notify-preview">${skipped}</ul>` : '';
  const truncated = preview.truncated ? '<p class="notice">Showing the first 200 messages.</p>' : '';
  dialog.innerHTML = `<div class="form-panel notify-send-panel" role="dialog" aria-modal="true" aria-labelledby="notice-send-title"><div class="toolbar"><h2 id="notice-send-title">Preview and send</h2><button type="button" class="button secondary" id="notice-send-close">Close</button></div><p class="lede">${escapeHtml(preview.milestoneTitle || 'Reminder')} · ${escapeHtml(preview.timing || '')} · ${escapeHtml(preview.audience || '')}</p><p class="muted">Today is ${escapeHtml(preview.today || '')}. These are the messages this reminder would send. Choose which ones to email.</p>${blocked ? `<p class="notice">${escapeHtml(blocked)}</p>` : ''}${truncated}${choices}${skipBlock}<p class="notice error" id="notice-send-error" hidden></p><div class="toolbar"><button type="button" class="button secondary" id="notice-send-cancel">Cancel</button><button type="button" class="button" id="notice-send-selected"${canSend && messages.length ? '' : ' disabled'}${canSend ? '' : ' data-blocked="1"'}>Send selected${messages.length ? ' (' + messages.length + ')' : ''}</button></div></div>`;
  document.getElementById('notice-send-close').addEventListener('click', closeNoticeSend);
  document.getElementById('notice-send-cancel').addEventListener('click', closeNoticeSend);
  dialog.onkeydown = function(event) { if (event.key === 'Escape') closeNoticeSend(); };
  dialog.querySelectorAll('[data-send-id]').forEach(function(box) {
    box.addEventListener('change', function() { noticeSendCount(dialog); });
  });
  const all = document.getElementById('notice-send-all');
  if (all) all.addEventListener('change', function() {
    dialog.querySelectorAll('[data-send-id]').forEach(function(box) { box.checked = all.checked; });
    noticeSendCount(dialog);
  });
  const send = document.getElementById('notice-send-selected');
  if (send) send.addEventListener('click', function() {
    const sendIds = Array.from(dialog.querySelectorAll('[data-send-id]:checked')).map(function(box) { return box.dataset.sendId; });
    if (!sendIds.length) return;
    send.disabled = true;
    const error = document.getElementById('notice-send-error');
    if (error) error.hidden = true;
    callServer('sendNotificationRule', { kind: kind === 'overlay' ? 'overlay' : 'cohort', ruleId: ruleId, sendIds: sendIds }).then(function(result) {
      (result.items || []).forEach(function(item) {
        const row = dialog.querySelector('[data-send-row="' + cssEscape(item.sendId) + '"] [data-send-status]');
        if (!row) return;
        row.hidden = false;
        row.textContent = noticeStatusLabel(item.status) + (item.error ? ' · ' + item.error : '');
      });
      dialog.querySelectorAll('[data-send-id], #notice-send-all').forEach(function(box) { box.disabled = true; });
      send.textContent = 'Sent ' + (result.sent || 0) + (result.failed ? '. Failed ' + result.failed : '');
      showSuccess('Sent ' + (result.sent || 0) + '.');
      renderEmailDesk(target, { back: back });
    }).catch(function(err) {
      send.disabled = false;
      if (error) {
        error.hidden = false;
        error.textContent = err && err.message ? err.message : String(err);
      } else showError(err);
    });
  });
  document.getElementById('notice-send-close').focus();
}

export function paintNoticePreview(result) {
  const host = document.getElementById('notice-preview-result');
  if (!host || !result) return;
  const items = result.items || [];
  const rows = items.length ? `<ul class="notify-preview">${items.map(function(item) {
    return `<li><strong>${escapeHtml(item.studentName)}</strong> · ${escapeHtml(item.milestoneTitle)}<div class="notify-meta">${escapeHtml(item.timing)} · ${escapeHtml(item.audience)} · ${escapeHtml((item.recipients || []).join(', ') || 'No recipient')} · ${escapeHtml(item.status || '')}</div><div>${escapeHtml(item.subject || '')}</div>${item.error ? `<div class="notify-meta">${escapeHtml(item.error)}</div>` : ''}</li>`;
  }).join('')}</ul>` : '<div class="empty">Nothing is due to send today for this cohort.</div>';
  host.innerHTML = `<section class="notify-card"><h2>Today, ${escapeHtml(result.today || '')}</h2><p class="muted">${result.considered || 0} ready, ${result.skipped || 0} skipped.${result.dryRun ? ' Nothing was sent.' : ''}</p>${rows}</section>`;
}
