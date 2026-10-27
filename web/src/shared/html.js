export function formatCount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!isFinite(number)) return '—';
  return Math.round(number).toLocaleString('en-US');
}

export function formatWordDelta(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Math.round(Number(value));
  if (!isFinite(number)) return '—';
  if (number > 0) return '+' + number.toLocaleString('en-US');
  return number.toLocaleString('en-US');
}

export function formatLastEdit(value) {
  const date = new Date(value || '');
  if (isNaN(date.getTime())) return '—';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 14) return days + ' days ago';
  return shortDate(value) || '—';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parts = text.split('-');
  return Number(parts[2]) + ' ' + MONTHS[Number(parts[1]) - 1] + ' ' + parts[0];
}

export function formatActivityWhen(value) {
  const text = String(value || '');
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) return Number(dateOnly[3]) + ' ' + MONTHS[Number(dateOnly[2]) - 1] + ' ' + dateOnly[1];
  const stamp = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!stamp) return text || '—';
  return Number(stamp[3]) + ' ' + MONTHS[Number(stamp[2]) - 1] + ' ' + stamp[1] + ', ' + stamp[4] + ':' + stamp[5];
}

export function textCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

export function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function toBoolean(value) {
  return value === true || value === 1 || ['true', '1', 'yes'].indexOf(String(value || '').toLowerCase()) >= 0;
}

export function hexColour(value) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(value || '').trim());
  return match ? '#' + match[1].toLowerCase() : '';
}

export function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch (error) { return ''; }
}

export function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
