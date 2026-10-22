import { callServer, markSync, runMutation } from '../shared/api.js';
import { showError, showSuccess } from '../shared/feedback.js';
import { escapeHtml, hexColour, shortDate, textCompare } from '../shared/html.js';
import { state } from '../shared/state.js';
import {
  milestoneDescriptionText,
  milestoneEditButton,
  milestonePhaseId,
  milestoneTitleText,
  nextIncomplete,
  paintStudentPage,
  setJourneyOpen,
  systemItemFor,
} from './home.js';
import { bindFormButtons, openMilestoneEditor } from './milestones.js';

export function journeyOverview(home) {
  const current = nextIncomplete(home);
  const currentId = current && current.template ? current.template.milestoneId : '';
  return (home.phases || []).map(function(phase, index) {
    const milestones = (home.templates || []).filter(function(template) {
      return milestonePhaseId(template, systemItemFor(home, template.milestoneId)) === phase.phaseId;
    }).map(function(template) {
      const item = systemItemFor(home, template.milestoneId);
      const done = !!(item && item.Status === 'Completed');
      return {
        id: template.milestoneId,
        title: milestoneTitleText(template, item),
        type: template.type || '',
        due: item && item.DueDate ? String(item.DueDate).slice(0, 10) : '',
        done: done,
        here: template.milestoneId === currentId && !done
      };
    }).sort(function(left, right) {
      const due = dueSortKey(left.due).localeCompare(dueSortKey(right.due));
      if (due) return due;
      return textCompare(left.title, right.title);
    });
    const doneCount = milestones.filter(function(milestone) { return milestone.done; }).length;
    return {
      id: phase.phaseId,
      title: phase.phaseTitle || phase.phaseId,
      index: index,
      colour: hexColour(phase.phaseColor),
      milestones: milestones,
      doneCount: doneCount,
      here: milestones.some(function(milestone) { return milestone.here; }),
      complete: milestones.length > 0 && doneCount === milestones.length
    };
  });
}

export function phaseRangeLabel(dates) {
  const keys = (dates || []).filter(function(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value); }).sort();
  if (!keys.length) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function part(key) {
    const bits = key.split('-');
    return { year: bits[0], month: months[Number(bits[1]) - 1] };
  }
  const start = part(keys[0]);
  const end = part(keys[keys.length - 1]);
  if (start.year === end.year && start.month === end.month) return start.month + ' ' + start.year;
  if (start.year === end.year) return start.month + ' – ' + end.month + ' ' + start.year;
  return start.month + ' ' + start.year + ' – ' + end.month + ' ' + end.year;
}

export function journeyDayLabel(value) {
  const full = shortDate(value);
  return full ? full.replace(/\s+\d{4}$/, '') : '';
}

export function phaseCardAttrs(phase) {
  const tone = 'tone-' + ((Number(phase.index) || 0) % 5);
  const colour = hexColour(phase.colour || phase.phaseColor || '');
  if (!colour) return { className: tone, style: '' };
  return {
    className: 'has-colour',
    style: '--phase:' + colour + ';--phase-bg:color-mix(in srgb, ' + colour + ' 16%, white);--phase-fg:' + colour
  };
}

export function milestoneMark(milestone) {
  const stateClass = milestone.done ? 'done' : (milestone.here ? 'here' : '');
  const star = milestone.type === 'form' || milestone.type === 'upload';
  if (star) {
    return `<svg class="ms-star ${stateClass}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`;
  }
  return `<span class="ms-dot ${stateClass}" aria-hidden="true"></span>`;
}

