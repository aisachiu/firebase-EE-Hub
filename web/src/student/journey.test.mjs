import assert from 'node:assert/strict';
import test from 'node:test';
import { state } from '../shared/state.js';
import {
  bindJourneyDisclosures,
  journeyHereCard,
  paintStudentJourney,
  renderJourneyMilestone,
  renderJourneyTodo,
} from './journey.js';

const template = { milestoneId: 'm1', title: 'Review', type: 'approval', phase: 'p1', mOwner: 'supervisor' };
const item = { TaskId: 'task1', TemplateId: 'm1', Title: 'Review', Description: 'Review the question', Status: 'Pending', canUpdate: true, staffUpdate: true };
const todo = { TaskId: 'todo1', Title: 'Read sources', Description: 'Read a chapter', Status: 'Pending', canEdit: true };
const home = { email: 'student@example.com', cohort: '2027', staffView: true, canUpdateMilestones: true, templates: [template], phases: [{ phaseId: 'p1', phaseTitle: 'Research' }], actionItems: [item] };

test('milestone and to-do headers start collapsed and retain their controls in details', () => {
  state.journeyExpanded = {};
  state.editingTodo = '';
  const milestone = renderJourneyMilestone(home, template, item, { template, item });
  assert.match(milestone, /data-journey-toggle="milestone:m1" aria-expanded="false"/);
  assert.match(milestone, /data-journey-details hidden[\s\S]*Review the question[\s\S]*data-decide="approve"[\s\S]*data-edit-milestone/);
  assert.match(milestone, /data-milestone-check/);
  const task = renderJourneyTodo(todo);
  assert.match(task, /data-journey-toggle="todo:todo1" aria-expanded="false"/);
  assert.match(task, /data-journey-details hidden[\s\S]*Read a chapter[\s\S]*data-edit-todo/);
  const current = journeyHereCard(home, { template, item }, { p1: 'Research' }, 'all', 'p1');
  assert.match(current, /data-journey-toggle="milestone:m1" aria-expanded="false"/);
  assert.match(current, /data-journey-details hidden[\s\S]*Review the question/);
});

test('disclosures toggle independently and synchronize both copies of a milestone', () => {
  state.journeyExpanded = {};
  function button(key) {
    const details = { hidden: true };
    const attributes = { 'aria-expanded': 'false' };
    return {
      dataset: { journeyToggle: key },
      details,
      getAttribute(name) { return attributes[name]; },
      setAttribute(name, value) { attributes[name] = value; },
      closest() { return { querySelector() { return details; } }; },
      addEventListener(event, callback) { this.click = callback; },
    };
  }
  const first = button('milestone:m1');
  const duplicate = button('milestone:m1');
  const other = button('todo:todo1');
  bindJourneyDisclosures({ querySelectorAll() { return [first, duplicate, other]; } });
  first.click();
  assert.equal(first.details.hidden, false);
  assert.equal(duplicate.details.hidden, false);
  assert.equal(duplicate.getAttribute('aria-expanded'), 'true');
  assert.equal(other.details.hidden, true);
  assert.match(renderJourneyMilestone(home, template, item, null), /aria-expanded="true"[\s\S]*data-journey-details>/);
  duplicate.click();
  assert.equal(first.details.hidden, true);
  assert.equal(first.getAttribute('aria-expanded'), 'false');
  assert.equal(state.journeyExpanded['milestone:m1'], undefined);
  other.click();
  state.editingTodo = 'todo1';
  assert.match(renderJourneyTodo(todo), /aria-expanded="true"[\s\S]*data-todo-title/);
});

test('a different student or view starts collapsed after a repaint', () => {
  const host = { id: 'journey-module', innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  state.journeySync = {};
  state.journeyFilters = { phaseId: 'all', showSystem: true, showStudent: true };
  state.journeyDisclosureIdentity = '';
  paintStudentJourney(home, host);
  state.journeyExpanded['milestone:m1'] = true;
  paintStudentJourney(home, host);
  assert.match(host.innerHTML, /data-journey-toggle="milestone:m1" aria-expanded="true"/);
  paintStudentJourney({ ...home, email: 'another@example.com' }, host);
  assert.match(host.innerHTML, /data-journey-toggle="milestone:m1" aria-expanded="false"/);
  state.journeyExpanded['milestone:m1'] = true;
  paintStudentJourney({ ...home, staffView: false }, host);
  assert.match(host.innerHTML, /data-journey-toggle="milestone:m1" aria-expanded="false"/);
});
