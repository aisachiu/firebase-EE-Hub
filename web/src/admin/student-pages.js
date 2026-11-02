import { STUDENT_PAGE_TOGGLES } from '../student/rotary.js';
import { callServer } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { state } from '../shared/state.js';

export function renderStudentPages(target) {
  if (!target) return;
  target.innerHTML = loadingLine('Loading student pages...');
  callServer('getStudentPageSettings').then(function(settings) {
    if (state.adminEntity !== 'studentPages') return;
    paintStudentPages(target, settings);
  }).catch(function(error) {
    showError(error);
    if (target && state.adminEntity === 'studentPages') target.innerHTML = '<div class="empty">Student pages could not be loaded.</div>';
  });
}

function paintStudentPages(target, settings) {
  const pages = (settings && settings.pages) || {};
  const rows = STUDENT_PAGE_TOGGLES.map(function(row) {
    const shown = pages[row.key] !== false;
    const hint = row.hint && row.hint !== row.label ? `<p class="muted">${escapeHtml(row.hint)}</p>` : '';
    return `<li class="student-page-row"><div><strong>${escapeHtml(row.label)}</strong>${hint}</div><label class="check-option"><input type="checkbox" data-page-key="${escapeHtml(row.key)}" ${shown ? 'checked' : ''}> Show</label></li>`;
  }).join('');
  target.innerHTML = `<section class="editor"><h2>Student pages</h2><p>Choose which pages appear in the My EE carousel. Hidden pages drop out of the student view and the staff student view the next time they load.</p><ul class="student-page-list">${rows}</ul></section>`;
  target.querySelectorAll('[data-page-key]').forEach(function(input) {
    input.addEventListener('change', function() {
      saveStudentPages(target, pages);
    });
  });
}

function saveStudentPages(target, previous) {
  const payload = {};
  let visible = 0;
  target.querySelectorAll('[data-page-key]').forEach(function(input) {
    payload[input.getAttribute('data-page-key')] = input.checked;
    if (input.checked) visible += 1;
    input.disabled = true;
  });
  if (!visible) {
    showError(new Error('Leave at least one student page visible.'));
    paintStudentPages(target, { pages: previous });
    return;
  }
  callServer('saveStudentPageSettings', { pages: payload }).then(function(saved) {
    if (state.adminEntity !== 'studentPages') return;
    paintStudentPages(target, saved);
    showSuccess('Student pages updated.');
  }).catch(function(error) {
    showError(error);
    if (state.adminEntity === 'studentPages') paintStudentPages(target, { pages: previous });
  });
}
