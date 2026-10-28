import { escapeHtml, safeUrl } from '../shared/html.js';

export function workspacePresence(record) {
  const source = record || {};
  const folderUrl = safeUrl(source.EEFolder);
  const docUrl = safeUrl(source.EEDoc);
  return {
    folder: !!folderUrl,
    doc: !!docUrl,
    folderUrl: folderUrl,
    docUrl: docUrl,
  };
}

export function provisioningStatus(record) {
  const presence = workspacePresence(record);
  if (presence.folder && presence.doc) return 'ready';
  if (!presence.folder && !presence.doc) return 'missing';
  if (!presence.folder) return 'missing-folder';
  return 'missing-doc';
}

export function provisioningStatusLabel(status) {
  if (status === 'ready') return 'Has folder and doc';
  if (status === 'missing-folder') return 'Missing folder';
  if (status === 'missing-doc') return 'Missing doc';
  return 'Missing folder and doc';
}

export function provisioningSortValue(record) {
  const presence = workspacePresence(record);
  return (presence.folder ? 1 : 0) + (presence.doc ? 1 : 0);
}

export function matchesProvisionFilter(record, filter) {
  if (!filter || filter === 'all') return true;
  const presence = workspacePresence(record);
  if (filter === 'ready') return presence.folder && presence.doc;
  if (filter === 'missing') return !presence.folder || !presence.doc;
  if (filter === 'missing-folder') return !presence.folder;
  if (filter === 'missing-doc') return !presence.doc;
  return true;
}

export function memberIdsForProvision(records, mode) {
  return (records || []).filter(function(record) {
    if (!record || record.hasStudentIdConflict || !record.StudentId) return false;
    const presence = workspacePresence(record);
    if (mode === 'ready') return presence.folder && presence.doc;
    if (mode === 'missing-folder') return !presence.folder;
    if (mode === 'missing-doc') return !presence.doc;
    if (mode === 'missing') return !presence.folder || !presence.doc;
    return true;
  }).map(function(record) { return record.StudentId; });
}

function folderIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
}

function docIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>';
}

function workspaceLink(url, label, icon) {
  return `<a class="icon-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</a>`;
}

export function workspaceCellHtml(record) {
  const presence = workspacePresence(record);
  const links = [];
  if (presence.folderUrl) links.push(workspaceLink(presence.folderUrl, 'Open EE folder', folderIcon()));
  if (presence.docUrl) links.push(workspaceLink(presence.docUrl, 'Open EE document', docIcon()));
  const label = provisioningStatusLabel(provisioningStatus(record));
  return `<span class="workspace-links">${links.join('')}<span class="muted">${escapeHtml(label)}</span></span>`;
}

export function cohortProvisionFilterControl(filter) {
  const current = filter || 'all';
  const options = [
    ['all', 'All students'],
    ['ready', 'Has folder and doc'],
    ['missing', 'Missing folder or doc'],
    ['missing-folder', 'Missing folder'],
    ['missing-doc', 'Missing doc'],
  ];
  return `<label for="member-provision-filter">Workspace</label><select id="member-provision-filter">${options.map(function(option) {
    return `<option value="${option[0]}"${current === option[0] ? ' selected' : ''}>${escapeHtml(option[1])}</option>`;
  }).join('')}</select>`;
}

export function cohortProvisionSelectionActions() {
  return `<button type="button" class="button secondary" id="select-missing-folder">Select missing folder</button><button type="button" class="button secondary" id="select-missing-doc">Select missing doc</button><button type="button" class="button secondary" id="select-provisioned">Select provisioned</button><button type="button" class="button secondary" id="clear-workspace-data" disabled>Clear Google Workspace Data</button>`;
}

export function driveStudentNeedsAttention(student) {
  if (!student) return false;
  return student.status === 'error' || student.status === 'ambiguous' || (student.doc && student.doc.status === 'error') || (student.shares || []).some(function(share) { return share.status === 'failed'; });
}

export function provisioningCounter(completed, total, running) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCompleted = Math.max(0, Math.min(Number(completed) || 0, safeTotal));
  if (!safeTotal) return 'Provisioning 0 of 0...';
  if (running && safeCompleted < safeTotal) return 'Provisioning ' + (safeCompleted + 1) + ' of ' + safeTotal + '...';
  return 'Provisioned ' + safeCompleted + ' of ' + safeTotal + '.';
}

export function provisioningLogHtml(students) {
  return (students || []).map(function(student) {
    const failed = driveStudentNeedsAttention(student);
    const name = student.displayName || student.studentId || 'Student';
    const detail = student.message || (student.doc && student.doc.message) || '';
    return `<li class="${failed ? 'provision-failed' : 'provision-ok'}"><strong>${escapeHtml(name)}</strong> · ${failed ? 'Failed' : 'Succeeded'}${detail ? `<div class="muted">${escapeHtml(detail)}</div>` : ''}</li>`;
  }).join('');
}

export function provisioningModalHtml(view) {
  const source = view || {};
  const total = Math.max(0, Number(source.total) || 0);
  const completed = Math.max(0, Math.min(Number(source.completed) || 0, total));
  const running = !!source.running && completed < total;
  const students = source.students || [];
  const failed = students.filter(driveStudentNeedsAttention).length;
  const succeeded = students.length - failed;
  const width = total ? Math.round((completed / total) * 100) : 0;
  const error = source.error ? `<p class="notice error">${escapeHtml(source.error)}</p>` : '';
  const hint = running ? '<p class="muted">Stay on this page until provisioning finishes. Leaving stops the process.</p>' : '';
  return `<div class="form-panel provisioning-modal" role="dialog" aria-modal="true" aria-labelledby="provision-title"><div class="toolbar"><h2 id="provision-title" tabindex="-1">Google Workspace provisioning</h2></div><p id="provision-progress" aria-live="polite">${escapeHtml(provisioningCounter(completed, total, running))}</p><div class="provision-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${completed}" aria-label="Provisioning progress"><span style="width:${width}%"></span></div><p class="muted"><span id="provision-ok">${succeeded} succeeded</span> · <span id="provision-bad">${failed} failed</span></p>${error}<ul class="drive-results provision-log">${provisioningLogHtml(students)}</ul>${hint}<div class="toolbar"><button type="button" class="button" id="provision-close"${running ? ' disabled' : ''}>Close</button></div></div>`;
}
