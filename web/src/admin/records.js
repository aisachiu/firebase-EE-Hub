import { updateDriveNamePreview } from './google.js';
import {
  cohortProvisionFilterControl,
  cohortProvisionSelectionActions,
  matchesProvisionFilter,
  memberIdsForProvision,
  provisioningSortValue,
  workspaceCellHtml,
} from './provisioning.js';
import { refreshAdminSectionSilently, sectionLabel, singularSection } from './sections.js';
import { bindStaffPane, renderStaffRecords, staffSectionNav } from './staff.js';
import { callServer, runMutation } from '../shared/api.js';
import { subjectList } from '../shared/checks.js';
import { showError } from '../shared/feedback.js';
import { cssEscape, escapeHtml, formatValue, hexColour, toBoolean } from '../shared/html.js';
import { renderResourceCard } from '../shared/resources.js';
import { registerMemberEditorCloser } from '../shared/sessionChrome.js';
import { state } from '../shared/state.js';
import {
  bindCollapsibleHeaders,
  bindSortableHeaders,
  collapsibleHeader,
  mergeSelection,
  sortableHeader,
  sortedRows,
  updateSelectedCount,
} from '../shared/tables.js';

export function listingDialogKind(kind) {
  return kind === 'admin-record' || kind === 'notice-rule' || kind === 'cohort-token' || kind === 'assignment-anchor' || kind === 'pathway-anchor' || kind === 'allocation-data';
}

export function adminDialogKind() {
  const dialog = document.getElementById('form-dialog');
  return dialog && !dialog.hidden ? (dialog.dataset.editor || '') : '';
}

export function onAdminDialogKeydown(event) {
  if (event.key !== 'Escape') return;
  if (!listingDialogKind(adminDialogKind())) return;
  event.preventDefault();
  closeAdminDialog();
}

export function closeAdminDialog() {
  const dialog = document.getElementById('form-dialog');
  const kind = adminDialogKind();
  if (!listingDialogKind(kind)) {
    memberEditorReturn = null;
    return;
  }
  document.removeEventListener('keydown', onAdminDialogKeydown);
  if (kind === 'admin-record') {
    state.editingRecord = null;
    state.originalKey = '';
  } else if (kind === 'notice-rule') state.noticeEdit = null;
  else if (kind === 'cohort-token') state.tokenEditId = '';
  dialog.hidden = true;
  dialog.innerHTML = '';
  delete dialog.dataset.editor;
  dialog.onclick = null;
  const back = memberEditorReturn;
  memberEditorReturn = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
}

export function openAdminDialog(kind, markup) {
  const dialog = document.getElementById('form-dialog');
  if (!dialog) return;
  const active = document.activeElement;
  if (active && active !== document.body && !dialog.contains(active)) memberEditorReturn = active;
  dialog.hidden = false;
  dialog.dataset.editor = kind;
  dialog.innerHTML = markup;
  dialog.onclick = function(event) {
    if (event.target === dialog) closeAdminDialog();
  };
  dialog.querySelectorAll('[data-close-admin-dialog]').forEach(function(button) {
    button.addEventListener('click', closeAdminDialog);
  });
  document.removeEventListener('keydown', onAdminDialogKeydown);
  document.addEventListener('keydown', onAdminDialogKeydown);
  const first = dialog.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
    || dialog.querySelector('button:not([disabled])');
  if (first) first.focus();
}

export function closeMemberEditor() {
  if (listingDialogKind(adminDialogKind())) closeAdminDialog();
  else memberEditorReturn = null;
}

registerMemberEditorCloser(closeMemberEditor);

export function adminFieldSortValue(field, record) {
  const value = record[field.name];
  if (field.type === 'checkbox' || typeof value === 'boolean') return toBoolean(value) ? 1 : 0;
  if (field.type === 'number') {
    if (value === '' || value === null || value === undefined) return '';
    const number = Number(value);
    return isNaN(number) ? '' : number;
  }
  if (field.type === 'date') return String(value || '').slice(0, 10);
  if (field.type === 'checks') return subjectList(value).join(', ');
  if (field.type === 'select' || (field.options && field.options.length)) return displayField(field, record);
  return value === null || value === undefined ? '' : value;
}

