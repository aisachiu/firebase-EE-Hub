import { renderAssignmentManager } from './assignments.js';
import { renderEmailDesk } from './email.js';
import { renderFormDesigner } from './forms.js';
import { renderDriveAccount, renderDriveFolderPanel } from './google.js';
import { renderPathwayPlanner } from './pathway.js';
import { closeMemberEditor, renderAdminData } from './records.js';
import { renderSheetSync } from './sheets.js';
import { renderStaffQuotas } from './staff.js';
import { callServer } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene } from '../shared/scene.js';
import { state } from '../shared/state.js';
import { renderShell } from '../shell.js';

export const adminSections = [
  ['cohorts', 'Cohorts'], ['driveAccount', 'Google account'], ['sheetSync', 'Sheets'], ['cohortMembers', 'Students in cohorts'], ['pathway', 'Phases & milestones'],
  ['emailNotifications', 'Email notifications'],
  ['assignments', 'Assignments'],
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
  if (state.adminEntity === 'assignments') {
    renderAssignmentManager(target);
    return;
  }
  if (state.adminEntity === 'staffUsers' && state.staffPane === 'quotas') {
    renderStaffQuotas(target);
    return;
  }
  if (state.adminEntity === 'cohortMembers') {
    callServer('getCohorts').then(function(cohorts) {
      const current = cohorts.some(function(cohort) { return cohort.id === state.cohortId; }) ? state.cohortId : (cohorts[0] ? cohorts[0].id : '');
      state.cohortId = current;
      if (!current) {
        target.innerHTML = '<div class="empty">Create an active cohort before adding students.</div>';
        return;
      }
      target.innerHTML = `<div class="toolbar"><label for="admin-cohort">Cohort</label><select id="admin-cohort">${cohorts.map(function(cohort) {
        return `<option value="${escapeHtml(cohort.id)}" ${cohort.id === current ? 'selected' : ''}>${escapeHtml(cohort.name)}</option>`;
      }).join('')}</select></div><section class="editor drive-panel" id="drive-folder-panel">${loadingLine('Loading Drive folders...')}</section><div id="admin-records">${loadingLine('Loading students...')}</div>`;
      document.getElementById('admin-cohort').addEventListener('change', function(event) {
        closeMemberEditor();
        state.cohortId = event.target.value;
        state.editingRecord = null;
        state.selectedMemberIds = [];
        state.importRecords = null;
        loadAdminSection();
      });
      callServer('getCohortMembersForAdmin', current).then(renderAdminData).catch(showError);
      renderDriveFolderPanel();
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
  callServer('getAdminRecords', state.adminEntity).then(renderAdminData).catch(showError);
}

export function switchAdminSection(entity) {
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