export function renderJourneyHero(phases) {
  const full = phases.length ? phases.map(function(phase) {
    const range = phaseRangeLabel(phase.milestones.map(function(milestone) { return milestone.due; }));
    const marks = phase.milestones.length ? phase.milestones.map(function(milestone) {
      const status = milestone.done ? 'Done' : (milestone.here ? 'Current step' : 'Not done yet');
      const when = milestone.due ? shortDate(milestone.due) : '';
      const label = milestone.title + (when ? ', ' + when : '') + ', ' + status + '. Open this phase in the journey panel.';
      return `<li><button type="button" class="ms-hit" data-open-phase="${escapeHtml(phase.id)}" aria-label="${escapeHtml(label)}"><span class="ms-date">${escapeHtml(journeyDayLabel(milestone.due))}</span><span class="ms-mark-wrap">${milestoneMark(milestone)}</span><span class="ms-label">${escapeHtml(milestone.title)}</span></button></li>`;
    }).join('') : '<li class="muted">No milestones</li>';
    const card = phaseCardAttrs(phase);
    const style = (card.style ? card.style + ';' : '') + '--span:' + Math.max(phase.milestones.length, 1);
    return `<section class="phase-card ${card.className}${phase.here ? ' here' : ''}${phase.complete ? ' done' : ''}" style="${style}"><button type="button" class="phase-title" data-open-phase="${escapeHtml(phase.id)}">${escapeHtml((phase.index + 1) + ' · ' + phase.title)}</button><p class="phase-range">${escapeHtml(range)}</p><div class="phase-body"><div class="phase-line" aria-hidden="true"></div><ol class="ms-row">${marks}</ol></div></section>`;
  }).join('') : '<p class="muted">Official milestones appear after a cohort is assigned.</p>';
  const compact = phases.length ? `<ol class="compact-path">${phases.map(function(phase) {
    const dots = phase.milestones.map(function(milestone) {
      const stateClass = milestone.done ? 'done' : (milestone.here ? 'here' : '');
      return `<i class="cmark ${stateClass}" title="${escapeHtml(milestone.title + (milestone.done ? ' · Done' : (milestone.here ? ' · Current' : '')))}"></i>`;
    }).join('');
    const summary = phase.title + ', ' + phase.doneCount + ' of ' + phase.milestones.length + ' done. Open this phase in the journey panel.';
    return `<li class="compact-phase${phase.complete ? ' done' : ''}${phase.here ? ' here' : ''}"><button type="button" data-open-phase="${escapeHtml(phase.id)}" aria-label="${escapeHtml(summary)}"><span class="compact-marks">${dots}</span><span class="compact-label">${escapeHtml(phase.title)}</span></button></li>`;
  }).join('')}</ol>` : '';
  return `<section class="journey-hero" aria-label="Journey overview"><div class="journey-hero-bar"><h2>Journey</h2><button type="button" class="journey-hero-toggle" data-journey-hero-toggle aria-expanded="true">Collapse</button></div><div class="journey-hero-full" data-journey-full>${full}</div><div class="journey-hero-compact" data-journey-compact hidden>${compact}</div></section>`;
}

export function applyJourneyHero(main) {
  const expanded = state.journeyHeroExpanded !== false;
  const full = main.querySelector('[data-journey-full]');
  const compact = main.querySelector('[data-journey-compact]');
  const toggle = main.querySelector('[data-journey-hero-toggle]');
  if (full) full.hidden = !expanded;
  if (compact) compact.hidden = expanded;
  if (toggle) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.textContent = expanded ? 'Collapse' : 'Expand';
  }
}

export function bindJourneyHero(main) {
  const toggle = main.querySelector('[data-journey-hero-toggle]');
  if (toggle) toggle.addEventListener('click', function() {
    state.journeyHeroExpanded = state.journeyHeroExpanded === false;
    applyJourneyHero(main);
  });
  main.querySelectorAll('[data-open-phase]').forEach(function(button) {
    button.addEventListener('click', function() {
      const phaseId = button.dataset.openPhase;
      state.journeyFilters.phaseId = state.journeyFilters.phaseId === phaseId ? 'all' : phaseId;
      setJourneyOpen(true);
      const home = activeJourneyRecord();
      if (home && document.getElementById('journey-body')) paintStudentJourney(home);
    });
  });
}

