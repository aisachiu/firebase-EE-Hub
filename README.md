# Firebase EE Hub

Firebase version of the [VSA Extended Essay hub](https://github.com/aisachiu/GAS-EE-Hub). The screens are the same. Records live in Firestore, sign-in is Firebase Auth, and the Apps Script calls are one Cloud Function named `eeHub`.

Students see Document, Journey, and Supervisor. Published resources sit on Journey as research support, and `/resources` opens that module. Staff see My Students, resources, messages, and notes. Coordinators and admins also see Admin. Milestone ownership, phase prerequisites, tickets, and milestone forms are enforced in the function. The browser cannot write Firestore directly.

## Web app

The browser UI is a Vite app in `web/`. `web/index.html` is the shell. Screens live in ES modules under `web/src/`. `web/src/main.js` owns Firebase Auth and `window.eeCall`. View modules call that. They do not talk to Cloud Functions on their own.

| Folder | Owns |
| --- | --- |
| `web/src/shell.js` | Top bar, role tabs, sign-in |
| `web/src/router.js` | Path matching, history, role guards |
| `web/src/styles/` | CSS |
| `web/src/shared/` | API helper, HTML escaping, tables, checks, forms, resources, messages |
| `web/src/student/` | Document, Journey, and Supervisor views, modules, activity, milestone editing |
| `web/src/staff/` | My Students, messages, notes |
| `web/src/admin/` | Cohorts, sheets, students, pathway, email, student tasks, users, subjects, forms, resources, FAQs |
| `web/src/allocation/` | Allocation desk, cohort tokens, settings |

One change should stay inside the `web/src/<area>/` folder that owns the screen. Shared widgets (sortable tables, name filters, multi-select, checks) belong in `web/src/shared/`.

Navigation uses the History API. Refresh, share, and back/forward reopen the same screen. A role that cannot open a path is sent to that role’s home. No error is shown. `/` does the same. Unknown paths do too.

| Path | Who | Screen |
| --- | --- | --- |
| `/` | any signed-in role | That role’s home. Students land on Journey |
| `/document` | student | Document. `/doc` and `/my-ee` open this too |
| `/journey` | student | Journey |
| `/supervisor` | student | Supervisor. `/help` opens this too |
| `/resources` | student | Journey, scrolled to research support |
| `/resources` | staff | Resources |
| `/my-students` | staff | My Students |
| `/messages` | supervisor or coordinator | Messages |
| `/notes` | supervisor or coordinator | Notes |
| `/allocation` | coordinator | Allocation dashboard |
| `/allocation/tokens` | coordinator | Cohort tokens |
| `/allocation/settings` | coordinator | Allocation settings |
| `/admin` | coordinator | Cohorts (canonical `/admin/cohorts`) |
| `/admin/cohorts` | coordinator | Cohorts |
| `/admin/google` | coordinator | Google account |
| `/admin/sheets` | coordinator | Sheets |
| `/admin/students` | coordinator | Students in cohorts |
| `/admin/pathway` | coordinator | Phases & milestones |
| `/admin/email` | coordinator | Email notifications |
| `/admin/student-tasks` | coordinator | Student Tasks. `/admin/assignments` opens this too |
| `/admin/student-users` | coordinator | Student users |
| `/admin/staff-users` | coordinator | Staff users |
| `/admin/quotas` | coordinator | EE quotas |
| `/admin/subjects` | coordinator | Subjects |
| `/admin/forms` | coordinator | Milestone forms |
| `/admin/resources` | coordinator | Resource records |
| `/admin/faqs` | coordinator | FAQs |
| `/admin/categories` | coordinator | Message categories |

`/admin/allocation-settings` opens Allocation settings. The address bar becomes `/allocation/settings`. Messages are hidden while Acting as is Staff browse. Allocation and Admin require a coordinator or admin.

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

Share the spreadsheet with the account that will read it (Viewer is enough). If `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` or `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` is set, the command uses that service account. This local import is separate from the Cloud Function OAuth user. If the variable is unset, the command uses application default credentials from `gcloud auth application-default login`.

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

3. Create `functions/.env` with `EE_TIMEZONE=Asia/Hong_Kong`. Drive folders, copied EE documents, spreadsheet export, and essay edit history all use one Workspace account (for VSA, `sec-ict@vsa.edu.hk`). The function signs in as that account with an OAuth refresh token stored in Secret Manager (see Connect Google). Students and staff are never asked to connect Google. Enable the Google Drive API, Google Sheets API, and Gmail API on the Firebase project. The local demo can save a folder or template link; it cannot create or read Drive files until the refresh token is set. Email reminders use the same token; see Email notifications below.

The student page shows an EE folder card and an EE document card with word-count changes and an edit heatmap. The heatmap uses the connected account (`https://www.googleapis.com/auth/drive`). The signed-in student or supervisor is not asked for a Drive scope. The file id is the EE document already saved on that student. If the connected account cannot open the document, the page says so. No access token is stored. Daily word totals are kept in `docWordLogs` so a later visit can show the change. The local demo cannot read a Google Doc until the OAuth refresh token is configured.

### Connect Google (Drive + Sheets + Gmail)

In Google Cloud Console, on the same project:

1. APIs & Services → OAuth consent screen. User type **Internal** (Workspace users only). Add these scopes:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/gmail.send`
2. Create an OAuth client. A **Desktop** client can use the loopback redirect below. A **Web** client must list that exact URI as an authorized redirect.
3. Sign in once as the school mailbox (the account that should own folders, spreadsheets, and outgoing mail) and mint a refresh token:

```bash
export EE_GOOGLE_OAUTH_CLIENT_ID=YOUR_CLIENT_ID
export EE_GOOGLE_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET
# optional; this is the default
# export EE_GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:8765/oauth/callback
npm run mint-google-oauth
```

`npm run mint-google-oauth` stays on your machine. It prints a consent URL, listens on `http://127.0.0.1:8765/oauth/callback`, and prints the refresh token. It does not write `functions/.env`. If you already have an authorization code, run `npm run mint-google-oauth -- --code=THE_CODE`. Google returns a refresh token only on the first consent with `prompt=consent`. If it does not, revoke the app at https://myaccount.google.com/permissions and run the script again.

Store the client id, client secret, and refresh token in Secret Manager. `eeHub` and `notificationSweep` both bind those three secrets. `EE_TIMEZONE` stays in `functions/.env`.

```bash
firebase functions:secrets:set EE_GOOGLE_OAUTH_CLIENT_ID
firebase functions:secrets:set EE_GOOGLE_OAUTH_CLIENT_SECRET
firebase functions:secrets:set EE_GOOGLE_OAUTH_REFRESH_TOKEN
```

Each command prompts for the value. Paste only the value after `=` from the mint script, not the `NAME=value` line. Deploy both functions, then remove the OAuth keys from `functions/.env`:

```bash
firebase deploy --only functions:eeHub,functions:notificationSweep
```

Delete `EE_GOOGLE_OAUTH_CLIENT_ID`, `EE_GOOGLE_OAUTH_CLIENT_SECRET`, and `EE_GOOGLE_OAUTH_REFRESH_TOKEN` from `functions/.env`. Leave `EE_TIMEZONE`. If those keys are already in the file, delete them before the deploy above. Cloud Run rejects a function that sets the same name as both a plain environment variable and a secret (`Secret environment variable overlaps non secret environment variable`). A deploy that still loads the refresh token from `functions/.env` can replace the live token with a stale copy. After the keys are gone, later deploys cannot do that.

To remint, run `npm run mint-google-oauth` again, then `firebase functions:secrets:set EE_GOOGLE_OAUTH_REFRESH_TOKEN` with the new token, then redeploy `eeHub` and `notificationSweep`. The new version is not live until that deploy. Do not rely on `functions/.env` for the refresh token.

The redirect URI is only for the local mint script. The default is `http://127.0.0.1:8765/oauth/callback`. The emulator does not mount Secret Manager unless you give it the values: export the same three names in the shell that starts the emulator, or put them in gitignored `functions/.secret.local` (or `functions/.env.local`). Do not put them in `functions/.env`.

Open Admin → Google account and choose **Check connection**. The page shows the mailbox on the refresh token. It does not ask for a different account, and it does not store the token in Firestore. Domain-wide delegation is not used. `EE_DRIVE_SERVICE_ACCOUNT_JSON`, `EE_GMAIL_SERVICE_ACCOUNT_JSON`, and `EE_GMAIL_SENDER` are ignored.

The cohort folder must be somewhere that connected account can edit. Existing folders owned by a personal My Drive are left where they are.

Admin → Sheets exports the collections an admin or coordinator selects into a spreadsheet owned by that same account, and shares it with the person who exported it. Phases, milestones, cohorts, and student lists are selected by default. Ingest reads a Google Sheet link and replaces only the selected collections whose tabs are present. A missing tab is left unchanged. Rows that are not in a selected tab are removed, after a preview and a confirmation. Audit logs can be exported and are not written back. Email logs and word-count samples are not part of this sheet. The Sheets scope on the same refresh token is what the Sheets API uses. The local demo can open the page and cannot create a spreadsheet until the refresh token is configured. The command-line `import-sheet` path is unchanged.

Coordinators open Allocation to draft a supervisor and subject for each active student. Slots are individual tokens. A tab named `SUPERVISORTOKENS: 2026` has StaffEmail, Quota, and EligibleSubjects. Ingest adds missing tokens and leaves draft or committed slots as they are. Admin → Staff users → EE quotas edits the standing quota and `EESubjects` on each staff record, shows overlapped subject capacity, and can export that `SUPERVISORTOKENS` sheet or apply the same top-up into a cohort. Allocation → Cohort tokens edits the tokens already on a cohort. A tab named `COHORTDATA: 2026` has StudentId, an optional SubjectChoice JSON cell, columns that start with `Choice_`, and any other column the dashboard can show. Publish writes the drafted supervisor and subject onto that student's roster row. Students with Active for allocation unchecked stay off the dashboard. Allocation settings, on that tab and under Admin, choose the choice keys and columns.

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

## Supervisor To Do

On My Students, a supervisor sees Supervisor To Do. It lists the milestones that supervisor owns and still has to attend to. The next milestone for each student is in that same list, marked Next, along with any later open milestone they own. The supervisor switches that list between By due date (earliest first) and Group by student. Student groups follow the most urgent item, and students with no due date follow display name. Items in a group follow the due date. A lead or coordinator can add a to-do for a supervisor. Those added to-dos appear in the same list. Leads and coordinators open Supervisor to-dos on My Students to see every supervisor in the cohort, with that supervisor's milestones and to-dos, and to add one. Added to-dos are stored in `supervisorTodos`. Callable methods: `getSupervisorTodoDesk`, `addSupervisorTodo`, `setSupervisorTodoStatus`, and `deleteSupervisorTodo`.

## Email notifications

Coordinators own the cohort rules. Open Admin → Email notifications, or use Email notifications on the Phases & milestones editor. Each rule names a milestone, how many days before or after its due date to send, and whether the email goes to the milestone owner or only to coordinators and admins. The owner is the student when `milestoneTemplates.mOwner` is `student`, and the roster `supervisorId` when the owner is `supervisor`. Leads and coordinator-owned milestones go to staff with that flag. Supervisors can add an extra reminder for their own students from My Students → Email reminders. Staff browse is read-only.

Rules live in `notificationRules`. Supervisor overlays live in `notificationOverlays`. `notificationSends` records each send, keyed by rule, task, and trigger day, so the morning job does not repeat a reminder. Admin → Email notifications shows that log. A supervisor sees mail from their own reminders. When the student is one of the recipients, the same send is written to the audit log and appears in that student’s activity. Callable methods on `eeHub`: `listNotificationDesk`, `saveNotificationRule`, `deleteNotificationRule`, `setNotificationRuleEnabled`, `saveNotificationOverlay`, `deleteNotificationOverlay`, `setNotificationOverlayEnabled`, `previewNotificationSweep`, `previewNotificationRule`, `runNotificationSweep`, `sendNotificationRule`, and `sendNotificationTest`.

Sending uses the Gmail API as the connected Google account. It does not use SMTP, and it does not use a service account. The same Secret Manager refresh token from Connect Google above is enough. Add this to `functions/.env` (do not commit that file):

```bash
EE_TIMEZONE=Asia/Hong_Kong
# EE_NOTIFICATIONS_DRY_RUN=true
```

`EE_NOTIFICATIONS_DRY_RUN=true` writes a dry-run log and does not send. Leave it unset once Gmail is ready. The scheduled function is `notificationSweep` (07:15 in `EE_TIMEZONE`). Mail is sent as the mailbox on the refresh token (`userId: me`). Confirm that address in Admin → Google account after deploy.

Preview today does not send. Coordinators and admins can use Preview and send on one rule: it runs that rule’s check for today, shows each message, and emails only the ones they select. The rule has to be on, and Google has to be connected. Send test emails only the signed-in coordinator or supervisor.
