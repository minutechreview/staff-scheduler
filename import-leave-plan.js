// import-leave-plan.js
// Reads a filled Annual Leave Plan Excel and migrates leave data to Firestore:
//   1. Creates leavePlans documents (deterministic IDs — safe to re-run)
//   2. Updates leaveBalances (used/remaining) per employee
//   3. Writes 'Leave' shifts to schedule week documents
//
// Usage:
//   node import-leave-plan.js /path/to/Annual_Leave_Plan.xlsx
//   node import-leave-plan.js /path/to/file.xlsx --dry-run
//
// Requirements:
//   - Copy .env.example to .env and fill in your Firebase credentials
//   - Install dependencies: npm install firebase dotenv xlsx

import 'dotenv/config'
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore'
import { readFile } from 'fs/promises'
import { read, utils } from 'xlsx'

// ── Firebase ───────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

// ── Public holidays ────────────────────────────────────────────────────────────
// Update these dates to match your country/region's public holidays.
// Override at runtime via Firestore: config/publicHolidays { dates: [...] }
const PUBLIC_HOLIDAYS = new Set([
  '2026-01-01', // New Year's Day
  '2026-12-25', // Christmas Day
  '2026-12-26', // Boxing Day
])

const ANNUAL_ENTITLEMENT = 30
const YEAR = new Date().getFullYear()

// ── Helpers ────────────────────────────────────────────────────────────────────
function toISO(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDate(value) {
  if (!value) return null
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null
    return toISO(value)
  }
  if (typeof value === 'number') return toISO(utils.numToDate(value))
  if (typeof value === 'string') {
    const s = value.trim()
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    if (/^\d{5}$/.test(s)) return toISO(utils.numToDate(Number(s)))
  }
  return null
}

function nameToStaffId(name) {
  return String(name).trim().replace(/\s+/g, '_').replace(/'/g, '').toLowerCase().slice(0, 30)
}

function getWeekStartFriday(date) {
  const d = new Date(date)
  const daysFromFriday = (d.getDay() + 2) % 7
  d.setDate(d.getDate() - daysFromFriday)
  return toISO(d)
}

function getWeekDates(fridayISO) {
  const friday = new Date(fridayISO + 'T00:00:00')
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(friday)
    d.setDate(friday.getDate() + i)
    return toISO(d)
  })
}

const WEEK_DAYS = ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU']

function buildWeekMap(startDate, endDate) {
  const map = {}
  const current = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (current <= end) {
    const iso = toISO(current)
    if (current.getDay() !== 5 && !PUBLIC_HOLIDAYS.has(iso)) {
      const weekStart = getWeekStartFriday(current)
      const weekDates = getWeekDates(weekStart)
      const dayName = WEEK_DAYS[weekDates.indexOf(iso)]
      if (dayName) {
        if (!map[weekStart]) map[weekStart] = []
        map[weekStart].push(dayName)
      }
    }
    current.setDate(current.getDate() + 1)
  }
  return map
}

function countLeaveDays(startDate, endDate) {
  const weekMap = buildWeekMap(startDate, endDate)
  return Object.values(weekMap).reduce((sum, days) => sum + days.length, 0)
}

async function applyLeaveToSchedule(staffId, storeId, startDate, endDate, dryRun) {
  const weekMap = buildWeekMap(startDate, endDate)
  let weeksWritten = 0
  for (const [weekStart, dayNames] of Object.entries(weekMap)) {
    if (dryRun) {
      console.log(`    [dry-run] schedule ${storeId}/${staffId} week ${weekStart}: ${dayNames.join(', ')} -> Leave`)
      weeksWritten++
      continue
    }
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStart)
    const snap = await getDoc(docRef)
    const data = snap.exists() ? snap.data() : {}
    const entries = { ...(data.entries || {}) }
    const staffEntry = { ...(entries[staffId] || {}) }
    for (const dayName of dayNames) staffEntry[dayName] = 'Leave'
    entries[staffId] = staffEntry
    await setDoc(docRef, { ...data, entries, storeId, weekStartDate: weekStart }, { merge: true })
    weeksWritten++
  }
  return weeksWritten
}

async function deductLeaveBalance(staffId, staffName, storeId, daysCount, dryRun) {
  const balanceDocId = `${YEAR}_${staffId}`
  const ref = doc(db, 'leaveBalances', balanceDocId)
  if (dryRun) {
    console.log(`    [dry-run] leaveBalances/${balanceDocId}: deduct ${daysCount} days`)
    return
  }
  const snap = await getDoc(ref)
  if (snap.exists()) {
    const bal = snap.data()
    await setDoc(ref, {
      ...bal,
      staffName,
      storeId,
      used: (bal.used || 0) + daysCount,
      remaining: (bal.remaining ?? bal.totalBalance) - daysCount,
    }, { merge: true })
  } else {
    await setDoc(ref, {
      staffId, staffName, storeId,
      year: YEAR,
      annualEntitlement: ANNUAL_ENTITLEMENT,
      carryForward: 0,
      totalBalance: ANNUAL_ENTITLEMENT,
      used: daysCount,
      remaining: ANNUAL_ENTITLEMENT - daysCount,
    })
  }
}

