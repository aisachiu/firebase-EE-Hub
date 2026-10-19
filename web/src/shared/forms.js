import { callServer, markSync, runMutation } from './api.js';
import { fillCheckGroup, namedControls } from './checks.js';
import { showError, showSuccess } from './feedback.js';
import { escapeHtml } from './html.js';
import { state } from './state.js';
import { paintStudentJourney, repaintStudentPage } from '../student/journey.js';

export function openStudentForm(milestoneId) {
  const cached = state.formViews[milestoneId];
  if (cached) paintLiveForm(cached, true);
  else openFormShell('Form', '<p class="muted">Loading form…</p>', '', { loading: true });
  const panel = document.querySelector('#form-dialog .form-panel');
  markSync(panel, 'pending');
  callServer('getStudentForm', milestoneId).then(function(form) {
    state.formViews[milestoneId] = form;
    paintLiveForm(form, false);
    markSync(document.querySelector('#form-dialog .form-panel'), 'confirmed');
  }).catch(function(error) {
    const current = document.querySelector('#form-dialog .form-panel');
    markSync(current, 'rejected');
    const formError = document.getElementById('form-error');
    if (formError) {
      formError.hidden = false;
      formError.textContent = error && error.message ? error.message : String(error);
    } else showError(error);
  });
}

export function paintLiveForm(form, refreshing) {
  const values = form.response ? form.response.values : {};
  const open = form.formOpen !== false;
  openFormShell(form.title, form.html, form.js, {
    fields: form.fields,
    values: values,
    student: form.student,
    readOnly: !open,
    notice: open ? '' : (form.closedMessage || 'This form is closed. Answers can no longer be changed.'),
    onSubmit: open ? function(collected, submit) {
      const panel = document.querySelector('#form-dialog .form-panel');
      markSync(panel, 'pending');
      const draft = document.getElementById('save-form-draft');
      const submitButton = document.getElementById('submit-form');
      if (draft) draft.disabled = true;
      if (submitButton) submitButton.disabled = true;
      return runMutation('saveStudentForm', [form.milestoneId, {
        values: collected,
        lastUpdated: form.response ? form.response.lastUpdated : '',
        submit: submit
      }], { key: 'form:' + form.milestoneId }).then(function(result) {
        const saved = Object.assign({}, form, {
          response: {
            values: collected,
            status: result && result.status ? result.status : (submit ? 'Submitted' : 'Draft'),
            lastUpdated: result && result.lastUpdated ? result.lastUpdated : '',
            version: form.version
          }
        });
        state.formViews[form.milestoneId] = saved;
        if (submit && form.submitCompletes !== false && state.studentHome) {
          (state.studentHome.actionItems || []).forEach(function(item) {
            if (item.CreatorType === 'System' && item.TemplateId === form.milestoneId) item.Status = 'Completed';
          });
        }
        markSync(document.querySelector('#form-dialog .form-panel'), 'confirmed');
        window.setTimeout(function() {
          closeForm();
          showSuccess(submit ? 'Form submitted.' : 'Draft saved.');
          if (state.studentHome && document.getElementById('my-activity')) repaintStudentPage(state.studentHome);
          if (document.getElementById('journey-body')) paintStudentJourney(state.studentHome);
        }, 350);
      }).catch(function(error) {
        if (draft) draft.disabled = false;
        if (submitButton) submitButton.disabled = false;
        markSync(document.querySelector('#form-dialog .form-panel'), 'rejected');
        throw error;
      });
    } : null
  });
  if (refreshing) markSync(document.querySelector('#form-dialog .form-panel'), 'pending');
}

