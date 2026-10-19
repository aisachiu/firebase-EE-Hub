import { adminDialogKind, closeAdminDialog, openAdminDialog } from '../admin/records.js';
import { openStaffQuotas } from '../admin/staff.js';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml, safeUrl } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import {
  bindCollapsibleHeaders,
  bindSortableHeaders,
  collapsibleHeader,
  compareSortValues,
  sortableHeader,
  sortedRows,
} from '../shared/tables.js';
import { requestPush, syncHistory } from '../router.js';
import { renderShell } from '../shell.js';

export function openAllocationTokens() {
  requestPush();
  state.section = 'allocation';
  state.view = 'allocation';
  state.allocationView = 'tokens';
  renderShell();
}

export function renderAllocation() {
  advanceScene();
  const main = document.getElementById('main');
  main.classList.add('plan-wide');
  const view = state.allocationView === 'settings' || state.allocationView === 'tokens' ? state.allocationView : 'dashboard';
  state.allocationView = view;
  const heading = view === 'settings' ? 'Allocation settings' : view === 'tokens' ? 'Cohort allocation tokens' : 'Supervisor allocation';
  const lede = view === 'settings'
    ? 'Ingest student choices and staff tokens, then choose what the dashboard shows.'
    : view === 'tokens'
      ? 'Add, edit, or remove the supervisor tokens already on a cohort. Generating tokens from EE quotas will not replace these.'
      : 'Draft a supervisor for each active student. Publish writes the supervisor and subject onto the live roster.';
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Allocation</p><h1>${heading}</h1><p class="lede">${lede}</p></div></div>
    <nav class="subnav" aria-label="Allocation"><button type="button" data-alloc-view="dashboard" aria-current="${view === 'dashboard' ? 'page' : 'false'}">Dashboard</button><button type="button" data-alloc-view="tokens" aria-current="${view === 'tokens' ? 'page' : 'false'}">Cohort tokens</button><button type="button" data-alloc-view="settings" aria-current="${view === 'settings' ? 'page' : 'false'}">Settings</button></nav>
    <div id="alloc-body">${loadingLine('Loading allocation...')}</div>`;
  main.querySelectorAll('[data-alloc-view]').forEach(function(button) {
    button.addEventListener('click', function() {
      requestPush();
      state.allocationView = button.dataset.allocView;
      renderAllocation();
    });
  });
  loadAllocation();
  syncHistory();
}

export function loadAllocation() {
  const target = document.getElementById('alloc-body');
  if (!target) return;
  callServer('getCohorts').then(function(cohorts) {
    state.allocationCohorts = cohorts || [];
    if (!state.allocationCohorts.length) {
      target.innerHTML = '<div class="empty">Create an active cohort before allocating supervisors.</div>';
      return null;
    }
    if (!state.allocationCohorts.some(function(cohort) { return cohort.id === state.cohortId; })) state.cohortId = state.allocationCohorts[0].id;
    return callServer('getAllocationDesk', state.cohortId);
  }).then(function(desk) {
    if (!desk) return;
    state.allocationDesk = desk;
    paintAllocation();
  }).catch(showError);
}

export function paintAllocation() {
  const target = document.getElementById('alloc-body');
  const desk = state.allocationDesk;
  if (!target || !desk) return;
  if (state.allocationView === 'tokens') {
    paintCohortTokens(target);
    return;
  }
  target.innerHTML = state.allocationView === 'settings' ? allocationSettingsMarkup(desk) : allocationDashboardMarkup(desk);
  bindAllocation(target, desk);
}

export function allocationDashboardMarkup(desk) {
  const students = visibleAllocationStudents(desk);
  const sortable = (desk.settings.columns || []).filter(function(column) { return column.sortable; });
  const supervisors = desk.supervisors || [];
  const openSupervisors = supervisors.filter(function(person) { return person.available > 0; });
  const publish = desk.publish || { drafts: 0, clears: 0, blocked: 0 };
  const summary = desk.summary || { staffCount: 0, tokenCount: 0, activeStudents: 0, buffer: 0 };
  const sortHeader = function(key, label) {
    const active = state.allocationSort === key;
    const mark = !active ? '' : state.allocationSortDir === -1 ? ' ↓' : ' ↑';
    const aria = !active ? 'none' : state.allocationSortDir === -1 ? 'descending' : 'ascending';
    return `<div role="columnheader" aria-sort="${aria}"><button type="button" class="sort-button" data-alloc-sort="${escapeHtml(key)}">${escapeHtml(label)}${mark}</button></div>`;
  };
  return `<div class="alloc-layout"><div>
      ${collapsibleHeader('alloc-filters', 'Filters and selection', `<div class="toolbar"><label for="alloc-cohort">Cohort</label><select id="alloc-cohort">${state.allocationCohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
  }).join('')}</select><span class="muted">${summary.activeStudents} active students · ${summary.tokenCount} tokens · ${summary.buffer >= 0 ? '+' + summary.buffer + ' buffer' : 'short by ' + (-summary.buffer)}</span></div>
      ${desk.warnings && desk.warnings.length ? `<p class="notice">${escapeHtml(desk.warnings[0])}</p>` : ''}
      <div class="alloc-filters">
        <div><span class="alloc-kicker">Status</span><div class="view-toggle" role="group" aria-label="Status">
          ${[['all', 'All'], ['unallocated', 'Unallocated'], ['draft', 'Drafted']].map(function(item) {
            return `<button type="button" data-alloc-status="${item[0]}" aria-pressed="${state.allocationStatus === item[0] ? 'true' : 'false'}">${item[1]}</button>`;
          }).join('')}
        </div></div>
        <div><label for="alloc-support">Support flag</label><select id="alloc-support"><option value="all" ${state.allocationSupport === 'all' ? 'selected' : ''}>All students</option><option value="flagged" ${state.allocationSupport === 'flagged' ? 'selected' : ''}>Flagged only</option></select></div>
        <div><label for="alloc-sort">Sort by</label><select id="alloc-sort"><option value="name" ${state.allocationSort === 'name' ? 'selected' : ''}>Name</option><option value="supervisor" ${state.allocationSort === 'supervisor' ? 'selected' : ''}>Supervisor</option><option value="subject" ${state.allocationSort === 'subject' ? 'selected' : ''}>Requested subjects</option><option value="status" ${state.allocationSort === 'status' ? 'selected' : ''}>Status</option>${sortable.map(function(column) {
          return `<option value="${escapeHtml(column.key)}" ${state.allocationSort === column.key ? 'selected' : ''}>${escapeHtml(column.key)}</option>`;
        }).join('')}</select></div>
      </div>
      <div class="alloc-batch">
        <label><input type="checkbox" id="alloc-select-all" ${students.length && students.every(function(student) { return state.allocationSelected.indexOf(student.studentId) >= 0; }) ? 'checked' : ''}> Select all</label>
        <span class="muted">|</span>
        <span>Apply to selected</span>
        <select id="alloc-batch-supervisor"><option value="">Select supervisor...</option>${openSupervisors.map(function(person) {
          return `<option value="${escapeHtml(person.staffId)}">${escapeHtml(allocationSupervisorLabel(person))}</option>`;
        }).join('')}</select>
        <button type="button" class="button" id="alloc-batch-assign">Assign</button>
        <span class="muted">${state.allocationSelected.length} selected</span>
      </div>`)}
      <div class="alloc-table">
        <div class="alloc-head"><div></div>${sortHeader('name', 'Student')}${sortHeader('supervisor', 'Supervisor')}${sortHeader('subject', 'Requested subjects')}</div>
        ${students.length ? students.map(function(student) { return allocationRowMarkup(student, supervisors); }).join('') : '<div class="empty">No students in this view.</div>'}
      </div>
    </div>
    <aside class="alloc-side">
      <header><h2>Supervisor token load</h2></header>
      ${supervisors.length ? supervisors.map(allocationLoadMarkup).join('') : '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Settings.</div>'}
      <footer>
        <p class="muted">Allocations stay in draft until they are published to the hub.</p>
        <button type="button" class="button" id="alloc-publish" ${publish.blocked || (!publish.drafts && !publish.clears) ? 'disabled' : ''}>Publish allocations to hub</button>
        <p class="muted">${publish.drafts} draft${publish.drafts === 1 ? '' : 's'}${publish.clears ? ' · ' + publish.clears + ' to clear' : ''}</p>
      </footer>
    </aside></div>`;
}

export function allocationRowMarkup(student, supervisors) {
  const subject = selectedAllocationSubject(student);
  const current = student.token ? student.token.staffId : '';
  const options = supervisors.filter(function(person) { return person.available > 0 || person.staffId === current; });
  const cards = (state.allocationDesk.settings.columns || []).filter(function(column) { return column.showOnCard; }).map(function(column) {
    const value = student.dynamicData[column.key];
    if (value === undefined || value === null || value === '') return '';
    return escapeHtml(column.key) + ': ' + escapeHtml(value);
  }).filter(Boolean);
  const choices = [];
  if (student.choices.primary) choices.push(student.choices.primary);
  if (student.choices.secondary && student.choices.secondary !== student.choices.primary) choices.push(student.choices.secondary);
  const statusClass = student.flags.committed ? 'committed' : student.flags.drafted ? 'draft' : '';
  return `<div class="alloc-row">
    <div><input type="checkbox" data-alloc-pick="${escapeHtml(student.studentId)}" ${state.allocationSelected.indexOf(student.studentId) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(student.displayName)}"></div>
    <div>
      <div class="alloc-name">${escapeHtml(student.displayName)}${student.flags.needsSupport ? '<span class="support-badge">Needs support</span>' : ''}${student.choices.interdisciplinary ? '<span class="info-badge">Interdisciplinary</span>' : ''}${student.pendingClear ? '<span class="info-badge">Clears on publish</span>' : ''}</div>
      <div class="alloc-marks">${allocationMark(student.token ? 'Drafted' : 'Unallocated', student.token ? 'on' : 'off')}${allocationMark(student.flags.subjectMatch === 'match' ? 'Subject match' : 'No subject match', student.flags.subjectMatch === 'match' ? 'on' : 'off')}${allocationMark(student.flags.hlMatch === 'miss' ? 'Not an HL match' : student.flags.hlMatch === 'match' ? 'HL match' : 'No HL match', student.flags.hlMatch === 'match' ? 'on' : student.flags.hlMatch === 'miss' ? 'warn' : 'off')}</div>
      <div class="alloc-meta">${cards.join(' <span>|</span> ') || 'No card fields'}${student.flags.committed ? ' <button type="button" class="link-button" data-alloc-reopen="' + escapeHtml(student.studentId) + '">Return to draft</button>' : ''}</div>
    </div>
    <div><select class="alloc-select ${statusClass}" data-alloc-supervisor="${escapeHtml(student.studentId)}" aria-label="Supervisor for ${escapeHtml(student.displayName)}"><option value="">${student.token ? 'Unassigned...' : 'Select...'}</option>${options.map(function(person) {
      return `<option value="${escapeHtml(person.staffId)}" ${person.staffId === current ? 'selected' : ''}>${escapeHtml(allocationSupervisorLabel(person))}</option>`;
    }).join('')}</select></div>
    <div>${choices.map(function(choice) {
      return `<button type="button" class="subject-chip${choice === subject ? ' on' : ''}" data-alloc-subject="${escapeHtml(student.studentId)}" data-subject="${escapeHtml(choice)}">${escapeHtml(choice)}</button>`;
    }).join('') || '<span class="muted">No subject choices</span>'}</div>
  </div>`;
}

export function allocationLoadMarkup(person) {
  const pct = person.total ? Math.round((person.used / person.total) * 100) : 0;
  const tone = person.total && person.used >= person.total ? 'full' : pct >= 60 ? 'mid' : '';
  return `<div class="alloc-load"><p><strong>${escapeHtml(person.displayName)}</strong> <span class="muted">${person.used}/${person.total} slots</span></p><p class="muted">Eligible: ${escapeHtml((person.eligibleSubjects || []).join(', ') || 'None')}</p><div class="alloc-meter ${tone}" role="progressbar" aria-valuenow="${person.used}" aria-valuemin="0" aria-valuemax="${person.total}"><span style="width:${pct}%"></span></div></div>`;
}

export function allocationSettingsMarkup(desk) {
  const settings = desk.settings || {};
  const summary = desk.summary || { staffCount: 0, tokenCount: 0, activeStudents: 0, buffer: 0 };
  const buffer = summary.buffer >= 0
    ? 'Capacity is sufficient. You have +' + summary.buffer + ' buffer tokens.'
    : 'Short by ' + (-summary.buffer) + ' tokens.';
  const columns = settings.detectedDynamicKeys || [];
  const flags = {};
  (settings.columns || []).forEach(function(column) { flags[column.key] = column; });
  return `<div class="toolbar"><label for="alloc-cohort">Cohort</label><select id="alloc-cohort">${state.allocationCohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
  }).join('')}</select></div><div class="alloc-config"><div>
      <section class="alloc-panel"><h2>Google Sheets sync</h2>
        ${desk.driveReady ? '' : `<p class="notice">${escapeHtml(desk.driveError || 'Connect Google in Admin → Google account before ingesting sheets.')}</p>`}
        <label class="field" for="alloc-sheet-url">Spreadsheet link</label>
        <input id="alloc-sheet-url" value="${escapeHtml(state.allocationSheetUrl)}" placeholder="https://docs.google.com/spreadsheets/d/...">
        <div class="field"><span class="alloc-kicker">1. Workspace data (COHORTDATA: ${escapeHtml(state.cohortId)})</span><button type="button" class="button secondary" id="alloc-ingest-workspace">Ingest student data</button><div class="alloc-sync">${settings.lastWorkspaceSync ? 'Last sync: ' + escapeHtml(allocationWhen(settings.lastWorkspaceSync)) : 'Not ingested yet'}</div></div>
        <div class="field"><span class="alloc-kicker">2. Supervisor quotas (SUPERVISORTOKENS: ${escapeHtml(state.cohortId)})</span><button type="button" class="button secondary" id="alloc-ingest-tokens">Ingest staff tokens</button><div class="alloc-sync">${settings.lastTokenSync ? 'Last sync: ' + escapeHtml(allocationWhen(settings.lastTokenSync)) : 'Not ingested yet'}</div><p class="muted">Build the same sheet from Staff users → EE quotas. Applying there uses this top-up and leaves draft and committed tokens in place.</p><button type="button" class="button secondary" id="alloc-open-quotas">Open EE quotas</button></div>
        <div class="field"><span class="alloc-kicker">3. Allocation output</span><button type="button" class="button secondary" id="alloc-export">Export drafts to Sheets</button><div class="alloc-sync" id="alloc-export-result">${settings.lastExport ? 'Last export: ' + escapeHtml(allocationWhen(settings.lastExport)) : 'Not exported yet'}</div></div>
      </section>
      <section class="alloc-panel"><h2>Token summary</h2>
        <p>Total eligible staff <strong>${summary.staffCount}</strong></p>
        <p>Total tokens generated <strong>${summary.tokenCount}</strong></p>
        <p>Total active students <strong>${summary.activeStudents}</strong></p>
        <p class="muted">${escapeHtml(buffer)}</p>
      </section>
    </div>
    <div>
      <section class="alloc-panel"><h2>Subject choice mapping</h2>
        <p class="muted">Map keys from the SubjectChoice JSON, or from columns named Choice_..., onto the dashboard.</p>
        <div class="alloc-map"><label for="alloc-primary">Primary choice</label><select id="alloc-primary">${allocationKeyOptions(settings.detectedChoiceKeys, settings.primaryChoiceKey, false)}</select></div>
        <div class="alloc-map"><label for="alloc-secondary">Secondary choice</label><select id="alloc-secondary">${allocationKeyOptions(settings.detectedChoiceKeys, settings.secondaryChoiceKey, false)}</select></div>
        <div class="alloc-map"><label for="alloc-inter">Is interdisciplinary?</label><select id="alloc-inter">${allocationKeyOptions(settings.detectedChoiceKeys, settings.interdisciplinaryKey, true)}</select></div>
        <div class="alloc-map"><label for="alloc-hl">HL match column</label><select id="alloc-hl">${allocationKeyOptions(columns, settings.hlColumn, true)}</select></div>
        <div class="alloc-map"><label for="alloc-flag">Support flag column</label><select id="alloc-flag">${allocationKeyOptions(columns, settings.supportColumn, true)}</select></div>
      </section>
      <section class="alloc-panel"><h2>Dashboard fields</h2>
        <p class="muted">These columns were detected in the latest COHORTDATA import.</p>
        ${columns.length ? `<div class="table-wrap"><table><thead><tr>${sortableHeader('alloc-columns', 'column', 'Imported column')}<th>Show on card</th><th>Filterable</th><th>Sortable</th></tr></thead><tbody>${sortedRows('alloc-columns', columns, function(key) { return key; }).map(function(key) {
          const column = flags[key] || {};
          return `<tr><td><code>${escapeHtml(key)}</code></td>${['showOnCard', 'filterable', 'sortable'].map(function(flag) {
            return `<td><input type="checkbox" data-alloc-col="${escapeHtml(key)}" data-flag="${flag}" ${column[flag] ? 'checked' : ''} aria-label="${escapeHtml(flag + ' ' + key)}"></td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">Ingest student data to detect columns.</div>'}
        <div class="toolbar"><button type="button" class="button" id="alloc-save-config">Save configuration</button></div>
      </section>
    </div></div>`;
}

export function bindAllocation(target, desk) {
  const cohort = document.getElementById('alloc-cohort');
  if (cohort) cohort.addEventListener('change', function(event) {
    if (adminDialogKind() === 'cohort-token') closeAdminDialog();
    state.cohortId = event.target.value;
    state.allocationSelected = [];
    state.allocationSubjects = {};
    state.tokenEditId = '';
    loadAllocation();
  });
  target.querySelectorAll('[data-alloc-status]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.allocationStatus = button.dataset.allocStatus;
      paintAllocation();
    });
  });
  const support = document.getElementById('alloc-support');
  if (support) support.addEventListener('change', function(event) { state.allocationSupport = event.target.value; paintAllocation(); });
  const sort = document.getElementById('alloc-sort');
  if (sort) sort.addEventListener('change', function(event) {
    state.allocationSort = event.target.value;
    state.allocationSortDir = 1;
    paintAllocation();
  });
  bindCollapsibleHeaders(target);
  bindSortableHeaders(target, function() {
    captureAllocationColumns();
    paintAllocation();
  });
  target.querySelectorAll('[data-alloc-sort]').forEach(function(button) {
    button.addEventListener('click', function() {
      const key = button.getAttribute('data-alloc-sort');
      if (state.allocationSort === key) state.allocationSortDir = state.allocationSortDir === -1 ? 1 : -1;
      else {
        state.allocationSort = key;
        state.allocationSortDir = 1;
      }
      paintAllocation();
    });
  });
  const selectAll = document.getElementById('alloc-select-all');
  if (selectAll) selectAll.addEventListener('change', function(event) {
    const visible = visibleAllocationStudents(desk).map(function(student) { return student.studentId; });
    state.allocationSelected = event.target.checked ? visible : state.allocationSelected.filter(function(id) { return visible.indexOf(id) < 0; });
    paintAllocation();
  });
  target.querySelectorAll('[data-alloc-pick]').forEach(function(box) {
    box.addEventListener('change', function() {
      const id = box.getAttribute('data-alloc-pick');
      state.allocationSelected = box.checked ? state.allocationSelected.concat([id]) : state.allocationSelected.filter(function(item) { return item !== id; });
      paintAllocation();
    });
  });
  const batch = document.getElementById('alloc-batch-assign');
  if (batch) batch.addEventListener('click', assignAllocationBatch);
  target.querySelectorAll('[data-alloc-supervisor]').forEach(function(select) {
    select.addEventListener('change', function() {
      const studentId = select.getAttribute('data-alloc-supervisor');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      callServer('draftAllocation', state.cohortId, studentId, select.value, student ? selectedAllocationSubject(student) : '').then(function() {
        showSuccess(select.value ? 'Draft saved.' : 'Assignment cleared.');
        loadAllocation();
      }).catch(showError);
    });
  });
  target.querySelectorAll('[data-alloc-subject]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-subject');
      const subject = button.getAttribute('data-subject');
      state.allocationSubjects[studentId] = subject;
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (!student || !student.token) { paintAllocation(); return; }
      callServer('draftAllocation', state.cohortId, studentId, student.token.staffId, subject).then(function() {
        loadAllocation();
      }).catch(showError);
    });
  });
  target.querySelectorAll('[data-alloc-reopen]').forEach(function(button) {
    button.addEventListener('click', function() {
      callServer('reopenAllocation', state.cohortId, button.getAttribute('data-alloc-reopen')).then(function() {
        showSuccess('Returned to draft.');
        loadAllocation();
      }).catch(showError);
    });
  });
  const publish = document.getElementById('alloc-publish');
  if (publish) publish.addEventListener('click', publishAllocations);
  const sheetUrl = document.getElementById('alloc-sheet-url');
  if (sheetUrl) sheetUrl.addEventListener('input', function(event) { state.allocationSheetUrl = event.target.value; });
  const ingestWorkspace = document.getElementById('alloc-ingest-workspace');
  if (ingestWorkspace) ingestWorkspace.addEventListener('click', function() { ingestAllocation('workspace'); });
  const ingestTokens = document.getElementById('alloc-ingest-tokens');
  if (ingestTokens) ingestTokens.addEventListener('click', function() { ingestAllocation('tokens'); });
  const exportButton = document.getElementById('alloc-export');
  if (exportButton) exportButton.addEventListener('click', exportAllocations);
  const save = document.getElementById('alloc-save-config');
  if (save) save.addEventListener('click', saveAllocationSettings);
  const openQuotas = document.getElementById('alloc-open-quotas');
  if (openQuotas) openQuotas.addEventListener('click', openStaffQuotas);
}

