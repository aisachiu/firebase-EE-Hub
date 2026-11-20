import assert from 'node:assert/strict';
import test from 'node:test';
import { milestoneManagementPreviewMarkup } from './milestoneManagementPreview.js';

test('assignment preview distinguishes legacy and excluded records and explains retained history', () => {
  const html = milestoneManagementPreviewMarkup({
    assignments: [
      { taskId: '1', studentId: 'student@example.edu', studentName: 'A & B', status: 'Completed', cohortId: '2027', legacy: false },
      { taskId: '2', studentId: 'student@example.edu', studentName: 'A & B', status: 'Pending', cohortId: '', legacy: true },
    ],
    excluded: [{ studentId: 'student@example.edu', studentName: 'A & B', status: 'Completed', cohortId: '2026' }],
  });
  assert.match(html, /2<\/strong> assignments for 1 student/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /Legacy \(no cohort ID\)/);
  assert.match(html, /1 assignment excluded from another cohort/);
  assert.match(html, /form responses, milestone events, reflection notes and audit history are retained/);
  assert.match(html, /data-management-action="reset"/);
  assert.match(html, /data-management-action="delete"/);
  assert.doesNotMatch(html, /data-management-delete-milestone/);
});

test('empty preview offers milestone deletion but disables assignment mutations', () => {
  const html = milestoneManagementPreviewMarkup({ assignments: [], excluded: [] });
  assert.match(html, /No matching assignments/);
  assert.match(html, /data-management-action="reset" disabled/);
  assert.match(html, /data-management-action="delete" disabled/);
  assert.match(html, /data-management-delete-milestone/);
});

test('large previews remain actionable and count student aliases once', () => {
  const assignments = Array.from({ length: 451 }, (_, index) => ({
    taskId: String(index), studentId: index % 2 ? 'login@example.edu' : 'alias@example.edu',
    canonicalStudentId: 'login@example.edu', studentName: 'Student', status: 'Completed', cohortId: '2027',
  }));
  const html = milestoneManagementPreviewMarkup({ assignments, excluded: [] });
  assert.match(html, /451<\/strong> assignments for 1 student/);
  assert.doesNotMatch(html, /data-management-action="(?:reset|delete)" disabled/);
});
