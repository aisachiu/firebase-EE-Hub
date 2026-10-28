import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webSrc = path.join(root, 'web/src');
const roleDirs = new Set(['admin', 'allocation', 'staff', 'student']);
const allowedFunctionEntries = new Set([
  'functions/src/allocationPure.ts',
  'functions/src/collectionsRegistry.ts',
  'functions/src/workspaceSheetHelp.ts',
]);

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  });
  return out;
}

function specifiers(source) {
  const found = [];
  const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s+['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = fromRe.exec(source))) found.push({ spec: match[1], dynamic: false });
  while ((match = bareRe.exec(source))) found.push({ spec: match[1], dynamic: false });
  while ((match = dynamicRe.exec(source))) found.push({ spec: match[1], dynamic: true });
  return found;
}

function areaOf(fromFile, spec) {
  if (!spec.startsWith('.')) return '';
  const resolved = path.normalize(path.join(path.dirname(fromFile), spec));
  const relative = path.relative(webSrc, resolved);
  return relative.split(path.sep)[0];
}

test('student screens do not import staff, admin, or allocation', function() {
  const violations = [];
  walk(path.join(webSrc, 'student'), []).forEach(function(file) {
    specifiers(fs.readFileSync(file, 'utf8')).forEach(function(item) {
      if (item.dynamic) return;
      const area = areaOf(file, item.spec);
      if (area === 'staff' || area === 'admin' || area === 'allocation') {
        violations.push(path.relative(root, file) + ' imports ' + item.spec);
      }
    });
  });
  assert.deepEqual(violations, []);
});

test('the shell does not statically import a role screen', function() {
  const shellFiles = ['shell.js', 'navigation.js', 'shared/sessionChrome.js', 'shared/headerCohorts.js'];
  const violations = [];
  shellFiles.forEach(function(relative) {
    const file = path.join(webSrc, relative);
    specifiers(fs.readFileSync(file, 'utf8')).forEach(function(item) {
      if (item.dynamic) return;
      if (roleDirs.has(areaOf(file, item.spec))) violations.push(relative + ' imports ' + item.spec);
    });
  });
  assert.deepEqual(violations, []);
});

test('shared modules stay out of role screens except the coordinator table helper', function() {
  const allowed = new Set(['web/src/shared/tables.js']);
  const violations = [];
  walk(path.join(webSrc, 'shared'), []).forEach(function(file) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    specifiers(fs.readFileSync(file, 'utf8')).forEach(function(item) {
      if (item.dynamic) return;
      const area = areaOf(file, item.spec);
      if (!roleDirs.has(area)) return;
      if (allowed.has(relative) && item.spec === '../admin/google.js') return;
      violations.push(relative + ' imports ' + item.spec);
    });
  });
  assert.deepEqual(violations, []);
});

test('the browser may import only the pure function helpers', function() {
  const violations = [];
  walk(webSrc, []).forEach(function(file) {
    specifiers(fs.readFileSync(file, 'utf8')).forEach(function(item) {
      if (!item.spec.includes('functions/src/')) return;
      const normalized = item.spec.replace(/\\/g, '/');
      const allowed = Array.from(allowedFunctionEntries).some(function(entry) {
        return normalized.endsWith(entry);
      });
      if (!allowed) violations.push(path.relative(root, file) + ' imports ' + item.spec);
    });
  });
  assert.deepEqual(violations, []);
});

test('shared function helpers do not import Node or Firebase packages', function() {
  const pending = Array.from(allowedFunctionEntries).map(function(relative) {
    return path.join(root, relative);
  });
  const seen = new Set();
  const violations = [];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    specifiers(source).forEach(function(item) {
      if (!item.spec.startsWith('.')) {
        violations.push(path.relative(root, file) + ' imports ' + item.spec);
        return;
      }
      const next = path.normalize(path.join(path.dirname(file), item.spec));
      const withTs = fs.existsSync(next + '.ts') ? next + '.ts' : next;
      if (!withTs.startsWith(path.join(root, 'functions/src') + path.sep)) {
        violations.push(path.relative(root, file) + ' reaches ' + item.spec);
        return;
      }
      pending.push(withTs);
    });
  }
  assert.deepEqual(violations, []);
});
