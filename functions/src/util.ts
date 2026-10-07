export type Doc = Record<string, any>;

export class HubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubError';
  }
}

export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Drive prefixes and suffixes keep leading and trailing spaces. Folder names are built from them. */
export function driveNamePart(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function normalizeEmail(value: unknown): string {
  return text(value).toLowerCase();
}

export function toBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'y'].includes(text(value).toLowerCase());
}

export function serializable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function validateEmail(value: unknown, label: string): string {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HubError(`${label} must be a valid email address.`);
  }
  return email;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function shortId(prefix: string): string {
  return prefix + uuid().replace(/-/g, '').substring(0, 12).toUpperCase();
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function parseActionDate(value: unknown): Date | null {
  let date: Date | null = null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    if (match) date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    else if (text(value)) {
      const parsed = new Date(text(value));
      if (!isNaN(parsed.getTime())) {
        date = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
      }
    }
  }
  if (!date || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return null;
  return date;
}

export function serializeDateOnly(value: Date): string {
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  result.setUTCDate(result.getUTCDate() + Number(days || 0));
  return result;
}

export function dateOnlyValue(value: unknown): string {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text(value));
  if (match) return match[1];
  const parsed = parseActionDate(value);
  return parsed ? serializeDateOnly(parsed) : '';
}

export function cleanDoc(data: Doc): Doc {
  const out: Doc = {};
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (value === undefined) return;
    out[key] = value instanceof Date ? value.toISOString() : value;
  });
  return out;
}

export function quoteDayStamp(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function textHash(value: unknown): string {
  const source = String(value || '');
  let hash = 0;
  for (let index = 0; index < source.length; index++) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return String(hash);
}

export function clockParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const bag: Record<string, string> = {};
  fmt.formatToParts(date).forEach((part) => {
    bag[part.type] = part.value;
  });
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

export function startOfScriptDay(year: number, month: number, day: number, timeZone: string): Date {
  let corrected = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  for (let pass = 0; pass < 3; pass++) {
    const shown = clockParts(corrected, timeZone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const target = Date.UTC(year, month - 1, day, 0, 0, 0);
    if (shownUtc === target) return corrected;
    corrected = new Date(corrected.getTime() + (target - shownUtc));
  }
  return corrected;
}

export function formatHubDate(date: Date, timeZone: string, withTime: boolean): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: withTime ? '2-digit' : undefined,
    minute: withTime ? '2-digit' : undefined,
    hourCycle: 'h23',
  }).format(date);
}
