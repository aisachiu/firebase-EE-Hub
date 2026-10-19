import { callServer, runMutation } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { closeForm, openFormShell } from '../shared/forms.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { state } from '../shared/state.js';

export function renderFormDesigner(target) {
  target.innerHTML = loadingLine('Loading form milestones...');
  callServer('listFormMilestones').then(function(forms) {
    if (!forms.length) { target.innerHTML = '<div class="empty">No milestones use the form type.</div>'; return; }
    const current = forms.some(function(form) { return form.milestoneId === state.formMilestoneId; }) ? state.formMilestoneId : forms[0].milestoneId;
    state.formMilestoneId = current;
    target.innerHTML = `<div class="toolbar"><label for="form-milestone">Milestone</label><select id="form-milestone">${forms.map(function(form) {
      return `<option value="${escapeHtml(form.milestoneId)}" ${form.milestoneId === current ? 'selected' : ''}>${escapeHtml(form.title)} · ${escapeHtml(form.status)}</option>`;
    }).join('')}</select></div><div id="form-designer">${loadingLine('Loading design...')}</div>`;
    document.getElementById('form-milestone').addEventListener('change', function(event) {
      state.formMilestoneId = event.target.value;
      renderFormDesigner(target);
    });
    callServer('getFormDesigner', current).then(paintFormDesigner).catch(showError);
  }).catch(showError);
}

export function paintFormDesigner(design) {
  const target = document.getElementById('form-designer');
  if (!target) return;
  const definition = design.definition;
  target.innerHTML = `<p class="muted">${escapeHtml(design.sheetName)} · version ${definition.version || 0} · ${escapeHtml(definition.status)} · ${design.responseCount} responses</p>
    <p class="notice">Custom JavaScript can use EEForm only. It cannot call google.script, the network, or the rest of the page. Publish is what creates the response columns. Use type checks with Options set to subjects, and Max set to 3, for a subject shortlist.</p>
    <div id="field-editor">${definition.fields.map(function(field, index) { return fieldEditorRow(field, index); }).join('')}</div>
    <div class="toolbar"><button type="button" class="button secondary" id="add-form-field">Add field</button></div>
    <div class="field wide"><label for="form-html">HTML</label><textarea id="form-html">${escapeHtml(definition.html || '')}</textarea></div>
    <div class="field wide"><label for="form-js">JavaScript</label><textarea id="form-js">${escapeHtml(definition.js || '')}</textarea></div>
    <label class="field check"><input type="checkbox" id="form-completes" ${definition.submitCompletes ? 'checked' : ''}> Submitting completes this milestone</label>
    <div class="toolbar"><button type="button" class="button secondary" id="save-form-design">Save draft</button><button type="button" class="button" id="publish-form-design">Publish</button><button type="button" class="button secondary" id="preview-form-design">Preview</button></div>`;
  document.getElementById('add-form-field').addEventListener('click', function() {
    document.getElementById('field-editor').insertAdjacentHTML('beforeend', fieldEditorRow({ name: '', label: '', type: 'text', required: false, options: [], optionsFrom: '' }, Date.now()));
  });
  document.getElementById('save-form-design').addEventListener('click', function() { storeFormDesign(false); });
  document.getElementById('publish-form-design').addEventListener('click', function() { storeFormDesign(true); });
  document.getElementById('preview-form-design').addEventListener('click', function() {
    const payload = readFormDesignPayload();
    payload.fields.forEach(function(field) {
      if (field.optionsFrom === 'subjects') field.options = design.subjectNames || [];
    });
    openFormShell(design.title + ' preview', payload.html, payload.js, { fields: payload.fields, values: {}, student: { displayName: 'Preview student', subject: '' }, onSubmit: function() { closeForm(); showSuccess('Preview only. Nothing was saved.'); return Promise.resolve(); } });
  });
}

export function fieldEditorRow(field, index) {
  const options = field.optionsFrom === 'subjects' ? 'subjects' : (field.options || []).join(', ');
  return `<div class="form-grid" data-field-row="${index}"><div class="field"><label>Name</label><input data-part="name" value="${escapeHtml(field.name)}"></div>
    <div class="field"><label>Label</label><input data-part="label" value="${escapeHtml(field.label)}"></div>
    <div class="field"><label>Type</label><select data-part="type">${['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'checks'].map(function(type) {
      return `<option ${field.type === type ? 'selected' : ''}>${type}</option>`;
    }).join('')}</select></div>
    <div class="field"><label>Options</label><input data-part="options" value="${escapeHtml(options)}" placeholder="subjects, or comma-separated choices"></div>
    <div class="field"><label>Max</label><input data-part="max" type="number" min="1" max="40" value="${field.maxSelections ? escapeHtml(String(field.maxSelections)) : ''}" placeholder="No limit"></div>
    <label class="field check"><input type="checkbox" data-part="required" ${field.required ? 'checked' : ''}> Required</label></div>`;
}

export function readFormDesignPayload() {
  const fields = Array.from(document.querySelectorAll('[data-field-row]')).map(function(row) {
    const optionsText = row.querySelector('[data-part="options"]').value.trim();
    const optionsFrom = optionsText === 'subjects' ? 'subjects' : '';
    return {
      name: row.querySelector('[data-part="name"]').value.trim(),
      label: row.querySelector('[data-part="label"]').value.trim(),
      type: row.querySelector('[data-part="type"]').value,
      required: row.querySelector('[data-part="required"]').checked,
      optionsFrom: optionsFrom,
      maxSelections: Number(row.querySelector('[data-part="max"]').value) || 0,
      options: optionsFrom ? [] : optionsText.split(',').map(function(option) { return option.trim(); }).filter(Boolean)
    };
  }).filter(function(field) { return field.name; });
  return {
    fields: fields,
    html: document.getElementById('form-html').value,
    js: document.getElementById('form-js').value,
    submitCompletes: document.getElementById('form-completes').checked
  };
}

export function storeFormDesign(publish) {
  const payload = readFormDesignPayload();
  const button = document.getElementById(publish ? 'publish-form-design' : 'save-form-design');
  button.disabled = true;
  runMutation(publish ? 'publishForm' : 'saveFormDraft', [state.formMilestoneId, payload], { key: 'form-design:' + state.formMilestoneId }).then(function(result) {
    showSuccess(publish ? 'Published ' + result.sheetName + ' version ' + result.version + '.' : 'Draft saved.');
    renderFormDesigner(document.getElementById('admin-content'));
  }).catch(function(error) { button.disabled = false; showError(error); });
}
