import { callServer, runMutation } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { openFormShell, openStudentForm } from '../shared/forms.js';
import { escapeHtml } from '../shared/html.js';
import { state } from '../shared/state.js';
import { renderStaffHome } from '../staff/students.js';
import { milestonePhaseId, milestoneTitleText, setJourneyOpen } from './home.js';
import { paintStudentJourney, repaintStudentPage } from './journey.js';
import { commonMilestoneChoices } from './milestoneChoices.js';

export function bindFormButtons(main) {
  main.querySelectorAll('[data-open-form]').forEach(function(button) {
    button.addEventListener('click', function() { openStudentForm(button.dataset.openForm); });
  });
  main.querySelectorAll('[data-view-response]').forEach(function(button) {
    button.addEventListener('click', function() { viewStudentForm(button.dataset.viewResponse); });
  });
  const journey = main.querySelector('[data-go-journey]');
  if (journey) journey.addEventListener('click', function() { setJourneyOpen(true); });
}

export function viewStudentForm(milestoneId) {
  const email = state.staffStudentHome ? state.staffStudentHome.email : '';
  callServer('getFormResponse', milestoneId, email).then(function(form) {
    const answers = form.response ? form.response.values : null;
    const body = (form.fields || []).map(function(field) {
      const raw = answers ? answers[field.name] : '';
      const shown = !answers ? 'No response yet' : (field.type === 'checks' && raw ? String(raw).split('; ').join(', ') : (raw || '—'));
      return `<p><strong>${escapeHtml(field.label)}</strong><br>${escapeHtml(shown)}</p>`;
    }).join('');
    openFormShell(form.title || 'Form', body, '', null);
  }).catch(showError);
}