export function openFormShell(title, html, js, binding) {
  const dialog = document.getElementById('form-dialog');
  const readOnly = !!(binding && binding.readOnly);
  const notice = binding && binding.notice ? `<p class="notice">${escapeHtml(binding.notice)}</p>` : '';
  dialog.hidden = false;
  dialog.innerHTML = `<div class="form-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="toolbar"><h2>${escapeHtml(title)}</h2><button type="button" class="button secondary" id="close-form">Close</button></div>${notice}<div id="ee-form-root">${html || ''}</div><p class="notice error" id="form-error" hidden></p><div class="toolbar"><button type="button" class="button secondary" id="save-form-draft">Save draft</button><button type="button" class="button" id="submit-form">Submit</button></div></div>`;
  document.getElementById('close-form').addEventListener('click', closeForm);
  const root = document.getElementById('ee-form-root');
  if (binding && binding.fields) fillFormControls(root, binding.fields, binding.values || {});
  if (js) {
    try { runFormScript(js, { root: root, fields: binding ? binding.fields : [], student: binding ? binding.student : {}, draft: binding ? binding.values : {} }); }
    catch (error) {
      const formError = document.getElementById('form-error');
      formError.hidden = false;
      formError.textContent = error.message || String(error);
    }
  }
  if (readOnly) lockFormControls(root);
  const submit = function(isSubmit) {
    if (!binding || !binding.onSubmit) { closeForm(); return; }
    const error = document.getElementById('form-error');
    error.hidden = true;
    binding.onSubmit(collectFormValues(root, binding.fields), isSubmit).catch(function(err) {
      error.hidden = false;
      error.textContent = err.message || String(err);
    });
  };
  if (!binding || !binding.onSubmit) {
    document.getElementById('save-form-draft').hidden = true;
    document.getElementById('submit-form').hidden = true;
  } else {
    document.getElementById('save-form-draft').addEventListener('click', function() { submit(false); });
    document.getElementById('submit-form').addEventListener('click', function() { submit(true); });
  }
}

export function lockFormControls(root) {
  root.querySelectorAll('input, textarea, select').forEach(function(control) {
    control.disabled = true;
  });
}

export function closeForm() {
  const dialog = document.getElementById('form-dialog');
  if (!dialog) return;
  dialog.hidden = true;
  dialog.innerHTML = '';
}

export function fillFormControls(root, fields, values) {
  fields.forEach(function(field) {
    const current = values[field.name] || '';
    if (field.type === 'checks') {
      fillCheckGroup(root, field, current);
      return;
    }
    const named = namedControls(root, field.name);
    if (named.length && named[0].type === 'radio') {
      named.forEach(function(input) { input.checked = input.value === String(current); });
      return;
    }
    let input = named[0];
    if (!input) {
      const label = document.createElement('label');
      label.className = 'field';
      label.appendChild(document.createTextNode(field.label));
      input = field.type === 'textarea' ? document.createElement('textarea') : (field.type === 'select' ? document.createElement('select') : document.createElement('input'));
      if (field.type === 'checkbox') input.type = 'checkbox';
      input.name = field.name;
      label.appendChild(input);
      root.appendChild(label);
    }
    if (input.tagName === 'SELECT') {
      input.innerHTML = '<option value="">Select…</option>' + (field.options || []).map(function(option) {
        return `<option ${option === current ? 'selected' : ''}>${escapeHtml(option)}</option>`;
      }).join('');
    } else if (input.type === 'checkbox') input.checked = current === 'Yes' || current === true;
    else if (current) input.value = current;
  });
}

export function collectFormValues(root, fields) {
  const values = {};
  fields.forEach(function(field) {
    const named = namedControls(root, field.name);
    if (!named.length) return;
    if (field.type === 'checks') {
      values[field.name] = named.filter(function(input) { return input.checked; }).map(function(input) { return input.value; });
      return;
    }
    if (named[0].type === 'radio') {
      const picked = named.filter(function(input) { return input.checked; })[0];
      values[field.name] = picked ? picked.value : '';
      return;
    }
    const input = named[0];
    values[field.name] = input.type === 'checkbox' ? input.checked : input.value;
  });
  return values;
}

export function runFormScript(js, api) {
  if (!js || !String(js).trim()) return;
  const runner = new Function('EEForm', 'google', 'window', 'parent', 'top', 'document', 'fetch', 'XMLHttpRequest', 'eval', 'Function', js);
  runner(api, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
}
