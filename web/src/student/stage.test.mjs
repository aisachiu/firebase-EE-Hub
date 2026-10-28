import assert from 'node:assert/strict';
import test from 'node:test';
import { groupModules, modulesFor, pathwayStage } from './stage.js';

function homeWithDone(done, total) {
  const templates = [];
  const actionItems = [];
  for (let index = 0; index < total; index += 1) {
    templates.push({ milestoneId: 'm' + index });
    if (index < done) actionItems.push({ CreatorType: 'System', Status: 'Completed', TemplateId: 'm' + index });
  }
  return { templates: templates, actionItems: actionItems };
}

test('pathway stage follows how much of the official journey is done', () => {
  assert.equal(pathwayStage(homeWithDone(0, 3)), 'early');
  assert.equal(pathwayStage(homeWithDone(1, 3)), 'mid');
  assert.equal(pathwayStage(homeWithDone(2, 3)), 'late');
  assert.equal(pathwayStage({ templates: [], actionItems: [] }), 'early');
});

test('module order and slots come from the stage config', () => {
  assert.deepEqual(modulesFor('journey', 'early').map((entry) => entry.id), ['milestones', 'research', 'meetingNotes']);
  assert.deepEqual(modulesFor('journey', 'mid').map((entry) => entry.id), ['milestones', 'meetingNotes', 'research']);
  assert.equal(modulesFor('journey', 'late').find((entry) => entry.id === 'research').slot, 'compact');
  assert.equal(modulesFor('document', 'early')[0].id, 'document');
  assert.equal(modulesFor('document', 'early')[0].slot, 'primary');
  assert.equal(modulesFor('supervisor', 'mid')[0].id, 'communication');
  ['early', 'mid', 'late'].forEach((stage) => {
    assert.ok(modulesFor('journey', stage).some((entry) => entry.id === 'research' && entry.slot !== 'hidden'));
  });
});

test('grouping follows config order and drops hidden modules', () => {
  const grouped = groupModules([
    { id: 'research', slot: 'primary' },
    { id: 'meetingNotes', slot: 'hidden' },
    { id: 'milestones', slot: 'secondary' },
    { id: 'supervisor', slot: 'compact' },
  ]);
  assert.deepEqual(grouped.primary.map((entry) => entry.id), ['research']);
  assert.deepEqual(grouped.secondary.map((entry) => entry.id), ['milestones', 'supervisor']);
});
