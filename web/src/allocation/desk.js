import { coalesceKnownSubjects, colorScaleFill, columnMappingsFrom, columnScaleExtent, LIVE_SHEET_FIELDS, LIVE_SHEET_GROUPS, liveLinkProblems, liveSheetLinked, liveSyncAge, scaleNumber, subjectTokenLoad, subjectsOverlap } from '../../../functions/src/allocationPure.ts';
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
import { beginAllocationWatch, overlayPendingEdits, pendingSettled, releaseAllocationWatch, setAllocationPainter } from './realtime.js';
import { workspaceHelpMarkup } from './workspaceHelp.js';

function allocationSection(id, title, body, options) {
  return collapsibleHeader(id, title, body, Object.assign({ titleToggle: true }, options || {}));
}

function syncAllocationDrawerChrome() {
  const onDashboard = state.section === 'allocation' && state.allocationView !== 'settings' && state.allocationView !== 'tokens';
  document.body.classList.toggle('has-alloc-drawer', onDashboard);
  document.body.classList.toggle('alloc-drawer-open', onDashboard && state.allocationDrawerOpen === true);
}

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
  syncAllocationDrawerChrome();
  const heading = view === 'settings' ? 'Student data' : view === 'tokens' ? 'Cohort allocation tokens' : 'Supervisor allocation';
  const lede = view === 'settings'
    ? 'Ingest student choices and staff tokens, then choose what the dashboard shows. The cohort follows the header.'
    : view === 'tokens'
      ? 'Add, edit, or remove the supervisor tokens already on a cohort. Generating tokens from EE quotas will not replace these. The cohort follows the header.'
      : 'Draft a supervisor for each active student. Publish writes the supervisor and subject onto the live roster. The cohort follows the header.';
  const deskReady = !!(state.allocationDesk && state.allocationWatchCohort === state.cohortId);
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Allocation</p><h1>${heading}</h1><p class="lede">${lede}</p></div></div>
    <nav class="subnav" aria-label="Allocation"><button type="button" data-alloc-view="dashboard" aria-current="${view === 'dashboard' ? 'page' : 'false'}">Dashboard</button><button type="button" data-alloc-view="tokens" aria-current="${view === 'tokens' ? 'page' : 'false'}">Cohort tokens</button><button type="button" data-alloc-view="settings" aria-current="${view === 'settings' ? 'page' : 'false'}">Student Data</button></nav>
    <div id="alloc-body">${deskReady ? '' : loadingLine('Loading allocation...')}</div>`;
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
  if (!state.cohortId) {
    callServer('getCohorts').then(function(cohorts) {
      state.allocationCohorts = cohorts || [];
      const host = document.getElementById('alloc-body');
      if (!host) return;
      if (!state.allocationCohorts.length) {
        host.innerHTML = '<div class="empty">Create an active cohort before allocating supervisors.</div>';
        return;
      }
      state.cohortId = state.allocationCohorts[0].id;
      syncHeaderCohortSelect();
      beginAllocationWatch(state.cohortId);
    }).catch(showError);
    return;
  }
  if (!(state.allocationCohorts || []).some(function(cohort) { return cohort.id === state.cohortId; })) {
    callServer('getCohorts').then(function(cohorts) {
      state.allocationCohorts = cohorts || [];
      const host = document.getElementById('alloc-body');
      if (!state.allocationCohorts.length) {
        releaseAllocationWatch();
        if (host) host.innerHTML = '<div class="empty">Create an active cohort before allocating supervisors.</div>';
        return;
      }
      if (!state.allocationCohorts.some(function(cohort) { return cohort.id === state.cohortId; })) {
        state.cohortId = state.allocationCohorts[0].id;
        beginAllocationWatch(state.cohortId);
      }
      syncHeaderCohortSelect();
    }).catch(function() {});
  }
  beginAllocationWatch(state.cohortId);
  if (state.allocationDesk && state.allocationWatchCohort === state.cohortId) paintAllocationLive();
}

export function paintAllocation() {
  const target = document.getElementById('alloc-body');
  const desk = state.allocationDesk;
  if (!target || !desk) return;
  rememberLiveCohort(desk);
  if (state.allocationView === 'tokens') {
    paintCohortTokens(target);
    return;
  }
  syncAllocationDrawerChrome();
  const wrap = document.querySelector('.alloc-desk-wrap');
  const top = wrap ? wrap.scrollTop : 0;
  const left = wrap ? wrap.scrollLeft : 0;
  const page = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
  target.innerHTML = state.allocationView === 'settings' ? allocationSettingsMarkup(desk) : allocationDashboardMarkup(desk);
  bindAllocation(target, desk);
  const next = document.querySelector('.alloc-desk-wrap');
  if (next) {
    next.scrollTop = top;
    next.scrollLeft = left;
  }
  if (document.scrollingElement && page) document.scrollingElement.scrollTop = page;
}

function allocationInteractionHeld() {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || !active.closest || !active.matches) return false;
  if (!active.closest('#alloc-body')) return false;
  return active.matches('select, input, textarea');
}

let interactionReleaseBound = false;

function ensureAllocationInteractionRelease() {
  if (interactionReleaseBound || typeof document === 'undefined') return;
  interactionReleaseBound = true;
  document.addEventListener('focusout', function() {
    window.setTimeout(function() {
      if (!state.allocationPaintDeferred) return;
      if (allocationInteractionHeld()) return;
      state.allocationPaintDeferred = false;
      paintAllocationLive();
    }, 0);
  });
}

function currentSyncAge() {
  const settings = state.allocationDesk && state.allocationDesk.settings;
  return liveSyncAge((settings && (settings.lastSyncedAt || settings.lastLiveSync)) || '', Date.now());
}

function syncAgeNodes() {
  const age = currentSyncAge();
  if (typeof document === 'undefined') return age;
  const ageNode = document.getElementById('alloc-resync-age');
  const button = document.getElementById('alloc-resync-live');
  if (ageNode && age.label) ageNode.textContent = age.label;
  if (button && state.allocationLiveBusy !== 'resync') {
    button.disabled = age.blocked || !!(state.allocationDesk && state.allocationDesk.driveReady === false);
  }
  return age;
}

function armSyncClock() {
  const settings = state.allocationDesk && state.allocationDesk.settings;
  if (!(settings && (settings.lastSyncedAt || settings.lastLiveSync))) return;
  syncAgeNodes();
  if (state.allocationSyncClock) return;
  state.allocationSyncClock = setInterval(function() {
    const onDashboard = state.section === 'allocation' && (state.allocationView || 'dashboard') === 'dashboard';
    const button = typeof document !== 'undefined' ? document.getElementById('alloc-resync-live') : null;
    if (!onDashboard || !button) {
      clearInterval(state.allocationSyncClock);
      state.allocationSyncClock = 0;
      return;
    }
    syncAgeNodes();
  }, 1000);
}

export function paintAllocationLive() {
  if (typeof document === 'undefined') return;
  const target = document.getElementById('alloc-body');
  if (!target || !state.allocationDesk) return;
  armSyncClock();
  if (allocationInteractionHeld()) {
    state.allocationPaintDeferred = true;
    ensureAllocationInteractionRelease();
    return;
  }
  state.allocationPaintDeferred = false;
  paintAllocation();
}

export function allocationDeskColumns(settings) {
  return ((settings && settings.columns) || []).filter(function(column) { return column.showOnCard; });
}

export function allocationDashboardMarkup(desk) {
  const students = visibleAllocationStudents(desk);
  const settings = desk.settings || {};
  const liveLinked = liveSheetLinked(settings);
  const syncedAt = settings.lastSyncedAt || settings.lastLiveSync || '';
  const syncAge = liveSyncAge(syncedAt, Date.now());
  const liveSyncing = state.allocationLiveBusy === 'resync';
  const resyncDisabled = liveSyncing || syncAge.blocked || desk.driveReady === false;
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
      <div class="toolbar">
        <p class="muted">${summary.activeStudents} active students · ${summary.tokenCount} tokens · ${summary.buffer >= 0 ? '+' + summary.buffer + ' buffer' : 'short by ' + (-summary.buffer)}</p>
        ${liveLinked ? `<button type="button" class="button secondary" id="alloc-resync-live" ${resyncDisabled ? 'disabled' : ''} aria-busy="${liveSyncing ? 'true' : 'false'}">Resync Live Choice Data</button>` : ''}
      </div>
      ${liveSyncing ? '<p class="load-status" id="alloc-resync-status">Resyncing live choice data…</p>' : ''}
      ${liveLinked && syncAge.label ? `<p class="muted" id="alloc-resync-age">${escapeHtml(syncAge.label)}</p>` : ''}
      ${liveLinked && syncedAt ? `<p class="muted">Last live sync ${escapeHtml(allocationWhen(syncedAt))}</p>` : ''}
      ${desk.warnings && desk.warnings.length ? `<p class="notice">${escapeHtml(desk.warnings[0])}</p>` : ''}
      ${allocationSection('alloc-filters', 'Filters', `<div class="alloc-filters">
        <div><span class="alloc-kicker">Status</span><div class="view-toggle" role="group" aria-label="Status">
          ${[['all', 'All'], ['unallocated', 'Unallocated'], ['draft', 'Drafted']].map(function(item) {
            return `<button type="button" data-alloc-status="${item[0]}" aria-pressed="${state.allocationStatus === item[0] ? 'true' : 'false'}">${item[1]}</button>`;
          }).join('')}
        </div></div>
        <div><label for="alloc-sort">Sort by</label><select id="alloc-sort">${sortOption('name', 'Name')}${sortOption('supervisor', 'Supervisor')}${sortOption('subject', 'Requested subjects')}${sortOption('status', 'Status')}${columns.filter(function(column) { return column.sortable !== false; }).map(function(column) {
          return sortOption('field:' + column.key, column.key);
        }).join('')}</select></div>
        ${allocationSupportFilterMarkup(desk)}
        ${allocationSubjectFilterMarkup(desk)}
        ${allocationAllocatedFilterMarkup(desk)}
        ${allocationTeacherFilterMarkup(desk)}
        <div><button type="button" class="button secondary" id="alloc-clear-filters">Clear filters</button></div>
      </div>
      <div class="alloc-batch">
        <span>Apply to selected</span>
        <select id="alloc-batch-supervisor"><option value="">Select supervisor...</option>${openSupervisors.map(function(person) {
          return `<option value="${escapeHtml(person.staffId)}">${escapeHtml(allocationSupervisorLabel(person))}</option>`;
        }).join('')}</select>
        <button type="button" class="button" id="alloc-batch-assign">Assign</button>
        <span class="muted">${state.allocationSelected.length} selected</span>
      </div>`)}
      ${allocationLegendMarkup()}
      ${scaleOn ? '<p class="muted alloc-scale-note">Blue shading runs from low to high among the students in this view.</p>' : ''}
      <div class="table-wrap alloc-desk-wrap"><table class="alloc-desk">
        <thead><tr>
          <th class="alloc-check" scope="col"><input type="checkbox" id="alloc-select-all" ${allSelected ? 'checked' : ''} aria-label="Select all students"></th>
          ${sortableHeader('alloc-desk', 'name', 'Student')}
          ${sortableHeader('alloc-desk', 'subject', 'Requested subjects')}
          ${sortableHeader('alloc-desk', 'supervisor', 'Supervisor')}
          ${dynamicHeaders}
        </tr></thead>
        <tbody>${students.length ? students.map(function(student) { return allocationRowMarkup(student, supervisors, columns, extents); }).join('') : `<tr><td class="empty" colspan="${4 + columns.length}">No students in this view.</td></tr>`}</tbody>
      </table></div>
    </div></div>
    ${allocationDrawerMarkup(desk, supervisors, publish)}`;
}

