import { closeAdminDialog, openAdminDialog } from './records.js';
import { renderAdmin } from './sections.js';
import { requestPush } from '../router.js';
import { callServer, markSync } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { cssEscape, escapeHtml, hexColour, toBoolean } from '../shared/html.js';
import { loadingLine } from '../shared/loading.js';
import { isStale } from '../shared/scene.js';
import { state } from '../shared/state.js';

export const PATHWAY_COLORS = ['#004C80', '#0E8A6A', '#FF5A36', '#6B4C9A', '#B8860B', '#0E7C86', '#C43D6E', '#3E6B4F'];

export let pathwayPainting = false;

export const PATHWAY_TYPES = ['form', 'upload', 'doc', 'approval', 'meeting'];

export const PATHWAY_OWNERS = ['student', 'supervisor', 'lead', 'coordinator'];

export const PATHWAY_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function readPlanSetting(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null || value === '' ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

export function writePlanSetting(key, value) {
  try { window.localStorage.setItem(key, String(value)); } catch (error) { /* the plan still works for this visit */ }
}

export function clonePathway(value) {
  return JSON.parse(JSON.stringify(value));
}

export function pathwayOffset(value) {
  const number = Number(value);
  return isFinite(number) ? Math.round(number) : 0;
}

export function parsePlanDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

export function formatPlanDate(date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return date.getUTCFullYear() + '-' + month + '-' + day;
}

export function addPlanDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function addPlanMonths(date, count) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

export function startOfPlanMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function planMonthKey(date) {
  return formatPlanDate(startOfPlanMonth(date)).slice(0, 7);
}

export function planMonthDiff(start, end) {
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
}

export function planDaysBetween(fromDate, toDate) {
  return Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
}

export function formatPlanLabel(date) {
  return date.getUTCDate() + ' ' + PATHWAY_MONTHS[date.getUTCMonth()] + ' ' + date.getUTCFullYear();
}

export function pathwayDefaultAnchorIso() {
  const now = new Date();
  return formatPlanDate(new Date(Date.UTC(now.getFullYear(), now.getMonth() + 5, 1)));
}

export function pathwayTodayIso() {
  const now = new Date();
  return formatPlanDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function ensurePathwayPlan() {
  if (state.pathwayPlan) return state.pathwayPlan;
  let hidden = {};
  try {
    const parsed = JSON.parse(readPlanSetting('ee-hub-plan-hidden', '[]'));
    if (Array.isArray(parsed)) parsed.forEach(function(id) { hidden[String(id)] = true; });
  } catch (error) { hidden = {}; }
  const storedAnchor = readPlanSetting('ee-hub-plan-anchor', pathwayDefaultAnchorIso());
  const storedMonths = Number(readPlanSetting('ee-hub-plan-months', '2'));
  state.pathwayPlan = {
    phases: [],
    milestones: [],
    anchorDate: parsePlanDate(storedAnchor) ? String(storedAnchor).slice(0, 10) : pathwayDefaultAnchorIso(),
    monthsVisible: Math.max(2, Math.min(6, storedMonths || 2)),
    hiddenPhaseIds: hidden,
    openPhaseIds: {},
    openMilestoneIds: {},
    leadMonths: 1,
    trailMonths: 1,
    selectedMilestoneId: '',
    preferredPhaseId: '',
    persistedPhases: {},
    persistedMilestones: {},
    baselines: { phases: {}, milestones: {} },
    saving: {},
    timers: {},
    loaded: false,
    loadToken: 0,
    pendingScroll: 'anchor',
    scrollLeft: 0,
    dragId: '',
    didDrop: false,
    focusAfterPaint: '',
    selectAfterPaint: false,
    resizeBound: false
  };
  return state.pathwayPlan;
}

export function pathwayAnchorIso() {
  return ensurePathwayPlan().anchorDate;
}

export function pathwayNormalizePhase(record) {
  return {
    phaseId: String(record.phaseId || '').trim().toLowerCase(),
    phaseTitle: String(record.phaseTitle || ''),
    phaseDescription: String(record.phaseDescription || ''),
    sequence: record.sequence === '' || record.sequence === undefined || record.sequence === null ? '' : Number(record.sequence),
    prerequisitePhaseId: String(record.prerequisitePhaseId || ''),
    active: toBoolean(record.active),
    phaseColor: hexColour(record.phaseColor)
  };
}

export function pathwayNormalizeMilestone(record) {
  return {
    milestoneId: String(record.milestoneId || '').trim(),
    type: String(record.type || 'form').toLowerCase(),
    milestoneTitle: String(record.milestoneTitle || ''),
    offsetDays: pathwayOffset(record.offsetDays),
    milestoneDescription: String(record.milestoneDescription || ''),
    phase: String(record.phase || ''),
    mOwner: String(record.mOwner || 'student').toLowerCase(),
    isAnchor: record.isAnchor === undefined || record.isAnchor === null || record.isAnchor === '' ? null : toBoolean(record.isAnchor),
    deleting: !!record.deleting
  };
}

export function pathwayPhasePayload(phase) {
  const sequenceText = String(phase.sequence === undefined || phase.sequence === null ? '' : phase.sequence).trim();
  return {
    phaseId: String(phase.phaseId || '').trim().toLowerCase(),
    phaseTitle: String(phase.phaseTitle || '').trim(),
    phaseDescription: String(phase.phaseDescription || ''),
    sequence: sequenceText === '' ? NaN : Number(sequenceText),
    prerequisitePhaseId: String(phase.prerequisitePhaseId || ''),
    active: !!phase.active,
    phaseColor: hexColour(phase.phaseColor)
  };
}

export function pathwayMilestonePayload(milestone) {
  const payload = {
    milestoneId: String(milestone.milestoneId || '').trim(),
    type: String(milestone.type || 'form').toLowerCase(),
    milestoneTitle: String(milestone.milestoneTitle || '').trim(),
    offsetDays: pathwayOffset(milestone.offsetDays),
    milestoneDescription: String(milestone.milestoneDescription || ''),
    phase: String(milestone.phase || ''),
    mOwner: String(milestone.mOwner || 'student').toLowerCase()
  };
  if (milestone.isAnchor === true || milestone.isAnchor === false) payload.isAnchor = milestone.isAnchor;
  return payload;
}

export function pathwaySamePayload(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function pathwaySortedPhases() {
  return ensurePathwayPlan().phases.slice().sort(function(left, right) {
    const delta = (Number(left.sequence) || 0) - (Number(right.sequence) || 0);
    if (delta) return delta;
    return String(left.phaseTitle).localeCompare(String(right.phaseTitle));
  });
}

export function pathwayFindPhase(id) {
  return ensurePathwayPlan().phases.filter(function(phase) { return phase.phaseId === id; })[0] || null;
}

export function pathwayFindMilestone(id) {
  return ensurePathwayPlan().milestones.filter(function(milestone) { return milestone.milestoneId === id; })[0] || null;
}

export function pathwayPhaseColor(phaseId) {
  const phase = pathwayFindPhase(phaseId);
  const chosen = phase && hexColour(phase.phaseColor);
  if (chosen) return chosen;
  const phases = pathwaySortedPhases();
  let index = 0;
  phases.forEach(function(item, phaseIndex) { if (item.phaseId === phaseId) index = phaseIndex; });
  return PATHWAY_COLORS[index % PATHWAY_COLORS.length];
}

export function pathwayIsAnchor(milestone) {
  if (!milestone || milestone.deleting) return false;
  const milestones = ensurePathwayPlan().milestones.filter(function(item) { return !item.deleting; });
  if (milestones.some(function(item) { return item.isAnchor === true; })) return milestone.isAnchor === true;
  if (milestones.some(function(item) { return item.isAnchor === false; })) return false;
  if (pathwayOffset(milestone.offsetDays) !== 0) return false;
  const onAnchorDate = milestones.filter(function(item) { return pathwayOffset(item.offsetDays) === 0; });
  return onAnchorDate.length === 1 && onAnchorDate[0].milestoneId === milestone.milestoneId;
}

export function pathwayAnchorMilestone() {
  return ensurePathwayPlan().milestones.filter(function(milestone) { return pathwayIsAnchor(milestone); })[0] || null;
}

export function pathwayVisibleMilestones() {
  const hidden = ensurePathwayPlan().hiddenPhaseIds;
  return ensurePathwayPlan().milestones.filter(function(milestone) {
    return !hidden[milestone.phase];
  }).sort(function(left, right) {
    const delta = pathwayOffset(right.offsetDays) - pathwayOffset(left.offsetDays);
    if (delta) return delta;
    return String(left.milestoneTitle).localeCompare(String(right.milestoneTitle));
  });
}

export function pathwayMilestoneIso(milestone) {
  const anchor = parsePlanDate(pathwayAnchorIso());
  if (!anchor) return '';
  return formatPlanDate(addPlanDays(anchor, -pathwayOffset(milestone.offsetDays)));
}

export function pathwaySetMilestoneDate(milestone, iso) {
  const anchor = parsePlanDate(pathwayAnchorIso());
  const due = parsePlanDate(iso);
  if (!anchor || !due) return false;
  milestone.offsetDays = planDaysBetween(due, anchor);
  return true;
}

export function pathwayOffsetLabel(offset) {
  const days = pathwayOffset(offset);
  if (days === 0) return 'On the anchor date';
  const size = Math.abs(days);
  const unit = size === 1 ? 'day' : 'days';
  return days > 0 ? size + ' ' + unit + ' before the anchor' : size + ' ' + unit + ' after the anchor';
}

export function pathwayDefaultPhaseId() {
  const phases = pathwaySortedPhases().filter(function(phase) {
    return phase.active && !state.pathwayPlan.hiddenPhaseIds[phase.phaseId];
  });
  if (state.pathwayPlan.preferredPhaseId && phases.some(function(phase) { return phase.phaseId === state.pathwayPlan.preferredPhaseId; })) {
    return state.pathwayPlan.preferredPhaseId;
  }
  return phases.length ? phases[0].phaseId : '';
}

export function pathwayNextId(prefix, records, field) {
  const used = {};
  records.forEach(function(record) { used[record[field]] = true; });
  let number = records.length + 1;
  while (used[prefix + number]) number += 1;
  return prefix + number;
}

export function pathwayOptionList(values, current) {
  const options = values.slice();
  if (current && options.indexOf(current) < 0) options.push(current);
  return options.map(function(value) {
    return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(value)}</option>`;
  }).join('');
}

export function pathwayPhaseOptions(current) {
  const options = pathwaySortedPhases().map(function(phase) {
    const label = (phase.phaseTitle || phase.phaseId) + (phase.active ? '' : ' (inactive)');
    return `<option value="${escapeHtml(phase.phaseId)}" ${phase.phaseId === current ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  });
  if (current && !pathwayFindPhase(current)) options.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
  return options.join('');
}

export function pathwayPrerequisiteOptions(phase) {
  const options = ['<option value="">No prerequisite</option>'].concat(pathwaySortedPhases().filter(function(item) {
    return item.phaseId !== phase.phaseId;
  }).map(function(item) {
    return `<option value="${escapeHtml(item.phaseId)}" ${item.phaseId === phase.prerequisitePhaseId ? 'selected' : ''}>${escapeHtml(item.phaseTitle || item.phaseId)}</option>`;
  }));
  return options.join('');
}

export function pathwaySyncClass(kind, id) {
  return state.pathwayPlan.saving[kind + ':' + id] ? ' sync-pending' : '';
}

export function pathwayIngest(phaseRecords, milestoneRecords) {
  const plan = ensurePathwayPlan();
  plan.phases = phaseRecords.map(pathwayNormalizePhase).filter(function(phase) { return phase.phaseId; });
  plan.milestones = milestoneRecords.map(pathwayNormalizeMilestone).filter(function(milestone) { return milestone.milestoneId; });
  plan.persistedPhases = {};
  plan.persistedMilestones = {};
  plan.baselines = { phases: {}, milestones: {} };
  plan.phases.forEach(function(phase) {
    plan.persistedPhases[phase.phaseId] = true;
    plan.baselines.phases[phase.phaseId] = clonePathway(phase);
  });
  plan.milestones.forEach(function(milestone) {
    plan.persistedMilestones[milestone.milestoneId] = true;
    plan.baselines.milestones[milestone.milestoneId] = clonePathway(milestone);
  });
}

export function renderPathwayPlanner(target) {
  const plan = ensurePathwayPlan();
  const busy = Object.keys(plan.saving).length > 0 || Object.keys(plan.timers).length > 0;
  if (plan.loaded && busy) {
    plan.pendingScroll = 'preserve';
    paintPathway();
    return;
  }
  const token = ++plan.loadToken;
  target.innerHTML = loadingLine('Loading phases and milestones...');
  callServer('getPathwayPlan').then(function(result) {
    if (!state.pathwayPlan || token !== state.pathwayPlan.loadToken) return;
    pathwayIngest((result.phases && result.phases.records) || [], (result.milestones && result.milestones.records) || []);
    state.pathwayPlan.loaded = true;
    state.pathwayPlan.pendingScroll = 'anchor';
    paintPathway();
  }).catch(function(error) {
    if (isStale(error)) return;
    showError(error);
    if (target) target.innerHTML = '<div class="empty">Phases and milestones could not be loaded.</div>';
  });
}

export function paintPathway() {
  const target = document.getElementById('admin-content');
  const plan = ensurePathwayPlan();
  if (pathwayPainting || state.section !== 'admin' || state.adminEntity !== 'pathway') return;
  if (!target || !plan.loaded) return;
  pathwayPainting = true;
  try {
  const previous = document.activeElement;
  const focusKey = plan.focusAfterPaint || (previous && previous.getAttribute ? previous.getAttribute('data-focus') : '');
  const selectionStart = previous && typeof previous.selectionStart === 'number' ? previous.selectionStart : null;
  const selectionEnd = previous && typeof previous.selectionEnd === 'number' ? previous.selectionEnd : null;
  const selectAll = plan.selectAfterPaint;
  plan.focusAfterPaint = '';
  plan.selectAfterPaint = false;
  const scroller = document.getElementById('plan-scroll');
  const side = document.querySelector('.plan-side');
  const sideScroll = side ? side.scrollTop : 0;
  if (scroller && plan.pendingScroll === 'preserve') plan.scrollLeft = scroller.scrollLeft;
  target.innerHTML = pathwayMarkup();
  pathwayBind(target);
  const nextSide = document.querySelector('.plan-side');
  if (nextSide) nextSide.scrollTop = sideScroll;
  sizePathwayMonths();
  pathwayApplyScroll();
  if (focusKey) {
    const next = target.querySelector('[data-focus="' + cssEscape(focusKey) + '"]');
    if (next) {
      next.focus();
      if (selectAll && next.select) next.select();
      else if (selectionStart !== null && next.setSelectionRange) {
        const end = selectionEnd === null ? selectionStart : selectionEnd;
        const length = String(next.value || '').length;
        next.setSelectionRange(Math.min(selectionStart, length), Math.min(end, length));
      }
    }
  }
  Object.keys(plan.saving).forEach(function(key) {
    const parts = key.split(':');
    pathwayMarkSaving(parts[0], parts.slice(1).join(':'), 'pending');
  });
  if (!plan.resizeBound) {
    plan.resizeBound = true;
    window.addEventListener('resize', function() {
      if (state.section !== 'admin' || state.adminEntity !== 'pathway') return;
      sizePathwayMonths();
    });
  }
  } finally {
    pathwayPainting = false;
  }
}

export function pathwayMarkup() {
  const plan = state.pathwayPlan;
  const hiddenCount = Object.keys(plan.hiddenPhaseIds).length;
  const visible = pathwayVisibleMilestones();
  const anchorMilestone = pathwayAnchorMilestone();
  return `<div id="pathway-planner">
    <p class="lede plan-intro">Define the phases first, then choose one anchor milestone. Add the other milestones on the calendar. Colour shows the phase. A hidden phase drops its milestones from the calendar and the list.</p>
    <div class="plan-layout">
    <aside class="plan-side">
    <section class="plan-block" aria-labelledby="plan-phases-heading">
      <div class="toolbar"><h2 id="plan-phases-heading">Phases</h2><button type="button" class="button" data-plan-action="add-phase">Add phase</button>${hiddenCount ? '<button type="button" class="button secondary" data-plan-action="show-phases">Show all phases</button>' : ''}</div>
      <p class="muted">Shown phases stay on the calendar. Set a colour for each phase.</p>
      ${plan.phases.length ? `<div class="plan-phase-list">${pathwaySortedPhases().map(pathwayPhaseMarkup).join('')}</div>` : '<div class="empty">Add the first phase to start the plan.</div>'}
    </section>
    </aside>
    <div class="plan-main">
    <section class="plan-anchor plan-block" style="--phase:${anchorMilestone ? pathwayPhaseColor(anchorMilestone.phase) : '#004C80'}">
      <div class="field"><label for="plan-anchor-date">Anchor date</label><input id="plan-anchor-date" type="date" value="${escapeHtml(plan.anchorDate)}"><p class="muted">Day 0 on this calendar. Changing it moves the preview only. Each student still has an anchor date under Assignments.</p></div>
      <div>${pathwayAnchorCopy(anchorMilestone)}</div>
      <div class="field"><span id="plan-months-label">Months in view</span><div class="plan-span" role="radiogroup" aria-labelledby="plan-months-label">${[2, 3, 4, 5, 6].map(function(count) {
        return `<button type="button" data-plan-action="months" data-months="${count}" aria-pressed="${plan.monthsVisible === count ? 'true' : 'false'}">${count}</button>`;
      }).join('')}</div><p class="muted">Desktop opens on 2 months. Choose up to 6 across the width, then scroll for the rest.</p></div>
    </section>
    <section class="plan-block" aria-labelledby="plan-calendar-heading">
      <div class="toolbar"><h2 id="plan-calendar-heading">Calendar</h2><button type="button" class="button secondary" data-plan-action="earlier">Earlier</button><button type="button" class="button secondary" data-plan-action="later">Later</button><button type="button" class="button secondary" data-plan-action="jump-anchor">Jump to anchor</button><span class="muted">${visible.length} milestone${visible.length === 1 ? '' : 's'} in view. Drag a milestone to another day, or click a day to add one.</span></div>
      <div id="plan-scroll" class="plan-scroll" tabindex="0" aria-label="Milestone calendar, scroll horizontally">
        <div class="plan-track">${pathwayMonths().map(pathwayMonthMarkup).join('')}</div>
      </div>
    </section>
    <section class="plan-block" aria-labelledby="plan-list-heading">
      <div class="toolbar"><h2 id="plan-list-heading">Milestones</h2><button type="button" class="button" data-plan-action="add-milestone">Add milestone</button><button type="button" class="button secondary" data-plan-action="email-notifications">Email notifications</button><span class="muted">Edit the list here. Hidden phases are left out.</span></div>
      ${visible.length ? `<div class="plan-edit-list">${visible.map(pathwayMilestoneMarkup).join('')}</div>` : '<div class="empty">No milestones in the phases that are shown. Show a phase, or add a milestone.</div>'}
    </section>
    </div>
    </div>
  </div>`;
}

export function pathwayAnchorCopy(anchorMilestone) {
  if (!anchorMilestone) {
    return `<p class="eyebrow">Anchor milestone</p><p>No milestone is the anchor yet. Name one to land on each student's anchor date, or choose Make anchor on a milestone.</p>
      <div class="toolbar"><input id="plan-anchor-title" data-focus="anchor:title" placeholder="Final essay" aria-label="Anchor milestone title"><button type="button" class="button" data-plan-action="add-anchor">Add on this date</button></div>`;
  }
  const phase = pathwayFindPhase(anchorMilestone.phase);
  const hidden = !!state.pathwayPlan.hiddenPhaseIds[anchorMilestone.phase];
  const name = escapeHtml(anchorMilestone.milestoneTitle || anchorMilestone.milestoneId) + (phase ? ' · ' + escapeHtml(phase.phaseTitle || phase.phaseId) : '') + (hidden ? ' · hidden by filter' : '');
  return `<p class="eyebrow">Anchor milestone</p><p>${name}</p><button type="button" class="button secondary" data-plan-action="add-anchor">Add a milestone on this date</button>`;
}

export function pathwayColourChoices(phase) {
  const selected = hexColour(phase.phaseColor);
  const shown = selected || hexColour(pathwayPhaseColor(phase.phaseId));
  const swatches = PATHWAY_COLORS.map(function(colour) {
    const value = hexColour(colour);
    const pressed = value === shown;
    return `<button type="button" class="plan-colour" data-plan-action="phase-colour" data-phase-id="${escapeHtml(phase.phaseId)}" data-colour="${value}" data-focus="phase:${escapeHtml(phase.phaseId)}:colour:${value}" style="--swatch:${value}" aria-pressed="${pressed ? 'true' : 'false'}" aria-label="Phase colour ${value}" ${phase.deleting ? 'disabled' : ''}></button>`;
  }).join('');
  return `<div class="field plan-phase-colour"><span id="phase-colour-${escapeHtml(phase.phaseId)}">Colour</span><div class="plan-colours" role="radiogroup" aria-labelledby="phase-colour-${escapeHtml(phase.phaseId)}">${swatches}<label class="plan-colour-custom"><span class="sr">Custom</span><input type="color" aria-label="Custom phase colour" data-focus="phase:${escapeHtml(phase.phaseId)}:colour" data-phase-id="${escapeHtml(phase.phaseId)}" data-phase-field="phaseColor" value="${escapeHtml(shown || '#004c80')}" ${phase.deleting ? 'disabled' : ''}></label></div></div>`;
}

export function pathwayPhaseMarkup(phase) {
  const hidden = !!state.pathwayPlan.hiddenPhaseIds[phase.phaseId];
  const open = !!state.pathwayPlan.openPhaseIds[phase.phaseId];
  const color = pathwayPhaseColor(phase.phaseId);
  const count = state.pathwayPlan.milestones.filter(function(milestone) { return milestone.phase === phase.phaseId; }).length;
  const locked = phase.deleting ? 'disabled' : '';
  const id = escapeHtml(phase.phaseId);
  return `<article class="plan-phase plan-sync${hidden ? ' is-hidden' : ''}${open ? ' is-open' : ''}${pathwaySyncClass('phase', phase.phaseId)}" data-sync-key="phase:${id}" style="--phase:${color}">
    <div class="plan-phase-summary">
      <button type="button" class="plan-phase-toggle" data-plan-action="toggle-phase" data-phase-id="${id}" data-focus="phase:${id}:toggle" aria-expanded="${open ? 'true' : 'false'}">
        <span class="plan-swatch" style="--phase:${color}"></span>
        <span class="plan-phase-name">${escapeHtml(phase.phaseTitle || 'Untitled phase')}</span>
      </button>
      <button type="button" class="plan-filter" data-plan-action="filter-phase" data-phase-id="${id}" aria-pressed="${hidden ? 'false' : 'true'}">
        <span class="plan-swatch" style="--phase:${color}"></span>${hidden ? 'Hidden' : 'Shown'}
      </button>
      ${open ? `<button type="button" class="link-button" data-plan-action="delete-phase" data-phase-id="${id}">Delete</button>` : ''}
    </div>
    ${open ? `<div class="plan-phase-fields">
      <div class="field"><label>Title</label><input ${locked} data-focus="phase:${id}:title" data-phase-id="${id}" data-phase-field="phaseTitle" value="${escapeHtml(phase.phaseTitle)}"></div>
      <div class="field plan-phase-order"><label>Order</label><input ${locked} type="number" data-focus="phase:${id}:sequence" data-phase-id="${id}" data-phase-field="sequence" value="${escapeHtml(phase.sequence)}"></div>
      <label class="field check"><input type="checkbox" ${locked} data-phase-id="${id}" data-phase-field="active" ${phase.active ? 'checked' : ''}> Active</label>
      <div class="field"><label>Prerequisite</label><select ${locked} data-focus="phase:${id}:prerequisite" data-phase-id="${id}" data-phase-field="prerequisitePhaseId">${pathwayPrerequisiteOptions(phase)}</select></div>
      ${pathwayColourChoices(phase)}
    </div>
    <div class="field"><label>Description</label><textarea ${locked} data-focus="phase:${id}:description" data-phase-id="${id}" data-phase-field="phaseDescription">${escapeHtml(phase.phaseDescription || '')}</textarea><p class="muted plan-count">${count} milestone${count === 1 ? '' : 's'}</p></div>` : ''}
  </article>`;
}

export function pathwayMonths() {
  const anchor = parsePlanDate(pathwayAnchorIso()) || parsePlanDate(pathwayDefaultAnchorIso());
  let min = anchor;
  let max = anchor;
  pathwayVisibleMilestones().forEach(function(milestone) {
    const due = parsePlanDate(pathwayMilestoneIso(milestone));
    if (!due) return;
    if (due.getTime() < min.getTime()) min = due;
    if (due.getTime() > max.getTime()) max = due;
  });
  const plan = state.pathwayPlan;
  let start = addPlanMonths(startOfPlanMonth(min), -plan.leadMonths);
  let end = addPlanMonths(startOfPlanMonth(max), plan.trailMonths);
  while (planMonthDiff(start, end) + 1 < plan.monthsVisible) end = addPlanMonths(end, 1);
  const months = [];
  for (let cursor = start; cursor.getTime() <= end.getTime() && months.length < 48; cursor = addPlanMonths(cursor, 1)) months.push(cursor);
  return months;
}

export function pathwayMonthMarkup(monthDate) {
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const anchorIso = pathwayAnchorIso();
  const today = pathwayTodayIso();
  let cells = '';
  for (let blank = 0; blank < firstWeekday; blank += 1) cells += '<span class="plan-blank"></span>';
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = formatPlanDate(new Date(Date.UTC(year, month, day)));
    const milestones = pathwayVisibleMilestones().filter(function(milestone) { return pathwayMilestoneIso(milestone) === iso; });
    const classes = ['plan-day'];
    if (iso === anchorIso) classes.push('is-anchor-day');
    if (iso === today) classes.push('is-today');
    cells += `<div class="${classes.join(' ')}" data-plan-date="${iso}"><button type="button" class="plan-day-hit" data-plan-add="${iso}" aria-label="Add a milestone on ${escapeHtml(formatPlanLabel(parsePlanDate(iso)))}">${day}</button><div class="plan-chips">${milestones.map(pathwayChipMarkup).join('')}</div></div>`;
  }
  return `<section class="plan-month" data-month="${planMonthKey(monthDate)}"><h3>${PATHWAY_MONTHS[month]} ${year}</h3><div class="plan-weekdays" aria-hidden="true"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div><div class="plan-grid">${cells}</div></section>`;
}

export function pathwayChipMarkup(milestone) {
  const color = pathwayPhaseColor(milestone.phase);
  const anchor = pathwayIsAnchor(milestone);
  const selected = state.pathwayPlan.selectedMilestoneId === milestone.milestoneId;
  const label = (milestone.milestoneTitle || 'Untitled') + ' · ' + pathwayOffsetLabel(milestone.offsetDays);
  return `<button type="button" class="plan-chip plan-sync${anchor ? ' is-anchor' : ''}${selected ? ' is-selected' : ''}${pathwaySyncClass('milestone', milestone.milestoneId)}" draggable="${milestone.deleting ? 'false' : 'true'}" data-chip-id="${escapeHtml(milestone.milestoneId)}" data-sync-key="milestone:${escapeHtml(milestone.milestoneId)}" style="--phase:${color}" title="${escapeHtml(label)}"><span class="plan-chip-title">${escapeHtml(milestone.milestoneTitle || 'Untitled')}</span></button>`;
}

export function pathwayDetailsIcon(open) {
  if (open) return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 10.2 8 5.2l5 5-.9.9L8 7.1l-4.1 4z"/></svg>';
  return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.2 1.6 14.4 4.8 5.2 14H2v-3.2zM3.1 11.9l.3 1.7 1.7.3 6.7-6.7-2-2z"/></svg>';
}

export function pathwayMilestoneMarkup(milestone) {
  const color = pathwayPhaseColor(milestone.phase);
  const selected = state.pathwayPlan.selectedMilestoneId === milestone.milestoneId;
  const open = !!state.pathwayPlan.openMilestoneIds[milestone.milestoneId];
  const anchor = pathwayIsAnchor(milestone);
  const locked = milestone.deleting ? 'disabled' : '';
  const id = escapeHtml(milestone.milestoneId);
  return `<article class="plan-edit plan-sync${selected ? ' is-selected' : ''}${open ? ' is-open' : ''}${pathwaySyncClass('milestone', milestone.milestoneId)}" data-milestone-row="${id}" data-sync-key="milestone:${id}" style="--phase:${color}">
    <div class="plan-edit-main">
      <span class="plan-swatch" style="--phase:${color}"></span>
      <div class="plan-edit-fields">
        <div class="field"><label>Title</label><input ${locked} data-focus="milestone:${id}:title" data-milestone-id="${id}" data-milestone-field="milestoneTitle" value="${escapeHtml(milestone.milestoneTitle)}"></div>
        <div class="field"><label>Date</label><input ${locked} type="date" data-focus="milestone:${id}:due" data-milestone-id="${id}" data-milestone-field="due" value="${escapeHtml(pathwayMilestoneIso(milestone))}"></div>
        <div class="field"><label>Days before anchor</label><input ${locked} type="number" data-focus="milestone:${id}:offset" data-milestone-id="${id}" data-milestone-field="offsetDays" value="${escapeHtml(milestone.offsetDays)}"></div>
      </div>
      <button type="button" class="plan-icon-button" data-plan-action="toggle-milestone" data-milestone-id="${id}" data-focus="milestone:${id}:details" aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? 'Hide milestone details' : 'Edit milestone details'}">${pathwayDetailsIcon(open)}</button>
    </div>
    ${open ? `<div class="plan-edit-more">
      <div class="field"><label>Phase</label><select ${locked} data-focus="milestone:${id}:phase" data-milestone-id="${id}" data-milestone-field="phase">${pathwayPhaseOptions(milestone.phase)}</select></div>
      <div class="field"><label>Type</label><select ${locked} data-focus="milestone:${id}:type" data-milestone-id="${id}" data-milestone-field="type">${pathwayOptionList(PATHWAY_TYPES, milestone.type)}</select></div>
      <div class="field"><label>Owner</label><select ${locked} data-focus="milestone:${id}:owner" data-milestone-id="${id}" data-milestone-field="mOwner">${pathwayOptionList(PATHWAY_OWNERS, milestone.mOwner)}</select></div>
      <div class="plan-actions"><button type="button" class="link-button" data-plan-action="${anchor ? 'release-anchor' : 'make-anchor'}" data-milestone-id="${id}" ${milestone.deleting ? 'disabled' : ''}>${anchor ? 'Release anchor' : 'Make anchor'}</button><button type="button" class="link-button" data-plan-action="email-milestone" data-milestone-id="${id}">Email notification</button><button type="button" class="link-button" data-plan-action="delete-milestone" data-milestone-id="${id}">Delete</button></div>
      <div class="field plan-edit-description"><label>Description</label><textarea ${locked} data-focus="milestone:${id}:description" data-milestone-id="${id}" data-milestone-field="milestoneDescription">${escapeHtml(milestone.milestoneDescription || '')}</textarea></div>
    </div>` : ''}
  </article>`;
}

export function pathwayBind(root) {
  root.addEventListener('click', pathwayOnClick);
  root.addEventListener('input', pathwayOnInput);
  root.addEventListener('change', pathwayOnChange);
  root.addEventListener('focusout', pathwayOnBlur);
  root.addEventListener('dragstart', pathwayOnDragStart);
  root.addEventListener('dragover', pathwayOnDragOver);
  root.addEventListener('drop', pathwayOnDrop);
  root.addEventListener('dragend', pathwayOnDragEnd);
  const scroller = document.getElementById('plan-scroll');
  if (scroller) scroller.addEventListener('scroll', function() { state.pathwayPlan.scrollLeft = scroller.scrollLeft; });
}

export function pathwayOnClick(event) {
  if (state.pathwayPlan.didDrop) {
    state.pathwayPlan.didDrop = false;
    return;
  }
  const actionNode = event.target.closest('[data-plan-action]');
  if (actionNode) {
    pathwayRunAction(actionNode);
    return;
  }
  const chip = event.target.closest('[data-chip-id]');
  if (chip) {
    pathwaySelectMilestone(chip.dataset.chipId);
    return;
  }
  const day = event.target.closest('.plan-day');
  if (day && !event.target.closest('.plan-chip')) pathwayAddMilestone(day.dataset.planDate);
}

export function pathwayRunAction(node) {
  const action = node.dataset.planAction;
  if (action === 'filter-phase') pathwayTogglePhase(node.dataset.phaseId);
  else if (action === 'toggle-phase') pathwayTogglePhaseOpen(node.dataset.phaseId);
  else if (action === 'toggle-milestone') pathwayToggleMilestoneOpen(node.dataset.milestoneId);
  else if (action === 'show-phases') pathwayShowAllPhases();
  else if (action === 'add-phase') pathwayAddPhase();
  else if (action === 'delete-phase') pathwayDeletePhase(node.dataset.phaseId);
  else if (action === 'add-milestone') pathwayAddMilestone(pathwayAnchorIso());
  else if (action === 'add-anchor') {
    const titleInput = document.getElementById('plan-anchor-title');
    pathwayAddMilestone(pathwayAnchorIso(), titleInput ? titleInput.value.trim() : '');
  } else if (action === 'months') pathwaySetMonths(Number(node.dataset.months));
  else if (action === 'earlier') pathwayExtend('earlier');
  else if (action === 'later') pathwayExtend('later');
  else if (action === 'jump-anchor') {
    const scroller = document.getElementById('plan-scroll');
    if (scroller) pathwayScrollAnchorIntoView(scroller);
  } else if (action === 'make-anchor') pathwayMakeAnchor(node.dataset.milestoneId);
  else if (action === 'release-anchor') pathwayReleaseAnchor(node.dataset.milestoneId);
  else if (action === 'phase-colour') pathwaySetPhaseColour(node.dataset.phaseId, node.dataset.colour);
  else if (action === 'delete-milestone') pathwayDeleteMilestone(node.dataset.milestoneId);
  else if (action === 'email-notifications') openEmailNotifications('');
  else if (action === 'email-milestone') openEmailNotifications(node.dataset.milestoneId);
}

export function openEmailNotifications(milestoneId) {
  requestPush();
  state.adminEntity = 'emailNotifications';
  state.noticeMilestoneId = milestoneId || '';
  state.noticeEdit = null;
  state.emailDesk = false;
  renderAdmin();
}

export function pathwayOnInput(event) {
  const input = event.target;
  if (!input || input.tagName === 'SELECT' || input.type === 'date' || input.type === 'color') return;
  if (input.dataset && input.dataset.phaseField) pathwayUpdatePhaseField(input);
  if (input.dataset && input.dataset.milestoneField) pathwayUpdateMilestoneField(input);
}

export function pathwayOnChange(event) {
  const input = event.target;
  if (!input) return;
  if (input.id === 'plan-anchor-date') {
    pathwaySetAnchorDate(input.value);
    return;
  }
  if (input.tagName !== 'SELECT' && input.type !== 'date' && input.type !== 'color') return;
  if (input.dataset && input.dataset.phaseField) pathwayUpdatePhaseField(input);
  if (input.dataset && input.dataset.milestoneField) pathwayUpdateMilestoneField(input);
}

export function pathwayOnBlur(event) {
  const input = event.target;
  if (pathwayPainting || !input || !input.dataset) return;
  if (input.dataset.phaseField === 'phaseTitle' && !String(input.value || '').trim()) {
    const phase = pathwayFindPhase(input.dataset.phaseId);
    const baseline = phase && state.pathwayPlan.baselines.phases[phase.phaseId];
    if (phase && baseline && baseline.phaseTitle) {
      phase.phaseTitle = baseline.phaseTitle;
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
    }
    showError(new Error('Phase title is required.'));
  }
  if (input.dataset.milestoneField === 'milestoneTitle' && !String(input.value || '').trim()) {
    const milestone = pathwayFindMilestone(input.dataset.milestoneId);
    const baseline = milestone && state.pathwayPlan.baselines.milestones[milestone.milestoneId];
    if (milestone) milestone.milestoneTitle = baseline && baseline.milestoneTitle ? baseline.milestoneTitle : 'New milestone';
    state.pathwayPlan.pendingScroll = 'preserve';
    paintPathway();
    showError(new Error('Milestone title is required.'));
  }
}

export function pathwayUpdatePhaseField(input) {
  const phase = pathwayFindPhase(input.dataset.phaseId);
  if (!phase || phase.deleting) return;
  const field = input.dataset.phaseField;
  if (field === 'active') phase.active = !!input.checked;
  else if (field === 'sequence') phase.sequence = input.value === '' ? '' : Number(input.value);
  else if (field === 'phaseColor') {
    const next = hexColour(input.value);
    if (!next || next === hexColour(phase.phaseColor)) return;
    phase.phaseColor = next;
  } else phase[field] = input.value;
  if (field === 'phaseTitle') {
    const name = input.closest('.plan-phase') && input.closest('.plan-phase').querySelector('.plan-phase-name');
    if (name) name.textContent = String(input.value || '').trim() || 'Untitled phase';
  }
  state.pathwayPlan.preferredPhaseId = phase.phaseId;
  if (field === 'sequence' || field === 'active' || field === 'prerequisitePhaseId' || field === 'phaseColor') {
    state.pathwayPlan.pendingScroll = 'preserve';
    paintPathway();
  }
  pathwaySchedulePhaseSave(phase.phaseId, field === 'phaseTitle' || field === 'phaseDescription' ? 450 : 0);
}

export function pathwayUpdateMilestoneField(input) {
  const milestone = pathwayFindMilestone(input.dataset.milestoneId);
  if (!milestone || milestone.deleting) return;
  const field = input.dataset.milestoneField;
  if (field === 'due') {
    if (!pathwaySetMilestoneDate(milestone, input.value)) return;
  } else if (field === 'offsetDays') {
    if (input.value === '' || input.value === '-') return;
    milestone.offsetDays = pathwayOffset(input.value);
  } else milestone[field] = input.value;
  if (field === 'milestoneTitle') pathwayRefreshChipTitle(milestone);
  if (field === 'due' || field === 'offsetDays' || field === 'phase' || field === 'type' || field === 'mOwner') {
    state.pathwayPlan.pendingScroll = 'preserve';
    state.pathwayPlan.selectedMilestoneId = milestone.milestoneId;
    paintPathway();
  }
  pathwayScheduleMilestoneSave(milestone.milestoneId, field === 'milestoneTitle' || field === 'milestoneDescription' ? 450 : 0);
}

export function pathwayRefreshChipTitle(milestone) {
  document.querySelectorAll('[data-chip-id="' + cssEscape(milestone.milestoneId) + '"] .plan-chip-title').forEach(function(node) {
    node.textContent = milestone.milestoneTitle || 'Untitled';
  });
}

export function pathwaySelectMilestone(id) {
  state.pathwayPlan.selectedMilestoneId = id;
  document.querySelectorAll('.plan-chip').forEach(function(chip) {
    chip.classList.toggle('is-selected', chip.dataset.chipId === id);
  });
  document.querySelectorAll('.plan-edit').forEach(function(row) {
    row.classList.toggle('is-selected', row.dataset.milestoneRow === id);
  });
  const row = document.querySelector('[data-milestone-row="' + cssEscape(id) + '"]');
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

export function pathwayTogglePhaseOpen(id) {
  const plan = state.pathwayPlan;
  const opening = !plan.openPhaseIds[id];
  if (opening) plan.openPhaseIds[id] = true;
  else delete plan.openPhaseIds[id];
  plan.pendingScroll = 'preserve';
  plan.focusAfterPaint = opening ? 'phase:' + id + ':title' : 'phase:' + id + ':toggle';
  paintPathway();
}

export function pathwayToggleMilestoneOpen(id) {
  const plan = state.pathwayPlan;
  if (plan.openMilestoneIds[id]) delete plan.openMilestoneIds[id];
  else plan.openMilestoneIds[id] = true;
  plan.selectedMilestoneId = id;
  plan.pendingScroll = 'preserve';
  plan.focusAfterPaint = 'milestone:' + id + ':details';
  paintPathway();
}

export function pathwayTogglePhase(id) {
  const hidden = state.pathwayPlan.hiddenPhaseIds;
  if (hidden[id]) delete hidden[id];
  else hidden[id] = true;
  writePlanSetting('ee-hub-plan-hidden', JSON.stringify(Object.keys(hidden)));
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
}

export function pathwayShowAllPhases() {
  state.pathwayPlan.hiddenPhaseIds = {};
  writePlanSetting('ee-hub-plan-hidden', '[]');
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
}

export function pathwaySetAnchorDate(iso) {
  if (!parsePlanDate(iso)) return;
  state.pathwayPlan.anchorDate = String(iso).slice(0, 10);
  writePlanSetting('ee-hub-plan-anchor', state.pathwayPlan.anchorDate);
  state.pathwayPlan.pendingScroll = 'anchor';
  paintPathway();
}

export function pathwaySetMonths(count) {
  const next = Math.max(2, Math.min(6, count || 2));
  state.pathwayPlan.monthsVisible = next;
  writePlanSetting('ee-hub-plan-months', String(next));
  state.pathwayPlan.pendingScroll = 'anchor';
  paintPathway();
}

export function pathwayExtend(direction) {
  if (direction === 'earlier') {
    if (state.pathwayPlan.leadMonths >= 24) return;
    state.pathwayPlan.leadMonths += 1;
    state.pathwayPlan.pendingScroll = 'start';
  } else {
    if (state.pathwayPlan.trailMonths >= 24) return;
    state.pathwayPlan.trailMonths += 1;
    state.pathwayPlan.pendingScroll = 'end';
  }
  paintPathway();
}

export function pathwayAddPhase() {
  const plan = state.pathwayPlan;
  const id = pathwayNextId('p', plan.phases, 'phaseId');
  const maxOrder = plan.phases.reduce(function(max, phase) {
    const number = Number(phase.sequence);
    return isFinite(number) ? Math.max(max, number) : max;
  }, 0);
  const ordered = pathwaySortedPhases();
  plan.phases.push({
    phaseId: id,
    phaseTitle: 'New phase',
    phaseDescription: '',
    sequence: maxOrder + 1,
    prerequisitePhaseId: ordered.length ? ordered[ordered.length - 1].phaseId : '',
    active: true,
    phaseColor: hexColour(PATHWAY_COLORS[ordered.length % PATHWAY_COLORS.length])
  });
  plan.preferredPhaseId = id;
  plan.openPhaseIds[id] = true;
  plan.focusAfterPaint = 'phase:' + id + ':title';
  plan.selectAfterPaint = true;
  plan.pendingScroll = 'preserve';
  paintPathway();
  pathwayCommitPhase(id);
}

export function pathwayAddMilestone(iso, title) {
  const phaseId = pathwayDefaultPhaseId();
  if (!phaseId) {
    showError(new Error('Add an active phase, and leave it shown, before adding a milestone.'));
    return;
  }
  const anchor = parsePlanDate(pathwayAnchorIso());
  const due = parsePlanDate(iso) || anchor;
  if (!anchor || !due) return;
  const id = pathwayNextId('m', state.pathwayPlan.milestones, 'milestoneId');
  const offsetDays = planDaysBetween(due, anchor);
  const existingAnchor = pathwayAnchorMilestone();
  if (offsetDays === 0 && existingAnchor && existingAnchor.isAnchor !== true) {
    existingAnchor.isAnchor = true;
    pathwayScheduleMilestoneSave(existingAnchor.milestoneId, 0);
  }
  state.pathwayPlan.milestones.push({
    milestoneId: id,
    type: 'form',
    milestoneTitle: title || 'New milestone',
    offsetDays: offsetDays,
    milestoneDescription: '',
    phase: phaseId,
    mOwner: 'student',
    isAnchor: offsetDays === 0 && !existingAnchor ? true : null
  });
  state.pathwayPlan.selectedMilestoneId = id;
  state.pathwayPlan.preferredPhaseId = phaseId;
  state.pathwayPlan.focusAfterPaint = 'milestone:' + id + ':title';
  state.pathwayPlan.selectAfterPaint = true;
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
  pathwayCommitMilestone(id);
}

export function pathwaySetPhaseColour(id, colour) {
  const phase = pathwayFindPhase(id);
  const next = hexColour(colour);
  if (!phase || phase.deleting || !next || hexColour(phase.phaseColor) === next) return;
  phase.phaseColor = next;
  state.pathwayPlan.preferredPhaseId = id;
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
  pathwaySchedulePhaseSave(id, 0);
}

export function pathwayMakeAnchor(id) {
  const milestone = pathwayFindMilestone(id);
  if (!milestone || milestone.deleting || pathwayIsAnchor(milestone)) return;
  const previous = pathwayAnchorMilestone();
  const previousNote = previous && previous.milestoneId !== milestone.milestoneId
    ? ' This releases ' + (previous.milestoneTitle || previous.milestoneId) + ' as the anchor.'
    : '';
  openAdminDialog('pathway-anchor', `<div class="form-panel" role="dialog" aria-modal="true" aria-labelledby="anchor-choice-title"><div class="toolbar"><h2 id="anchor-choice-title">Make this the anchor</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p>Only one milestone can be the anchor. Choose how to set ${escapeHtml(milestone.milestoneTitle || milestone.milestoneId)} as that milestone.${escapeHtml(previousNote)}</p>
    <form id="anchor-choice-form"><div class="plan-anchor-choice">
      <label class="check-option"><input type="radio" name="anchor-mode" value="adjust" checked> Keep the dates and adjust every other Days before anchor field so they count from this milestone. The preview anchor date moves with those dates.</label>
      <label class="check-option"><input type="radio" name="anchor-mode" value="move"> Set this milestone as the existing anchor date. Other Days before anchor fields stay as they are, and the previous anchor is released.</label>
    </div>
    <p class="notice error" id="anchor-choice-error" hidden></p>
    <div class="toolbar"><button class="button" type="submit">Update anchor</button><button class="button secondary" type="button" data-close-admin-dialog>Cancel</button></div></form></div>`);
  const form = document.getElementById('anchor-choice-form');
  if (!form) return;
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    const selected = form.querySelector('input[name="anchor-mode"]:checked');
    closeAdminDialog();
    pathwayApplyAnchorChoice(id, selected ? selected.value : 'adjust');
  });
}

export function pathwayReleaseAnchor(id) {
  const milestone = pathwayFindMilestone(id);
  if (!milestone || milestone.deleting || !pathwayIsAnchor(milestone)) return;
  openAdminDialog('pathway-anchor', `<div class="form-panel" role="dialog" aria-modal="true" aria-labelledby="anchor-release-title"><div class="toolbar"><h2 id="anchor-release-title">Release this anchor</h2><button type="button" class="button secondary" data-close-admin-dialog>Close</button></div>
    <p>Release ${escapeHtml(milestone.milestoneTitle || milestone.milestoneId)} as the anchor? Days before anchor stay as they are until you choose another anchor.</p>
    <div class="toolbar"><button type="button" class="button" id="anchor-release-confirm">Release anchor</button><button type="button" class="button secondary" data-close-admin-dialog>Cancel</button></div></div>`);
  const confirm = document.getElementById('anchor-release-confirm');
  if (!confirm) return;
  confirm.addEventListener('click', function() {
    closeAdminDialog();
    pathwayApplyAnchorChoice(id, 'release');
  });
}

export function pathwayApplyAnchorChoice(id, mode) {
  const milestone = pathwayFindMilestone(id);
  if (!milestone || milestone.deleting) return;
  if (mode !== 'adjust' && mode !== 'move' && mode !== 'release') return;
  pathwayMarkSaving('milestone', id, 'pending');
  Object.keys(state.pathwayPlan.timers).forEach(function(key) {
    if (key.indexOf('milestone:') !== 0) return;
    window.clearTimeout(state.pathwayPlan.timers[key]);
    delete state.pathwayPlan.timers[key];
  });
  return pathwayEnqueue('pathway:anchor', function() {
    return pathwayFlushMilestones().then(function() {
      if (!pathwayFindMilestone(id) || !state.pathwayPlan.persistedMilestones[id]) {
        throw new Error('Save this milestone before changing the anchor.');
      }
      return callServer('setMilestoneAnchor', id, mode);
    }).then(function(result) {
      pathwayApplyAnchorResult(result, mode);
      pathwayMarkSaving('milestone', id, 'confirmed');
    }).catch(function(error) {
      if (isStale(error)) return;
      pathwayMarkSaving('milestone', id, 'rejected');
      showError(error);
    });
  });
}

export function pathwayFlushMilestones() {
  const ids = state.pathwayPlan.milestones.filter(function(milestone) {
    return milestone && !milestone.deleting && pathwayMilestoneDirty(milestone.milestoneId);
  }).map(function(milestone) { return milestone.milestoneId; });
  return ids.reduce(function(chain, milestoneId) {
    return chain.then(function() { return pathwayCommitMilestone(milestoneId); });
  }, Promise.resolve());
}

export function pathwayMilestoneDirty(id) {
  const milestone = pathwayFindMilestone(id);
  if (!milestone || milestone.deleting) return false;
  if (!state.pathwayPlan.persistedMilestones[id]) return true;
  const baseline = state.pathwayPlan.baselines.milestones[id];
  if (!baseline) return true;
  return !pathwaySamePayload(pathwayMilestonePayload(milestone), pathwayMilestonePayload(baseline));
}

export function pathwayApplyAnchorResult(result, mode) {
  const records = result && result.milestones ? result.milestones : [];
  const byId = {};
  records.forEach(function(record) { byId[String(record.milestoneId || '')] = record; });
  state.pathwayPlan.milestones.forEach(function(milestone) {
    const saved = byId[milestone.milestoneId];
    if (!saved) return;
    milestone.offsetDays = pathwayOffset(saved.offsetDays);
    if (saved.isAnchor === undefined || saved.isAnchor === null || saved.isAnchor === '') milestone.isAnchor = null;
    else milestone.isAnchor = toBoolean(saved.isAnchor);
    const baseline = state.pathwayPlan.baselines.milestones[milestone.milestoneId];
    if (baseline) {
      baseline.offsetDays = milestone.offsetDays;
      baseline.isAnchor = milestone.isAnchor;
    }
  });
  if (mode === 'adjust' && result && result.deltaDays) {
    const anchor = parsePlanDate(state.pathwayPlan.anchorDate);
    if (anchor) {
      state.pathwayPlan.anchorDate = formatPlanDate(addPlanDays(anchor, -Number(result.deltaDays)));
      writePlanSetting('ee-hub-plan-anchor', state.pathwayPlan.anchorDate);
    }
  }
  const anchorMilestone = pathwayAnchorMilestone();
  state.pathwayPlan.selectedMilestoneId = anchorMilestone ? anchorMilestone.milestoneId : state.pathwayPlan.selectedMilestoneId;
  state.pathwayPlan.pendingScroll = mode === 'release' ? 'preserve' : 'anchor';
  paintPathway();
}

export function sizePathwayMonths() {
  const scroller = document.getElementById('plan-scroll');
  if (!scroller || !state.pathwayPlan) return;
  const months = scroller.querySelectorAll('.plan-month');
  if (!months.length) return;
  const width = Math.max(1, Math.floor(scroller.clientWidth / state.pathwayPlan.monthsVisible));
  months.forEach(function(month) { month.style.width = width + 'px'; });
}

export function pathwayApplyScroll() {
  const scroller = document.getElementById('plan-scroll');
  if (!scroller) return;
  const mode = state.pathwayPlan.pendingScroll || 'preserve';
  if (mode === 'start') scroller.scrollLeft = 0;
  else if (mode === 'end') scroller.scrollLeft = scroller.scrollWidth;
  else if (mode === 'anchor') pathwayScrollAnchorIntoView(scroller);
  else scroller.scrollLeft = state.pathwayPlan.scrollLeft || 0;
  state.pathwayPlan.pendingScroll = 'preserve';
  state.pathwayPlan.scrollLeft = scroller.scrollLeft;
}

export function pathwayScrollAnchorIntoView(scroller) {
  const anchor = parsePlanDate(pathwayAnchorIso());
  if (!anchor) return;
  const month = scroller.querySelector('[data-month="' + planMonthKey(anchor) + '"]');
  if (!month) return;
  const scrollerBox = scroller.getBoundingClientRect();
  const monthBox = month.getBoundingClientRect();
  const left = monthBox.left - scrollerBox.left + scroller.scrollLeft;
  const width = monthBox.width || 1;
  scroller.scrollLeft = Math.max(0, left - Math.max(0, state.pathwayPlan.monthsVisible - 1) * width);
  state.pathwayPlan.scrollLeft = scroller.scrollLeft;
}

export function pathwaySchedulePhaseSave(id, delay) {
  const key = 'phase:' + id;
  window.clearTimeout(state.pathwayPlan.timers[key]);
  state.pathwayPlan.timers[key] = window.setTimeout(function() {
    delete state.pathwayPlan.timers[key];
    pathwayCommitPhase(id);
  }, delay || 0);
}

export function pathwayScheduleMilestoneSave(id, delay) {
  const key = 'milestone:' + id;
  window.clearTimeout(state.pathwayPlan.timers[key]);
  state.pathwayPlan.timers[key] = window.setTimeout(function() {
    delete state.pathwayPlan.timers[key];
    pathwayCommitMilestone(id);
  }, delay || 0);
}

export function pathwayEnqueue(key, createWork) {
  const prior = state.mutationQueues[key] || Promise.resolve();
  const operation = prior.catch(function() {}).then(function() { return createWork(); });
  state.mutationQueues[key] = operation.catch(function() {});
  return operation;
}

export function pathwayMarkSaving(kind, id, status) {
  if (!state.pathwayPlan) return;
  const key = kind + ':' + id;
  if (status === 'pending') state.pathwayPlan.saving[key] = true;
  else delete state.pathwayPlan.saving[key];
  document.querySelectorAll('[data-sync-key="' + cssEscape(key) + '"]').forEach(function(element) {
    markSync(element, status);
  });
}

export function pathwayRemovePhase(id) {
  state.pathwayPlan.phases = state.pathwayPlan.phases.filter(function(phase) { return phase.phaseId !== id; });
}

export function pathwayRemoveMilestone(id) {
  state.pathwayPlan.milestones = state.pathwayPlan.milestones.filter(function(milestone) { return milestone.milestoneId !== id; });
  if (state.pathwayPlan.selectedMilestoneId === id) state.pathwayPlan.selectedMilestoneId = '';
}

export function pathwayReplacePhase(id, record) {
  const index = state.pathwayPlan.phases.findIndex(function(phase) { return phase.phaseId === id; });
  if (index >= 0) state.pathwayPlan.phases[index] = pathwayNormalizePhase(record);
}

export function pathwayReplaceMilestone(id, record) {
  const index = state.pathwayPlan.milestones.findIndex(function(milestone) { return milestone.milestoneId === id; });
  if (index >= 0) state.pathwayPlan.milestones[index] = pathwayNormalizeMilestone(record);
}

export function pathwayCommitPhase(id) {
  return pathwayEnqueue('pathway:phase:' + id, function() {
    const phase = pathwayFindPhase(id);
    if (!phase || phase.deleting) return null;
    const payload = pathwayPhasePayload(phase);
    if (!payload.phaseTitle || !isFinite(payload.sequence)) {
      const baseline = state.pathwayPlan.baselines.phases[id];
      if (!payload.phaseTitle && baseline) phase.phaseTitle = baseline.phaseTitle;
      if (!isFinite(payload.sequence) && baseline) phase.sequence = baseline.sequence;
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
      showError(new Error(!payload.phaseTitle ? 'Phase title is required.' : 'Phase order must be a number.'));
      return null;
    }
    const isNew = !state.pathwayPlan.persistedPhases[id];
    pathwayMarkSaving('phase', id, 'pending');
    return callServer('saveAdminRecord', 'phases', payload, isNew ? '' : id).then(function() {
      state.pathwayPlan.persistedPhases[id] = true;
      state.pathwayPlan.baselines.phases[id] = clonePathway(payload);
      pathwayMarkSaving('phase', id, 'confirmed');
      const current = pathwayFindPhase(id);
      if (current && !pathwaySamePayload(pathwayPhasePayload(current), payload)) {
        window.setTimeout(function() { pathwayCommitPhase(id); }, 0);
      }
    }).catch(function(error) {
      if (isStale(error)) return;
      const current = pathwayFindPhase(id);
      if (current && pathwaySamePayload(pathwayPhasePayload(current), payload)) {
        if (isNew) pathwayRemovePhase(id);
        else if (state.pathwayPlan.baselines.phases[id]) pathwayReplacePhase(id, state.pathwayPlan.baselines.phases[id]);
        state.pathwayPlan.pendingScroll = 'preserve';
        paintPathway();
      }
      pathwayMarkSaving('phase', id, 'rejected');
      showError(error);
    });
  });
}

export function pathwayCommitMilestone(id) {
  return pathwayEnqueue('pathway:milestone:' + id, function() {
    const milestone = pathwayFindMilestone(id);
    if (!milestone || milestone.deleting) return null;
    const payload = pathwayMilestonePayload(milestone);
    if (!payload.milestoneTitle) return null;
    const phase = pathwayFindPhase(payload.phase);
    if (!phase || !phase.active) {
      const baseline = state.pathwayPlan.baselines.milestones[id];
      if (baseline) pathwayReplaceMilestone(id, baseline);
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
      showError(new Error('Choose an active phase before saving this milestone.'));
      return null;
    }
    const isNew = !state.pathwayPlan.persistedMilestones[id];
    pathwayMarkSaving('milestone', id, 'pending');
    return callServer('saveAdminRecord', 'milestoneTemplates', payload, isNew ? '' : id).then(function() {
      state.pathwayPlan.persistedMilestones[id] = true;
      state.pathwayPlan.baselines.milestones[id] = clonePathway(payload);
      pathwayMarkSaving('milestone', id, 'confirmed');
      const current = pathwayFindMilestone(id);
      if (current && !pathwaySamePayload(pathwayMilestonePayload(current), payload)) {
        window.setTimeout(function() { pathwayCommitMilestone(id); }, 0);
      }
    }).catch(function(error) {
      if (isStale(error)) return;
      const current = pathwayFindMilestone(id);
      if (current && pathwaySamePayload(pathwayMilestonePayload(current), payload)) {
        if (isNew) pathwayRemoveMilestone(id);
        else if (state.pathwayPlan.baselines.milestones[id]) pathwayReplaceMilestone(id, state.pathwayPlan.baselines.milestones[id]);
        state.pathwayPlan.pendingScroll = 'preserve';
        paintPathway();
      }
      pathwayMarkSaving('milestone', id, 'rejected');
      showError(error);
    });
  });
}

export function pathwayDeletePhase(id) {
  const phase = pathwayFindPhase(id);
  if (!phase) return;
  const title = phase.phaseTitle || phase.phaseId;
  if (!window.confirm('Delete the ' + title + ' phase?')) return;
  phase.deleting = true;
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
  pathwayEnqueue('pathway:phase:' + id, function() {
    if (!state.pathwayPlan.persistedPhases[id]) {
      pathwayRemovePhase(id);
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
      return null;
    }
    pathwayMarkSaving('phase', id, 'pending');
    return callServer('deleteAdminRecord', 'phases', id).then(function() {
      pathwayMarkSaving('phase', id, 'confirmed');
      window.setTimeout(function() {
        pathwayRemovePhase(id);
        delete state.pathwayPlan.persistedPhases[id];
        delete state.pathwayPlan.baselines.phases[id];
        delete state.pathwayPlan.hiddenPhaseIds[id];
        state.pathwayPlan.pendingScroll = 'preserve';
        paintPathway();
      }, 650);
    }).catch(function(error) {
      if (isStale(error)) return;
      const current = pathwayFindPhase(id);
      if (current) current.deleting = false;
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
      pathwayMarkSaving('phase', id, 'rejected');
      showError(error);
    });
  });
}

export function pathwayDeleteMilestone(id) {
  const milestone = pathwayFindMilestone(id);
  if (!milestone) return;
  const title = milestone.milestoneTitle || milestone.milestoneId;
  if (!window.confirm('Delete ' + title + '?')) return;
  milestone.deleting = true;
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
  pathwayEnqueue('pathway:milestone:' + id, function() {
    if (!state.pathwayPlan.persistedMilestones[id]) {
      pathwayRemoveMilestone(id);
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
      return null;
    }
    pathwayMarkSaving('milestone', id, 'pending');
    return callServer('deleteAdminRecord', 'milestoneTemplates', id).then(function() {
      pathwayMarkSaving('milestone', id, 'confirmed');
      window.setTimeout(function() {
        pathwayRemoveMilestone(id);
        delete state.pathwayPlan.persistedMilestones[id];
        delete state.pathwayPlan.baselines.milestones[id];
        state.pathwayPlan.pendingScroll = 'preserve';
        paintPathway();
      }, 650);
    }).catch(function(error) {
      if (isStale(error)) return;
      const current = pathwayFindMilestone(id);
      if (current) current.deleting = false;
      state.pathwayPlan.pendingScroll = 'preserve';
      paintPathway();
      pathwayMarkSaving('milestone', id, 'rejected');
      showError(error);
    });
  });
}

export function pathwayOnDragStart(event) {
  const chip = event.target.closest('[data-chip-id]');
  if (!chip || !event.dataTransfer) return;
  state.pathwayPlan.dragId = chip.dataset.chipId;
  event.dataTransfer.setData('text/plain', chip.dataset.chipId);
  event.dataTransfer.effectAllowed = 'move';
  chip.classList.add('is-dragging');
}

export function pathwayOnDragOver(event) {
  const day = event.target.closest('.plan-day');
  if (!day || !state.pathwayPlan.dragId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.plan-day.is-drop').forEach(function(node) {
    if (node !== day) node.classList.remove('is-drop');
  });
  day.classList.add('is-drop');
}

