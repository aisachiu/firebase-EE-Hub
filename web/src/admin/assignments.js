import { closeAdminDialog, openAdminDialog } from './records.js';
import { callServer, runMutation } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import {
  bindCollapsibleHeaders,
  bindSortableHeaders,
  collapsibleHeader,
  sortableHeader,
  sortedRows,
} from '../shared/tables.js';

export function renderAssignmentManager(target) {
  advanceScene();
  target.innerHTML = loadingLine('Loading cohorts...');
  callServer('getCohorts').then(function(cohorts) {
    if (!cohorts.length) { target.innerHTML = '<div class="empty">Create a cohort before assigning milestone templates.</div>'; return; }
    const current = cohorts.some(function(cohort) { return cohort.id === state.cohortId; }) ? state.cohortId : cohorts[0].id;
    state.cohortId = current;
    target.innerHTML = `${collapsibleHeader('assignment-selection', 'Cohort and selection', `<div class="toolbar"><label for="assignment-cohort">Cohort</label><select id="assignment-cohort">${cohorts.map(function(cohort) {
      return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === current ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
    }).join('')}</select><label for="baseline-anchor">Baseline anchor date</label><input id="baseline-anchor" type="date"><button type="button" class="button" id="assign-milestones">Assign selected</button><label><input type="checkbox" id="select-all-assignment"> Select all</label><span id="assignment-count" class="muted">${state.assignmentStudentIds.length} selected</span></div>`)}
      ${state.status ? `<p class="status">${escapeHtml(state.status)}</p>` : ''}<div id="assignment-roster">${loadingLine('Loading students...')}</div>`;
    bindCollapsibleHeaders(target);
    document.getElementById('assignment-cohort').addEventListener('change', function(event) {
      state.cohortId = event.target.value;
      state.assignmentStudentIds = [];
      renderAssignmentManager(target);
    });
    document.getElementById('assign-milestones').addEventListener('click', assignSelectedStudents);
    loadAssignmentRoster(current);
  }).catch(showError);
}

export function loadAssignmentRoster(cohortId) {
  callServer('getCohortMembersForAdmin', cohortId).then(function(result) {
    if (state.cohortId !== cohortId || state.adminEntity !== 'assignments') return;
    state.assignmentRoster = result.records || [];
    state.assignmentRosterCohort = cohortId;
    paintAssignmentRoster(cohortId);
  }).catch(showError);
}

export function paintAssignmentRoster(cohortId) {
  const target = document.getElementById('assignment-roster');
  if (!target || state.assignmentRosterCohort !== cohortId) return;
  const records = state.assignmentRoster || [];
  const tableId = 'assignments';
  const sorted = sortedRows(tableId, records.map(function(record, index) { return { record: record, index: index }; }), function(item, key) {
    if (key === 'student') return item.record['Display Name'] || '';
    if (key === 'year') return item.record['Year Group'] || '';
    if (key === 'anchor') return String(item.record.Anchor_Date || '').slice(0, 10);
    return '';
  });
  target.innerHTML = records.length ? `<div class="table-wrap"><table><thead><tr><th>Select</th>${sortableHeader(tableId, 'student', 'Student')}${sortableHeader(tableId, 'year', 'Year Group')}${sortableHeader(tableId, 'anchor', 'Anchor Date')}<th>Action</th></tr></thead><tbody>${sorted.map(function(item) {
    const record = item.record;
    const index = item.index;
    const checked = state.assignmentStudentIds.indexOf(record.StudentId) >= 0;
    const number = record['Student Number'] || record['Student ID'] || '';
    const identity = (number ? 'Student Number ' + number + ' · ' : '') + 'StudentId ' + (record.StudentId || '');
    return `<tr><td><input type="checkbox" data-assignment-student="${index}" value="${escapeHtml(record.StudentId)}" ${checked ? 'checked' : ''}></td><td>${escapeHtml(record['Display Name'])}<br><small>${escapeHtml(identity)}</small></td><td>${escapeHtml(record['Year Group'])}</td><td>${escapeHtml(String(record.Anchor_Date || '').slice(0, 10))}</td><td><button type="button" class="link-button" data-edit-assignment="${index}">Edit</button></td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="empty">No students are listed in this cohort.</div>';
  bindSortableHeaders(target, function() { paintAssignmentRoster(cohortId); });
  target.querySelectorAll('[data-assignment-student]').forEach(function(input) {
    input.addEventListener('change', function() {
      state.assignmentStudentIds = Array.from(target.querySelectorAll('[data-assignment-student]:checked')).map(function(item) { return item.value; });
      const count = document.getElementById('assignment-count');
      if (count) count.textContent = state.assignmentStudentIds.length + ' selected';
      const selectAllBox = document.getElementById('select-all-assignment');
      if (selectAllBox) selectAllBox.checked = records.length > 0 && state.assignmentStudentIds.length === records.length;
    });
  });
  const selectAll = document.getElementById('select-all-assignment');
  if (selectAll) {
    selectAll.checked = records.length > 0 && records.every(function(record) { return state.assignmentStudentIds.indexOf(record.StudentId) >= 0; });
    selectAll.onchange = function() {
      target.querySelectorAll('[data-assignment-student]').forEach(function(input) { input.checked = selectAll.checked; });
      state.assignmentStudentIds = selectAll.checked ? records.map(function(record) { return record.StudentId; }) : [];
      const count = document.getElementById('assignment-count');
      if (count) count.textContent = state.assignmentStudentIds.length + ' selected';
    };
  }
  target.querySelectorAll('[data-edit-assignment]').forEach(function(button) {
    button.addEventListener('click', function() {
      openAssignmentEditor(cohortId, records[Number(button.dataset.editAssignment)]);
    });
  });
}

