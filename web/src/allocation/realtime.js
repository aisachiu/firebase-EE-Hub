import { buildDesk, choiceMatchFlag, diplomaLevelFlag, hodStatusFromDoc, settingsFromDoc, subjectsOverlap, tokenFromDoc, workspaceFromDoc } from '../../../functions/src/allocationPure.ts';
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
  state.allocationPendingFlags = {};
  state.allocationPendingSubjects = {};
  state.allocationPendingSuggestions = {};
  state.allocationHodStatus = null;
  state.allocationAuditLogs = [];
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
    return {
      email: email,
      displayName: String(doc.DisplayName || doc.EMAIL || email).trim(),
      department: String(doc['Primary Department'] || '').trim(),
      isHOD: doc.isHOD === true,
    };
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
  if ((student.selectedInterdisciplinary === true) !== (edit.interdisciplinary === true)) return false;
  if (String(student.interdisciplinarySubject || '').toLowerCase() !== String(edit.interdisciplinarySubject || '').toLowerCase()) return false;
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

export function overlayPendingFlags(desk, pending) {
  const flags = pending || {};
  const ids = Object.keys(flags);
  if (!desk || !ids.length) return desk;
  const students = (desk.students || []).map(function(student) {
    const edit = flags[student.studentId];
    if (!edit) return student;
    return Object.assign({}, student, {
      isFlagged: edit.isFlagged === true,
      flagNote: edit.flagNote || '',
    });
  });
  return Object.assign({}, desk, { students: students });
}

export function reconcilePendingFlags(pending, remoteDesk) {
  const next = {};
  const students = new Map(((remoteDesk && remoteDesk.students) || []).map(function(student) {
    return [student.studentId, student];
  }));
  Object.keys(pending || {}).forEach(function(studentId) {
    const edit = pending[studentId];
    const student = students.get(studentId);
    if (!student) {
      next[studentId] = edit;
      return;
    }
    const sameFlag = (student.isFlagged === true) === (edit.isFlagged === true);
    const sameNote = String(student.flagNote || '') === String(edit.flagNote || '');
    if (sameFlag && sameNote) return;
    next[studentId] = edit;
  });
  return next;
}

export function overlayPendingSubjects(desk, pending) {
  const edits = pending || {};
  const ids = Object.keys(edits);
  if (!desk || !ids.length) return desk;
  const students = (desk.students || []).map(function(student) {
    const edit = edits[student.studentId];
    if (!edit) return student;
    const next = Object.assign({}, student, { selectedSubject: edit.selectedSubject || '' });
    if (edit.clearSuggestion) {
      next.suggestedStaffId = '';
      next.suggestedSubject = '';
      next.suggestedStaffName = '';
    }
    return next;
  });
  return Object.assign({}, desk, { students: students });
}

export function overlayPendingSuggestions(desk, pending) {
  const edits = pending || {};
  const ids = Object.keys(edits);
  if (!desk || !ids.length) return desk;
  const names = new Map(((desk.directory) || []).map(function(person) {
    return [emailOf(person.email), person.displayName || person.email];
  }));
  const students = (desk.students || []).map(function(student) {
    const edit = edits[student.studentId];
    if (!edit) return student;
    const staffId = emailOf(edit.suggestedStaffId);
    return Object.assign({}, student, {
      suggestedStaffId: staffId,
      suggestedSubject: edit.suggestedSubject || '',
      suggestedStaffName: staffId ? (names.get(staffId) || edit.suggestedStaffName || staffId) : '',
    });
  });
  return Object.assign({}, desk, { students: students });
}

export function reconcilePendingSubjects(pending, remoteDesk) {
  const next = {};
  const students = new Map(((remoteDesk && remoteDesk.students) || []).map(function(student) {
    return [student.studentId, student];
  }));
  Object.keys(pending || {}).forEach(function(studentId) {
    const edit = pending[studentId];
    const student = students.get(studentId);
    if (!student) {
      next[studentId] = edit;
      return;
    }
    if (String(student.selectedSubject || '').toLowerCase() !== String(edit.selectedSubject || '').toLowerCase()) {
      next[studentId] = edit;
    }
  });
  return next;
}

