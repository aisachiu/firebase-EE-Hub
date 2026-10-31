import { renderAdminData } from './records.js';
import { callServer } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { loadingLine } from '../shared/loading.js';
import { adoptGlobalCohort } from '../shared/headerCohorts.js';
import { state } from '../shared/state.js';

export function renderStudentTasks(target) {
  if (!target) return;
  if (state.cohortId) {
    loadStudentTasks(target, state.cohortId);
    return;
  }
  target.innerHTML = loadingLine('Loading student tasks...');
  callServer('getCohorts').then(function(cohorts) {
    if (state.adminEntity !== 'studentTasks') return;
    loadStudentTasks(target, adoptGlobalCohort(cohorts));
  }).catch(showError);
}

function loadStudentTasks(target, cohortId) {
  if (!target) return;
  if (!cohortId) {
    target.innerHTML = '<div class="empty">Create an active cohort before adding student tasks.</div>';
    return;
  }
  target.innerHTML = loadingLine('Loading student tasks...');
  callServer('listStudentTasks', cohortId).then(function(data) {
    if (state.cohortId !== cohortId || state.adminEntity !== 'studentTasks') return;
    renderAdminData(data);
  }).catch(showError);
}
