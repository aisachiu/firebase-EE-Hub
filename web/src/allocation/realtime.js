import { buildDesk, settingsFromDoc, tokenFromDoc, workspaceFromDoc } from '../../../functions/src/allocationPure.ts';
import { callServer } from '../shared/api.js';
import { showError } from '../shared/feedback.js';
import { isStale, sameScene } from '../shared/scene.js';
import { state } from '../shared/state.js';

let unsubscribe = null;
let watchedCohort = '';
let painter = function() {};

export function setAllocationPainter(paint) {
  painter = typeof paint === 'function' ? paint : function() {};
}

export function releaseAllocationWatch() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  watchedCohort = '';
  state.allocationWatchCohort = '';
  state.allocationListenFallback = false;
  state.allocationPendingEdits = {};
  state.allocationRevision = 0;
  state.allocationPaintDeferred = false;
  if (state.allocationSyncClock) {
    clearInterval(state.allocationSyncClock);
    state.allocationSyncClock = 0;
  }
}

function emailOf(value) {
  return String(value || '').trim().toLowerCase();
}

export function deskFromAllocationSources(cohortId, sources) {
  const incoming = sources || {};
  const workspaces = (incoming.workspace || []).map(function(doc) {
    return workspaceFromDoc(doc, doc.id || doc.studentId || '');
  });
  const tokens = (incoming.tokens || []).map(function(doc) {
    return tokenFromDoc(Object.assign({ cohortId: cohortId }, doc, { id: doc.id }));
  }).filter(Boolean);
  const staff = (incoming.staff || []).map(function(doc) {
    const email = emailOf(doc.EMAIL || doc.id);
    return { email: email, displayName: String(doc.DisplayName || doc.EMAIL || email).trim() };
  }).filter(function(person) { return person.email; });
  const choiceSources = new Map();
  (incoming.workspace || []).forEach(function(doc) {
    const id = emailOf(doc.studentId || doc.id);
    if (id) choiceSources.set(id, doc.subjectChoices);
  });
  return buildDesk({
    cohortId: cohortId,
    members: incoming.members || [],
    workspaces: workspaces,
    tokens: tokens,
    staff: staff,
    settings: settingsFromDoc(incoming.settings || null),
    subjects: incoming.subjects || [],
    choiceSources: choiceSources,
  });
}

export function pendingSettled(student, edit) {
  if (!edit) return true;
  const staffId = emailOf(edit.staffId);
  if (!staffId) return !student || !student.token;
  if (!student || !student.token || student.token.status !== 'draft') return false;
  if (emailOf(student.token.staffId) !== staffId) return false;
  if ((student.token.interdisciplinary === true) !== (edit.interdisciplinary === true)) return false;
  return String(student.token.assignedSubject || '').toLowerCase() === String(edit.subject || '').toLowerCase();
}

export function tokenUpdatedStamps(sources) {
  const stamps = {};
  ((sources && sources.tokens) || []).forEach(function(doc) {
    const holder = emailOf(doc.allocatedTo);
    const status = String(doc.status || '').toLowerCase();
    if (!holder || status === 'available') return;
    const at = String(doc.updatedAt || '');
    if (!at) return;
    if (!stamps[holder] || at > stamps[holder]) stamps[holder] = at;
  });
  return stamps;
}

export function stampCaughtUp(stamp, startedAt) {
  const at = Date.parse(stamp || '');
  const start = Date.parse(startedAt || '');
  if (!Number.isFinite(at) || !Number.isFinite(start)) return false;
  return at + 15000 >= start;
}

export function reconcilePendingEdits(pending, remoteDesk, stamps) {
  const next = {};
  const students = new Map(((remoteDesk && remoteDesk.students) || []).map(function(student) {
    return [student.studentId, student];
  }));
  Object.keys(pending || {}).forEach(function(studentId) {
    const edit = pending[studentId];
    if (pendingSettled(students.get(studentId) || null, edit)) return;
    if (edit.acked && stampCaughtUp(stamps && stamps[studentId], edit.startedAt)) return;
    next[studentId] = edit;
  });
  return next;
}

export function overlayPendingEdits(desk, pending) {
  const edits = pending || {};
  const ids = Object.keys(edits);
  if (!desk || !ids.length) return desk;
  const supervisors = desk.supervisors || [];
  const students = (desk.students || []).map(function(student) {
    const edit = edits[student.studentId];
    if (!edit) return student;
    if (!emailOf(edit.staffId)) {
      return Object.assign({}, student, {
        token: null,
        pendingClear: !!(student.flags && student.flags.committed) || student.pendingClear,
        flags: Object.assign({}, student.flags, { drafted: false, committed: false, subjectMatch: 'none' }),
      });
    }
    const person = supervisors.find(function(item) { return emailOf(item.staffId) === emailOf(edit.staffId); });
    const prior = student.token;
    return Object.assign({}, student, {
      pendingClear: false,
      token: {
        id: prior && emailOf(prior.staffId) === emailOf(edit.staffId) ? prior.id : (edit.tokenId || 'pending'),
        staffId: emailOf(edit.staffId),
        staffName: person ? person.displayName : (edit.staffId || ''),
        eligibleSubjects: person && person.eligibleSubjects ? person.eligibleSubjects.slice() : (prior && prior.eligibleSubjects ? prior.eligibleSubjects.slice() : []),
        assignedSubject: edit.subject || '',
        interdisciplinary: edit.interdisciplinary === true,
        status: 'draft',
      },
      flags: Object.assign({}, student.flags, { drafted: true, committed: false }),
    });
  });
  return Object.assign({}, desk, { students: students });
}