export function reconcilePendingSuggestions(pending, remoteDesk) {
  const next = {};
  const students = new Map(((remoteDesk && remoteDesk.students) || []).map(function(student) {
    return [student.studentId, student];
  }));
  Object.keys(pending || {}).forEach(function(studentId) {
    const edit = pending[studentId];
    const student = students.get(studentId);
    if (!student) {
      next[studentId] = edit;
      return;
    }
    const sameStaff = emailOf(student.suggestedStaffId) === emailOf(edit.suggestedStaffId);
    const sameSubject = String(student.suggestedSubject || '').toLowerCase() === String(edit.suggestedSubject || '').toLowerCase();
    if (!sameStaff || !sameSubject) next[studentId] = edit;
  });
  return next;
}

export function presentAllocationDesk(remote) {
  const edited = overlayPendingEdits(remote, state.allocationPendingEdits);
  const flagged = overlayPendingFlags(edited, state.allocationPendingFlags);
  const selected = overlayPendingSubjects(flagged, state.allocationPendingSubjects);
  return overlayPendingSuggestions(selected, state.allocationPendingSuggestions);
}

function supervisorsAfterMoves(supervisors, beforeStudents, afterStudents) {
  const before = new Map((beforeStudents || []).map(function(student) { return [student.studentId, student]; }));
  const delta = {};
  (afterStudents || []).forEach(function(student) {
    const prior = before.get(student.studentId);
    const from = prior && prior.token ? emailOf(prior.token.staffId) : '';
    const to = student.token ? emailOf(student.token.staffId) : '';
    if (from === to) return;
    if (from) delta[from] = (delta[from] || 0) + 1;
    if (to) delta[to] = (delta[to] || 0) - 1;
  });
  return (supervisors || []).map(function(person) {
    const change = delta[emailOf(person.staffId)] || 0;
    if (!change) return person;
    const total = Number(person.total) || 0;
    const available = Math.max(0, (Number(person.available) || 0) + change);
    return Object.assign({}, person, { available: available, used: Math.max(0, total - available) });
  });
}

export function overlayPendingEdits(desk, pending) {
  const edits = pending || {};
  const ids = Object.keys(edits);
  if (!desk || !ids.length) return desk;
  const supervisors = desk.supervisors || [];
  const remoteStudents = desk.students || [];
  const students = remoteStudents.map(function(student) {
    const edit = edits[student.studentId];
    if (!edit) return student;
    if (!emailOf(edit.staffId)) {
      return Object.assign({}, student, {
        token: null,
        selectedInterdisciplinary: edit.interdisciplinary === true,
        interdisciplinarySubject: edit.interdisciplinarySubject || '',
        pendingClear: !!(student.flags && student.flags.committed) || student.pendingClear,
        flags: Object.assign({}, student.flags, { drafted: false, committed: false, subjectMatch: 'none', hlMatch: 'none' }),
      });
    }
    const person = supervisors.find(function(item) { return emailOf(item.staffId) === emailOf(edit.staffId); });
    const prior = student.token;
    return Object.assign({}, student, {
      pendingClear: false,
      selectedInterdisciplinary: edit.interdisciplinary === true,
      interdisciplinarySubject: edit.interdisciplinarySubject || '',
      token: {
        id: prior && emailOf(prior.staffId) === emailOf(edit.staffId) ? prior.id : (edit.tokenId || 'pending'),
        staffId: emailOf(edit.staffId),
        staffName: person ? person.displayName : (edit.staffId || ''),
        eligibleSubjects: person && person.eligibleSubjects ? person.eligibleSubjects.slice() : (prior && prior.eligibleSubjects ? prior.eligibleSubjects.slice() : []),
        assignedSubject: edit.subject || '',
        status: 'draft',
      },
      flags: Object.assign({}, student.flags, {
        drafted: true,
        committed: false,
        subjectMatch: choiceMatchFlag(edit.subject || '', student.choices && student.choices.primary, student.choices && student.choices.secondary),
        hlMatch: diplomaLevelFlag(edit.subject || '', student.dynamicData || {}, (desk.settings && desk.settings.hlColumn) || ''),
      }),
    });
  });
  const presented = {
    students: students,
    supervisors: supervisorsAfterMoves(supervisors, remoteStudents, students),
  };
  if (Array.isArray(desk.tokenRows)) presented.tokenRows = tokenRowsAfterEdits(desk.tokenRows, remoteStudents, students);
  return Object.assign({}, desk, presented);
}

