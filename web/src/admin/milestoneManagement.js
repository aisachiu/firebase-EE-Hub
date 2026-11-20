import { adminDialogKind, closeAdminDialog, openAdminDialog } from './records.js';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { milestoneManagementPreviewMarkup } from './milestoneManagementPreview.js';

export function openMilestoneManagement(cohortId, milestones, onDeleteMilestone) {
  const options = milestones.map(function(item) {
    return `<option value="${escapeHtml(item.milestoneId)}">${escapeHtml(item.milestoneTitle || item.milestoneId)}</option>`;
  }).join('');
  openAdminDialog('milestone-management', `<div class="form-panel milestone-management" role="dialog" aria-modal="true" aria-labelledby="milestone-management-title"><div class="toolbar"><h2 id="milestone-management-title">Manage cohort milestone assignments</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div><p>Cohort ${escapeHtml(cohortId)}. Select a milestone to preview its assignments.</p><div class="field"><label for="management-milestone">Milestone</label><select id="management-milestone"><option value="">Choose a milestone</option>${options}</select></div><div id="management-preview" aria-live="polite"></div></div>`);
  const select = document.getElementById('management-milestone');
  const host = document.getElementById('management-preview');
  if (!select || !host) return;
  let generation = 0;
  function load() {
    const milestoneId = select.value;
    const request = ++generation;
    if (!milestoneId) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = '<p class="muted">Loading assignments...</p>';
    callServer('previewCohortMilestoneAssignments', cohortId, milestoneId).then(function(preview) {
      if (request !== generation || adminDialogKind() !== 'milestone-management' || document.getElementById('management-preview') !== host) return;
      host.innerHTML = milestoneManagementPreviewMarkup(preview);
      host.querySelectorAll('[data-management-action]').forEach(function(button) {
        button.addEventListener('click', function() {
          const action = button.dataset.managementAction;
          const label = select.options[select.selectedIndex].textContent;
          const question = action === 'delete'
            ? `Permanently delete ${preview.assignments.length} assignment(s) for "${label}" in cohort ${cohortId}? Form responses, milestone events and audit history will remain.`
            : `Reset ${preview.assignments.length} assignment(s) for "${label}" in cohort ${cohortId} to Pending? Due dates and history will remain.`;
          if (!window.confirm(question)) return;
          select.disabled = true;
          host.querySelectorAll('button').forEach(function(control) { control.disabled = true; });
          callServer('manageCohortMilestoneAssignments', cohortId, milestoneId, action, preview.signature).then(function(result) {
            if (result.auditWarning) showError(new Error('Assignments changed, but the completion audit entry could not be written.'));
            else showSuccess(`${result.changed} assignment(s) ${action === 'delete' ? 'deleted' : 'reset'}.`);
            if (document.getElementById('management-preview') === host) {
              select.disabled = false;
              load();
            }
          }).catch(function(error) {
            if (document.getElementById('management-preview') === host) {
              select.disabled = false;
              load();
            }
            showError(error);
          });
        });
      });
      const deleteMilestone = host.querySelector('[data-management-delete-milestone]');
      if (deleteMilestone) deleteMilestone.addEventListener('click', function() {
        closeAdminDialog();
        onDeleteMilestone(milestoneId);
      });
    }).catch(function(error) {
      if (request !== generation || document.getElementById('management-preview') !== host) return;
      host.innerHTML = '<p class="notice">Could not load assignments.</p><button type="button" class="button secondary" data-management-retry>Retry preview</button>';
      host.querySelector('[data-management-retry]').addEventListener('click', load);
      showError(error);
    });
  }
  select.addEventListener('change', load);
}