export function allocationRowMarkup(student, supervisors, columns, extents) {
  const subject = selectedAllocationSubject(student);
  const current = student.token ? student.token.staffId : '';
  const options = supervisors.filter(function(person) { return person.available > 0 || person.staffId === current; });
  const requested = allocationRequestedSubjects(student);
  const statusClass = student.flags.committed ? 'committed' : student.flags.drafted ? 'draft' : '';
  const fields = (columns || []).map(function(column) {
    const value = student.dynamicData ? student.dynamicData[column.key] : '';
    const shown = value === undefined || value === null || value === '' ? '' : String(value);
    const fill = column.colorScale ? colorScaleFill(value, extents ? extents[column.key] : null) : null;
    const style = scaleStyle(fill);
    return `<td${style ? ` class="alloc-scale" style="${style}"` : ''}>${escapeHtml(shown)}</td>`;
  }).join('');
  const subjectTags = requested.map(function(choice) {
    const on = sameSubjectName(choice.name, subject) ? ' on' : '';
    const colour = subjectChipStyle(choice.colour);
    return `<button type="button" class="subject-chip${on}" data-alloc-subject="${escapeHtml(student.studentId)}" data-subject="${escapeHtml(choice.name)}"${colour ? ` style="${colour}"` : ''}>${escapeHtml(choice.name)}</button>`;
  }).join('');
  const open = state.allocationOpenStudent === student.studentId;
  const supportTags = allocationSupportMarkup(student);
  const interdisciplinaryOn = allocationInterdisciplinaryOn(student);
  return `<tr>
    <td class="alloc-check"><input type="checkbox" data-alloc-pick="${escapeHtml(student.studentId)}" ${state.allocationSelected.indexOf(student.studentId) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(student.displayName)}"></td>
    <td>
      <div class="alloc-name"><button type="button" class="link-button alloc-student-name" data-alloc-expand="${escapeHtml(student.studentId)}" aria-expanded="${open ? 'true' : 'false'}">${escapeHtml(student.displayName)}</button>${supportTags}${student.choices && student.choices.interdisciplinary ? '<span class="id-tag" title="Requested an interdisciplinary EE">ID</span>' : ''}${student.pendingClear ? '<span class="info-badge">Clears on publish</span>' : ''}</div>
      <div class="alloc-marks">${allocationMark(student.token ? 'Drafted' : 'Unallocated', student.token ? 'on' : 'off')}${allocationMark(student.flags.subjectMatch === 'match' ? 'Subject match' : 'No subject match', student.flags.subjectMatch === 'match' ? 'on' : 'off')}${allocationMark(student.flags.hlMatch === 'miss' ? 'Not an HL match' : student.flags.hlMatch === 'match' ? 'HL match' : 'No HL match', student.flags.hlMatch === 'match' ? 'on' : student.flags.hlMatch === 'miss' ? 'warn' : 'off')}</div>
      ${student.flags.committed ? '<button type="button" class="link-button" data-alloc-reopen="' + escapeHtml(student.studentId) + '">Return to draft</button>' : ''}
    </td>
    <td>${subjectTags || '<span class="muted">No subject choices</span>'}</td>
    <td><select class="alloc-select ${statusClass}" data-alloc-supervisor="${escapeHtml(student.studentId)}" aria-label="Supervisor for ${escapeHtml(student.displayName)}"><option value="">${student.token ? 'Unassigned...' : 'Select...'}</option>${options.map(function(person) {
      return `<option value="${escapeHtml(person.staffId)}" ${person.staffId === current ? 'selected' : ''}>${escapeHtml(allocationSupervisorLabel(person))}</option>`;
    }).join('')}</select>${allocationSupervisorCues(student, supervisors)}<label class="check-option alloc-ee-flag"><input type="checkbox" data-alloc-ee-inter="${escapeHtml(student.studentId)}" ${interdisciplinaryOn ? 'checked' : ''}> Interdisciplinary EE</label></td>
    ${fields}
  </tr>${open ? allocationExpandedMarkup(student, 4 + (columns || []).length) : ''}`;
}

/** One tag per value parsed from the mapped Support Flag column. */
export function allocationSupportMarkup(student) {
  const seen = new Set();
  return (student && student.supportFlags || []).map(function(flag) {
    const label = String(flag || '').trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return '';
    seen.add(key);
    return `<span class="support-tag">${escapeHtml(label)}</span>`;
  }).join('');
}

export function allocationLegendMarkup() {
  const item = function(title, mode, label) {
    return `<span class="alloc-legend-item">${allocationMark(title, mode)}<span>${escapeHtml(label)}</span></span>`;
  };
  return `<div class="alloc-legend" aria-label="Star key">${item('Drafted', 'on', 'Drafted')}${item('Unallocated', 'off', 'Unallocated')}${item('Subject match', 'on', 'Subject match')}${item('No subject match', 'off', 'No subject match')}${item('HL match', 'on', 'HL match')}${item('Not an HL match', 'warn', 'Not an HL match')}</div>`;
}

export function allocationExpandedMarkup(student, colspan) {
  const settings = (state.allocationDesk && state.allocationDesk.settings) || {};
  const requested = allocationRequestedSubjects(student);
  const choice1 = plainChoice(student.choices && student.choices.primary, requested[0] && requested[0].name);
  const choice2 = plainChoice(student.choices && student.choices.secondary, requested[1] && requested[1].name);
  const rawInter = interdisciplinaryRaw(student, settings);
  const interLabel = rawInter === 'Yes' || rawInter === 'No' ? rawInter : (student.choices && student.choices.interdisciplinary ? 'Yes' : 'No');
  const expanded = ((settings.columns) || []).filter(function(column) { return column.expanded; });
  const notes = expanded.map(function(column) {
    const value = student.dynamicData ? student.dynamicData[column.key] : '';
    const shown = value === undefined || value === null || value === '' ? '—' : String(value);
    return `<dt>${escapeHtml(column.key)}</dt><dd>${escapeHtml(shown)}</dd>`;
  }).join('');
  return `<tr class="alloc-expanded"><td colspan="${colspan}"><dl>
    <dt>Choice 1</dt><dd>${escapeHtml(choice1)}</dd>
    <dt>Choice 2</dt><dd>${escapeHtml(choice2)}</dd>
    <dt>Interdisciplinary</dt><dd>${escapeHtml(interLabel)}</dd>
    ${notes}
  </dl></td></tr>`;
}