export function paintStudentJourney(home) {
  const main = document.getElementById('journey-body');
  if (!main) return;
  const phases = home.phases || [];
  const items = home.actionItems || [];
  const templates = home.templates || [];
  const phaseTitle = {};
  phases.forEach(function(phase) { phaseTitle[phase.phaseId] = phase.phaseTitle || phase.phaseId; });
  const current = nextIncomplete(home);
  const currentPhaseId = current && current.template ? milestonePhaseId(current.template, current.item) : '';
  const systemItems = items.filter(function(item) { return item.CreatorType === 'System'; });
  const doneCount = systemItems.filter(function(item) { return item.Status === 'Completed'; }).length;
  const total = templates.length || systemItems.length;
  const zoom = state.journeyFilters.phaseId;
  const visiblePhases = zoom === 'all' ? phases : phases.filter(function(phase) { return phase.phaseId === zoom; });
  const percent = total ? Math.round((doneCount / total) * 100) : 0;
  main.innerHTML = `<section class="journey">
    <div class="journey-head"><div><p class="eyebrow">Extended Essay</p><h1>${home.staffView ? escapeHtml(home.displayName) : 'Your journey'}</h1></div><p class="journey-score"><strong>${doneCount}</strong> of ${total} done</p></div>
    <div class="journey-bar" role="img" aria-label="${doneCount} of ${total} milestones done"><span style="width:${percent}%"></span></div>
    <ol class="journey-path">${phases.map(function(phase) {
      const phaseTemplates = templates.filter(function(template) { return milestonePhaseId(template, systemItemFor(home, template.milestoneId)) === phase.phaseId; });
      const phaseDone = phaseTemplates.filter(function(template) {
        return systemItems.some(function(item) { return item.TemplateId === template.milestoneId && item.Status === 'Completed'; });
      }).length;
      const stateClass = phase.phaseId === currentPhaseId ? 'here' : (phaseTemplates.length && phaseDone === phaseTemplates.length ? 'done' : '');
      return `<li><button type="button" class="phase-stop ${stateClass}" data-zoom="${escapeHtml(phase.phaseId)}" aria-pressed="${zoom === phase.phaseId ? 'true' : 'false'}"><span class="phase-mark"></span><span class="phase-name">${escapeHtml(phase.phaseTitle || phase.phaseId)}</span><span class="phase-count">${phaseDone}/${phaseTemplates.length || 0}</span></button></li>`;
    }).join('')}</ol>
    <div class="journey-filters">
      <button type="button" data-zoom="all" aria-pressed="${zoom === 'all' ? 'true' : 'false'}">Whole journey</button>
      <button type="button" data-layer="milestones" aria-pressed="${state.journeyFilters.showSystem ? 'true' : 'false'}">Milestones</button>
      <button type="button" data-layer="todos" aria-pressed="${state.journeyFilters.showStudent ? 'true' : 'false'}">To-dos</button>
    </div>
    ${journeyHereCard(home, current, phaseTitle, zoom, currentPhaseId)}
    ${visiblePhases.length ? visiblePhases.map(function(phase) {
      return renderJourneyPhase(home, phase, phaseTitle, current, zoom, currentPhaseId);
    }).join('') : '<div class="empty">Official milestones appear after your cohort is assigned.</div>'}
  </section>`;
  bindJourney(main, home, currentPhaseId);
  bindFormButtons(main);
  Object.keys(state.journeySync || {}).forEach(function(taskId) {
    flashJourneyRows(taskId, 'pending');
  });
}

export function journeyHereCard(home, current, phaseTitle, zoom, currentPhaseId) {
  if (!current || !current.template) return `<section class="here-card"><p class="eyebrow">All caught up</p><h2>The official milestones are complete</h2><p>${home.canWriteTodos === false ? 'Nothing is waiting on you.' : 'Add a to-do if something still needs your attention.'}</p></section>`;
  if (zoom !== 'all' && zoom !== currentPhaseId) return '';
  const item = current.item;
  const shownTitle = milestoneTitleText(current.template, item);
  const shownPhase = milestonePhaseId(current.template, item);
  const title = phaseTitle[shownPhase] || shownPhase;
  const due = item && item.DueDate ? shortDate(item.DueDate) : '';
  const actions = journeyActions(item, current.template);
  const check = journeyCheck(item, 'Mark ' + shownTitle + ' done', !!(item && item.canUpdate));
  const edit = milestoneEditButton(home, item, shownTitle);
  return `<section class="here-card" data-task-id="${item ? escapeHtml(item.TaskId) : ''}"><p class="eyebrow">You are here · ${escapeHtml(title)}</p><div class="step-top">${check}<div class="step-title"><h2>${escapeHtml(shownTitle)}</h2>${edit}</div></div><p>${escapeHtml(milestoneDescriptionText(current.template, item) || 'This is your next step.')}</p><div class="step-actions">${due ? `<span class="chip">${escapeHtml(due)}</span>` : ''}${actions || `<span class="chip">${escapeHtml(milestoneProgressLabel(item, current.template))}</span>`}</div></section>`;
}

