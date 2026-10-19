import { escapeHtml } from './html.js';

export function namedControls(root, name) {
  return Array.prototype.filter.call(root.querySelectorAll('[name]'), function(control) { return control.name === name; });
}

export function fillCheckGroup(root, field, current) {
  const selected = String(current || '').split(';').map(function(part) { return part.trim(); }).filter(Boolean);
  let host = root.querySelector('[data-checks="' + field.name + '"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'check-grid';
    host.setAttribute('data-checks', field.name);
    const label = document.createElement('label');
    label.className = 'field wide';
    label.appendChild(document.createTextNode(field.label));
    label.appendChild(host);
    root.appendChild(label);
  }
  host.innerHTML = (field.options || []).map(function(option) {
    const checked = selected.indexOf(option) >= 0 ? ' checked' : '';
    return `<label class="check-option"><input type="checkbox" name="${escapeHtml(field.name)}" value="${escapeHtml(option)}"${checked}> ${escapeHtml(option)}</label>`;
  }).join('');
}

export function subjectList(value) {
  const seen = {};
  const names = [];
  const source = Array.isArray(value) ? value : String(value || '').split(/[,;/|]/);
  source.forEach(function(item) {
    const name = String(item || '').trim();
    const key = name.toLowerCase();
    if (!name || seen[key]) return;
    seen[key] = true;
    names.push(name);
  });
  return names;
}

export function schemaSubjectNames(data) {
  const fields = data && data.schema && data.schema.fields ? data.schema.fields : [];
  const field = fields.filter(function(item) { return item.name === 'EESubjects'; })[0];
  return (field && field.options ? field.options : []).map(function(option) {
    return typeof option === 'string' ? option : option.value;
  }).filter(Boolean);
}

export function subjectMenuMarkup(email, assigned, subjects, attr) {
  const names = subjectList(assigned);
  const summary = names.length ? names.join(', ') : 'No subjects';
  const options = (subjects || []).slice();
  names.forEach(function(item) {
    if (!options.some(function(option) { return String(option).toLowerCase() === item.toLowerCase(); })) options.push(item);
  });
  const boxes = options.map(function(subject) {
    const on = names.some(function(item) { return item.toLowerCase() === String(subject).toLowerCase(); });
    return `<label class="check-option"><input type="checkbox" ${attr}="${escapeHtml(email)}" data-subject="${escapeHtml(subject)}" ${on ? 'checked' : ''}> ${escapeHtml(subject)}</label>`;
  }).join('');
  return `<details class="subject-menu"><summary>${escapeHtml(summary)}</summary><div class="subject-menu-list">${boxes || '<span class="muted">Add active subjects under Admin → Subjects.</span>'}</div></details>`;
}

export function checkedSubjectsIn(menu) {
  return Array.from(menu.querySelectorAll('input[type="checkbox"]:checked')).map(function(box) {
    return box.getAttribute('data-subject');
  }).filter(Boolean);
}
