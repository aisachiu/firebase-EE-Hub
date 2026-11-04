import {
  addStaffStudentTodo,
  addStudentTodo,
  applyTodoTemplate,
  assignMilestonesToStudents,
  deleteTodoTemplate,
  massUpdateMilestones,
  recordMilestoneDecision,
  saveStudentAnchorAndSync,
  setStaffMilestoneStatus,
  updateMilestoneAssignment,
  saveStudentTodo,
  saveTodoTemplate,
  setActionItemStatus,
} from './actions';
import {
  autoApplySubjectColours,
  clearCohortWorkspaceLinks,
  createStudentUsersFromCohort,
  deleteAdminRecord,
  deleteCohortMember,
  getAdminRecords,
  getCohortMembersForAdmin,
  getCohorts,
  getContentHub,
  importCohortMembers,
  saveAdminRecord,
  saveCohortMember,
  setMilestoneAnchor,
} from './admin';
import { getAppBootstrap } from './bootstrap';
import { getStaffStudentChat, getStudentChat, sendStaffStudentChat, sendStudentChat } from './chat';
import { getMyEssayAnalytics, getStudentEssayAnalytics } from './docAnalytics';
import { syncEssayDocComments } from './docComments';
import { checkCohortDriveFolders, getCohortDriveSettings, getDriveAccount, saveCohortDriveSettings, saveDriveAccount, syncCohortDriveFolders } from './drive';
import { getFormDesigner, getFormResponse, getStudentForm, listFormMilestones, publishForm, saveFormDraft, saveStudentForm } from './forms';
import {
  deleteCohortMilestone,
  deleteCohortPhase,
  getPathwayPlan,
  saveCohortMilestone,
  saveCohortPhase,
  saveCohortPlanAnchor,
  seedCohortPathway,
} from './cohortPathway';
import { getMyActivity, getStaffHome, getStaffStudentHome, getStudentActivity, getStudentHome, recordStudentView } from './journey';
import { saveReflectionNote } from './reflectionNotes';
import { getServerSettings, saveServerSettings } from './serverSettings';
import { getStudentPageSettings, saveStudentPageSettings } from './studentPages';
import {
  createStaffNote,
  getStaffNotesHub,
  getStaffStudentPanel,
  markTicketRead,
  replyTicket,
  setMessageShared,
} from './messaging';
import {
  deleteNotificationOverlay,
  deleteNotificationRule,
  listNotificationDesk,
  previewNotificationRule,
  previewNotificationSweep,
  runNotificationSweep,
  saveNotificationOverlay,
  saveNotificationRule,
  sendNotificationRule,
  sendNotificationTest,
  setNotificationOverlayEnabled,
  setNotificationRuleEnabled,
} from './notifications';
import { App } from './session';
import {
  addCohortTokens,
  applyAllocationIngest,
  applyStaffQuotaTokens,
  batchDraftAllocations,
  commitAllocations,
  deleteCohortToken,
  draftAllocation,
  exportAllocationDrafts,
  exportStaffQuotaSheet,
  getAllocationDesk,
  getStaffQuotaSheet,
  listCohortTokens,
  previewAllocationIngest,
  previewAllocationBackfill,
  applyAllocationBackfill,
  previewStaffQuotaTokens,
  reopenAllocation,
  reopenAllocations,
  saveAllocationChoices,
  saveAllocationConfig,
  saveAllocationFlag,
  setAllocationSubject,
  suggestAllocation,
  certifyHodSuggestions,
  reopenHodSuggestions,
  approveAllocationSuggestion,
  batchApproveAllocationSuggestions,
  assignStaffSubjects,
  saveStaffQuotas,
  saveStaffSubjects,
  updateCohortToken,
} from './allocation';
import { undoAllocationAudit } from './allocationAudit';
import { getLiveSheetHeaders, listLiveSheetTabs, resyncLiveChoiceData, saveLiveSheetLink } from './liveSheet';
import { applySheetIngest, exportSheetCollections, listSheetCollections, previewSheetIngest } from './sheetSync';
import { deleteStudentTask, listStudentTasks, saveStudentTask } from './studentTasks';
import { addSupervisorTodo, deleteSupervisorTodo, getSupervisorTodoDesk, setSupervisorTodoStatus } from './supervisorTodos';
import { HubError, text } from './util';

