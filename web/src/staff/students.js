import { paintTabDot, renderShell } from '../navigation.js';
import { callServer } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { rememberHeaderCohorts } from '../shared/headerCohorts.js';
import { escapeHtml, shortDate, textCompare } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { advanceScene, sameScene } from '../shared/scene.js';
import { hideListJourneyTip } from '../shared/sessionChrome.js';
import { state } from '../shared/state.js';
import { bindUnreadNotices, renderUnreadNotices } from '../student/home.js';
import { paintStaffPreview } from '../student/views.js';
import { dueSortKey, journeyDayLabel, milestoneMark, phaseCardAttrs, phaseRangeLabel } from '../student/journey.js';
import { openMassMilestoneEditor } from '../student/milestones.js';
import { bindSupervisorTodoList, mayManageSupervisorTodos, renderSupervisorDesk, supervisorTodoList } from './supervisorTodos.js';

export function openStaffStudent(email) {
  callServer('getStaffStudentHome', email, state.cohortId, state.actingAs).then(function(detail) {
    state.staffStudentHome = detail;
    state.staffPreviewView = '0';
    state.staffPane = 'home';
    state.journeyOpen = true;
    state.notesOpen = false;
    state.journeyFilters = { phaseId: 'all', showSystem: true, showStudent: true };
    state.editingTodo = '';
    renderShell();
  }).catch(showError);
}

function supervisorDeskHooks() {
  return {
    back: function() {
      state.supervisorDesk = false;
      renderStaffHome();
    },
    openStudent: openStaffStudent,
    reload: function() {
      const main = document.getElementById('main');
      if (main && state.supervisorDesk) renderSupervisorDesk(main, supervisorDeskHooks());
    },
  };
}

export function renderStaffHome() {
  advanceScene();
  const main = document.getElementById('main');
  if (state.supervisorDesk && !mayManageSupervisorTodos(state.user)) state.supervisorDesk = false;
  if (state.emailDesk) {
    const scene = state.scene;
    main.innerHTML = loadingLine('Loading email notifications...');
    import('../admin/email.js').then(function(mod) {
      if (!sameScene(scene) || !state.emailDesk) return;
      const target = document.getElementById('main');
      if (target) mod.renderEmailDesk(target, { back: true });
    }).catch(function(error) {
      if (!sameScene(scene)) return;
      showError(error);
    });
    return;
  }
  if (state.staffStudentHome) { paintStaffAsStudent(state.staffStudentHome); return; }
  if (state.supervisorDesk) { renderSupervisorDesk(main, supervisorDeskHooks()); return; }
  main.innerHTML = loadingLine('Loading students...');
  callServer('getStaffHome', state.cohortId || '', state.actingAs).then(function(home) {
    state.staffHome = home;
    state.cohortId = home.cohortId || '';
    rememberHeaderCohorts(home.cohorts);
    state.staffTicketUnread = home.unreadTicketCount || 0;
    paintTabDot('tickets', state.staffTicketUnread, 'Messages');
    paintStaffCards(home);
  }).catch(showError);
}

export function paintStaffAsStudent(home) {
  paintStaffPreview(home);
}

export function staffSortValue(student, sort) {
  if (sort === 'displayName') return student.displayName || '';
  if (sort === 'hrm') return student.hrm || '';
  return student.surname || student.displayName || '';
}

export function visibleStaffStudents(home) {
  let students = (home.students || []).slice();
  if (state.staffTrack === 'on') students = students.filter(function(student) { return !student.behind; });
  if (state.staffTrack === 'off') students = students.filter(function(student) { return !!student.behind; });
  if (state.staffMine) students = students.filter(function(student) { return student.supervisorId === state.user.email; });
  if (state.staffSupervisor) {
    students = students.filter(function(student) {
      return (student.supervisorId || '__unassigned__') === state.staffSupervisor;
    });
  }
  const query = state.staffQuery.trim().toLowerCase();
  if (query) {
    students = students.filter(function(student) {
      return (student.displayName + ' ' + student.surname + ' ' + student.subject + ' ' + student.hrm + ' ' + (student.studentNumber || '')).toLowerCase().indexOf(query) >= 0;
    });
  }
  const sort = state.staffSort || 'surname';
  students.sort(function(left, right) {
    const primary = textCompare(staffSortValue(left, sort), staffSortValue(right, sort));
    if (primary) return primary;
    return textCompare(left.displayName, right.displayName);
  });
  return students;
}