function withDrive(desk) {
  const drive = state.allocationDrive;
  if (!drive) return desk;
  return Object.assign({}, desk, {
    driveReady: drive.ready,
    driveActor: drive.actor || '',
    driveError: drive.error || '',
  });
}

export function receiveAllocationSources(cohortId, sources) {
  if (watchedCohort !== cohortId) return;
  const remote = withDrive(deskFromAllocationSources(cohortId, sources));
  const previous = state.allocationRemoteDesk;
  const settingsChanged = !previous || settingsStamp(previous.settings) !== settingsStamp(remote.settings);
  state.allocationRemoteDesk = remote;
  state.allocationRevision = (state.allocationRevision || 0) + 1;
  state.allocationPendingEdits = reconcilePendingEdits(state.allocationPendingEdits, remote, tokenUpdatedStamps(sources));
  state.allocationDesk = overlayPendingEdits(remote, state.allocationPendingEdits);
  const view = state.allocationView || 'dashboard';
  if (state.section === 'allocation' && (view === 'dashboard' || (view === 'settings' && settingsChanged))) painter();
}

function settingsStamp(settings) {
  if (!settings) return '';
  return [
    settings.lastSyncedAt || '',
    settings.lastLiveSync || '',
    settings.lastWorkspaceSync || '',
    settings.primaryChoiceKey || '',
    settings.secondaryChoiceKey || '',
    settings.interdisciplinaryKey || '',
    settings.hlColumn || '',
    settings.supportColumn || '',
    JSON.stringify(settings.columns || []),
    JSON.stringify(settings.columnMappings || {}),
  ].join('|');
}

function loadStaticDesk(cohortId) {
  const scene = state.scene;
  return callServer('getAllocationDesk', cohortId).then(function(desk) {
    if (!sameScene(scene) || state.cohortId !== cohortId || watchedCohort !== cohortId) return;
    state.allocationRemoteDesk = desk;
    state.allocationDrive = {
      ready: desk.driveReady !== false,
      actor: desk.driveActor || '',
      error: desk.driveError || '',
    };
    state.allocationRevision = (state.allocationRevision || 0) + 1;
    state.allocationPendingEdits = reconcilePendingEdits(state.allocationPendingEdits, desk, {});
    state.allocationDesk = overlayPendingEdits(desk, state.allocationPendingEdits);
    painter();
  }).catch(function(error) {
    if (isStale(error)) return;
    showError(error);
  });
}

function refreshAllocationDrive(cohortId) {
  const scene = state.scene;
  callServer('getAllocationDesk', cohortId).then(function(desk) {
    if (!sameScene(scene) || state.cohortId !== cohortId || watchedCohort !== cohortId) return;
    state.allocationDrive = {
      ready: desk.driveReady !== false,
      actor: desk.driveActor || '',
      error: desk.driveError || '',
    };
    if (!state.allocationDesk) return;
    const patch = {
      driveReady: state.allocationDrive.ready,
      driveActor: state.allocationDrive.actor,
      driveError: state.allocationDrive.error,
    };
    state.allocationDesk = Object.assign({}, state.allocationDesk, patch);
    if (state.allocationRemoteDesk) state.allocationRemoteDesk = Object.assign({}, state.allocationRemoteDesk, patch);
    if (state.section === 'allocation' && (state.allocationView || 'dashboard') === 'dashboard') painter();
  }).catch(function(error) {
    if (isStale(error)) return;
  });
}

export function beginAllocationWatch(cohortId) {
  if (!cohortId) return;
  if (watchedCohort === cohortId && unsubscribe) return;
  if (watchedCohort === cohortId && state.allocationListenFallback) {
    loadStaticDesk(cohortId);
    return;
  }
  const switching = !!(watchedCohort && watchedCohort !== cohortId);
  releaseAllocationWatch();
  if (switching) {
    state.allocationDesk = null;
    state.allocationRemoteDesk = null;
  }
  watchedCohort = cohortId;
  state.allocationWatchCohort = cohortId;
  const listen = typeof window !== 'undefined' ? window.eeWatchAllocation : null;
  if (typeof listen !== 'function') {
    state.allocationListenFallback = true;
    loadStaticDesk(cohortId);
    return;
  }
  refreshAllocationDrive(cohortId);
  try {
    unsubscribe = listen(cohortId, {
      onData: function(sources) { receiveAllocationSources(cohortId, sources); },
      onError: function(error) {
        if (watchedCohort !== cohortId) return;
        const stop = unsubscribe;
        unsubscribe = null;
        if (stop) stop();
        state.allocationListenFallback = true;
        showError(error);
        loadStaticDesk(cohortId);
      },
    });
  } catch (error) {
    unsubscribe = null;
    state.allocationListenFallback = true;
    showError(error);
    loadStaticDesk(cohortId);
  }
}

if (typeof window !== 'undefined') window.eeReleaseAllocationWatch = releaseAllocationWatch;
