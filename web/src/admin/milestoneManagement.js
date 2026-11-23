import { adminDialogKind, openAdminDialog } from './records.js';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { milestoneManagementPreviewMarkup, sameRemainingPreview } from './milestoneManagementPreview.js';

export function openMilestoneManagement(cohortId, milestones, onPlanChanged) {
  let available = milestones.slice();
  openAdminDialog('milestone-management', `<div class="form-panel milestone-management" role="dialog" aria-modal="true" aria-labelledby="milestone-management-title">
    <div class="toolbar"><h2 id="milestone-management-title">Manage cohort milestones</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p>Review assignments and student progress before removing milestones in cohort ${escapeHtml(cohortId)}.</p>
    <div class="field"><label for="management-milestone">Milestones to review</label><select id="management-milestone"></select></div>
    <div id="management-preview" aria-live="polite"></div><details id="management-archive"><summary>Archived assignments</summary><div id="management-archive-content"></div></details></div>`);
  const select = document.getElementById('management-milestone');
  const host = document.getElementById('management-preview');
  const archive = document.getElementById('management-archive');
  const archiveHost = document.getElementById('management-archive-content');
  if (!select || !host || !archive || !archiveHost) return;
  let generation = 0;
  function active() { return adminDialogKind() === 'milestone-management' && document.getElementById('management-preview') === host; }
  function options(value) {
    select.innerHTML = `<option value="">All milestones (${available.length})</option>${available.map(function(item) {
      return `<option value="${escapeHtml(item.milestoneId)}">${escapeHtml(item.milestoneTitle || item.milestoneId)}</option>`;
    }).join('')}`;
    select.value = available.some(function(item) { return item.milestoneId === value; }) ? value : '';
  }
  function load() {
    const request = ++generation;
    const selected = !select.value ? available.slice() : available.filter(function(item) { return item.milestoneId === select.value; });
    host.innerHTML = '<p class="muted">Loading assignments...</p>';
    Promise.all(selected.map(function(item) {
      return callServer('previewCohortMilestoneAssignments', cohortId, item.milestoneId).then(function(preview) { return { item, preview }; });
    })).then(function(groups) {
      if (request !== generation || !active()) return;
      const blocked = groups.some(function(group) {
        return group.preview.assignments.length || group.preview.excluded.some(function(row) { return row.reason === 'legacy'; });
      });
      host.innerHTML = `${groups.length ? groups.map(function(group) {
        return `<details open data-management-group="${escapeHtml(group.item.milestoneId)}"><summary>${escapeHtml(group.item.milestoneTitle || group.item.milestoneId)}</summary>${milestoneManagementPreviewMarkup(group.preview)}</details>`;
      }).join('') : '<p class="muted">No milestones in this cohort.</p>'}
        <p class="notice">Only selected cohort-tagged assignments are changed. Archive preserves the assignment and milestone for later restoration. Delete is permanent. Form responses, milestone events, notes and audit history are retained. Legacy assignments without a cohort ID are excluded and block milestone deletion until their ownership is resolved separately.</p>
        <div class="toolbar"><button type="button" class="button secondary" data-management-action="reset">Reset selected</button><button type="button" class="button secondary" data-management-action="archive">Archive selected</button><button type="button" class="button danger" data-management-action="delete">Delete selected</button><button type="button" class="button danger" data-management-delete-milestones${!groups.length || blocked ? ' disabled' : ''}>Delete ${groups.length === 1 ? 'milestone' : 'all reviewed milestones'}</button></div>`;
      host.querySelectorAll('[data-management-action]').forEach(function(button) {
        button.addEventListener('click', async function() {
          const action = button.dataset.managementAction;
          const targets = groups.map(function(group) {
            const element = Array.from(host.querySelectorAll('[data-management-group]')).find(function(node) { return node.dataset.managementGroup === group.item.milestoneId; });
            return { ...group, ids: Array.from(element.querySelectorAll('[data-management-task]:checked')).map(function(node) { return node.dataset.managementTask; }) };
          }).filter(function(group) { return group.ids.length; });
          const count = targets.reduce(function(sum, group) { return sum + group.ids.length; }, 0);
          if (!count) { showError(new Error('Select at least one assignment.')); return; }
          if (!window.confirm(`${action === 'delete' ? 'Permanently delete' : action === 'archive' ? 'Archive' : 'Reset'} ${count} selected assignment(s) in cohort ${cohortId}? Separate history and form responses remain.`)) return;
          select.disabled = true;
          host.querySelectorAll('button, input').forEach(function(node) { node.disabled = true; });
          let completed = 0;
          try {
            for (const group of targets) {
              let current = group.preview;
              const processed = [];
              for (let offset = 0; offset < group.ids.length; offset += 150) {
                if (offset) {
                  current = await callServer('previewCohortMilestoneAssignments', cohortId, group.item.milestoneId);
                  if (!sameRemainingPreview(group.preview, current, processed)) throw new Error('Assignments changed since the preview. Review them again.');
                }
                const ids = group.ids.slice(offset, offset + 150);
                const result = await callServer('manageCohortMilestoneAssignments', cohortId, group.item.milestoneId, action, current.signature, ids);
                completed += result.changed;
                processed.push(...ids);
                if (result.auditWarning) throw new Error('The operation succeeded but its completion audit entry could not be written.');
              }
            }
            showSuccess(`${completed} assignment(s) ${action === 'delete' ? 'deleted' : action === 'archive' ? 'archived' : 'reset'}.`);
          } catch (error) {
            showError(new Error(`${completed} assignment(s) confirmed processed before the operation stopped. Refresh the preview to verify the remaining assignments. ${error.message}`));
          } finally {
            if (active()) { select.disabled = false; load(); if (archive.open) loadArchive(); }
          }
        });
      });
      host.querySelector('[data-management-delete-milestones]').addEventListener('click', async function() {
        if (!window.confirm(`Permanently delete ${groups.length} reviewed milestone(s) from cohort ${cohortId}? Form responses, events and notes remain.`)) return;
        select.disabled = true;
        host.querySelectorAll('button, input').forEach(function(node) { node.disabled = true; });
        let completed = 0;
        try {
          for (const group of groups) {
            const result = await callServer('deleteCohortMilestone', cohortId, group.item.milestoneId);
            available = available.filter(function(item) { return item.milestoneId !== group.item.milestoneId; });
            completed++;
            if (result.auditWarning) throw new Error('The operation succeeded but its completion audit entry could not be written.');
          }
          showSuccess(`${completed} milestone(s) deleted.`);
        } catch (error) {
          showError(new Error(`${completed} milestone(s) confirmed deleted before the operation stopped. Refresh the pathway to verify the rest. ${error.message}`));
        } finally {
          onPlanChanged();
          if (active()) { const previous = select.value; options(previous); select.disabled = false; load(); }
        }
      });
    }).catch(function(error) {
      if (request !== generation || !active()) return;
      host.innerHTML = '<p class="notice">Could not load assignments.</p><button type="button" class="button secondary" data-management-retry>Retry</button>';
      host.querySelector('[data-management-retry]').addEventListener('click', load);
      showError(error);
    });
  }
  function loadArchive() {
    archiveHost.innerHTML = '<p class="muted">Loading archive...</p>';
    callServer('listCohortMilestoneArchives', cohortId).then(function(entries) {
      if (!active()) return;
      archiveHost.innerHTML = entries.length ? `<div class="table-wrap milestone-management-table"><table><thead><tr><th>Milestone</th><th>Student</th><th>Status</th><th>Archived</th><th></th></tr></thead><tbody>${entries.map(function(entry) {
        return `<tr><td>${escapeHtml(entry.milestone.milestoneTitle || entry.task.TemplateId)}</td><td>${escapeHtml(entry.task.StudentId || entry.task.studentId)}</td><td>${escapeHtml(entry.task.Status)}</td><td>${escapeHtml(entry.archivedAt)}</td><td><button type="button" class="button secondary" data-restore-archive="${escapeHtml(entry.id)}">Restore</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">No archived assignments.</p>';
      archiveHost.querySelectorAll('[data-restore-archive]').forEach(function(button) {
        button.addEventListener('click', async function() {
          if (!window.confirm('Restore this assignment and, if necessary, its original milestone? Existing assignments will not be overwritten.')) return;
          button.disabled = true;
          try {
            const result = await callServer('restoreCohortMilestoneAssignment', cohortId, button.dataset.restoreArchive);
            if (result.auditWarning) showError(new Error('Restored, but the completion audit entry could not be written.'));
            else showSuccess('Assignment restored.');
            onPlanChanged();
            if (active()) { select.disabled = true; loadArchive(); host.innerHTML = '<p class="notice">The pathway changed. Close and reopen this dialog to review milestones.</p>'; }
          } catch (error) { button.disabled = false; showError(error); }
        });
      });
    }).catch(function(error) {
      if (!active()) return;
      archiveHost.innerHTML = '<p class="notice">Could not load archive.</p><button type="button" class="button secondary" data-archive-retry>Retry</button>';
      archiveHost.querySelector('[data-archive-retry]').addEventListener('click', loadArchive);
      showError(error);
    });
  }
  archive.addEventListener('toggle', function() { if (archive.open) loadArchive(); });
  select.addEventListener('change', load);
  options('');
  load();
}
