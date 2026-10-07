import { readFileSync } from 'node:fs';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { google } from 'googleapis';
import { COLLECTIONS } from './schema';
import { planSheetImport, SheetGrid, SheetImportPlan, spreadsheetIdFrom } from './sheetImport';
import { cleanDoc, Doc } from './util';

const READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const production = args.includes('--production');
  const dryRun = args.includes('--dry-run');
  const projectFlag = args.find((arg) => arg.startsWith('--project='));
  const spreadsheetArg = args.find((arg) => !arg.startsWith('--'));
  if (!spreadsheetArg) {
    throw new Error('Usage: npm run import-sheet -- <sheet url or id> [--dry-run] [--production] [--project=project-id]');
  }
  const spreadsheetId = spreadsheetIdFrom(spreadsheetArg);
  const projectId = projectFlag?.slice('--project='.length) || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-ee-hub';
  const account = loadServiceAccount();

  if (!production) process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  else if (process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Unset FIRESTORE_EMULATOR_HOST before importing into a live Firebase project.');
  }

  const grids = await readWorkbook(spreadsheetId, account);
  const plan = planSheetImport(grids);
  printPlan(plan, production ? `project ${projectId}` : `emulator ${projectId}`);
  if (dryRun) return;

  initializeApp(account && production
    ? { credential: cert(account), projectId }
    : { projectId });
  await writePlan(getFirestore(), plan);
  console.log(production ? `Imported into ${projectId}.` : `Imported into the Firestore emulator for ${projectId}.`);
}

function loadServiceAccount(): Record<string, string> | null {
  const raw = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '';
  if (!raw.trim()) return null;
  const parsed = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(readFileSync(raw, 'utf8'));
  if (!parsed.client_email || !parsed.private_key) throw new Error('The service account JSON needs client_email and private_key.');
  return parsed;
}

async function readWorkbook(spreadsheetId: string, account: Record<string, string> | null): Promise<SheetGrid[]> {
  const auth = new google.auth.GoogleAuth(account
    ? { credentials: account, scopes: [READ_SCOPE] }
    : { scopes: [READ_SCOPE] });
  if (account) console.log(`Reading the spreadsheet as ${account.client_email}. Share the sheet with that address if the read is denied.`);
  else console.log('Reading the spreadsheet with application default credentials.');
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const titles = (meta.data.sheets || []).map((sheet) => sheet.properties?.title || '').filter(Boolean);
  const grids: SheetGrid[] = [];
  for (const title of titles) {
    const range = `'${title.replace(/'/g, "''")}'`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    grids.push({ title, rows: response.data.values || [] });
  }
  return grids;
}

function printPlan(plan: SheetImportPlan, target: string): void {
  console.log(`Workbook plan for ${target}`);
  Object.keys(plan.docs).sort().forEach((collection) => {
    console.log(`  ${collection}: ${plan.docs[collection].length}`);
  });
  console.log(`  cohort members: ${plan.members.length}`);
  console.log(`  ticket messages: ${plan.messages.length}`);
  console.log(`  audit logs: ${plan.audits.length}`);
  if (plan.warningCount) {
    console.log(`${plan.warningCount} warning${plan.warningCount === 1 ? '' : 's'}:`);
    plan.warnings.forEach((warning) => console.log(`  - ${warning}`));
    if (plan.warningCount > plan.warnings.length) console.log(`  - and ${plan.warningCount - plan.warnings.length} more`);
  }
}

export async function writePlan(db: FirebaseFirestore.Firestore, plan: SheetImportPlan): Promise<void> {
  if (plan.docs[COLLECTIONS.cohorts]) await clearMembers(db);
  if (plan.docs[COLLECTIONS.tickets] || plan.messages.length) await clearMessages(db);
  for (const collection of Object.keys(plan.docs)) await clearCollection(db.collection(collection));
  if (plan.audits.length) await clearCollection(db.collection(COLLECTIONS.auditLogs));

  const ops: { ref: FirebaseFirestore.DocumentReference; data: Doc }[] = [];
  Object.keys(plan.docs).forEach((collection) => {
    plan.docs[collection].forEach((doc) => {
      ops.push({ ref: db.collection(collection).doc(doc.id), data: doc.data });
    });
  });
  plan.members.forEach((member) => {
    ops.push({
      ref: db.collection(COLLECTIONS.cohorts).doc(member.cohortId).collection('members').doc(member.id),
      data: member.data,
    });
  });
  plan.messages.forEach((message) => {
    ops.push({
      ref: db.collection(COLLECTIONS.tickets).doc(message.ticketId).collection('messages').doc(message.id),
      data: message.data,
    });
  });
  plan.audits.forEach((entry) => {
    ops.push({ ref: db.collection(COLLECTIONS.auditLogs).doc(), data: entry });
  });
  for (let index = 0; index < ops.length; index += 400) {
    const batch = db.batch();
    ops.slice(index, index + 400).forEach((op) => batch.set(op.ref, cleanDoc(op.data)));
    await batch.commit();
  }
}

async function clearMembers(db: FirebaseFirestore.Firestore): Promise<void> {
  const cohorts = await db.collection(COLLECTIONS.cohorts).get();
  for (const cohort of cohorts.docs) await clearCollection(cohort.ref.collection('members'));
}

async function clearMessages(db: FirebaseFirestore.Firestore): Promise<void> {
  const tickets = await db.collection(COLLECTIONS.tickets).get();
  for (const ticket of tickets.docs) await clearCollection(ticket.ref.collection('messages'));
}

async function clearCollection(collection: FirebaseFirestore.CollectionReference): Promise<void> {
  for (;;) {
    const snap = await collection.limit(400).get();
    if (snap.empty) return;
    const batch = collection.firestore.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < 400) return;
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
