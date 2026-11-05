import { choiceMatchFlag, coalesceKnownSubjects, colorScaleFill, columnMappingsFrom, columnScaleExtent, dashboardFieldKeys, departmentOfSubject, departmentsMatch, diplomaLevelFlag, hodSuggestionOverview, LIVE_SHEET_FIELDS, LIVE_SHEET_GROUPS, liveLinkProblems, liveSheetLinked, liveSyncAge, scaleNumber, subjectTokenLoad, subjectsOverlap, suggestionCapacity } from '../../../functions/src/allocationPure.ts';
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
import { beginAllocationWatch, pendingSettled, presentAllocationDesk, releaseAllocationWatch, setAllocationPainter } from './realtime.js';
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

function allocationPermissions() {
  const permissions = (state.user && state.user.permissions) || {};
  return { canAdmin: !!permissions.canAdmin, isHOD: !!permissions.isHOD };
}

function pureHodUser() {
  const permissions = allocationPermissions();
  return permissions.isHOD && !permissions.canAdmin;
}

export function renderAllocation() {
  advanceScene();
  const main = document.getElementById('main');
  main.classList.add('plan-wide');
  let view = state.allocationView;
  if (pureHodUser()) view = 'hod';
  else if (view !== 'settings' && view !== 'tokens' && view !== 'hod') view = 'dashboard';
  state.allocationView = view;
  syncAllocationDrawerChrome();
  const heading = view === 'settings' ? 'Student data' : view === 'tokens' ? 'Cohort allocation tokens' : view === 'hod' ? 'Department suggestions' : 'Supervisor allocation';
  const lede = view === 'settings'
    ? 'Ingest student choices and staff tokens, then choose what the dashboard shows. The cohort follows the header.'
    : view === 'tokens'
      ? 'Add, edit, or remove the supervisor tokens already on a cohort. Generating tokens from EE quotas will not replace these. The cohort follows the header.'
      : view === 'hod'
        ? 'Suggest a supervisor for students whose selected subject is in a department. Certify when the list is ready. Coordinators approve suggestions on the Dashboard.'
        : 'Select a subject, then draft a supervisor. Publish writes the supervisor and assigned subject onto the live roster. The cohort follows the header.';
  const deskReady = !!(state.allocationDesk && state.allocationWatchCohort === state.cohortId);
  const nav = (pureHodUser()
    ? [['hod', 'Department']]
    : [['dashboard', 'Dashboard'], ['hod', 'Department'], ['tokens', 'Cohort tokens'], ['settings', 'Student Data']]
  ).map(function(item) {
    return `<button type="button" data-alloc-view="${item[0]}" aria-current="${view === item[0] ? 'page' : 'false'}">${item[1]}</button>`;
  }).join('');
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Allocation</p><h1>${heading}</h1><p class="lede">${lede}</p></div></div>
    <nav class="subnav" aria-label="Allocation">${nav}</nav>
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
  target.innerHTML = state.allocationView === 'settings'
    ? allocationSettingsMarkup(desk)
    : state.allocationView === 'hod'
      ? allocationHodMarkup(desk)
      : allocationDashboardMarkup(desk);
  bindAllocation(target, desk);
  const next = document.querySelector('.alloc-desk-wrap');
  if (next) {
    next.scrollTop = top;
    next.scrollLeft = left;
  }
  if (document.scrollingElement && page) document.scrollingElement.scrollTop = page;
}

export function allocationQueryMatches(student, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const name = String((student && student.displayName) || '').toLowerCase();
  const id = String((student && student.studentId) || '').toLowerCase();
  return name.indexOf(needle) >= 0 || id.indexOf(needle) >= 0;
}