export function staffViewMode() {
  const mode = state.staffViewMode;
  if (mode === 'list-collapsed' || mode === 'list-expanded' || mode === 'tiles') return mode;
  return 'tiles';
}

export function rememberStaffViewMode(mode) {
  const next = mode === 'list-collapsed' || mode === 'list-expanded' ? mode : 'tiles';
  state.staffViewMode = next;
  try { window.localStorage.setItem('ee-hub-staff-view-mode', next); }
  catch (error) { /* the choice still applies for this visit */ }
}

export function staffViewModeControl(mode) {
  const current = mode || staffViewMode();
  const options = [
    ['tiles', 'Tiles'],
    ['list-collapsed', 'List collapsed'],
    ['list-expanded', 'List expanded'],
  ];
  return `<div class="view-toggle staff-view-mode" role="group" aria-label="Student layout">${options.map(function(option) {
    return `<button type="button" data-staff-view="${option[0]}" aria-pressed="${current === option[0] ? 'true' : 'false'}">${option[1]}</button>`;
  }).join('')}</div>`;
}

export function staffIdentityMarkup(student) {
  const details = escapeHtml(student.subject || 'No subject yet') + (student.studentNumber ? ' · Student Number ' + escapeHtml(student.studentNumber) : '') + (student.hrm ? ' · ' + escapeHtml(student.hrm) : '') + (student.surname ? ' · ' + escapeHtml(student.surname) : '');
  return `<button type="button" class="name" data-open-student="${escapeHtml(student.email)}">${escapeHtml(student.displayName)}</button><div class="muted list-student-meta">${details}</div>`;
}

export function staffStatusMarkup(student) {
  const chips = [`<span class="chip ${student.behind ? 'bad' : 'ok'}">${student.behind ? student.behind + ' overdue' : 'On track'}</span>`];
  if (student.returned) chips.push('<span class="chip bad">Returned</span>');
  if (student.waiting && student.waiting.length) chips.push(`<span class="chip bad">${student.waiting.length} waiting</span>`);
  return `<div class="chips">${chips.join('')}</div><div class="muted list-latest">Latest: ${escapeHtml(student.latestTitle || '—')}</div>`;
}

export function listMilestoneStatus(milestone) {
  if (milestone.done) return 'Done';
  if (milestone.here) return 'Current step';
  return 'Not done yet';
}

export function staffJourneyPhases(home, student) {
  const templates = home.templates || [];
  const rawSegments = String(student.segments || '');
  const segments = rawSegments ? rawSegments.split('') : [];
  const dues = Array.isArray(student.dues) ? student.dues : [];
  let currentIndex = -1;
  templates.forEach(function(template, index) {
    if (currentIndex < 0 && (segments[index] || 'o') !== 'd') currentIndex = index;
  });
  const assignedByTemplate = {};
  (student.assigned || []).forEach(function(item) {
    if (item && item.templateId) assignedByTemplate[item.templateId] = item;
  });
  const grouped = {};
  templates.forEach(function(template, index) {
    const segment = segments[index] || 'o';
    const phaseId = template.phase || '';
    const assignment = assignedByTemplate[template.milestoneId];
    if (!grouped[phaseId]) grouped[phaseId] = [];
    grouped[phaseId].push({
      id: template.milestoneId,
      title: (assignment && assignment.title) || template.title || template.milestoneId,
      type: template.type || '',
      due: assignment && assignment.due ? String(assignment.due).slice(0, 10) : (dues[index] ? String(dues[index]).slice(0, 10) : ''),
      done: segment === 'd',
      here: index === currentIndex
    });
  });
  Object.keys(grouped).forEach(function(phaseId) {
    grouped[phaseId].sort(function(left, right) {
      const due = dueSortKey(left.due).localeCompare(dueSortKey(right.due));
      if (due) return due;
      return textCompare(left.title, right.title);
    });
  });
  const phases = (home.phases || []).slice();
  const seen = {};
  phases.forEach(function(phase) { seen[phase.phaseId] = true; });
  Object.keys(grouped).forEach(function(phaseId) {
    if (!phaseId || seen[phaseId]) return;
    seen[phaseId] = true;
    phases.push({ phaseId: phaseId, phaseTitle: phaseId });
  });
  return phases.map(function(phase, index) {
    const milestones = grouped[phase.phaseId] || [];
    const doneCount = milestones.filter(function(milestone) { return milestone.done; }).length;
    return {
      id: phase.phaseId,
      title: phase.phaseTitle || phase.phaseId,
      index: index,
      colour: phase.phaseColor || '',
      milestones: milestones,
      doneCount: doneCount,
      here: milestones.some(function(milestone) { return milestone.here; }),
      complete: milestones.length > 0 && doneCount === milestones.length
    };
  });
}