export function renderJourneyPhase(home, phase, phaseTitle, current, zoom, currentPhaseId) {
  const detailed = zoom !== 'all' || phase.phaseId === currentPhaseId;
  const milestones = (home.templates || []).filter(function(template) {
    return milestonePhaseId(template, systemItemFor(home, template.milestoneId)) === phase.phaseId;
  });
  const todos = (home.actionItems || []).filter(function(item) {
    return item.CreatorType === 'Student' && (item.PhaseId === phase.phaseId || (!item.PhaseId && phase.phaseId === currentPhaseId));
  });
  const showMilestones = state.journeyFilters.showSystem;
  const showTodos = state.journeyFilters.showStudent;
  const rows = [];
  if (showMilestones) milestones.forEach(function(template) {
    const item = (home.actionItems || []).filter(function(entry) { return entry.CreatorType === 'System' && entry.TemplateId === template.milestoneId; })[0] || null;
    rows.push({
      due: item && item.DueDate,
      title: template.title,
      html: renderJourneyMilestone(home, template, item, detailed, current, zoom)
    });
  });
  if (showTodos) todos.forEach(function(item) {
    rows.push({ due: item.DueDate, title: item.Title, html: renderJourneyTodo(item) });
  });
  rows.sort(function(left, right) {
    const due = dueSortKey(left.due).localeCompare(dueSortKey(right.due));
    if (due) return due;
    return textCompare(left.title, right.title);
  });
  const composer = showTodos && home.canWriteTodos !== false ? `<div class="add-todo" data-phase="${escapeHtml(phase.phaseId)}"><button type="button" class="add-todo-open" aria-expanded="false">+ Add To Do</button><form class="add-todo-form"><input maxlength="240" placeholder="To-do" aria-label="New to-do"><button class="button" type="submit">Add</button></form></div>` : '';
  const done = milestones.filter(function(template) {
    return (home.actionItems || []).some(function(item) { return item.TemplateId === template.milestoneId && item.Status === 'Completed'; });
  }).length;
  return `<section class="journey-phase ${phase.phaseId === currentPhaseId ? 'here' : ''}"><header><h2>${escapeHtml(phase.phaseTitle || phase.phaseId)}</h2><span class="muted">${done} of ${milestones.length}</span></header>${composer}<ol class="steps-rail">${rows.length ? rows.map(function(row) { return row.html; }).join('') : '<li class="muted">Nothing in this view.</li>'}</ol></section>`;
}

export function dueSortKey(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '9999-99-99';
}

export function journeyCheck(item, label, enabled) {
  const checked = item && item.Status === 'Completed';
  const interactive = !!(enabled && item && item.TaskId);
  return `<input type="checkbox" class="rail-check" data-milestone-check ${checked ? 'checked' : ''} ${interactive ? '' : 'disabled'} aria-label="${escapeHtml(label)}">`;
}

export function renderJourneyMilestone(home, template, item, detailed, current, zoom) {
  const title = milestoneTitleText(template, item);
  const status = item ? item.Status : 'Pending';
  const isHere = current && current.template.milestoneId === template.milestoneId && status !== 'Completed';
  const showActions = item && item.canUpdate && (zoom !== 'all' || status === 'Completed' || template.type === 'form');
  const due = item && item.DueDate ? shortDate(item.DueDate) : '';
  const closed = template.type === 'form' && item && item.formOpen === false ? ' · Form closed' : '';
  const check = journeyCheck(item, 'Mark ' + title + ' done', !!(item && item.canUpdate));
  const edit = milestoneEditButton(home, item, title);
  return `<li class="step ${status === 'Completed' ? 'done' : ''} ${isHere ? 'here' : ''}" data-task-id="${item ? escapeHtml(item.TaskId) : ''}" data-creator-type="System">${check}<div><div class="step-top"><div class="step-title"><h3>${escapeHtml(title)}</h3>${edit}</div><span class="muted">${escapeHtml(milestoneKind(template))}${due ? ' · ' + escapeHtml(due) : ''}${closed}</span></div>${detailed ? `<p class="muted">${escapeHtml(milestoneDescriptionText(template, item))}</p>` : ''}${item && item.returnedComment ? `<p class="notice">Returned: ${escapeHtml(item.returnedComment)}</p>` : ''}<div class="step-actions"><span class="muted">${escapeHtml(milestoneProgressLabel(item, template))}</span>${showActions ? journeyActions(item, template) : ''}</div></div></li>`;
}

