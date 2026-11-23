import { escapeHtml } from '../shared/html.js';

export function sameRemainingPreview(original, current, processedIds) {
  const processed = new Set(processedIds);
  return JSON.stringify(original.assignments.filter(function(row) { return !processed.has(row.taskId); })) === JSON.stringify(current.assignments.filter(function(row) { return !processed.has(row.taskId); }))
    && JSON.stringify(original.excluded) === JSON.stringify(current.excluded);
}

export function milestoneManagementPreviewMarkup(preview) {
  const rows = preview.assignments || [];
  const excluded = preview.excluded || [];
  const legacy = excluded.filter(function(row) { return row.reason === 'legacy'; });
  const other = excluded.filter(function(row) { return row.reason !== 'legacy'; });
  const students = new Set(rows.map(function(row) { return row.canonicalStudentId || row.studentId || row.taskId; })).size;
  const table = rows.length ? `<div class="table-wrap milestone-management-table"><table><thead><tr><th>Select</th><th>Student</th><th>Status</th><th>Task type</th></tr></thead><tbody>${rows.map(function(row) {
    return `<tr><td><input type="checkbox" data-management-task="${escapeHtml(row.taskId)}" checked aria-label="Select assignment for ${escapeHtml(row.studentName)}"></td><td>${escapeHtml(row.studentName)}<br><span class="muted">${escapeHtml(row.studentId)}</span></td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.creator || 'Unknown')}</td></tr>`;
  }).join('')}</tbody></table></div>` : '<p class="muted">No cohort-tagged assignments.</p>';
  const excludedMarkup = function(items, label) {
    return items.length ? `<details><summary>${items.length} ${label}</summary><ul>${items.map(function(row) {
      return `<li>${escapeHtml(row.studentName)} (${escapeHtml(row.studentId)}): ${escapeHtml(row.status)}${row.cohortId ? ', cohort ' + escapeHtml(row.cohortId) : ''}</li>`;
    }).join('')}</ul></details>` : '';
  };
  return `<p><strong>${rows.length}</strong> assignment${rows.length === 1 ? '' : 's'} for ${students} student${students === 1 ? '' : 's'}.</p>${table}
    ${excludedMarkup(legacy, 'ambiguous legacy assignment(s) without a cohort ID; resolve before deleting this milestone')}
    ${excludedMarkup(other, 'assignment(s) in another cohort; not changed')}`;
}
