import { callServer, markSync, runMutation } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { closeForm, openFormShell } from '../shared/forms.js';
import { state } from '../shared/state.js';
import { paintStudentJourney, repaintStudentPage } from './journey.js';

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
