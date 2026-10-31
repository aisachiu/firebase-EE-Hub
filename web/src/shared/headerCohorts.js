import { callServer } from './api.js';
import { escapeHtml } from './html.js';
import { syncHeaderCohortSelect } from './staffContext.js';
import { state } from './state.js';

let headerCohortsRequest = null;

function normalizeCohorts(cohorts) {
  return (cohorts || []).map(function(cohort) {
    return { id: cohort.id, name: cohort.name || cohort.id };
  }).filter(function(cohort) { return cohort.id; });
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

export function rememberHeaderCohorts(cohorts) {
  if (!Array.isArray(cohorts)) return;
  state.headerCohorts = normalizeCohorts(cohorts);
  paintHeaderCohortSelect();
}

/** Use the header cohort. When none is selected, adopt the first cohort into that same global state. */
export function adoptGlobalCohort(cohorts) {
  const list = normalizeCohorts(cohorts);
  if (!list.length) return state.cohortId || '';
  if (!list.some(function(cohort) { return cohort.id === state.cohortId; })) {
    state.cohortId = list[0].id;
  }
  state.headerCohorts = list;
  paintHeaderCohortSelect();
  syncHeaderCohortSelect();
  return state.cohortId;
}

export function ensureHeaderCohorts() {
  if (!state.user || state.user.role === 'student') return;
  if (state.headerCohorts || headerCohortsRequest) return;
  headerCohortsRequest = callServer('getCohorts').then(function(cohorts) {
    if (!state.headerCohorts) state.headerCohorts = normalizeCohorts(cohorts);
    paintHeaderCohortSelect();
  }, function(error) {
    headerCohortsRequest = null;
    if (error && error.stale) ensureHeaderCohorts();
  });
}
