import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { starterSubjectForm } from './formsPure';
import { COLLECTIONS } from './schema';
import { Store } from './store';
import { addDays, parseActionDate, serializeDateOnly } from './util';

const PASSWORD = 'ee-hub-demo';
const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-ee-hub';

if (process.env.EE_SEED_PRODUCTION !== '1') {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
}

const COORDINATOR = 'coordinator@vsa.example.edu';
const SUPERVISOR = 'supervisor@vsa.example.edu';
const STUDENT = 'student@vsa.example.edu';

async function ensureAuth(email: string, displayName: string) {
  const auth = getAuth();
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password: PASSWORD, displayName, emailVerified: true });
    return existing.uid;
  } catch {
    const created = await auth.createUser({ email, password: PASSWORD, displayName, emailVerified: true });
    return created.uid;
  }
}

async function seed() {
  initializeApp({ projectId: PROJECT });
  const store = new Store(getFirestore());
  await ensureAuth(COORDINATOR, 'Alex Chen');
  await ensureAuth(SUPERVISOR, 'Priya Shah');
  await ensureAuth(STUDENT, 'Jamie Wong');

  await store.set(COLLECTIONS.staffUsers, COORDINATOR, {
    EMAIL: COORDINATOR, DisplayName: 'Alex Chen', 'Primary Department': 'Extended Essay', StaffCode: 'AC',
    isStaff: true, isSupervisor: false, isLead: false, isCoordinator: true, isAdmin: true, EEQuota: 40, EESubjects: '',
  });
  await store.set(COLLECTIONS.staffUsers, SUPERVISOR, {
    EMAIL: SUPERVISOR, DisplayName: 'Priya Shah', 'Primary Department': 'English', StaffCode: 'PS',
    isStaff: true, isSupervisor: true, isLead: true, isCoordinator: false, isAdmin: false, EEQuota: 8, EESubjects: 'English',
  });
  await store.set(COLLECTIONS.studentUsers, STUDENT, {
    StudentId: STUDENT, DisplayName: 'Jamie Wong', Cohort: '2026', studentEmail: STUDENT, parentEmail: 'family.wong@vsa.example.edu',
  });
  await store.set(COLLECTIONS.cohorts, '2026', {
    Cohort: '2026', SheetName: 'COHORT: 2026', Status: 'Active', DriveRootFolderId: '', FolderPrefix: 'EE ', FolderSuffix: '',
  });
  await store.setMember('2026', STUDENT, {
    StudentId: STUDENT,
    'Display Name': 'Jamie Wong',
    HRM: 'WON001',
    Surname: 'Wong',
    'First Name': 'Jamie',
    'Preferred Name': 'Jamie',
    'Chinese Name': '',
    'Student ID': '20260001',
    'Family Email': 'family.wong@vsa.example.edu',
    'Student Email': STUDENT,
    'Date of Birth': '2008-04-12',
    House: 'Dragon',
    Gender: '',
    'Year Group': 12,
    Anchor_Date: '2026-12-15',
    supervisorId: SUPERVISOR,
    subject: 'English',
    latestMilestone: '',
    EEFolder: '',
    EEDoc: '',
    RPPFDoc: '',
    EEPoster: '',
  });

  const phases = [
    { phaseId: 'topic', phaseTitle: 'Topic', phaseDescription: 'Choose a subject and a question.', sequence: 1, prerequisitePhaseId: '', active: true },
    { phaseId: 'research', phaseTitle: 'Research', phaseDescription: 'Read, plan, and check the question with your supervisor.', sequence: 2, prerequisitePhaseId: 'topic', active: true },
    { phaseId: 'writing', phaseTitle: 'Writing', phaseDescription: 'Draft, revise, and prepare the reflection.', sequence: 3, prerequisitePhaseId: 'research', active: true },
  ];
  for (const phase of phases) await store.set(COLLECTIONS.phases, phase.phaseId, phase);

  const milestones = [
    { milestoneId: 'm1', type: 'form', milestoneTitle: 'Subject preference', offsetDays: 80, milestoneDescription: 'Tell us which subjects you are considering.', phase: 'topic', mOwner: 'student', position: 1 },
    { milestoneId: 'm2', type: 'upload', milestoneTitle: 'Research question', offsetDays: 40, milestoneDescription: 'Upload a one-page question and why it matters.', phase: 'research', mOwner: 'student', position: 2 },
    { milestoneId: 'm3', type: 'approval', milestoneTitle: 'Supervisor approval', offsetDays: 20, milestoneDescription: 'Your supervisor confirms the question is viable.', phase: 'research', mOwner: 'supervisor', position: 3 },
    { milestoneId: 'm4', type: 'meeting', milestoneTitle: 'First check-in', offsetDays: 5, milestoneDescription: 'A short meeting with the EE Coordinator.', phase: 'writing', mOwner: 'coordinator', position: 4 },
  ];
  for (const milestone of milestones) await store.set(COLLECTIONS.milestoneTemplates, milestone.milestoneId, milestone);

  const anchor = parseActionDate('2026-12-15');
  if (!anchor) throw new Error('Seed anchor date is invalid.');
  const now = new Date().toISOString();
  for (const milestone of milestones) {
    const taskId = `ACT_SEED_${milestone.milestoneId.toUpperCase()}`;
    await store.set(COLLECTIONS.studentActionItems, taskId, {
      TaskId: taskId,
      StudentId: STUDENT,
      CreatorType: 'System',
      TemplateId: milestone.milestoneId,
      PhaseId: milestone.phase,
      Title: milestone.milestoneTitle,
      Description: milestone.milestoneDescription,
      DueDate: serializeDateOnly(addDays(anchor, -milestone.offsetDays)),
      Status: 'Pending',
      LastUpdated: now,
      CreatedBy: COORDINATOR,
      UpdatedBy: COORDINATOR,
    });
  }

  const starter = starterSubjectForm();
  await store.set(COLLECTIONS.formDefinitions, 'm1', {
    milestoneId: 'm1',
    status: 'Published',
    version: 1,
    fieldsJson: JSON.stringify(starter.fields),
    html: starter.html,
    js: starter.js,
    submitCompletes: true,
    LastUpdated: now,
    UpdatedBy: COORDINATOR,
  });

  for (const subject of [
    { 'Subject ID': 'eng', Name: 'English', Department: 'English', Active: true },
    { 'Subject ID': 'his', Name: 'History', Department: 'Humanities', Active: true },
    { 'Subject ID': 'bio', Name: 'Biology', Department: 'Science', Active: true },
  ]) {
    await store.set(COLLECTIONS.subjects, subject['Subject ID'], subject);
  }

  await store.set(COLLECTIONS.resources, 'guide-question', {
    'Resource ID': 'guide-question',
    Title: 'Writing a focused research question',
    Category: 'Guide',
    Description: 'A short guide for the first weeks of the EE.',
    URL: 'https://www.ibo.org/programmes/diploma-programme/curriculum/dp-core/extended-essay/',
    Audience: 'all',
    Published: true,
    'Sort Order': 1,
    Slug: 'research-question',
    Body: 'Name the subject, a specific case or text, and a question you can answer in 4,000 words.',
    'Body Format': 'plain',
  });
  await store.set(COLLECTIONS.faqs, 'faq-words', {
    FaqId: 'faq-words',
    Question: 'What counts toward the 4,000-word limit?',
    Answer: 'The introduction, body, conclusion, and quotations count. Contents pages, charts, citations, the bibliography, and appendices do not.',
    Audience: 'student',
    Published: true,
    SortOrder: 1,
  });
  const quotes = [
    'A clear question is the start of a strong essay.',
    'Small steady steps finish a long project.',
    'Ask for feedback, then make the work more precise.',
  ];
  for (let index = 0; index < quotes.length; index++) {
    await store.set(COLLECTIONS.quotations, `quote-${index + 1}`, { QuoteId: `quote-${index + 1}`, Display: quotes[index], Quote: quotes[index], Author: '' });
  }
  const categories = [
    ['cat-subject', 'Subject & Methodology', 'supervisor', 1],
    ['cat-citations', 'Citations', 'supervisor', 2],
    ['cat-ethics', 'Ethics', 'coordinator', 3],
    ['cat-extensions', 'Extensions', 'coordinator', 4],
    ['cat-technical', 'Technical', 'coordinator', 5],
  ] as const;
  for (const [id, name, route, sort] of categories) {
    await store.set(COLLECTIONS.ticketCategories, id, { CategoryId: id, Name: name, Route: route, SortOrder: sort, Active: true });
  }
  const ticketId = 'ticket-seed-question';
  await store.set(COLLECTIONS.tickets, ticketId, {
    TicketId: ticketId,
    StudentId: STUDENT,
    Cohort: '2026',
    Category: 'Subject & Methodology',
    Title: 'Is my question too broad?',
    Status: 'Open',
    Route: 'supervisor',
    Assignee: SUPERVISOR,
    CreatedAt: now,
    LastUpdated: now,
    LastActor: STUDENT,
    StudentUnread: false,
    StaffUnread: true,
    Shared: true,
  });
  await store.addMessage(ticketId, 'msg-seed-1', {
    MessageId: 'msg-seed-1',
    TicketId: ticketId,
    AuthorEmail: STUDENT,
    AuthorRole: 'student',
    Body: 'I want to write about cities in fiction. Is that too broad for 4,000 words?',
    CreatedAt: now,
  });
  console.log(`Seeded ${PROJECT}. Demo password for the emulator: ${PASSWORD}`);
  console.log(`Student ${STUDENT}`);
  console.log(`Supervisor ${SUPERVISOR}`);
  console.log(`Coordinator ${COORDINATOR}`);
}

if (require.main === module) {
  seed().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