export function renderListJourney(home, student) {
  const phases = staffJourneyPhases(home, student);
  if (!phases.length) return '<p class="muted">No milestones yet.</p>';
  const summary = (student.done || 0) + ' of ' + (student.total || 0) + ' milestones done. ' + phases.map(function(phase) {
    if (!phase.milestones.length) return phase.title + ', no milestones';
    const bits = phase.milestones.map(function(milestone) {
      const when = milestone.due ? shortDate(milestone.due) : '';
      return milestone.title + (when ? ', ' + when : '') + ', ' + listMilestoneStatus(milestone);
    }).join('; ');
    return phase.title + (phase.here ? ' (current phase)' : '') + ': ' + bits;
  }).join('. ');
  if (staffViewMode() !== 'list-expanded') {
    const compact = `<ol class="compact-path">${phases.map(function(phase) {
      const dots = phase.milestones.map(function(milestone) {
        const stateClass = milestone.done ? 'done' : (milestone.here ? 'here' : '');
        const when = milestone.due ? shortDate(milestone.due) : '';
        const tip = milestone.title + (when ? ' · ' + when : '') + ' · ' + listMilestoneStatus(milestone);
        return `<i class="cmark ${stateClass}" data-tip="${escapeHtml(tip)}"></i>`;
      }).join('');
      return `<li class="compact-phase${phase.complete ? ' done' : ''}${phase.here ? ' here' : ''}"><div class="compact-phase-body"><span class="compact-marks">${dots}</span><span class="compact-label">${escapeHtml(phase.title)}</span></div></li>`;
    }).join('')}</ol>`;
    return `<div class="list-journey is-collapsed" role="img" aria-label="${escapeHtml(summary)}">${compact}</div>`;
  }
  const cards = phases.map(function(phase) {
    const range = phaseRangeLabel(phase.milestones.map(function(milestone) { return milestone.due; }));
    const card = phaseCardAttrs(phase);
    const phaseTip = phase.title + ', ' + phase.doneCount + ' of ' + phase.milestones.length + ' done' + (phase.here ? ', current phase' : (phase.complete ? ', complete' : ''));
    if (!phase.milestones.length) {
      const style = (card.style ? card.style + ';' : '') + '--span:1';
      return `<li class="phase-card ${card.className}" style="${style}"><span class="phase-title" data-tip="${escapeHtml(phaseTip)}">${escapeHtml((phase.index + 1) + ' · ' + phase.title)}</span><p class="phase-range"></p><p class="muted list-phase-empty">No milestones</p></li>`;
    }
    const marks = phase.milestones.map(function(milestone) {
      const when = milestone.due ? shortDate(milestone.due) : '';
      const tip = milestone.title + (when ? ' · ' + when : '') + ' · ' + listMilestoneStatus(milestone);
      return `<li><span class="list-mark" data-tip="${escapeHtml(tip)}"><span class="ms-date">${escapeHtml(journeyDayLabel(milestone.due))}</span><span class="ms-mark-wrap">${milestoneMark(milestone)}</span><span class="ms-label">${escapeHtml(milestone.title)}</span></span></li>`;
    }).join('');
    const filledStyle = (card.style ? card.style + ';' : '') + '--span:' + Math.max(phase.milestones.length, 1);
    return `<li class="phase-card ${card.className}${phase.here ? ' here' : ''}${phase.complete ? ' done' : ''}" style="${filledStyle}"><span class="phase-title" data-tip="${escapeHtml(phaseTip)}">${escapeHtml((phase.index + 1) + ' · ' + phase.title)}</span><p class="phase-range">${escapeHtml(range)}</p><div class="phase-body"><div class="phase-line" aria-hidden="true"></div><ol class="ms-row">${marks}</ol></div></li>`;
  }).join('');
  return `<div class="list-journey is-expanded" role="img" aria-label="${escapeHtml(summary)}"><ol class="list-phases">${cards}</ol></div>`;
}