function plainChoice(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw || raw === '[object Object]' || /^[[{]/.test(raw)) return fallback || '—';
  return raw;
}

function interdisciplinaryRaw(student, settings) {
  const key = settings && settings.interdisciplinaryKey;
  const choices = (student && student.subjectChoices) || {};
  if (!key || !Object.prototype.hasOwnProperty.call(choices, key)) return '';
  const value = choices[key];
  if (value === true) return 'true';
  if (value === false) return 'false';
  return value === undefined || value === null ? '' : String(value);
}

export function allocationInterdisciplinaryOn(student) {
  if (student && Object.prototype.hasOwnProperty.call(state.allocationInterdisciplinary, student.studentId)) {
    return state.allocationInterdisciplinary[student.studentId] === true;
  }
  return !!(student && student.token && student.token.interdisciplinary);
}

export function allocationSubjectFilterMarkup(desk) {
  const options = allocationSubjectOptions(desk);
  if (!options.length) return '';
  const selected = state.allocationSubjectFilter || [];
  const allOn = selected.length === 0;
  const chips = options.map(function(subject) {
    const on = selected.some(function(name) { return sameSubjectName(name, subject.name); });
    const colour = subjectChipStyle(subject.colour);
    return `<button type="button" class="subject-chip" data-alloc-subject-filter="${escapeHtml(subject.name)}" aria-pressed="${on ? 'true' : 'false'}"${colour ? ` style="${colour}"` : ''}>${subjectLabelHtml(subject.name, subject.shortName)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Requested subject</span><div class="alloc-subject-picks" role="group" aria-label="Requested subject"><button type="button" class="alloc-filter-all" data-alloc-subject-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationAllocatedFilterMarkup(desk) {
  const options = allocationAllocatedOptions(desk);
  if (!options.length) return '';
  const selected = state.allocationAllocatedFilter || [];
  const allOn = selected.length === 0;
  const chips = options.map(function(subject) {
    const on = selected.some(function(name) { return sameSubjectName(name, subject.name); });
    const colour = subjectChipStyle(subject.colour);
    return `<button type="button" class="subject-chip" data-alloc-allocated-filter="${escapeHtml(subject.name)}" aria-pressed="${on ? 'true' : 'false'}"${colour ? ` style="${colour}"` : ''}>${subjectLabelHtml(subject.name, subject.shortName)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Allocated subject</span><div class="alloc-subject-picks" role="group" aria-label="Allocated subject"><button type="button" class="alloc-filter-all" data-alloc-allocated-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationTeacherFilterMarkup(desk) {
  const people = (desk.supervisors || []).slice().sort(function(left, right) {
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), undefined, { sensitivity: 'base' });
  });
  if (!people.length) return '';
  const selected = state.allocationTeacherFilter || [];
  const allOn = selected.length === 0;
  const chips = people.map(function(person) {
    const on = selected.indexOf(person.staffId) >= 0;
    return `<button type="button" class="subject-chip" data-alloc-teacher-filter="${escapeHtml(person.staffId)}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(person.displayName || person.staffId)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Allocated teacher</span><div class="alloc-subject-picks" role="group" aria-label="Allocated teacher"><button type="button" class="alloc-filter-all" data-alloc-teacher-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationSupportFilterMarkup(desk) {
  const options = allocationSupportOptions(desk);
  const selected = state.allocationSupportFlags || [];
  const allOn = selected.length === 0;
  const chips = options.map(function(flag) {
    const on = selected.some(function(name) { return sameSubjectName(name, flag); });
    return `<button type="button" class="subject-chip" data-alloc-flag-filter="${escapeHtml(flag)}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(flag)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Support flag</span><div class="alloc-subject-picks" role="group" aria-label="Support flag"><button type="button" class="alloc-filter-all" data-alloc-flag-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationSupportOptions(desk) {
  const seen = new Map();
  (desk.students || []).forEach(function(student) {
    (student.supportFlags || []).forEach(function(flag) {
      const key = String(flag || '').toLowerCase();
      if (key && !seen.has(key)) seen.set(key, String(flag));
    });
  });
  return Array.from(seen.values()).sort(function(left, right) {
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  });
}

export function allocationAllocatedOptions(desk) {
  const seen = new Map();
  allocationSubjectOptions(desk).forEach(function(subject) {
    seen.set(subject.name.toLowerCase(), subject);
  });
  (desk.students || []).forEach(function(student) {
    const name = student.token && student.token.assignedSubject ? String(student.token.assignedSubject) : '';
    if (!name || seen.has(name.toLowerCase())) return;
    seen.set(name.toLowerCase(), { name: name, colour: '' });
  });
  return Array.from(seen.values()).sort(function(left, right) {
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

export function allocationSupervisorCues(student, supervisors) {
  const picked = state.allocationSubjects[student.studentId];
  if (!picked) return '';
  const match = allocationRequestedSubjects(student).filter(function(item) { return sameSubjectName(item.name, picked); })[0];
  const colour = subjectChipStyle(match ? match.colour : '');
  const current = student.token ? student.token.staffId : '';
  const eligible = (supervisors || []).filter(function(person) {
    return subjectsOverlap(picked, person.eligibleSubjects || []);
  });
  if (!eligible.length) return `<p class="muted alloc-cue-empty">No supervisor is eligible for ${escapeHtml(picked)}.</p>`;
  const tags = eligible.map(function(person) {
    const chosen = person.staffId === current;
    return `<button type="button" class="supervisor-cue${chosen ? ' is-chosen' : ''}" data-alloc-supervisor-cue="${escapeHtml(person.staffId)}" data-alloc-cue-student="${escapeHtml(student.studentId)}"${colour ? ` style="${colour}"` : ''}>${escapeHtml(person.displayName)}</button>`;
  }).join('');
  return `<div class="alloc-cues" role="group" aria-label="Supervisors for ${escapeHtml(picked)}">${tags}</div>`;
}

export function subjectChipStyle(colour) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(colour || '').trim());
  if (!match) return '';
  const value = '#' + match[1].toLowerCase();
  return '--subject:' + value + ';--subject-bg:color-mix(in srgb, ' + value + ' 18%, white);--subject-fg:' + value;
}

export function allocationRequestedSubjects(student) {
  const listed = student && Array.isArray(student.requestedSubjects) ? student.requestedSubjects : [];
  const fromServer = listed.map(function(item) {
    if (item && typeof item === 'object') return { name: String(item.name || '').trim(), colour: String(item.colour || item.color || '').trim(), shortName: String(item.shortName || '').trim() };
    return { name: String(item || '').trim(), colour: '', shortName: '' };
  }).filter(function(item) { return item.name; });
  if (fromServer.length) return fromServer;
  const names = [];
  const choices = (student && student.choices) || {};
  if (choices.primary) names.push(String(choices.primary));
  if (choices.secondary && choices.secondary !== choices.primary) names.push(String(choices.secondary));
  return names.filter(Boolean).map(function(name) { return { name: name, colour: '', shortName: '' }; });
}

export function subjectLabelHtml(name, shortName) {
  const full = String(name || '').trim();
  const short = String(shortName || '').trim();
  if (!short || short.toLowerCase() === full.toLowerCase()) return escapeHtml(full);
  return `<span title="${escapeHtml(full)}">${escapeHtml(short)}</span>`;
}

export function subjectCatalogue(desk) {
  return ((desk && desk.subjects) || []).map(function(subject) {
    if (subject && typeof subject === 'object') return { name: String(subject.name || '').trim(), shortName: String(subject.shortName || '').trim(), colour: String(subject.colour || '').trim() };
    return { name: String(subject || '').trim(), shortName: '', colour: '' };
  }).filter(function(subject) { return subject.name; });
}

function catalogueNames(desk) {
  return subjectCatalogue(desk).map(function(subject) { return subject.name; });
}

function shortNameFor(name, desk) {
  const match = subjectCatalogue(desk).find(function(subject) { return sameSubjectName(subject.name, name); });
  return match ? match.shortName : '';
}

export function allocationSubjectOptions(desk) {
  const seen = new Map();
  (desk.students || []).forEach(function(student) {
    allocationRequestedSubjects(student).forEach(function(subject) {
      const key = subject.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, subject);
    });
  });
  return Array.from(seen.values()).sort(function(left, right) {
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

function sameSubjectName(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function toggleNameFilter(current, value) {
  if (!value) return [];
  const next = (current || []).slice();
  const index = next.findIndex(function(name) { return sameSubjectName(name, value); });
  if (index >= 0) next.splice(index, 1);
  else next.push(value);
  return next;
}

export function supervisorAcceptsSubject(desk, staffId, subject) {
  if (!staffId || !subject) return true;
  const person = ((desk && desk.supervisors) || []).find(function(item) { return item.staffId === staffId; });
  return subjectsOverlap(subject, person ? (person.eligibleSubjects || []) : []);
}

function applyPendingDesk() {
  const base = state.allocationRemoteDesk || state.allocationDesk;
  if (!base) return;
  state.allocationDesk = overlayPendingEdits(base, state.allocationPendingEdits);
}

function saveAllocationDraft(studentId, staffId, subject, interdisciplinary, message) {
  const edit = {
    staffId: staffId || '',
    subject: subject || '',
    interdisciplinary: interdisciplinary === true,
    startedAt: new Date().toISOString(),
    acked: false,
  };
  if (!state.allocationRemoteDesk && state.allocationDesk) state.allocationRemoteDesk = state.allocationDesk;
  state.allocationPendingEdits[studentId] = edit;
  delete state.allocationInterdisciplinary[studentId];
  applyPendingDesk();
  paintAllocationLive();
  const cohortId = state.cohortId;
  callServer('draftAllocation', cohortId, studentId, staffId, subject, interdisciplinary === true).then(function(result) {
    if (state.cohortId !== cohortId) return;
    const current = state.allocationPendingEdits[studentId];
    if (current && current !== edit) return;
    if (current === edit) {
      if (result && result.changed === false) {
        delete state.allocationPendingEdits[studentId];
      } else {
        edit.acked = true;
        const remote = (state.allocationRemoteDesk && state.allocationRemoteDesk.students || []).find(function(student) {
          return student.studentId === studentId;
        });
        if (pendingSettled(remote || null, edit)) delete state.allocationPendingEdits[studentId];
      }
      applyPendingDesk();
      paintAllocationLive();
    }
    if (message) showSuccess(message);
    if (state.allocationListenFallback) loadAllocation();
  }).catch(function(error) {
    if (state.cohortId === cohortId && state.allocationPendingEdits[studentId] === edit) {
      delete state.allocationPendingEdits[studentId];
      applyPendingDesk();
      paintAllocationLive();
    }
    showError(error);
  });
}

function allocationModalUpdates(studentId) {
  const updates = [];
  document.querySelectorAll('[data-alloc-modal-field]').forEach(function(input) {
    updates.push({
      studentId: studentId,
      key: input.getAttribute('data-key'),
      value: input.value,
    });
  });
  return updates;
}

export function openAllocationStudentEditor(row, settings) {
  if (!row) return;
  const config = settings || {};
  openAdminDialog('allocation-data', allocationStudentEditorMarkup(row, config));
  const save = document.getElementById('alloc-student-editor-save');
  if (!save) return;
  save.addEventListener('click', function() {
    const updates = allocationModalUpdates(row.studentId);
    const interdisciplinaryKey = config.interdisciplinaryKey || '';
    const invalid = updates.some(function(update) {
      return interdisciplinaryKey && update.key === interdisciplinaryKey && update.value !== 'Yes' && update.value !== 'No';
    });
    const error = document.getElementById('alloc-student-editor-error');
    if (invalid) {
      if (error) {
        error.hidden = false;
        error.textContent = 'Is Interdisciplinary? must be Yes or No.';
      }
      return;
    }
    if (!updates.length) {
      showError(new Error('No allocation fields to save.'));
      return;
    }
    if (error) error.hidden = true;
    save.disabled = true;
    callServer('saveAllocationChoices', state.cohortId, updates).then(function() {
      closeAdminDialog();
      showSuccess('Student allocation data saved.');
      loadAllocation();
    }).catch(function(saveError) {
      save.disabled = false;
      showError(saveError);
    });
  });
}

function bindAllocationData(target, desk) {
  const settings = (desk && desk.settings) || {};
  const field = document.getElementById('alloc-data-field');
  const valueInput = document.getElementById('alloc-data-value');
  const yesNo = document.getElementById('alloc-data-yesno');
  function syncBatchValue() {
    const interdisciplinary = !!(settings.interdisciplinaryKey && field && field.value === settings.interdisciplinaryKey);
    if (valueInput) valueInput.hidden = interdisciplinary;
    if (yesNo) yesNo.hidden = !interdisciplinary;
  }
  if (field) field.addEventListener('change', syncBatchValue);
  syncBatchValue();
  const remember = function(id, checked) {
    if (checked && state.allocationDataSelected.indexOf(id) < 0) state.allocationDataSelected = state.allocationDataSelected.concat([id]);
    if (!checked) state.allocationDataSelected = state.allocationDataSelected.filter(function(item) { return item !== id; });
    const count = document.getElementById('alloc-data-count');
    if (count) count.textContent = state.allocationDataSelected.length + ' selected';
  };
  target.querySelectorAll('[data-alloc-data-pick]').forEach(function(box) {
    box.addEventListener('change', function() {
      remember(box.getAttribute('data-alloc-data-pick'), box.checked);
    });
  });
  const selectAll = document.getElementById('alloc-data-all');
  if (selectAll) selectAll.addEventListener('change', function() {
    const ids = ((desk.choiceRows && desk.choiceRows.length) ? desk.choiceRows : (desk.students || [])).map(function(row) { return row.studentId; });
    state.allocationDataSelected = selectAll.checked ? ids.slice() : [];
    target.querySelectorAll('[data-alloc-data-pick]').forEach(function(box) { box.checked = selectAll.checked; });
    const count = document.getElementById('alloc-data-count');
    if (count) count.textContent = state.allocationDataSelected.length + ' selected';
  });
  const dataRows = (desk.choiceRows && desk.choiceRows.length) ? desk.choiceRows : (desk.students || []);
  target.querySelectorAll('[data-alloc-data-edit]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-data-edit');
      const row = dataRows.find(function(item) { return item.studentId === studentId; });
      openAllocationStudentEditor(row, settings);
    });
  });
  target.querySelectorAll('[data-alloc-row-save]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-row-save');
      const updates = choiceUpdatesFor(studentId);
      if (!updates.length) return;
      button.disabled = true;
      callServer('saveAllocationChoices', state.cohortId, updates).then(function() {
        showSuccess('Choice data saved.');
        loadAllocation();
      }).catch(function(error) {
        button.disabled = false;
        showError(error);
      });
    });
  });
  const batch = document.getElementById('alloc-data-batch');
  if (batch) batch.addEventListener('click', function() {
    const key = field ? field.value : '';
    const interdisciplinary = settings.interdisciplinaryKey && key === settings.interdisciplinaryKey;
    const value = interdisciplinary ? (yesNo ? yesNo.value : '') : (valueInput ? valueInput.value : '');
    if (!key) { showError(new Error('Choose a column.')); return; }
    if (!state.allocationDataSelected.length) { showError(new Error('Select at least one student.')); return; }
    if (interdisciplinary && value !== 'Yes' && value !== 'No') {
      showError(new Error('Is Interdisciplinary? must be Yes or No.'));
      return;
    }
    const updates = state.allocationDataSelected.map(function(studentId) {
      return { studentId: studentId, key: key, value: value };
    });
    batch.disabled = true;
    callServer('saveAllocationChoices', state.cohortId, updates).then(function() {
      state.allocationDataSelected = [];
      showSuccess('Applied to ' + updates.length + ' student' + (updates.length === 1 ? '' : 's') + '.');
      loadAllocation();
    }).catch(function(error) {
      batch.disabled = false;
      showError(error);
    });
  });
}

function choiceUpdatesFor(studentId) {
  const updates = [];
  document.querySelectorAll('[data-alloc-edit]').forEach(function(input) {
    if (input.getAttribute('data-alloc-edit') !== studentId) return;
    updates.push({
      studentId: studentId,
      key: input.getAttribute('data-key'),
      value: input.value,
    });
  });
  return updates;
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

export function subjectTokenLoadMarkup(load, desk) {
  const subjects = load.subjects || [];
  if (!subjects.length) {
    if (load.untied) return untiedTokenNote(load.untied);
    return '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Student Data.</div>';
  }
  const metricTitle = 'Total requested (Pool), total unallocated requesting (UPool), total allocated (Alloc), tokens remaining (Rem).';
  const blocks = subjects.map(function(item) {
    const pool = Number(item.pool) || 0;
    const upool = Number(item.upool) || 0;
    const alloc = Number(item.alloc) || 0;
    const remaining = Number(item.remaining) || 0;
    const total = alloc + remaining;
    return `<div class="alloc-subject-block"><p class="alloc-subject-name">${subjectLabelHtml(item.subject, shortNameFor(item.subject, desk))}</p><p class="alloc-subject-figures" title="${escapeHtml(metricTitle)}">${capacityFigure(pool, remaining)} | ${capacityFigure(upool, remaining)} | ${alloc} | ${remaining}</p>${allocationMeterMarkup(alloc, total)}</div>`;
  }).join('');
  const untied = load.untied ? untiedTokenNote(load.untied) : '';
  const note = load.overlaps ? '<p class="muted alloc-load-note">An open token counts toward every subject it can take.</p>' : '';
  return `<div class="alloc-subject-load"><p class="sr-only">Subject token load</p><p class="alloc-subject-metrics" title="${escapeHtml(metricTitle)}">Pool | UPool | Alloc | Rem</p>${blocks}</div>${untied}${note}`;
}

function capacityFigure(value, remaining) {
  const shown = Number(value) || 0;
  if (shown > (Number(remaining) || 0)) return `<strong class="alloc-capacity-warn">${shown}</strong>`;
  return String(shown);
}

export function allocationMeterMarkup(used, total) {
  const safeUsed = Math.max(0, Number(used) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const pct = safeTotal ? Math.round((safeUsed / safeTotal) * 100) : 0;
  const tone = safeTotal && safeUsed >= safeTotal ? 'full' : pct >= 60 ? 'mid' : '';
  return `<div class="alloc-meter ${tone}" role="progressbar" aria-valuenow="${safeUsed}" aria-valuemin="0" aria-valuemax="${safeTotal}" aria-label="${safeUsed} of ${safeTotal} allocated"><span style="width:${pct}%"></span></div>`;
}

function untiedTokenNote(count) {
  const noun = count === 1 ? 'token is' : 'tokens are';
  return `<div class="alloc-load"><p class="muted">${count} remaining ${noun} not tied to a subject.</p></div>`;
}

export function allocationLoadPanel(desk, supervisors) {
  const view = state.allocationLoadView === 'supervisor' || state.allocationLoadView === 'assigned' ? state.allocationLoadView : 'subject';
  const heading = view === 'assigned' ? 'Assigned tokens' : view === 'supervisor' ? 'Supervisor token load' : 'Subject token load';
  const tokens = desk && Array.isArray(desk.tokenRows) && desk.tokenRows.length ? desk.tokenRows : allocationTokenSlots(desk);
  const body = view === 'assigned'
    ? allocationAssignedMarkup(desk)
    : view === 'subject'
      ? subjectTokenLoadMarkup(subjectTokenLoad(tokens, allocationDemand(desk), catalogueNames(desk)), desk)
      : (supervisors.length ? supervisors.map(allocationLoadMarkup).join('') : '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Student Data.</div>');
  return `<header><h2>${heading}</h2><div class="view-toggle" role="group" aria-label="Token overview"><button type="button" data-alloc-load="subject" aria-pressed="${view === 'subject' ? 'true' : 'false'}">Subject</button><button type="button" data-alloc-load="supervisor" aria-pressed="${view === 'supervisor' ? 'true' : 'false'}">Supervisor</button><button type="button" data-alloc-load="assigned" aria-pressed="${view === 'assigned' ? 'true' : 'false'}">Assigned</button></div></header>${body}`;
}

export function allocationDemand(desk) {
  return ((desk && desk.students) || []).map(function(student) {
    return {
      subjects: allocationRequestedSubjects(student).map(function(item) { return item.name; }),
      allocated: !!student.token,
      assignedSubject: student.token ? student.token.assignedSubject || '' : '',
    };
  });
}

export function allocationAssignedMarkup(desk) {
  const groups = allocationAssignedGroups(desk);
  if (!groups.length) return '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Student Data.</div>';
  return groups.map(function(group) {
    const key = group.subject.toLowerCase();
    const open = state.allocationAssignedOpen[key] === true;
    const people = group.taken.concat(group.available).slice().sort(function(left, right) {
      const staff = String(left.staffName || left.staffId || '').localeCompare(String(right.staffName || right.staffId || ''), undefined, { sensitivity: 'base' });
      if (staff) return staff;
      return String(left.studentName || left.studentId || '').localeCompare(String(right.studentName || right.studentId || ''), undefined, { sensitivity: 'base' });
    }).map(function(token) {
      const openToken = token.status === 'available';
      const student = token.studentName || (openToken ? 'Available' : (token.studentId || 'Available'));
      const tone = openToken ? 'alloc-token-open' : 'alloc-token-taken';
      return `<li class="${tone}"><strong>${escapeHtml(token.staffName || token.staffId || 'Staff')}</strong> · ${escapeHtml(student)}</li>`;
    }).join('');
    const allocated = group.taken.length;
    const total = allocated + group.available.length;
    return `<div class="alloc-assigned"><button type="button" data-alloc-assigned="${escapeHtml(group.subject)}" aria-expanded="${open ? 'true' : 'false'}"><span>${subjectLabelHtml(group.subject, shortNameFor(group.subject, desk))}</span><span class="muted">taken ${group.taken.length} · available ${group.available.length}</span></button>${allocationMeterMarkup(allocated, total)}${open ? `<ul>${people || '<li class="muted">No tokens</li>'}</ul>` : ''}</div>`;
  }).join('');
}

export function allocationAssignedGroups(desk) {
  const rows = (desk && desk.tokenRows) || [];
  const groups = new Map();
  function groupFor(subject) {
    const name = String(subject || '').trim();
    if (!name) return null;
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { subject: name, taken: [], available: [] });
    return groups.get(key);
  }
  rows.forEach(function(token) {
    const eligible = coalesceKnownSubjects(token.eligibleSubjects || [], catalogueNames(desk));
    if (token.status === 'available') {
      (eligible.length ? eligible : ['Untied']).forEach(function(subject) {
        const group = groupFor(subject);
        if (group) group.available.push(token);
      });
      return;
    }
    const assigned = coalesceKnownSubjects([token.assignedSubject || eligible[0] || 'Unassigned'], catalogueNames(desk))[0] || 'Unassigned';
    const group = groupFor(assigned);
    if (group) group.taken.push(token);
  });
  const sortPeople = function(left, right) {
    const staff = String(left.staffName || left.staffId || '').localeCompare(String(right.staffName || right.staffId || ''), undefined, { sensitivity: 'base' });
    if (staff) return staff;
    return String(left.studentName || '').localeCompare(String(right.studentName || ''), undefined, { sensitivity: 'base' });
  };
  return Array.from(groups.values()).map(function(group) {
    group.taken.sort(sortPeople);
    group.available.sort(sortPeople);
    return group;
  }).sort(function(left, right) {
    return left.subject.localeCompare(right.subject, undefined, { sensitivity: 'base' });
  });
}

export function allocationLoadMarkup(person) {
  const eligible = (person.eligibleSubjects || []).map(function(name) {
    return subjectLabelHtml(name, shortNameFor(name, state.allocationDesk));
  }).join(', ');
  return `<div class="alloc-load"><p><strong>${escapeHtml(person.displayName)}</strong> <span class="muted">${person.used}/${person.total} slots</span></p><p class="muted">Eligible: ${eligible || 'None'}</p>${allocationMeterMarkup(person.used, person.total)}</div>`;
}

export function allocationDrawerMarkup(desk, supervisors, publish) {
  const open = state.allocationDrawerOpen === true;
  const summary = publish || { drafts: 0, clears: 0, blocked: 0 };
  return `<aside id="alloc-drawer" class="alloc-drawer${open ? ' open' : ''}" aria-label="Token Overview">
    <button type="button" class="alloc-drawer-peek" id="alloc-drawer-peek" aria-expanded="${open ? 'true' : 'false'}" aria-controls="alloc-drawer-panel">Token Overview</button>
    <div class="alloc-drawer-panel" id="alloc-drawer-panel"${open ? '' : ' inert'} aria-hidden="${open ? 'false' : 'true'}">
      <div class="alloc-drawer-bar"><strong>Token Overview</strong><button type="button" id="alloc-drawer-close">Close</button></div>
      <div class="alloc-drawer-scroll">${allocationLoadPanel(desk, supervisors)}</div>
      <footer>
        <p class="muted">Allocations stay in draft until they are published to the hub.</p>
        <button type="button" class="button" id="alloc-publish" ${summary.blocked || (!summary.drafts && !summary.clears) ? 'disabled' : ''}>Publish allocations to hub</button>
        <p class="muted">${summary.drafts} draft${summary.drafts === 1 ? '' : 's'}${summary.clears ? ' · ' + summary.clears + ' to clear' : ''}</p>
      </footer>
    </div>
  </aside>`;
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
  const flagLabels = [['showOnCard', 'Show in table'], ['filterable', 'Filterable'], ['sortable', 'Sortable'], ['colorScale', 'Color scale'], ['expanded', 'Expanded']];
  const collapsed = { open: false };
  return `<p class="muted">Showing student data for the cohort selected in the header.</p>
    ${allocationSection('alloc-sync', 'Google Sheets sync', `<section class="alloc-panel">
        ${desk.driveReady ? '' : `<p class="notice">${escapeHtml(desk.driveError || 'Connect Google in Admin → Google account before ingesting sheets.')}</p>`}
        <p class="doc-hint">Choose workspace or tokens, export a workbook if you need one, paste the link, then preview. Workspace ingest reads <code>COHORTDATA: ${escapeHtml(state.cohortId)}</code> and upserts by StudentId. Token ingest reads <code>SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</code> and tops up quotas. Neither deletes rows that are missing from the sheet. When a live choice sheet is linked, a workspace ingest keeps the live choice values and live dashboard columns, and still updates the other auxiliary columns.</p>
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
        ${allocationLiveSheetMarkup(desk)}
      </section>`, collapsed)}
    ${allocationSection('alloc-cohortdata', 'COHORTDATA Columns', workspaceHelpMarkup(state.cohortId), collapsed)}
    <div id="alloc-preview-result"></div>
    ${allocationSection('alloc-data', 'Data Management', allocationDataManagementMarkup(desk), collapsed)}
    <div class="alloc-config"><div>
      <section class="alloc-panel"><h2>Token summary</h2>
        <p>Total eligible staff <strong>${summary.staffCount}</strong></p>
        <p>Total tokens generated <strong>${summary.tokenCount}</strong></p>
        <p>Total active students <strong>${summary.activeStudents}</strong></p>
        <p class="muted">${escapeHtml(buffer)}</p>
      </section>
    </div>
    <div>
      ${allocationSection('alloc-choice-map', 'Subject choice mapping', `<p class="muted">Map keys from the SubjectChoice JSON, or from columns named Choice_..., onto the dashboard.</p>
        <div class="alloc-map"><label for="alloc-primary">Primary choice</label><select id="alloc-primary">${allocationKeyOptions(settings.detectedChoiceKeys, settings.primaryChoiceKey, false)}</select></div>
        <div class="alloc-map"><label for="alloc-secondary">Secondary choice</label><select id="alloc-secondary">${allocationKeyOptions(settings.detectedChoiceKeys, settings.secondaryChoiceKey, false)}</select></div>
        <div class="alloc-map"><label for="alloc-inter">Is Interdisciplinary?</label><select id="alloc-inter">${allocationKeyOptions(settings.detectedChoiceKeys, settings.interdisciplinaryKey, true)}</select></div>
        ${interdisciplinaryAuditMarkup(desk)}
        <div class="alloc-map"><label for="alloc-hl">HL match column</label><select id="alloc-hl">${allocationKeyOptions(columns, settings.hlColumn, true)}</select></div>
        <div class="alloc-map"><label for="alloc-flag">Support flag column</label><select id="alloc-flag">${allocationKeyOptions(columns, settings.supportColumn, true)}</select></div>
        <div class="toolbar"><button type="button" class="button" id="alloc-save-config">Save configuration</button></div>`, collapsed)}
      ${allocationSection('alloc-fields', 'Dashboard Fields', `<p class="muted">These columns were detected in the latest COHORTDATA import and on the linked live sheet. Columns that stay in sync with the live sheet are marked LIVE. New columns start visible and sortable. Color scale stays off until you turn it on. It paints numbers, and words such as Weak or Strong, from light blue to deep blue across the students in the current view. It does not use red and green. Uncheck Sortable to leave a column on the desk without a sort button. Check Expanded to show a long note in the row that opens from the student name.</p>
        ${columns.length ? `<div class="table-wrap"><table><thead><tr>${sortableHeader('alloc-columns', 'column', 'Imported column')}${flagLabels.map(function(flag) { return `<th>${escapeHtml(flag[1])}</th>`; }).join('')}</tr></thead><tbody>${sortedRows('alloc-columns', columns, function(key) { return key; }).map(function(key) {
          const column = flags[key] || {};
          const liveBadge = column.source === 'live' ? ' <span class="live-badge">LIVE</span>' : '';
          return `<tr><td><code>${escapeHtml(key)}</code>${liveBadge}</td>${flagLabels.map(function(flag) {
            return `<td><input type="checkbox" data-alloc-col="${escapeHtml(key)}" data-flag="${flag[0]}" ${column[flag[0]] ? 'checked' : ''} aria-label="${escapeHtml(flag[1] + ' ' + key)}"></td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">Ingest student data to detect columns.</div>'}
        <div class="toolbar"><button type="button" class="button" id="alloc-save-config-fields">Save configuration</button></div>`, collapsed)}
    </div></div>`;
}

export function interdisciplinaryAuditMarkup(desk) {
  const settings = (desk && desk.settings) || {};
  const key = settings.interdisciplinaryKey || '';
  const intro = '<p class="muted">Is Interdisciplinary? must be exactly Yes or No.</p>';
  if (!key) return intro;
  const rows = (desk.choiceRows && desk.choiceRows.length ? desk.choiceRows : desk.students) || [];
  const bad = [];
  rows.forEach(function(row) {
    const choices = row.subjectChoices || {};
    if (!Object.prototype.hasOwnProperty.call(choices, key)) return;
    const value = choices[key];
    const shown = value === true || value === false ? String(value) : String(value === undefined || value === null ? '' : value);
    if (shown !== 'Yes' && shown !== 'No') bad.push((row.displayName || row.studentId) + ': ' + (shown || 'blank'));
  });
  if (!bad.length) return intro;
  return intro + `<p class="notice">${escapeHtml(bad.slice(0, 8).join('; '))}${bad.length > 8 ? '…' : ''}</p>`;
}

export function allocationDataFields(settings) {
  const config = settings || {};
  const columns = config.columns || [];
  const sourceOf = {};
  columns.forEach(function(column) {
    if (!column || !column.key) return;
    sourceOf[column.key] = column.source === 'live' ? 'live' : 'static';
  });
  const seen = {};
  const fields = [];
  function add(key, group) {
    const name = String(key || '').trim();
    if (!name || seen[name]) return;
    seen[name] = true;
    fields.push({
      key: name,
      group: group,
      source: group === 'choice' ? 'static' : (sourceOf[name] === 'live' ? 'live' : 'static'),
    });
  }
  (config.detectedChoiceKeys || []).forEach(function(key) { add(key, 'choice'); });
  const dynamic = config.detectedDynamicKeys && config.detectedDynamicKeys.length
    ? config.detectedDynamicKeys
    : columns.map(function(column) { return column && column.key; });
  dynamic.forEach(function(key) { add(key, 'dynamic'); });
  return fields;
}

function allocationStoredValue(bag, key) {
  const source = bag || {};
  if (!Object.prototype.hasOwnProperty.call(source, key)) return '';
  const raw = source[key];
  if (raw === true || raw === false) return String(raw);
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

export function allocationStudentEditorMarkup(row, settings) {
  const config = settings || {};
  const fields = allocationDataFields(config);
  const name = (row && (row.displayName || row.studentId)) || 'student';
  const interdisciplinaryKey = config.interdisciplinaryKey || '';
  const controls = fields.map(function(field, index) {
    const shown = allocationStoredValue(field.group === 'choice' ? row.subjectChoices : row.dynamicData, field.key);
    const live = field.source === 'live' ? ' <span class="live-badge">LIVE</span>' : '';
    const inputId = 'alloc-modal-field-' + index;
    const label = field.key + ' for ' + name;
    let control = '';
    if (interdisciplinaryKey && field.key === interdisciplinaryKey) {
      const valid = shown === 'Yes' || shown === 'No';
      control = `<select id="${inputId}" data-alloc-modal-field data-key="${escapeHtml(field.key)}" aria-label="${escapeHtml(label)}"><option value="">Choose</option><option value="Yes" ${shown === 'Yes' ? 'selected' : ''}>Yes</option><option value="No" ${shown === 'No' ? 'selected' : ''}>No</option>${valid || !shown ? '' : `<option value="${escapeHtml(shown)}" selected>${escapeHtml(shown)}</option>`}</select>`;
    } else {
      control = `<input id="${inputId}" data-alloc-modal-field data-key="${escapeHtml(field.key)}" value="${escapeHtml(shown)}" aria-label="${escapeHtml(label)}">`;
    }
    return `<div class="field"><label for="${inputId}">${escapeHtml(field.key)}${live}</label>${control}</div>`;
  }).join('');
  return `<div class="form-panel member-editor" role="dialog" aria-modal="true" aria-labelledby="alloc-student-editor-title"><div class="toolbar"><h2 id="alloc-student-editor-title">Edit ${escapeHtml(name)}</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p class="muted">${escapeHtml((row && row.studentId) || '')}</p>
    <p class="muted">Choice columns and dashboard fields, including static imports and LIVE columns from the linked Google Sheet. Is Interdisciplinary? accepts only Yes or No.</p>
    ${controls || '<div class="empty">No allocation fields were detected for this cohort.</div>'}
    <p class="notice error" id="alloc-student-editor-error" hidden></p>
    <div class="toolbar"><button type="button" class="button" id="alloc-student-editor-save"${fields.length ? '' : ' disabled'}>Save</button><button type="button" class="button secondary" data-close-admin-dialog>Cancel</button></div></div>`;
}

export function allocationDataManagementMarkup(desk) {
  const settings = (desk && desk.settings) || {};
  const keys = settings.detectedChoiceKeys || [];
  const fields = allocationDataFields(settings);
  const rows = ((desk.choiceRows && desk.choiceRows.length) ? desk.choiceRows : (desk.students || [])).slice();
  if (!rows.length) return '<div class="empty">Ingest student choices to edit them here.</div>';
  if (!fields.length) return '<div class="empty">No choice columns were detected. Ingest a COHORTDATA sheet first.</div>';
  const interdisciplinaryKey = settings.interdisciplinaryKey || '';
  const allSelected = rows.length > 0 && rows.every(function(row) { return state.allocationDataSelected.indexOf(row.studentId) >= 0; });
  const body = rows.map(function(row) {
    const cells = keys.map(function(key) { return `<td>${allocationChoiceCell(row, key, interdisciplinaryKey)}</td>`; }).join('');
    const who = row.displayName || row.studentId;
    return `<tr>
      <td><input type="checkbox" data-alloc-data-pick="${escapeHtml(row.studentId)}" ${state.allocationDataSelected.indexOf(row.studentId) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(who)}"></td>
      <td><strong>${escapeHtml(who)}</strong><div class="muted">${escapeHtml(row.studentId)}</div></td>
      ${cells}
      <td><div class="actions"><button type="button" class="link-button" data-alloc-data-edit="${escapeHtml(row.studentId)}" aria-label="Edit ${escapeHtml(who)}">Edit</button>${keys.length ? `<button type="button" class="button secondary" data-alloc-row-save="${escapeHtml(row.studentId)}">Save</button>` : ''}</div></td>
    </tr>`;
  }).join('');
  const batch = keys.length ? `<div class="alloc-batch">
      <span>Apply to selected</span>
      <label for="alloc-data-field">Column</label>
      <select id="alloc-data-field">${keys.map(function(key) { return `<option value="${escapeHtml(key)}">${escapeHtml(key)}</option>`; }).join('')}</select>
      <input id="alloc-data-value" placeholder="Value" aria-label="Value to apply">
      <select id="alloc-data-yesno" aria-label="Yes or No" hidden><option value="Yes">Yes</option><option value="No">No</option></select>
      <button type="button" class="button" id="alloc-data-batch">Apply</button>
      <span class="muted" id="alloc-data-count">${state.allocationDataSelected.length} selected</span>
    </div>` : '';
  return `<p class="muted">Edit ingested choice values inline, or open Edit for every static and live allocation field. Tick rows to apply one value to the selected students. Is Interdisciplinary? accepts only Yes or No.</p>
    ${batch}
    <div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="alloc-data-all" ${allSelected ? 'checked' : ''} aria-label="Select all choice rows"></th><th>Student</th>${keys.map(function(key) { return `<th>${escapeHtml(key)}</th>`; }).join('')}<th>Actions</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function allocationChoiceCell(row, key, interdisciplinaryKey) {
  const choices = row.subjectChoices || {};
  const raw = Object.prototype.hasOwnProperty.call(choices, key) ? choices[key] : '';
  const shown = raw === true || raw === false ? String(raw) : (raw === undefined || raw === null ? '' : String(raw));
  if (interdisciplinaryKey && key === interdisciplinaryKey) {
    const valid = shown === 'Yes' || shown === 'No';
    return `<select data-alloc-edit="${escapeHtml(row.studentId)}" data-key="${escapeHtml(key)}" aria-label="Is Interdisciplinary? for ${escapeHtml(row.displayName || row.studentId)}"><option value="">Choose</option><option value="Yes" ${shown === 'Yes' ? 'selected' : ''}>Yes</option><option value="No" ${shown === 'No' ? 'selected' : ''}>No</option>${valid || !shown ? '' : `<option value="${escapeHtml(shown)}" selected>${escapeHtml(shown)}</option>`}</select>`;
  }
  return `<input data-alloc-edit="${escapeHtml(row.studentId)}" data-key="${escapeHtml(key)}" value="${escapeHtml(shown)}" aria-label="${escapeHtml(key + ' for ' + (row.displayName || row.studentId))}">`;
}

export function bindAllocation(target, desk) {
  const cohort = document.getElementById('alloc-cohort');
  if (cohort) cohort.addEventListener('change', function(event) {
    if (adminDialogKind() === 'cohort-token') closeAdminDialog();
    state.cohortId = event.target.value;
    syncHeaderCohortSelect();
    state.allocationSelected = [];
    state.allocationSubjects = {};
    state.allocationSubjectFilter = [];
    state.tokenEditId = '';
    loadAllocation();
  });
  target.querySelectorAll('[data-alloc-status]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.allocationStatus = button.dataset.allocStatus;
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-subject-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.allocationSubjectFilter = toggleNameFilter(state.allocationSubjectFilter, button.getAttribute('data-alloc-subject-filter') || '');
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-allocated-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.allocationAllocatedFilter = toggleNameFilter(state.allocationAllocatedFilter, button.getAttribute('data-alloc-allocated-filter') || '');
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-teacher-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      const value = button.getAttribute('data-alloc-teacher-filter') || '';
      if (!value) state.allocationTeacherFilter = [];
      else {
        const current = (state.allocationTeacherFilter || []).slice();
        const index = current.indexOf(value);
        if (index >= 0) current.splice(index, 1);
        else current.push(value);
        state.allocationTeacherFilter = current;
      }
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-flag-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.allocationSupportFlags = toggleNameFilter(state.allocationSupportFlags, button.getAttribute('data-alloc-flag-filter') || '');
      state.allocationSupport = 'all';
      paintAllocation();
    });
  });
  const clearFilters = document.getElementById('alloc-clear-filters');
  if (clearFilters) clearFilters.addEventListener('click', function() {
    state.allocationStatus = 'all';
    state.allocationSupport = 'all';
    state.allocationSupportFlags = [];
    state.allocationSubjectFilter = [];
    state.allocationAllocatedFilter = [];
    state.allocationTeacherFilter = [];
    paintAllocation();
  });
  const drawerPeek = document.getElementById('alloc-drawer-peek');
  if (drawerPeek) drawerPeek.addEventListener('click', function() {
    state.allocationDrawerOpen = true;
    paintAllocation();
  });
  const drawerClose = document.getElementById('alloc-drawer-close');
  if (drawerClose) drawerClose.addEventListener('click', function() {
    state.allocationDrawerOpen = false;
    paintAllocation();
    const peek = document.getElementById('alloc-drawer-peek');
    if (peek) peek.focus();
  });
  target.querySelectorAll('[data-alloc-load]').forEach(function(button) {
    button.addEventListener('click', function() {
      const raw = button.getAttribute('data-alloc-load');
      const next = raw === 'supervisor' || raw === 'assigned' ? raw : 'subject';
      if (state.allocationLoadView === next) return;
      state.allocationLoadView = next;
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-assigned]').forEach(function(button) {
    button.addEventListener('click', function() {
      const subject = button.getAttribute('data-alloc-assigned') || '';
      const key = subject.toLowerCase();
      state.allocationAssignedOpen[key] = state.allocationAssignedOpen[key] !== true;
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-expand]').forEach(function(button) {
    button.addEventListener('click', function() {
      const id = button.getAttribute('data-alloc-expand');
      state.allocationOpenStudent = state.allocationOpenStudent === id ? '' : id;
      paintAllocation();
    });
  });
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
      const subject = student ? selectedAllocationSubject(student) : '';
      if (select.value && !supervisorAcceptsSubject(desk, select.value, subject)) {
        showError(new Error(subject + ' does not match the supervisor\'s EE subjects.'));
        paintAllocation();
        return;
      }
      saveAllocationDraft(studentId, select.value, subject, allocationInterdisciplinaryOn(student), select.value ? 'Draft saved.' : 'Assignment cleared.');
    });
  });
  target.querySelectorAll('[data-alloc-subject]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-subject');
      const subject = button.getAttribute('data-subject');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      const previous = student ? selectedAllocationSubject(student) : '';
      state.allocationSubjects[studentId] = subject;
      if (sameSubjectName(previous, subject)) {
        paintAllocation();
        return;
      }
      if (!student || !student.token) {
        paintAllocation();
        return;
      }
      saveAllocationDraft(studentId, '', '', false, 'Assigned staff cleared.');
    });
  });
  target.querySelectorAll('[data-alloc-ee-inter]').forEach(function(box) {
    box.addEventListener('change', function() {
      const studentId = box.getAttribute('data-alloc-ee-inter');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      state.allocationInterdisciplinary[studentId] = box.checked;
      if (!student || !student.token) {
        paintAllocation();
        return;
      }
      const subject = selectedAllocationSubject(student);
      if (!supervisorAcceptsSubject(desk, student.token.staffId, subject)) {
        delete state.allocationInterdisciplinary[studentId];
        showError(new Error(subject + ' does not match the supervisor\'s EE subjects.'));
        paintAllocation();
        return;
      }
      saveAllocationDraft(studentId, student.token.staffId, subject, box.checked, box.checked ? 'Marked as an interdisciplinary EE.' : 'Interdisciplinary mark cleared.');
    });
  });
  target.querySelectorAll('[data-alloc-supervisor-cue]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-cue-student');
      const staffId = button.getAttribute('data-alloc-supervisor-cue');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      const subject = state.allocationSubjects[studentId] || (student ? selectedAllocationSubject(student) : '');
      if (!supervisorAcceptsSubject(desk, staffId, subject)) {
        showError(new Error(subject + ' does not match the supervisor\'s EE subjects.'));
        return;
      }
      saveAllocationDraft(studentId, staffId, subject, allocationInterdisciplinaryOn(student), 'Draft saved.');
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
  bindLiveSheet(target);
  ['alloc-save-config', 'alloc-save-config-fields'].forEach(function(id) {
    const save = document.getElementById(id);
    if (save) save.addEventListener('click', saveAllocationSettings);
  });
  bindAllocationData(target, desk);
  const openQuotas = document.getElementById('alloc-open-quotas');
  if (openQuotas) openQuotas.addEventListener('click', openStaffQuotas);
}

