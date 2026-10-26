import { adminDialogKind, adminFieldSortValue, displayField, openEditor, removeRecord } from './records.js';
import { loadAdminSection } from './sections.js';
import { openAllocationTokens } from '../allocation/desk.js';
import { callServer, runMutation } from '../shared/api.js';
import { checkedSubjectsIn, schemaSubjectNames, subjectList, subjectMenuMarkup } from '../shared/checks.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { cssEscape, escapeHtml, safeUrl } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { isStale } from '../shared/scene.js';
import { syncHeaderCohortSelect } from '../shared/staffContext.js';
import { state } from '../shared/state.js';
import {
  bindCollapsibleHeaders,
  bindSortableHeaders,
  collapsibleHeader,
  compareSortValues,
  mergeSelection,
  sortableHeader,
  sortedRows,
  staffNameMatch,
} from '../shared/tables.js';
import { requestPush, syncHistory } from '../router.js';
import { renderShell } from '../shell.js';

export function staffSectionNav() {
  const pane = state.staffPane === 'quotas' ? 'quotas' : 'records';
  return `<nav class="subnav" aria-label="Staff users"><button type="button" data-staff-pane="records" aria-current="${pane === 'records' ? 'page' : 'false'}">Staff records</button><button type="button" data-staff-pane="quotas" aria-current="${pane === 'quotas' ? 'page' : 'false'}">EE quotas</button></nav>`;
}

export function bindStaffPane(root) {
  root.querySelectorAll('[data-staff-pane]').forEach(function(button) {
    button.addEventListener('click', function() {
      requestPush();
      state.staffPane = button.dataset.staffPane === 'quotas' ? 'quotas' : 'records';
      const main = document.getElementById('main');
      if (main) main.classList.toggle('plan-wide', state.staffPane === 'quotas');
      loadAdminSection();
      syncHistory();
    });
  });
}

