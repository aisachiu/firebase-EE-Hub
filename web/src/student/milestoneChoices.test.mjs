import assert from 'node:assert/strict';
import test from 'node:test';
import { commonMilestoneChoices } from './milestoneChoices.js';

const home = {
  templates: [
    { milestoneId: 'm1', title: 'Subject preference' },
    { milestoneId: 'm2', title: 'Research question' },
  ],
};

test('a cohort milestone is shared even when the selected students have no stored task yet', () => {
  const students = [
    { email: 'a@vsa.example.edu', assigned: [] },
    { email: 'b@vsa.example.edu', assigned: [] },
  ];
  assert.deepEqual(commonMilestoneChoices(home, students).map((choice) => choice.id), ['m1', 'm2']);
  assert.deepEqual(commonMilestoneChoices(home, [students[0]]).map((choice) => choice.title), ['Subject preference', 'Research question']);
});

test('an extra milestone is listed only when every selected student has it', () => {
  const students = [
    { assigned: [{ templateId: 'm1', title: 'Subject preference' }, { templateId: 'custom', title: 'Extra' }] },
    { assigned: [{ templateId: 'custom', title: 'Extra' }] },
  ];
  const ids = commonMilestoneChoices(home, students).map((choice) => choice.id);
  assert.deepEqual(ids, ['m1', 'm2', 'custom']);
  const one = commonMilestoneChoices({ templates: [] }, [students[0]]).map((choice) => choice.id);
  assert.deepEqual(one, ['m1', 'custom']);
});
