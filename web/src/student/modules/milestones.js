import { escapeHtml } from '../../shared/html.js';
import { bindFormButtons } from '../milestones.js';
import {
  formButton,
  milestoneDescriptionText,
  milestoneTitleText,
  nextIncomplete,
} from '../home.js';
import {
  applyJourneyHero,
  bindJourneyHero,
  journeyOverview,
  paintStudentJourney,
  renderJourneyHero,
} from '../journey.js';

export const id = 'milestones';

export function render(home, context) {
  if (context && context.slot === 'primary') {
    return `<div class="milestone-module">${renderJourneyHero(journeyOverview(home))}<div id="journey-module"></div></div>`;
  }
  return renderCompact(home);
}

export function mount(host, home, context) {
  if (context && context.slot === 'primary') {
    applyJourneyHero(host);
    bindJourneyHero(host);
    const body = host.querySelector('#journey-module');
    if (body) paintStudentJourney(home, body);
    return;
  }
  bindFormButtons(host);
}

function renderCompact(home) {
  const next = nextIncomplete(home);
  const templates = (home && home.templates) || [];
  const done = ((home && home.actionItems) || []).filter(function(item) {
    return item.CreatorType === 'System' && item.Status === 'Completed';
  }).length;
  const hero = next
    ? `<section class="hero"><div><p class="eyebrow">${home.staffView ? 'Next step' : 'Your next step'}</p><h2>${escapeHtml(milestoneTitleText(next.template, next.item))}</h2><p>${escapeHtml(milestoneDescriptionText(next.template, next.item) || 'Complete this milestone before the due date.')}</p></div><div>${next.item && next.item.DueDate ? `<div class="chip">${escapeHtml(String(next.item.DueDate).slice(0, 10))}</div>` : ''}${formButton(home, next)}</div></section>`
    : '<section class="hero"><div><p class="eyebrow">All caught up</p><h2>No action needed right now</h2><p>Open Journey to see what is coming.</p></div></section>';
  return `<h2>Milestones</h2>${hero}<div class="tiles"><div class="tile"><div class="muted">Done</div><div class="val">${done} <small>/ ${templates.length}</small></div></div></div>`;
}
