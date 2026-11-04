export const MAINTENANCE_NOTE_LIMIT = 500;

export const DEFAULT_MAINTENANCE_MESSAGE = 'The EE Hub is temporarily unavailable while we carry out maintenance. Please check back soon.';

export function emptyServerSettings() {
  return {
    emailNotificationEnabled: true,
    commentsSweepEnabled: true,
    maintenanceMode: false,
    maintenanceNote: '',
    loaded: false,
  };
}

/** Same defaults as the Cloud Functions reader: jobs on, maintenance off, until a field is set. */
export function serverSettingsFromDoc(data) {
  const record = data && typeof data === 'object' ? data : {};
  return {
    emailNotificationEnabled: flagOrDefault(record, 'emailNotificationEnabled', true),
    commentsSweepEnabled: flagOrDefault(record, 'commentsSweepEnabled', true),
    maintenanceMode: flagOrDefault(record, 'maintenanceMode', false),
    maintenanceNote: noteText(record.maintenanceNote),
    loaded: true,
  };
}

export function maintenanceMessage(settings) {
  const note = settings && noteText(settings.maintenanceNote);
  return note || DEFAULT_MAINTENANCE_MESSAGE;
}

function noteText(value) {
  return String(value === null || value === undefined ? '' : value).trim().slice(0, MAINTENANCE_NOTE_LIMIT);
}

function flagOrDefault(record, key, fallback) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return fallback;
  const value = record[key];
  if (value === '' || value === null || value === undefined) return fallback;
  return truthy(value);
}

function truthy(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'y'].indexOf(String(value).trim().toLowerCase()) !== -1;
}
