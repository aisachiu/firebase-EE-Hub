import { renderEmailDesk } from './email.js';
import { renderFormDesigner } from './forms.js';
import { renderDriveAccount, renderDriveFolderPanel } from './google.js';
import { renderPathwayPlanner } from './pathway.js';
import { closeMemberEditor, renderAdminData } from './records.js';
import { renderSheetSync } from './sheets.js';
import { renderStaffQuotas } from './staff.js';
import { renderStudentTasks } from './studentTasks.js';
import { callServer } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { adoptGlobalCohort } from '../shared/headerCohorts.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { requestPush, syncHistory } from '../router.js';
import { renderShell } from '../navigation.js';

export const adminSections = [
  ['cohorts', 'Cohorts'], ['driveAccount', 'Google account'], ['sheetSync', 'Sheets'], ['cohortMembers', 'Students in cohorts'], ['pathway', 'Phases & milestones'],
  ['emailNotifications', 'Email notifications'],
  ['studentTasks', 'Student Tasks'],
  ['allocationSettings', 'Allocation'],
  ['studentUsers', 'Student users'], ['staffUsers', 'Staff users'], ['subjects', 'Subjects'], ['formDesigner', 'Milestone forms'],
  ['resources', 'Resources'], ['faqs', 'FAQs'], ['ticketCategories', 'Message categories']
];

export function renderAdmin() {
  advanceScene();
  const main = document.getElementById('main');
  const planner = state.adminEntity === 'pathway' || state.adminEntity === 'phases' || state.adminEntity === 'milestoneTemplates' || state.adminEntity === 'templateDesigner';
  main.classList.toggle('plan-wide', planner || (state.adminEntity === 'staffUsers' && state.staffPane === 'quotas'));
  main.innerHTML = `<div class="page-head"><div><p class="eyebrow">Administration</p><h1>Admin</h1><p class="lede">Manage the records that power the EE Hub.</p></div></div>
    <nav class="subnav" aria-label="Admin sections">${adminSections.map(function(section) {
      return `<button type="button" data-admin-entity="${section[0]}" aria-current="${state.adminEntity === section[0] ? 'page' : 'false'}">${section[1]}</button>`;
    }).join('')}</nav><div id="admin-content">${loadingLine('Loading...')}</div>`;
  main.querySelectorAll('[data-admin-entity]').forEach(function(button) {
    button.addEventListener('click', function() {
      if (!requestPush()) return;
      closeMemberEditor();
      if (button.dataset.adminEntity === 'allocationSettings') {
        state.section = 'allocation';
        state.view = 'allocation';
        state.allocationView = 'settings';
        renderShell();
        return;
      }
      state.adminEntity = button.dataset.adminEntity;
      state.editingRecord = null;
      state.noticeEdit = null;
      state.status = '';
      renderAdmin();
    });
  });
  loadAdminSection();
  syncHistory();
}

export function loadAdminSection() {
  const target = document.getElementById('admin-content');
  if (!target) return;
  if (state.adminEntity === 'allocationSettings') {
    state.section = 'allocation';
    state.view = 'allocation';
    state.allocationView = 'settings';
    renderShell();
    return;
  }
  if (state.adminEntity === 'phases' || state.adminEntity === 'milestoneTemplates' || state.adminEntity === 'templateDesigner') {
    state.adminEntity = 'pathway';
  }
  if (state.adminEntity === 'pathway') {
    renderPathwayPlanner(target);
    return;
  }
  if (state.adminEntity === 'emailNotifications') {
    renderEmailDesk(target, { back: false });
    return;
  }
  if (state.adminEntity === 'driveAccount') {
    renderDriveAccount(target);
    return;
  }
  if (state.adminEntity === 'sheetSync') {
    renderSheetSync(target);
    return;
  }
  if (state.adminEntity === 'formDesigner') {
    renderFormDesigner(target);
    return;
  }
  if (state.adminEntity === 'studentTasks') {
    renderStudentTasks(target);
    return;
  }
  if (state.adminEntity === 'staffUsers' && state.staffPane === 'quotas') {
    renderStaffQuotas(target);
    return;
  }
  if (state.adminEntity === 'cohortMembers') {
    const paintMembers = function(cohortId) {
      if (state.adminEntity !== 'cohortMembers') return;
      if (!cohortId) {
        target.innerHTML = '<div class="empty">Create an active cohort before adding students.</div>';
        return;
      }
      target.innerHTML = `<section class="editor drive-panel" id="drive-folder-panel">${loadingLine('Loading Drive folders...')}</section><div id="admin-records">${loadingLine('Loading students...')}</div>`;
      callServer('getCohortMembersForAdmin', cohortId).then(function(data) {
        if (state.cohortId !== cohortId || state.adminEntity !== 'cohortMembers') return;
        renderAdminData(data);
      }).catch(showError);
      renderDriveFolderPanel();
    };
    if (state.cohortId) {
      paintMembers(state.cohortId);
      return;
    }
    callServer('getCohorts').then(function(cohorts) {
      paintMembers(adoptGlobalCohort(cohorts));
    }).catch(showError);
    return;
  }
  callServer('getAdminRecords', state.adminEntity).then(renderAdminData).catch(showError);
}

export function refreshAdminSectionSilently() {
  if (state.adminEntity === 'pathway' || state.adminEntity === 'emailNotifications' || state.adminEntity === 'driveAccount' || state.adminEntity === 'sheetSync') return;
  if (state.adminEntity === 'staffUsers' && state.staffPane === 'quotas') {
    renderStaffQuotas(document.getElementById('admin-content'));
    return;
  }
  if (state.adminEntity === 'cohortMembers') {
    callServer('getCohortMembersForAdmin', state.cohortId).then(renderAdminData).catch(showError);
    return;
  }
  if (state.adminEntity === 'studentTasks') {
    callServer('listStudentTasks', state.cohortId).then(function(data) {
      if (state.adminEntity !== 'studentTasks') return;
      renderAdminData(data);
    }).catch(showError);
    return;
  }
  callServer('getAdminRecords', state.adminEntity).then(renderAdminData).catch(showError);
}

export function switchAdminSection(entity) {
  if (!requestPush()) return;
  advanceScene();
  state.adminEntity = entity;
  state.editingRecord = null;
  state.status = '';
  renderAdmin();
}

export function sectionLabel(entity) {
  const item = adminSections.filter(function(section) { return section[0] === entity; })[0];
  return item ? item[1] : entity;
}

export function singularSection(label) {
  if (/ies$/.test(label)) return label.replace(/ies$/, 'y');
  if (/s$/.test(label) && !/ss$/.test(label)) return label.replace(/s$/, '');
  return label;
}