async function createLeavePlan(staffId, staffName, storeId, startDate, endDate, daysCount, note, dryRun) {
  const planDocId = `import_${staffId}_${startDate}_${endDate}`
  const ref = doc(db, 'leavePlans', planDocId)
  if (dryRun) {
    console.log(`    [dry-run] leavePlans/${planDocId}: ${staffName} ${startDate}->${endDate} (${daysCount}d)`)
    return true
  }
  const snap = await getDoc(ref)
  if (snap.exists()) return false
  await setDoc(ref, {
    staffId, staffName, storeId,
    year: YEAR,
    startDate, endDate,
    daysCount,
    note: note || '',
    createdAt: new Date().toISOString(),
    importedFromExcel: true,
  })
  return true
}

// ── Main ───────────────────────────────────────────────────────────────────────
const [, , filePath, flag] = process.argv
const DRY_RUN = flag === '--dry-run'

if (!filePath) {
  console.error('Usage: node import-leave-plan.js <path-to-excel> [--dry-run]')
  process.exit(1)
}

console.log(`\nAnnual Leave Import ${DRY_RUN ? '(DRY RUN)' : ''}`)
console.log(`   File: ${filePath}\n`)

const buf = await readFile(filePath)
const wb = read(buf, { type: 'buffer', cellDates: true })

// Update the sheet name to match your Excel file's tab name
const SHEET_NAME = 'Annual Leave Plan'
const ws = wb.Sheets[SHEET_NAME]

if (!ws) {
  console.error(`Sheet "${SHEET_NAME}" not found.`)
  console.error('Available sheets:', wb.SheetNames.join(', '))
  process.exit(1)
}

// Expected columns (0-indexed):
//  0=#  1=Name  2=EmpNo  3=Store  4=StoreID
//  5=L1Start  6=L1End  7=L1Days
//  8=L2Start  9=L2End  10=L2Days
//  11=L3Start  12=L3End  13=L3Days
//  14=Total  15=Notes
const rows = utils.sheet_to_json(ws, { header: 1, defval: null, raw: false, cellDates: true })

let totalEmployees = 0
let totalBlocks = 0
let skippedBlocks = 0
let skippedRows = 0

for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  if (!row || row[0] === null || row[0] === undefined) continue
  const rowNum = parseInt(row[0], 10)
  if (isNaN(rowNum) || i < 3) continue

  const name = row[1] ? String(row[1]).trim() : null
  if (!name) { skippedRows++; continue }

  const storeId = row[4] ? String(row[4]).trim() : null
  if (!storeId) { skippedRows++; continue }

  const staffId = nameToStaffId(name)
  const note = row[15] ? String(row[15]).trim() : ''

  const blocks = [
    { start: row[5], end: row[6] },
    { start: row[8], end: row[9] },
    { start: row[11], end: row[12] },
  ]

  let employeeHasBlock = false
  for (const { start, end } of blocks) {
    const s = parseDate(start)
    const e = parseDate(end)
    if (!s || !e) continue
    if (e < s) {
      console.warn(`  Warning: ${name} (${storeId}): end ${e} before start ${s} — skipping block`)
      continue
    }

    const daysCount = countLeaveDays(s, e)
    if (daysCount === 0) {
      console.warn(`  Warning: ${name} (${storeId}): ${s}->${e} has 0 working days — skipping`)
      continue
    }

    console.log(`  + ${name} [${storeId}] -> ${s} to ${e} (${daysCount} days)`)

    const isNew = await createLeavePlan(staffId, name, storeId, s, e, daysCount, note, DRY_RUN)
    if (isNew) {
      await deductLeaveBalance(staffId, name, storeId, daysCount, DRY_RUN)
      const weeks = await applyLeaveToSchedule(staffId, storeId, s, e, DRY_RUN)
      console.log(`    ${weeks} week(s) written to schedule`)
      totalBlocks++
      employeeHasBlock = true
    } else {
      console.log(`    Already imported — skipping`)
      skippedBlocks++
    }
  }

  if (employeeHasBlock) totalEmployees++
}

console.log(`\nDone.`)
console.log(`   Employees processed : ${totalEmployees}`)
console.log(`   Leave blocks applied: ${totalBlocks}`)
if (skippedBlocks > 0) console.log(`   Blocks already existed (skipped): ${skippedBlocks}`)
if (skippedRows > 0) console.log(`   Rows skipped (no name/store): ${skippedRows}`)
if (DRY_RUN) console.log('\n   Dry run — nothing written to Firebase.')

process.exit(0)
