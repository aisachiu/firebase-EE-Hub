import { escapeHtml } from './html.js';
import { isStale } from './scene.js';

export function showError(error, relatedElement) {
  if (isStale(error)) return;
  const message = error && error.message ? error.message : String(error);
  const feedback = document.getElementById('feedback-region');
  if (feedback) {
    feedback.innerHTML = `<p class="notice error">${escapeHtml(message)}</p>`;
    window.setTimeout(function() { if (feedback) feedback.innerHTML = ''; }, 5000);
  }
  if (relatedElement) relatedElement.setAttribute('aria-label', message);
}

export function showSuccess(message) {
  const feedback = document.getElementById('feedback-region');
  if (!feedback) return;
  feedback.innerHTML = `<p class="notice">${escapeHtml(message)}</p>`;
  window.setTimeout(function() { if (feedback) feedback.innerHTML = ''; }, 3500);
}

export function showFatal(title, message) {
  document.getElementById('app').innerHTML = `<div class="shell"><p class="eyebrow">VSA EE Hub</p><h1>${escapeHtml(title)}</h1><p class="notice error">${escapeHtml(message)}</p></div>`;
}