export function renderJourneyTodo(item) {
  const writable = !!(item.canEdit || item.canUpdate);
  const editing = writable && state.editingTodo === item.TaskId;
  const due = item.DueDate ? String(item.DueDate).slice(0, 10) : '';
  const actions = writable
    ? `<div class="step-actions"><button type="button" class="link-button" data-edit-todo="${escapeHtml(item.TaskId)}">Edit</button></div>`
    : '';
  const check = journeyCheck(item, 'Mark ' + (item.Title || 'to-do') + ' done', writable);
  return `<li class="step todo ${item.Status === 'Completed' ? 'done' : ''}" data-task-id="${escapeHtml(item.TaskId)}" data-creator-type="Student">${check}<div><div class="step-top"><h3>${escapeHtml(item.Title)}</h3><span class="muted">To-do${due ? ' · ' + escapeHtml(shortDate(due)) : ''}</span></div>${item.Description && !editing ? `<p class="muted">${escapeHtml(item.Description)}</p>` : ''}${editing ? `<div class="todo-edit"><input data-todo-title value="${escapeHtml(item.Title)}" maxlength="240" aria-label="To-do title"><textarea data-todo-description aria-label="To-do note">${escapeHtml(item.Description || '')}</textarea><input type="date" data-todo-date value="${escapeHtml(due)}" aria-label="To-do date"><div class="step-actions"><button type="button" class="button" data-save-todo="${escapeHtml(item.TaskId)}">Save</button><button type="button" class="button secondary" data-close-todo>Close</button></div></div>` : actions}</div></li>`;
}

export function journeyActions(item, template) {
  if (!item || !item.canUpdate) return '';
  const completed = item.Status === 'Completed';
  let html = '';
  if (item.staffUpdate && template && template.type === 'form') {
    html += `<button type="button" class="button secondary" data-view-response="${escapeHtml(template.milestoneId)}">View form</button>`;
  } else if (template && template.type === 'form') {
    html += formJourneyButton(template, item);
  }
  if (completed) return html;
  if (item.staffUpdate && template && template.type === 'approval') {
    return html + '<button type="button" class="button" data-decide="approve">Approve</button><button type="button" class="button secondary" data-decide="return">Return</button>';
  }
  if (item.staffUpdate && template && template.type === 'meeting') {
    return html + '<button type="button" class="button" data-decide="session">Log session</button>';
  }
  return html;
}

export function formJourneyButton(template, item) {
  const home = state.studentHome;
  if (!(home && home.publishedForms && home.publishedForms[template.milestoneId])) return '<span class="muted">Form not published yet</span>';
  const closed = item && item.formOpen === false;
  const label = closed ? 'View form' : (item && item.Status === 'Completed' ? 'Edit form' : 'Open form');
  return `<button type="button" class="button" data-open-form="${escapeHtml(template.milestoneId)}">${label}</button>`;
}

export function milestoneKind(template) {
  const names = { form: 'Form', upload: 'Upload', doc: 'Document', approval: 'Approval', meeting: 'Session' };
  return names[template.type] || 'Milestone';
}

export function milestoneProgressLabel(item, template) {
  if (item && item.Status === 'Completed') return 'Done';
  if (item && item.canUpdate) {
    if (item.staffUpdate) return item.Status === 'In Progress' ? 'In progress' : 'You can update this';
    return item.Status === 'In Progress' ? 'In progress' : 'Yours to do';
  }
  if (template.type === 'meeting') return 'Your supervisor logs this session';
  if (template.mOwner === 'supervisor') return 'With your supervisor';
  if (template.mOwner === 'coordinator') return 'With the EE Coordinator';
  if (template.mOwner === 'lead') return 'With your subject lead';
  return 'Waiting';
}

