# Retail Staff Scheduler

An open-source web application for managing weekly staff schedules across multiple retail locations. Built with React, Vite, Tailwind CSS v4, and Firebase Firestore.

## Features

- **Multi-store overview** — see headcount, SIC coverage, and schedule status for all stores at a glance
- **Weekly schedule grid** — click or drag cells to assign shifts; multi-select with Ctrl/Cmd+click
- **Shift types** — AM, PM, Mid, GY, Day Off, Leave, Support, Activity, LOP
- **Store categories** — Regular (8h), Office 12h, Office 10h, Office 8h, each with different days-off rules
- **SIC (Shift In Charge) validation** — automatic warnings when a shift has no qualified SIC
- **Support pool** — manage floating staff assigned across stores for the week
- **Leave management** — plan and track annual leave with carry-forward balances
- **Leave calendar** — weekly, monthly, and yearly leave visualization
- **Analytics dashboard** — 12-week trends for leave, support, and SIC coverage
- **Global staff search** — find any staff member across all stores instantly
- **PDF export** — printable weekly schedule in landscape A4
- **Excel import** — bulk-import schedules and rosters from spreadsheets
- **Dark/light theme** — system-aware with manual toggle
- **In-app feedback** — floating feedback button, saves to Firestore and optionally notifies via Telegram
- **Onboarding tour** — guided first-time setup for new users
- **Role-based access** — Store Manager (SM), District Manager (DM), Admin

## Tech Stack

- **Frontend:** React 19, Vite 8, Tailwind CSS v4
- **Backend:** Firebase Firestore (real-time sync), Firebase Hosting, Firebase Cloud Functions (optional)
- **Auth:** Firebase email-based login
- **PDF:** jsPDF + jspdf-autotable
- **Excel:** SheetJS (xlsx)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/your-github-org/staff-scheduler.git
cd staff-scheduler
npm install
```

### 2. Create a Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com) and create a new project
2. Enable **Firestore Database** (start in production mode)
3. Register a **Web app** to get your config keys
4. Set up **Authentication** (Email/Password provider)

### 3. Configure environment

```bash
cp .env.example .env
# Fill in your Firebase project credentials in .env
```

See `.env.example` for all available variables and their descriptions.

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

### 5. Build for production

```bash
npm run build
firebase deploy
```

## Configuration

### Stores

The default store list in `src/data/stores.js` contains example placeholder stores. Replace these with your actual store data, or use the in-app **Settings > Stores** panel to configure stores per AOR via Firestore.

### Store Categories

| Category | Shifts/week | Days off | Weekend |
|----------|-------------|----------|---------|
| `regular` | 6 x 8h | 1 | Works |
| `office-12h` | 4 x 12h | 3 | Closed |
| `office-10h` | 5 x 10h | 2 (Fri+Sat) | Closed |
| `office-8h` | 5 x 8h + 1 Support | 1 | Support only |

### Week Start Day

The week starts on **Friday** by default (configurable in `src/data/stores.js` via the `WEEK_DAYS` and `getWeekStartFriday` exports).

### Public Holidays

Default placeholder holidays are defined in `src/utils/leaveUtils.js` (`DEFAULT_HOLIDAYS`). Replace with your locale's actual public holiday dates. These can also be overridden at runtime via Firestore: `config/publicHolidays { dates: ['YYYY-MM-DD', ...] }`.

### Domain Restriction

To restrict login to a specific email domain, uncomment and update the line in `src/firebase.js`:

```js
googleProvider.setCustomParameters({ hd: 'your-company.com' })
```

And in `src/hooks/useAuth.js`:

```js
if (!firebaseUser.email?.endsWith('@your-company.com')) {
  signOut(auth)
  setAuthError('Access is restricted to @your-company.com accounts only.')
  ...
}
```

### Role Pre-assignment

To auto-assign DM or Admin roles to specific email addresses during onboarding, set in your `.env`:

```
VITE_DM_EMAIL=dm@your-company.com
VITE_ADMIN_EMAIL=admin@your-company.com
```

## Data Import

### Seed staff data

Edit `seed-staff.js` with your store IDs and staff list, then:

```bash
node seed-staff.js
```

### Import leave plans from Excel

```bash
node import-leave-plan.js /path/to/Annual_Leave_Plan.xlsx
node import-leave-plan.js /path/to/file.xlsx --dry-run  # preview without writing
```

Expected sheet format: columns for Name, EmpNo, Store, StoreID, and up to 3 leave date ranges per employee.

## Firebase Cloud Functions (Optional)

The `functions/` directory contains a welcome email function that triggers when a new user document is created in Firestore.

```bash
cd functions
npm install
firebase deploy --only functions
```

Configure SMTP credentials via Firebase secrets:

```bash
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
```

## Firestore Structure

```
stores/{storeId}                         — store metadata
stores/{storeId}/roster/{id}             — staff members
schedules/{storeId}/weeks/{weekStart}    — weekly schedule data
leavePlans/{id}                          — leave plan records
leaveBalances/{year_staffId}             — leave balance tracking
config/storeSettings                     — per-store headcount overrides
config/publicHolidays                    — holiday date list override
users/{email}                            — user profiles (role, aorId, storeId)
feedback/{id}                            — in-app feedback submissions
```

## Firestore Security Rules

Review and customize `firestore.rules` before deploying to production. The default rules require authentication for all reads and writes.

## Branding

- Replace `public/logo.png` and `src/assets/logo.png` with your company logo (PNG recommended)
- Update the brand color `#006241` in `src/index.css` and `src/utils/pdfExport.js`
- Update the app name in `index.html` and the subtitle in `src/components/LoginPage.jsx`

## License

MIT