export let cohortTokenLoad = 0;

export function paintCohortTokens(target) {
  const load = ++cohortTokenLoad;
  target.innerHTML = `<div class="toolbar"><button type="button" class="button secondary" id="alloc-open-quotas">Edit EE quotas</button><span class="muted">Cohort ${escapeHtml(state.cohortId)}</span></div>${loadingLine('Loading cohort tokens...')}`;
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
  const summary = tokenBoardSummary(board);
  return `${allocationSection('token-metrics', 'Cohort summary', `<div class="alloc-metrics">
      <p>Teachers allocated <strong>${summary.teachersAllocated}</strong></p>
      <p>Number of tokens <strong>${summary.tokenCount}</strong></p>
      <p>Number of students <strong>${summary.studentCount}</strong></p>
    </div>`)}
    <div class="toolbar"><button type="button" class="button secondary" id="alloc-open-quotas">Edit EE quotas</button><span class="muted">${tokens.length} token${tokens.length === 1 ? '' : 's'} · cohort ${escapeHtml(board.cohortId || state.cohortId)}</span></div>
    <p class="muted">These slots already belong to ${escapeHtml(board.cohortId)}. Adding tokens does not remove the ones here. A published token has to go back to draft on the dashboard before it can be deleted.</p>
    ${allocationSection('token-add', 'Add tokens', `<div class="alloc-batch">
        <label for="token-staff">Staff</label>
        <select id="token-staff"><option value="">Choose staff</option>${(board.staff || []).map(function(person) {
          return `<option value="${escapeHtml(person.email)}">${escapeHtml(person.displayName)}</option>`;
        }).join('')}</select>
        <label for="token-count">How many</label>
        <input id="token-count" inputmode="numeric" value="1" style="width:72px">
        <button type="button" class="button" id="token-add">Add tokens</button>
      </div>
      <div class="quota-pick">${subjects.length ? subjects.map(function(subject) {
        const name = tokenSubjectName(subject);
        return `<label class="check-option"><input type="checkbox" data-new-token-subject="${escapeHtml(name)}"> ${subjectLabelHtml(name, tokenSubjectShort(subject))}</label>`;
      }).join('') : '<span class="muted">No active subjects yet.</span>'}</div>`)}
    ${tokens.length ? `<div class="table-wrap"><table><thead><tr>${sortableHeader(tableId, 'staff', 'Staff')}${sortableHeader(tableId, 'subjects', 'EE subjects')}${sortableHeader(tableId, 'status', 'Status')}${sortableHeader(tableId, 'student', 'Student')}${sortableHeader(tableId, 'assigned', 'Assigned subject')}<th>Actions</th></tr></thead><tbody>${tokens.map(function(token) {
      return `<tr>
        <td><strong>${escapeHtml(token.staffName)}</strong><div class="muted">${escapeHtml(token.staffId)}</div></td>
        <td>${escapeHtml((token.eligibleSubjects || []).join(', ') || 'None')}</td>
        <td>${escapeHtml(token.status)}</td>
        <td>${token.allocatedTo ? `<strong>${escapeHtml(token.studentName || token.allocatedTo)}</strong><div class="muted">${escapeHtml(token.allocatedTo)}</div>` : '—'}${token.interdisciplinary ? ' <span class="id-tag" title="Interdisciplinary EE">ID</span>' : ''}</td>
        <td>${escapeHtml(token.assignedSubject || '—')}</td>
        <td><div class="actions"><button type="button" class="link-button" data-token-edit="${escapeHtml(token.id)}">Edit</button>${token.status === 'committed' ? '' : `<button type="button" class="link-button" data-token-delete="${escapeHtml(token.id)}">Delete</button>`}</div></td>
      </tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">This cohort has no tokens yet. Add them here, or generate them from EE quotas.</div>'}`;
}

export function tokenBoardSummary(board) {
  const tokens = (board && board.tokens) || [];
  const summary = (board && board.summary) || {};
  const teachers = new Set(tokens.filter(function(token) { return token.status && token.status !== 'available'; }).map(function(token) { return token.staffId; }));
  const held = new Set(tokens.map(function(token) { return token.allocatedTo; }).filter(Boolean));
  return {
    teachersAllocated: summary.teachersAllocated === undefined ? teachers.size : summary.teachersAllocated,
    tokenCount: summary.tokenCount === undefined ? tokens.length : summary.tokenCount,
    studentCount: summary.studentCount === undefined ? held.size : summary.studentCount,
  };
}

function tokenSubjectName(subject) {
  if (subject && typeof subject === 'object') return String(subject.name || '');
  return String(subject || '');
}

function tokenSubjectShort(subject) {
  if (subject && typeof subject === 'object') return String(subject.shortName || '');
  return '';
}

export function tokenSubjectChoices(token, board) {
  const choices = (board.subjects || []).map(function(subject) {
    return { name: tokenSubjectName(subject), shortName: tokenSubjectShort(subject) };
  }).filter(function(subject) { return subject.name; });
  (token.eligibleSubjects || []).forEach(function(subject) {
    if (!choices.some(function(item) { return item.name.toLowerCase() === String(subject).toLowerCase(); })) choices.push({ name: String(subject), shortName: '' });
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
      const name = tokenSubjectName(subject);
      const on = (token.eligibleSubjects || []).some(function(item) { return item.toLowerCase() === name.toLowerCase(); });
      return `<label class="check-option"><input type="checkbox" data-token-subject="${escapeHtml(name)}" ${on ? 'checked' : ''}> ${subjectLabelHtml(name, tokenSubjectShort(subject))}</label>`;
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

function allocationColumnDraft(key) {
  const prior = ((state.allocationDesk && state.allocationDesk.settings && state.allocationDesk.settings.columns) || []).find(function(column) { return column.key === key; });
  return {
    key: key,
    showOnCard: false,
    filterable: false,
    sortable: false,
    colorScale: false,
    expanded: false,
    source: prior && prior.source === 'live' ? 'live' : 'static',
  };
}

export function captureAllocationColumns() {
  const boxes = document.querySelectorAll('[data-alloc-col]');
  if (!boxes.length || !state.allocationDesk || !state.allocationDesk.settings) return;
  const columns = {};
  boxes.forEach(function(box) {
    const key = box.getAttribute('data-alloc-col');
    const flag = box.getAttribute('data-flag');
    if (!columns[key]) columns[key] = allocationColumnDraft(key);
    columns[key][flag] = box.checked;
  });
  state.allocationDesk.settings.columns = Object.keys(columns).map(function(key) { return columns[key]; });
}

export function allocationLiveSheetMarkup(desk) {
  const settings = (desk && desk.settings) || {};
  const url = liveFormUrl(settings);
  const tab = liveFormTab(settings);
  const tabs = liveFormTabs();
  const headers = liveFormHeaders();
  const mappings = liveFormMappings(settings);
  const busy = state.allocationLiveBusy || '';
  const loading = busy === 'tabs' || busy === 'headers' || busy === 'save';
  const problems = headers.length ? liveLinkProblems(mappings, headers) : [];
  const driveBlocked = desk && desk.driveReady === false;
  const saveBlocked = !headers.length || problems.length > 0 || loading || driveBlocked;
  const linked = liveSheetLinked(settings);
  const loadLabel = busy === 'tabs' ? 'Loading sheet tabs…' : 'Load sheet tabs';
  const tabOptions = ['<option value="">Choose a tab</option>'].concat(tabs.map(function(name) {
    return `<option value="${escapeHtml(name)}" ${name === tab ? 'selected' : ''}>${escapeHtml(name)}</option>`;
  })).join('');
  const mapping = headers.length ? `<div id="alloc-live-map">${LIVE_SHEET_GROUPS.map(function(group) {
    const fields = LIVE_SHEET_FIELDS.filter(function(field) { return field.group === group.id; });
    return `<h3>${escapeHtml(group.title)}</h3><p class="muted">${escapeHtml(group.note)}</p>${fields.map(function(field) {
      const current = (mappings[field.group] && mappings[field.group][field.key]) || '';
      return liveMapSelect(field, headers, current);
    }).join('')}`;
  }).join('')}<p class="notice" id="alloc-live-problems"${problems.length ? '' : ' hidden'}>${escapeHtml(problems.join(' '))}</p><div class="toolbar"><button type="button" class="button" id="alloc-live-save" ${saveBlocked ? 'disabled' : ''}>Save live link</button></div></div>` : `<p class="muted" id="alloc-live-problems">${tabs.length ? 'Choose a sheet tab to map its columns.' : (linked ? 'Load the workbook to change the linked tab or columns.' : 'Load the workbook to choose a tab.')}</p>`;
  return `<div class="alloc-live">
      <h3>Live choice sheet</h3>
      <p class="muted">Link a Google Sheet that stays the source of truth for subject choices. Every other column on that sheet is ingested as a live dashboard field. Static ingest still fills auxiliary columns and leaves live columns in place. Student Number or Student Email is the merge key, and Primary choice has to be mapped before the link can be saved.</p>
      ${linked ? `<p class="muted">Linked spreadsheet <code>${escapeHtml(settings.spreadsheetId || '')}</code>${tab ? ` · tab <strong>${escapeHtml(settings.sheetName || settings.liveSheetTab || tab)}</strong>` : ''}${(settings.lastSyncedAt || settings.lastLiveSync) ? ` · last sync ${escapeHtml(allocationWhen(settings.lastSyncedAt || settings.lastLiveSync))}` : ''}.</p>` : ''}
      <label class="field" for="alloc-live-url">Live Google Sheet URL</label>
      <input id="alloc-live-url" value="${escapeHtml(url)}" placeholder="https://docs.google.com/spreadsheets/d/..." ${driveBlocked ? 'disabled' : ''}>
      <div class="toolbar"><button type="button" class="button secondary" id="alloc-live-load" ${driveBlocked || loading ? 'disabled' : ''}>${loadLabel}</button></div>
      ${loading ? loadingLine(busy === 'headers' ? 'Loading column headers…' : busy === 'save' ? 'Saving live sheet link…' : 'Loading sheet tabs…') : ''}
      <div id="alloc-live-follow">
        ${tabs.length ? `<label class="field" for="alloc-live-tab">Sheet tab</label><select id="alloc-live-tab">${tabOptions}</select>` : (linked && tab ? `<p class="muted">Linked tab: <strong>${escapeHtml(tab)}</strong>.</p>` : '')}
        ${mapping}
      </div>
    </div>`;
}

function liveMapSelect(field, headers, current) {
  const id = 'alloc-live-' + field.group + '-' + field.key;
  const list = (headers || []).filter(Boolean);
  if (current && list.indexOf(current) < 0) list.unshift(current);
  const hint = field.hint ? ` <span class="muted">(${escapeHtml(field.hint)})</span>` : '';
  return `<div class="alloc-map"><label for="${id}">${escapeHtml(field.label)}${hint}</label><select id="${id}" data-live-map="${escapeHtml(field.group + '.' + field.key)}"><option value="">Not mapped</option>${list.map(function(header) {
    return `<option value="${escapeHtml(header)}" ${header === current ? 'selected' : ''}>${escapeHtml(header)}</option>`;
  }).join('')}</select></div>`;
}

function liveFormUrl(settings) {
  if (state.allocationLiveCohort === state.cohortId) return state.allocationLiveUrl || '';
  return (settings && settings.liveSheetUrl) || '';
}

function liveFormTab(settings) {
  if (state.allocationLiveCohort === state.cohortId) return state.allocationLiveTab || '';
  return (settings && (settings.sheetName || settings.liveSheetTab)) || '';
}

function liveFormTabs() {
  if (state.allocationLiveCohort !== state.cohortId) return [];
  return state.allocationLiveTabs || [];
}

function liveFormHeaders() {
  if (state.allocationLiveCohort !== state.cohortId) return [];
  return state.allocationLiveHeaders || [];
}

function liveFormMappings(settings) {
  if (state.allocationLiveCohort === state.cohortId && state.allocationLiveDraft) return state.allocationLiveDraft;
  return columnMappingsFrom(settings && settings.columnMappings);
}

function rememberLiveCohort(desk) {
  if (state.allocationLiveCohort === state.cohortId) return;
  const settings = (desk && desk.settings) || {};
  state.allocationLiveCohort = state.cohortId;
  state.allocationLiveTabs = [];
  state.allocationLiveHeaders = [];
  state.allocationLiveDraft = null;
  state.allocationLiveLoadedUrl = '';
  state.allocationLiveBusy = '';
  state.allocationLiveUrl = settings.liveSheetUrl || '';
  state.allocationLiveTab = settings.sheetName || settings.liveSheetTab || '';
}

function looksLikeSheet(value) {
  return /\/spreadsheets\/d\/[a-zA-Z0-9-_]+/.test(value) || /^[a-zA-Z0-9-_]{20,}$/.test(value);
}

function liveUrlFromDom() {
  const input = document.getElementById('alloc-live-url');
  const url = String((input && input.value) || state.allocationLiveUrl || '').trim();
  state.allocationLiveUrl = url;
  state.allocationLiveCohort = state.cohortId;
  return url;
}

function tabFromDom() {
  const select = document.getElementById('alloc-live-tab');
  const tab = String((select && select.value) || state.allocationLiveTab || '').trim();
  state.allocationLiveTab = tab;
  state.allocationLiveCohort = state.cohortId;
  return tab;
}

function readLiveMappingsFromDom() {
  const mappings = columnMappingsFrom(state.allocationLiveDraft || (state.allocationDesk && state.allocationDesk.settings && state.allocationDesk.settings.columnMappings));
  document.querySelectorAll('[data-live-map]').forEach(function(select) {
    const path = String(select.getAttribute('data-live-map') || '').split('.');
    if (path.length !== 2 || !mappings[path[0]]) return;
    mappings[path[0]][path[1]] = select.value;
  });
  return mappings;
}

function syncLiveSaveState() {
  const mappings = readLiveMappingsFromDom();
  state.allocationLiveDraft = mappings;
  const headers = liveFormHeaders();
  const problems = headers.length ? liveLinkProblems(mappings, headers) : ['Choose a sheet tab to map its columns.'];
  const save = document.getElementById('alloc-live-save');
  const note = document.getElementById('alloc-live-problems');
  const driveBlocked = state.allocationDesk && state.allocationDesk.driveReady === false;
  if (save) save.disabled = problems.length > 0 || !!state.allocationLiveBusy || driveBlocked;
  if (note) {
    note.hidden = problems.length === 0;
    note.textContent = problems.join(' ');
  }
}

function bindLiveSheet(target) {
  const liveUrl = document.getElementById('alloc-live-url');
  if (liveUrl) {
    liveUrl.addEventListener('input', function(event) {
      state.allocationLiveUrl = event.target.value;
      state.allocationLiveCohort = state.cohortId;
      const trimmed = event.target.value.trim();
      if (state.allocationLiveLoadedUrl && trimmed !== state.allocationLiveLoadedUrl) {
        state.allocationLiveTabs = [];
        state.allocationLiveHeaders = [];
        state.allocationLiveLoadedUrl = '';
        const follow = document.getElementById('alloc-live-follow');
        if (follow) follow.hidden = true;
      }
    });
    liveUrl.addEventListener('blur', function() {
      const url = liveUrlFromDom();
      if (!looksLikeSheet(url)) return;
      if (state.allocationDesk && state.allocationDesk.driveReady === false) return;
      if (url === state.allocationLiveLoadedUrl && (state.allocationLiveTabs || []).length) return;
      loadLiveSheetTabs();
    });
  }
  const loadTabs = document.getElementById('alloc-live-load');
  if (loadTabs) loadTabs.addEventListener('click', loadLiveSheetTabs);
  const tabSelect = document.getElementById('alloc-live-tab');
  if (tabSelect) tabSelect.addEventListener('change', function() {
    const name = tabFromDom();
    state.allocationLiveHeaders = [];
    state.allocationLiveDraft = null;
    if (!name) {
      paintAllocation();
      return;
    }
    loadLiveSheetHeaders(name);
  });
  target.querySelectorAll('[data-live-map]').forEach(function(select) {
    select.addEventListener('change', syncLiveSaveState);
  });
  const save = document.getElementById('alloc-live-save');
  if (save) save.addEventListener('click', saveLiveSheetLink);
  const resync = document.getElementById('alloc-resync-live');
  if (resync) resync.addEventListener('click', resyncLiveChoiceData);
}

export function loadLiveSheetTabs() {
  if (state.allocationLiveBusy === 'tabs' || state.allocationLiveBusy === 'headers') return;
  const url = liveUrlFromDom();
  if (!url) { showError(new Error('Enter a Google Sheet URL.')); return; }
  if (!looksLikeSheet(url)) { showError(new Error('Enter a valid Google Sheet URL.')); return; }
  const cohortId = state.cohortId;
  state.allocationLiveBusy = 'tabs';
  state.allocationLiveCohort = cohortId;
  paintAllocation();
  callServer('listLiveSheetTabs', cohortId, { url: url }).then(function(result) {
    if (state.cohortId !== cohortId) return;
    state.allocationLiveBusy = '';
    state.allocationLiveTabs = (result && result.tabs) || [];
    state.allocationLiveLoadedUrl = url;
    state.allocationLiveHeaders = [];
    if (state.allocationLiveTab && state.allocationLiveTabs.indexOf(state.allocationLiveTab) < 0) state.allocationLiveTab = '';
    const selected = state.allocationLiveTab || (state.allocationLiveTabs.length === 1 ? state.allocationLiveTabs[0] : '');
    state.allocationLiveTab = selected;
    paintAllocation();
    if (selected) loadLiveSheetHeaders(selected);
  }).catch(function(error) {
    if (state.cohortId === cohortId) state.allocationLiveBusy = '';
    paintAllocation();
    showError(error);
  });
}

export function loadLiveSheetHeaders(sheetName) {
  const url = liveUrlFromDom();
  const name = String(sheetName || '').trim();
  if (!url || !name) return;
  const cohortId = state.cohortId;
  state.allocationLiveTab = name;
  state.allocationLiveBusy = 'headers';
  state.allocationLiveCohort = cohortId;
  paintAllocation();
  callServer('getLiveSheetHeaders', cohortId, { url: url }, name).then(function(result) {
    if (state.cohortId !== cohortId) return;
    state.allocationLiveBusy = '';
    state.allocationLiveHeaders = (result && result.headers) || [];
    state.allocationLiveTab = (result && result.sheetName) || name;
    paintAllocation();
  }).catch(function(error) {
    if (state.cohortId === cohortId) state.allocationLiveBusy = '';
    paintAllocation();
    showError(error);
  });
}

export function saveLiveSheetLink() {
  const mappings = readLiveMappingsFromDom();
  const headers = liveFormHeaders();
  const problems = liveLinkProblems(mappings, headers);
  if (!headers.length || problems.length) { showError(new Error(problems[0] || 'Choose a sheet tab to map its columns.')); return; }
  const url = liveUrlFromDom();
  const sheetName = tabFromDom();
  if (!sheetName) { showError(new Error('Choose a sheet tab.')); return; }
  const cohortId = state.cohortId;
  state.allocationLiveDraft = mappings;
  state.allocationLiveBusy = 'save';
  paintAllocation();
  callServer('saveLiveSheetLink', cohortId, { url: url, sheetName: sheetName, columnMappings: mappings }).then(function(saved) {
    state.allocationLiveBusy = '';
    state.allocationLiveDraft = null;
    if (saved) {
      state.allocationLiveUrl = saved.liveSheetUrl || url;
      state.allocationLiveTab = saved.sheetName || saved.liveSheetTab || sheetName;
    }
    showSuccess('Live sheet link saved.');
    loadAllocation();
  }).catch(function(error) {
    if (state.cohortId === cohortId) state.allocationLiveBusy = '';
    paintAllocation();
    showError(error);
  });
}

function rememberSyncStamp(stamp) {
  if (!stamp) return;
  [state.allocationDesk, state.allocationRemoteDesk].forEach(function(desk) {
    if (!desk) return;
    desk.settings = Object.assign({}, desk.settings || {}, { lastSyncedAt: stamp, lastLiveSync: stamp });
  });
}

export function resyncLiveChoiceData() {
  if (state.allocationLiveBusy === 'resync') return;
  const settings = (state.allocationDesk && state.allocationDesk.settings) || {};
  if (liveSyncAge(settings.lastSyncedAt || settings.lastLiveSync, Date.now()).blocked) return;
  const cohortId = state.cohortId;
  state.allocationLiveBusy = 'resync';
  paintAllocationLive();
  callServer('resyncLiveChoiceData', cohortId).then(function(result) {
    if (state.cohortId === cohortId) state.allocationLiveBusy = '';
    if (state.cohortId !== cohortId) return;
    rememberSyncStamp(result && result.lastSyncedAt);
    const updated = result && result.updated ? result.updated : 0;
    const warnings = (result && result.warnings) || [];
    showSuccess(warnings.length
      ? 'Live choice data updated for ' + updated + ' students. ' + warnings[0]
      : 'Live choice data updated for ' + updated + ' students.');
    if (state.allocationListenFallback) loadAllocation();
    else paintAllocationLive();
  }).catch(function(error) {
    if (state.cohortId === cohortId) state.allocationLiveBusy = '';
    if (state.cohortId === cohortId) paintAllocationLive();
    showError(error);
  });
}

export function saveAllocationSettings() {
  const columns = {};
  document.querySelectorAll('[data-alloc-col]').forEach(function(box) {
    const key = box.getAttribute('data-alloc-col');
    const flag = box.getAttribute('data-flag');
    if (!columns[key]) columns[key] = allocationColumnDraft(key);
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
    const flags = state.allocationSupportFlags || [];
    if (flags.length) {
      const owned = student.supportFlags || [];
      if (!flags.some(function(flag) { return owned.some(function(item) { return sameSubjectName(item, flag); }); })) return false;
    }
    const wanted = state.allocationSubjectFilter || [];
    if (wanted.length) {
      const names = allocationRequestedSubjects(student).map(function(item) { return item.name; });
      if (!wanted.some(function(name) { return names.some(function(item) { return sameSubjectName(item, name); }); })) return false;
    }
    const allocated = state.allocationAllocatedFilter || [];
    if (allocated.length) {
      const assigned = student.token ? student.token.assignedSubject : '';
      if (!allocated.some(function(name) { return sameSubjectName(name, assigned); })) return false;
    }
    const teachers = state.allocationTeacherFilter || [];
    if (teachers.length && teachers.indexOf(student.token ? student.token.staffId : '') < 0) return false;
    return true;
  });
  rows.sort(function(left, right) { return left.sortName.localeCompare(right.sortName); });
  return sortedRows('alloc-desk', rows, function(student, key) { return allocationRank(student, key); });
}

export function allocationRank(student, key) {
  if (key === 'name') return student.sortName || '';
  if (key === 'supervisor') return student.token && student.token.staffName ? student.token.staffName : '';
  if (key === 'subject') return allocationRequestedSubjects(student).map(function(item) { return item.name; }).join(', ');
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
  const requested = allocationRequestedSubjects(student);
  if (requested.length) return requested[0].name;
  return (student.choices && student.choices.primary) || '';
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

setAllocationPainter(paintAllocationLive);
