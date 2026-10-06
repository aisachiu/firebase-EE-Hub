import { HubError, clockParts, formatHubDate, startOfScriptDay, text } from './util';

export const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'checks'];
export const FORM_SYSTEM_COLUMNS = ['StudentId', 'FormVersion', 'Status', 'SubmittedAt', 'LastUpdated'];
export const LIKERT_SCALE = ['1 — Strongly disagree', '2 — Disagree', '3 — Neutral', '4 — Agree', '5 — Strongly agree'];
export const SUBJECT_PREFERENCE_MAX = 3;

export interface FormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  optionsFrom: string;
  maxSelections: number;
  maxLength: number;
}

export function lintFormSource(html: string, js: string): void {
  const htmlText = String(html || '');
  const jsText = String(js || '');
  if (htmlText.length > 40000) throw new HubError('HTML must be 40,000 characters or fewer.');
  if (jsText.length > 20000) throw new HubError('JavaScript must be 20,000 characters or fewer.');
  if (/<\s*script/i.test(htmlText) || /javascript\s*:/i.test(htmlText)) {
    throw new HubError('Put scripts in the JavaScript panel, not in the HTML.');
  }
  const banned = [/google\s*\.\s*script/i, /\beval\s*\(/, /\bFunction\s*\(/, /\bimport\s*\(/, /\bglobalThis\b/, /\bdocument\s*\./, /\bwindow\s*\./, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bparent\s*\./, /\btop\s*\./];
  banned.forEach((pattern) => {
    if (pattern.test(jsText)) throw new HubError('Custom code cannot access the page, the network, or google.script. Use EEForm only.');
  });
}

export function normalizeFormFields(fields: unknown): FormField[] {
  if (!Array.isArray(fields) || !fields.length) throw new HubError('Add at least one field.');
  const seen: Record<string, boolean> = {};
  return fields.map((field) => {
    const name = text(field?.name);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) {
      throw new HubError('Field names must start with a letter and use only letters, numbers, or underscores.');
    }
    if (FORM_SYSTEM_COLUMNS.includes(name)) throw new HubError(`${name} is reserved.`);
    if (seen[name]) throw new HubError(`Duplicate field ${name}.`);
    seen[name] = true;
    const type = text(field?.type);
    if (!FORM_FIELD_TYPES.includes(type)) throw new HubError(`Unsupported field type for ${name}.`);
    const optionsFrom = text(field?.optionsFrom);
    if (optionsFrom && optionsFrom !== 'subjects') throw new HubError('optionsFrom must be subjects.');
    const options = Array.isArray(field?.options) ? field.options.map(text).filter(Boolean).slice(0, 40) : [];
    if ((type === 'select' || type === 'checks') && !optionsFrom && !options.length) throw new HubError(`${name} needs options.`);
    let maxLength = Number(field?.maxLength);
    if (!maxLength || maxLength < 1) maxLength = type === 'textarea' ? 2000 : 240;
    let maxSelections = Math.floor(Number(field?.maxSelections));
    if (!maxSelections || maxSelections < 1) maxSelections = 0;
    return {
      name,
      label: text(field?.label) || name,
      type,
      required: field?.required === true || text(field?.required).toLowerCase() === 'true',
      options,
      optionsFrom,
      maxSelections: Math.min(40, maxSelections),
      maxLength: Math.min(5000, maxLength),
    };
  });
}

export function checkedSelections(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : text(raw).split(';');
  const unique: string[] = [];
  list.forEach((item) => {
    const value = text(item);
    if (value && !unique.includes(value)) unique.push(value);
  });
  return unique;
}

export function validateFormAnswers(fields: FormField[], values: Record<string, any>, submit: boolean, subjectNames: string[] = []): Record<string, string> {
  const answers: Record<string, string> = {};
  fields.forEach((field) => {
    const raw = values[field.name];
    if (field.type === 'checks') {
      const selected = checkedSelections(raw);
      const choices = field.optionsFrom === 'subjects' ? subjectNames : field.options;
      selected.forEach((item) => {
        if (!choices.includes(item)) throw new HubError(`${field.label} includes a choice that is not available.`);
      });
      if (field.maxSelections && selected.length > field.maxSelections) {
        throw new HubError(`Choose at most ${field.maxSelections} for ${field.label}.`);
      }
      if (submit && field.required && !selected.length) throw new HubError(`${field.label} is required.`);
      const joined = selected.join('; ');
      if (joined.length > field.maxLength) throw new HubError(`${field.label} is too long.`);
      answers[field.name] = joined;
      return;
    }
    const value = field.type === 'checkbox'
      ? (raw === true || ['true', 'yes', '1'].includes(text(raw).toLowerCase()) ? 'Yes' : 'No')
      : text(raw);
    if (submit && field.required && (field.type === 'checkbox' ? value !== 'Yes' : !value)) {
      throw new HubError(`${field.label} is required.`);
    }
    if (value && field.type !== 'checkbox' && value.length > field.maxLength) throw new HubError(`${field.label} is too long.`);
    if (field.type === 'number' && value && !isFinite(Number(value))) throw new HubError(`${field.label} must be a number.`);
    if (field.type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HubError(`${field.label} must be a date.`);
    if (field.type === 'select' && value) {
      const options = field.optionsFrom === 'subjects' ? subjectNames : field.options;
      if (!options.includes(value)) throw new HubError(`${field.label} is not an available choice.`);
    }
    answers[field.name] = value;
  });
  return answers;
}

export interface DueFacts {
  missing?: boolean;
  invalid?: boolean;
  timed?: boolean;
  date?: Date;
  year?: number;
  month?: number;
  day?: number;
}

export function dueDateFacts(dueValue: unknown, timeZone: string): DueFacts {
  if (dueValue === '' || dueValue === null || dueValue === undefined) return { missing: true };
  const date = dueValue instanceof Date ? dueValue : new Date(text(dueValue));
  if (isNaN(date.getTime())) return { invalid: true };
  const parts = clockParts(date, timeZone);
  const utcMidnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  const localMidnight = parts.hour === 0 && parts.minute === 0 && parts.second === 0;
  if (!utcMidnight && !localMidnight) return { date, timed: true };
  const year = localMidnight && !utcMidnight ? parts.year : date.getUTCFullYear();
  const month = localMidnight && !utcMidnight ? parts.month : date.getUTCMonth() + 1;
  const day = localMidnight && !utcMidnight ? parts.day : date.getUTCDate();
  return { date, timed: false, year, month, day };
}

export function formWritesClosed(dueValue: unknown, now: Date, timeZone: string): boolean {
  const facts = dueDateFacts(dueValue, timeZone);
  if (facts.missing) return false;
  if (facts.invalid || !facts.date) return true;
  if (isNaN(now.getTime())) return true;
  if (facts.timed) return now.getTime() > facts.date.getTime();
  const deadline = startOfScriptDay(facts.year || 0, facts.month || 1, (facts.day || 1) + 1, timeZone);
  return now.getTime() >= deadline.getTime();
}

export function formClosedMessage(dueValue: unknown, timeZone: string): string {
  const facts = dueDateFacts(dueValue, timeZone);
  if (facts.missing || facts.invalid || !facts.date) {
    return 'This form is closed because its due date could not be read. Answers can no longer be changed.';
  }
  const when = facts.timed
    ? formatHubDate(facts.date, timeZone, true)
    : formatHubDate(startOfScriptDay(facts.year || 0, facts.month || 1, facts.day || 1, timeZone), timeZone, false);
  return `This form's due date has passed (${when}). Answers can no longer be changed.`;
}

export function assertSafeResourceHtml(html: string): void {
  const source = String(html || '');
  if (/<\s*script/i.test(source) || /javascript\s*:/i.test(source) || /\son[a-z]+\s*=/i.test(source)) {
    throw new HubError('Resource HTML cannot include scripts or event handlers.');
  }
}

function likertMarkup(name: string, legend: string): string {
  const choices = LIKERT_SCALE.map((option) => {
    const parts = option.split(' — ');
    return `<label><input type="radio" name="${name}" value="${option}"><span>${parts[0]}</span><small>${parts[1] || option}</small></label>`;
  }).join('');
  return `<fieldset class="likert"><legend>${legend}</legend><div class="scale" role="radiogroup">${choices}</div></fieldset>`;
}

export function starterSubjectForm() {
  const confidenceLabel = 'I feel confident about the EE at this point';
  const supportedLabel = 'I feel supported learning about the EE so far';
  return {
    milestoneId: 'm1',
    status: 'Draft',
    version: 0,
    fields: [
      { name: 'subjects', label: 'Which subjects are you considering for your EE?', type: 'checks', required: true, options: [], optionsFrom: 'subjects', maxSelections: SUBJECT_PREFERENCE_MAX, maxLength: 240 },
      { name: 'rationale', label: 'Explain your choices', type: 'textarea', required: true, options: [], optionsFrom: '', maxSelections: 0, maxLength: 2000 },
      { name: 'confidence', label: confidenceLabel, type: 'select', required: true, options: LIKERT_SCALE.slice(), optionsFrom: '', maxSelections: 0, maxLength: 80 },
      { name: 'supported', label: supportedLabel, type: 'select', required: true, options: LIKERT_SCALE.slice(), optionsFrom: '', maxSelections: 0, maxLength: 80 },
    ] as FormField[],
    html: [
      '<p class="form-intro">Choose the subjects you are most interested in for your Extended Essay. You can select up to three.</p>',
      '<fieldset class="subject-picks"><legend>Which subjects are you considering for your EE?</legend><p class="hint" id="subject-count">Select up to 3.</p><div class="check-grid" data-checks="subjects"></div></fieldset>',
      '<label class="field wide">Explain your choices<span class="hint">Why these subjects, and what kind of topic do you hope to explore?</span><textarea name="rationale" maxlength="2000"></textarea></label>',
      likertMarkup('confidence', confidenceLabel),
      likertMarkup('supported', supportedLabel),
    ].join(''),
    js: [
      'var root = EEForm.root;',
      'var subjectField = (EEForm.fields || []).filter(function(field) { return field.name === "subjects"; })[0];',
      'var maxSubjects = subjectField && Number(subjectField.maxSelections) > 0 ? Number(subjectField.maxSelections) : 3;',
      'var boxes = Array.prototype.filter.call(root.querySelectorAll("input"), function(input) { return input.name === "subjects" && input.type === "checkbox"; });',
      'var count = root.querySelector("#subject-count");',
      'function limitSubjects() {',
      '  var picked = boxes.filter(function(box) { return box.checked; }).length;',
      '  boxes.forEach(function(box) { box.disabled = !box.checked && picked >= maxSubjects; });',
      '  if (count) count.textContent = picked + " of " + maxSubjects + " selected";',
      '}',
      'boxes.forEach(function(box) { box.addEventListener("change", limitSubjects); });',
      'limitSubjects();',
    ].join('\n'),
    submitCompletes: true,
  };
}

export function starterFor(milestoneId: string) {
  if (milestoneId === 'm1') return starterSubjectForm();
  return {
    milestoneId,
    status: 'Draft',
    version: 0,
    fields: [{ name: 'response', label: 'Response', type: 'textarea', required: true, options: [], optionsFrom: '', maxSelections: 0, maxLength: 2000 }] as FormField[],
    html: '<label class="field wide">Response<textarea name="response"></textarea></label>',
    js: '',
    submitCompletes: true,
  };
}