export function openAssignmentEditor(cohortId, record) {
  if (!record) return;
  const name = record['Display Name'] || record.StudentId || 'student';
  const date = String(record.Anchor_Date || '').slice(0, 10);
  openAdminDialog('assignment-anchor', `<div class="form-panel" role="dialog" aria-modal="true" aria-labelledby="assignment-editor-title"><div class="toolbar"><h2 id="assignment-editor-title">Edit ${escapeHtml(name)}</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <form id="assignment-anchor-form"><div class="field"><label for="assignment-anchor-date">Anchor date</label><input id="assignment-anchor-date" type="date" value="${escapeHtml(date)}"></div>
    <p class="notice error" id="assignment-anchor-error" hidden></p>
    <div class="toolbar"><button class="button" type="submit">Save &amp; sync</button><button class="button secondary" type="button" data-close-admin-dialog>Cancel</button></div></form></div>`);
  const form = document.getElementById('assignment-anchor-form');
  if (!form) return;
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    const input = document.getElementById('assignment-anchor-date');
    const submit = form.querySelector('[type="submit"]');
    const errorNode = document.getElementById('assignment-anchor-error');
    if (errorNode) { errorNode.hidden = true; errorNode.textContent = ''; }
    if (submit) submit.disabled = true;
    runMutation('saveStudentAnchorAndSync', [cohortId, record.StudentId, input ? input.value : ''], {
      key: 'anchor-date:' + record.StudentId
    }).then(function(result) {
      state.status = 'Updated ' + result.updated + ' system due dates.';
      closeAdminDialog();
      showSuccess(state.status);
      loadAssignmentRoster(cohortId);
    }).catch(function(error) {
      if (submit) submit.disabled = false;
      if (errorNode) {
        errorNode.hidden = false;
        errorNode.textContent = error && error.message ? error.message : String(error);
      } else showError(error);
    });
  });
}

export function assignSelectedStudents() {
  const date = document.getElementById('baseline-anchor').value;
  if (!state.assignmentStudentIds.length) { showError(new Error('Select one or more students.')); return; }
  if (!date) { showError(new Error('Choose a baseline anchor date.')); return; }
  const button = document.getElementById('assign-milestones');
  button.disabled = true;
  runMutation('assignMilestonesToStudents', [state.cohortId, state.assignmentStudentIds, date], { key: 'assignments:' + state.cohortId }).then(function(result) {
    state.status = result.createdTasks + ' system action items created for ' + result.assignedStudents + ' students.';
    state.assignmentStudentIds = [];
    button.disabled = false;
    showSuccess(state.status);
  }).catch(function(error) { button.disabled = false; showError(error); });
}
