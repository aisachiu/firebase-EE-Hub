/**
 * Coordinator-facing contract for the COHORTDATA sheet.
 * The Settings help panel renders these strings, and allocationPure tests
 * parse the example through parseWorkspaceGrid so the copy cannot drift.
 */
export const WORKSPACE_SHEET_HELP = {
  tabPattern: 'COHORTDATA: {cohortYear}',
  tabExample: 'COHORTDATA: 2026',
  requiredColumn: 'StudentId',
  requiredMeans: 'the student email already on that cohort roster',
  activeHeaders: ['EEActive', 'EE Active'],
  choiceHeaders: ['SubjectChoice', 'SubjectChoices'],
  choiceShape: 'a JSON object, not an array',
  choiceColumnPrefixes: ['Choice_', 'Choice:', 'Choice ', 'Choice-'],
  otherColumns: 'Any other header is stored as dynamicData and can be shown as a desk column.',
  subjectValues: 'Display names as text (for example "History"), not Hub subject document ids.',
  jsonExample: '{"choice1":"History","choice2":"Eng Lit","interdisciplinary":true}',
  exampleHeaders: ['StudentId', 'SubjectChoice', 'Choice_choice2', 'Y10 GPA', 'EEActive'],
  exampleRow: {
    StudentId: 'jane.doe@school.edu',
    SubjectChoice: '{"choice1":"History","interdisciplinary":true}',
    Choice_choice2: 'Eng Lit',
    'Y10 GPA': '3.4',
    EEActive: 'yes',
  },
  mappingNote: 'After ingest, set Primary, Secondary, and Interdisciplinary key mapping in Settings. Requested subjects on the desk reads those mapped keys first, then any other choice value, and shows subject names instead of raw JSON. A wrong or missing mapping shows "No subject choices" when no subject name can be read. Malformed JSON warns, and the row still ingests with empty choices. Interdisciplinary, including a value such as deciding, is the ID tag.',
  workspaceNote: 'Student ingest upserts by StudentId. Students missing from the sheet stay in the hub. This preview does not remove rows.',
  tokenNote: 'Token ingest tops up quotas and updates open slots. Tokens missing from the sheet stay in the hub. Draft and committed tokens keep their subject lists. This preview does not remove rows.',
};
