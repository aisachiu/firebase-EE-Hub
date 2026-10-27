import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLECTIONS_REGISTRY, sheetChoiceModels, sheetCollectionRejection } from './collectionsRegistry';
import { APP_TABLES, COLLECTIONS } from './schema';

test('the sheet registry is the allowlist for import and export', () => {
  const ids = COLLECTIONS_REGISTRY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  COLLECTIONS_REGISTRY.forEach((entry) => {
    if (COLLECTIONS[entry.id]) assert.equal(entry.collectionId, COLLECTIONS[entry.id]);
    assert.equal(entry.exportable || entry.importable, true);
  });
  Object.keys(APP_TABLES).forEach((entity) => {
    assert.equal(sheetCollectionRejection(entity, 'export'), null);
  });
  assert.equal(sheetCollectionRejection('formResponses', 'import'), null);
  assert.equal(sheetCollectionRejection('cohortMembers', 'import'), null);
  assert.equal(sheetCollectionRejection('ticketMessages', 'import'), null);
  assert.equal(sheetCollectionRejection('auditLogs', 'export'), null);
  assert.match(sheetCollectionRejection('auditLogs', 'import') || '', /Audit logs/);
  ['docWordLogs', 'notificationRules', 'notificationSends', 'notificationOverlays', 'functionSecrets'].forEach((id) => {
    assert.match(sheetCollectionRejection(id, 'export') || '', /not registered/);
    assert.match(sheetCollectionRejection(id, 'import') || '', /not registered/);
  });

  const choices = sheetChoiceModels({ phases: 4, functionSecrets: 9, auditLogs: 2 });
  assert.equal(choices.find((item) => item.id === 'phases')?.count, 4);
  assert.equal(choices.find((item) => item.id === 'phases')?.label, 'Phases');
  assert.equal(choices.find((item) => item.id === 'phases')?.recommended, true);
  assert.equal(choices.find((item) => item.id === 'milestoneTemplates')?.recommended, true);
  assert.equal(choices.find((item) => item.id === 'auditLogs')?.exportOnly, true);
  assert.equal(choices.find((item) => item.id === 'auditLogs')?.count, 2);
  assert.equal(choices.find((item) => item.id === 'functionSecrets'), undefined);
  assert.equal(choices.find((item) => item.id === 'docWordLogs'), undefined);
  assert.deepEqual(choices.map((item) => item.id), ids);
});