export function staffPickMarkup(student) {
  const checked = (state.staffSelected || []).indexOf(student.email) >= 0;
  return `<input type="checkbox" class="student-pick" data-select-student="${escapeHtml(student.email)}" ${checked ? 'checked' : ''} aria-label="${escapeHtml('Select ' + (student.displayName || 'student'))}">`;
}

export function renderStaffStudentTiles(students, phaseName, canEdit) {
  return `<div class="sgrid">${students.map(function(student) {
    return `<article class="scard">${canEdit ? `<div class="card-tools">${staffPickMarkup(student)}</div>` : ''}<button type="button" class="name" data-open-student="${escapeHtml(student.email)}">${escapeHtml(student.displayName)}</button>
        <div class="muted">${escapeHtml(student.subject || 'No subject yet')}${student.hrm ? ' · ' + escapeHtml(student.hrm) : ''}${student.surname ? ' · ' + escapeHtml(student.surname) : ''}</div>
        <div class="segs" aria-label="${student.done} of ${student.total} milestones">${student.segments.split('').map(function(segment) { return `<i class="${segment === 'o' ? '' : segment}"></i>`; }).join('')}</div>
        <div class="chips"><span class="chip">${escapeHtml(phaseName[student.phaseId] || student.phaseId || 'Phase')}</span><span class="chip ${student.behind ? 'bad' : 'ok'}">${student.behind ? student.behind + ' overdue' : 'On track'}</span>${student.waiting.length ? `<span class="chip bad">${student.waiting.length} waiting</span>` : ''}${student.returned ? `<span class="chip bad">Returned</span>` : ''}</div>
        <div class="muted">Latest: ${escapeHtml(student.latestTitle || '—')}</div></article>`;
  }).join('')}</div>`;
}

