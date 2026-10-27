import assert from 'node:assert/strict';
import test from 'node:test';
import { state } from '../shared/state.js';
import { staffStudentDrawersHtml } from '../shared/studentDrawers.js';
import { rememberStaffViewMode, renderStaffStudentList, staffViewMode, staffViewModeControl } from './students.js';

const home = {
  canEditMilestones: false,
  templates: [{ milestoneId: 'm1', phase: 'p1', title: 'Proposal', type: 'task' }],
  phases: [{ phaseId: 'p1', phaseTitle: 'Inquiry', phaseColor: '#004C80' }],
};

const student = {
  email: 'amy@school.edu',
  displayName: 'Amy Chen',
  surname: 'Chen',
  subject: 'Biology',
  hrm: '12A',
  studentNumber: '1001',
  segments: 'o',
  dues: ['2026-11-01'],
  done: 0,
  total: 1,
  behind: 0,
  waiting: [],
  latestTitle: 'Proposal',
};

test('one viewMode control offers Tiles, List collapsed, and List expanded', () => {
  state.staffViewMode = 'list-collapsed';
  assert.equal(staffViewMode(), 'list-collapsed');
  const control = staffViewModeControl();
  assert.match(control, /role="group" aria-label="Student layout"/);
  assert.match(control, /data-staff-view="tiles" aria-pressed="false"/);
  assert.match(control, /data-staff-view="list-collapsed" aria-pressed="true"/);
  assert.match(control, /data-staff-view="list-expanded" aria-pressed="false"/);
  assert.match(control, />Tiles</);
  assert.match(control, />List collapsed</);
  assert.match(control, />List expanded</);
  assert.equal((control.match(/data-staff-view=/g) || []).length, 3);
  rememberStaffViewMode('list-expanded');
  assert.equal(staffViewMode(), 'list-expanded');
  rememberStaffViewMode('somewhere-else');
  assert.equal(staffViewMode(), 'tiles');
});

test('list rows follow viewMode and the column no longer has its own expand button', () => {
  state.staffViewMode = 'list-collapsed';
  const collapsed = renderStaffStudentList(home, [student]);
  assert.match(collapsed, /list-journey is-collapsed/);
  assert.equal(collapsed.includes('data-list-journey-toggle'), false);
  assert.equal(collapsed.includes('>Expand<'), false);
  state.staffViewMode = 'list-expanded';
  const expanded = renderStaffStudentList(home, [student]);
  assert.match(expanded, /list-journey is-expanded/);
  assert.equal(expanded.includes('data-list-journey-toggle'), false);
  assert.equal(expanded.includes('>Collapse<'), false);
});

test('staff student drawers collapse into one right rail and open with Notes on the right', () => {
  const collapsed = staffStudentDrawersHtml({ journeyOpen: false, notesOpen: false });
  assert.match(collapsed, /id="side-drawers" class="side-drawers"/);
  assert.match(collapsed, /aria-label="Student Journey"/);
  assert.match(collapsed, /class="journey-peek"[^>]*>Student Journey</);
  assert.match(collapsed, /class="notes-peek"[^>]*>Notes</);
  assert.ok(collapsed.indexOf('id="journey-panel"') < collapsed.indexOf('id="notes-panel"'));
  assert.equal(collapsed.includes('>Journey<'), false);
  const open = staffStudentDrawersHtml({ journeyOpen: true, notesOpen: true });
  assert.match(open, /id="journey-panel" class="journey-panel open"/);
  assert.match(open, /id="notes-panel" class="notes-panel open"/);
  assert.ok(open.indexOf('id="journey-panel"') < open.indexOf('id="notes-panel"'));
  assert.match(open, /<strong>Student Journey<\/strong>/);
  assert.match(open, /<strong>Notes<\/strong>/);
});
