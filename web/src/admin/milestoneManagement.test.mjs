import assert from 'node:assert/strict';
import test from 'node:test';
import { milestoneManagementPreviewMarkup, sameRemainingPreview } from './milestoneManagementPreview.js';

test('preview permits selecting students and identifies excluded legacy and other-cohort records', () => {
  const html = milestoneManagementPreviewMarkup({
    assignments: [
      { taskId: '1', studentId: 'student@example.edu', studentName: 'A & B', status: 'Completed' },
      { taskId: '2', studentId: 'student@example.edu', studentName: 'A & B', status: 'Pending' },
    ],
    excluded: [
      { studentId: 'student@example.edu', studentName: 'A & B', status: 'Completed', cohortId: '2026', reason: 'other-cohort' },
      { studentId: 'student@example.edu', studentName: 'A & B', status: 'Pending', reason: 'legacy' },
    ],
  });
  assert.match(html, /2<\/strong> assignments for 1 student/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /data-management-task="1" checked/);
  assert.match(html, /ambiguous legacy assignment/);
  assert.match(html, /assignment\(s\) in another cohort/);
});

test('empty preview explains there are no cohort-tagged assignments', () => {
  assert.match(milestoneManagementPreviewMarkup({ assignments: [], excluded: [] }), /No cohort-tagged assignments/);
});

test('batch continuation refuses changes to remaining or excluded assignments', () => {
  const original = { assignments: [{ taskId: 'a', status: 'Pending' }, { taskId: 'b', status: 'Completed' }], excluded: [{ taskId: 'legacy' }] };
  assert.equal(sameRemainingPreview(original, { assignments: [original.assignments[1]], excluded: original.excluded }, ['a']), true);
  assert.equal(sameRemainingPreview(original, { assignments: [{ taskId: 'a', status: 'Pending' }, original.assignments[1]], excluded: original.excluded }, ['a']), true);
  assert.equal(sameRemainingPreview(original, { assignments: [{ taskId: 'b', status: 'Pending' }], excluded: original.excluded }, ['a']), false);
  assert.equal(sameRemainingPreview(original, { assignments: [original.assignments[1]], excluded: [] }, ['a']), false);
});