export function renderStaffRecords(data) {
  state.adminData = data || { records: [], schema: { fields: [] } };
  const target = document.getElementById('admin-records') || document.getElementById('admin-content');
  if (!target) return;
  const activeElement = document.activeElement;
  const filterFocus = activeElement && activeElement.id === 'staff-record-filter';
  const filterCaret = filterFocus ? activeElement.selectionStart : null;
  const fields = state.adminData.schema && state.adminData.schema.fields ? state.adminData.schema.fields : [];
  const columns = fields.filter(function(field) { return field.table !== false; });
  const records = state.adminData.records || [];
  const subjects = schemaSubjectNames(state.adminData);
  const known = {};
  records.forEach(function(record) { known[String(record.EMAIL || '').toLowerCase()] = true; });
  state.staffRecordSelected = (state.staffRecordSelected || []).filter(function(email) { return known[String(email || '').toLowerCase()]; });
  const visible = visibleStaffRecords();
  const selectedVisible = visible.filter(function(record) { return state.staffRecordSelected.indexOf(record.EMAIL) >= 0; }).length;
  const allVisible = visible.length > 0 && selectedVisible === visible.length;
  const subjectBoxes = subjects.length ? subjects.map(function(subject) {
    return `<label class="check-option"><input type="checkbox" data-staff-subject="${escapeHtml(subject)}"> ${escapeHtml(subject)}</label>`;
  }).join('') : '<span class="muted">Add active subjects under Admin → Subjects.</span>';
  target.innerHTML = `${staffSectionNav()}
    <p class="lede">EE subjects are the subjects a staff member can supervise. Pick one or more active subjects on the record, or filter by name and apply a subject change to everyone you select. Selections stay in place when the filter changes.</p>
    <div class="toolbar">
      <button type="button" class="button" id="new-record">Add staff user</button>
      <label for="staff-record-filter">Filter by name</label>
      <input id="staff-record-filter" type="search" placeholder="Name or email" value="${escapeHtml(state.staffRecordQuery || '')}" aria-label="Filter staff by name">
      <span class="muted" id="staff-shown-count">${visible.length} shown · ${records.length} record${records.length === 1 ? '' : 's'}</span>
    </div>
    ${state.status ? `<p class="status">${escapeHtml(state.status)}</p>` : ''}
    ${collapsibleHeader('staff-record-selection', 'Selection', `<div class="alloc-batch">
      <label><input type="checkbox" id="staff-select-shown" ${allVisible ? 'checked' : ''}> Select shown</label>
      <span class="muted" id="staff-selected-count">${state.staffRecordSelected.length} selected</span>
      <div class="quota-pick" role="group" aria-label="Subjects to assign">${subjectBoxes}</div>
      <button type="button" class="button secondary" id="staff-add-subjects">Add subjects to selected</button>
      <button type="button" class="button secondary" id="staff-remove-subjects">Remove subjects from selected</button>
    </div>`)}
    ${records.length ? `<div class="table-wrap"><table><thead><tr>
      <th scope="col"><span class="sr-only">Select</span></th>
      ${columns.map(function(field) { return sortableHeader('admin:staffUsers', field.name, field.label || field.name); }).join('')}
      <th scope="col">Actions</th>
    </tr></thead><tbody id="staff-record-body">${visible.length ? visible.map(function(record) {
      const email = record.EMAIL || '';
      return `<tr>
        <td><input type="checkbox" data-staff-pick="${escapeHtml(email)}" ${state.staffRecordSelected.indexOf(email) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(record.DisplayName || email)}"></td>
        ${columns.map(function(field) {
          if (field.name === 'EESubjects') return `<td>${subjectMenuMarkup(email, record.EESubjects, subjects, 'data-staff-subject-toggle')}</td>`;
          return `<td>${escapeHtml(displayField(field, record))}</td>`;
        }).join('')}
        <td><div class="actions"><button type="button" class="link-button" data-edit="${escapeHtml(email)}">Edit</button><button type="button" class="link-button" data-delete="${escapeHtml(email)}">Delete</button></div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="${columns.length + 2}"><div class="empty">No staff match that name.</div></td></tr>`}</tbody></table></div>` : '<div class="empty">No records yet.</div>'}`;
  bindStaffPane(target);
  bindCollapsibleHeaders(target);
  bindSortableHeaders(target, function() { renderStaffRecords(state.adminData); });
  const addButton = document.getElementById('new-record');
  if (addButton) addButton.addEventListener('click', function() { openEditor(null); });
  const selectShown = document.getElementById('staff-select-shown');
  if (selectShown) {
    selectShown.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    selectShown.addEventListener('change', function(event) {
      state.staffRecordSelected = mergeSelection(state.staffRecordSelected, visibleStaffRecords().map(function(record) { return record.EMAIL; }), event.target.checked);
      refreshStaffRecordRows();
    });
  }
  target.querySelectorAll('[data-staff-pick]').forEach(function(box) {
    box.addEventListener('change', function() {
      const email = box.getAttribute('data-staff-pick');
      state.staffRecordSelected = box.checked
        ? state.staffRecordSelected.concat([email]).filter(function(item, index, list) { return list.indexOf(item) === index; })
        : state.staffRecordSelected.filter(function(item) { return item !== email; });
      const count = document.getElementById('staff-selected-count');
      if (count) count.textContent = state.staffRecordSelected.length + ' selected';
      if (selectShown) {
        const shownSelected = visible.filter(function(record) { return state.staffRecordSelected.indexOf(record.EMAIL) >= 0; }).length;
        selectShown.checked = visible.length > 0 && shownSelected === visible.length;
        selectShown.indeterminate = shownSelected > 0 && shownSelected < visible.length;
      }
    });
  });
  const filter = document.getElementById('staff-record-filter');
  if (filter) filter.addEventListener('input', function(event) {
    state.staffRecordQuery = event.target.value;
    refreshStaffRecordRows();
  });
  const addSubjects = document.getElementById('staff-add-subjects');
  if (addSubjects) addSubjects.addEventListener('click', function() { assignSelectedStaffSubjects(true); });
  const removeSubjects = document.getElementById('staff-remove-subjects');
  if (removeSubjects) removeSubjects.addEventListener('click', function() { assignSelectedStaffSubjects(false); });
  target.querySelectorAll('[data-staff-subject-toggle]').forEach(function(box) {
    box.addEventListener('change', function() {
      const menu = box.closest('details');
      const email = box.getAttribute('data-staff-subject-toggle');
      const record = records.find(function(item) { return item.EMAIL === email; });
      if (!record || !menu) return;
      const previous = subjectList(record.EESubjects);
      record.EESubjects = checkedSubjectsIn(menu);
      const summary = menu.querySelector('summary');
      if (summary) summary.textContent = record.EESubjects.length ? record.EESubjects.join(', ') : 'No subjects';
      runMutation('saveStaffSubjects', [[{ email: email, subjects: record.EESubjects.slice() }]], { key: 'staff-subjects:' + email }).then(function(result) {
        const saved = result && result.staff && result.staff[0];
        if (saved && Array.isArray(saved.subjects)) {
          record.EESubjects = saved.subjects.slice();
          if (summary) summary.textContent = record.EESubjects.length ? record.EESubjects.join(', ') : 'No subjects';
        }
      }).catch(function(error) {
        if (isStale(error)) return;
        record.EESubjects = previous;
        showError(error);
        renderStaffRecords(state.adminData);
      });
    });
  });
  target.querySelectorAll('[data-edit]').forEach(function(button) {
    button.addEventListener('click', function() {
      const record = records.find(function(item) { return item.EMAIL === button.getAttribute('data-edit'); });
      if (record) openEditor(record);
    });
  });
  target.querySelectorAll('[data-delete]').forEach(function(button) {
    button.addEventListener('click', function() {
      const record = records.find(function(item) { return item.EMAIL === button.getAttribute('data-delete'); });
      if (record) removeRecord(record);
    });
  });
  if (state.editingRecord && adminDialogKind() !== 'admin-record' && !filterFocus) openEditor(state.editingRecord.record, true);
  if (filterFocus) {
    const input = document.getElementById('staff-record-filter');
    if (input) {
      input.focus();
      if (filterCaret !== null && input.setSelectionRange) input.setSelectionRange(filterCaret, filterCaret);
    }
  }
}

export function visibleStaffRecords() {
  const records = state.adminData && state.adminData.records ? state.adminData.records : [];
  const fields = state.adminData && state.adminData.schema && state.adminData.schema.fields ? state.adminData.schema.fields : [];
  const columns = fields.filter(function(field) { return field.table !== false; });
  const query = String(state.staffRecordQuery || '').trim().toLowerCase();
  return sortedRows('admin:staffUsers', records, function(record, key) {
    const field = columns.filter(function(column) { return column.name === key; })[0];
    return field ? adminFieldSortValue(field, record) : '';
  }).filter(function(record) { return staffNameMatch(record.DisplayName, record.EMAIL, query); });
}

export function refreshStaffRecordRows() {
  const body = document.getElementById('staff-record-body');
  const records = state.adminData && state.adminData.records ? state.adminData.records : [];
  const fields = state.adminData && state.adminData.schema && state.adminData.schema.fields ? state.adminData.schema.fields : [];
  const columns = fields.filter(function(field) { return field.table !== false; });
  const subjects = schemaSubjectNames(state.adminData);
  const visible = visibleStaffRecords();
  const selectedVisible = visible.filter(function(record) { return state.staffRecordSelected.indexOf(record.EMAIL) >= 0; }).length;
  if (body) {
    body.innerHTML = visible.length ? visible.map(function(record) {
      const email = record.EMAIL || '';
      return `<tr>
        <td><input type="checkbox" data-staff-pick="${escapeHtml(email)}" ${state.staffRecordSelected.indexOf(email) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(record.DisplayName || email)}"></td>
        ${columns.map(function(field) {
          if (field.name === 'EESubjects') return `<td>${subjectMenuMarkup(email, record.EESubjects, subjects, 'data-staff-subject-toggle')}</td>`;
          return `<td>${escapeHtml(displayField(field, record))}</td>`;
        }).join('')}
        <td><div class="actions"><button type="button" class="link-button" data-edit="${escapeHtml(email)}">Edit</button><button type="button" class="link-button" data-delete="${escapeHtml(email)}">Delete</button></div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="${columns.length + 2}"><div class="empty">No staff match that name.</div></td></tr>`;
  }
  const shown = document.getElementById('staff-shown-count');
  if (shown) shown.textContent = visible.length + ' shown · ' + records.length + ' record' + (records.length === 1 ? '' : 's');
  const count = document.getElementById('staff-selected-count');
  if (count) count.textContent = state.staffRecordSelected.length + ' selected';
  const selectShown = document.getElementById('staff-select-shown');
  if (selectShown) {
    selectShown.checked = visible.length > 0 && selectedVisible === visible.length;
    selectShown.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  }
  bindStaffRecordRowEvents(records, visible);
}

export function bindStaffRecordRowEvents(records, visible) {
  const target = document.getElementById('admin-content');
  if (!target) return;
  const selectShown = document.getElementById('staff-select-shown');
  target.querySelectorAll('[data-staff-pick]').forEach(function(box) {
    box.addEventListener('change', function() {
      const email = box.getAttribute('data-staff-pick');
      state.staffRecordSelected = box.checked
        ? state.staffRecordSelected.concat([email]).filter(function(item, index, list) { return list.indexOf(item) === index; })
        : state.staffRecordSelected.filter(function(item) { return item !== email; });
      const count = document.getElementById('staff-selected-count');
      if (count) count.textContent = state.staffRecordSelected.length + ' selected';
      if (selectShown) {
        const shownSelected = visible.filter(function(record) { return state.staffRecordSelected.indexOf(record.EMAIL) >= 0; }).length;
        selectShown.checked = visible.length > 0 && shownSelected === visible.length;
        selectShown.indeterminate = shownSelected > 0 && shownSelected < visible.length;
      }
    });
  });
  target.querySelectorAll('[data-staff-subject-toggle]').forEach(function(box) {
    box.addEventListener('change', function() {
      const menu = box.closest('details');
      const email = box.getAttribute('data-staff-subject-toggle');
      const record = records.find(function(item) { return item.EMAIL === email; });
      if (!record || !menu) return;
      const previous = subjectList(record.EESubjects);
      record.EESubjects = checkedSubjectsIn(menu);
      const summary = menu.querySelector('summary');
      if (summary) summary.textContent = record.EESubjects.length ? record.EESubjects.join(', ') : 'No subjects';
      runMutation('saveStaffSubjects', [[{ email: email, subjects: record.EESubjects.slice() }]], { key: 'staff-subjects:' + email }).then(function(result) {
        const saved = result && result.staff && result.staff[0];
        if (saved && Array.isArray(saved.subjects)) {
          record.EESubjects = saved.subjects.slice();
          if (summary) summary.textContent = record.EESubjects.length ? record.EESubjects.join(', ') : 'No subjects';
        }
      }).catch(function(error) {
        if (isStale(error)) return;
        record.EESubjects = previous;
        showError(error);
        renderStaffRecords(state.adminData);
      });
    });
  });
  target.querySelectorAll('[data-edit]').forEach(function(button) {
    button.addEventListener('click', function() {
      const record = records.find(function(item) { return item.EMAIL === button.getAttribute('data-edit'); });
      if (record) openEditor(record);
    });
  });
  target.querySelectorAll('[data-delete]').forEach(function(button) {
    button.addEventListener('click', function() {
      const record = records.find(function(item) { return item.EMAIL === button.getAttribute('data-delete'); });
      if (record) removeRecord(record);
    });
  });
}

export function assignSelectedStaffSubjects(add) {
  const subjects = Array.from(document.querySelectorAll('[data-staff-subject]:checked')).map(function(box) {
    return box.getAttribute('data-staff-subject');
  });
  if (!state.staffRecordSelected.length) { showError(new Error('Select at least one staff member.')); return; }
  if (!subjects.length) { showError(new Error('Choose at least one subject.')); return; }
  const button = document.getElementById(add ? 'staff-add-subjects' : 'staff-remove-subjects');
  if (button) button.disabled = true;
  runMutation('assignStaffSubjects', [state.staffRecordSelected.slice(), subjects, add ? 'add' : 'remove'], { key: 'staff-subjects-bulk' }).then(function(result) {
    state.status = (add ? 'Added subjects for ' : 'Removed subjects from ') + (result.updated || state.staffRecordSelected.length) + ' staff.';
    showSuccess(state.status);
    return callServer('getAdminRecords', 'staffUsers');
  }).then(function(fresh) {
    if (button) button.disabled = false;
    if (fresh) renderStaffRecords(fresh);
  }).catch(function(error) {
    if (button) button.disabled = false;
    if (isStale(error)) return;
    showError(error);
  });
}

export function renderStaffQuotas(target) {
  if (!target) return;
  const main = document.getElementById('main');
  if (main) main.classList.add('plan-wide');
  target.innerHTML = staffSectionNav() + loadingLine('Loading staff quotas...');
  bindStaffPane(target);
  Promise.all([callServer('getStaffQuotaSheet'), callServer('getCohorts')]).then(function(results) {
    if (state.adminEntity !== 'staffUsers' || state.staffPane !== 'quotas') return;
    const sheet = results[0] || {};
    state.quotaSubjects = sheet.subjects || [];
    state.quotaRows = (sheet.staff || []).map(function(person) {
      return {
        email: person.email,
        displayName: person.displayName || person.email,
        department: person.department || '',
        quota: person.quota === '' || person.quota === undefined || person.quota === null ? '' : String(person.quota),
        subjects: (person.subjects || []).slice(),
      };
    });
    state.quotaCohorts = results[1] || [];
    state.quotaSelected = state.quotaSelected.filter(function(email) {
      return state.quotaRows.some(function(row) { return row.email === email; });
    });
    if (state.quotaCohorts.length && !state.quotaCohorts.some(function(cohort) { return cohort.id === state.cohortId; })) {
      state.cohortId = state.quotaCohorts[0].id;
      syncHeaderCohortSelect();
    }
    paintStaffQuotas();
  }).catch(showError);
}

export function sortedQuotaRows() {
  const rows = state.quotaRows.slice();
  const dir = state.quotaDir === -1 ? -1 : 1;
  const valueOf = function(row) {
    if (state.quotaSort === 'department') return row.department || '';
    if (state.quotaSort === 'quota') return row.quota === '' ? '' : Number(row.quota);
    return row.displayName || '';
  };
  rows.sort(function(left, right) {
    return compareSortValues(valueOf(left), valueOf(right), dir) || left.displayName.toLowerCase().localeCompare(right.displayName.toLowerCase());
  });
  return rows;
}

export function visibleQuotaRows() {
  const query = String(state.quotaQuery || '').trim().toLowerCase();
  return sortedQuotaRows().filter(function(row) { return staffNameMatch(row.displayName, row.email, query); });
}

export function paintStaffQuotas() {
  const target = document.getElementById('admin-content');
  if (!target || state.staffPane !== 'quotas') return;
  const activeElement = document.activeElement;
  const focused = activeElement && activeElement.getAttribute ? activeElement.getAttribute('data-quota') : '';
  const filterFocus = activeElement && activeElement.id === 'quota-filter';
  const filterCaret = filterFocus ? activeElement.selectionStart : null;
  const rows = visibleQuotaRows();
  const selectedCount = state.quotaSelected.length;
  const allVisible = rows.length > 0 && rows.every(function(row) { return state.quotaSelected.indexOf(row.email) >= 0; });
  const sortMark = function(key) {
    if (state.quotaSort !== key) return '';
    return state.quotaDir === -1 ? ' ↓' : ' ↑';
  };
  const quotaAria = function(key) {
    if (state.quotaSort !== key) return 'none';
    return state.quotaDir === -1 ? 'descending' : 'ascending';
  };
  target.innerHTML = `${staffSectionNav()}
    <p class="lede">EE subjects on the staff record are the standing list of what someone can supervise. Open a name and tick the active subjects. Quota is how many supervisor tokens to create for a cohort. Subject changes save to the staff record immediately. Applying tokens adds missing slots and leaves draft or committed tokens in place.</p>
    <div class="toolbar">
      <label for="quota-filter">Filter by name</label>
      <input id="quota-filter" type="search" placeholder="Name or email" value="${escapeHtml(state.quotaQuery || '')}" aria-label="Filter staff by name">
      <span class="muted" id="quota-shown-count">${rows.length} shown</span>
    </div>
    ${collapsibleHeader('quota-selection', 'Selection', `<div class="alloc-batch">
      <label><input type="checkbox" id="quota-select-all" ${allVisible ? 'checked' : ''}> Select shown</label>
      <span class="muted" id="quota-selected-count">${selectedCount} selected</span>
      <label for="quota-bulk">Quota for selected</label>
      <input id="quota-bulk" inputmode="numeric" style="width:72px" placeholder="0">
      <button type="button" class="button secondary" id="quota-apply-bulk">Apply quota</button>
      <button type="button" class="button" id="quota-save">Save quotas</button>
    </div>
    <div class="quota-pick" role="group" aria-label="Subjects to assign">${state.quotaSubjects.length ? state.quotaSubjects.map(function(subject) {
      return `<label class="check-option"><input type="checkbox" data-quota-subject="${escapeHtml(subject)}"> ${escapeHtml(subject)}</label>`;
    }).join('') : '<span class="muted">Add active subjects under Admin → Subjects.</span>'}
      <button type="button" class="button secondary" id="quota-add-subjects">Add subjects to selected</button>
      <button type="button" class="button secondary" id="quota-remove-subjects">Remove subjects from selected</button>
    </div>`)}
    <div class="quota-layout"><div class="table-wrap"><table class="quota-table"><thead><tr>
      <th><span class="sr-only">Select</span></th>
      <th scope="col" aria-sort="${quotaAria('name')}"><button type="button" class="sort-button" data-quota-sort="name">Display name${sortMark('name')}</button></th>
      <th scope="col" aria-sort="${quotaAria('department')}"><button type="button" class="sort-button" data-quota-sort="department">Primary department${sortMark('department')}</button></th>
      <th scope="col" aria-sort="${quotaAria('quota')}"><button type="button" class="sort-button" data-quota-sort="quota">Quota${sortMark('quota')}</button></th>
      <th>EE subjects</th>
    </tr></thead><tbody id="quota-body">${rows.length ? rows.map(function(row) {
      return `<tr>
        <td><input type="checkbox" data-quota-pick="${escapeHtml(row.email)}" ${state.quotaSelected.indexOf(row.email) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(row.displayName)}"></td>
        <td><strong>${escapeHtml(row.displayName)}</strong><div class="muted">${escapeHtml(row.email)}</div></td>
        <td>${escapeHtml(row.department || '—')}</td>
        <td><input data-quota="${escapeHtml(row.email)}" inputmode="numeric" value="${escapeHtml(row.quota)}" aria-label="Quota for ${escapeHtml(row.displayName)}"></td>
        <td>${subjectMenuMarkup(row.email, row.subjects, state.quotaSubjects, 'data-quota-subject-toggle')}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="5"><div class="empty">${state.quotaRows.length ? 'No staff match that name.' : 'No staff users yet.'}</div></td></tr>`}</tbody></table></div>
    <aside class="alloc-side"><header><h2>Subject capacity</h2></header><div id="quota-dashboard"></div>
      <footer>
        <label for="quota-cohort">Cohort</label>
        <select id="quota-cohort">${state.quotaCohorts.map(function(cohort) {
          return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
        }).join('')}</select>
        ${state.quotaCohorts.length ? '' : '<p class="notice">Create a cohort before generating tokens.</p>'}
        <div class="toolbar"><button type="button" class="button secondary" id="quota-export">Export token sheet</button><button type="button" class="button" id="quota-ingest">Apply tokens to cohort</button></div>
        <p id="quota-export-result" class="muted"></p>
        <button type="button" class="link-button" id="quota-open-tokens">Open cohort allocation tokens</button>
      </footer>
    </aside></div>`;
  bindStaffPane(target);
  bindCollapsibleHeaders(target);
  bindStaffQuotas();
  paintQuotaDashboard();
  if (focused) {
    const input = target.querySelector('[data-quota="' + cssEscape(focused) + '"]');
    if (input) input.focus();
  }
  if (filterFocus) {
    const input = document.getElementById('quota-filter');
    if (input) {
      input.focus();
      if (filterCaret !== null && input.setSelectionRange) input.setSelectionRange(filterCaret, filterCaret);
    }
  }
}

export function paintQuotaDashboard() {
  const host = document.getElementById('quota-dashboard');
  if (!host) return;
  const capacity = clientQuotaCapacity(state.quotaRows);
  const lines = capacity.subjects.length ? capacity.subjects.map(function(item) {
    return `<div class="alloc-load"><p><strong>${escapeHtml(item.subject)}</strong> <span class="muted">${item.capacity} spot${item.capacity === 1 ? '' : 's'}</span></p></div>`;
  }).join('') : '<div class="alloc-load"><p class="muted">Enter a quota and subject to see capacity.</p></div>';
  host.innerHTML = `${lines}${capacity.untied ? `<div class="alloc-load"><p class="muted">${capacity.untied} spot${capacity.untied === 1 ? '' : 's'} ${capacity.untied === 1 ? 'is' : 'are'} not tied to a subject.</p></div>` : ''}<div class="alloc-load"><p>Total teacher quota <strong>${capacity.total}</strong></p><p class="muted">This is each teacher’s quota added once. Subject spots above can overlap.</p></div>`;
}

export function clientQuotaCapacity(rows) {
  let total = 0;
  let untied = 0;
  const groups = {};
  const labels = {};
  rows.forEach(function(row) {
    const quota = row.quota === '' ? 0 : Number(row.quota);
    const spots = Number.isInteger(quota) && quota > 0 ? quota : 0;
    total += spots;
    const seen = {};
    const subjects = [];
    (row.subjects || []).forEach(function(subject) {
      const name = String(subject || '').trim();
      const key = name.toLowerCase();
      if (!name || seen[key]) return;
      seen[key] = true;
      subjects.push(name);
    });
    if (spots && !subjects.length) untied += spots;
    if (!spots) return;
    subjects.forEach(function(subject) {
      const key = subject.toLowerCase();
      labels[key] = labels[key] || subject;
      groups[key] = (groups[key] || 0) + spots;
    });
  });
  return {
    total: total,
    untied: untied,
    subjects: Object.keys(groups).sort(function(left, right) { return labels[left].localeCompare(labels[right]); }).map(function(key) {
      return { subject: labels[key], capacity: groups[key] };
    }),
  };
}

export function bindStaffQuotas() {
  const selectAll = document.getElementById('quota-select-all');
  const visible = visibleQuotaRows();
  if (selectAll) {
    const selectedVisible = visible.filter(function(row) { return state.quotaSelected.indexOf(row.email) >= 0; }).length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    selectAll.addEventListener('change', function(event) {
      state.quotaSelected = mergeSelection(state.quotaSelected, visibleQuotaRows().map(function(row) { return row.email; }), event.target.checked);
      refreshQuotaRows();
    });
  }
  const filter = document.getElementById('quota-filter');
  if (filter) filter.addEventListener('input', function(event) {
    state.quotaQuery = event.target.value;
    refreshQuotaRows();
  });
  bindQuotaTableEvents();
  bindQuotaPageActions();
}

export function refreshQuotaRows() {
  const body = document.getElementById('quota-body');
  if (!body) return;
  const rows = visibleQuotaRows();
  const selectedVisible = rows.filter(function(row) { return state.quotaSelected.indexOf(row.email) >= 0; }).length;
  body.innerHTML = rows.length ? rows.map(function(row) {
    return `<tr>
      <td><input type="checkbox" data-quota-pick="${escapeHtml(row.email)}" ${state.quotaSelected.indexOf(row.email) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(row.displayName)}"></td>
      <td><strong>${escapeHtml(row.displayName)}</strong><div class="muted">${escapeHtml(row.email)}</div></td>
      <td>${escapeHtml(row.department || '—')}</td>
      <td><input data-quota="${escapeHtml(row.email)}" inputmode="numeric" value="${escapeHtml(row.quota)}" aria-label="Quota for ${escapeHtml(row.displayName)}"></td>
      <td>${subjectMenuMarkup(row.email, row.subjects, state.quotaSubjects, 'data-quota-subject-toggle')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5"><div class="empty">${state.quotaRows.length ? 'No staff match that name.' : 'No staff users yet.'}</div></td></tr>`;
  const shown = document.getElementById('quota-shown-count');
  if (shown) shown.textContent = rows.length + ' shown';
  const count = document.getElementById('quota-selected-count');
  if (count) count.textContent = state.quotaSelected.length + ' selected';
  const selectAll = document.getElementById('quota-select-all');
  if (selectAll) {
    selectAll.checked = rows.length > 0 && selectedVisible === rows.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < rows.length;
  }
  bindQuotaTableEvents();
}

export function bindQuotaTableEvents() {
  const selectAll = document.getElementById('quota-select-all');
  document.querySelectorAll('[data-quota-pick]').forEach(function(box) {
    box.addEventListener('change', function() {
      const email = box.getAttribute('data-quota-pick');
      state.quotaSelected = box.checked
        ? state.quotaSelected.concat([email]).filter(function(item, index, list) { return list.indexOf(item) === index; })
        : state.quotaSelected.filter(function(item) { return item !== email; });
      const count = document.getElementById('quota-selected-count');
      if (count) count.textContent = state.quotaSelected.length + ' selected';
      if (selectAll) {
        const shown = visibleQuotaRows();
        const shownSelected = shown.filter(function(row) { return state.quotaSelected.indexOf(row.email) >= 0; }).length;
        selectAll.checked = shown.length > 0 && shownSelected === shown.length;
        selectAll.indeterminate = shownSelected > 0 && shownSelected < shown.length;
      }
    });
  });
  document.querySelectorAll('[data-quota]').forEach(function(input) {
    input.addEventListener('input', function() {
      const row = state.quotaRows.find(function(item) { return item.email === input.getAttribute('data-quota'); });
      if (row) row.quota = input.value.trim();
      paintQuotaDashboard();
    });
    input.addEventListener('keydown', function(event) {
      if (event.key !== 'Enter' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (event.target.selectionStart !== event.target.selectionEnd) return;
      }
      event.preventDefault();
      const inputs = Array.from(document.querySelectorAll('[data-quota]'));
      const index = inputs.indexOf(input);
      const next = inputs[event.key === 'ArrowUp' ? index - 1 : index + 1];
      if (next) next.focus();
    });
  });
  document.querySelectorAll('[data-quota-subject-toggle]').forEach(function(box) {
    box.addEventListener('change', function() {
      const menu = box.closest('details');
      const email = box.getAttribute('data-quota-subject-toggle');
      const row = state.quotaRows.find(function(item) { return item.email === email; });
      if (!row || !menu) return;
      const snapshot = cloneQuotaRows();
      row.subjects = checkedSubjectsIn(menu);
      const summary = menu.querySelector('summary');
      if (summary) summary.textContent = row.subjects.length ? row.subjects.join(', ') : 'No subjects';
      paintQuotaDashboard();
  persistQuotaSubjects(snapshot).then(function(result) {
    applySavedQuotaSubjects(result);
    const saved = state.quotaRows.find(function(item) { return item.email === email; });
    if (summary && saved) summary.textContent = saved.subjects.length ? saved.subjects.join(', ') : 'No subjects';
    paintQuotaDashboard();
  }).catch(function(error) { if (!isStale(error)) showError(error); });
    });
  });
}

export function bindQuotaPageActions() {
  document.querySelectorAll('[data-quota-sort]').forEach(function(button) {
    button.addEventListener('click', function() {
      const key = button.getAttribute('data-quota-sort');
      state.quotaDir = state.quotaSort === key ? -state.quotaDir : 1;
      state.quotaSort = key;
      paintStaffQuotas();
    });
  });
  const bulk = document.getElementById('quota-apply-bulk');
  if (bulk) bulk.addEventListener('click', function() {
    const value = document.getElementById('quota-bulk').value.trim();
    if (!state.quotaSelected.length) { showError(new Error('Select at least one staff member.')); return; }
    if (value !== '' && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
      showError(new Error('Quota must be a whole number, or blank.'));
      return;
    }
    state.quotaRows.forEach(function(row) {
      if (state.quotaSelected.indexOf(row.email) >= 0) row.quota = value;
    });
    paintStaffQuotas();
  });
  const addSubjects = document.getElementById('quota-add-subjects');
  if (addSubjects) addSubjects.addEventListener('click', function() { changeSelectedSubjects(true); });
  const removeSubjects = document.getElementById('quota-remove-subjects');
  if (removeSubjects) removeSubjects.addEventListener('click', function() { changeSelectedSubjects(false); });
  const save = document.getElementById('quota-save');
  if (save) save.addEventListener('click', function() {
    save.disabled = true;
    saveQuotaRows().then(function(result) {
      save.disabled = false;
      showSuccess('Saved quotas for ' + result.updated + ' staff.');
    }).catch(function(error) { save.disabled = false; showError(error); });
  });
  const cohort = document.getElementById('quota-cohort');
  if (cohort) cohort.addEventListener('change', function(event) {
    state.cohortId = event.target.value;
    syncHeaderCohortSelect();
  });
  const exportButton = document.getElementById('quota-export');
  if (exportButton) exportButton.addEventListener('click', exportQuotaSheet);
  const ingest = document.getElementById('quota-ingest');
  if (ingest) ingest.addEventListener('click', applyQuotaTokens);
  const openTokens = document.getElementById('quota-open-tokens');
  if (openTokens) openTokens.addEventListener('click', function() { openAllocationTokens(); });
}

export function checkedQuotaSubjects() {
  return Array.from(document.querySelectorAll('[data-quota-subject]:checked')).map(function(box) {
    return box.getAttribute('data-quota-subject');
  });
}

export function changeSelectedSubjects(add) {
  const subjects = checkedQuotaSubjects();
  if (!state.quotaSelected.length) { showError(new Error('Select at least one staff member.')); return; }
  if (!subjects.length) { showError(new Error('Choose at least one subject.')); return; }
  const snapshot = cloneQuotaRows();
  state.quotaRows.forEach(function(row) {
    if (state.quotaSelected.indexOf(row.email) < 0) return;
    if (add) {
      subjects.forEach(function(subject) {
        if (!row.subjects.some(function(item) { return item.toLowerCase() === subject.toLowerCase(); })) row.subjects.push(subject);
      });
    } else {
      row.subjects = row.subjects.filter(function(item) {
        return !subjects.some(function(subject) { return subject.toLowerCase() === item.toLowerCase(); });
      });
    }
  });
  paintStaffQuotas();
  persistQuotaSubjects(snapshot).then(function(result) {
    applySavedQuotaSubjects(result);
    paintStaffQuotas();
    showSuccess((add ? 'Added subjects for ' : 'Removed subjects from ') + state.quotaSelected.length + ' staff.');
  }).catch(function(error) { if (!isStale(error)) showError(error); });
}

export function cloneQuotaRows() {
  return state.quotaRows.map(function(row) {
    return {
      email: row.email,
      displayName: row.displayName,
      department: row.department,
      quota: row.quota,
      subjects: row.subjects.slice()
    };
  });
}

export function applySavedQuotaSubjects(result) {
  (result && result.staff ? result.staff : []).forEach(function(item) {
    const row = state.quotaRows.find(function(entry) { return entry.email === item.email; });
    if (row && Array.isArray(item.subjects)) row.subjects = item.subjects.slice();
  });
}

export function persistQuotaSubjects(snapshot) {
  const payload = state.quotaRows.map(function(row) {
    return { email: row.email, subjects: row.subjects.slice() };
  });
  return runMutation('saveStaffSubjects', [payload], { key: 'quota-subjects' }).catch(function(error) {
    if (isStale(error)) throw error;
    if (snapshot) state.quotaRows = snapshot;
    paintStaffQuotas();
    throw error;
  });
}

export function quotaPayload() {
  return state.quotaRows.map(function(row) {
    return { email: row.email, quota: row.quota === '' ? '' : Number(row.quota), subjects: row.subjects.slice() };
  });
}

export function saveQuotaRows() {
  return callServer('saveStaffQuotas', quotaPayload());
}

export function exportQuotaSheet() {
  if (!state.cohortId) { showError(new Error('Choose a cohort.')); return; }
  const button = document.getElementById('quota-export');
  if (button) button.disabled = true;
  saveQuotaRows().then(function() {
    return callServer('exportStaffQuotaSheet', state.cohortId);
  }).then(function(exported) {
    if (button) button.disabled = false;
    const url = safeUrl(exported.url);
    const host = document.getElementById('quota-export-result');
    if (host) {
      host.innerHTML = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(exported.title || 'Open token sheet')}</a>`
        : escapeHtml(exported.shareProblem || 'Export finished.');
    }
    showSuccess(exported.shared ? 'Token sheet created. Existing cohort tokens were not changed.' : 'Token sheet created. ' + (exported.shareProblem || ''));
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

export function applyQuotaTokens() {
  if (!state.cohortId) { showError(new Error('Choose a cohort.')); return; }
  const button = document.getElementById('quota-ingest');
  if (button) button.disabled = true;
  saveQuotaRows().then(function() {
    return callServer('previewStaffQuotaTokens', state.cohortId);
  }).then(function(preview) {
    const summary = preview.creating + ' tokens will be created. ' + preview.writing + ' open slots will take the new subject list. Draft and committed tokens stay in place.';
    const warnings = (preview.warnings || []).slice(0, 8).join('\n');
    if (!window.confirm(summary + (warnings ? '\n\n' + warnings : '') + '\n\nApply tokens to cohort ' + state.cohortId + '?')) return null;
    return callServer('applyStaffQuotaTokens', state.cohortId);
  }).then(function(result) {
    if (button) button.disabled = false;
    if (!result) return;
    showSuccess('Applied tokens to cohort ' + result.cohortId + '. ' + result.creating + ' created.');
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

export function openStaffQuotas() {
  requestPush();
  state.section = 'admin';
  state.view = 'admin';
  state.adminEntity = 'staffUsers';
  state.staffPane = 'quotas';
  renderShell();
}
