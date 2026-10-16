// Heatmap and word-count maths for the student essay card. Edit squares count
// Drive revisions per day. Google Drive does not report how often a file was opened.

import { clockParts } from './util';

export const DOC_HEATMAP_WEEKS = 26;
export const DOC_WORD_SAMPLE_LIMIT = 120;
export const DAY_MS = 86400000;

export interface WordSample {
  d: string;
  w: number;
  t?: number;
}

export interface HeatDay {
  date: string;
  count: number;
  level: number;
  future: boolean;
}

export interface HeatMonth {
  column: number;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value: number): string {
  const text = String(value);
  return text.length < 2 ? '0' + text : text;
}

export function countWords(value: string): number {
  const cleaned = String(value || '').replace(/^\uFEFF/, '').replace(/\u00a0/g, ' ').trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

export function dayKeyInZone(date: Date, timeZone: string): string {
  try {
    const parts = clockParts(date, timeZone || 'UTC');
    if (!parts.year || !parts.month || !parts.day) throw new Error('missing date parts');
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  } catch {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }
}

export function addDays(dayKey: string, days: number): string {
  const parts = String(dayKey || '').split('-');
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function mondayOnOrBefore(dayKey: string): string {
  const parts = String(dayKey || '').split('-');
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  const weekday = date.getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  return addDays(dayKey, -back);
}

export function countRevisionDays(stamps: string[], timeZone: string): Record<string, number> {
  const counts: Record<string, number> = {};
  (stamps || []).forEach((stamp) => {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return;
    const key = dayKeyInZone(date, timeZone);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

export function normalizeWordSamples(value: unknown): WordSample[] {
  if (!Array.isArray(value)) return [];
  const samples: WordSample[] = [];
  value.forEach((sample) => {
    if (!sample || typeof sample !== 'object') return;
    const row = sample as { d?: unknown; w?: unknown; t?: unknown };
    const day = String(row.d || '');
    const words = Number(row.w);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(words)) return;
    const next: WordSample = { d: day, w: words };
    const at = Number(row.t);
    if (Number.isFinite(at)) next.t = at;
    samples.push(next);
  });
  return samples;
}

function sampleTime(sample: WordSample): number {
  const at = Number(sample && sample.t);
  if (Number.isFinite(at)) return at;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sample && sample.d || ''))) return Number.NaN;
  return Date.parse(`${sample.d}T12:00:00Z`);
}

export function rememberWordSample(samples: WordSample[], wordCount: number, now: Date, dayKey: string): WordSample[] {
  const when = now instanceof Date ? now : new Date(now);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || '')) ? String(dayKey) : dayKeyInZone(when, 'UTC');
  const next: WordSample[] = [];
  let seen = false;
  (samples || []).forEach((sample) => {
    if (!sample || !sample.d) return;
    if (sample.d === day) {
      seen = true;
      next.push(sample);
      return;
    }
    const kept: WordSample = { d: sample.d, w: Number(sample.w) };
    if (sample.t !== undefined) kept.t = sample.t;
    next.push(kept);
  });
  if (!seen) next.push({ d: day, w: Math.round(Number(wordCount) || 0), t: when.getTime() });
  next.sort((left, right) => (left.d < right.d ? -1 : left.d > right.d ? 1 : 0));
  if (next.length > DOC_WORD_SAMPLE_LIMIT) return next.slice(next.length - DOC_WORD_SAMPLE_LIMIT);
  return next;
}

export function wordSamplesChanged(before: WordSample[], after: WordSample[]): boolean {
  return JSON.stringify(before || []) !== JSON.stringify(after || []);
}

export function wordsTypedSince(samples: WordSample[], wordCount: number, nowMs: number, targetMs: number, toleranceMs: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  (samples || []).forEach((sample) => {
    const at = sampleTime(sample);
    const words = Number(sample && sample.w);
    if (!Number.isFinite(at) || !Number.isFinite(words) || at > nowMs) return;
    const distance = Math.abs(at - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = words;
    }
  });
  if (best === null || bestDistance > toleranceMs) return null;
  return Math.round(Number(wordCount) - best);
}

export function editStreak(dayKeys: string[], todayKey: string): number {
  const present: Record<string, boolean> = {};
  (dayKeys || []).forEach((key) => { if (key) present[key] = true; });
  let cursor = todayKey;
  if (!present[cursor]) {
    cursor = addDays(todayKey, -1);
    if (!present[cursor]) return 0;
  }
  let streak = 0;
  while (present[cursor] && streak < 400) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function editHeatLevel(count: number): number {
  const value = Number(count) || 0;
  if (value <= 0) return 0;
  if (value === 1) return 1;
  if (value <= 3) return 2;
  if (value <= 6) return 3;
  return 4;
}

export function monthLabel(dayKey: string): string {
  const month = Number(String(dayKey || '').split('-')[1]);
  return MONTHS[month - 1] || '';
}

export function buildEditHeatmap(dayCounts: Record<string, number>, todayKey: string, weeks?: number): { days: HeatDay[]; months: HeatMonth[] } {
  const totalWeeks = Math.max(1, Number(weeks) || DOC_HEATMAP_WEEKS);
  const start = addDays(mondayOnOrBefore(todayKey), -7 * (totalWeeks - 1));
  const days: HeatDay[] = [];
  const months: HeatMonth[] = [];
  let lastMonth = '';
  const counts = dayCounts || {};
  for (let week = 0; week < totalWeeks; week += 1) {
    const monday = addDays(start, week * 7);
    let monthOnFirst = '';
    for (let offset = 0; offset < 7; offset += 1) {
      const key = addDays(monday, offset);
      if (key.slice(8) === '01') monthOnFirst = monthLabel(key);
    }
    const label = week === 0 ? (monthOnFirst || monthLabel(monday)) : monthOnFirst;
    if (label && label !== lastMonth) {
      months.push({ column: week, label });
      lastMonth = label;
    }
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(monday, day);
      const future = date > todayKey;
      const count = future ? 0 : (counts[date] || 0);
      days.push({ date, count, level: future ? 0 : editHeatLevel(count), future });
    }
  }
  return { days, months };
}