export async function dispatch(app: App, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'getAppBootstrap': return getAppBootstrap(app);
    case 'getStudentHome': return getStudentHome(app);
    case 'getStaffHome': return getStaffHome(app, args[0], args[1]);
    case 'getStaffStudentHome': return getStaffStudentHome(app, args[0], args[1], args[2]);
    case 'getMyActivity': return getMyActivity(app);
    case 'recordStudentView': return recordStudentView(app, args[0]);
    case 'getStudentActivity': return getStudentActivity(app, args[0], args[1]);
    case 'getMyEssayAnalytics': return getMyEssayAnalytics(app);
    case 'syncEssayDocComments': return syncEssayDocComments(app, args[0], args[1], args[2]);
    case 'getStudentEssayAnalytics': return getStudentEssayAnalytics(app, args[0], args[1], args[2]);
    case 'getContentHub': return getContentHub(app);
    case 'getCohorts': return getCohorts(app);
    case 'getAdminRecords': return getAdminRecords(app, text(args[0]));
    case 'getCohortMembersForAdmin': return getCohortMembersForAdmin(app, args[0]);
    case 'getPathwayPlan': return getPathwayPlan(app, args[0]);
    case 'saveCohortPhase': return saveCohortPhase(app, args[0], (args[1] || {}) as any, args[2]);
    case 'deleteCohortPhase': return deleteCohortPhase(app, args[0], args[1]);
    case 'saveCohortMilestone': return saveCohortMilestone(app, args[0], (args[1] || {}) as any, args[2]);
    case 'deleteCohortMilestone': return deleteCohortMilestone(app, args[0], args[1]);
    case 'saveCohortPlanAnchor': return saveCohortPlanAnchor(app, args[0], args[1]);
    case 'seedCohortPathway': return seedCohortPathway(app, args[0], args[1], args[2]);
    case 'saveAdminRecord': return saveAdminRecord(app, text(args[0]), (args[1] || {}) as any, args[2]);
    case 'autoApplySubjectColours': return autoApplySubjectColours(app, args[0]);
    case 'setMilestoneAnchor': return setMilestoneAnchor(app, args[0], args[1], args[2]);
    case 'deleteAdminRecord': return deleteAdminRecord(app, text(args[0]), args[1]);
    case 'saveCohortMember': return saveCohortMember(app, args[0], (args[1] || {}) as any, args[2]);
    case 'deleteCohortMember': return deleteCohortMember(app, args[0], args[1]);
    case 'importCohortMembers': return importCohortMembers(app, args[0], args[1]);
    case 'createStudentUsersFromCohort': return createStudentUsersFromCohort(app, args[0], args[1]);
    case 'clearCohortWorkspaceLinks': return clearCohortWorkspaceLinks(app, args[0], args[1]);
    case 'assignMilestonesToStudents': return assignMilestonesToStudents(app, args[0], args[1], args[2]);
    case 'listStudentTasks': return listStudentTasks(app, args[0]);
    case 'saveStudentTask': return saveStudentTask(app, args[0], (args[1] || {}) as any, args[2]);
    case 'deleteStudentTask': return deleteStudentTask(app, args[0], args[1]);
    case 'saveStudentAnchorAndSync': return saveStudentAnchorAndSync(app, args[0], args[1], args[2]);
    case 'setActionItemStatus': return setActionItemStatus(app, args[0], args[1], args[2], args[3], args[4]);
    case 'saveStudentTodo': return saveStudentTodo(app, args[0], args[1], args[2], args[3]);
    case 'addStudentTodo': return addStudentTodo(app, args[0], args[1]);
    case 'addStaffStudentTodo': return addStaffStudentTodo(app, args[0], args[1], args[2], args[3], args[4]);
    case 'recordMilestoneDecision': return recordMilestoneDecision(app, args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
    case 'setStaffMilestoneStatus': return setStaffMilestoneStatus(app, args[0], args[1], args[2], args[3], args[4]);
    case 'updateMilestoneAssignment': return updateMilestoneAssignment(app, args[0], args[1], args[2], args[3], args[4]);
    case 'massUpdateMilestones': return massUpdateMilestones(app, args[0], args[1], args[2], args[3], args[4]);
    case 'saveTodoTemplate': return saveTodoTemplate(app, args[0]);
    case 'deleteTodoTemplate': return deleteTodoTemplate(app, args[0]);
    case 'applyTodoTemplate': return applyTodoTemplate(app, args[0], args[1], args[2], args[3], args[4]);
    case 'getStudentChat': return getStudentChat(app);
    case 'sendStudentChat': return sendStudentChat(app, args[0], args[1]);
    case 'replyTicket': return replyTicket(app, args[0], args[1], args[2], args[3]);
    case 'markTicketRead': return markTicketRead(app, args[0], args[1], args[2]);
    case 'setMessageShared': return setMessageShared(app, args[0], args[1], args[2], args[3]);
    case 'getStaffStudentChat': return getStaffStudentChat(app, args[0], args[1], args[2]);
    case 'getStaffNotesHub': return getStaffNotesHub(app, args[0]);
    case 'getStaffStudentPanel': return getStaffStudentPanel(app, args[0], args[1], args[2]);
    case 'createStaffNote': return createStaffNote(app, args[0], args[1], args[2], args[3], args[4]);
    case 'sendStaffStudentChat': return sendStaffStudentChat(app, args[0], args[1], args[2], args[3], args[4]);
    case 'listFormMilestones': return listFormMilestones(app);
    case 'getFormDesigner': return getFormDesigner(app, args[0]);
    case 'saveFormDraft': return saveFormDraft(app, args[0], args[1]);
    case 'publishForm': return publishForm(app, args[0], args[1]);
    case 'getStudentForm': return getStudentForm(app, args[0]);
    case 'saveStudentForm': return saveStudentForm(app, args[0], args[1]);
    case 'getFormResponse': return getFormResponse(app, args[0], args[1]);
    case 'getDriveAccount': return getDriveAccount(app);
    case 'saveDriveAccount': return saveDriveAccount(app, args[0]);
    case 'getCohortDriveSettings': return getCohortDriveSettings(app, args[0], args[1]);
    case 'saveCohortDriveSettings': return saveCohortDriveSettings(app, args[0], args[1]);
    case 'checkCohortDriveFolders': return checkCohortDriveFolders(app, args[0], args[1], args[2]);
    case 'syncCohortDriveFolders': return syncCohortDriveFolders(app, args[0], args[1], args[2]);
    case 'listSheetCollections': return listSheetCollections(app);
    case 'exportSheetCollections': return exportSheetCollections(app, args[0]);
    case 'previewSheetIngest': return previewSheetIngest(app, args[0], args[1]);
    case 'applySheetIngest': return applySheetIngest(app, args[0], args[1], args[2]);
    case 'listNotificationDesk': return listNotificationDesk(app, args[0], args[1]);
    case 'saveNotificationRule': return saveNotificationRule(app, args[0]);
    case 'deleteNotificationRule': return deleteNotificationRule(app, args[0]);
    case 'setNotificationRuleEnabled': return setNotificationRuleEnabled(app, args[0], args[1]);
    case 'saveNotificationOverlay': return saveNotificationOverlay(app, args[0]);
    case 'deleteNotificationOverlay': return deleteNotificationOverlay(app, args[0]);
    case 'setNotificationOverlayEnabled': return setNotificationOverlayEnabled(app, args[0], args[1]);
    case 'previewNotificationSweep': return previewNotificationSweep(app, args[0]);
    case 'previewNotificationRule': return previewNotificationRule(app, args[0], args[1]);
    case 'runNotificationSweep': return runNotificationSweep(app, args[0]);
    case 'sendNotificationRule': return sendNotificationRule(app, args[0]);
    case 'sendNotificationTest': return sendNotificationTest(app, args[0], args[1]);
    case 'getAllocationDesk': return getAllocationDesk(app, args[0]);
    case 'draftAllocation': return draftAllocation(app, args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
    case 'saveAllocationFlag': return saveAllocationFlag(app, args[0], args[1], args[2], args[3]);
    case 'setAllocationSubject': return setAllocationSubject(app, args[0], args[1], args[2]);
    case 'suggestAllocation': return suggestAllocation(app, args[0], args[1], args[2]);
    case 'certifyHodSuggestions': return certifyHodSuggestions(app, args[0]);
    case 'reopenHodSuggestions': return reopenHodSuggestions(app, args[0], args[1]);
    case 'approveAllocationSuggestion': return approveAllocationSuggestion(app, args[0], args[1]);
    case 'batchApproveAllocationSuggestions': return batchApproveAllocationSuggestions(app, args[0], args[1]);
    case 'batchDraftAllocations': return batchDraftAllocations(app, args[0], args[1], args[2], args[3], args[4]);
    case 'reopenAllocation': return reopenAllocation(app, args[0], args[1]);
    case 'reopenAllocations': return reopenAllocations(app, args[0], args[1]);
    case 'commitAllocations': return commitAllocations(app, args[0], args[1]);
    case 'saveAllocationChoices': return saveAllocationChoices(app, args[0], args[1]);
    case 'saveAllocationConfig': return saveAllocationConfig(app, args[0], args[1]);
    case 'previewAllocationIngest': return previewAllocationIngest(app, args[0], args[1], args[2]);
    case 'applyAllocationIngest': return applyAllocationIngest(app, args[0], args[1], args[2]);
    case 'previewAllocationBackfill': return previewAllocationBackfill(app, args[0]);
    case 'applyAllocationBackfill': return applyAllocationBackfill(app, args[0]);
    case 'exportAllocationDrafts': return exportAllocationDrafts(app, args[0]);
    case 'getStaffQuotaSheet': return getStaffQuotaSheet(app);
    case 'saveStaffQuotas': return saveStaffQuotas(app, args[0]);
    case 'saveStaffSubjects': return saveStaffSubjects(app, args[0]);
    case 'assignStaffSubjects': return assignStaffSubjects(app, args[0], args[1], args[2]);
    case 'previewStaffQuotaTokens': return previewStaffQuotaTokens(app, args[0]);
    case 'applyStaffQuotaTokens': return applyStaffQuotaTokens(app, args[0]);
    case 'exportStaffQuotaSheet': return exportStaffQuotaSheet(app, args[0]);
    case 'listCohortTokens': return listCohortTokens(app, args[0]);
    case 'addCohortTokens': return addCohortTokens(app, args[0], args[1], args[2], args[3]);
    case 'updateCohortToken': return updateCohortToken(app, args[0], args[1], args[2]);
    case 'deleteCohortToken': return deleteCohortToken(app, args[0], args[1]);
    case 'undoAllocationAudit': return undoAllocationAudit(app, args[0], args[1]);
    case 'listLiveSheetTabs': return listLiveSheetTabs(app, args[0], args[1]);
    case 'getLiveSheetHeaders': return getLiveSheetHeaders(app, args[0], args[1], args[2]);
    case 'saveLiveSheetLink': return saveLiveSheetLink(app, args[0], args[1]);
    case 'resyncLiveChoiceData': return resyncLiveChoiceData(app, args[0]);
    case 'getSupervisorTodoDesk': return getSupervisorTodoDesk(app, args[0]);
    case 'addSupervisorTodo': return addSupervisorTodo(app, args[0], args[1], args[2]);
    case 'setSupervisorTodoStatus': return setSupervisorTodoStatus(app, args[0], args[1]);
    case 'deleteSupervisorTodo': return deleteSupervisorTodo(app, args[0]);
    case 'getServerSettings': return getServerSettings(app);
    case 'saveServerSettings': return saveServerSettings(app, args[0]);
    case 'getStudentPageSettings': return getStudentPageSettings(app);
    case 'saveStudentPageSettings': return saveStudentPageSettings(app, args[0]);
    case 'saveReflectionNote': return saveReflectionNote(app, args[0], args[1]);
    default: throw new HubError('Unknown EE Hub request.');
  }
}
