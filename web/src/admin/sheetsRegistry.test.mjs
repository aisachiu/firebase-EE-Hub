import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sheets.js');

test('the sheets screen takes its collections from the shared registry', function() {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /from ['"]\.\.\/\.\.\/\.\.\/functions\/src\/collectionsRegistry\.ts['"]/);
  assert.match(source, /sheetChoiceModels\(/);
  assert.doesNotMatch(source, /milestoneTemplates/);
  assert.doesNotMatch(source, /auditLogs/);
  assert.doesNotMatch(source, /functionSecrets/);
});
