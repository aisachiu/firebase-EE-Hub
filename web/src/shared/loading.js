import { escapeHtml } from './html.js';
import { state } from './state.js';

export function quoteMarkup() {
  const bank = state.quotes && state.quotes.length ? state.quotes : (state.quote ? [state.quote] : []);
  if (!bank.length) return '';
  const quote = bank[Math.floor(Math.random() * bank.length)];
  return `<blockquote class="load-quote"><span class="load-quote-text">${escapeHtml(quote)}</span></blockquote>`;
}

export function loadingLine(message) {
  return `<div class="load-stage"><p class="load-status">${escapeHtml(message)}</p>${quoteMarkup()}</div>`;
}

export function rememberQuotes(result) {
  if (!result) return;
  if (result.quotes && result.quotes.length) state.quotes = result.quotes.slice();
  if (result.quote) state.quote = result.quote;
  const node = document.querySelector('#app [data-connect]');
  if (!node) return;
  node.innerHTML = '<p class="load-status">Connecting to VSA EE Hub...</p>' + quoteMarkup();
}