export function bindJourney(main, home, currentPhaseId) {
  main.querySelectorAll('[data-zoom]').forEach(function(button) {
    button.addEventListener('click', function() {
      const next = button.dataset.zoom;
      state.journeyFilters.phaseId = state.journeyFilters.phaseId === next && next !== 'all' ? 'all' : next;
      paintStudentJourney(home);
    });
  });
  main.querySelectorAll('[data-layer]').forEach(function(button) {
    button.addEventListener('click', function() {
      if (button.dataset.layer === 'milestones') state.journeyFilters.showSystem = !state.journeyFilters.showSystem;
      else state.journeyFilters.showStudent = !state.journeyFilters.showStudent;
      paintStudentJourney(home);
    });
  });
  main.querySelectorAll('[data-milestone-check]').forEach(function(box) {
    box.addEventListener('change', function() {
      const card = box.closest('[data-task-id]');
      const taskId = card && card.dataset.taskId;
      if (box.disabled) return;
      if (!taskId) {
        box.checked = !box.checked;
        return;
      }
      if (state.journeySync[taskId]) {
        box.checked = !box.checked;
        return;
      }
      const record = activeJourneyRecord() || home;
      const item = (record.actionItems || []).filter(function(entry) { return entry.TaskId === taskId; })[0];
      if (!item) {
        box.checked = !box.checked;
        return;
      }
      const previous = item.Status;
      const nextStatus = box.checked ? 'Completed' : 'Pending';
      item.Status = nextStatus;
      state.journeySync[taskId] = 'pending';
      paintStudentJourney(record);
      const studentEmail = home.staffView ? home.email : '';
      const viewAs = home.staffView ? state.actingAs : '';
      runMutation('setActionItemStatus', [taskId, nextStatus, studentEmail, home.cohort || '', viewAs], { key: 'action-item:' + taskId }).then(function() {
        delete state.journeySync[taskId];
        flashJourneyRows(taskId, 'confirmed');
        if (document.getElementById('my-activity')) repaintStudentPage(record);
        showSuccess(nextStatus === 'Completed' ? 'Marked done.' : 'Marked not done.');
      }).catch(function(error) {
        delete state.journeySync[taskId];
        item.Status = previous;
        paintStudentJourney(activeJourneyRecord() || home);
        showError(error);
      });
    });
  });
  main.querySelectorAll('[data-decide]').forEach(function(button) {
    button.addEventListener('click', function() {
      const card = button.closest('[data-task-id]');
      const taskId = card && card.dataset.taskId;
      if (!taskId || !home.staffView) return;
      const action = button.dataset.decide;
      const comment = action === 'approve' ? '' : window.prompt(action === 'return' ? 'Comments for the student' : 'Session summary');
      if (action !== 'approve' && !comment) return;
      button.disabled = true;
      state.journeySync[taskId] = 'pending';
      flashJourneyRows(taskId, 'pending');
      runMutation('recordMilestoneDecision', [taskId, action, comment || '', home.email, home.cohort || '', state.actingAs], {
        key: 'milestone:' + taskId
      }).then(function() {
        return callServer('getStaffStudentHome', home.email, home.cohort || '', state.actingAs);
      }).then(function(fresh) {
        delete state.journeySync[taskId];
        state.staffStudentHome = fresh;
        paintStudentJourney(fresh);
        flashJourneyRows(taskId, 'confirmed');
        if (state.section === 'students') repaintStudentPage(fresh);
        showSuccess(action === 'return' ? 'Returned to the student.' : 'Milestone updated.');
      }).catch(function(error) {
        delete state.journeySync[taskId];
        button.disabled = false;
        flashJourneyRows(taskId, 'rejected');
        showError(error);
      });
    });
  });
  main.querySelectorAll('.add-todo').forEach(function(box) {
    const open = box.querySelector('.add-todo-open');
    const form = box.querySelector('.add-todo-form');
    const input = form.querySelector('input');
    open.addEventListener('click', function() {
      box.classList.add('is-open');
      open.setAttribute('aria-expanded', 'true');
      input.focus();
    });
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const phaseId = box.dataset.phase || currentPhaseId || '';
      const addingAsStaff = !!home.staffView;
      const record = activeJourneyRecord() || home;
      const tempId = 'pending-' + Date.now();
      const created = { TaskId: tempId, StudentId: addingAsStaff ? home.email : state.user.email, CreatorType: 'Student', TemplateId: '', PhaseId: phaseId, Title: title, Description: '', DueDate: '', Status: 'Pending', canEdit: !addingAsStaff, canUpdate: !addingAsStaff };
      record.actionItems = (record.actionItems || []).concat([created]);
      state.journeyFilters.showStudent = true;
      state.journeySync[tempId] = 'pending';
      input.value = '';
      paintStudentJourney(record);
      const call = addingAsStaff
        ? runMutation('addStaffStudentTodo', [title, phaseId, home.email, home.cohort || '', state.actingAs], { key: 'student-todo:new' })
        : runMutation('addStudentTodo', [title, phaseId], { key: 'student-todo:new' });
      call.then(function(result) {
        created.TaskId = result.TaskId;
        delete state.journeySync[tempId];
        paintStudentJourney(activeJourneyRecord() || home);
        flashJourneyRows(result.TaskId, 'confirmed');
        showSuccess('To-do added.');
      }).catch(function(error) {
        delete state.journeySync[tempId];
        record.actionItems = (record.actionItems || []).filter(function(item) { return item !== created; });
        paintStudentJourney(activeJourneyRecord() || home);
        showError(error);
      });
    });
  });
  main.querySelectorAll('[data-edit-todo]').forEach(function(button) {
    button.addEventListener('click', function() {
      state.editingTodo = button.dataset.editTodo;
      paintStudentJourney(home);
    });
  });
  const closeTodo = main.querySelector('[data-close-todo]');
  if (closeTodo) closeTodo.addEventListener('click', function() { state.editingTodo = ''; paintStudentJourney(home); });
  main.querySelectorAll('[data-save-todo]').forEach(function(button) {
    button.addEventListener('click', function() {
      const card = button.closest('[data-task-id]');
      const title = card.querySelector('[data-todo-title]').value;
      const description = card.querySelector('[data-todo-description]').value;
      const date = card.querySelector('[data-todo-date]').value;
      const taskId = button.dataset.saveTodo;
      const record = activeJourneyRecord() || home;
      const item = (record.actionItems || []).filter(function(entry) { return entry.TaskId === taskId; })[0];
      const previous = item ? { Title: item.Title, Description: item.Description, DueDate: item.DueDate } : null;
      if (item) {
        item.Title = title;
        item.Description = description;
        item.DueDate = date;
      }
      state.editingTodo = '';
      state.journeySync[taskId] = 'pending';
      paintStudentJourney(record);
      runMutation('saveStudentTodo', [taskId, title, description, date], { key: 'action-item:' + taskId }).then(function() {
        delete state.journeySync[taskId];
        flashJourneyRows(taskId, 'confirmed');
        showSuccess('To-do saved.');
      }).catch(function(error) {
        delete state.journeySync[taskId];
        if (item && previous) {
          item.Title = previous.Title;
          item.Description = previous.Description;
          item.DueDate = previous.DueDate;
        }
        state.editingTodo = taskId;
        paintStudentJourney(activeJourneyRecord() || home);
        showError(error);
      });
    });
  });
  main.querySelectorAll('[data-edit-milestone]').forEach(function(button) {
    button.addEventListener('click', function() {
      openMilestoneEditor(home, button.dataset.editMilestone);
    });
  });
}

export function activeJourneyRecord() {
  if (state.user && state.user.role !== 'student' && state.staffStudentHome) return state.staffStudentHome;
  return state.studentHome;
}

export function repaintStudentPage(home) {
  const top = window.scrollY;
  paintStudentPage(home);
  window.scrollTo(0, top);
}

export function flashJourneyRows(taskId, status) {
  Array.prototype.forEach.call(document.querySelectorAll('#journey-body [data-task-id]'), function(node) {
    if (node.dataset.taskId === taskId) markSync(node, status);
  });
}

export function patchJourneyItem(taskId, changes) {
  const home = activeJourneyRecord();
  if (!home || !home.actionItems) return;
  const item = home.actionItems.filter(function(entry) { return entry.TaskId === taskId; })[0];
  if (!item) return;
  Object.keys(changes).forEach(function(key) { item[key] = changes[key]; });
}