function refocusAllocationControl(attr, key, caret) {
  const next = attr === 'id'
    ? document.getElementById(key)
    : Array.from(document.querySelectorAll('[' + attr + ']')).find(function(node) {
      return node.getAttribute(attr) === key;
    });
  if (!next || !next.focus) return;
  next.focus();
  if (typeof caret === 'number' && next.setSelectionRange) {
    const at = Math.min(caret, String(next.value || '').length);
    next.setSelectionRange(at, at);
  }
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
  const overviewDrilldown = state.allocationOverviewDrilldown;
  const settings = desk.settings || {};
  const liveLinked = liveSheetLinked(settings);
  const syncedAt = settings.lastSyncedAt || settings.lastLiveSync || '';
  const syncAge = liveSyncAge(syncedAt, Date.now());
  const liveSyncing = state.allocationLiveBusy === 'resync';
  const resyncDisabled = liveSyncing || syncAge.blocked || desk.driveReady === false;
  const columns = allocationDeskColumns(desk.settings);
  const sort = adminSortState('alloc-desk');
  const supervisors = desk.supervisors || [];
  const teacherOptions = supervisors.slice().sort(function(left, right) {
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), undefined, { sensitivity: 'base' });
  }).map(function(person) {
    const exhausted = !(Number(person.available) > 0);
    return `<option value="${escapeHtml(person.staffId)}"${exhausted ? ' disabled class="alloc-teacher-empty"' : ''}>${escapeHtml(allocationSupervisorLabel(person))}${exhausted ? ' (0 remaining)' : ''}</option>`;
  }).join('');
  const subjectNames = new Map();
  subjectCatalogue(desk).concat(allocationSelectedSubjectOptions(desk)).forEach(function(subject) {
    const name = typeof subject === 'string' ? subject : subject.name;
    if (name && !subjectNames.has(name.toLowerCase())) subjectNames.set(name.toLowerCase(), name);
  });
  const subjectOptions = Array.from(subjectNames.values()).sort(function(left, right) {
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  }).map(function(name) {
    return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  }).join('');
  const counts = allocationDashboardCounts(desk);
  const extents = {};
  columns.forEach(function(column) {
    if (!column.colorScale) return;
    extents[column.key] = columnScaleExtent(students.map(function(student) {
      return allocationStoredField(student, column.key);
    }));
  });
  const scaleOn = columns.some(function(column) { return column.colorScale && extents[column.key]; });
  const allSelected = students.length > 0 && students.every(function(student) { return state.allocationSelected.indexOf(student.studentId) >= 0; });
  const batchAction = `<details class="alloc-batch"${state.allocationSelected.length ? ' open' : ''}>
        <summary>Apply to selected <span class="muted">${state.allocationSelected.length} selected</span></summary>
        <div class="alloc-batch-controls">
        <select id="alloc-batch-subject" aria-label="Subject to apply"><option value="">Select subject...</option><option value="__no_subject__">[no subject]</option>${subjectOptions}</select>
        <button type="button" class="button" id="alloc-batch-apply-subject">Apply Subject</button>
        <button type="button" class="button" id="alloc-batch-approve">Assign From Suggestions</button>
        <select id="alloc-batch-supervisor" aria-label="Teacher token"><option value="">Select teacher token...</option><option value="__no_supervisor__">[no supervisor]</option>${teacherOptions}</select>
        <button type="button" class="button" id="alloc-batch-assign">Assign Supervisor</button>
        <select id="alloc-batch-publication-action" aria-label="Publish action"><option value="publish">Publish</option><option value="unpublish">Unpublish</option></select>
        <button type="button" class="button secondary" id="alloc-batch-publication">Publish</button>
        </div>
      </details>`;
  const sortOption = function(key, label) {
    return `<option value="${escapeHtml(key)}" ${sort.key === key ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  };
  const dynamicHeaders = columns.map(function(column) {
    const label = allocationDashboardFieldLabel(column.key, settings);
    if (column.sortable === false) return `<th scope="col">${escapeHtml(label)}</th>`;
    return sortableHeader('alloc-desk', 'field:' + column.key, label);
  }).join('');
  const bufferText = counts.buffer >= 0 ? '+' + counts.buffer : String(counts.buffer);
  const metric = function(label, value) {
    return `<p><span>${escapeHtml(label)}</span> <strong>${escapeHtml(String(value))}</strong></p>`;
  };
  const syncSlot = liveLinked ? `<div class="alloc-sync-slot">
        <button type="button" class="button secondary" id="alloc-resync-live" ${resyncDisabled ? 'disabled' : ''} aria-busy="${liveSyncing ? 'true' : 'false'}">Resync Live Choice Data</button>
        ${liveSyncing ? '<p class="alloc-sync-meta" id="alloc-resync-status">Resyncing live choice data…</p>' : ''}
        ${syncAge.label ? `<p class="alloc-sync-meta" id="alloc-resync-age">${escapeHtml(syncAge.label)}</p>` : ''}
        ${syncedAt ? `<p class="alloc-sync-meta">Last live sync ${escapeHtml(allocationWhen(syncedAt))}</p>` : ''}
      </div>` : '';
  return `<div class="alloc-layout"><div>
      <div class="alloc-dashboard-head">
        <div class="alloc-metrics-line">
          ${metric('Active Students', counts.activeStudents)}
          ${metric('Tokens', counts.tokenCount)}
          ${metric('Buffer', bufferText)}
          ${metric('Published', counts.published)}
          ${metric('Drafted', counts.drafted)}
          ${metric('Unassigned (students)', counts.unassigned)}
          ${metric('Remaining Tokens', counts.remaining)}
        </div>
        ${syncSlot}
      </div>
      ${desk.warnings && desk.warnings.length ? `<p class="notice">${escapeHtml(desk.warnings[0])}</p>` : ''}
      ${overviewDrilldown ? `<div class="notice alloc-overview-return"><span>Showing ${escapeHtml(overviewDrilldown.label)} (${overviewDrilldown.ids.length})</span><button type="button" class="button secondary" id="alloc-overview-return">Back to Token Overview</button></div>` : ''}
      ${allocationWorkflowFilterMarkup()}
      ${allocationSection('alloc-filters', 'Filters', `<div class="alloc-filters">
        <div><label for="alloc-status">Status</label><select id="alloc-status">${allocationStatusOptionsMarkup()}</select></div>
        <div><label for="alloc-sort">Sort by</label><select id="alloc-sort">${sortOption('name', 'Name')}${sortOption('supervisor', 'Supervisor')}${sortOption('subject', 'Requested subjects')}${sortOption('status', 'Status')}${columns.filter(function(column) { return column.sortable !== false; }).map(function(column) {
          return sortOption('field:' + column.key, column.key);
        }).join('')}</select></div>
        ${allocationNeedSupportFilterMarkup()}
        ${allocationFlaggedFilterMarkup()}
        ${allocationSupportFilterMarkup(desk)}
        ${allocationSubjectFilterMarkup(desk)}
        ${allocationSelectedSubjectFilterMarkup(desk)}
        ${allocationTeacherFilterMarkup(desk)}
        ${allocationCustomFilterMarkup(desk)}
        <div class="alloc-filter-actions"><button type="button" class="button secondary" id="alloc-clear-filters">Clear filters</button></div>
      </div>
      `)}
      <div class="alloc-search"><label for="alloc-student-search">Search students</label><input id="alloc-student-search" type="search" value="${escapeHtml(state.allocationQuery || '')}" placeholder="Name or student email" autocomplete="off" aria-label="Search students by name or email"></div>
      ${batchAction}
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
      ${allocationAuditMarkup()}
    </div></div>
    ${allocationDrawerMarkup(desk, supervisors)}`;
}

export function allocationRowMarkup(student, supervisors, columns, extents) {
  const locked = allocationIsPublished(student);
  const fields = (columns || []).map(function(column) {
    const value = allocationStoredField(student, column.key);
    const shown = value === undefined || value === null || value === '' ? '' : String(value);
    const fill = column.colorScale ? colorScaleFill(value, extents ? extents[column.key] : null) : null;
    const style = scaleStyle(fill);
    return `<td${style ? ` class="alloc-scale" style="${style}"` : ''}>${escapeHtml(shown)}</td>`;
  }).join('');
  const subjectTags = allocationSubjectChoiceMarkup(student, state.allocationDesk);
  const suggestionLine = allocationSuggestionMarkup(student, locked);
  const open = state.allocationOpenStudent === student.studentId;
  const supportTags = allocationSupportMarkup(student);
  const interdisciplinaryOn = allocationInterdisciplinaryOn(student);
  const interdisciplinaryChosen = !!(student.choices && student.choices.interdisciplinary);
  const interdisciplinarySubject = allocationInterdisciplinarySubject(student);
  const interdisciplinaryOptions = allocationInterdisciplinarySubjectOptions(student, state.allocationDesk);
  const interdisciplinarySelect = interdisciplinaryOn ? `<label class="alloc-inter-subject">Second subject<select data-alloc-inter-subject="${escapeHtml(student.studentId)}" aria-label="Interdisciplinary subject for ${escapeHtml(student.displayName)}" ${locked ? 'disabled' : ''}><option value="">Choose subject...</option>${interdisciplinaryOptions.map(function(name) {
    return `<option value="${escapeHtml(name)}" ${sameSubjectName(name, interdisciplinarySubject) ? 'selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('')}</select></label>` : '';
  const supervisorName = allocationAssignedSupervisorName(student, supervisors);
  const assignedSubject = student.token && student.token.assignedSubject ? `<div class="muted">${escapeHtml(student.token.assignedSubject)}</div>` : '';
  const flagged = allocationIsFlagged(student);
  const flagNote = allocationFlagNote(student);
  const flagOpen = !!(state.allocationFlagOpen && state.allocationFlagOpen[student.studentId]);
  const flagIcon = `<button type="button" class="alloc-flag-icon${flagged ? ' is-on' : ''}" data-alloc-flag-toggle="${escapeHtml(student.studentId)}" aria-expanded="${flagOpen ? 'true' : 'false'}" aria-label="${flagged ? 'Flagged' : 'Not flagged'}, flag notes for ${escapeHtml(student.displayName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V3.5h11.2L14.6 7.2 17.2 11H6"/></svg></button>`;
  const rowClass = [locked ? 'is-published' : '', flagged ? 'is-flagged' : ''].filter(Boolean).join(' ');
  const teacherPick = allocationSupervisorCues(student, supervisors, state.allocationDesk);
  return `<tr${rowClass ? ` class="${rowClass}"` : ''}>
    <td class="alloc-check"><input type="checkbox" data-alloc-pick="${escapeHtml(student.studentId)}" ${state.allocationSelected.indexOf(student.studentId) >= 0 ? 'checked' : ''} aria-label="Select ${escapeHtml(student.displayName)}"></td>
    <td>
      <div class="alloc-name"><button type="button" class="link-button alloc-student-name" data-alloc-expand="${escapeHtml(student.studentId)}" aria-expanded="${open ? 'true' : 'false'}">${escapeHtml(student.displayName)}</button>${supportTags}${student.choices && student.choices.interdisciplinary ? allocationInterdisciplinaryMark(student) : ''}${student.pendingClear ? '<span class="info-badge">Clears on publish</span>' : ''}</div>
      <div class="alloc-marks">${flagIcon}${allocationFirstMark(student)}${allocationChoiceMark(student)}${allocationLevelMark(student)}</div>
      <div class="alloc-flag-panel"${flagOpen ? '' : ' hidden'}><label class="check-option alloc-flag-toggle"><input type="checkbox" data-alloc-flag="${escapeHtml(student.studentId)}" ${flagged ? 'checked' : ''} aria-label="Flag ${escapeHtml(student.displayName)}"> Flag</label><input class="alloc-flag-note" type="text" data-alloc-flag-note="${escapeHtml(student.studentId)}" value="${escapeHtml(flagNote)}" placeholder="Flag note" aria-label="Flag note for ${escapeHtml(student.displayName)}" maxlength="500"></div>
    </td>
    <td><div class="alloc-subject-list">${subjectTags || '<span class="muted">No subject choices</span>'}</div>${suggestionLine}<label class="check-option alloc-ee-flag ${interdisciplinaryChosen ? 'is-chosen' : 'is-unset'}"><input type="checkbox" data-alloc-ee-inter="${escapeHtml(student.studentId)}" ${interdisciplinaryOn ? 'checked' : ''} ${locked ? 'disabled' : ''}> Interdisciplinary EE</label>${interdisciplinarySelect}</td>
    <td><div class="alloc-supervisor-name${supervisorName ? '' : ' muted'}">${escapeHtml(supervisorName || 'Unassigned')}</div>${assignedSubject}${teacherPick}</td>
    ${fields}
  </tr>${open ? allocationExpandedMarkup(student, 4 + (columns || []).length) : ''}`;
}

export function allocationIsPublished(student) {
  if (!student) return false;
  if (student.flags && student.flags.committed) return true;
  return !!(student.token && student.token.status === 'committed');
}

/** Published, then an assigned token, then an HOD suggestion, then a selected subject. */
export function allocationStudentStatus(student) {
  if (allocationIsPublished(student)) return 'published';
  if (student && student.token) return 'allocated';
  if (student && student.suggestedStaffId) return 'suggested';
  if (student && String(student.selectedSubject || '').trim()) return 'drafted';
  return 'unallocated';
}

export function allocationStatusLabel(status) {
  if (status === 'published') return 'Published';
  if (status === 'allocated') return 'Allocated';
  if (status === 'suggested') return 'Suggested';
  if (status === 'drafted') return 'Drafted';
  return 'Unallocated';
}

function allocationStatusMode(status) {
  if (status === 'published' || status === 'allocated') return 'on';
  if (status === 'suggested') return 'warn';
  if (status === 'drafted') return 'off';
  return 'idle';
}

export function allocationSubjectLocked(student) {
  return allocationIsPublished(student);
}

export function allocationChosenSubject(student) {
  if (student && student.token && student.token.assignedSubject) return student.token.assignedSubject;
  return (student && student.selectedSubject) || '';
}

export function allocationAssignedSupervisorName(student, supervisors) {
  if (!student || !student.token) return '';
  if (student.token.staffName) return student.token.staffName;
  const person = (supervisors || []).find(function(item) { return item.staffId === student.token.staffId; });
  return person ? (person.displayName || person.staffId) : student.token.staffId;
}

export function allocationDashboardCounts(desk) {
  const students = (desk && desk.students) || [];
  const summary = (desk && desk.summary) || {};
  const people = (desk && desk.supervisors) || [];
  const slots = (desk && desk.tokenSlots) || [];
  const published = students.filter(function(student) { return allocationIsPublished(student); }).length;
  const drafted = students.filter(function(student) { return student.flags && student.flags.drafted && !allocationIsPublished(student); }).length;
  const unassigned = students.filter(function(student) { return !student.token; }).length;
  const fromStaff = people.reduce(function(sum, person) { return sum + Number(person.available || 0); }, 0);
  const fromSlots = slots.filter(function(slot) { return slot.status === 'available'; }).length;
  const tokenCount = summary.tokenCount === undefined
    ? (people.length ? people.reduce(function(sum, person) { return sum + Number(person.total || 0); }, 0) : slots.length)
    : summary.tokenCount;
  return {
    activeStudents: summary.activeStudents === undefined ? students.length : summary.activeStudents,
    tokenCount: tokenCount,
    buffer: summary.buffer === undefined ? tokenCount - students.length : summary.buffer,
    published: published,
    drafted: drafted,
    unassigned: unassigned,
    remaining: people.length ? fromStaff : fromSlots,
  };
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

export function allocationAuditEntries(logs) {
  return (logs || []).slice().sort(function(left, right) {
    const seq = (Number(right && right.seq) || 0) - (Number(left && left.seq) || 0);
    if (seq) return seq;
    return String((right && right.at) || '').localeCompare(String((left && left.at) || ''));
  });
}

export function allocationUndoCount(logs, id) {
  const rows = logs || [];
  const target = rows.find(function(row) { return row && row.id === id; });
  if (!target) return 0;
  const seq = Number(target.seq) || 0;
  return rows.filter(function(row) { return (Number(row && row.seq) || 0) >= seq; }).length;
}

export function allocationUndoMessage(count) {
  return 'You are about to undo ' + count + ' actions. Are you sure you want to proceed?';
}

export function allocationAuditMarkup(logs) {
  const entries = allocationAuditEntries(logs || state.allocationAuditLogs);
  const rows = entries.map(function(entry) {
    const id = String(entry.id || '');
    const when = entry.at ? allocationWhen(entry.at) : '';
    return `<tr class="alloc-audit-row"${when ? ` title="${escapeHtml(when)}"` : ''}>
      <td>${escapeHtml(entry.studentName || '—')}</td>
      <td>${escapeHtml(entry.subject || '—')}</td>
      <td>${escapeHtml(entry.teacher || '—')}</td>
      <td>${escapeHtml(entry.action || '')} <button type="button" class="link-button alloc-undo" data-alloc-undo="${escapeHtml(id)}">Undo</button></td>
      <td>${escapeHtml(entry.userName || entry.userEmail || '—')}</td>
    </tr>`;
  }).join('');
  const body = rows || '<tr><td class="empty" colspan="5">No allocation changes yet.</td></tr>';
  return `<section class="alloc-audit" aria-label="Allocation audit log"><h2>Allocation audit log</h2>
    <div class="table-wrap"><table><thead><tr><th>Student</th><th>Subject</th><th>Teacher</th><th>Action</th><th>User</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

export function allocationLegendMarkup() {
  const item = function(title, mode, label, kind) {
    return `<span class="alloc-legend-item">${allocationMark(title, mode, kind)}<span>${escapeHtml(label)}</span></span>`;
  };
  return `<div class="alloc-legend" aria-label="Allocation indicator key">${item('No subject drafted', 'idle', 'No Subject Drafted', 'status')}${item('Subject drafted, no token', 'off', 'Drafted', 'status')}${item('Token assigned', 'on', 'Allocated', 'status')}${item('Published allocation', 'published', 'Published', 'status')}${item('Choice 1 match', 'on', 'Choice 1', 'subject')}${item('Choice 2 match', 'off', 'Choice 2', 'subject')}${item('Choice mismatch', 'warn', 'Choice mismatch', 'subject')}${item('HL subject', 'on', 'HL subject', 'hl')}${item('Not an HL subject', 'warn', 'Not HL', 'hl')}</div>`;
}

export function allocationExpandedMarkup(student, colspan) {
  const settings = (state.allocationDesk && state.allocationDesk.settings) || {};
  const requested = allocationRequestedSubjects(student);
  const choice1 = plainChoice(student.choices && student.choices.primary, requested[0] && requested[0].name);
  const choice2 = plainChoice(student.choices && student.choices.secondary, requested[1] && requested[1].name);
  const rawInter = interdisciplinaryRaw(student, settings);
  const interLabel = rawInter === 'Yes' || rawInter === 'No' ? rawInter : (student.choices && student.choices.interdisciplinary ? 'Yes' : 'No');
  const interSubject = student.interdisciplinarySubject || '';
  const expanded = ((settings.columns) || []).filter(function(column) { return column.expanded; });
  const notes = expanded.map(function(column) {
    const value = allocationStoredField(student, column.key);
    const shown = value === undefined || value === null || value === '' ? '—' : String(value);
    return `<dt>${escapeHtml(allocationDashboardFieldLabel(column.key, settings))}</dt><dd>${escapeHtml(shown)}</dd>`;
  }).join('');
  return `<tr class="alloc-expanded"><td colspan="${colspan}"><dl>
    <dt>StudentId</dt><dd>${escapeHtml(student.studentId || '—')}</dd>
    <dt>Choice 1</dt><dd>${escapeHtml(choice1)}</dd>
    <dt>Choice 2</dt><dd>${escapeHtml(choice2)}</dd>
    <dt>Interdisciplinary</dt><dd>${escapeHtml(interLabel)}</dd>
    <dt>Interdisciplinary Subject</dt><dd>${escapeHtml(interSubject || '—')}</dd>
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
  return !!(student && student.selectedInterdisciplinary);
}

export function allocationInterdisciplinarySubject(student) {
  const studentId = student && student.studentId;
  if (studentId && Object.prototype.hasOwnProperty.call(state.allocationInterdisciplinarySubject, studentId)) {
    return state.allocationInterdisciplinarySubject[studentId];
  }
  if (student && student.interdisciplinarySubject) return student.interdisciplinarySubject;
  if (!allocationInterdisciplinaryOn(student) || !studentId) return '';
  const seeded = student && student.choices ? String(student.choices.secondary || '') : '';
  state.allocationInterdisciplinarySubject[studentId] = seeded;
  return seeded;
}

export function allocationIsFlagged(student) {
  return !!(student && student.isFlagged);
}

export function allocationFlagNote(student) {
  return student && student.flagNote ? String(student.flagNote) : '';
}

export function allocationDashboardFieldLabel(key, settings) {
  const config = settings || {};
  if (config.primaryChoiceKey && key === config.primaryChoiceKey) return 'First Choice';
  if (config.secondaryChoiceKey && key === config.secondaryChoiceKey) return 'Second Choice';
  if (config.interdisciplinaryKey && key === config.interdisciplinaryKey) return 'Interdisciplinary';
  return key || '';
}

export function allocationStoredField(student, columnKey) {
  const settings = (state.allocationDesk && state.allocationDesk.settings) || {};
  if (settings.interdisciplinaryKey && columnKey === settings.interdisciplinaryKey) {
    const raw = interdisciplinaryRaw(student, settings);
    if (raw === 'Yes' || raw === 'No') return raw;
    if (raw === 'true' || (student && student.choices && student.choices.interdisciplinary)) return 'Yes';
    if (raw === 'false') return 'No';
    return raw || 'No';
  }
  const dynamic = student && student.dynamicData ? student.dynamicData[columnKey] : undefined;
  if (dynamic !== undefined && dynamic !== null && dynamic !== '') return dynamic;
  const choices = student && student.subjectChoices ? student.subjectChoices : {};
  if (Object.prototype.hasOwnProperty.call(choices, columnKey) && choices[columnKey] !== undefined && choices[columnKey] !== null && choices[columnKey] !== '') {
    return choices[columnKey];
  }
  if (settings.primaryChoiceKey === columnKey && student && student.choices) return student.choices.primary || '';
  if (settings.secondaryChoiceKey === columnKey && student && student.choices) return student.choices.secondary || '';
  return dynamic === undefined || dynamic === null ? '' : dynamic;
}

export function allocationInterdisciplinarySubjectOptions(student, desk) {
  const names = subjectCatalogue(desk).map(function(subject) { return subject.name; });
  const choice2 = student && student.choices ? String(student.choices.secondary || '').trim() : '';
  const saved = student ? String(student.interdisciplinarySubject || '').trim() : '';
  const current = allocationInterdisciplinarySubject(student);
  [saved, choice2, current].forEach(function(name) {
    if (name && !names.some(function(item) { return sameSubjectName(item, name); })) names.unshift(name);
  });
  return names.sort(function(left, right) { return left.localeCompare(right, undefined, { sensitivity: 'base' }); });
}

export function allocationInterdisciplinaryModalMarkup(student, desk) {
  const subject = allocationInterdisciplinarySubject(student);
  const options = allocationInterdisciplinarySubjectOptions(student, desk);
  const subjectOptions = options.map(function(name) {
    return `<option value="${escapeHtml(name)}" ${sameSubjectName(name, subject) ? 'selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('');
  const name = (student && student.displayName) || 'student';
  return `<div class="form-panel member-editor" role="dialog" aria-modal="true" aria-labelledby="alloc-inter-modal-title"><div class="toolbar"><h2 id="alloc-inter-modal-title">Interdisciplinary EE</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p class="muted">Choose the second subject for ${escapeHtml(name)}.</p>
    <div class="field"><label for="alloc-inter-modal-subject">Second interdisciplinary subject</label><select id="alloc-inter-modal-subject"><option value="">Choose subject...</option>${subjectOptions}</select></div>
    <p class="notice error" id="alloc-inter-modal-error" hidden></p>
    <div class="toolbar"><button type="button" class="button" id="alloc-inter-modal-save">Save</button><button type="button" class="button secondary" data-close-admin-dialog>Cancel</button></div></div>`;
}

export function allocationCustomSelections(filters, key) {
  const value = filters ? filters[key] : undefined;
  if (Array.isArray(value)) return value.map(function(item) { return String(item); }).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

export function allocationCustomValues(desk, key) {
  const values = new Map();
  ((desk && desk.students) || []).forEach(function(student) {
    const raw = student.dynamicData && student.dynamicData[key];
    if (raw === undefined || raw === null || raw === '') return;
    const value = String(raw);
    if (!values.has(value)) values.set(value, value);
  });
  return Array.from(values.values()).sort(function(left, right) {
    return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
  });
}

const ALLOCATION_STATUS_OPTIONS = [
  ['all', 'All'],
  ['unallocated', 'Unallocated'],
  ['drafted', 'Drafted'],
  ['suggested', 'Suggested'],
  ['allocated', 'Allocated'],
  ['published', 'Published'],
];

function cloneCustomFilters(filters) {
  const copy = {};
  Object.keys(filters || {}).forEach(function(key) {
    copy[key] = allocationCustomSelections(filters, key);
  });
  return copy;
}

function appliedFilterDraft() {
  return {
    status: state.allocationStatus || 'all',
    needSupport: state.allocationNeedSupport || 'all',
    flagged: state.allocationFlaggedFilter || 'all',
    supportFlags: (state.allocationSupportFlags || []).slice(),
    subject: (state.allocationSubjectFilter || []).slice(),
    selected: (state.allocationSelectedSubjectFilter || []).slice(),
    teacher: (state.allocationTeacherFilter || []).slice(),
    custom: cloneCustomFilters(state.allocationCustomFilters),
  };
}

function shownFilterDraft() {
  return state.allocationFilterDraft || appliedFilterDraft();
}

function ensureFilterDraft() {
  if (!state.allocationFilterDraft) state.allocationFilterDraft = appliedFilterDraft();
  return state.allocationFilterDraft;
}

function allocationFiltersNarrow() {
  if (state.allocationStatus && state.allocationStatus !== 'all') return true;
  if (state.allocationNeedSupport === 'yes') return true;
  if (state.allocationFlaggedFilter === 'yes') return true;
  if (String(state.allocationQuery || '').trim()) return true;
  if ((state.allocationSupportFlags || []).length) return true;
  if ((state.allocationSubjectFilter || []).length) return true;
  if ((state.allocationSelectedSubjectFilter || []).length) return true;
  if ((state.allocationTeacherFilter || []).length) return true;
  if (state.allocationWorkflowFilter) return true;
  const custom = state.allocationCustomFilters || {};
  return Object.keys(custom).some(function(key) {
    return allocationCustomSelections(custom, key).length > 0;
  });
}

function writeAppliedFilters(draft) {
  state.allocationStatus = draft.status || 'all';
  state.allocationNeedSupport = draft.needSupport || 'all';
  state.allocationFlaggedFilter = draft.flagged || 'all';
  state.allocationSupportFlags = (draft.supportFlags || []).slice();
  state.allocationSubjectFilter = (draft.subject || []).slice();
  state.allocationSelectedSubjectFilter = (draft.selected || []).slice();
  state.allocationTeacherFilter = (draft.teacher || []).slice();
  state.allocationCustomFilters = cloneCustomFilters(draft.custom);
  state.allocationFilterDraft = null;
}

export function commitAllocationFilterDraft(desk) {
  writeAppliedFilters(state.allocationFilterDraft || appliedFilterDraft());
  if (!allocationFiltersNarrow() || !desk) {
    state.allocationFilterSnapshot = null;
    return null;
  }
  const ids = (desk.students || []).filter(function(student) {
    return allocationQueryMatches(student, state.allocationQuery) && allocationStudentMatchesFilters(student, desk);
  }).map(function(student) { return student.studentId; });
  state.allocationFilterSnapshot = ids;
  return ids;
}

export function applyAllocationFilters() {
  state.allocationOverviewDrilldown = null;
  commitAllocationFilterDraft(state.allocationDesk);
  paintAllocation();
}

export function resetAllocationFilters() {
  state.allocationStatus = 'all';
  state.allocationSupport = 'all';
  state.allocationNeedSupport = 'all';
  state.allocationFlaggedFilter = 'all';
  state.allocationSupportFlags = [];
  state.allocationSubjectFilter = [];
  state.allocationSelectedSubjectFilter = [];
  state.allocationTeacherFilter = [];
  state.allocationCustomFilters = {};
  state.allocationWorkflowFilter = null;
  state.allocationQuery = '';
  state.allocationCustomQueries = {};
  state.allocationCustomOpen = '';
  state.allocationFilterDraft = null;
  state.allocationFilterSnapshot = null;
  state.allocationOverviewDrilldown = null;
}

function allocationStatusOptionsMarkup() {
  const selected = shownFilterDraft().status || 'all';
  return ALLOCATION_STATUS_OPTIONS.map(function(item) {
    return `<option value="${item[0]}"${selected === item[0] ? ' selected' : ''}>${item[1]}</option>`;
  }).join('');
}

function binaryFilterMarkup(id, label, value) {
  const selected = value === 'yes' ? 'yes' : 'all';
  return `<div><label for="${id}">${escapeHtml(label)}</label><select id="${id}"><option value="all"${selected === 'all' ? ' selected' : ''}>All</option><option value="yes"${selected === 'yes' ? ' selected' : ''}>${escapeHtml(label)}</option></select></div>`;
}

function allocationNeedSupportFilterMarkup() {
  return binaryFilterMarkup('alloc-need-support', 'Need Support', shownFilterDraft().needSupport);
}

function allocationFlaggedFilterMarkup() {
  return binaryFilterMarkup('alloc-flagged-filter', 'Flagged', shownFilterDraft().flagged);
}

export function allocationCustomFilterMarkup(desk) {
  const columns = ((desk && desk.settings && desk.settings.columns) || []).filter(function(column) {
    return column.filterable === true;
  });
  const draftCustom = shownFilterDraft().custom || {};
  return columns.map(function(column, index) {
    const selected = allocationCustomSelections(draftCustom, column.key);
    const query = String((state.allocationCustomQueries || {})[column.key] || '');
    const needle = query.trim().toLowerCase();
    const options = allocationCustomValues(desk, column.key).filter(function(value) {
      return !needle || value.toLowerCase().indexOf(needle) >= 0;
    });
    const inputId = 'alloc-custom-query-' + index;
    const listId = 'alloc-custom-list-' + index;
    const open = state.allocationCustomOpen === column.key;
    const chips = selected.map(function(value) {
      return `<button type="button" class="alloc-combo-chip" data-alloc-custom-filter="${escapeHtml(column.key)}" data-alloc-custom-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}">${escapeHtml(value)} ×</button>`;
    }).join('');
    const choices = options.map(function(value) {
      const on = selected.indexOf(value) >= 0;
      return `<button type="button" role="option" aria-selected="${on ? 'true' : 'false'}" data-alloc-custom-filter="${escapeHtml(column.key)}" data-alloc-custom-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`;
    }).join('');
    return `<div class="alloc-custom-filter" data-alloc-custom-filter="${escapeHtml(column.key)}"><label for="${inputId}">${escapeHtml(column.key)}</label><div class="alloc-combo">${chips ? `<div class="alloc-combo-selected">${chips}</div>` : ''}<input id="${inputId}" type="search" data-alloc-custom-query="${escapeHtml(column.key)}" value="${escapeHtml(query)}" placeholder="Search values" autocomplete="off" aria-controls="${listId}" aria-expanded="${open ? 'true' : 'false'}"><div class="alloc-combo-list" id="${listId}" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(column.key)} values"${open ? '' : ' hidden'}>${choices || '<p class="muted">No matching values</p>'}</div></div></div>`;
  }).join('');
}

export function allocationSubjectFilterMarkup(desk) {
  const options = allocationSubjectOptions(desk);
  if (!options.length) return '';
  const selected = shownFilterDraft().subject || [];
  const allOn = selected.length === 0;
  const chips = options.map(function(subject) {
    const on = selected.some(function(name) { return sameSubjectName(name, subject.name); });
    const colour = subjectChipStyle(subject.colour);
    return `<button type="button" class="subject-chip" data-alloc-subject-filter="${escapeHtml(subject.name)}" aria-pressed="${on ? 'true' : 'false'}"${colour ? ` style="${colour}"` : ''}>${subjectLabelHtml(subject.name, subject.shortName)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Requested subject</span><div class="alloc-subject-picks" role="group" aria-label="Requested subject"><button type="button" class="alloc-filter-all" data-alloc-subject-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationSelectedSubjectFilterMarkup(desk) {
  const options = allocationSelectedSubjectOptions(desk);
  if (!options.length) return '';
  const selected = shownFilterDraft().selected || [];
  const allOn = selected.length === 0;
  const chips = options.map(function(subject) {
    const on = selected.some(function(name) { return sameSubjectName(name, subject.name); });
    const colour = subjectChipStyle(subject.colour);
    return `<button type="button" class="subject-chip" data-alloc-selected-filter="${escapeHtml(subject.name)}" aria-pressed="${on ? 'true' : 'false'}"${colour ? ` style="${colour}"` : ''}>${subjectLabelHtml(subject.name, subject.shortName)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Selected subject</span><div class="alloc-subject-picks" role="group" aria-label="Selected subject"><button type="button" class="alloc-filter-all" data-alloc-selected-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationTeacherFilterMarkup(desk) {
  const people = (desk.supervisors || []).slice().sort(function(left, right) {
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), undefined, { sensitivity: 'base' });
  });
  if (!people.length) return '';
  const selected = shownFilterDraft().teacher || [];
  const allOn = selected.length === 0;
  const chips = people.map(function(person) {
    const on = selected.indexOf(person.staffId) >= 0;
    return `<button type="button" class="subject-chip" data-alloc-teacher-filter="${escapeHtml(person.staffId)}" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(person.displayName || person.staffId)}</button>`;
  }).join('');
  return `<div class="alloc-subject-filter"><span class="alloc-kicker">Allocated teacher</span><div class="alloc-subject-picks" role="group" aria-label="Allocated teacher"><button type="button" class="alloc-filter-all" data-alloc-teacher-filter="" aria-pressed="${allOn ? 'true' : 'false'}">All</button>${chips}</div></div>`;
}

export function allocationSupportFilterMarkup(desk) {
  const options = allocationSupportOptions(desk);
  const selected = shownFilterDraft().supportFlags || [];
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

export function allocationSelectedSubjectOptions(desk) {
  const seen = new Map();
  allocationSubjectOptions(desk).forEach(function(subject) {
    seen.set(subject.name.toLowerCase(), subject);
  });
  (desk.students || []).forEach(function(student) {
    const name = String(student.selectedSubject || '').trim();
    if (!name || seen.has(name.toLowerCase())) return;
    const known = subjectCatalogue(desk).find(function(subject) { return sameSubjectName(subject.name, name); });
    seen.set(name.toLowerCase(), known || { name: name, colour: '', shortName: '' });
  });
  return Array.from(seen.values()).sort(function(left, right) {
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

function teacherSubjectCounts(person, subject, desk) {
  if (desk && Array.isArray(desk.tokenRows)) {
    const rows = desk.tokenRows.filter(function(token) {
      return token.staffId === person.staffId && subjectsOverlap(subject, token.eligibleSubjects || []);
    });
    const allocated = rows.filter(function(token) { return String(token.status || 'available') !== 'available'; }).length;
    return { allocated: allocated, total: rows.length };
  }
  const total = Number(person.total) || 0;
  const available = Number(person.available) || 0;
  return { allocated: Math.max(0, total - available), total: total };
}

function holdsEligibleToken(student, person, subject) {
  const token = student && student.token;
  if (!token || token.staffId !== person.staffId) return false;
  const eligible = Array.isArray(token.eligibleSubjects) && token.eligibleSubjects.length
    ? token.eligibleSubjects
    : (person.eligibleSubjects || []);
  if (!subject) return true;
  return subjectsOverlap(subject, eligible);
}

function allocationSupervisorMatchSubject(person, student, selectedSubject) {
  const eligible = person.eligibleSubjects || [];
  if (subjectsOverlap(selectedSubject, eligible)) return selectedSubject;
  const secondSubject = allocationInterdisciplinaryOn(student) ? allocationInterdisciplinarySubject(student) : '';
  return secondSubject && subjectsOverlap(secondSubject, eligible) ? secondSubject : '';
}

function teacherCanTake(person, subject, student, desk) {
  const counts = teacherSubjectCounts(person, subject, desk);
  return counts.allocated < counts.total || holdsEligibleToken(student, person, subject);
}

export function nextAllocationTeacher(student, subject, supervisors, desk) {
  const people = (supervisors || []).filter(function(person) {
    return subjectsOverlap(subject, person.eligibleSubjects || []);
  }).slice().sort(function(left, right) {
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), undefined, { sensitivity: 'base' });
  });
  const open = people.find(function(person) {
    const counts = teacherSubjectCounts(person, subject, desk);
    return counts.allocated < counts.total;
  });
  if (open) return open;
  return people.find(function(person) { return holdsEligibleToken(student, person, subject); }) || null;
}

export function allocationSubjectAction(student, subject) {
  return { type: 'select', subject: subject };
}

export function allocationSuggestionMarkup(student, locked) {
  const staffId = student && student.suggestedStaffId ? student.suggestedStaffId : '';
  if (!staffId) return '';
  const name = (student.suggestedStaffName || staffId);
  const approve = locked ? '' : `<button type="button" class="alloc-approve-link" data-alloc-approve="${escapeHtml(student.studentId)}">Approve</button>`;
  return `<p class="alloc-suggestion">Suggested: ${escapeHtml(name)} ${approve}</p>`;
}

export function allocationSupervisorCues(student, supervisors, desk) {
  const picked = allocationChosenSubject(student);
  const locked = allocationIsPublished(student);
  const source = desk || state.allocationDesk;
  if (!picked) {
    return `<label class="alloc-teacher-pick">Teacher<select class="alloc-teacher-select" data-alloc-supervisor="${escapeHtml(student.studentId)}" aria-label="Teacher" disabled><option value="">Choose a subject first...</option></select></label>`;
  }
  const match = allocationRequestedSubjects(student).filter(function(item) { return sameSubjectName(item.name, picked); })[0];
  const colour = subjectChipStyle(match ? match.colour : '');
  const current = student.token ? student.token.staffId : '';
  const eligible = (supervisors || []).filter(function(person) {
    return !!allocationSupervisorMatchSubject(person, student, picked);
  }).slice().sort(function(left, right) {
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), undefined, { sensitivity: 'base' });
  });
  if (!eligible.length) return `<p class="muted alloc-cue-empty">No supervisor is eligible for ${escapeHtml(picked)}.</p>`;
  const options = eligible.map(function(person) {
    const matchedSubject = allocationSupervisorMatchSubject(person, student, picked);
    const counts = teacherSubjectCounts(person, matchedSubject, source);
    const canTake = teacherCanTake(person, matchedSubject, student, source);
    const selected = person.staffId === current ? ' selected' : '';
    const disabled = canTake ? '' : ' disabled class="alloc-teacher-empty"';
    const label = (person.displayName || person.staffId) + ' (' + counts.allocated + '/' + counts.total + ')';
    return `<option value="${escapeHtml(person.staffId)}"${disabled}${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  const lock = locked ? ' disabled' : '';
  return `<label class="alloc-teacher-pick">Teacher<select class="alloc-teacher-select" data-alloc-supervisor="${escapeHtml(student.studentId)}" aria-label="Teacher for ${escapeHtml(picked)}"${colour ? ` style="${colour}"` : ''}${lock}><option value="">Choose teacher...</option>${options}</select></label>`;
}

export function subjectChipStyle(colour) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(colour || '').trim());
  if (!match) return '';
  const value = '#' + match[1].toLowerCase();
  return '--subject:' + value + ';--subject-bg:color-mix(in srgb, ' + value + ' 18%, white);--subject-fg:' + value;
}

function subjectChoiceChip(student, choice, selected, locked, label, score) {
  const on = selected ? ' on' : '';
  const lock = locked ? ' is-locked' : '';
  const colour = subjectChipStyle(choice.colour);
  const disabled = locked ? ' disabled' : '';
  const who = student.displayName || student.studentId;
  const kicker = label ? `<span class="alloc-choice-kicker">${escapeHtml(label)}</span>` : '';
  const scoreText = String(score || '').trim();
  const scoreLabel = scoreText ? ` (${escapeHtml(scoreText)})` : '';
  const accessible = (label ? label + ' ' : '') + choice.name + (scoreText ? ' (' + scoreText + ')' : '');
  return `<button type="button" class="subject-chip${on}${lock}" data-alloc-subject="${escapeHtml(student.studentId)}" data-subject="${escapeHtml(choice.name)}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${locked ? 'Allocated' : 'Select'} ${escapeHtml(accessible)} for ${escapeHtml(who)}"${colour ? ` style="${colour}"` : ''}${disabled ? ' disabled' : ''}>${kicker}${escapeHtml(choice.name)}${scoreLabel}</button>`;
}

export function allocationSubjectChoiceMarkup(student, desk) {
  const requested = allocationRequestedSubjects(student);
  const selectedName = String(student && student.selectedSubject || '');
  const locked = allocationIsPublished(student);
  const catalogue = subjectCatalogue(desk || state.allocationDesk).filter(function(subject) { return subject.active !== false; });
  const chips = requested.map(function(choice, index) {
    const label = index === 0 ? '1' : index === 1 ? '2' : '';
    const scores = student.choices || {};
    const score = index === 0 ? scores.primaryScore : index === 1 ? scores.secondaryScore : '';
    return subjectChoiceChip(student, choice, sameSubjectName(choice.name, selectedName), locked, label, score);
  }).join('');
  const extraMatch = selectedName && !requested.some(function(choice) { return sameSubjectName(choice.name, selectedName); });
  const extra = extraMatch
    ? (catalogue.find(function(subject) { return sameSubjectName(subject.name, selectedName); }) || { name: selectedName, colour: '', shortName: '' })
    : null;
  const pickerOpen = !locked && !!(state.allocationSubjectPicker && state.allocationSubjectPicker[student.studentId]);
  const add = locked ? '' : `<button type="button" class="alloc-subject-add" data-alloc-subject-add="${escapeHtml(student.studentId)}" aria-expanded="${pickerOpen ? 'true' : 'false'}" aria-label="Choose another subject for ${escapeHtml(student.displayName || student.studentId)}">+</button>`;
  const options = catalogue.map(function(subject) {
    const selected = sameSubjectName(subject.name, selectedName) ? ' selected' : '';
    return `<option value="${escapeHtml(subject.name)}"${selected}>${escapeHtml(subject.name)}</option>`;
  }).join('');
  const known = catalogue.some(function(subject) { return sameSubjectName(subject.name, selectedName); });
  const current = extra && !known ? `<option value="${escapeHtml(selectedName)}" selected>${escapeHtml(selectedName)}</option>` : '';
  const picker = pickerOpen ? `<select class="alloc-extra-subject" data-alloc-extra-subject="${escapeHtml(student.studentId)}" aria-label="Other subject for ${escapeHtml(student.displayName || student.studentId)}"><option value="">Choose subject...</option>${options}${current}</select>` : '';
  const extraChip = extra && !pickerOpen ? subjectChoiceChip(student, extra, true, locked, '') : '';
  return `${chips}${add}${picker}${extraChip}`;
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

function allocationChoice1Subject(student) {
  const requested = allocationRequestedSubjects(student);
  return plainChoice(student && student.choices && student.choices.primary, requested[0] && requested[0].name);
}

export function subjectLabelHtml(name, shortName) {
  const full = String(name || '').trim();
  const short = String(shortName || '').trim();
  if (!short || short.toLowerCase() === full.toLowerCase()) return escapeHtml(full);
  return `<span title="${escapeHtml(full)}">${escapeHtml(short)}</span>`;
}

export function subjectCatalogue(desk) {
  return ((desk && desk.subjects) || []).map(function(subject) {
    if (subject && typeof subject === 'object') return { name: String(subject.name || '').trim(), shortName: String(subject.shortName || '').trim(), colour: String(subject.colour || '').trim(), department: String(subject.department || '').trim(), active: subject.active !== false };
    return { name: String(subject || '').trim(), shortName: '', colour: '', department: '', active: true };
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

export function supervisorAcceptsSubject(desk, staffId, subject, student) {
  if (!staffId || !subject) return true;
  const person = ((desk && desk.supervisors) || []).find(function(item) { return item.staffId === staffId; });
  return !!person && !!allocationSupervisorMatchSubject(person, student, subject);
}

function applyPendingDesk() {
  const base = state.allocationRemoteDesk || state.allocationDesk;
  if (!base) return;
  state.allocationDesk = presentAllocationDesk(base);
}

const flagSaveTimers = {};

function queueAllocationFlag(studentId, isFlagged, flagNote, immediate) {
  const edit = {
    isFlagged: isFlagged === true,
    flagNote: String(flagNote || '').slice(0, 500),
    acked: false,
  };
  state.allocationPendingFlags[studentId] = edit;
  applyPendingDesk();
  paintAllocationLive();
  if (flagSaveTimers[studentId]) clearTimeout(flagSaveTimers[studentId]);
  const wait = immediate ? 0 : 400;
  flagSaveTimers[studentId] = setTimeout(function() {
    delete flagSaveTimers[studentId];
    const current = state.allocationPendingFlags[studentId];
    if (current !== edit) return;
    const cohortId = state.cohortId;
    callServer('saveAllocationFlag', cohortId, studentId, edit.isFlagged, edit.flagNote).then(function() {
      if (state.cohortId !== cohortId || state.allocationPendingFlags[studentId] !== edit) return;
      edit.acked = true;
      const remote = ((state.allocationRemoteDesk && state.allocationRemoteDesk.students) || []).find(function(student) {
        return student.studentId === studentId;
      });
      if (remote && (remote.isFlagged === true) === edit.isFlagged && String(remote.flagNote || '') === edit.flagNote) {
        delete state.allocationPendingFlags[studentId];
        applyPendingDesk();
        paintAllocationLive();
      }
    }).catch(function(error) {
      if (state.cohortId === cohortId && state.allocationPendingFlags[studentId] === edit) {
        delete state.allocationPendingFlags[studentId];
        applyPendingDesk();
        paintAllocationLive();
      }
      showError(error);
    });
  }, wait);
}

function openAllocationInterdisciplinaryModal(student, desk, wasOn, seededNow) {
  if (!student) return;
  openAdminDialog('allocation-interdisciplinary', allocationInterdisciplinaryModalMarkup(student, desk));
  const dialog = document.getElementById('form-dialog');
  if (!dialog) return;
  let settled = false;
  function revert() {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onEscape, true);
    if (!wasOn) {
      delete state.allocationInterdisciplinary[student.studentId];
      if (seededNow) delete state.allocationInterdisciplinarySubject[student.studentId];
    }
    paintAllocation();
  }
  function onEscape(event) {
    if (event.key !== 'Escape') return;
    if (adminDialogKind() !== 'allocation-interdisciplinary') return;
    revert();
  }
  document.addEventListener('keydown', onEscape, true);
  dialog.onclick = function(event) {
    if (event.target !== dialog) return;
    revert();
    closeAdminDialog();
  };
  dialog.querySelectorAll('[data-close-admin-dialog]').forEach(function(button) {
    button.addEventListener('click', revert);
  });
  const save = document.getElementById('alloc-inter-modal-save');
  if (!save) return;
  save.addEventListener('click', function() {
    const subjectSelect = document.getElementById('alloc-inter-modal-subject');
    const error = document.getElementById('alloc-inter-modal-error');
    const chosenSubject = subjectSelect ? subjectSelect.value : '';
    if (!chosenSubject) {
      if (error) {
        error.hidden = false;
        error.textContent = 'Choose a second subject.';
      }
      return;
    }
    settled = true;
    document.removeEventListener('keydown', onEscape, true);
    state.allocationInterdisciplinary[student.studentId] = true;
    state.allocationInterdisciplinarySubject[student.studentId] = chosenSubject;
    closeAdminDialog();
    const currentToken = student.token;
    const assignedSubject = currentToken && currentToken.assignedSubject
      ? currentToken.assignedSubject
      : (student.selectedSubject || '');
    saveAllocationDraft(
      student.studentId,
      currentToken ? currentToken.staffId : '',
      assignedSubject,
      true,
      'Interdisciplinary subject saved.',
      { bypassSubject: !!currentToken },
    );
  });
}

function openAllocationUndoDialog(logId, count) {
  const message = allocationUndoMessage(count);
  openAdminDialog('allocation-undo', `<div class="form-panel member-editor" role="dialog" aria-modal="true" aria-labelledby="alloc-undo-title"><div class="toolbar"><h2 id="alloc-undo-title">Undo allocation changes</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p>${escapeHtml(message)}</p>
    <div class="toolbar"><button type="button" class="button secondary" data-close-admin-dialog>Cancel</button><button type="button" class="button" id="alloc-undo-confirm">Undo</button></div></div>`);
  const confirm = document.getElementById('alloc-undo-confirm');
  if (!confirm) return;
  confirm.addEventListener('click', function() {
    confirm.disabled = true;
    const cohortId = state.cohortId;
    callServer('undoAllocationAudit', cohortId, logId).then(function() {
      closeAdminDialog();
      showSuccess('Undid ' + count + ' actions.');
      if (state.allocationListenFallback) loadAllocation();
    }).catch(function(error) {
      confirm.disabled = false;
      showError(error);
    });
  });
}

function saveAllocationDraft(studentId, staffId, subject, interdisciplinary, message, options) {
  const student = ((state.allocationDesk && state.allocationDesk.students) || []).find(function(item) {
    return item.studentId === studentId;
  });
  if (allocationIsPublished(student)) {
    showError(new Error('This allocation is published. Unpublish it before changing the token.'));
    paintAllocation();
    return;
  }
  const extra = options || {};
  const interdisciplinarySubject = interdisciplinary
    ? (Object.prototype.hasOwnProperty.call(state.allocationInterdisciplinarySubject, studentId)
      ? state.allocationInterdisciplinarySubject[studentId]
      : (student && student.interdisciplinarySubject) || '')
    : '';
  const edit = {
    staffId: staffId || '',
    subject: subject || '',
    interdisciplinary: interdisciplinary === true,
    interdisciplinarySubject,
    tokenId: extra.tokenId || '',
    startedAt: new Date().toISOString(),
    acked: false,
  };
  if (!state.allocationRemoteDesk && state.allocationDesk) state.allocationRemoteDesk = state.allocationDesk;
  state.allocationPendingEdits[studentId] = edit;
  delete state.allocationInterdisciplinary[studentId];
  if (!interdisciplinary) delete state.allocationInterdisciplinarySubject[studentId];
  applyPendingDesk();
  paintAllocationLive();
  const cohortId = state.cohortId;
  callServer('draftAllocation', cohortId, studentId, staffId, subject, interdisciplinary === true, interdisciplinarySubject, {
    bypassSubject: extra.bypassSubject === true,
    tokenId: extra.tokenId || '',
  }).then(function(result) {
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
  const sortColumn = state.allocationDrawerSortColumn || 'subject';
  const sortDirection = state.allocationDrawerSortDirection === -1 ? -1 : 1;
  const subjects = (load.subjects || []).slice().sort(function(left, right) {
    const leftValue = sortColumn === 'subject' ? String(left.subject || '') : Number(left[sortColumn]) || 0;
    const rightValue = sortColumn === 'subject' ? String(right.subject || '') : Number(right[sortColumn]) || 0;
    const comparison = sortColumn === 'subject'
      ? leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' })
      : leftValue - rightValue;
    return comparison * sortDirection;
  });
  if (!subjects.length) {
    if (load.untied) return untiedTokenNote(load.untied);
    return '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Student Data.</div>';
  }
  const metricTitle = 'Total requested and first-choice count (Pool (1)), unallocated requested and first-choice count (UPool (1)), total allocated (Alloc), tokens remaining (Rem). 15 (10) means 15 students requested the subject and 10 picked it as choice 1.';
  const blocks = subjects.map(function(item) {
    const pool = Number(item.pool) || 0;
    const upool = Number(item.upool) || 0;
    const alloc = Number(item.alloc) || 0;
    const remaining = Number(item.remaining) || 0;
    const total = alloc + remaining;
    return `<div class="alloc-subject-block"><p class="alloc-subject-name">${subjectLabelHtml(item.subject, shortNameFor(item.subject, desk))}</p><span>${demandFigure(pool, item.poolChoice1, remaining)}</span><span>${demandFigure(upool, item.upoolChoice1, remaining)}</span><span>${alloc}</span><span>${remaining}</span>${allocationMeterMarkup(alloc, total)}</div>`;
  }).join('');
  const sortHeaders = [['subject', 'Subject'], ['pool', 'Pool (1)'], ['upool', 'UPool (1)'], ['alloc', 'Alloc'], ['remaining', 'Rem']].map(function(item) {
    const active = sortColumn === item[0];
    const arrow = active ? (sortDirection === 1 ? ' ▲' : ' ▼') : '';
    return `<button type="button" data-alloc-drawer-sort="${item[0]}" aria-sort="${active ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none'}">${item[1]}${arrow}</button>`;
  }).join('');
  const untied = load.untied ? untiedTokenNote(load.untied) : '';
  const note = load.overlaps ? '<p class="muted alloc-load-note">An open token counts toward every subject it can take.</p>' : '';
  return `<div class="alloc-subject-load"><p class="sr-only">Subject token load</p><div class="alloc-subject-metrics" title="${escapeHtml(metricTitle)}">${sortHeaders}</div>${blocks}</div>${untied}${note}`;
}

function demandFigure(total, choice1, remaining) {
  const count = Number(total) || 0;
  const first = Number(choice1) || 0;
  const shown = count + ' (' + first + ')';
  if (count > (Number(remaining) || 0)) return `<strong class="alloc-capacity-warn">${shown}</strong>`;
  return shown;
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
  const hod = state.allocationView === 'hod';
  const validViews = hod ? ['subject', 'supervisor', 'assigned'] : ['overview', 'hod-overview', 'subject', 'supervisor', 'assigned'];
  const view = validViews.indexOf(state.allocationLoadView) >= 0
    ? state.allocationLoadView
    : hod ? 'subject' : 'overview';
  const heading = hod
    ? (view === 'assigned' ? 'Suggested tokens' : view === 'supervisor' ? 'Suggestion load' : 'Subject suggestions')
    : (view === 'overview' ? 'Subject Allocation' : view === 'hod-overview' ? 'HOD' : view === 'assigned' ? 'Assigned tokens' : view === 'supervisor' ? 'Supervisor token load' : 'Subject token load');
  const assignedLabel = hod ? 'Suggested taken' : 'Assigned Tokens';
  const tokens = desk && Array.isArray(desk.tokenRows) && desk.tokenRows.length ? desk.tokenRows : allocationTokenSlots(desk);
  const body = hod
    ? hodLoadBody(desk, view)
    : view === 'overview'
      ? allocationCoordinatorOverviewMarkup(desk)
      : view === 'hod-overview'
        ? allocationHodOverviewMarkup(desk)
      : view === 'assigned'
      ? allocationAssignedMarkup(desk)
      : view === 'subject'
        ? subjectTokenLoadMarkup(subjectTokenLoad(tokens, allocationDemand(desk), catalogueNames(desk)), desk)
        : (supervisors.length ? supervisors.map(allocationLoadMarkup).join('') : '<div class="empty">No tokens yet. Build them in Staff users → EE quotas, or ingest a token sheet from Student Data.</div>');
  const buttons = hod
    ? [['subject', 'Subject'], ['supervisor', 'Supervisor'], ['assigned', assignedLabel]]
    : [['overview', 'Subject Allocation'], ['hod-overview', 'HOD'], ['subject', 'Subject capacity'], ['supervisor', 'Supervisor'], ['assigned', 'Assigned tokens']];
  const tabs = buttons.map(function(item) {
    return `<button type="button" data-alloc-load="${item[0]}" aria-pressed="${view === item[0] ? 'true' : 'false'}">${item[1]}</button>`;
  }).join('');
  return `<header><h2>${heading}</h2><div class="view-toggle" role="group" aria-label="Token overview">${tabs}</div></header>${body}`;
}

export function allocationCoordinatorOverview(desk) {
  const students = (desk && desk.students) || [];
  const subjectBuckets = new Map();
  const departmentBuckets = new Map();
  const drilldowns = {};
  const drilldownLabels = {
    'subject-needed': 'Students needing a subject',
    'subject-selected': 'Students with a selected subject',
    'proposal-needed': 'Students needing an HOD proposal',
    'proposal-review': 'Proposals awaiting coordinator review',
    'proposal-stale': 'Proposals with a changed subject',
    'assignment-draft': 'Draft assignments',
    'assignment-published': 'Published allocations',
  };
  const needsSubject = [];
  const hasSubject = [];
  const needsProposal = [];
  const awaitingApproval = [];
  const staleProposal = [];
  const drafts = [];
  const published = [];
  const hasTokenRows = !!(desk && Array.isArray(desk.tokenRows) && desk.tokenRows.length);
  const capacityTokens = hasTokenRows ? desk.tokenRows : allocationTokenSlots(desk);
  const knownSubjects = catalogueNames(desk);
  function bucketSubject(name) {
    const subject = String(name || '').trim();
    if (!subject) return null;
    const key = subject.toLowerCase();
    if (!subjectBuckets.has(key)) {
      subjectBuckets.set(key, {
        subject: subject,
        ids: [],
        poolIds: [],
        poolChoice1Ids: [],
        undraftedIds: [],
        undraftedChoice1Ids: [],
        draftedIds: [],
        allocated: 0,
        total: 0,
        remaining: 0,
        shortfall: 0,
      });
    }
    return subjectBuckets.get(key);
  }
  subjectCatalogue(desk).forEach(function(subject) { bucketSubject(subject.name); });
  subjectTokenLoad(capacityTokens, allocationDemand(desk), knownSubjects).subjects.forEach(function(row) {
    const bucket = bucketSubject(row.subject);
    if (!bucket) return;
    bucket.allocated = Number(row.alloc) || 0;
    bucket.total = bucket.allocated + (Number(row.remaining) || 0);
  });

  subjectCatalogue(desk).forEach(function(subject) {
    const department = String(subject.department || '').trim();
    const key = department.toLowerCase();
    if (department && !departmentBuckets.has(key)) {
      departmentBuckets.set(key, { department: department, ids: [], proposals: [] });
    }
  });

  students.forEach(function(student) {
    const subject = String(student.selectedSubject || '').trim();
    const token = student.token || null;
    const suggestion = String(student.suggestedStaffId || '').trim();
    const requestedNames = [];
    allocationRequestedSubjects(student).forEach(function(item) {
      if (!requestedNames.some(function(name) { return sameSubjectName(name, item.name); })) requestedNames.push(item.name);
    });
    requestedNames.forEach(function(name) {
      const bucket = bucketSubject(name);
      if (!bucket) return;
      bucket.poolIds.push(student.studentId);
      if (sameSubjectName(allocationChoice1Subject(student), name)) bucket.poolChoice1Ids.push(student.studentId);
      if (!subject) {
        bucket.undraftedIds.push(student.studentId);
        if (sameSubjectName(allocationChoice1Subject(student), name)) bucket.undraftedChoice1Ids.push(student.studentId);
      }
    });
    if (!subject) needsSubject.push(student.studentId);
    else {
      hasSubject.push(student.studentId);
      const bucket = bucketSubject(subject);
      bucket.ids.push(student.studentId);
      bucket.draftedIds.push(student.studentId);
      const department = departmentOfSubject(subject, catalogueForDepartment(desk));
      if (department) {
        const departmentKey = department.toLowerCase();
        if (!departmentBuckets.has(departmentKey)) departmentBuckets.set(departmentKey, { department: department, ids: [], proposals: [] });
        departmentBuckets.get(departmentKey).ids.push(student.studentId);
      }
    }

    if (subject && !suggestion && !token) needsProposal.push(student.studentId);
    if (suggestion && (!token || String(token.staffId || '').toLowerCase() !== suggestion.toLowerCase())) {
      awaitingApproval.push(student.studentId);
    }
    if (suggestion && student.suggestedSubject && !sameSubjectName(student.suggestedSubject, subject)) {
      staleProposal.push(student.studentId);
    }
    if (token && token.status === 'draft') drafts.push(student.studentId);
    if (allocationIsPublished(student)) published.push(student.studentId);
  });

  const departmentStatuses = (state.allocationHodStatus && state.allocationHodStatus.byDepartment) || {};
  const departments = Array.from(departmentBuckets.values()).map(function(item) {
    const statusKey = Object.keys(departmentStatuses).find(function(key) {
      const row = departmentStatuses[key] || {};
      return departmentsMatch(row.department, item.department) || key === item.department.toLowerCase();
    });
    const status = statusKey ? departmentStatuses[statusKey] : null;
    const proposalIds = awaitingApproval.filter(function(id) {
      const student = students.find(function(row) { return row.studentId === id; });
      return student && departmentsMatch(departmentOfSubject(student.selectedSubject, catalogueForDepartment(desk)), item.department);
    });
    item.proposals = proposalIds;
    item.submitted = !!(status && status.submitted);
    return item;
  }).sort(function(left, right) {
    return left.department.localeCompare(right.department, undefined, { sensitivity: 'base' });
  });

  const subjects = Array.from(subjectBuckets.values()).map(function(item) {
    item.remaining = item.total - item.draftedIds.length;
    item.shortfall = Math.max(0, -item.remaining);
    return item;
  }).sort(function(left, right) {
    return left.subject.localeCompare(right.subject, undefined, { sensitivity: 'base' });
  });
  drilldowns['subject-needed'] = needsSubject;
  drilldowns['subject-selected'] = hasSubject;
  drilldowns['proposal-needed'] = needsProposal;
  drilldowns['proposal-review'] = awaitingApproval;
  drilldowns['proposal-stale'] = staleProposal;
  drilldowns['assignment-draft'] = drafts;
  drilldowns['assignment-published'] = published;
  subjects.forEach(function(item) {
    const key = 'subject:' + item.subject;
    drilldowns[key] = item.ids;
    drilldownLabels[key] = item.subject + ' students';
  });
  departments.forEach(function(item) {
    const studentKey = 'department:' + item.department;
    const proposalKey = 'department-proposals:' + item.department;
    drilldowns[studentKey] = item.ids;
    drilldowns[proposalKey] = item.proposals;
    drilldownLabels[studentKey] = item.department + ' students';
    drilldownLabels[proposalKey] = item.department + ' proposals awaiting coordinator review';
  });

  return {
    subjects: subjects,
    departments: departments,
    drilldowns: drilldowns,
    drilldownLabels: drilldownLabels,
    subject: { selected: hasSubject.length, needed: needsSubject.length },
    proposal: { needsProposal: needsProposal.length, awaitingApproval: awaitingApproval.length, stale: staleProposal.length },
    assignment: { drafts: drafts.length, published: published.length },
  };
}

function allocationOverviewDrillButton(key, label, count) {
  return `<button type="button" class="alloc-overview-count" data-alloc-overview-drill="${escapeHtml(key)}" ${count ? '' : 'disabled'}>${escapeHtml(label)} <strong>${count}</strong></button>`;
}

export function allocationCoordinatorOverviewMarkup(desk) {
  const overview = allocationCoordinatorOverview(desk);
  const sortColumn = state.allocationWorkflowSortColumn || 'subject';
  const sortDirection = state.allocationWorkflowSortDirection === -1 ? -1 : 1;
  const sortedSubjects = overview.subjects.slice().sort(function(left, right) {
    const sortValue = function(item) {
      if (sortColumn === 'subject') return item.subject.toLowerCase();
      if (sortColumn === 'pool') return item.poolIds.length;
      if (sortColumn === 'undrafted') return item.undraftedIds.length;
      if (sortColumn === 'drafted') return item.draftedIds.length;
      return Number(item[sortColumn]) || 0;
    };
    const leftValue = sortValue(left);
    const rightValue = sortValue(right);
    const comparison = sortColumn === 'subject' ? leftValue.localeCompare(rightValue) : leftValue - rightValue;
    return comparison * sortDirection;
  });
  const headers = [['subject', 'Subject'], ['pool', 'Pool (1)'], ['total', 'TTL'], ['undrafted', 'Undrafted (1)'], ['drafted', 'Drafted'], ['allocated', 'Alloc'], ['remaining', 'Remain']];
  const headerMarkup = headers.map(function(column) {
    const active = sortColumn === column[0];
    const arrow = active ? (sortDirection === 1 ? ' ▲' : ' ▼') : '';
    return `<th scope="col" aria-sort="${active ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-alloc-workflow-sort="${column[0]}">${column[1]}${arrow}</button></th>`;
  }).join('');
  const subjectRows = sortedSubjects.map(function(item) {
    const subjectName = `<button type="button" class="alloc-workflow-subject" data-alloc-workflow-filter="subject-pool" data-alloc-workflow-subject="${escapeHtml(item.subject)}">${subjectLabelHtml(item.subject, shortNameFor(item.subject, desk))}</button>`;
    const pool = `<div class="alloc-metric-pair">${allocationWorkflowCountButton('subject-pool', item.subject, item.poolIds.length, 'Pool')}<span>(</span>${allocationWorkflowCountButton('subject-choice1', item.subject, item.poolChoice1Ids.length, 'Choice 1')}<span>)</span></div>`;
    const undrafted = `<div class="alloc-metric-pair">${allocationWorkflowCountButton('subject-undrafted', item.subject, item.undraftedIds.length, 'Undrafted')}<span>(</span>${allocationWorkflowCountButton('subject-undrafted-choice1', item.subject, item.undraftedChoice1Ids.length, 'Undrafted Choice 1')}<span>)</span></div>`;
    const total = allocationWorkflowCountButton('subject-pool', item.subject, item.total, 'TTL');
    const drafted = allocationWorkflowCountButton('subject-drafted', item.subject, item.draftedIds.length, 'Drafted');
    const allocated = allocationWorkflowCountButton('subject-allocated', item.subject, item.allocated, 'Alloc');
    const remaining = item.remaining < 0 ? `<span class="alloc-capacity-warn">${item.remaining}</span>` : String(item.remaining);
    return `<tr><th scope="row">${subjectName}</th><td>${pool}</td><td>${total}</td><td>${undrafted}</td><td>${drafted}</td><td>${allocated}</td><td>${remaining}${allocationMeterMarkup(item.allocated, item.total)}</td></tr>`;
  }).join('');
  const selectedSummary = allocationOverviewDrillButton('subject-selected', 'Subject Drafted', overview.subject.selected)
    + allocationOverviewDrillButton('subject-needed', 'Need a Subject', overview.subject.needed);
  const assignmentSummary = allocationOverviewDrillButton('assignment-draft', 'Draft assignments', overview.assignment.drafts)
    + allocationOverviewDrillButton('assignment-published', 'Published', overview.assignment.published);
  return `<div class="alloc-workflow-overview">
    <section class="alloc-workflow-phase"><h3>2. Subject Allocation summary</h3><div class="alloc-overview-counts">${selectedSummary}</div><p class="muted">Pool counts students choosing the subject as Choice 1 or Choice 2, regardless of drafting. Duplicate choices count once. Undrafted is the subset with no Subject Drafted.</p><div class="table-wrap alloc-workflow-table-wrap"><table class="alloc-workflow-table"><thead><tr>${headerMarkup}</tr></thead><tbody>${subjectRows || '<tr><td class="empty" colspan="7">No subjects available.</td></tr>'}</tbody></table></div></section>
    <section class="alloc-workflow-phase"><h3>3. Coordinator assignment</h3><div class="alloc-overview-counts">${assignmentSummary}</div><p class="muted">Draft assignments are ready to review and publish. Published allocations are live.</p></section>
  </div>`;
}

function allocationHodOverviewMarkup(desk) {
  const overview = allocationCoordinatorOverview(desk);
  const departmentRows = overview.departments.length
    ? overview.departments.map(function(item) {
      const status = item.submitted ? 'HOD submitted' : 'HOD pending';
      return `<li><div class="alloc-overview-department"><div class="alloc-overview-department-heading"><strong>${escapeHtml(item.department)}</strong><span>${status}</span></div><div class="alloc-hod-actions">${allocationOverviewDrillButton('department:' + item.department, 'View students', item.ids.length)}${allocationOverviewDrillButton('department-proposals:' + item.department, 'Proposals to review', item.proposals.length)}</div></div></li>`;
    }).join('')
    : '<li class="muted">No department assignments available.</li>';
  const proposalSummary = allocationOverviewDrillButton('proposal-needed', 'Need an HOD proposal', overview.proposal.needsProposal)
    + allocationOverviewDrillButton('proposal-review', 'Awaiting coordinator review', overview.proposal.awaitingApproval)
    + allocationOverviewDrillButton('proposal-stale', 'Proposal subject changed', overview.proposal.stale);
  return `<div class="alloc-workflow-overview"><section class="alloc-workflow-phase"><h3>HOD Proposals</h3><div class="alloc-overview-counts">${proposalSummary}</div><h4>Department status</h4><ul>${departmentRows}</ul><p class="muted">Proposals are advisory and do not reserve token capacity.</p></section></div>`;
}

function allocationWorkflowCountButton(type, subject, count, label) {
  return `<button type="button" class="alloc-workflow-count" data-alloc-workflow-filter="${type}" data-alloc-workflow-subject="${escapeHtml(subject)}" aria-label="${escapeHtml(label + ' for ' + subject + ': ' + count)}">${count}</button>`;
}

function hodLoadBody(desk, view) {
  const overview = hodOverviewFor(desk);
  if (view === 'assigned') return hodAssignedMarkup(overview);
  if (view === 'supervisor') return hodSupervisorMarkup(overview);
  return hodSubjectMarkup(overview);
}

function hodOverviewFor(desk) {
  const department = viewedHodDepartment(desk);
  const catalogue = subjectCatalogue(desk).map(function(subject) {
    return { name: subject.name, department: subject.department || '' };
  });
  return hodSuggestionOverview({
    department: department,
    catalogue: catalogue,
    tokens: ((desk && desk.tokenRows) || []).map(function(token) {
      return {
        staffId: token.staffId,
        status: token.status,
        eligibleSubjects: token.eligibleSubjects,
        allocatedTo: token.studentId,
      };
    }),
    students: ((desk && desk.students) || []).map(function(student) {
      return {
        studentId: student.studentId,
        displayName: student.displayName,
        suggestedStaffId: student.suggestedStaffId,
        suggestedSubject: student.suggestedSubject,
        tokenStaffId: student.token ? student.token.staffId : '',
      };
    }),
    staff: ((desk && desk.directory) || (desk && desk.supervisors) || []).map(function(person) {
      return { staffId: person.email || person.staffId, displayName: person.displayName };
    }),
  });
}

function hodSubjectMarkup(overview) {
  const subjects = overview.subjects || [];
  if (!subjects.length) return '<div class="empty">No subjects in this department.</div>';
  const blocks = subjects.map(function(item) {
    const taken = Number(item.taken) || 0;
    const remaining = Number(item.remaining) || 0;
    return `<div class="alloc-subject-block"><p class="alloc-subject-name">${escapeHtml(item.subject)}</p><span>Suggested taken ${taken}</span><span>Rem ${remaining}</span>${allocationMeterMarkup(taken, taken + remaining)}</div>`;
  }).join('');
  return `<div class="alloc-subject-load">${blocks}</div>`;
}

function hodSupervisorMarkup(overview) {
  const people = overview.supervisors || [];
  if (!people.length) return '<div class="empty">No supervisors in this department.</div>';
  return people.map(function(person) {
    const key = String(person.staffId || '').toLowerCase();
    const open = state.allocationAssignedOpen[key] === true;
    const students = (person.students || []).map(function(student) {
      return `<li>${escapeHtml(student.displayName)} · ${escapeHtml(student.subject)}</li>`;
    }).join('');
    return `<div class="alloc-load"><button type="button" data-alloc-assigned="${escapeHtml(person.staffId)}" aria-expanded="${open ? 'true' : 'false'}"><strong>${escapeHtml(person.displayName)}</strong> <span class="muted">${person.taken} suggested · ${person.remaining} suggestable</span></button>${allocationMeterMarkup(person.taken, person.total)}${open ? `<ul>${students || '<li class="muted">No suggested students</li>'}<li class="muted">${person.remaining} suggestable slots left</li></ul>` : ''}</div>`;
  }).join('');
}

function hodAssignedMarkup(overview) {
  const groups = overview.groups || [];
  if (!groups.length) return '<div class="empty">No suggestions in this department.</div>';
  return groups.map(function(group) {
    const key = group.subject.toLowerCase();
    const open = state.allocationAssignedOpen[key] === true;
    const taken = (group.taken || []).map(function(row) {
      return `<li class="alloc-token-taken"><strong>${escapeHtml(row.staffName)}</strong> · ${escapeHtml(row.studentName)}</li>`;
    }).join('');
    const available = (group.available || []).map(function(row) {
      return `<li class="alloc-token-open"><strong>${escapeHtml(row.staffName)}</strong> · ${row.slots} suggestable</li>`;
    }).join('');
    const takenCount = (group.taken || []).length;
    const availableCount = (group.available || []).reduce(function(sum, row) { return sum + (Number(row.slots) || 0); }, 0);
    return `<div class="alloc-assigned"><button type="button" data-alloc-assigned="${escapeHtml(group.subject)}" aria-expanded="${open ? 'true' : 'false'}"><span>${escapeHtml(group.subject)}</span><span class="muted">Suggested taken ${takenCount} · Suggested available ${availableCount}</span></button>${allocationMeterMarkup(takenCount, takenCount + availableCount)}${open ? `<ul>${taken}${available}</ul>` : ''}</div>`;
  }).join('');
}

export function allocationDemand(desk) {
  return ((desk && desk.students) || []).map(function(student) {
    return {
      subjects: [],
      selectedSubject: student.selectedSubject || '',
      primary: student.choices ? student.choices.primary : '',
      allocated: !!student.token,
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

function callerEmail() {
  return String((state.user && (state.user.email || state.user.Email)) || '').trim().toLowerCase();
}

function callerDepartment(desk) {
  const email = callerEmail();
  const person = ((desk && desk.directory) || []).find(function(item) {
    return String(item.email || '').toLowerCase() === email;
  });
  return person ? String(person.department || '').trim() : '';
}

export function hodDepartmentNames(desk) {
  const seen = new Map();
  subjectCatalogue(desk).forEach(function(subject) {
    const department = String(subject.department || '').trim();
    const key = department.toLowerCase();
    if (!department || seen.has(key)) return;
    seen.set(key, department);
  });
  return Array.from(seen.values()).sort(function(left, right) {
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  });
}

function catalogueForDepartment(desk) {
  return subjectCatalogue(desk).map(function(subject) {
    return { name: subject.name, department: subject.department || '' };
  });
}

function viewedHodDepartment(desk) {
  const departments = hodDepartmentNames(desk);
  const current = state.allocationHodDepartment || '';
  const currentMatch = departments.find(function(name) { return departmentsMatch(name, current); });
  if (currentMatch) return currentMatch;
  if (pureHodUser()) {
    const own = departments.find(function(name) { return departmentsMatch(name, callerDepartment(desk)); });
    if (own) return own;
  }
  return departments[0] || '';
}

function departmentStatus(department) {
  const record = state.allocationHodStatus && state.allocationHodStatus.byDepartment;
  if (!record) return null;
  const key = Object.keys(record).find(function(id) {
    const row = record[id] || {};
    return departmentsMatch(row.department, department) || id === String(department || '').trim().toLowerCase();
  });
  return key ? record[key] : null;
}

function hodCanSuggest(desk, department) {
  if (!allocationPermissions().isHOD) return false;
  if (!departmentsMatch(callerDepartment(desk), department)) return false;
  const status = departmentStatus(department);
  return !(status && status.submitted);
}

function hodNamesFor(desk, department) {
  const names = ((desk && desk.directory) || []).filter(function(person) {
    return person.isHOD && departmentsMatch(person.department, department);
  }).map(function(person) { return person.displayName || person.email; });
  return names.length ? names.join(', ') : 'No HOD';
}

export function allocationHodStatusMarkup(desk) {
  const departments = hodDepartmentNames(desk);
  const rows = departments.map(function(department) {
    const status = departmentStatus(department);
    const submitted = !!(status && status.submitted);
    const when = submitted && status.submittedAt ? allocationWhen(status.submittedAt) : '';
    const by = submitted && status.submittedBy ? status.submittedBy : '';
    const own = departmentsMatch(callerDepartment(desk), department);
    const canReopen = submitted && (allocationPermissions().canAdmin || (allocationPermissions().isHOD && own));
    const reopen = canReopen ? `<button type="button" class="button secondary" data-alloc-hod-reopen="${escapeHtml(department)}">Reopen</button>` : '';
    return `<div class="alloc-hod-status-row"><strong>${escapeHtml(department)}</strong><span>${escapeHtml(hodNamesFor(desk, department))}</span><span>${submitted ? 'Submitted' : 'Pending'}</span>${when ? `<span class="muted">${escapeHtml(when)}</span>` : ''}${by ? `<span class="muted">${escapeHtml(by)}</span>` : ''}${reopen}</div>`;
  }).join('');
  const blank = subjectCatalogue(desk).filter(function(subject) { return !String(subject.department || '').trim(); });
  const warning = blank.length ? '<p class="notice alloc-hod-warn">Subjects with no department</p>' : '';
  const body = `<section class="alloc-hod-status" aria-label="Department submission status">${rows || '<p class="muted">No departments yet.</p>'}${warning}</section>`;
  return allocationSection('alloc-hod-status', 'HOD listing', body, { open: false });
}

function hodStudents(desk, department) {
  const catalogue = catalogueForDepartment(desk);
  return ((desk && desk.students) || []).filter(function(student) {
    return departmentsMatch(departmentOfSubject(student.selectedSubject, catalogue), department);
  });
}

function hodSuggestOptions(student, desk) {
  const subject = student.selectedSubject || '';
  const suggestions = ((desk && desk.students) || []).map(function(item) {
    return { studentId: item.studentId, suggestedStaffId: item.suggestedStaffId || '', suggestedSubject: item.suggestedSubject || '' };
  });
  const tokens = ((desk && desk.tokenRows) || []).map(function(token) {
    return { staffId: token.staffId, status: token.status, eligibleSubjects: token.eligibleSubjects, allocatedTo: token.studentId };
  });
  const people = ((desk && desk.supervisors) || []).filter(function(person) {
    return subjectsOverlap(subject, person.eligibleSubjects || []);
  }).slice().sort(function(left, right) {
    return String(left.displayName || '').localeCompare(String(right.displayName || ''), undefined, { sensitivity: 'base' });
  });
  return people.map(function(person) {
    const capacity = suggestionCapacity({
      staffId: person.staffId,
      subject: subject,
      tokens: tokens,
      suggestions: suggestions,
    });
    const selected = String(person.staffId).toLowerCase() === String(student.suggestedStaffId || '').toLowerCase();
    const disabled = !selected && (!capacity.eligible || capacity.remaining <= 0);
    const label = (person.displayName || person.staffId) + ' (' + capacity.held + '/' + capacity.open + ')';
    return `<option value="${escapeHtml(person.staffId)}"${disabled ? ' disabled' : ''}${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

export function allocationHodRowMarkup(student, desk, enabled) {
  const locked = allocationIsPublished(student) || !enabled;
  const options = hodSuggestOptions(student, desk);
  const assigned = allocationAssignedSupervisorName(student, (desk && desk.supervisors) || []);
  const assignedLine = assigned ? `<div class="muted">Assigned: ${escapeHtml(assigned)}</div>` : '';
  const open = state.allocationOpenStudent === student.studentId;
  const name = `<button type="button" class="link-button alloc-student-name" data-alloc-expand="${escapeHtml(student.studentId)}" aria-expanded="${open ? 'true' : 'false'}">${escapeHtml(student.displayName || student.studentId)}</button>`;
  return `<tr class="${locked ? 'alloc-hod-lock' : ''}"><td>${name}</td><td>${escapeHtml(student.selectedSubject || '')}</td><td><select data-alloc-suggest="${escapeHtml(student.studentId)}" aria-label="Suggested teacher for ${escapeHtml(student.displayName || student.studentId)}"${locked ? ' disabled' : ''}><option value="">No suggestion</option>${options}</select>${assignedLine}</td></tr>${open ? allocationExpandedMarkup(student, 3) : ''}`;
}

export function allocationHodMarkup(desk) {
  const department = viewedHodDepartment(desk);
  state.allocationHodDepartment = department;
  const departments = hodDepartmentNames(desk);
  const options = departments.map(function(name) {
    return `<option value="${escapeHtml(name)}"${departmentsMatch(name, department) ? ' selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('');
  const editable = hodCanSuggest(desk, department);
  const status = departmentStatus(department);
  const submitted = !!(status && status.submitted);
  const own = departmentsMatch(callerDepartment(desk), department);
  const students = sortedRows('alloc-hod', hodStudents(desk, department), function(student, key) {
    if (key === 'subject') return String(student.selectedSubject || '').toLowerCase();
    if (key === 'teacher') return String(student.suggestedStaffName || student.suggestedStaffId || '').toLowerCase();
    return String(student.displayName || '').toLowerCase();
  });
  const certify = editable ? '<button type="button" class="button" id="alloc-hod-certify">Certify & Submit Suggestions</button>' : '';
  const reopen = submitted && (allocationPermissions().canAdmin || (allocationPermissions().isHOD && own))
    ? `<button type="button" class="button secondary" data-alloc-hod-reopen="${escapeHtml(department)}">Reopen suggestions</button>`
    : '';
  const body = students.length
    ? students.map(function(student) { return allocationHodRowMarkup(student, desk, editable && !allocationIsPublished(student)); }).join('')
    : '<tr><td class="empty" colspan="3">No students with a selected subject in this department.</td></tr>';
  return `<div class="alloc-layout"><div>
      ${allocationHodStatusMarkup(desk)}
      <div class="alloc-filters"><label for="alloc-hod-department">Department</label><select id="alloc-hod-department">${options}</select>${certify}${reopen}</div>
      <div class="table-wrap"><table class="alloc-desk"><thead><tr>${sortableHeader('alloc-hod', 'name', 'Student')}${sortableHeader('alloc-hod', 'subject', 'Selected subject')}${sortableHeader('alloc-hod', 'teacher', 'Suggested teacher')}</tr></thead><tbody>${body}</tbody></table></div>
    </div></div>${allocationDrawerMarkup(desk, (desk && desk.supervisors) || [])}`;
}

export function allocationDrawerMarkup(desk, supervisors) {
  const open = state.allocationDrawerOpen === true;
  return `<aside id="alloc-drawer" class="alloc-drawer${open ? ' open' : ''}" aria-label="Token Overview">
    <button type="button" class="alloc-drawer-peek" id="alloc-drawer-peek" aria-expanded="${open ? 'true' : 'false'}" aria-controls="alloc-drawer-panel">Token Overview</button>
    <div class="alloc-drawer-panel" id="alloc-drawer-panel"${open ? '' : ' inert'} aria-hidden="${open ? 'false' : 'true'}">
      <div class="alloc-drawer-bar"><strong>Token Overview</strong><button type="button" id="alloc-drawer-close">Close</button></div>
      <div class="alloc-drawer-scroll">${allocationLoadPanel(desk, supervisors)}</div>
    </div>
  </aside>`;
}

export function allocationSettingsMarkup(desk) {
  const settings = desk.settings || {};
  const summary = desk.summary || { staffCount: 0, tokenCount: 0, activeStudents: 0, buffer: 0 };
  const buffer = summary.buffer >= 0
    ? 'Capacity is sufficient. You have +' + summary.buffer + ' buffer tokens.'
    : 'Short by ' + (-summary.buffer) + ' tokens.';
  const dynamicColumns = settings.detectedDynamicKeys || [];
  const columns = dashboardFieldKeys(settings);
  const flags = {};
  (settings.columns || []).forEach(function(column) { flags[column.key] = column; });
  const kind = allocationIngestKind();
  const flagLabels = [['showOnCard', 'Show in table'], ['filterable', 'Filterable'], ['sortable', 'Sortable'], ['colorScale', 'Color scale'], ['expanded', 'Expanded']];
  const collapsed = { open: false };
  return `<p class="muted">Showing student data for the cohort selected in the header.</p>
    ${allocationSection('alloc-sync', 'Google Sheets sync', `<section class="alloc-panel">
        ${desk.driveReady ? '' : `<p class="notice">${escapeHtml(desk.driveError || 'Connect Google in Admin → Google account before ingesting sheets.')}</p>`}
        <p class="doc-hint">Choose workspace, allocation drafts, or tokens, export a workbook if you need one, paste the link, then preview. Workspace ingest reads <code>COHORTDATA: ${escapeHtml(state.cohortId)}</code> and upserts by StudentId. Allocation draft ingest reads <code>ALLOCATIONS: ${escapeHtml(state.cohortId)}</code> and restores the selected subject, the suggested teacher, and draft tokens. Token ingest reads <code>SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</code> and tops up quotas. None of these deletes rows that are missing from the sheet. When a live choice sheet is linked, a workspace ingest keeps the live choice values and live dashboard columns, and still updates the other auxiliary columns.</p>
        <div class="sheet-choices" role="radiogroup" aria-label="Ingest kind">
          <label class="check-option"><input type="radio" name="alloc-ingest-kind" value="workspace" ${kind === 'workspace' ? 'checked' : ''}><span>Workspace data <span class="muted">COHORTDATA: ${escapeHtml(state.cohortId)}</span></span></label>
          <label class="check-option"><input type="radio" name="alloc-ingest-kind" value="drafts" ${kind === 'drafts' ? 'checked' : ''}><span>Allocation drafts <span class="muted">ALLOCATIONS: ${escapeHtml(state.cohortId)}</span></span></label>
          <label class="check-option"><input type="radio" name="alloc-ingest-kind" value="tokens" ${kind === 'tokens' ? 'checked' : ''}><span>Supervisor tokens <span class="muted">SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</span></span></label>
        </div>
        <div class="toolbar">
          <button type="button" class="button secondary" id="alloc-export">Export allocation drafts</button>
          <button type="button" class="button secondary" id="alloc-export-tokens">Export token sheet</button>
          <button type="button" class="button secondary" id="alloc-open-quotas">Open EE quotas</button>
        </div>
        <p class="muted">Export allocation drafts writes an <code>ALLOCATIONS: ${escapeHtml(state.cohortId)}</code> tab with the drafted or published supervisor, Selected Subject, suggested teacher, SelectedInterdisciplinary, and InterdisciplinarySubject. Paste that spreadsheet back, choose Allocation drafts, and ingest to restore those fields. If either interdisciplinary column is present, blank cells clear that workspace value; older sheets without those columns leave it unchanged. Published tokens are not changed. Export token sheet writes <code>SUPERVISORTOKENS: ${escapeHtml(state.cohortId)}</code> from the EE quotas already saved on staff. Set those quotas before exporting tokens.</p>
        <p id="alloc-export-result" class="muted">${settings.lastExport ? 'Last draft export: ' + escapeHtml(allocationWhen(settings.lastExport)) : 'Drafts not exported yet'}${settings.lastWorkspaceSync ? ' · Workspace: ' + escapeHtml(allocationWhen(settings.lastWorkspaceSync)) : ''}${settings.lastTokenSync ? ' · Tokens: ' + escapeHtml(allocationWhen(settings.lastTokenSync)) : ''}</p>
        <div class="toolbar"><button type="button" class="button secondary" id="alloc-backfill-preview">Preview draft backfill</button></div>
        <p class="muted">Backfill fills an empty Selected Subject from each student's drafted token and copies that teacher into an empty suggestion. Published tokens, and any selected subject or suggestion already stored, stay as they are.</p>
        <label class="check-option"><input type="checkbox" id="alloc-backfill-confirm"><span>Apply this backfill to the current cohort.</span></label>
        <div class="toolbar"><button class="button" id="alloc-backfill-apply" type="button" disabled>Apply draft backfill</button></div>
        <div id="alloc-backfill-result"></div>
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
        <div class="alloc-map"><label for="alloc-hl">HL match column</label><select id="alloc-hl">${allocationKeyOptions(dynamicColumns, settings.hlColumn, true)}</select></div>
        <div class="alloc-map"><label for="alloc-flag">Support flag column</label><select id="alloc-flag">${allocationKeyOptions(dynamicColumns, settings.supportColumn, true)}</select></div>
        <div class="toolbar"><button type="button" class="button" id="alloc-save-config">Save configuration</button></div>`, collapsed)}
      ${allocationSection('alloc-fields', 'Dashboard Fields', `<p class="muted">Every detected column can be shown on the dashboard, including First Choice, Second Choice, Interdisciplinary, and the other fields mapped from the ingest. Columns that stay in sync with the live sheet are marked LIVE. New columns start visible and sortable. Color scale stays off until you turn it on. It paints numbers, and words such as Weak or Strong, from light blue to deep blue across the students in the current view. It does not use red and green. Uncheck Sortable to leave a column on the desk without a sort button. Check Expanded to show a long note in the row that opens from the student name.</p>
        ${columns.length ? `<div class="table-wrap"><table><thead><tr>${sortableHeader('alloc-columns', 'column', 'Imported column')}${flagLabels.map(function(flag) { return `<th>${escapeHtml(flag[1])}</th>`; }).join('')}</tr></thead><tbody>${sortedRows('alloc-columns', columns, function(key) { return allocationDashboardFieldLabel(key, settings); }).map(function(key) {
          const column = flags[key] || {};
          const label = allocationDashboardFieldLabel(key, settings);
          const raw = label !== key ? ` <span class="muted">${escapeHtml(key)}</span>` : '';
          const liveBadge = column.source === 'live' ? ' <span class="live-badge">LIVE</span>' : '';
          return `<tr><td><code>${escapeHtml(label)}</code>${raw}${liveBadge}</td>${flagLabels.map(function(flag) {
            return `<td><input type="checkbox" data-alloc-col="${escapeHtml(key)}" data-flag="${flag[0]}" ${column[flag[0]] ? 'checked' : ''} aria-label="${escapeHtml(flag[1] + ' ' + label)}"></td>`;
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
    state.allocationSubjectPicker = {};
    resetAllocationFilters();
    state.tokenEditId = '';
    loadAllocation();
  });
  const statusFilter = document.getElementById('alloc-status');
  if (statusFilter) statusFilter.addEventListener('change', function() {
    ensureFilterDraft().status = statusFilter.value || 'all';
    applyAllocationFilters();
  });
  const needSupportFilter = document.getElementById('alloc-need-support');
  if (needSupportFilter) needSupportFilter.addEventListener('change', function() {
    ensureFilterDraft().needSupport = needSupportFilter.value === 'yes' ? 'yes' : 'all';
    applyAllocationFilters();
  });
  const flaggedFilter = document.getElementById('alloc-flagged-filter');
  if (flaggedFilter) flaggedFilter.addEventListener('change', function() {
    ensureFilterDraft().flagged = flaggedFilter.value === 'yes' ? 'yes' : 'all';
    applyAllocationFilters();
  });
  target.querySelectorAll('[data-alloc-drawer-sort]').forEach(function(button) {
    button.addEventListener('click', function() {
      const column = button.getAttribute('data-alloc-drawer-sort') || 'subject';
      if (state.allocationDrawerSortColumn === column) {
        state.allocationDrawerSortDirection = state.allocationDrawerSortDirection === -1 ? 1 : -1;
      } else {
        state.allocationDrawerSortColumn = column;
        state.allocationDrawerSortDirection = 1;
      }
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-workflow-sort]').forEach(function(button) {
    button.addEventListener('click', function() {
      const column = button.getAttribute('data-alloc-workflow-sort') || 'subject';
      if (state.allocationWorkflowSortColumn === column) {
        state.allocationWorkflowSortDirection = state.allocationWorkflowSortDirection === -1 ? 1 : -1;
      } else {
        state.allocationWorkflowSortColumn = column;
        state.allocationWorkflowSortDirection = 1;
      }
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-workflow-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.allocationWorkflowFilter = {
        type: button.getAttribute('data-alloc-workflow-filter') || '',
        subject: button.getAttribute('data-alloc-workflow-subject') || '',
      };
      state.allocationOverviewDrilldown = null;
      state.allocationDrawerOpen = true;
      applyAllocationFilters();
    });
  });
  const clearWorkflowFilter = target.querySelector('[data-alloc-workflow-filter-clear]');
  if (clearWorkflowFilter) clearWorkflowFilter.addEventListener('click', function() {
    state.allocationWorkflowFilter = null;
    applyAllocationFilters();
  });
  target.querySelectorAll('[data-alloc-subject-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      const draft = ensureFilterDraft();
      draft.subject = toggleNameFilter(draft.subject, button.getAttribute('data-alloc-subject-filter') || '');
      applyAllocationFilters();
    });
  });
  target.querySelectorAll('[data-alloc-inter-subject]').forEach(function(select) {
    select.addEventListener('change', function() {
      const studentId = select.getAttribute('data-alloc-inter-subject');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (allocationIsPublished(student)) {
        showError(new Error('This allocation is published. Unpublish it before changing the token.'));
        paintAllocation();
        return;
      }
      state.allocationInterdisciplinarySubject[studentId] = select.value;
      if (student && student.token && allocationInterdisciplinaryOn(student)) {
        const subject = student.selectedSubject || '';
        if (!subject) {
          showError(new Error('Choose a subject before assigning a teacher.'));
          paintAllocation();
          return;
        }
        saveAllocationDraft(studentId, student.token.staffId, subject, true, 'Interdisciplinary subject saved.');
      }
    });
  });
  target.querySelectorAll('[data-alloc-selected-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      const draft = ensureFilterDraft();
      draft.selected = toggleNameFilter(draft.selected, button.getAttribute('data-alloc-selected-filter') || '');
      applyAllocationFilters();
    });
  });
  target.querySelectorAll('[data-alloc-teacher-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      const draft = ensureFilterDraft();
      const value = button.getAttribute('data-alloc-teacher-filter') || '';
      if (!value) draft.teacher = [];
      else {
        const current = (draft.teacher || []).slice();
        const index = current.indexOf(value);
        if (index >= 0) current.splice(index, 1);
        else current.push(value);
        draft.teacher = current;
      }
      applyAllocationFilters();
    });
  });
  target.querySelectorAll('[data-alloc-flag-filter]').forEach(function(button) {
    button.addEventListener('click', function() {
      const draft = ensureFilterDraft();
      draft.supportFlags = toggleNameFilter(draft.supportFlags, button.getAttribute('data-alloc-flag-filter') || '');
      applyAllocationFilters();
    });
  });
  target.querySelectorAll('[data-alloc-custom-value]').forEach(function(button) {
    button.addEventListener('mousedown', function(event) { event.preventDefault(); });
  });
  target.querySelectorAll('[data-alloc-custom-query]').forEach(function(input) {
    input.addEventListener('focus', function() {
      const key = input.getAttribute('data-alloc-custom-query');
      if (state.allocationCustomOpen === key) return;
      state.allocationCustomOpen = key;
      const caret = input.selectionStart;
      paintAllocation();
      refocusAllocationControl('data-alloc-custom-query', key, caret);
    });
    input.addEventListener('input', function() {
      const key = input.getAttribute('data-alloc-custom-query');
      const caret = input.selectionStart;
      state.allocationCustomOpen = key;
      state.allocationCustomQueries = Object.assign({}, state.allocationCustomQueries || {}, { [key]: input.value });
      paintAllocation();
      refocusAllocationControl('data-alloc-custom-query', key, caret);
    });
    input.addEventListener('blur', function() {
      const key = input.getAttribute('data-alloc-custom-query');
      window.setTimeout(function() {
        const active = document.activeElement;
        const inside = active && active.getAttribute && (active.getAttribute('data-alloc-custom-query') === key || active.getAttribute('data-alloc-custom-filter') === key);
        if (inside || state.allocationCustomOpen !== key) return;
        state.allocationCustomOpen = '';
        paintAllocation();
      }, 0);
    });
  });
  target.querySelectorAll('[data-alloc-custom-value]').forEach(function(button) {
    button.addEventListener('click', function() {
      const key = button.getAttribute('data-alloc-custom-filter');
      const value = button.getAttribute('data-alloc-custom-value') || '';
      const draft = ensureFilterDraft();
      const filters = Object.assign({}, draft.custom || {});
      const current = allocationCustomSelections(filters, key);
      const index = current.indexOf(value);
      const next = current.slice();
      if (index >= 0) next.splice(index, 1);
      else next.push(value);
      if (next.length) filters[key] = next;
      else delete filters[key];
      draft.custom = filters;
      state.allocationCustomOpen = key;
      applyAllocationFilters();
      refocusAllocationControl('data-alloc-custom-query', key, null);
    });
  });
  const studentSearch = document.getElementById('alloc-student-search');
  if (studentSearch) studentSearch.addEventListener('input', function() {
    const caret = studentSearch.selectionStart;
    state.allocationQuery = studentSearch.value;
    applyAllocationFilters();
    refocusAllocationControl('id', 'alloc-student-search', caret);
  });
  const clearFilters = document.getElementById('alloc-clear-filters');
  if (clearFilters) clearFilters.addEventListener('click', function() {
    resetAllocationFilters();
    paintAllocation();
  });
  const returnOverview = document.getElementById('alloc-overview-return');
  if (returnOverview) returnOverview.addEventListener('click', function() {
    state.allocationOverviewDrilldown = null;
    state.allocationDrawerOpen = true;
    paintAllocation();
  });
  target.querySelectorAll('[data-alloc-overview-drill]').forEach(function(button) {
    button.addEventListener('click', function() {
      const key = button.getAttribute('data-alloc-overview-drill') || '';
      const filter = allocationOverviewFilterFromKey(key);
      if (!filter) return;
      state.allocationWorkflowFilter = filter;
      state.allocationOverviewDrilldown = null;
      state.allocationDrawerOpen = true;
      applyAllocationFilters();
    });
  });
  const drawerPeek = document.getElementById('alloc-drawer-peek');
  if (drawerPeek) drawerPeek.addEventListener('click', function() {
    state.allocationDrawerOpen = true;
    paintAllocation();
    if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
      const close = document.getElementById('alloc-drawer-close');
      if (close) close.focus();
    }
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
      const next = raw === 'supervisor' || raw === 'assigned' || raw === 'subject' || raw === 'overview' || raw === 'hod-overview'
        ? raw
        : 'overview';
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
  const approveBatch = document.getElementById('alloc-batch-approve');
  if (approveBatch) approveBatch.addEventListener('click', approveSuggestedBatch);
  const batchSubject = document.getElementById('alloc-batch-apply-subject');
  if (batchSubject) batchSubject.addEventListener('click', function() {
    const select = document.getElementById('alloc-batch-subject');
    if (select) applyAllocationSubjectBatch(select.value);
  });
  const hodDepartment = document.getElementById('alloc-hod-department');
  if (hodDepartment) hodDepartment.addEventListener('change', function() {
    state.allocationHodDepartment = hodDepartment.value;
    paintAllocation();
  });
  const certify = document.getElementById('alloc-hod-certify');
  if (certify) certify.addEventListener('click', function() {
    certify.disabled = true;
    callServer('certifyHodSuggestions', state.cohortId).then(function() {
      showSuccess('Suggestions submitted.');
      if (state.allocationListenFallback) loadAllocation();
      else paintAllocation();
    }).catch(function(error) {
      certify.disabled = false;
      showError(error);
    });
  });
  target.querySelectorAll('[data-alloc-hod-reopen]').forEach(function(button) {
    button.addEventListener('click', function() {
      const department = button.getAttribute('data-alloc-hod-reopen') || '';
      button.disabled = true;
      callServer('reopenHodSuggestions', state.cohortId, department).then(function() {
        showSuccess('Suggestions reopened.');
        if (state.allocationListenFallback) loadAllocation();
        else paintAllocation();
      }).catch(function(error) {
        button.disabled = false;
        showError(error);
      });
    });
  });
  target.querySelectorAll('[data-alloc-suggest]').forEach(function(select) {
    select.addEventListener('change', function() {
      const studentId = select.getAttribute('data-alloc-suggest');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (!student) return;
      if (select.options[select.selectedIndex] && select.options[select.selectedIndex].disabled) {
        paintAllocation();
        return;
      }
      queueSuggestion(student, select.value);
    });
  });
  const publicationAction = document.getElementById('alloc-batch-publication-action');
  const publicationButton = document.getElementById('alloc-batch-publication');
  if (publicationAction && publicationButton) {
    publicationAction.addEventListener('change', function() {
      publicationButton.textContent = publicationAction.value === 'unpublish' ? 'Unpublish' : 'Publish';
    });
    publicationButton.addEventListener('click', function() {
      if (publicationAction.value === 'unpublish') unpublishSelectedAllocations();
      else publishSelectedAllocations();
    });
  }
  target.querySelectorAll('[data-alloc-subject]').forEach(function(box) {
    box.addEventListener('click', function() {
      if (box.disabled) return;
      const studentId = box.getAttribute('data-alloc-subject');
      const subject = box.getAttribute('data-subject') || '';
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (!student || !subject || allocationSubjectLocked(student)) return;
      const current = student.selectedSubject || '';
      const hasLinkedAssignment = !!(student.token || student.suggestedStaffId || student.suggestedSubject);
      if (hasLinkedAssignment && !window.confirm('This student has a suggested teacher or assigned token. Changing or clearing the subject will clear the suggestion and free the token. Continue?')) return;
      selectAllocationSubject(student, sameSubjectName(current, subject) ? '' : subject, hasLinkedAssignment);
    });
  });
  target.querySelectorAll('[data-alloc-subject-add]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-subject-add');
      if (!state.allocationSubjectPicker) state.allocationSubjectPicker = {};
      if (state.allocationSubjectPicker[studentId]) delete state.allocationSubjectPicker[studentId];
      else state.allocationSubjectPicker[studentId] = true;
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-extra-subject]').forEach(function(select) {
    select.addEventListener('change', function() {
      const studentId = select.getAttribute('data-alloc-extra-subject');
      const subject = select.value;
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (!student || !subject || sameSubjectName(student.selectedSubject, subject)) {
        paintAllocation();
        return;
      }
      const hasLinkedAssignment = !!(student.token || student.suggestedStaffId || student.suggestedSubject);
      if (hasLinkedAssignment && !window.confirm('This student has a suggested teacher or assigned token. Changing the subject will clear the suggestion and free the token. Continue?')) {
        paintAllocation();
        return;
      }
      if (state.allocationSubjectPicker) delete state.allocationSubjectPicker[studentId];
      selectAllocationSubject(student, subject, hasLinkedAssignment);
    });
  });
  target.querySelectorAll('[data-alloc-approve]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-approve');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (student) approveAllocationSuggestionRow(student);
    });
  });
  target.querySelectorAll('[data-alloc-ee-inter]').forEach(function(box) {
    box.addEventListener('change', function() {
      const studentId = box.getAttribute('data-alloc-ee-inter');
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (allocationIsPublished(student)) {
        showError(new Error('This allocation is published. Unpublish it before changing the token.'));
        paintAllocation();
        return;
      }
      const wasOn = allocationInterdisciplinaryOn(student);
      if (box.checked) {
        state.allocationInterdisciplinary[studentId] = true;
        const seededNow = !Object.prototype.hasOwnProperty.call(state.allocationInterdisciplinarySubject, studentId);
        if (seededNow) {
          const existing = student && student.interdisciplinarySubject;
          state.allocationInterdisciplinarySubject[studentId] = existing || (student && student.choices && student.choices.secondary) || '';
        }
        openAllocationInterdisciplinaryModal(student, desk, wasOn, seededNow);
        return;
      }
      delete state.allocationInterdisciplinary[studentId];
      const subject = student && student.token
        ? student.token.assignedSubject || student.selectedSubject || ''
        : (student && student.selectedSubject) || '';
      saveAllocationDraft(studentId, student && student.token ? student.token.staffId : '', subject, false, 'Interdisciplinary mark cleared.');
    });
  });
  target.querySelectorAll('[data-alloc-supervisor]').forEach(function(select) {
    select.addEventListener('change', function() {
      const studentId = select.getAttribute('data-alloc-supervisor');
      const staffId = select.value;
      const student = (desk.students || []).find(function(item) { return item.studentId === studentId; });
      if (allocationIsPublished(student)) {
        showError(new Error('This allocation is published. Unpublish it before changing the token.'));
        paintAllocation();
        return;
      }
      const option = select.options[select.selectedIndex];
      if (option && option.disabled) {
        paintAllocation();
        return;
      }
      const subject = student && student.selectedSubject ? student.selectedSubject : '';
      if (staffId && !subject) {
        showError(new Error('Choose a subject before assigning a teacher.'));
        paintAllocation();
        return;
      }
      if (staffId && !supervisorAcceptsSubject(desk, staffId, subject, student)) {
        showError(new Error(subject + ' does not match the supervisor\'s EE subjects.'));
        paintAllocation();
        return;
      }
      saveAllocationDraft(studentId, staffId, subject, allocationInterdisciplinaryOn(student), staffId ? 'Draft saved.' : 'Assigned staff cleared.');
    });
  });
  target.querySelectorAll('[data-alloc-flag-toggle]').forEach(function(button) {
    button.addEventListener('click', function() {
      const studentId = button.getAttribute('data-alloc-flag-toggle');
      if (!state.allocationFlagOpen) state.allocationFlagOpen = {};
      if (state.allocationFlagOpen[studentId]) delete state.allocationFlagOpen[studentId];
      else state.allocationFlagOpen[studentId] = true;
      paintAllocation();
    });
  });
  target.querySelectorAll('[data-alloc-undo]').forEach(function(button) {
    button.addEventListener('click', function() {
      const id = button.getAttribute('data-alloc-undo') || '';
      const count = allocationUndoCount(state.allocationAuditLogs, id);
      if (!id || !count) return;
      openAllocationUndoDialog(id, count);
    });
  });
  target.querySelectorAll('[data-alloc-flag]').forEach(function(box) {
    box.addEventListener('change', function() {
      const studentId = box.getAttribute('data-alloc-flag');
      let note = '';
      target.querySelectorAll('[data-alloc-flag-note]').forEach(function(input) {
        if (input.getAttribute('data-alloc-flag-note') === studentId) note = input.value;
      });
      queueAllocationFlag(studentId, box.checked, note, true);
    });
  });
  target.querySelectorAll('[data-alloc-flag-note]').forEach(function(input) {
    input.addEventListener('input', function() {
      const studentId = input.getAttribute('data-alloc-flag-note');
      let checked = false;
      target.querySelectorAll('[data-alloc-flag]').forEach(function(item) {
        if (item.getAttribute('data-alloc-flag') === studentId) checked = item.checked;
      });
      queueAllocationFlag(studentId, checked, input.value, false);
    });
  });
  const sheetUrl = document.getElementById('alloc-sheet-url');
  if (sheetUrl) sheetUrl.addEventListener('input', function(event) {
    state.allocationSheetUrl = event.target.value;
    clearAllocationPreview();
  });
  target.querySelectorAll('input[name="alloc-ingest-kind"]').forEach(function(input) {
    input.addEventListener('change', function() {
      state.allocationIngestKind = input.value === 'tokens' || input.value === 'drafts' ? input.value : 'workspace';
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
  const backfillPreview = document.getElementById('alloc-backfill-preview');
  if (backfillPreview) backfillPreview.addEventListener('click', previewAllocationBackfill);
  const backfillApply = document.getElementById('alloc-backfill-apply');
  if (backfillApply) backfillApply.addEventListener('click', applyAllocationBackfill);
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
    <p class="muted">These slots already belong to ${escapeHtml(board.cohortId)}. Adding tokens does not remove the ones here. A published token stays locked until it is unpublished on the allocation dashboard.</p>
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
        <td>${token.allocatedTo ? `<strong>${escapeHtml(token.studentName || token.allocatedTo)}</strong><div class="muted">${escapeHtml(token.allocatedTo)}</div>` : '—'}</td>
        <td>${escapeHtml(token.assignedSubject || '—')}</td>
        <td><div class="actions">${token.status === 'committed' ? '<span class="muted">Locked</span>' : `<button type="button" class="link-button" data-token-edit="${escapeHtml(token.id)}">Edit</button><button type="button" class="link-button" data-token-delete="${escapeHtml(token.id)}">Delete</button>`}</div></td>
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

function selectAllocationSubject(student, subject, clearExisting) {
  if (allocationSubjectLocked(student)) return;
  const studentId = student.studentId;
  const edit = {
    selectedSubject: subject || '',
    clearSuggestion: clearExisting === true,
    clearAllocation: clearExisting === true && !!student.token,
  };
  if (!state.allocationPendingSubjects) state.allocationPendingSubjects = {};
  state.allocationPendingSubjects[studentId] = edit;
  applyPendingDesk();
  paintAllocationLive();
  const cohortId = state.cohortId;
  callServer('setAllocationSubject', cohortId, studentId, subject, clearExisting === true).then(function(result) {
    if (state.cohortId !== cohortId || state.allocationPendingSubjects[studentId] !== edit) return;
    const remote = ((state.allocationRemoteDesk && state.allocationRemoteDesk.students) || []).find(function(item) {
      return item.studentId === studentId;
    });
    const saved = result && Object.prototype.hasOwnProperty.call(result, 'selectedSubject') ? result.selectedSubject : subject;
    if (remote && sameSubjectName(remote.selectedSubject, saved)) {
      delete state.allocationPendingSubjects[studentId];
      applyPendingDesk();
      paintAllocationLive();
    }
  }).catch(function(error) {
    if (state.cohortId === cohortId && state.allocationPendingSubjects[studentId] === edit) {
      delete state.allocationPendingSubjects[studentId];
      applyPendingDesk();
      paintAllocationLive();
    }
    showError(error);
  });
}

function queueSuggestion(student, staffId) {
  const studentId = student.studentId;
  const subject = student.selectedSubject || '';
  const edit = {
    suggestedStaffId: staffId || '',
    suggestedSubject: staffId ? subject : '',
    suggestedStaffName: '',
  };
  if (!state.allocationPendingSuggestions) state.allocationPendingSuggestions = {};
  state.allocationPendingSuggestions[studentId] = edit;
  applyPendingDesk();
  paintAllocationLive();
  const cohortId = state.cohortId;
  callServer('suggestAllocation', cohortId, studentId, staffId || '').then(function() {
    if (state.cohortId !== cohortId || state.allocationPendingSuggestions[studentId] !== edit) return;
    const remote = ((state.allocationRemoteDesk && state.allocationRemoteDesk.students) || []).find(function(item) {
      return item.studentId === studentId;
    });
    if (remote && String(remote.suggestedStaffId || '').toLowerCase() === String(staffId || '').toLowerCase()) {
      delete state.allocationPendingSuggestions[studentId];
      applyPendingDesk();
      paintAllocationLive();
    }
  }).catch(function(error) {
    if (state.cohortId === cohortId && state.allocationPendingSuggestions[studentId] === edit) {
      delete state.allocationPendingSuggestions[studentId];
      applyPendingDesk();
      paintAllocationLive();
    }
    showError(error);
  });
}

function approveAllocationSuggestionRow(student) {
  if (allocationIsPublished(student)) {
    showError(new Error('This allocation is published. Unpublish it before changing the token.'));
    return;
  }
  if (!student.suggestedStaffId || !student.selectedSubject) return;
  const studentId = student.studentId;
  const edit = {
    staffId: student.suggestedStaffId,
    subject: student.selectedSubject,
    interdisciplinary: allocationInterdisciplinaryOn(student),
    interdisciplinarySubject: allocationInterdisciplinarySubject(student),
    tokenId: '',
    startedAt: new Date().toISOString(),
    acked: false,
  };
  if (!state.allocationRemoteDesk && state.allocationDesk) state.allocationRemoteDesk = state.allocationDesk;
  state.allocationPendingEdits[studentId] = edit;
  applyPendingDesk();
  paintAllocationLive();
  const cohortId = state.cohortId;
  callServer('approveAllocationSuggestion', cohortId, studentId).then(function() {
    if (state.cohortId !== cohortId) return;
    if (state.allocationPendingEdits[studentId] === edit) edit.acked = true;
  }).catch(function(error) {
    if (state.cohortId === cohortId && state.allocationPendingEdits[studentId] === edit) {
      delete state.allocationPendingEdits[studentId];
      applyPendingDesk();
      paintAllocationLive();
    }
    showError(error);
  });
}

export function assignAllocationBatch() {
  const staffId = document.getElementById('alloc-batch-supervisor').value;
  if (!state.allocationSelected.length) { showError(new Error('Select at least one student.')); return; }
  if (staffId === '__no_supervisor__') {
    clearAllocationSupervisorBatch();
    return;
  }
  if (!staffId) { showError(new Error('Choose a teacher token.')); return; }
  const subjects = {};
  state.allocationSelected.forEach(function(id) {
    const student = ((state.allocationDesk && state.allocationDesk.students) || []).find(function(item) { return item.studentId === id; });
    subjects[id] = (student && student.selectedSubject) || state.allocationSubjects[id] || '';
  });
  callServer('batchDraftAllocations', state.cohortId, staffId, state.allocationSelected.slice(), subjects, true).then(function(result) {
    const skipped = (result.skipped || []).length;
    const locked = (result.skipped || []).filter(function(item) { return /published/i.test(item.reason || ''); }).length;
    let message = result.assigned.length + ' drafted' + (skipped ? '. ' + skipped + ' left unchanged.' : '.');
    if (locked) message += ' Unpublish a published allocation before changing its token.';
    showSuccess(message);
    state.allocationSelected = [];
    loadAllocation();
  }).catch(showError);
}

function completeAllocationBatch(ids, results, successMessage) {
  const failedIds = new Set();
  const failures = [];
  let succeeded = 0;
  results.forEach(function(result, index) {
    if (result.status === 'fulfilled') {
      succeeded += 1;
      return;
    }
    const id = ids[index];
    failedIds.add(id);
    failures.push(id + ': ' + (result.reason && result.reason.message ? result.reason.message : String(result.reason)));
  });
  state.allocationSelected = ids.filter(function(id) { return failedIds.has(id); });
  if (succeeded) showSuccess(successMessage(succeeded));
  if (failures.length) showError(new Error(failures.join('\n')));
  loadAllocation();
}

export function applyAllocationSubjectBatch(value) {
  if (!state.allocationSelected.length) { showError(new Error('Select at least one student.')); return; }
  if (!value) { showError(new Error('Choose a subject or [no subject].')); return; }
  const subject = value === '__no_subject__' ? '' : value;
  const ids = state.allocationSelected.slice();
  const results = Promise.allSettled(ids.map(function(studentId) {
    return callServer('setAllocationSubject', state.cohortId, studentId, subject);
  }));
  results.then(function(settled) {
    completeAllocationBatch(ids, settled, function(count) {
      return 'Applied subject to ' + count + ' student' + (count === 1 ? '' : 's') + '.';
    });
  });
}

function clearAllocationSupervisorBatch() {
  const students = selectedAllocationRows();
  if (!students.length) { showError(new Error('Select at least one student.')); return; }
  const ids = students.map(function(student) { return student.studentId; });
  const results = Promise.allSettled(students.map(function(student) {
    const subject = student.token && student.token.assignedSubject
      ? student.token.assignedSubject
      : (student.selectedSubject || '');
    const interdisciplinarySubject = student.interdisciplinarySubject
      ? student.interdisciplinarySubject
      : '';
    return callServer(
      'draftAllocation',
      state.cohortId,
      student.studentId,
      '',
      subject,
      allocationInterdisciplinaryOn(student),
      interdisciplinarySubject,
    );
  }));
  results.then(function(settled) {
    completeAllocationBatch(ids, settled, function(count) {
      return 'Cleared supervisor for ' + count + ' student' + (count === 1 ? '' : 's') + '.';
    });
  });
}

export function approveSuggestedBatch() {
  if (!state.allocationSelected.length) { showError(new Error('Select at least one student.')); return; }
  const ids = state.allocationSelected.slice();
  const optimistic = [];
  ids.forEach(function(studentId) {
    const student = ((state.allocationDesk && state.allocationDesk.students) || []).find(function(item) { return item.studentId === studentId; });
    if (!student || allocationIsPublished(student) || !student.suggestedStaffId || !student.selectedSubject) return;
    state.allocationPendingEdits[studentId] = {
      staffId: student.suggestedStaffId,
      subject: student.selectedSubject,
      interdisciplinary: allocationInterdisciplinaryOn(student),
      interdisciplinarySubject: allocationInterdisciplinarySubject(student),
      tokenId: '',
      startedAt: new Date().toISOString(),
      acked: false,
    };
    optimistic.push(studentId);
  });
  applyPendingDesk();
  paintAllocationLive();
  const cohortId = state.cohortId;
  callServer('batchApproveAllocationSuggestions', cohortId, ids).then(function(result) {
    if (state.cohortId !== cohortId) return;
    const skipped = new Set((result.skipped || []).map(function(item) { return item.studentId; }));
    optimistic.forEach(function(studentId) {
      if (!skipped.has(studentId)) return;
      delete state.allocationPendingEdits[studentId];
    });
    applyPendingDesk();
    paintAllocationLive();
    const assigned = (result.assigned || []).length;
    const left = (result.skipped || []).length;
    showSuccess(assigned + ' drafted' + (left ? '. ' + left + ' left unchanged.' : '.'));
    state.allocationSelected = [];
  }).catch(function(error) {
    if (state.cohortId === cohortId) {
      optimistic.forEach(function(studentId) {
        delete state.allocationPendingEdits[studentId];
      });
      applyPendingDesk();
      paintAllocationLive();
    }
    showError(error);
  });
}

function selectedAllocationRows() {
  const selected = state.allocationSelected || [];
  return ((state.allocationDesk && state.allocationDesk.students) || []).filter(function(student) {
    return selected.indexOf(student.studentId) >= 0;
  });
}

export function publishSelectedAllocations() {
  if (!state.allocationSelected.length) { showError(new Error('Select at least one student.')); return; }
  const students = selectedAllocationRows();
  const drafts = students.filter(function(student) { return student.flags && student.flags.drafted; });
  const clears = students.filter(function(student) { return student.pendingClear && !(student.flags && student.flags.drafted); });
  if (!drafts.length && !clears.length) { showError(new Error('Select a drafted allocation to publish.')); return; }
  let message = 'Publish ' + drafts.length + ' selected draft allocation' + (drafts.length === 1 ? '' : 's') + ' to the live Hub.';
  if (clears.length) message += ' ' + clears.length + ' released supervisor' + (clears.length === 1 ? '' : 's') + ' will be cleared.';
  if (!window.confirm(message + ' Proceed?')) return;
  const ids = drafts.map(function(student) { return student.studentId; }).concat(clears.map(function(student) { return student.studentId; }));
  callServer('commitAllocations', state.cohortId, ids).then(function(result) {
    showSuccess('Published ' + result.published + ' allocation' + (result.published === 1 ? '' : 's') + (result.cleared ? ' and cleared ' + result.cleared : '') + '.');
    state.allocationSelected = [];
    loadAllocation();
  }).catch(showError);
}

export function unpublishSelectedAllocations() {
  if (!state.allocationSelected.length) { showError(new Error('Select at least one student.')); return; }
  const published = selectedAllocationRows().filter(function(student) { return allocationIsPublished(student); });
  if (!published.length) { showError(new Error('Select a published allocation to send back to draft.')); return; }
  const count = published.length;
  if (!window.confirm('Send ' + count + ' published allocation' + (count === 1 ? '' : 's') + ' back to draft? Their tokens can be edited again.')) return;
  callServer('reopenAllocations', state.cohortId, published.map(function(student) { return student.studentId; })).then(function(result) {
    const reopened = (result && result.reopened ? result.reopened : []).length;
    showSuccess('Sent ' + reopened + ' allocation' + (reopened === 1 ? '' : 's') + ' back to draft.');
    state.allocationSelected = [];
    loadAllocation();
  }).catch(showError);
}

export function allocationIngestKind() {
  if (state.allocationIngestKind === 'tokens' || state.allocationIngestKind === 'drafts') return state.allocationIngestKind;
  return 'workspace';
}

export function allocationConfirmCopy(kind) {
  if (kind === 'tokens') return 'Apply this token top-up. Tokens missing from the sheet stay in the hub.';
  if (kind === 'drafts') return 'Apply selected subjects, suggestions, and draft tokens from this sheet. Students missing from the sheet stay in the hub. Published tokens stay as they are.';
  return 'Apply this student upsert. Students missing from the sheet stay in the hub.';
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
  const kind = allocationIngestKind();
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
  const kind = allocationIngestKind();
  const url = allocationSheetUrl();
  const confirm = document.getElementById('alloc-ingest-confirm');
  if (!url) { showError(new Error('Paste a spreadsheet link.')); return; }
  if (!confirm || confirm.checked !== true) { showError(new Error(allocationConfirmCopy(kind))); return; }
  const button = document.getElementById('alloc-apply');
  if (button) button.disabled = true;
  callServer('applyAllocationIngest', state.cohortId, { url: url }, kind).then(function() {
    const message = kind === 'tokens' ? 'Staff tokens ingested.' : kind === 'drafts' ? 'Allocation drafts ingested.' : 'Student data ingested.';
    showSuccess(message);
    loadAllocation();
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

export function previewAllocationBackfill() {
  callServer('previewAllocationBackfill', state.cohortId).then(function(preview) {
    paintAllocationBackfill(preview);
  }).catch(showError);
}

export function applyAllocationBackfill() {
  const confirm = document.getElementById('alloc-backfill-confirm');
  if (!confirm || confirm.checked !== true) {
    showError(new Error('Confirm the backfill before applying it.'));
    return;
  }
  const button = document.getElementById('alloc-backfill-apply');
  if (button) button.disabled = true;
  callServer('applyAllocationBackfill', state.cohortId).then(function(result) {
    paintAllocationBackfill(result);
    showSuccess('Filled ' + (result.writing || 0) + ' selected subject' + (result.writing === 1 ? '' : 's') + ' from draft tokens.');
    loadAllocation();
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

function paintAllocationBackfill(preview) {
  const host = document.getElementById('alloc-backfill-result');
  if (!host) return;
  host.innerHTML = renderSheetIngestPreview({
    note: 'Draft tokens are copied into an empty Selected Subject and an empty suggestion. Nothing already stored is replaced.',
    summaryColumns: ['Draft tokens', 'Rows to write', 'Rows skipped'],
    summaryRows: [[preview.drafts || 0, preview.writing || 0, preview.skipped || 0]],
    detailTitle: 'Draft tokens',
    detailColumns: ['Student', 'Action', 'After', 'Now'],
    detailRows: (preview.rows || []).map(function(row) { return [row.id, row.action, row.incoming, row.hub]; }),
    warnings: preview.warnings,
  });
  const apply = document.getElementById('alloc-backfill-apply');
  if (apply) apply.disabled = false;
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

export function allocationStudentMatchesFilters(student, desk) {
  if (state.allocationStatus && state.allocationStatus !== 'all' && allocationStudentStatus(student) !== state.allocationStatus) return false;
  if (state.allocationNeedSupport === 'yes' && !(student.flags && student.flags.needsSupport)) return false;
  if (state.allocationFlaggedFilter === 'yes' && !allocationIsFlagged(student)) return false;
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
  const selectedSubjects = state.allocationSelectedSubjectFilter || [];
  if (selectedSubjects.length && !selectedSubjects.some(function(name) { return sameSubjectName(name, student.selectedSubject || ''); })) return false;
  const teachers = state.allocationTeacherFilter || [];
  if (teachers.length && teachers.indexOf(student.token ? student.token.staffId : '') < 0) return false;
  if (!allocationWorkflowFilterMatches(student, state.allocationWorkflowFilter, desk)) return false;
  const customFilters = state.allocationCustomFilters || {};
  const filterableKeys = new Set(((((desk && desk.settings) || {}).columns) || []).filter(function(column) {
    return column.filterable === true;
  }).map(function(column) { return column.key; }));
  for (const key of Object.keys(customFilters)) {
    if (!filterableKeys.has(key)) continue;
    const wantedValues = allocationCustomSelections(customFilters, key);
    if (!wantedValues.length) continue;
    const raw = student.dynamicData ? student.dynamicData[key] : '';
    const value = String(raw === undefined || raw === null ? '' : raw);
    if (!wantedValues.some(function(item) { return item === value; })) return false;
  }
  return true;
}

function allocationWorkflowFilterMatches(student, filter, desk) {
  if (!filter) return true;
  const type = String(filter.type || '');
  const subject = String(filter.subject || '');
  const selected = String(student.selectedSubject || '').trim();
  const choices = student.choices || {};
  const requests = allocationRequestedSubjects(student).map(function(item) { return item.name; });
  const requestsSubject = requests.some(function(name) { return sameSubjectName(name, subject); });
  const choice1Matches = sameSubjectName(allocationChoice1Subject(student), subject);
  const department = String(filter.department || '');
  const inDepartment = departmentsMatch(departmentOfSubject(selected, catalogueForDepartment(desk)), department);
  const suggestion = String(student.suggestedStaffId || '').trim();
  const token = student.token || null;
  if (type === 'subject-pool') return requestsSubject;
  if (type === 'subject-choice1') return choice1Matches;
  if (type === 'subject-undrafted') return !selected && requestsSubject;
  if (type === 'subject-undrafted-choice1') return !selected && choice1Matches;
  if (type === 'subject-drafted') return sameSubjectName(selected, subject);
  if (type === 'subject-allocated') return !!token && sameSubjectName(token.assignedSubject || '', subject);
  if (type === 'subject-needed') return !selected;
  if (type === 'subject-selected') return !!selected;
  if (type === 'proposal-needed') return !!selected && !suggestion && !token;
  if (type === 'proposal-review') return !!suggestion && (!token || String(token.staffId || '').toLowerCase() !== suggestion.toLowerCase());
  if (type === 'proposal-stale') return !!suggestion && !!student.suggestedSubject && !sameSubjectName(student.suggestedSubject, selected);
  if (type === 'assignment-draft') return !!token && token.status === 'draft';
  if (type === 'assignment-published') return allocationIsPublished(student);
  if (type === 'department-students') return inDepartment;
  if (type === 'department-proposals') {
    return !!suggestion && (!token || String(token.staffId || '').toLowerCase() !== suggestion.toLowerCase()) && inDepartment;
  }
  return true;
}

function allocationOverviewFilterFromKey(key) {
  const value = String(key || '');
  const simple = {
    'subject-selected': 'subject-selected',
    'subject-needed': 'subject-needed',
    'proposal-needed': 'proposal-needed',
    'proposal-review': 'proposal-review',
    'proposal-stale': 'proposal-stale',
    'assignment-draft': 'assignment-draft',
    'assignment-published': 'assignment-published',
  };
  if (simple[value]) return { type: simple[value] };
  if (value.indexOf('department-proposals:') === 0) return { type: 'department-proposals', department: value.slice('department-proposals:'.length) };
  if (value.indexOf('department:') === 0) return { type: 'department-students', department: value.slice('department:'.length) };
  if (value.indexOf('subject:') === 0) return { type: 'subject-drafted', subject: value.slice('subject:'.length) };
  return null;
}

function allocationWorkflowFilterMarkup() {
  const filter = state.allocationWorkflowFilter;
  if (!filter) return '';
  const labels = {
    'subject-pool': 'Pool',
    'subject-choice1': 'Choice 1',
    'subject-undrafted': 'Undrafted',
    'subject-undrafted-choice1': 'Undrafted · Choice 1',
    'subject-drafted': 'Subject Drafted',
    'subject-allocated': 'Allocated',
    'subject-needed': 'Need a Subject',
    'subject-selected': 'Subject Drafted',
    'proposal-needed': 'Need an HOD proposal',
    'proposal-review': 'Awaiting coordinator review',
    'proposal-stale': 'Proposal subject changed',
    'assignment-draft': 'Draft assignments',
    'assignment-published': 'Published allocations',
    'department-students': 'Department students',
    'department-proposals': 'Department proposals',
  };
  const detail = filter.subject || filter.department;
  const label = (labels[filter.type] || 'Workflow') + (detail ? ': ' + detail : '');
  return `<div class="alloc-workflow-filter"><span>Workflow filter: ${escapeHtml(label)}</span><button type="button" class="button secondary" data-alloc-workflow-filter-clear aria-label="Clear workflow filter">×</button></div>`;
}

export function visibleAllocationStudents(desk) {
  const drilldown = state.allocationOverviewDrilldown;
  if (drilldown && Array.isArray(drilldown.ids)) {
    const ids = new Set(drilldown.ids);
    const selected = (desk.students || []).filter(function(student) { return ids.has(student.studentId); });
    selected.sort(function(left, right) { return left.sortName.localeCompare(right.sortName); });
    return sortedRows('alloc-desk', selected, function(student, key) { return allocationRank(student, key); });
  }
  const snapshot = state.allocationFilterSnapshot;
  const rows = (desk.students || []).filter(function(student) {
    if (Array.isArray(snapshot)) return snapshot.indexOf(student.studentId) >= 0;
    return allocationQueryMatches(student, state.allocationQuery) && allocationStudentMatchesFilters(student, desk);
  });
  rows.sort(function(left, right) { return left.sortName.localeCompare(right.sortName); });
  return sortedRows('alloc-desk', rows, function(student, key) { return allocationRank(student, key); });
}

export function allocationRank(student, key) {
  if (key === 'name') return student.sortName || '';
  if (key === 'supervisor') return student.token && student.token.staffName ? student.token.staffName : '';
  if (key === 'subject') return allocationRequestedSubjects(student).map(function(item) { return item.name; }).join(', ');
  if (key === 'status') {
    const order = { unallocated: 0, drafted: 1, suggested: 2, allocated: 3, published: 4 };
    return order[allocationStudentStatus(student)] || 0;
  }
  const field = String(key || '').indexOf('field:') === 0 ? String(key).slice(6) : key;
  const raw = allocationStoredField(student, field);
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

function allocationFirstMark(student) {
  if (!String(student && student.selectedSubject || '').trim()) return allocationMark('No subject drafted', 'idle', 'status');
  if (allocationIsPublished(student)) return allocationMark('Published allocation', 'published', 'status');
  if (student && student.token) return allocationMark('Allocated token', 'on', 'status');
  return allocationMark('Subject drafted, no token', 'off', 'status');
}

function allocationChoiceMark(student) {
  const selected = String(student && student.selectedSubject || '').trim();
  if (!selected) return allocationMark('No subject drafted', 'idle', 'subject');
  const flag = choiceMatchFlag(selected, student.choices && student.choices.primary, student.choices && student.choices.secondary);
  if (flag === 'match') return allocationMark('First choice match', 'on', 'subject');
  if (flag === 'second') return allocationMark('Second choice', 'off', 'subject');
  if (flag === 'miss') return allocationMark('Not first or second choice', 'warn', 'subject');
  return allocationMark('Not first or second choice', 'warn', 'subject');
}

function allocationLevelMark(student) {
  const selected = String(student && student.selectedSubject || '').trim();
  if (!selected) return allocationMark('No subject drafted', 'idle', 'hl');
  const settings = (state.allocationDesk && state.allocationDesk.settings) || {};
  const flag = diplomaLevelFlag(selected, student.dynamicData || {}, settings.hlColumn || '');
  if (flag === 'match') return allocationMark('HL subject', 'on', 'hl');
  return allocationMark('Subject is not listed as HL', 'warn', 'hl');
}

function allocationInterdisciplinaryMark(student) {
  const selected = !!String(student && student.selectedSubject || '').trim();
  const enabled = allocationInterdisciplinaryOn(student);
  const mode = !selected ? 'neutral' : enabled ? 'on' : 'warn';
  const title = !selected ? 'No subject drafted' : enabled ? 'Interdisciplinary allocation selected' : 'Subject drafted without interdisciplinary allocation';
  return `<span class="id-tag id-tag-${mode}" title="${escapeHtml(title)}">ID</span>`;
}

export function allocationMark(title, mode, kind) {
  const tone = kind === 'subject' || kind === 'hl' ? kind : 'status';
  const star = '<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>';
  const bang = '<path d="M11 3h2v12h-2z"/><path d="M11 17.5h2V21h-2z"/>';
  const dot = '<circle cx="12" cy="12" r="4"/>';
  const path = mode === 'warn' ? bang : mode === 'idle' ? dot : star;
  return `<span class="alloc-mark ${mode} ${tone}" title="${escapeHtml(title)}"><svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg></span>`;
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
