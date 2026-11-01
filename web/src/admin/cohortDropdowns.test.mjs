import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const adminDir = path.dirname(fileURLToPath(import.meta.url));

function source(name) {
  return fs.readFileSync(path.join(adminDir, name), 'utf8');
}

test('admin pages do not render their own cohort dropdowns', function() {
  const files = fs.readdirSync(adminDir).filter((name) => name.endsWith('.js'));
  const hits = [];
  files.forEach((name) => {
    const text = source(name);
    const match = text.match(/<select[^>]*id="[^"]*cohort[^"]*"/i);
    if (match) hits.push(name + ' ' + match[0]);
    ['assignment-cohort', 'admin-cohort', 'quota-cohort', 'notice-cohort', 'plan-cohort', 'import-cohort'].forEach((id) => {
      if (text.includes('id="' + id + '"')) hits.push(name + ' still has ' + id);
    });
  });
  assert.deepEqual(hits, []);
});

test('the assignments admin screen is now Student Tasks backed by studentActionItems', function() {
  const sections = source('sections.js');
  const tasks = source('studentTasks.js');
  const records = source('records.js');
  assert.match(sections, /\['studentTasks', 'Student Tasks'\]/);
  assert.doesNotMatch(sections, /Assignments/);
  assert.match(tasks, /listStudentTasks/);
  assert.match(tasks, /adoptGlobalCohort/);
  assert.match(records, /saveStudentTask/);
  assert.match(records, /deleteStudentTask/);
  assert.equal(fs.existsSync(path.join(adminDir, 'assignments.js')), false);
});
