import { callServer } from './api.js';
import { escapeHtml } from './html.js';
import { renderShell } from '../navigation.js';
import { confirmProvisioningLeave } from '../router.js';
import { syncHeaderCohortSelect } from './staffContext.js';
import { state } from './state.js';

let headerCohortsRequest = null;
let headerCohortsTicket = 0;
let headerCohortsGeneration = 0;
let headerWatchStop = null;
let headerWatchStarted = false;
let headerWatchFailed = false;
let headerCohortsLive = false;
let headerFollowQueued = false;
let headerFollowId = '';

function cohortIdentity(record) {
  if (!record) return '';
  const cohort = record.Cohort == null ? '' : String(record.Cohort).trim();
  if (cohort) return cohort;
  return record.id == null ? '' : String(record.id).trim();
}

function cohortStatus(record) {
  const raw = record && (record.Status != null && record.Status !== '' ? record.Status : record.status);
  const status = raw == null || raw === '' ? 'Active' : String(raw).trim();
  return status || 'Active';
}

function cohortLabel(record, id) {
  if (record && record.name != null && String(record.name).trim()) return String(record.name).trim();
  return id;
}

/** Active cohorts only, matching getCohorts. Archive stores Status "Inactive". */
export function activeHeaderCohorts(records) {
  return (records || []).map(function(record) {
    const id = cohortIdentity(record);
    return { id: id, name: cohortLabel(record, id), status: cohortStatus(record) };
  }).filter(function(cohort) {
    return cohort.id && cohort.status.toLowerCase() !== 'inactive';
  }).map(function(cohort) {
    return { id: cohort.id, name: cohort.name || cohort.id };
  }).sort(function(left, right) {
    return left.id.localeCompare(right.id);
  });
}

