import { updateDriveNamePreview } from '../admin/google.js';
import { escapeHtml } from './html.js';
import { state } from './state.js';

export function adminSortState(tableId) {
  if (!state.adminTableSort[tableId]) state.adminTableSort[tableId] = { key: '', dir: 1 };
  return state.adminTableSort[tableId];
}

export function toggleAdminSort(tableId, key) {
  const sort = adminSortState(tableId);
  if (sort.key === key) sort.dir = sort.dir === 1 ? -1 : 1;
  else {
    sort.key = key;
    sort.dir = 1;
  }
}

export function sortGlyph(tableId, key) {
  const sort = adminSortState(tableId);
  if (sort.key !== key) return '';
  return sort.dir === -1 ? ' ↓' : ' ↑';
}

export function ariaSortValue(tableId, key) {
  const sort = adminSortState(tableId);
  if (sort.key !== key) return 'none';
  return sort.dir === -1 ? 'descending' : 'ascending';
}

export function sortableHeader(tableId, key, label) {
  return `<th scope="col" aria-sort="${ariaSortValue(tableId, key)}"><button type="button" class="sort-button" data-sort-table="${escapeHtml(tableId)}" data-sort-key="${escapeHtml(key)}">${escapeHtml(label)}${sortGlyph(tableId, key)}</button></th>`;
}

export function bindSortableHeaders(root, onSort) {
  if (!root) return;
  root.querySelectorAll('[data-sort-table]').forEach(function(button) {
    button.addEventListener('click', function() {
      toggleAdminSort(button.getAttribute('data-sort-table'), button.getAttribute('data-sort-key'));
      onSort();
    });
  });
}

export function isSortEmpty(value) {
  return value === null || value === undefined || value === '';
}

export function sortNumber(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function sortTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const time = Date.parse(value);
  return isNaN(time) ? null : time;
}

export function compareSortValues(left, right, dir) {
  const direction = dir === -1 ? -1 : 1;
  if (isSortEmpty(left) && isSortEmpty(right)) return 0;
  if (isSortEmpty(left)) return 1;
  if (isSortEmpty(right)) return -1;
  const aNum = sortNumber(left);
  const bNum = sortNumber(right);
  if (aNum !== null && bNum !== null) return (aNum - bNum) * direction;
  const aTime = sortTime(left);
  const bTime = sortTime(right);
  if (aTime !== null && bTime !== null) return (aTime - bTime) * direction;
  return String(left).toLowerCase().localeCompare(String(right).toLowerCase(), undefined, { numeric: true, sensitivity: 'base' }) * direction;
}

export function sortByKey(items, getValue, dir) {
  return items.slice().sort(function(left, right) {
    return compareSortValues(getValue(left), getValue(right), dir);
  });
}

export function sortedRows(tableId, rows, valueOf) {
  const sort = adminSortState(tableId);
  if (!sort.key) return rows.slice();
  return sortByKey(rows, function(row) { return valueOf(row, sort.key); }, sort.dir);
}

export function headerOpen(id) {
  if (!Object.prototype.hasOwnProperty.call(state.adminHeaderOpen, id)) return true;
  return state.adminHeaderOpen[id] !== false;
}

export function collapsibleHeader(id, title, bodyHtml) {
  const open = headerOpen(id);
  return `<section class="table-header" data-table-header="${escapeHtml(id)}">
    <div class="table-header-bar"><h2>${escapeHtml(title)}</h2><button type="button" class="button secondary" data-toggle-header="${escapeHtml(id)}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Hide' : 'Show'}</button></div>
    <div class="table-header-body"${open ? '' : ' hidden'}>${bodyHtml}</div>
  </section>`;
}

export function bindCollapsibleHeaders(root) {
  if (!root) return;
  root.querySelectorAll('[data-toggle-header]').forEach(function(button) {
    button.addEventListener('click', function() {
      const id = button.getAttribute('data-toggle-header');
      const open = !headerOpen(id);
      state.adminHeaderOpen[id] = open;
      const section = button.closest('[data-table-header]');
      const body = section ? section.querySelector('.table-header-body') : null;
      if (body) body.hidden = !open;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.textContent = open ? 'Hide' : 'Show';
    });
  });
}

export function updateSelectedCount() {
  const count = document.getElementById('selected-count');
  const action = document.getElementById('create-selected-users');
  const selectAll = document.getElementById('select-all-members');
  const selectable = Array.from(document.querySelectorAll('[data-select-member]:not(:disabled)'));
  if (count) count.textContent = state.selectedMemberIds.length + ' selected';
  if (action) action.disabled = state.selectedMemberIds.length === 0;
  if (selectAll) selectAll.checked = selectable.length > 0 && selectable.every(function(input) { return input.checked; });
  const driveDisabled = !state.driveSettingsLoaded || state.driveBusy || state.selectedMemberIds.length === 0;
  const checkDrive = document.getElementById('check-drive-folders');
  const updateDrive = document.getElementById('update-drive-folders');
  if (checkDrive) checkDrive.disabled = driveDisabled;
  if (updateDrive) updateDrive.disabled = driveDisabled;
  updateDriveNamePreview();
}

export function staffNameMatch(name, email, query) {
  if (!query) return true;
  return String(name || '').toLowerCase().indexOf(query) >= 0 || String(email || '').toLowerCase().indexOf(query) >= 0;
}

export function mergeSelection(selected, visible, checked) {
  const shown = {};
  visible.forEach(function(email) { shown[email] = true; });
  const kept = selected.filter(function(email) { return !shown[email]; });
  if (!checked) return kept;
  visible.forEach(function(email) {
    if (kept.indexOf(email) < 0) kept.push(email);
  });
  return kept;
}