export function renderAdminData(data, options) {
  if (state.adminEntity === 'staffUsers' && state.staffPane !== 'quotas') {
    renderStaffRecords(data);
    return;
  }
  state.adminData = data;
  const target = document.getElementById('admin-records') || document.getElementById('admin-content');
  if (!target) return;
  const entity = state.adminEntity;
  const schemaFields = data.schema && data.schema.fields ? data.schema.fields : (data.headers || []).map(function(name) { return { name: name }; });
  const records = data.records || [];
  const columns = schemaFields.filter(function(field) { return field.table !== false; });
  const preserveSelection = !!(options && options.preserveSelection);
  if (entity === 'cohortMembers' && !preserveSelection) state.selectedMemberIds = [];
  const isCohortMembers = entity === 'cohortMembers';
  const addLabel = singularSection(sectionLabel(entity));
  const staffNav = entity === 'staffUsers' ? staffSectionNav() : '';
  const tableId = 'admin:' + entity;
  const indexed = records.map(function(record, index) { return { record: record, index: index }; });
  const filtered = isCohortMembers
    ? indexed.filter(function(item) { return matchesProvisionFilter(item.record, state.memberProvisionFilter); })
    : indexed;
  const sorted = sortedRows(tableId, filtered, function(item, key) {
    if (key === 'workspace') return provisioningSortValue(item.record);
    const field = columns.filter(function(column) { return column.name === key; })[0];
    return field ? adminFieldSortValue(field, item.record) : '';
  });
  const shownCount = isCohortMembers && state.memberProvisionFilter !== 'all'
    ? `${filtered.length} shown · ${records.length} record${records.length === 1 ? '' : 's'}`
    : `${records.length} record${records.length === 1 ? '' : 's'}`;
  const selectionHeader = isCohortMembers ? collapsibleHeader('cohort-member-selection', 'Selection and import', `<div class="toolbar"><button type="button" class="button secondary" id="open-roster-import">Import CSV / paste</button><button type="button" class="button secondary" id="create-selected-users" disabled>Add selected as users</button>${cohortProvisionSelectionActions()}<label><input type="checkbox" id="select-all-members"> Select all</label><span id="selected-count" class="muted">0 selected</span></div>`) : '';
  const categoryNote = entity === 'ticketCategories' ? '<p class="lede">These names are the choices a student sees when they send a message. Who they message sends it to that student\'s supervisor or to the EE Coordinator.</p>' : '';
  const filterControl = isCohortMembers ? cohortProvisionFilterControl(state.memberProvisionFilter) : '';
  const colourAction = entity === 'subjects' ? '<button type="button" class="button secondary" id="auto-subject-colours">Auto Apply Colours</button>' : '';
  target.innerHTML = `${staffNav}${categoryNote}<div class="toolbar"><button type="button" class="button" id="new-record">Add ${escapeHtml(addLabel)}</button>${colourAction}${filterControl}<span class="muted">${shownCount}</span></div>
    ${selectionHeader}
    ${state.status ? `<p class="status">${escapeHtml(state.status)}</p>` : ''}
    ${sorted.length ? `<div class="table-wrap"><table><thead><tr>${isCohortMembers ? '<th scope="col"><span class="sr-only">Select</span></th>' : ''}${columns.map(function(field) { return sortableHeader(tableId, field.name, field.label || field.name); }).join('')}${isCohortMembers ? sortableHeader(tableId, 'workspace', 'Workspace') : ''}<th scope="col">Actions</th></tr></thead><tbody>${sorted.map(function(item) {
      const record = item.record;
      const index = item.index;
      const selected = isCohortMembers && state.selectedMemberIds.indexOf(record.StudentId) >= 0;
      return `<tr>${isCohortMembers ? `<td><input type="checkbox" data-select-member value="${escapeHtml(record.StudentId)}" ${selected ? 'checked' : ''} ${record.hasStudentIdConflict ? 'disabled title="Resolve Student Number conflicts first"' : ''}></td>` : ''}${columns.map(function(field) { return `<td>${escapeHtml(displayField(field, record))}</td>`; }).join('')}${isCohortMembers ? `<td>${workspaceCellHtml(record)}</td>` : ''}<td><div class="actions"><button type="button" class="link-button" data-edit="${index}" ${record.hasStudentIdConflict ? 'disabled title="Reconcile duplicate Student Number values first"' : ''}>Edit</button><button type="button" class="link-button" data-delete="${index}">Delete</button></div>${record.hasStudentIdConflict ? '<div class="notice">Duplicate Student Number values disagree.</div>' : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : `<div class="empty">${records.length ? 'No students match this workspace filter.' : 'No records yet.'}</div>`}
    <div id="roster-import-panel"></div>`;
  document.getElementById('new-record').addEventListener('click', function() { openEditor(null); });
  const autoColours = document.getElementById('auto-subject-colours');
  if (autoColours) autoColours.addEventListener('click', function() {
    if (!window.confirm('Replace the colour on every subject with colours spaced evenly across the spectrum?')) return;
    const order = sorted.map(function(item) {
      const id = item.record && item.record['Subject ID'];
      return id ? String(id) : '';
    }).filter(Boolean);
    autoColours.disabled = true;
    runMutation('autoApplySubjectColours', [order], { key: 'subjects:colours' }).then(function(result) {
      state.status = 'Applied colours to ' + (result && result.updated ? result.updated : 0) + ' subjects.';
      refreshAdminSectionSilently();
    }).catch(function(error) {
      autoColours.disabled = false;
      showError(error);
    });
  });
  bindSortableHeaders(target, function() { renderAdminData(state.adminData, { preserveSelection: true }); });
  bindCollapsibleHeaders(target);
  if (entity === 'staffUsers') bindStaffPane(target);
  if (isCohortMembers) {
    document.getElementById('open-roster-import').addEventListener('click', openRosterImport);
    document.getElementById('create-selected-users').addEventListener('click', createSelectedUsers);
    document.getElementById('clear-workspace-data').addEventListener('click', clearSelectedWorkspaceData);
    document.getElementById('select-missing-folder').addEventListener('click', function() { selectMembersByProvision('missing-folder'); });
    document.getElementById('select-missing-doc').addEventListener('click', function() { selectMembersByProvision('missing-doc'); });
    document.getElementById('select-provisioned').addEventListener('click', function() { selectMembersByProvision('ready'); });
    const provisionFilter = document.getElementById('member-provision-filter');
    if (provisionFilter) provisionFilter.addEventListener('change', function(event) {
      state.memberProvisionFilter = event.target.value || 'all';
      renderAdminData(state.adminData, { preserveSelection: true });
    });
    document.getElementById('select-all-members').addEventListener('change', function(event) {
      const visible = Array.from(target.querySelectorAll('[data-select-member]:not(:disabled)')).map(function(input) { return input.value; });
      state.selectedMemberIds = mergeSelection(state.selectedMemberIds, visible, event.target.checked);
      target.querySelectorAll('[data-select-member]').forEach(function(input) { input.checked = state.selectedMemberIds.indexOf(input.value) >= 0; });
      updateSelectedCount();
    });
    target.querySelectorAll('[data-select-member]').forEach(function(input) {
      input.addEventListener('change', function() {
        const visible = Array.from(target.querySelectorAll('[data-select-member]')).map(function(item) { return item.value; });
        const checked = Array.from(target.querySelectorAll('[data-select-member]:checked')).map(function(item) { return item.value; });
        const kept = mergeSelection(state.selectedMemberIds, visible, false);
        checked.forEach(function(id) {
          if (kept.indexOf(id) < 0) kept.push(id);
        });
        state.selectedMemberIds = kept;
        updateSelectedCount();
      });
    });
    updateSelectedCount();
  }
  target.querySelectorAll('[data-edit]').forEach(function(button) {
    button.addEventListener('click', function() { openEditor(records[Number(button.dataset.edit)]); });
  });
  target.querySelectorAll('[data-delete]').forEach(function(button) {
    button.addEventListener('click', function() { removeRecord(records[Number(button.dataset.delete)]); });
  });
  if (state.editingRecord && adminDialogKind() !== 'admin-record') openEditor(state.editingRecord.record, true);
  updateDriveNamePreview();
}

export function openRosterImport() {
  const panel = document.getElementById('roster-import-panel');
  state.importRecords = null;
  const requiredHeaders = (state.adminData.schema.fields || []).filter(function(field) { return field.required; }).map(function(field) { return field.name; });
  panel.innerHTML = `<section class="editor"><h2>Import cohort students</h2>
    <div class="toolbar"><label class="button secondary" for="roster-file">Choose CSV</label><input id="roster-file" type="file" accept=".csv,text/csv" hidden></div>
    <div class="field"><label for="roster-source">Roster data</label><textarea id="roster-source" placeholder="${escapeHtml(requiredHeaders.join(', '))}"></textarea></div>
    <div class="toolbar"><button type="button" class="button secondary" id="preview-roster">Preview</button><button type="button" class="button secondary" id="cancel-roster-import">Cancel</button></div>
    <div id="roster-preview"></div></section>`;
  const source = document.getElementById('roster-source');
  document.getElementById('roster-file').addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (file) file.text().then(function(text) { source.value = text; state.importRecords = null; });
  });
  document.getElementById('preview-roster').addEventListener('click', previewRosterImport);
  document.getElementById('cancel-roster-import').addEventListener('click', function() {
    panel.innerHTML = '';
    state.importRecords = null;
  });
}

export function canonicalRosterHeader(header) {
  if (header === 'Student ID') return 'Student Number';
  if (header === 'studentEmail') return 'Student Email';
  return header;
}

export function parseRosterText(sourceText, requiredHeaders) {
  const firstLine = String(sourceText).split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.indexOf('\t') >= 0 ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(sourceText).replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      row.push(field);
      field = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(field);
      if (row.some(function(value) { return value.trim() !== ''; })) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('A quoted field is not closed.');
  row.push(field);
  if (row.some(function(value) { return value.trim() !== ''; })) rows.push(row);
  if (rows.length < 2) throw new Error('Include a header row and at least one student.');

  const headers = rows.shift().map(function(value) { return canonicalRosterHeader(value.trim()); });
  if (headers.some(function(header) { return !header; })) throw new Error('Every column needs a header.');
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate column headers are ambiguous.');
  (requiredHeaders || []).forEach(function(header) {
    if (headers.indexOf(header) < 0) throw new Error('Missing required column: ' + header);
  });
  return rows.map(function(values, index) {
    if (values.length > headers.length) throw new Error('Row ' + (index + 2) + ' has more values than headers.');
    const record = {};
    headers.forEach(function(header, column) { record[header] = (values[column] || '').trim(); });
    return record;
  });
}

export function previewRosterImport() {
  const preview = document.getElementById('roster-preview');
  try {
    const requiredHeaders = (state.adminData.schema.fields || []).filter(function(field) { return field.required; }).map(function(field) { return field.name; });
    state.importRecords = parseRosterText(document.getElementById('roster-source').value, requiredHeaders);
    const sample = state.importRecords.slice(0, 8);
    const previewFields = (state.adminData.schema.fields || []).filter(function(field) { return field.required; }).slice(0, 3);
    preview.innerHTML = `<p class="muted">${state.importRecords.length} rows ready to import to cohort ${escapeHtml(state.cohortId)}.</p>
      <div class="table-wrap"><table><thead><tr>${previewFields.map(function(field) { return `<th>${escapeHtml(field.label || field.name)}</th>`; }).join('')}</tr></thead><tbody>${sample.map(function(record) {
        return `<tr>${previewFields.map(function(field) { return `<td>${escapeHtml(record[field.name])}</td>`; }).join('')}</tr>`;
      }).join('')}</tbody></table></div>
      <div class="toolbar"><button type="button" class="button" id="confirm-roster-import">Import ${state.importRecords.length} students</button></div>`;
    document.getElementById('confirm-roster-import').addEventListener('click', confirmRosterImport);
  } catch (error) {
    state.importRecords = null;
    preview.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
  }
}

export function confirmRosterImport(event) {
  const button = event.currentTarget;
  button.disabled = true;
  runMutation('importCohortMembers', [state.cohortId, state.importRecords], { key: 'cohort-members:' + state.cohortId }).then(function(result) {
    state.status = 'Imported ' + result.imported + ' students.';
    state.importRecords = null;
    document.getElementById('roster-import-panel').innerHTML = '';
    refreshAdminSectionSilently();
  }).catch(function(error) {
    button.disabled = false;
    showError(error);
  });
}

export function selectMembersByProvision(mode) {
  const records = (state.adminData && state.adminData.records) || [];
  state.memberProvisionFilter = mode === 'ready' ? 'ready' : mode;
  state.selectedMemberIds = memberIdsForProvision(records, mode);
  renderAdminData(state.adminData, { preserveSelection: true });
}

export function clearSelectedWorkspaceData() {
  const button = document.getElementById('clear-workspace-data');
  if (!state.selectedMemberIds.length || state.driveBusy || state.isProvisioning) return;
  if (!window.confirm('Clear the saved EE folder and EE document links for the selected students? Files already in Google Drive stay where they are.')) return;
  if (button) button.disabled = true;
  runMutation('clearCohortWorkspaceLinks', [state.cohortId, state.selectedMemberIds.slice()], { key: 'clear-workspace:' + state.cohortId }).then(function(result) {
    const cleared = result && typeof result.cleared === 'number' ? result.cleared : 0;
    state.status = 'Cleared Google Workspace links for ' + cleared + ' student' + (cleared === 1 ? '' : 's') + '.';
    state.selectedMemberIds = [];
    refreshAdminSectionSilently();
  }).catch(function(error) {
    if (button) button.disabled = false;
    showError(error);
  });
}

export function createSelectedUsers() {
  const button = document.getElementById('create-selected-users');
  if (!state.selectedMemberIds.length || !window.confirm('Add the selected students as user accounts? Existing accounts stay, and their Student Number and Student Email are updated from the cohort.')) return;
  button.disabled = true;
  runMutation('createStudentUsersFromCohort', [state.cohortId, state.selectedMemberIds], { key: 'cohort-users:' + state.cohortId }).then(function(result) {
    state.status = result.created + ' user accounts added; ' + result.alreadyExists + ' already existed.';
    state.selectedMemberIds = [];
    refreshAdminSectionSilently();
  }).catch(function(error) {
    button.disabled = false;
    showError(error);
  });
}

export let memberEditorReturn = null;

export function openEditor(record, preserve) {
  if (state.adminEntity === 'resources') {
    openResourceEditor(record, preserve);
    return;
  }
  const data = state.adminData || { headers: [] };
  const entity = state.adminEntity;
  const fields = data.schema && data.schema.fields ? data.schema.fields : (data.headers || []).map(function(name) { return { name: name }; });
  state.editingRecord = record ? { record: record } : (preserve ? state.editingRecord : null);
  const editing = !!record || !!(preserve && state.originalKey);
  const source = record || (state.editingRecord && state.editingRecord.record) || null;
  state.originalKey = editing ? keyValue(entity, source) : '';
  const studentName = source ? (source['Display Name'] || source.StudentId || '') : '';
  const noun = singularSection(sectionLabel(entity));
  const title = entity === 'cohortMembers'
    ? (editing ? ('Edit ' + (studentName || 'student')) : 'Add student')
    : (editing ? 'Edit ' + noun : 'Add ' + noun);
  const formFields = fields.filter(function(field) { return field.form !== false; }).map(function(field) {
    return fieldMarkup(field, source ? source[field.name] : undefined, editing);
  }).join('');
  const formMarkup = `${entity === 'studentUsers' && !editing ? '<div id="cohort-import"></div>' : ''}
    <form id="record-form"><div class="form-grid">${formFields}</div>
      <p class="notice error" id="member-save-error" hidden></p>
      <div class="toolbar"><button class="button" type="submit">Save</button><button class="button secondary" type="button" id="cancel-edit">Cancel</button></div></form>`;
  openAdminDialog('admin-record', `<div class="form-panel member-editor" role="dialog" aria-modal="true" aria-labelledby="record-editor-title"><div class="toolbar"><h2 id="record-editor-title">${escapeHtml(title)}</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>${formMarkup}</div>`);
  const form = document.getElementById('record-form');
  if (!form) return;
  form.addEventListener('submit', saveForm);
  form.querySelectorAll('[data-colour-picker]').forEach(function(picker) {
    const fieldName = picker.getAttribute('data-colour-picker');
    const textInput = form.querySelector('[data-field="' + cssEscape(fieldName) + '"]');
    picker.addEventListener('input', function() {
      if (textInput) textInput.value = picker.value;
    });
    if (textInput) textInput.addEventListener('input', function() {
      const next = hexColour(textInput.value);
      if (next) picker.value = next;
    });
  });
  document.getElementById('cancel-edit').addEventListener('click', closeAdminDialog);
  if (entity === 'studentUsers' && !editing) renderCohortImport();
}

export function openResourceEditor(record, preserve) {
  const source = record || (preserve && state.editingRecord ? state.editingRecord.record : null);
  const editing = !!source;
  state.editingRecord = source ? { record: source } : null;
  state.originalKey = editing ? keyValue('resources', source) : '';
  const value = function(name, fallback) {
    if (!source || source[name] === undefined || source[name] === null || source[name] === '') return fallback;
    return source[name];
  };
  const audience = value('Audience', 'all');
  const format = String(value('Body Format', 'plain') || 'plain').toLowerCase();
  openAdminDialog('admin-record', `<div class="form-panel member-editor resource-modal" role="dialog" aria-modal="true" aria-labelledby="record-editor-title"><div class="toolbar"><h2 id="record-editor-title">${editing ? 'Edit resource' : 'Add resource'}</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <form id="record-form">${editing ? `<input type="hidden" data-field="Resource ID" value="${escapeHtml(source['Resource ID'] || '')}">` : ''}<div class="resource-editor-layout"><div class="resource-editor-fields"><div class="form-grid">
      <div class="field"><label>Title *</label><input data-field="Title" value="${escapeHtml(value('Title', ''))}" required></div>
      <div class="field"><label>Category</label><input data-field="Category" value="${escapeHtml(value('Category', ''))}"></div>
      <div class="field wide"><label>Description</label><textarea data-field="Description">${escapeHtml(value('Description', ''))}</textarea></div>
      <div class="field"><label>URL</label><input type="url" data-field="URL" value="${escapeHtml(value('URL', ''))}" placeholder="https://"></div>
      <div class="field"><label>Slug</label><input data-field="Slug" value="${escapeHtml(value('Slug', ''))}"></div>
      <div class="field"><label>Audience</label><select data-field="Audience">${['all', 'student', 'staff'].map(function(option) {
        return `<option value="${option}" ${audience === option ? 'selected' : ''}>${option}</option>`;
      }).join('')}</select></div>
      <div class="field"><label>Sort Order</label><input type="number" data-field="Sort Order" value="${escapeHtml(value('Sort Order', ''))}"></div>
      <div class="field"><label>Body format</label><select data-field="Body Format">${[['plain', 'Plain text'], ['markdown', 'Markup'], ['html', 'HTML']].map(function(option) {
        return `<option value="${option[0]}" ${format === option[0] ? 'selected' : ''}>${option[1]}</option>`;
      }).join('')}</select></div>
      <label class="field check"><input type="checkbox" data-field="Published" ${toBoolean(source && source.Published) ? 'checked' : ''}> Published</label>
      <div class="field wide"><label>Body</label><textarea data-field="Body">${escapeHtml(value('Body', ''))}</textarea></div>
    </div>
    <label class="field check"><input type="checkbox" id="live-preview" checked> Live preview</label>
    <p class="notice error" id="resource-save-error" hidden></p></div>
    <aside class="resource-preview"><p class="eyebrow">Preview</p><div id="resource-preview-card"></div></aside></div>
    <div class="toolbar"><button class="button" type="submit">Save</button><button class="button secondary" type="button" id="cancel-edit">Cancel</button></div></form></div>`);
  const form = document.getElementById('record-form');
  if (!form) return;
  form.addEventListener('submit', saveForm);
  document.getElementById('cancel-edit').addEventListener('click', closeAdminDialog);
  const live = document.getElementById('live-preview');
  function paintResourcePreview() {
    const card = document.getElementById('resource-preview-card');
    if (!card || !live || !live.checked) return;
    const draft = {};
    form.querySelectorAll('[data-field]').forEach(function(input) {
      draft[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
    });
    try {
      card.innerHTML = renderResourceCard(draft);
    } catch (error) {
      card.innerHTML = '<p class="notice error">Preview could not render this body.</p>';
    }
  }
  form.addEventListener('input', paintResourcePreview);
  form.addEventListener('change', paintResourcePreview);
  if (live) live.addEventListener('change', paintResourcePreview);
  paintResourcePreview();
}

export function fieldMarkup(field, value, editing) {
  const name = field.name;
  const required = field.required ? 'required' : '';
  const disabled = (editing && field.key) || field.editable === false ? 'disabled' : '';
  const label = field.label || name;
  const wide = field.type === 'textarea' ? 'wide' : '';
  const currentValue = value === undefined || value === null ? (field.defaultValue === undefined ? '' : field.defaultValue) : value;
  if (field.type === 'color') {
    const hex = hexColour(currentValue);
    return `<div class="field"><label>${escapeHtml(label)}</label><div class="colour-field"><input type="color" data-colour-picker="${escapeHtml(name)}" value="${escapeHtml(hex || '#004c80')}" aria-label="${escapeHtml(label)} picker"><input type="text" data-field="${escapeHtml(name)}" value="${escapeHtml(hex)}" placeholder="#004c80" ${disabled}></div></div>`;
  }
  if (field.type === 'checkbox') {
    const checked = toBoolean(currentValue);
    return `<div class="field check"><label><input type="checkbox" data-field="${escapeHtml(name)}" ${checked ? 'checked' : ''} ${disabled}> ${escapeHtml(label)}</label></div>`;
  }
  if (field.type === 'select') {
    const options = field.options || [];
    const blankOption = field.allowBlank ? `<option value="">No prerequisite</option>` : `<option value="">Choose ${escapeHtml(label)}</option>`;
    return `<div class="field"><label>${escapeHtml(label)}${required ? ' *' : ''}</label><select data-field="${escapeHtml(name)}" ${required} ${disabled}>${blankOption}${options.map(function(option) {
      const item = typeof option === 'string' ? { value: option, label: option } : option;
      return `<option value="${escapeHtml(item.value)}" ${String(currentValue) === String(item.value) ? 'selected' : ''}>${escapeHtml(item.label)}</option>`;
    }).join('')}</select></div>`;
  }
  if (field.type === 'checks') {
    const selected = subjectList(currentValue);
    const options = (field.options || []).map(function(option) {
      return typeof option === 'string' ? { value: option, label: option } : { value: option.value, label: option.label || option.value };
    });
    selected.forEach(function(item) {
      if (!options.some(function(option) { return String(option.value).toLowerCase() === item.toLowerCase(); })) {
        options.push({ value: item, label: item });
      }
    });
    const boxes = options.map(function(option) {
      const on = selected.some(function(item) { return item.toLowerCase() === String(option.value).toLowerCase(); });
      return `<label class="check-option"><input type="checkbox" data-field="${escapeHtml(name)}" data-multi="1" value="${escapeHtml(option.value)}" ${on ? 'checked' : ''} ${disabled}> ${escapeHtml(option.label)}</label>`;
    }).join('');
    return `<div class="field wide"><label>${escapeHtml(label)}</label><div class="check-grid" role="group" aria-label="${escapeHtml(label)}">${boxes || '<span class="muted">Add active subjects under Admin → Subjects.</span>'}</div></div>`;
  }
  const inputType = ['text', 'email', 'url', 'number', 'date'].indexOf(field.type) >= 0 ? field.type : 'text';
  const formatted = escapeHtml(formatValue(currentValue));
  const control = field.type === 'textarea'
    ? `<textarea data-field="${escapeHtml(name)}" ${required} ${disabled}>${formatted}</textarea>`
    : `<input type="${inputType}" data-field="${escapeHtml(name)}" value="${formatted}" ${required} ${disabled}>`;
  return `<div class="field ${wide}"><label>${escapeHtml(label)}${required ? ' *' : ''}</label>${control}</div>`;
}

export function renderCohortImport() {
  const target = document.getElementById('cohort-import');
  target.innerHTML = '<div class="toolbar"><button type="button" class="button secondary" id="show-cohort-import">Fill from cohort roster</button></div>';
  document.getElementById('show-cohort-import').addEventListener('click', function() {
    callServer('getCohorts').then(function(cohorts) {
      if (!cohorts.length) { target.innerHTML = '<p class="notice">No cohorts are available.</p>'; return; }
      target.innerHTML = `<div class="toolbar"><label for="import-cohort">Cohort</label><select id="import-cohort">${cohorts.map(function(cohort) {
        return `<option value="${escapeHtml(cohort.id)}">${escapeHtml(cohort.name)}</option>`;
      }).join('')}<option value=""></option></select><label for="import-student">Student</label><select id="import-student"><option value="">Choose a student</option></select></div>`;
      const cohortSelect = document.getElementById('import-cohort');
      const studentSelect = document.getElementById('import-student');
      function loadMembers() {
        if (!cohortSelect.value) return;
        callServer('getCohortMembersForAdmin', cohortSelect.value).then(function(result) {
          studentSelect.innerHTML = '<option value="">Choose a student</option>' + (result.records || []).map(function(member, index) {
            return `<option value="${index}" ${member.hasStudentIdConflict ? 'disabled' : ''}>${escapeHtml(member['Display Name'] || member.StudentId)} · StudentId ${escapeHtml(member.StudentId)}${member.hasStudentIdConflict ? ' · Student Number conflict' : ''}</option>`;
          }).join('');
          studentSelect.onchange = function() {
            const member = result.records[Number(studentSelect.value)];
            if (!member) return;
            setField('DisplayName', member['Display Name']);
            setField('Cohort', cohortSelect.value);
            setField('StudentId', member.StudentId);
            setField('Student Number', member['Student Number'] || member['Student ID'] || '');
            setField('Student Email', member['Student Email'] || '');
            setField('parentEmail', member['Family Email']);
          };
        }).catch(showError);
      }
      cohortSelect.addEventListener('change', loadMembers);
      loadMembers();
    }).catch(showError);
  });
}

export function setField(name, value) {
  const input = document.querySelector(`[data-field="${cssEscape(name)}"]`);
  if (input && !input.disabled) input.value = value || '';
}

export function saveForm(event) {
  event.preventDefault();
  const entity = state.adminEntity;
  const form = event.currentTarget;
  const record = {};
  const multi = {};
  form.querySelectorAll('[data-field]').forEach(function(input) {
    if (input.getAttribute('data-multi')) {
      const fieldName = input.dataset.field;
      if (!multi[fieldName]) multi[fieldName] = [];
      if (input.checked) multi[fieldName].push(input.value);
      return;
    }
    if (input.type === 'checkbox') record[input.dataset.field] = input.checked;
    else record[input.dataset.field] = input.value;
  });
  Object.keys(multi).forEach(function(fieldName) { record[fieldName] = multi[fieldName]; });
  const submit = form.querySelector('[type="submit"]');
  const localError = document.getElementById('member-save-error') || document.getElementById('resource-save-error');
  if (localError) { localError.hidden = true; localError.textContent = ''; }
  submit.disabled = true;
  const request = runMutation(entity === 'cohortMembers' ? 'saveCohortMember' : 'saveAdminRecord', entity === 'cohortMembers'
    ? [state.cohortId, record, state.originalKey || '']
    : [entity, record, state.originalKey || ''], { key: 'admin:' + entity + ':' + (state.originalKey || 'new') });
  request.then(function(result) {
    state.status = result && result.auditWarning ? 'Saved, but the completion audit entry could not be written. Check AUDIT_LOGS.' : 'Saved.';
    memberEditorReturn = null;
    if (adminDialogKind() === 'admin-record') closeAdminDialog();
    else {
      state.editingRecord = null;
      state.originalKey = '';
    }
    refreshAdminSectionSilently();
  }).catch(function(error) {
    submit.disabled = false;
    showError(error);
    const editorError = document.getElementById('member-save-error') || document.getElementById('resource-save-error');
    if (editorError) {
      editorError.hidden = false;
      editorError.textContent = error && error.message ? error.message : String(error);
    }
  });
}

export function removeRecord(record) {
  const entity = state.adminEntity;
  const key = keyValue(entity, record);
  const noun = entity === 'cohorts' ? 'archive this cohort' : 'delete this record';
  if (!window.confirm(`Are you sure you want to ${noun}?`)) return;
  const request = runMutation(entity === 'cohortMembers' ? 'deleteCohortMember' : 'deleteAdminRecord', entity === 'cohortMembers'
    ? [state.cohortId, key]
    : [entity, key], { key: 'admin:' + entity + ':' + key });
  request.then(function(result) {
    state.status = result && result.auditWarning ? 'Change saved, but the completion audit entry could not be written.' : 'Change saved.';
    state.editingRecord = null;
    refreshAdminSectionSilently();
  }).catch(showError);
}

export function keyValue(entity, record) {
  if (!record || !state.adminData || !state.adminData.schema) return '';
  var key = state.adminData.schema.fields.filter(function(field) { return field.key; })[0];
  return key ? record[key.name] || '' : '';
}

export function displayField(field, record) {
  const value = record[field.name];
  if (field.type === 'checks') return subjectList(value).join(', ');
  if (field.options && field.options.length) {
    const match = field.options.filter(function(option) {
      const item = typeof option === 'string' ? { value: option, label: option } : option;
      return String(item.value) === String(value);
    })[0];
    if (match) return typeof match === 'string' ? match : (match.label || match.value);
  }
  return formatValue(value);
}