export function headerCohortOptions() {
  const cohorts = state.headerCohorts;
  if (!cohorts) return '<option value="">Loading cohorts...</option>';
  if (!cohorts.length) return '<option value="">No cohorts</option>';
  return cohorts.map(function(cohort) {
    return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === state.cohortId ? 'selected' : ''}>${escapeHtml(cohort.name || cohort.id)}</option>`;
  }).join('');
}

export function paintHeaderCohortSelect() {
  if (typeof document === 'undefined') return;
  const select = document.getElementById('header-cohort');
  if (!select || !state.user || state.user.role === 'student') return;
  const signature = (state.headerCohorts || []).map(function(cohort) { return cohort.id + '\0' + cohort.name; }).join('\n');
  if (select.dataset.cohorts !== signature) {
    select.dataset.cohorts = signature;
    select.innerHTML = headerCohortOptions();
  }
  select.disabled = !(state.headerCohorts && state.headerCohorts.length);
  if (state.cohortId) select.value = state.cohortId;
}

export function replaceHeaderCohort(next) {
  state.cohortId = next || '';
  state.allocationSelected = [];
  state.allocationSubjects = {};
  state.allocationSubjectFilter = [];
  state.allocationAllocatedFilter = [];
  state.allocationTeacherFilter = [];
  state.allocationSupportFlags = [];
  state.allocationCustomFilters = {};
  state.allocationQuery = '';
  state.allocationCustomQueries = {};
  state.allocationCustomOpen = '';
  state.allocationOpenStudent = '';
  state.allocationAssignedOpen = {};
  state.allocationDataSelected = [];
  state.allocationInterdisciplinary = {};
  state.allocationInterdisciplinarySubject = {};
  state.allocationPendingFlags = {};
  state.tokenEditId = '';
  state.memberProvisionFilter = 'all';
  state.staffSupervisor = '';
  state.staffSelected = [];
  state.staffHome = null;
  state.staffStudent = null;
  state.staffStudentHome = null;
  state.staffStudentChat = null;
  state.staffStudentId = '';
  state.notesOpen = false;
  renderShell();
}

function scheduleHeaderFollow(next) {
  headerFollowId = next || '';
  if (typeof document === 'undefined' || !document.getElementById('app')) return;
  if (headerFollowQueued) return;
  headerFollowQueued = true;
  queueMicrotask(function() {
    headerFollowQueued = false;
    if (typeof document === 'undefined' || !document.getElementById('app')) return;
    replaceHeaderCohort(headerFollowId);
  });
}

function applyHeaderCohortList(list, follow) {
  const previous = state.cohortId;
  const missing = !!(previous && !list.some(function(cohort) { return cohort.id === previous; }));
  state.headerCohorts = list;
  if (follow && missing && confirmProvisioningLeave()) {
    const next = list.length ? list[0].id : '';
    state.cohortId = next;
    paintHeaderCohortSelect();
    syncHeaderCohortSelect();
    scheduleHeaderFollow(next);
    return;
  }
  paintHeaderCohortSelect();
  syncHeaderCohortSelect();
}

export function rememberHeaderCohorts(cohorts) {
  if (!Array.isArray(cohorts)) return;
  if (headerCohortsLive) {
    paintHeaderCohortSelect();
    syncHeaderCohortSelect();
    return;
  }
  applyHeaderCohortList(activeHeaderCohorts(cohorts), false);
}

/** Use the header cohort. When none is selected, adopt the first cohort into that same global state. */
export function adoptGlobalCohort(cohorts) {
  const list = headerCohortsLive ? (state.headerCohorts || []) : activeHeaderCohorts(cohorts);
  if (!headerCohortsLive) state.headerCohorts = list;
  if (list.length && !list.some(function(cohort) { return cohort.id === state.cohortId; })) {
    state.cohortId = list[0].id;
  }
  paintHeaderCohortSelect();
  syncHeaderCohortSelect();
  return state.cohortId || '';
}

function fetchHeaderCohorts(force) {
  if (!state.user || state.user.role === 'student') return;
  if (!force && headerCohortsRequest) return;
  const ticket = ++headerCohortsTicket;
  const generation = headerCohortsGeneration;
  headerCohortsRequest = callServer('getCohorts').then(function(cohorts) {
    if (ticket !== headerCohortsTicket) return;
    headerCohortsRequest = null;
    if (!force && headerCohortsLive) return;
    if (force && generation !== headerCohortsGeneration) return;
    applyHeaderCohortList(activeHeaderCohorts(cohorts), !!force);
  }, function(error) {
    if (ticket !== headerCohortsTicket) return;
    headerCohortsRequest = null;
    if (error && error.stale) fetchHeaderCohorts(force);
  });
}

function startHeaderCohortWatch() {
  if (headerWatchFailed || headerWatchStarted || headerCohortsLive) return false;
  // Rules allow coordinators and heads of department to read /cohorts. Other staff use getCohorts.
  const watch = typeof window !== 'undefined' ? window.eeWatchCohorts : null;
  const permissions = state.user && state.user.permissions;
  const canListen = !!(permissions && (permissions.canAdmin || permissions.isHOD)) && typeof watch === 'function';
  if (!canListen) return false;
  headerWatchStarted = true;
  let stop = null;
  try {
    stop = watch({
      onData: function(docs) {
        headerCohortsLive = true;
        headerCohortsGeneration += 1;
        applyHeaderCohortList(activeHeaderCohorts(docs), true);
      },
      onError: function() {
        headerWatchFailed = true;
        headerCohortsLive = false;
        headerWatchStarted = false;
        const current = headerWatchStop;
        headerWatchStop = null;
        if (typeof current === 'function') current();
        fetchHeaderCohorts(false);
      },
    });
  } catch (error) {
    headerWatchStarted = false;
    headerWatchFailed = true;
    return false;
  }
  if (typeof stop !== 'function') {
    headerWatchStarted = false;
    headerWatchFailed = true;
    return false;
  }
  headerWatchStop = stop;
  return true;
}

export function releaseHeaderCohortsWatch() {
  headerCohortsTicket += 1;
  headerCohortsGeneration += 1;
  headerCohortsRequest = null;
  headerCohortsLive = false;
  headerWatchStarted = false;
  headerWatchFailed = false;
  headerFollowQueued = false;
  headerFollowId = '';
  const stop = headerWatchStop;
  headerWatchStop = null;
  if (typeof stop === 'function') stop();
}

/** Re-read cohorts after an admin save. A snapshot that lands during the fetch wins. */
export function refreshHeaderCohorts() {
  if (!state.user || state.user.role === 'student') return;
  fetchHeaderCohorts(true);
}

export function ensureHeaderCohorts() {
  if (!state.user || state.user.role === 'student') return;
  if (headerWatchStarted || headerCohortsLive) return;
  if (startHeaderCohortWatch()) return;
  if (state.headerCohorts || headerCohortsRequest) return;
  fetchHeaderCohorts(false);
}