export function milestoneOptionMarkup(values, selected) {
  return values.map(function(option) {
    const value = option[0];
    const label = option[1];
    return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

export function phaseOptionMarkup(home, selected) {
  const phases = (home.phases || []).slice();
  const known = {};
  phases.forEach(function(phase) { known[phase.phaseId] = true; });
  if (selected && !known[selected]) phases.push({ phaseId: selected, phaseTitle: selected });
  return milestoneOptionMarkup(phases.map(function(phase) {
    return [phase.phaseId, phase.phaseTitle || phase.phaseId];
  }), selected);
}

export function statusOptionMarkup(selected) {
  return milestoneOptionMarkup([
    ['Pending', 'Pending'],
    ['In Progress', 'In Progress'],
    ['Completed', 'Completed']
  ], selected || 'Pending');
}

export function onMilestoneDialogKeydown(event) {
  if (event.key !== 'Escape') return;
  const dialog = document.getElementById('form-dialog');
  if (!dialog || dialog.hidden || dialog.dataset.editor !== 'milestone-edit') return;
  event.preventDefault();
  closeMilestoneDialog();
}

export function closeMilestoneDialog() {
  document.removeEventListener('keydown', onMilestoneDialogKeydown);
  const dialog = document.getElementById('form-dialog');
  if (!dialog || dialog.dataset.editor !== 'milestone-edit') return;
  dialog.hidden = true;
  dialog.innerHTML = '';
  delete dialog.dataset.editor;
  dialog.onclick = null;
}

export function openMilestoneDialog(markup) {
  const dialog = document.getElementById('form-dialog');
  if (!dialog) return;
  dialog.hidden = false;
  dialog.dataset.editor = 'milestone-edit';
  dialog.innerHTML = markup;
  dialog.onclick = function(event) {
    if (event.target === dialog) closeMilestoneDialog();
  };
  dialog.querySelectorAll('[data-close-milestone]').forEach(function(button) {
    button.addEventListener('click', closeMilestoneDialog);
  });
  document.removeEventListener('keydown', onMilestoneDialogKeydown);
  document.addEventListener('keydown', onMilestoneDialogKeydown);
  const first = dialog.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
  if (first) first.focus();
}

export function milestoneDialogError(error) {
  const node = document.getElementById('milestone-edit-error');
  if (!node) {
    showError(error);
    return;
  }
  node.hidden = false;
  node.textContent = error && error.message ? error.message : String(error);
}

export function openMilestoneEditor(home, taskId, milestoneId) {
  if (!home || !home.canUpdateMilestones) return;
  const item = taskId ? (home.actionItems || []).filter(function(entry) {
    return entry.TaskId === taskId && entry.CreatorType === 'System';
  })[0] : null;
  const templateId = (item && item.TemplateId) || milestoneId || '';
  const template = (home.templates || []).filter(function(entry) { return entry.milestoneId === templateId; })[0] || {};
  if (!item && !template.milestoneId) return;
  const title = item ? milestoneTitleText(template, item) : (template.title || template.milestoneId);
  const due = item && item.DueDate ? String(item.DueDate).slice(0, 10) : '';
  const phase = item ? milestonePhaseId(template, item) : (template.phase || '');
  openMilestoneDialog(`<div class="form-panel" role="dialog" aria-modal="true" aria-labelledby="milestone-editor-title"><div class="toolbar"><h2 id="milestone-editor-title">Edit milestone</h2><button type="button" class="button secondary" data-close-milestone>Close</button></div>
    <p class="muted">${escapeHtml(home.displayName || 'Student')} · ${escapeHtml(template.milestoneId || (item && item.TemplateId) || '')}</p>
    <form id="milestone-edit-form"><div class="form-grid">
      <div class="field wide"><label for="milestone-title">Title</label><input id="milestone-title" maxlength="500" required value="${escapeHtml(title)}"></div>
      <div class="field wide"><label for="milestone-description">Description</label><textarea id="milestone-description" maxlength="8000">${escapeHtml((item && item.Description) || template.description || '')}</textarea></div>
      <div class="field"><label for="milestone-phase">Phase</label><select id="milestone-phase" required>${phaseOptionMarkup(home, phase)}</select></div>
      <div class="field"><label for="milestone-status">Status</label><select id="milestone-status" required>${statusOptionMarkup(item && item.Status)}</select></div>
      <div class="field"><label for="milestone-date">Due date</label><input id="milestone-date" type="date" value="${escapeHtml(due)}"></div>
    </div>
    <p class="notice error" id="milestone-edit-error" hidden></p>
    <div class="toolbar"><button class="button" type="submit">Save</button><button class="button secondary" type="button" data-close-milestone>Cancel</button></div></form></div>`);
  const form = document.getElementById('milestone-edit-form');
  if (!form) return;
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    const errorNode = document.getElementById('milestone-edit-error');
    if (errorNode) errorNode.hidden = true;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const payload = {
      title: document.getElementById('milestone-title').value,
      description: document.getElementById('milestone-description').value,
      phaseId: document.getElementById('milestone-phase').value,
      status: document.getElementById('milestone-status').value,
      dueDate: document.getElementById('milestone-date').value,
      milestoneId: template.milestoneId || templateId
    };
    const savedTaskId = item ? item.TaskId : '';
    runMutation('updateMilestoneAssignment', [savedTaskId, home.email, home.cohort || '', state.actingAs, payload], {
      key: 'milestone-edit:' + (savedTaskId || templateId)
    }).then(function() {
      return callServer('getStaffStudentHome', home.email, home.cohort || '', state.actingAs);
    }).then(function(fresh) {
      state.staffStudentHome = fresh;
      closeMilestoneDialog();
      paintStudentJourney(fresh);
      if (state.section === 'students') repaintStudentPage(fresh);
      showSuccess('Milestone updated.');
    }).catch(function(error) {
      if (button) button.disabled = false;
      milestoneDialogError(error);
    });
  });
}

export function selectedStaffStudents(home) {
  const chosen = {};
  (state.staffSelected || []).forEach(function(email) { chosen[email] = true; });
  return (home.students || []).filter(function(student) { return chosen[student.email]; });
}

export { commonMilestoneChoices } from './milestoneChoices.js';

export function sharedAssignmentValues(students, templateId) {
  const rows = [];
  students.forEach(function(student) {
    (student.assigned || []).forEach(function(item) {
      if (item.templateId === templateId) rows.push(item);
    });
  });
  if (!rows.length) return { status: 'Pending', due: '', uniformStatus: true, uniformDate: true };
  const status = rows[0].status || '';
  const due = String(rows[0].due || '').slice(0, 10);
  return {
    status: rows.every(function(row) { return (row.status || '') === status; }) ? status : '',
    due: rows.every(function(row) { return String(row.due || '').slice(0, 10) === due; }) ? due : '',
    uniformStatus: rows.every(function(row) { return (row.status || '') === status; }),
    uniformDate: rows.every(function(row) { return String(row.due || '').slice(0, 10) === due; })
  };
}

export function selectedStudentSummary(students) {
  const names = students.map(function(student) { return student.displayName || student.email; });
  if (names.length <= 4) return names.join(', ');
  return names.slice(0, 3).join(', ') + ', and ' + (names.length - 3) + ' more';
}

export function openMassMilestoneEditor(home) {
  const students = selectedStaffStudents(home);
  if (!home || !home.canEditMilestones || !students.length) return;
  const choices = commonMilestoneChoices(home, students);
  const options = choices.length
    ? '<option value="">Choose a milestone</option>' + choices.map(function(choice) {
      return `<option value="${escapeHtml(choice.id)}">${escapeHtml(choice.title)}</option>`;
    }).join('')
    : '<option value="">No shared milestone</option>';
  openMilestoneDialog(`<div class="form-panel" role="dialog" aria-modal="true" aria-labelledby="mass-milestone-title"><div class="toolbar"><h2 id="mass-milestone-title">Edit Milestones</h2><button type="button" class="button secondary" data-close-milestone>Close</button></div>
    <p>${students.length} student${students.length === 1 ? '' : 's'} selected. ${escapeHtml(selectedStudentSummary(students))}</p>
    <form id="mass-milestone-form">
      <div class="field"><label for="mass-milestone">Milestone</label><select id="mass-milestone" required>${options}</select>
        <p class="muted mass-hint" id="mass-milestone-hint">${choices.length ? 'The change applies to every selected student.' : 'The selected students do not share a milestone.'}</p>
      </div>
      <div class="mass-fields">
        <div class="mass-field">
          <label class="check-option" for="mass-update-status"><input type="checkbox" id="mass-update-status"> Update status</label>
          <select id="mass-status" disabled>${statusOptionMarkup('Pending')}</select>
          <p class="muted mass-hint" id="mass-status-hint"></p>
        </div>
        <div class="mass-field">
          <label class="check-option" for="mass-update-date"><input type="checkbox" id="mass-update-date"> Update due date</label>
          <input id="mass-date" type="date" disabled>
          <p class="muted mass-hint" id="mass-date-hint"></p>
        </div>
      </div>
      <p class="notice error" id="milestone-edit-error" hidden></p>
      <div class="toolbar"><button class="button" type="submit" id="save-mass-milestones" disabled>Save</button><button class="button secondary" type="button" data-close-milestone>Cancel</button></div>
    </form></div>`);
  const milestone = document.getElementById('mass-milestone');
  const statusBox = document.getElementById('mass-update-status');
  const dateBox = document.getElementById('mass-update-date');
  const statusField = document.getElementById('mass-status');
  const dateField = document.getElementById('mass-date');
  const save = document.getElementById('save-mass-milestones');
  function paintShared() {
    const shared = sharedAssignmentValues(students, milestone.value);
    if (shared.uniformStatus && shared.status) statusField.value = shared.status;
    statusField.dataset.shared = shared.uniformStatus ? 'yes' : '';
    dateField.value = shared.uniformDate ? shared.due : '';
    document.getElementById('mass-status-hint').textContent = !milestone.value ? '' : (shared.uniformStatus ? '' : 'Status differs across the selected students.');
    document.getElementById('mass-date-hint').textContent = !milestone.value ? '' : (shared.uniformDate ? '' : 'Due dates differ across the selected students.');
  }
  function syncMassFields() {
    statusField.disabled = !statusBox.checked;
    dateField.disabled = !dateBox.checked;
    save.disabled = !milestone.value || (!statusBox.checked && !dateBox.checked);
  }
  milestone.addEventListener('change', function() {
    paintShared();
    syncMassFields();
  });
  statusBox.addEventListener('change', syncMassFields);
  dateBox.addEventListener('change', syncMassFields);
  document.getElementById('mass-milestone-form').addEventListener('submit', function(event) {
    event.preventDefault();
    const errorNode = document.getElementById('milestone-edit-error');
    if (errorNode) errorNode.hidden = true;
    if (!milestone.value) {
      milestoneDialogError(new Error('Choose a milestone.'));
      return;
    }
    if (!statusBox.checked && !dateBox.checked) {
      milestoneDialogError(new Error('Choose the status, the due date, or both.'));
      return;
    }
    if (dateBox.checked && !dateField.value) {
      milestoneDialogError(new Error('Due date must be a valid date.'));
      return;
    }
    save.disabled = true;
    const payload = {
      updateStatus: statusBox.checked,
      status: statusField.value,
      updateDate: dateBox.checked,
      dueDate: dateField.value
    };
    const emails = students.map(function(student) { return student.email; });
    runMutation('massUpdateMilestones', [home.cohortId || state.cohortId || '', emails, milestone.value, payload, state.actingAs], {
      key: 'mass-milestones:' + (home.cohortId || '')
    }).then(function(result) {
      closeMilestoneDialog();
      showSuccess('Updated ' + (result.students || emails.length) + ' student' + ((result.students || emails.length) === 1 ? '' : 's') + '.');
      state.staffHome = null;
      renderStaffHome();
    }).catch(function(error) {
      save.disabled = false;
      milestoneDialogError(error);
    });
  });
}
