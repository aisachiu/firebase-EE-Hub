# Firebase EE Hub

Firebase version of the [VSA Extended Essay hub](https://github.com/aisachiu/GAS-EE-Hub). The screens are the same. Records live in Firestore, sign-in is Firebase Auth, and the Apps Script calls are one Cloud Function named `eeHub`.

Students see My EE, resources, and help. Staff see My Students, messages, and notes. Coordinators and admins also see Admin. Milestone ownership, phase prerequisites, tickets, and milestone forms are enforced in the function. The browser cannot write Firestore directly.

## Local app

Java is required for the Firestore emulator.

```bash
npm install
npm --prefix functions install
npm run build:functions
npm run emulators
```

In another terminal, after the emulators are up:

```bash
npm run seed
npm run dev
```

Open http://127.0.0.1:5173. On the emulator, use a demo account. The buttons sign in through the Auth emulator with a Google credential, because the hub only accepts Google sign-in:

| Account | Email |
| --- | --- |
| Student | student@vsa.example.edu |
| Supervisor | supervisor@vsa.example.edu |
| Coordinator | coordinator@vsa.example.edu |

The Auth emulator still stores `ee-hub-demo` as the password for those accounts. Google sign-in is the production path: the signed-in email must match a staff or student record.

`npm test` checks phase cycles, milestone permissions, form answers, and ticket routing. `npm run schema` checks field names and that each table has its key. The audit log stays append-only, with no key.

## Import the existing spreadsheet

The Apps Script workbook is the database. `npm run import-sheet` reads that Google Sheet and writes the same tables into Firestore: cohorts, `COHORT: 2026` rosters, staff and students, phases, milestones, forms and `FORM: …` answers, tickets, messages, resources, and the audit log. Sheet dates are stored as `YYYY-MM-DD` or ISO timestamps. Emails are lowercased so they match Google sign-in.

Try it on the emulator first. Start `npm run emulators`, then in another terminal:

```bash
export GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=/path/to/service-account.json
npm run import-sheet -- "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" --dry-run
npm run import-sheet -- "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit"
npm run dev
```

Share the spreadsheet with the service account email (Viewer is enough). The same JSON used for Drive sync works when that account can read the sheet. If the variable is unset, the command uses application default credentials from `gcloud auth application-default login`.

`--dry-run` prints row counts and does not write. A real import replaces each collection that the workbook contains, including cohort members, ticket messages, and audit logs, so running it again does not duplicate rows. Collections whose tabs are missing are left as they are. Every `FORM:` tab is stored in one response collection, so the import keeps the answers from the form tabs that are present. `CONTENT_PAGES` rows are copied into resources when that resource id is not already there.

Sign-in still uses the email on `USERS-STAFF` or `USERS-STUDENTS`. The import does not create passwords. On the emulator, Google sign-in is the path for those real emails. The demo password buttons only exist for the seeded example accounts.

To load the same workbook into a live project after deploy:

```bash
npm run import-sheet -- "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" --production --project=YOUR_PROJECT_ID
```

That command uses the service account as Firebase Admin. Give that account the Cloud Datastore User role on the project. Leave `FIRESTORE_EMULATOR_HOST` unset.

## Deploy

Cloud Functions need the Blaze plan. The safest order is: import into the emulator and click through one student, one supervisor, and one coordinator, then deploy, then import into the live project.

1. Create a Firebase project and turn on Authentication → Google, and Firestore.
2. Add a web app. Put its config in `web/.env.production` (this file is not committed):

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
```

Do not set `VITE_USE_EMULATORS` for that build.

3. Create `functions/.env` with `EE_TIMEZONE=Asia/Hong_Kong`. Student Drive folders are not created by a service account. An Admin or Coordinator connects Google Drive in the cohort roster, and that Google account owns the folders and the copied EE documents. Enable the Google Drive API on the Firebase project, and keep the Google sign-in OAuth client internal to the school Workspace so the Drive scopes can be granted without a public verification review. The local demo can save a folder link and a template link; it cannot create Drive files. Email reminders use the same file; see Email notifications below.

The student page shows an EE folder card and an EE document card with word-count changes and an edit heatmap. That read uses the Google account of the person who has the page open (`https://www.googleapis.com/auth/drive.readonly`), not a service account and not the coordinator account that created the folder. The function checks that the Drive token belongs to the signed-in user, then reads only the EE document already saved on that student. If this person cannot open the document, the page says so. The access token is not stored. Daily word totals are kept in `docWordLogs` so a later visit can show the change. Add `https://www.googleapis.com/auth/drive.readonly` on the same internal OAuth client. A supervisor sees the heatmap when their own Google account can open that student's document. The local demo cannot read a Google Doc.

4. From this repo:

```bash
firebase login
firebase use --add
npm run build
npm run build:functions
firebase deploy
```

5. In Authentication → Settings → Authorized domains, include the Hosting domain Firebase prints after deploy.
6. Run the import command with `--production` and the same project id. The first sign-in is Google, using an email that is already on the staff or student tab.

Hosting serves the built web app. The callable is `eeHub`. Firestore rules deny all client writes, so the function and the import script are the only writers. Deploy also publishes `notificationSweep`.

## Email notifications

Coordinators own the cohort rules. Open Admin → Email notifications, or use Email notifications on the Phases & milestones editor. Each rule names a milestone, how many days before or after its due date to send, and whether the email goes to the milestone owner or only to coordinators and admins. The owner is the student when `milestoneTemplates.mOwner` is `student`, and the roster `supervisorId` when the owner is `supervisor`. Leads and coordinator-owned milestones go to staff with that flag. Supervisors can add an extra reminder for their own students from My Students → Email reminders. Staff browse is read-only.

Rules live in `notificationRules`. Supervisor overlays live in `notificationOverlays`. `notificationSends` records each send, keyed by rule, task, and trigger day, so the morning job does not repeat a reminder. Admin → Email notifications shows that log. A supervisor sees mail from their own reminders. When the student is one of the recipients, the same send is written to the audit log and appears in that student’s activity. Callable methods on `eeHub`: `listNotificationDesk`, `saveNotificationRule`, `deleteNotificationRule`, `setNotificationRuleEnabled`, `saveNotificationOverlay`, `deleteNotificationOverlay`, `setNotificationOverlayEnabled`, `previewNotificationSweep`, `previewNotificationRule`, `runNotificationSweep`, `sendNotificationRule`, and `sendNotificationTest`.

Sending uses the Gmail API with a service account and domain-wide delegation. It does not use SMTP. Add these to `functions/.env` (do not commit that file):

```bash
EE_TIMEZONE=Asia/Hong_Kong
EE_GMAIL_SENDER=ee-hub@school.edu
EE_GMAIL_SERVICE_ACCOUNT_JSON=/path/to/service-account.json
# EE_NOTIFICATIONS_DRY_RUN=true
```

`EE_GMAIL_SERVICE_ACCOUNT_JSON` may be the JSON itself or a path to the file. `EE_GMAIL_SENDER` is the Workspace user the job sends as. `EE_NOTIFICATIONS_DRY_RUN=true` writes a dry-run log and does not send. Leave it unset once Gmail is ready. The scheduled function is `notificationSweep` (07:15 in `EE_TIMEZONE`).

In Google Workspace admin, for that service account:

1. Enable the Gmail API on the Cloud project.
2. Turn on domain-wide delegation for the service account client id.
3. Authorize the scope `https://www.googleapis.com/auth/gmail.send`.

The sender must be a real user in that domain. Preview today does not send. Coordinators and admins can use Preview and send on one rule: it runs that rule’s check for today, shows each message, and emails only the ones they select. The rule has to be on, and Gmail has to be connected. Send test emails only the signed-in coordinator or supervisor.