export function pathwayOnDrop(event) {
  const day = event.target.closest('.plan-day');
  if (!day) return;
  event.preventDefault();
  const id = (event.dataTransfer && event.dataTransfer.getData('text/plain')) || state.pathwayPlan.dragId;
  state.pathwayPlan.dragId = '';
  state.pathwayPlan.didDrop = true;
  window.setTimeout(function() { if (state.pathwayPlan) state.pathwayPlan.didDrop = false; }, 300);
  day.classList.remove('is-drop');
  const milestone = pathwayFindMilestone(id);
  const due = parsePlanDate(day.dataset.planDate);
  const anchor = parsePlanDate(pathwayAnchorIso());
  if (!milestone || milestone.deleting || !due || !anchor) return;
  const next = planDaysBetween(due, anchor);
  if (pathwayOffset(milestone.offsetDays) === next) return;
  milestone.offsetDays = next;
  state.pathwayPlan.selectedMilestoneId = id;
  state.pathwayPlan.pendingScroll = 'preserve';
  paintPathway();
  pathwayCommitMilestone(id);
}

export function pathwayOnDragEnd() {
  if (!state.pathwayPlan) return;
  state.pathwayPlan.dragId = '';
  document.querySelectorAll('.is-dragging, .plan-day.is-drop').forEach(function(node) {
    node.classList.remove('is-dragging');
    node.classList.remove('is-drop');
  });
}