export function renderStaffStudentList(home, students) {
  const canEdit = !!home.canEditMilestones;
  const rows = students.map(function(student) {
    return `<tr>${canEdit ? `<td class="pick-col">${staffPickMarkup(student)}</td>` : ''}<td>${staffIdentityMarkup(student)}</td><td>${staffStatusMarkup(student)}</td><td>${renderListJourney(home, student)}</td></tr>`;
  }).join('');
  const pickHead = canEdit ? '<th class="pick-col" scope="col"><span class="muted">Select</span></th>' : '';
  return `<div class="table-wrap student-list"><table><thead><tr>${pickHead}<th class="student-col" scope="col">Student</th><th class="status-col" scope="col">Status</th><th class="journey-col" scope="col">Journey progress</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export let listJourneyTipBound = false;

export function listJourneyTipNode() {
  let tip = document.getElementById('list-journey-tip');
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'list-journey-tip';
  tip.className = 'list-journey-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

export { hideListJourneyTip };

export function showListJourneyTip(mark) {
  const text = mark.getAttribute('data-tip');
  if (!text) return;
  const tip = listJourneyTipNode();
  tip.textContent = text;
  tip.hidden = false;
  const rect = mark.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = rect.top - tipRect.height - 8;
  if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - tipRect.height - 8);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

export function bindListJourneyTips(root) {
  hideListJourneyTip();
  if (!listJourneyTipBound) {
    listJourneyTipBound = true;
    window.addEventListener('scroll', hideListJourneyTip, true);
    window.addEventListener('resize', hideListJourneyTip);
    document.addEventListener('pointerdown', function(event) {
      const target = event.target;
      if (!target || !target.closest || !target.closest('[data-tip]')) hideListJourneyTip();
    });
  }
  const board = root.querySelector('.student-list');
  if (!board) return;
  board.addEventListener('pointerover', function(event) {
    const mark = event.target.closest ? event.target.closest('[data-tip]') : null;
    if (mark && board.contains(mark)) showListJourneyTip(mark);
  });
  board.addEventListener('pointerout', function(event) {
    const mark = event.target.closest ? event.target.closest('[data-tip]') : null;
    if (!mark || !board.contains(mark)) return;
    const related = event.relatedTarget;
    const next = related && related.closest ? related.closest('[data-tip]') : null;
    if (next && board.contains(next)) showListJourneyTip(next);
    else hideListJourneyTip();
  });
}

export function paintStaffCards(home) {
  const main = document.getElementById('main');
  const mode = staffViewMode();
  main.classList.toggle('staff-list', mode !== 'tiles');
  const knownStudents = {};
  (home.students || []).forEach(function(student) { knownStudents[student.email] = true; });
  state.staffSelected = (state.staffSelected || []).filter(function(email) { return knownStudents[email]; });
  const canEditMilestones = !!home.canEditMilestones;
  const students = visibleStaffStudents(home);
  const total = (home.students || []).length;
  const visibleSelected = students.filter(function(student) { return state.staffSelected.indexOf(student.email) >= 0; }).length;
  const allVisibleSelected = students.length > 0 && visibleSelected === students.length;
  const phaseName = {};
  (home.phases || []).forEach(function(phase) { phaseName[phase.phaseId] = phase.phaseTitle; });
  const supervisors = home.supervisors || [];
  main.innerHTML = `${renderUnreadNotices(home.unreadTickets)}<div class="toolbar">
      <label for="staff-sort">Sort</label><select id="staff-sort" aria-label="Sort students">
        <option value="surname" ${state.staffSort === 'surname' ? 'selected' : ''}>Last name</option>
        <option value="displayName" ${state.staffSort === 'displayName' ? 'selected' : ''}>Display name</option>
        <option value="hrm" ${state.staffSort === 'hrm' ? 'selected' : ''}>Homeroom</option>
      </select>
      <label for="staff-track">Progress</label><select id="staff-track" aria-label="Filter by progress">
        <option value="all" ${state.staffTrack === 'all' ? 'selected' : ''}>All students</option>
        <option value="on" ${state.staffTrack === 'on' ? 'selected' : ''}>On track</option>
        <option value="off" ${state.staffTrack === 'off' ? 'selected' : ''}>Not on track</option>
      </select>
      <label for="staff-supervisor">Supervisor</label><select id="staff-supervisor" aria-label="Filter by supervisor">
        <option value="">All supervisors</option>
        ${supervisors.map(function(supervisor) {
          return `<option value="${escapeHtml(supervisor.id)}" ${state.staffSupervisor === supervisor.id ? 'selected' : ''}>${escapeHtml(supervisor.name)}</option>`;
        }).join('')}
      </select>
      <label><input type="checkbox" id="staff-mine" ${state.staffMine ? 'checked' : ''}> My students</label>
      <input id="staff-search" type="search" placeholder="Search students" value="${escapeHtml(state.staffQuery)}" aria-label="Search students">
      <span class="muted">${students.length}${students.length === total ? '' : ' of ' + total} students</span>
      <button type="button" class="button secondary" id="open-email-desk">Email reminders</button>
      ${mayManageSupervisorTodos(state.user) ? '<button type="button" class="button secondary" id="open-supervisor-todos">Supervisor to-dos</button>' : ''}
      ${canEditMilestones ? `<label><input type="checkbox" class="student-pick" id="staff-select-visible" ${allVisibleSelected ? 'checked' : ''} ${students.length ? '' : 'disabled'} aria-label="Select all students in this list"> Select all</label><span class="muted" id="staff-selected-count">${state.staffSelected.length} selected</span><button type="button" class="button secondary" id="edit-milestones" ${state.staffSelected.length ? '' : 'disabled'}>Edit Milestones</button>` : ''}
      ${staffViewModeControl(mode)}
    </div>
    <div class="staff-board${home.viewAs === 'supervisor' ? '' : ' solo'}">
    ${supervisorTodoList(home)}
    ${students.length ? (mode === 'tiles' ? renderStaffStudentTiles(students, phaseName, canEditMilestones) : renderStaffStudentList(home, students)) : '<div class="empty">No students match this view.</div>'}
    </div>`;
  bindUnreadNotices(main, true);
  document.getElementById('open-email-desk').addEventListener('click', function() {
    state.emailDesk = true;
    state.supervisorDesk = false;
    state.noticeCohortId = state.cohortId || '';
    state.noticeEdit = null;
    renderStaffHome();
  });
  const supervisorTodosButton = document.getElementById('open-supervisor-todos');
  if (supervisorTodosButton) supervisorTodosButton.addEventListener('click', function() {
    state.emailDesk = false;
    state.supervisorDesk = true;
    renderStaffHome();
  });
  bindSupervisorTodoList(main, function() { renderStaffHome(); }, function() { paintStaffCards(home); });
  function syncStaffSelectionChrome() {
    const count = document.getElementById('staff-selected-count');
    if (count) count.textContent = state.staffSelected.length + ' selected';
    const button = document.getElementById('edit-milestones');
    if (button) button.disabled = !state.staffSelected.length;
    const all = document.getElementById('staff-select-visible');
    const boxes = main.querySelectorAll('[data-select-student]');
    if (!all || !boxes.length) return;
    let checked = 0;
    boxes.forEach(function(box) { if (box.checked) checked += 1; });
    all.checked = checked === boxes.length && checked > 0;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
  main.querySelectorAll('[data-select-student]').forEach(function(box) {
    box.addEventListener('change', function() {
      const email = box.dataset.selectStudent;
      if (box.checked) {
        if (state.staffSelected.indexOf(email) < 0) state.staffSelected.push(email);
      } else {
        state.staffSelected = state.staffSelected.filter(function(item) { return item !== email; });
      }
      syncStaffSelectionChrome();
    });
  });
  const selectVisible = document.getElementById('staff-select-visible');
  if (selectVisible) {
    syncStaffSelectionChrome();
    selectVisible.addEventListener('change', function() {
      const emails = {};
      state.staffSelected.forEach(function(email) { emails[email] = true; });
      students.forEach(function(student) {
        if (selectVisible.checked) emails[student.email] = true;
        else delete emails[student.email];
      });
      state.staffSelected = Object.keys(emails);
      repaintFilters();
      const again = document.getElementById('staff-select-visible');
      if (again) again.focus();
    });
  }
  const editMilestones = document.getElementById('edit-milestones');
  if (editMilestones) editMilestones.addEventListener('click', function() {
    openMassMilestoneEditor(home, function() { renderStaffHome(); });
  });
  function repaintFilters() { paintStaffCards(home); }
  document.getElementById('staff-sort').addEventListener('change', function(event) {
    state.staffSort = event.target.value;
    repaintFilters();
  });
  document.getElementById('staff-track').addEventListener('change', function(event) {
    state.staffTrack = event.target.value;
    repaintFilters();
  });
  document.getElementById('staff-supervisor').addEventListener('change', function(event) {
    state.staffSupervisor = event.target.value;
    repaintFilters();
  });
  document.getElementById('staff-mine').addEventListener('change', function(event) {
    state.staffMine = event.target.checked;
    repaintFilters();
  });
  document.getElementById('staff-search').addEventListener('input', function(event) {
    state.staffQuery = event.target.value;
    repaintFilters();
    const search = document.getElementById('staff-search');
    if (search) {
      const end = search.value.length;
      search.focus();
      search.setSelectionRange(end, end);
    }
  });
  main.querySelectorAll('[data-staff-view]').forEach(function(button) {
    button.addEventListener('click', function() {
      const next = button.dataset.staffView;
      if (staffViewMode() === next) return;
      rememberStaffViewMode(next);
      repaintFilters();
      const again = document.querySelector('[data-staff-view="' + next + '"]');
      if (again) again.focus();
    });
  });
  bindListJourneyTips(main);
  main.querySelectorAll('[data-open-student]').forEach(function(button) {
    button.addEventListener('click', function() { openStaffStudent(button.dataset.openStudent); });
  });
}
