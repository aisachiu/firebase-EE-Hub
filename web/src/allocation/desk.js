import { colorScaleFill, columnScaleExtent, scaleNumber, subjectTokenLoad } from '../../../functions/src/allocationPure.ts';
import { adminDialogKind, closeAdminDialog, openAdminDialog } from '../admin/records.js';
import { openStaffQuotas } from '../admin/staff.js';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml, safeUrl } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { renderSheetIngestPreview } from '../shared/sheetPreview.js';
import { syncHeaderCohortSelect } from '../shared/staffContext.js';
import { state } from '../shared/state.js';
import {
  adminSortState,
  bindCollapsibleHeaders,
  bindSortableHeaders,
  collapsibleHeader,
  sortableHeader,
  sortedRows,
} from '../shared/tables.js';
import { requestPush, syncHistory } from '../router.js';
import { renderShell } from '../navigation.js';
import { workspaceHelpMarkup } from './workspaceHelp.js';

export function openAllocationTokens() {
  if (!requestPush()) return;
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
      if (!requestPush()) return;
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
    syncHeaderCohortSelect();
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

export function allocationDeskColumns(settings) {
  return ((settings && settings.columns) || []).filter(function(column) { return column.showOnCard; });
}

export function allocationDashboardMarkup(desk) {
  const students = visibleAllocationStudents(desk);
  const columns = allocationDeskColumns(desk.settings);
  const sort = adminSortState('alloc-desk');
  const supervisors = desk.supervisors || [];
  const openSupervisors = supervisors.filter(function(person) { return person.available > 0; });
  const publish = desk.publish || { drafts: 0, clears: 0, blocked: 0 };
  const summary = desk.summary || { staffCount: 0, tokenCount: 0, activeStudents: 0, buffer: 0 };
  const extents = {};
  columns.forEach(function(column) {
    if (!column.colorScale) return;
    extents[column.key] = columnScaleExtent(students.map(function(student) {
      return student.dynamicData ? student.dynamicData[column.key] : '';
    }));
  });
  const scaleOn = columns.some(function(column) { return column.colorScale && extents[column.key]; });
  const allSelected = students.length > 0 && students.every(function(student) { return state.allocationSelected.indexOf(student.studentId) >= 0; });
  const sortOption = function(key, label) {
    return `<option value="${escapeHtml(key)}" ${sort.key === key ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  };
  const dynamicHeaders = columns.map(function(column) {
    if (column.sortable === false) return `<th scope="col">${escapeHtml(column.key)}</th>`;
    return sortableHeader('alloc-desk', 'field:' + column.key, column.key);
  }).join('');
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
        <div><label for="alloc-sort">Sort by</label><select id="alloc-sort">${sortOption('name', 'Name')}${sortOption('supervisor', 'Supervisor')}${sortOption('subject', 'Requested subjects')}${sortOption('status', 'Status')}${columns.filter(function(column) { return column.sortable !== false; }).map(function(column) {
          return sortOption('field:' + column.key, column.key);
        }).join('')}</select></div>
      </div>
      <div class="alloc-batch">
        <span>Apply to selected</span>
        <select id="alloc-batch-supervisor"><option value="">Select supervisor...</option>${openSupervisors.map(function(person) {
          return `<option value="${escapeHtml(person.staffId)}">${escapeHtml(allocationSupervisorLabel(person))}</option>`;
        }).join('')}</select>
        <button type="button" class="button" id="alloc-batch-assign">Assign</button>
        <span class="muted">${state.allocationSelected.length} selected</span>
      </div>`)}
      ${scaleOn ? '<p class="muted alloc-scale-note">Blue shading runs from low to high among the students in this view.</p>' : ''}
      <div class="table-wrap alloc-desk-wrap"><table class="alloc-desk">
        <thead><tr>
          <th class="alloc-check" scope="col"><input type="checkbox" id="alloc-select-all" ${allSelected ? 'checked' : ''} aria-label="Select all students"></th>
          ${sortableHeader('alloc-desk', 'name', 'Student')}
          ${sortableHeader('alloc-desk', 'supervisor', 'Supervisor')}
          ${sortableHeader('alloc-desk', 'subject', 'Requested subjects')}
          ${dynamicHeaders}
        </tr></thead>
        <tbody>${students.length ? students.map(function(student) { return allocationRowMarkup(student, supervisors, columns, extents); }).join('') : `<tr><td class="empty" colspan="${4 + columns.length}">No students in this view.</td></tr>`}</tbody>
      </table></div>
    </div>
    <aside class="alloc-side">
      ${allocationLoadPanel(desk, supervisors)}
      <footer>
        <p class="muted">Allocations stay in draft until they are published to the hub.</p>
        <button type="button" class="button" id="alloc-publish" ${publish.blocked || (!publish.drafts && !publish.clears) ? 'disabled' : ''}>Publish allocations to hub</button>
        <p class="muted">${publish.drafts} draft${publish.drafts === 1 ? '' : 's'}${publish.clears ? ' · ' + publish.clears + ' to clear' : ''}</p>
      </footer>
    </aside></div>`;
}

export function allocationRowMarkup(student, supervisors, columns, extents) {
  const subject = selectedAllocationSubject(student);
  const current = student.token ? student.token.staffId : '';
  const options = supervisors.filter(function(person) { return person.available > 0 || person.staffId === current; });
  const choices = [];
  if (student.choices.primary) choices.push(student.choices.primary);
  if (student.choices.secondary && student.choices.secondary !== student.choices.primary) choices.push(student.choices.secondary);
  const statusClass = student.flags.committed ? 'committed' : student.flags.drafted ? 'draft' : '';
  const fields = (columns || []).map(function(column) {
    const value = student.dynamicData ? student.dynamicData[column.key] : '';
    const shown = value === undefined || value === null || value === '' ? '' : String(value);
    const fill = column.colorScale ? colorScaleFill(value, extents ? extents[column.key] : null) : null;
    const style = scaleStyle(fill);
    return `<td${style ? ` class="alloc-scale" style="${style}"` : ''}>${escapeHtml(shown)}</td>`;
  }).join('');
  return `<tr>
    <td class="alloc-check"><input type="checkbox" data-alloc-pick="${escapeHtml(student.studentId)}" ${state.allocationSelected.indexOf(student.studentId) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(student.displayName)}"></td>
    <td>
      <div class="alloc-name">${escapeHtml(student.displayName)}${student.flags.needsSupport ? '<span class="support-badge">Needs support</span>' : ''}${student.choices.interdisciplinary ? '<span class="info-badge">Interdisciplinary</span>' : ''}${student.pendingClear ? '<span class="info-badge">Clears on publish</span>' : ''}</div>
      <div class="alloc-marks">${allocationMark(student.token ? 'Drafted' : 'Unallocated', student.token ? 'on' : 'off')}${allocationMark(student.flags.subjectMatch === 'match' ? 'Subject match' : 'No subject match', student.flags.subjectMatch === 'match' ? 'on' : 'off')}${allocationMark(student.flags.hlMatch === 'miss' ? 'Not an HL match' : student.flags.hlMatch === 'match' ? 'HL match' : 'No HL match', student.flags.hlMatch === 'match' ? 'on' : student.flags.hlMatch === 'miss' ? 'warn' : 'off')}</div>
      ${student.flags.committed ? '<button type="button" class="link-button" data-alloc-reopen="' + escapeHtml(student.studentId) + '">Return to draft</button>' : ''}
    </td>
    <td><select class="alloc-select ${statusClass}" data-alloc-supervisor="${escapeHtml(student.studentId)}" aria-label="Supervisor for ${escapeHtml(student.displayName)}"><option value="">${student.token ? 'Unassigned...' : 'Select...'}</option>${options.map(function(person) {
      return `<option value="${escapeHtml(person.staffId)}" ${person.staffId === current ? 'selected' : ''}>${escapeHtml(allocationSupervisorLabel(person))}</option>`;
    }).join('')}</select></td>
    <td>${choices.map(function(choice) {
      return `<button type="button" class="subject-chip${choice === subject ? ' on' : ''}" data-alloc-subject="${escapeHtml(student.studentId)}" data-subject="${escapeHtml(choice)}">${escapeHtml(choice)}</button>`;
    }).join('') || '<span class="muted">No subject choices</span>'}</td>
    ${fields}
  </tr>`;
}

function scaleStyle(fill) {
  if (!fill) return '';
  const background = /^#[0-9a-fA-F]{6}$/.test(fill.background) ? fill.background : '';
  const color = /^#[0-9a-fA-F]{6}$/.test(fill.color) ? fill.color : '';
  if (!background || !color) return '';
  return 'background:' + background + ';color:' + color;
}

export function allocationTokenSlots(desk) {
  if (desk && Array.isArray(desk.tokenSlots)) return desk.tokenSlots;
  const slots = [];
  ((desk && desk.supervisors) || []).forEach(function(person) {
    const subjects = person.eligibleSubjects || [];
    const available = Math.max(0, Number(person.available) || 0);
    const used = Math.max(0, Number(person.used) || 0);
    for (let index = 0; index < available; index += 1) slots.push({ status: 'available', eligibleSubjects: subjects });
    for (let index = 0; index < used; index += 1) slots.push({ status: 'committed', eligibleSubjects: subjects });
  });
  return slots;
}

export function subjectTokenLoadMarkup(load) {
  const subjects = load.subjects || [];
  if (!subjects.length) {
    if (load.untied) return untiedTokenNote(load.untied);
    return '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Settings.</div>';
  }
  const rows = subjects.map(function(item) {
    return `<tr><th scope="row">${escapeHtml(item.subject)}</th><td>${item.remaining}</td></tr>`;
  }).join('');
  const untied = load.untied ? untiedTokenNote(load.untied) : '';
  const note = load.overlaps ? '<p class="muted alloc-load-note">An open token counts toward every subject it can take.</p>' : '';
  return `<table class="alloc-subject-load"><caption class="sr-only">Tokens remaining by subject</caption><thead><tr><th scope="col">Subject</th><th scope="col">Tokens remaining</th></tr></thead><tbody>${rows}</tbody></table>${untied}${note}`;
}

function untiedTokenNote(count) {
  const noun = count === 1 ? 'token is' : 'tokens are';
  return `<div class="alloc-load"><p class="muted">${count} remaining ${noun} not tied to a subject.</p></div>`;
}

export function allocationLoadPanel(desk, supervisors) {
  const view = state.allocationLoadView === 'supervisor' ? 'supervisor' : 'subject';
  const heading = view === 'subject' ? 'Subject token load' : 'Supervisor token load';
  const body = view === 'subject'
    ? subjectTokenLoadMarkup(subjectTokenLoad(allocationTokenSlots(desk)))
    : (supervisors.length ? supervisors.map(allocationLoadMarkup).join('') : '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Settings.</div>');
  return `<header><h2>${heading}</h2><div class="view-toggle" role="group" aria-label="Token load"><button type="button" data-alloc-load="subject" aria-pressed="${view === 'subject' ? 'true' : 'false'}">Subject</button><button type="button" data-alloc-load="supervisor" aria-pressed="${view === 'supervisor' ? 'true' : 'false'}">Supervisor</button></div></header>${body}`;
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
  const kind = state.allocationIngestKind === 'tokens' ? 'tokens' : 'workspace';
  const flagLabels = [['showOnCard', 'Show in table'], ['filterable', 'Filterable'], ['sortable', 'Sortable'], ['colorScale', 'Color scale']];
  return `<div class="toolbar"><label for="alloc-cohort">Cohort</label><select id="alloc-cohort">${state.allocationCohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
  }).join('')}</select></div>
    <div class="alloc-ingest-layout">
      <section class="alloc-panel"><h2>Google Sheets sync</h2>
        ${desk.driveReady ? '' : `<p class="notice">${escapeHtml(desk.driveError || 'Connect Google in Admin → Google account before ingesting sheets.')}</p>`}
        <p class="doc-hint">Choose workspace or tokens, export a workbook if you need one, paste the link, then preview. Workspace ingest reads <code>COHORTDATA: ${escapeHtml(state.cohortId)}</code> and upserts by StudentId. Token ingest reads <code>SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</code> and tops up quotas. Neither deletes rows that are missing from the sheet.</p>
        <div class="sheet-choices" role="radiogroup" aria-label="Ingest kind">
          <label class="check-option"><input type="radio" name="alloc-ingest-kind" value="workspace" ${kind === 'workspace' ? 'checked' : ''}><span>Workspace data <span class="muted">COHORTDATA: ${escapeHtml(state.cohortId)}</span></span></label>
          <label class="check-option"><input type="radio" name="alloc-ingest-kind" value="tokens" ${kind === 'tokens' ? 'checked' : ''}><span>Supervisor tokens <span class="muted">SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</span></span></label>
        </div>
        <div class="toolbar">
          <button type="button" class="button secondary" id="alloc-export">Export allocation drafts</button>
          <button type="button" class="button secondary" id="alloc-export-tokens">Export token sheet</button>
          <button type="button" class="button secondary" id="alloc-open-quotas">Open EE quotas</button>
        </div>
        <p class="muted">Export allocation drafts writes an <code>ALLOCATIONS: ${escapeHtml(state.cohortId)}</code> tab. Export token sheet writes <code>SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</code> from the EE quotas already saved on staff. Set those quotas before exporting tokens.</p>
        <p id="alloc-export-result" class="muted">${settings.lastExport ? 'Last draft export: ' + escapeHtml(allocationWhen(settings.lastExport)) : 'Drafts not exported yet'}${settings.lastWorkspaceSync ? ' · Workspace: ' + escapeHtml(allocationWhen(settings.lastWorkspaceSync)) : ''}${settings.lastTokenSync ? ' · Tokens: ' + escapeHtml(allocationWhen(settings.lastTokenSync)) : ''}</p>
        <label class="field" for="alloc-sheet-url">Spreadsheet link</label>
        <input id="alloc-sheet-url" value="${escapeHtml(state.allocationSheetUrl)}" placeholder="https://docs.google.com/spreadsheets/d/...">
        <label class="check-option"><input type="checkbox" id="alloc-ingest-confirm"><span id="alloc-confirm-label">${escapeHtml(allocationConfirmCopy(kind))}</span></label>
        <div class="toolbar"><button class="button secondary" id="alloc-preview" type="button">Preview ingest</button><button class="button" id="alloc-apply" type="button" disabled>Apply ingest</button></div>
      </section>
      ${workspaceHelpMarkup(state.cohortId)}
    </div>
    <div id="alloc-preview-result"></div>
    <div class="alloc-config"><div>
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
        <p class="muted">These columns were detected in the latest COHORTDATA import. New columns start visible and sortable. Color scale stays off until you turn it on. It paints numbers, and words such as Weak or Strong, from light blue to deep blue across the students in the current view. It does not use red and green. Uncheck Sortable to leave a column on the desk without a sort button.</p>
        ${columns.length ? `<div class="table-wrap"><table><thead><tr>${sortableHeader('alloc-columns', 'column', 'Imported column')}${flagLabels.map(function(flag) { return `<th>${escapeHtml(flag[1])}</th>`; }).join('')}</tr></thead><tbody>${sortedRows('alloc-columns', columns, function(key) { return key; }).map(function(key) {
          const column = flags[key] || {};
          return `<tr><td><code>${escapeHtml(key)}</code></td>${flagLabels.map(function(flag) {
            return `<td><input type="checkbox" data-alloc-col="${escapeHtml(key)}" data-flag="${flag[0]}" ${column[flag[0]] ? 'checked' : ''} aria-label="${escapeHtml(flag[1] + ' ' + key)}"></td>`;
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
    syncHeaderCohortSelect();
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
  target.querySelectorAll('[data-alloc-load]').forEach(function(button) {
    button.addEventListener('click', function() {
      const next = button.getAttribute('data-alloc-load') === 'supervisor' ? 'supervisor' : 'subject';
      if (state.allocationLoadView === next) return;
      state.allocationLoadView = next;
      paintAllocation();
    });
  });
  const support = document.getElementById('alloc-support');
  if (support) support.addEventListener('change', function(event) { state.allocationSupport = event.target.value; paintAllocation(); });
  const sort = document.getElementById('alloc-sort');
  if (sort) sort.addEventListener('change', function(event) {
    const current = adminSortState('alloc-desk');
    current.key = event.target.value;
    current.dir = 1;
    state.allocationSort = event.target.value;
    state.allocationSortDir = 1;
    paintAllocation();
  });
  bindCollapsibleHeaders(target);
  bindSortableHeaders(target, function() {
    captureAllocationColumns();
    const current = adminSortState('alloc-desk');
    state.allocationSort = current.key;
    state.allocationSortDir = current.dir;
    paintAllocation();
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
  if (sheetUrl) sheetUrl.addEventListener('input', function(event) {
    state.allocationSheetUrl = event.target.value;
    clearAllocationPreview();
  });
  target.querySelectorAll('input[name="alloc-ingest-kind"]').forEach(function(input) {
    input.addEventListener('change', function() {
      state.allocationIngestKind = input.value === 'tokens' ? 'tokens' : 'workspace';
      const label = document.getElementById('alloc-confirm-label');
      if (label) label.textContent = allocationConfirmCopy(state.allocationIngestKind);
      clearAllocationPreview();
    });
  });
  const previewButton = document.getElementById('alloc-preview');
  if (previewButton) previewButton.addEventListener('click', previewAllocationSheet);
  const applyButton = document.getElementById('alloc-apply');
  if (applyButton) applyButton.addEventListener('click', applyAllocationSheet);
  const exportButton = document.getElementById('alloc-export');
  if (exportButton) exportButton.addEventListener('click', exportAllocations);
  const exportTokens = document.getElementById('alloc-export-tokens');
  if (exportTokens) exportTokens.addEventListener('click', exportAllocationTokens);
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

export function allocationConfirmCopy(kind) {
  return kind === 'tokens'
    ? 'Apply this token top-up. Tokens missing from the sheet stay in the hub.'
    : 'Apply this student upsert. Students missing from the sheet stay in the hub.';
}

export function clearAllocationPreview() {
  const apply = document.getElementById('alloc-apply');
  if (apply) apply.disabled = true;
  const preview = document.getElementById('alloc-preview-result');
  if (preview) preview.innerHTML = '';
}

export function allocationSheetUrl() {
  const input = document.getElementById('alloc-sheet-url');
  const url = String((input && input.value) || state.allocationSheetUrl || '').trim();
  state.allocationSheetUrl = url;
  return url;
}

export function previewAllocationSheet() {
  const kind = state.allocationIngestKind === 'tokens' ? 'tokens' : 'workspace';
  const url = allocationSheetUrl();
  if (!url) { showError(new Error('Paste a spreadsheet link.')); return; }
  callServer('previewAllocationIngest', state.cohortId, { url: url }, kind).then(function(preview) {
    const host = document.getElementById('alloc-preview-result');
    if (!host) return;
    host.innerHTML = renderSheetIngestPreview({
      note: preview.note,
      summaryColumns: ['Sheet', 'Rows in the sheet', 'Rows in the hub', 'Rows removed'],
      summaryRows: [[preview.sheet || kind, preview.incoming, preview.existing, preview.removing]],
      detailTitle: 'Incoming and hub',
      detailColumns: [kind === 'tokens' ? 'Staff' : 'Student', 'Action', 'Incoming', 'In the hub'],
      detailRows: (preview.rows || []).map(function(row) { return [row.id, row.action, row.incoming, row.hub]; }),
      warnings: preview.warnings,
    });
    const apply = document.getElementById('alloc-apply');
    if (apply) apply.disabled = false;
  }).catch(showError);
}

export function applyAllocationSheet() {
  const kind = state.allocationIngestKind === 'tokens' ? 'tokens' : 'workspace';
  const url = allocationSheetUrl();
  const confirm = document.getElementById('alloc-ingest-confirm');
  if (!url) { showError(new Error('Paste a spreadsheet link.')); return; }
  if (!confirm || confirm.checked !== true) { showError(new Error(allocationConfirmCopy(kind))); return; }
  const button = document.getElementById('alloc-apply');
  if (button) button.disabled = true;
  callServer('applyAllocationIngest', state.cohortId, { url: url }, kind).then(function() {
    showSuccess(kind === 'workspace' ? 'Student data ingested.' : 'Staff tokens ingested.');
    loadAllocation();
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

export function exportAllocations() {
  callServer('exportAllocationDrafts', state.cohortId).then(function(exported) {
    paintAllocationExport(exported, exported.shared ? 'Allocation sheet created.' : 'Allocation sheet created. ' + (exported.shareProblem || ''));
    if (state.allocationDesk && state.allocationDesk.settings) state.allocationDesk.settings.lastExport = new Date().toISOString();
  }).catch(showError);
}

export function exportAllocationTokens() {
  callServer('exportStaffQuotaSheet', state.cohortId).then(function(exported) {
    paintAllocationExport(exported, exported.shared ? 'Token sheet created. Existing cohort tokens were not changed.' : 'Token sheet created. ' + (exported.shareProblem || ''));
  }).catch(showError);
}

function paintAllocationExport(exported, message) {
  const url = safeUrl(exported.url);
  const host = document.getElementById('alloc-export-result');
  if (host) {
    host.innerHTML = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(exported.title || 'Open spreadsheet')}</a>`
      : escapeHtml(exported.shareProblem || 'Export finished.');
  }
  if (url) {
    state.allocationSheetUrl = url;
    const input = document.getElementById('alloc-sheet-url');
    if (input) input.value = url;
    clearAllocationPreview();
  }
  showSuccess(message);
}

export function captureAllocationColumns() {
  const boxes = document.querySelectorAll('[data-alloc-col]');
  if (!boxes.length || !state.allocationDesk || !state.allocationDesk.settings) return;
  const columns = {};
  boxes.forEach(function(box) {
    const key = box.getAttribute('data-alloc-col');
    const flag = box.getAttribute('data-flag');
    if (!columns[key]) columns[key] = { key: key, showOnCard: false, filterable: false, sortable: false, colorScale: false };
    columns[key][flag] = box.checked;
  });
  state.allocationDesk.settings.columns = Object.keys(columns).map(function(key) { return columns[key]; });
}

export function saveAllocationSettings() {
  const columns = {};
  document.querySelectorAll('[data-alloc-col]').forEach(function(box) {
    const key = box.getAttribute('data-alloc-col');
    const flag = box.getAttribute('data-flag');
    if (!columns[key]) columns[key] = { key: key, showOnCard: false, filterable: false, sortable: false, colorScale: false };
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
  rows.sort(function(left, right) { return left.sortName.localeCompare(right.sortName); });
  return sortedRows('alloc-desk', rows, function(student, key) { return allocationRank(student, key); });
}

export function allocationRank(student, key) {
  if (key === 'name') return student.sortName || '';
  if (key === 'supervisor') return student.token && student.token.staffName ? student.token.staffName : '';
  if (key === 'subject') {
    const choices = [];
    if (student.choices && student.choices.primary) choices.push(student.choices.primary);
    if (student.choices && student.choices.secondary && student.choices.secondary !== student.choices.primary) choices.push(student.choices.secondary);
    return choices.join(', ');
  }
  if (key === 'status') return student.flags.committed ? 2 : student.flags.drafted ? 1 : 0;
  const field = String(key || '').indexOf('field:') === 0 ? String(key).slice(6) : key;
  const raw = student.dynamicData ? student.dynamicData[field] : '';
  if (raw === undefined || raw === null || raw === '') return '';
  const numeric = scaleNumber(raw);
  if (numeric !== null) return numeric;
  return String(raw).toLowerCase();
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