function cloneTokenRow(row) {
  return Object.assign({}, row, { eligibleSubjects: (row.eligibleSubjects || []).slice() });
}

function sameHeldToken(prior, next) {
  if (!prior && !next) return true;
  if (!prior || !next) return false;
  return emailOf(prior.staffId) === emailOf(next.staffId)
    && String(prior.assignedSubject || '').toLowerCase() === String(next.assignedSubject || '').toLowerCase()
    && String(prior.status || '') === String(next.status || '');
}

function releaseTokenRow(rows, studentId, token) {
  const row = rows.find(function(item) { return token.id && token.id !== 'pending' && item.id === token.id; })
    || rows.find(function(item) {
      return emailOf(item.staffId) === emailOf(token.staffId) && emailOf(item.studentId) === emailOf(studentId) && item.status !== 'available';
    });
  if (!row) return;
  row.status = 'available';
  row.studentId = '';
  row.studentName = '';
  row.assignedSubject = '';
}

function takeTokenRow(rows, student, token) {
  let row = token.id && token.id !== 'pending' ? rows.find(function(item) { return item.id === token.id; }) : null;
  const heldByStudent = row && emailOf(row.studentId) === emailOf(student.studentId);
  if (!row || (row.status !== 'available' && !heldByStudent)) {
    row = rows.find(function(item) {
      return emailOf(item.staffId) === emailOf(token.staffId)
        && item.status === 'available'
        && (!token.assignedSubject || subjectsOverlap(token.assignedSubject, item.eligibleSubjects || []));
    }) || rows.find(function(item) {
      return emailOf(item.staffId) === emailOf(token.staffId) && item.status === 'available';
    });
  }
  if (!row) return;
  row.status = token.status === 'committed' ? 'committed' : 'draft';
  row.staffId = emailOf(token.staffId) || row.staffId;
  row.studentId = student.studentId;
  row.studentName = student.displayName || student.studentId;
  row.assignedSubject = token.assignedSubject || '';
}

function tokenRowsAfterEdits(rows, beforeStudents, afterStudents) {
  const next = (rows || []).map(cloneTokenRow);
  const before = new Map((beforeStudents || []).map(function(student) { return [student.studentId, student]; }));
  const frees = [];
  const takes = [];
  (afterStudents || []).forEach(function(student) {
    const prior = before.get(student.studentId);
    const priorToken = prior && prior.token;
    const nextToken = student.token;
    if (sameHeldToken(priorToken, nextToken)) return;
    if (priorToken) frees.push({ studentId: student.studentId, token: priorToken });
    if (nextToken && emailOf(nextToken.staffId)) takes.push({ student: student, token: nextToken });
  });
  frees.forEach(function(item) { releaseTokenRow(next, item.studentId, item.token); });
  takes.forEach(function(item) { takeTokenRow(next, item.student, item.token); });
  return next;
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
  state.allocationPendingFlags = reconcilePendingFlags(state.allocationPendingFlags, remote);
  state.allocationPendingSubjects = reconcilePendingSubjects(state.allocationPendingSubjects, remote);
  state.allocationPendingSuggestions = reconcilePendingSuggestions(state.allocationPendingSuggestions, remote);
  state.allocationHodStatus = hodStatusFromDoc(sources && sources.hodStatus);
  state.allocationDesk = presentAllocationDesk(remote);
  state.allocationAuditLogs = Array.isArray(sources && sources.auditLogs) ? sources.auditLogs : [];
  const view = state.allocationView || 'dashboard';
  if (state.section === 'allocation' && (view === 'dashboard' || view === 'hod' || (view === 'settings' && settingsChanged))) painter();
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
    state.allocationPendingFlags = reconcilePendingFlags(state.allocationPendingFlags, desk);
    state.allocationPendingSubjects = reconcilePendingSubjects(state.allocationPendingSubjects, desk);
    state.allocationPendingSuggestions = reconcilePendingSuggestions(state.allocationPendingSuggestions, desk);
    state.allocationHodStatus = desk.hodStatus || hodStatusFromDoc(null);
    state.allocationDesk = presentAllocationDesk(desk);
    state.allocationAuditLogs = Array.isArray(desk.auditLogs) ? desk.auditLogs : [];
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
    const driveView = state.allocationView || 'dashboard';
    if (state.section === 'allocation' && (driveView === 'dashboard' || driveView === 'hod')) painter();
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
