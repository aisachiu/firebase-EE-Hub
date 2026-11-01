import { escapeHtml, safeUrl } from '../../shared/html.js';

export const id = 'supervisor';

export function render(home) {
  const email = (home && home.supervisorId) || '';
  const name = (home && home.supervisorName) || '';
  if (!email && !name) {
    return `<h2>Your supervisor</h2><div class="empty"><p>A supervisor has not been assigned yet.</p><p class="muted">When one is assigned, their name and email stay on this view.</p></div>`;
  }
  const shown = name || email;
  const mail = email ? `<p><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>` : '';
  const subject = home && home.subject ? `<p class="muted">Subject · ${escapeHtml(home.subject)}</p>` : '';
  return `<h2>Your supervisor</h2><p class="supervisor-name">${escapeHtml(shown)}</p>${mail}${subject}<p class="muted">Messages to your supervisor are in Chat.</p>`;
}

export function mount() {}

/** Appointment schedule when the home payload carries one. Otherwise say booking is not configured. */
export function renderBooking(home) {
  const links = (home && home.links) || {};
  const url = safeUrl(home && (home.bookingUrl || home.appointmentUrl || links.booking || links.appointments || ''));
  if (!url) {
    return `<section class="ee-booking"><h2>Book the teacher</h2><p class="muted">Booking is not configured for this supervisor yet.</p></section>`;
  }
  const frame = /calendar\.google\.com/i.test(url)
    ? `<iframe class="ee-booking-frame" title="Appointment schedule" src="${escapeHtml(url)}"></iframe>`
    : '';
  return `<section class="ee-booking"><h2>Book the teacher</h2><p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open the appointment schedule</a></p>${frame}</section>`;
}
