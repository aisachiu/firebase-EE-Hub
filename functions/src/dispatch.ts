import {
  addStaffStudentTodo,
  addStudentTodo,
  applyTodoTemplate,
  assignMilestonesToStudents,
  deleteTodoTemplate,
  recordMilestoneDecision,
  saveStudentAnchorAndSync,
  saveStudentTodo,
  saveTodoTemplate,
  setActionItemStatus,
} from './actions';
import {
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
} from './admin';
import { getAppBootstrap } from './bootstrap';
import { checkCohortDriveFolders, getCohortDriveSettings, saveCohortDriveSettings, syncCohortDriveFolders } from './drive';
import { getFormDesigner, getFormResponse, getStudentForm, listFormMilestones, publishForm, saveFormDraft, saveStudentForm } from './forms';
import { getMyActivity, getPathwayPlan, getStaffHome, getStaffStudentHome, getStudentActivity, getStudentHome } from './journey';
import {
  createStaffNote,
  createTicket,
  getStaffNotesHub,
  getStaffStudentPanel,
  getStaffTicketBadge,
  getStaffTickets,
  getTicketHub,
  markTicketRead,
  replyTicket,
  setMessageShared,
  setTicketStatus,
} from './messaging';
import { App } from './session';
import { HubError, text } from './util';

export async function dispatch(app: App, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'getAppBootstrap': return getAppBootstrap(app);
    case 'getStudentHome': return getStudentHome(app);
    case 'getStaffHome': return getStaffHome(app, args[0], args[1]);
    case 'getStaffStudentHome': return getStaffStudentHome(app, args[0], args[1], args[2]);
    case 'getMyActivity': return getMyActivity(app);
    case 'getStudentActivity': return getStudentActivity(app, args[0], args[1]);
    case 'getContentHub': return getContentHub(app);
    case 'getCohorts': return getCohorts(app);
    case 'getAdminRecords': return getAdminRecords(app, text(args[0]));
    case 'getCohortMembersForAdmin': return getCohortMembersForAdmin(app, args[0]);
    case 'getPathwayPlan': return getPathwayPlan(app);
    case 'saveAdminRecord': return saveAdminRecord(app, text(args[0]), (args[1] || {}) as any, args[2]);
    case 'deleteAdminRecord': return deleteAdminRecord(app, text(args[0]), args[1]);
    case 'saveCohortMember': return saveCohortMember(app, args[0], (args[1] || {}) as any, args[2]);
    case 'deleteCohortMember': return deleteCohortMember(app, args[0], args[1]);
    case 'importCohortMembers': return importCohortMembers(app, args[0], args[1]);
    case 'createStudentUsersFromCohort': return createStudentUsersFromCohort(app, args[0], args[1]);
    case 'assignMilestonesToStudents': return assignMilestonesToStudents(app, args[0], args[1], args[2]);
    case 'saveStudentAnchorAndSync': return saveStudentAnchorAndSync(app, args[0], args[1], args[2]);
    case 'setActionItemStatus': return setActionItemStatus(app, args[0], args[1], args[2], args[3], args[4]);
    case 'saveStudentTodo': return saveStudentTodo(app, args[0], args[1], args[2], args[3]);
    case 'addStudentTodo': return addStudentTodo(app, args[0], args[1]);
    case 'addStaffStudentTodo': return addStaffStudentTodo(app, args[0], args[1], args[2], args[3], args[4]);
    case 'recordMilestoneDecision': return recordMilestoneDecision(app, args[0], args[1], args[2], args[3], args[4], args[5]);
    case 'saveTodoTemplate': return saveTodoTemplate(app, args[0]);
    case 'deleteTodoTemplate': return deleteTodoTemplate(app, args[0]);
    case 'applyTodoTemplate': return applyTodoTemplate(app, args[0], args[1], args[2], args[3], args[4]);
    case 'getTicketHub': return getTicketHub(app);
    case 'createTicket': return createTicket(app, args[0]);
    case 'replyTicket': return replyTicket(app, args[0], args[1], args[2], args[3]);
    case 'setTicketStatus': return setTicketStatus(app, args[0], args[1], args[2], args[3]);
    case 'markTicketRead': return markTicketRead(app, args[0], args[1], args[2]);
    case 'setMessageShared': return setMessageShared(app, args[0], args[1], args[2], args[3]);
    case 'getStaffTickets': return getStaffTickets(app, args[0]);
    case 'getStaffTicketBadge': return getStaffTicketBadge(app, args[0]);
    case 'getStaffNotesHub': return getStaffNotesHub(app, args[0]);
    case 'getStaffStudentPanel': return getStaffStudentPanel(app, args[0], args[1], args[2]);
    case 'createStaffNote': return createStaffNote(app, args[0], args[1], args[2], args[3]);
    case 'listFormMilestones': return listFormMilestones(app);
    case 'getFormDesigner': return getFormDesigner(app, args[0]);
    case 'saveFormDraft': return saveFormDraft(app, args[0], args[1]);
    case 'publishForm': return publishForm(app, args[0], args[1]);
    case 'getStudentForm': return getStudentForm(app, args[0]);
    case 'saveStudentForm': return saveStudentForm(app, args[0], args[1]);
    case 'getFormResponse': return getFormResponse(app, args[0], args[1]);
    case 'getCohortDriveSettings': return getCohortDriveSettings(app, args[0]);
    case 'saveCohortDriveSettings': return saveCohortDriveSettings(app, args[0], args[1]);
    case 'checkCohortDriveFolders': return checkCohortDriveFolders(app, args[0], args[1], args[2]);
    case 'syncCohortDriveFolders': return syncCohortDriveFolders(app, args[0], args[1], args[2]);
    default: throw new HubError('Unknown EE Hub request.');
  }
}
