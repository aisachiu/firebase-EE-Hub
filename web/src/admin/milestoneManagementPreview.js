import { escapeHtml } from '../shared/html.js';

export function milestoneManagementPreviewMarkup(preview) {
  const rows = preview.assignments || [];
  const excluded = preview.excluded || [];
  const students = new Set(rows.map(function(row) { return row.canonicalStudentId || row.studentId || row.taskId; })).size;
  const table = rows.length ? `<div class="table-wrap milestone-management-table"><table><thead><tr><th>Student</th><th>Status</th><th>Assignment</th></tr></thead><tbody>${rows.map(function(row) {
    return `<tr><td>${escapeHtml(row.studentName)}<br><span class="muted">${escapeHtml(row.studentId)}</span></td><td>${escapeHtml(row.status)}</td><td>${row.legacy ? 'Legacy (no cohort ID)' : 'Cohort ' + escapeHtml(row.cohortId)}</td></tr>`;
  }).join('')}</tbody></table></div>` : '<p class="muted">No matching assignments.</p>';
  const other = excluded.length ? `<details><summary>${excluded.length} assignment${excluded.length === 1 ? '' : 's'} excluded from another cohort</summary><ul>${excluded.map(function(row) {
    return `<li>${escapeHtml(row.studentName)} (${escapeHtml(row.studentId)}): ${escapeHtml(row.status)}, cohort ${escapeHtml(row.cohortId)}</li>`;
  }).join('')}</ul><p>These assignments will not be changed or deleted.</p></details>` : '';
  return `<p><strong>${rows.length}</strong> assignment${rows.length === 1 ? '' : 's'} for ${students} student${students === 1 ? '' : 's'}.</p>${table}${other}
    <p class="notice">Reset only changes status to Pending. Delete removes the entire assignment records, including their fields. Due dates are unchanged by reset. Separate form responses, milestone events, reflection notes and audit history are retained; deleting assignments may leave history referring to removed tasks. Legacy records without a cohort ID are matched using current cohort membership, which can be ambiguous if a student belongs to multiple cohorts.</p>
    <div class="toolbar"><button type="button" class="button secondary" data-management-action="reset"${!rows.length ? ' disabled' : ''}>Reset status to Pending</button><button type="button" class="button danger" data-management-action="delete"${!rows.length ? ' disabled' : ''}>Delete assignments</button>${!rows.length ? '<button type="button" class="button danger" data-management-delete-milestone>Delete milestone...</button>' : ''}</div>`;
}