export let cohortTokenLoad = 0;

export function paintCohortTokens(target) {
  const load = ++cohortTokenLoad;
  target.innerHTML = `<div class="toolbar"><label for="alloc-cohort">Cohort</label><select id="alloc-cohort">${state.allocationCohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
  }).join('')}</select><button type="button" class="button secondary" id="alloc-open-quotas">Edit EE quotas</button></div>${loadingLine('Loading cohort tokens...')}`;
  bindAllocation(target, state.allocationDesk);
  callServer('listCohortTokens', state.cohortId).then(function(board) {
    if (load !== cohortTokenLoad || state.allocationView !== 'tokens') return;
    const host = document.getElementById('alloc-body');
    if (!host) return;
    host.innerHTML = cohortTokensMarkup(board);
    bindAllocation(host, state.allocationDesk);
    bindCohortTokens(board);
  }).catch(showError);
}

export function cohortTokensMarkup(board) {
  const tokens = sortedRows('cohort-tokens', board.tokens || [], function(token, key) {
    if (key === 'staff') return token.staffName || '';
    if (key === 'subjects') return (token.eligibleSubjects || []).join(', ');
    if (key === 'status') return token.status || '';
    if (key === 'student') return token.allocatedTo || '';
    if (key === 'assigned') return token.assignedSubject || '';
    return '';
  });
  const subjects = board.subjects || [];
  const tableId = 'cohort-tokens';
  return `<div class="toolbar"><label for="alloc-cohort">Cohort</label><select id="alloc-cohort">${state.allocationCohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
  }).join('')}</select><button type="button" class="button secondary" id="alloc-open-quotas">Edit EE quotas</button><span class="muted">${tokens.length} token${tokens.length === 1 ? '' : 's'}</span></div>
    <p class="muted">These slots already belong to ${escapeHtml(board.cohortId)}. Adding tokens does not remove the ones here. A published token has to go back to draft on the dashboard before it can be deleted.</p>
    ${collapsibleHeader('token-add', 'Add tokens', `<div class="alloc-batch">
        <label for="token-staff">Staff</label>
        <select id="token-staff"><option value="">Choose staff</option>${(board.staff || []).map(function(person) {
          return `<option value="${escapeHtml(person.email)}">${escapeHtml(person.displayName)}</option>`;
        }).join('')}</select>
        <label for="token-count">How many</label>
        <input id="token-count" inputmode="numeric" value="1" style="width:72px">
        <button type="button" class="button" id="token-add">Add tokens</button>
      </div>
      <div class="quota-pick">${subjects.length ? subjects.map(function(subject) {
        return `<label class="check-option"><input type="checkbox" data-new-token-subject="${escapeHtml(subject)}"> ${escapeHtml(subject)}</label>`;
      }).join('') : '<span class="muted">No active subjects yet.</span>'}</div>`)}
    ${tokens.length ? `<div class="table-wrap"><table><thead><tr>${sortableHeader(tableId, 'staff', 'Staff')}${sortableHeader(tableId, 'subjects', 'EE subjects')}${sortableHeader(tableId, 'status', 'Status')}${sortableHeader(tableId, 'student', 'Student')}${sortableHeader(tableId, 'assigned', 'Assigned subject')}<th>Actions</th></tr></thead><tbody>${tokens.map(function(token) {
      return `<tr>
        <td><strong>${escapeHtml(token.staffName)}</strong><div class="muted">${escapeHtml(token.staffId)}</div></td>
        <td>${escapeHtml((token.eligibleSubjects || []).join(', ') || 'None')}</td>
        <td>${escapeHtml(token.status)}</td>
        <td>${escapeHtml(token.allocatedTo || '—')}</td>
        <td>${escapeHtml(token.assignedSubject || '—')}</td>
        <td><div class="actions"><button type="button" class="link-button" data-token-edit="${escapeHtml(token.id)}">Edit</button>${token.status === 'committed' ? '' : `<button type="button" class="link-button" data-token-delete="${escapeHtml(token.id)}">Delete</button>`}</div></td>
      </tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">This cohort has no tokens yet. Add them here, or generate them from EE quotas.</div>'}`;
}

export function tokenSubjectChoices(token, board) {
  const choices = (board.subjects || []).slice();
  (token.eligibleSubjects || []).forEach(function(subject) {
    if (!choices.some(function(item) { return item.toLowerCase() === subject.toLowerCase(); })) choices.push(subject);
  });
  return choices;
}

export function openTokenEditor(token, board) {
  if (!token) return;
  state.tokenEditId = token.id;
  const choices = tokenSubjectChoices(token, board);
  openAdminDialog('cohort-token', `<div class="form-panel member-editor" role="dialog" aria-modal="true" aria-labelledby="token-editor-title"><div class="toolbar"><h2 id="token-editor-title">Edit token</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p class="muted">${escapeHtml(token.staffName)} · ${escapeHtml(token.staffId)}</p>
    <div class="quota-pick" role="group" aria-label="EE subjects">${choices.length ? choices.map(function(subject) {
      const on = (token.eligibleSubjects || []).some(function(item) { return item.toLowerCase() === subject.toLowerCase(); });
      return `<label class="check-option"><input type="checkbox" data-token-subject="${escapeHtml(subject)}" ${on ? 'checked' : ''}> ${escapeHtml(subject)}</label>`;
    }).join('') : '<span class="muted">No active subjects yet.</span>'}</div>
    <p class="notice error" id="token-editor-error" hidden></p>
    <div class="toolbar"><button type="button" class="button" id="token-editor-save">Save</button><button type="button" class="button secondary" data-close-admin-dialog>Cancel</button></div></div>`);
  const save = document.getElementById('token-editor-save');
  if (!save) return;
  save.addEventListener('click', function() {
    const picked = Array.from(document.querySelectorAll('[data-token-subject]:checked')).map(function(box) {
      return box.getAttribute('data-token-subject');
    });
    save.disabled = true;
    callServer('updateCohortToken', state.cohortId, token.id, picked).then(function() {
      closeAdminDialog();
      showSuccess('Token updated.');
      loadAllocation();
    }).catch(function(error) {
      save.disabled = false;
      const errorNode = document.getElementById('token-editor-error');
      if (errorNode) {
        errorNode.hidden = false;
        errorNode.textContent = error && error.message ? error.message : String(error);
      } else showError(error);
    });
  });
}

export function bindCohortTokens(board) {
  const add = document.getElementById('token-add');
  if (add) add.addEventListener('click', function() {
    const staffId = document.getElementById('token-staff').value;
    const count = document.getElementById('token-count').value;
    const subjects = Array.from(document.querySelectorAll('[data-new-token-subject]:checked')).map(function(box) {
      return box.getAttribute('data-new-token-subject');
    });
    add.disabled = true;
    callServer('addCohortTokens', state.cohortId, staffId, subjects, count).then(function(result) {
      state.tokenEditId = '';
      showSuccess('Added ' + result.created + ' token' + (result.created === 1 ? '' : 's') + '.');
      loadAllocation();
    }).catch(function(error) { add.disabled = false; showError(error); });
  });
  document.querySelectorAll('[data-token-edit]').forEach(function(button) {
    button.addEventListener('click', function() {
      const token = (board.tokens || []).find(function(item) { return item.id === button.getAttribute('data-token-edit'); });
      openTokenEditor(token, board);
    });
  });
  document.querySelectorAll('[data-token-delete]').forEach(function(button) {
    button.addEventListener('click', function() {
      const id = button.getAttribute('data-token-delete');
      const token = (board.tokens || []).find(function(item) { return item.id === id; });
      const who = token ? token.staffName : 'this staff member';
      if (!window.confirm('Delete this token for ' + who + '?')) return;
      callServer('deleteCohortToken', state.cohortId, id).then(function() {
        if (state.tokenEditId === id) closeAdminDialog();
        state.tokenEditId = '';
        showSuccess('Token deleted.');
        loadAllocation();
      }).catch(showError);
    });
  });
}

export function assignAllocationBatch() {
  const staffId = document.getElementById('alloc-batch-supervisor').value;
  if (!staffId) { showError(new Error('Choose a supervisor.')); return; }
  if (!state.allocationSelected.length) { showError(new Error('Select at least one student.')); return; }
  const subjects = {};
  state.allocationSelected.forEach(function(id) { subjects[id] = state.allocationSubjects[id] || ''; });
  callServer('batchDraftAllocations', state.cohortId, staffId, state.allocationSelected.slice(), subjects).then(function(result) {
    const skipped = (result.skipped || []).length;
    showSuccess(result.assigned.length + ' drafted' + (skipped ? '. ' + skipped + ' left unchanged.' : '.'));
    state.allocationSelected = [];
    loadAllocation();
  }).catch(showError);
}

export function publishAllocations() {
  const publish = state.allocationDesk && state.allocationDesk.publish ? state.allocationDesk.publish : { drafts: 0, clears: 0 };
  let message = 'You are about to publish ' + publish.drafts + ' draft allocation' + (publish.drafts === 1 ? '' : 's') + ' to the live Hub.';
  if (publish.clears) message += ' ' + publish.clears + ' released supervisor' + (publish.clears === 1 ? '' : 's') + ' will be cleared.';
  if (!window.confirm(message + ' Proceed?')) return;
  callServer('commitAllocations', state.cohortId).then(function(result) {
    showSuccess('Published ' + result.published + ' allocation' + (result.published === 1 ? '' : 's') + (result.cleared ? ' and cleared ' + result.cleared : '') + '.');
    loadAllocation();
  }).catch(showError);
}

export function ingestAllocation(kind) {
  const url = state.allocationSheetUrl || (document.getElementById('alloc-sheet-url') ? document.getElementById('alloc-sheet-url').value : '');
  if (!url) { showError(new Error('Paste a spreadsheet link.')); return; }
  callServer('previewAllocationIngest', state.cohortId, { url: url }, kind).then(function(preview) {
    const summary = kind === 'workspace'
      ? preview.writing + ' students will update. ' + preview.skipped + ' rows are not on the roster.'
      : preview.creating + ' tokens will be created. ' + preview.writing + ' open slots will take the new subject list.';
    const warnings = (preview.warnings || []).slice(0, 8).join('\n');
    if (!window.confirm(summary + (warnings ? '\n\n' + warnings : '') + '\n\nIngest this sheet?')) return null;
    return callServer('applyAllocationIngest', state.cohortId, { url: url }, kind);
  }).then(function(result) {
    if (!result) return;
    showSuccess(kind === 'workspace' ? 'Student data ingested.' : 'Staff tokens ingested.');
    loadAllocation();
  }).catch(showError);
}

export function exportAllocations() {
  callServer('exportAllocationDrafts', state.cohortId).then(function(exported) {
    const url = safeUrl(exported.url);
    const host = document.getElementById('alloc-export-result');
    if (host) {
      host.innerHTML = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(exported.title || 'Open spreadsheet')}</a>`
        : escapeHtml(exported.shareProblem || 'Export finished.');
    }
    if (url) state.allocationSheetUrl = url;
    const input = document.getElementById('alloc-sheet-url');
    if (input && url) input.value = url;
    showSuccess(exported.shared ? 'Allocation sheet created.' : 'Allocation sheet created. ' + (exported.shareProblem || ''));
    if (state.allocationDesk && state.allocationDesk.settings) state.allocationDesk.settings.lastExport = new Date().toISOString();
  }).catch(showError);
}

export function captureAllocationColumns() {
  const boxes = document.querySelectorAll('[data-alloc-col]');
  if (!boxes.length || !state.allocationDesk || !state.allocationDesk.settings) return;
  const columns = {};
  boxes.forEach(function(box) {
    const key = box.getAttribute('data-alloc-col');
    const flag = box.getAttribute('data-flag');
    if (!columns[key]) columns[key] = { key: key, showOnCard: false, filterable: false, sortable: false };
    columns[key][flag] = box.checked;
  });
  state.allocationDesk.settings.columns = Object.keys(columns).map(function(key) { return columns[key]; });
}

export function saveAllocationSettings() {
  const columns = {};
  document.querySelectorAll('[data-alloc-col]').forEach(function(box) {
    const key = box.getAttribute('data-alloc-col');
    const flag = box.getAttribute('data-flag');
    if (!columns[key]) columns[key] = { key: key, showOnCard: false, filterable: false, sortable: false };
    columns[key][flag] = box.checked;
  });
  const config = {
    primaryChoiceKey: document.getElementById('alloc-primary').value,
    secondaryChoiceKey: document.getElementById('alloc-secondary').value,
    interdisciplinaryKey: document.getElementById('alloc-inter').value,
    hlColumn: document.getElementById('alloc-hl').value,
    supportColumn: document.getElementById('alloc-flag').value,
    columns: Object.keys(columns).map(function(key) { return columns[key]; }),
  };
  callServer('saveAllocationConfig', state.cohortId, config).then(function() {
    showSuccess('Allocation settings saved.');
    loadAllocation();
  }).catch(showError);
}

export function visibleAllocationStudents(desk) {
  const rows = (desk.students || []).filter(function(student) {
    if (state.allocationStatus === 'unallocated' && student.token) return false;
    if (state.allocationStatus === 'draft' && !student.flags.drafted) return false;
    if (state.allocationSupport === 'flagged' && !student.flags.needsSupport) return false;
    return true;
  });
  const dir = state.allocationSortDir === -1 ? -1 : 1;
  rows.sort(function(left, right) {
    return compareSortValues(allocationRank(left, state.allocationSort), allocationRank(right, state.allocationSort), dir) || left.sortName.localeCompare(right.sortName);
  });
  return rows;
}

export function allocationRank(student, key) {
  if (key === 'name') return student.sortName || '';
  if (key === 'supervisor') return student.token && student.token.staffName ? student.token.staffName : '';
  if (key === 'subject') return student.choices && student.choices.primary ? student.choices.primary : '';
  if (key === 'status') return student.flags.committed ? 2 : student.flags.drafted ? 1 : 0;
  const raw = student.dynamicData ? student.dynamicData[key] : '';
  const word = String(raw === undefined || raw === null ? '' : raw).toLowerCase();
  const academic = { weak: 0, low: 1, avg: 2, average: 2, strong: 3, high: 4 };
  if (Object.prototype.hasOwnProperty.call(academic, word)) return academic[word];
  const numeric = Number(raw);
  if (raw !== '' && raw !== null && raw !== undefined && !isNaN(numeric)) return numeric;
  return word;
}

export function selectedAllocationSubject(student) {
  if (state.allocationSubjects[student.studentId]) return state.allocationSubjects[student.studentId];
  if (student.token && student.token.assignedSubject) return student.token.assignedSubject;
  return student.choices.primary || '';
}

export function allocationSupervisorLabel(person) {
  const subjects = (person.eligibleSubjects || []).join(', ');
  const slots = person.available === 1 ? '1 slot' : person.available + ' slots';
  return person.displayName + (subjects ? ' · ' + subjects : '') + ' (' + slots + ')';
}

export function allocationMark(title, mode) {
  const path = mode === 'warn'
    ? '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>'
    : '<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>';
  return `<span class="alloc-mark ${mode}" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg></span>`;
}

export function allocationKeyOptions(keys, current, allowEmpty) {
  const list = (keys || []).slice();
  if (current && list.indexOf(current) < 0) list.unshift(current);
  const blank = allowEmpty ? 'Ignore' : 'Choose';
  return `<option value="">${blank}</option>` + list.map(function(key) {
    return `<option value="${escapeHtml(key)}" ${key === current ? 'selected' : ''}>${escapeHtml(key)}</option>`;
  }).join('');
}

export function allocationWhen(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
