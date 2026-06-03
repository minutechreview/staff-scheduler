import { WEEK_DAYS, getWeekStartFriday, getWeekDates } from '../data/stores'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'

// Public holidays — update these dates to match your country/region.
// Override at runtime via Firestore: config/publicHolidays { dates: ['YYYY-MM-DD', ...] }
export const DEFAULT_HOLIDAYS = [
  // 2025 — example dates, replace with your locale's public holidays
  '2025-01-01', // New Year's Day
  '2025-12-25', // Christmas Day
  '2025-12-26', // Boxing Day
  // 2026
  '2026-01-01', // New Year's Day
  '2026-12-25', // Christmas Day
  '2026-12-26', // Boxing Day
]

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isFriday(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay() === 5
}

export function validateLeaveDates(startDate, endDate) {
  if (!startDate || !endDate) return 'Please select both start and end dates.'
  if (isFriday(startDate)) return 'Start date cannot be a Friday.'
  if (isFriday(endDate)) return 'End date cannot be a Friday.'
  if (endDate < startDate) return 'End date must be on or after start date.'
  return null
}

// Count billable leave days (excluding Fridays and public holidays)
export function countLeaveDays(startDate, endDate, holidays = []) {
  const phSet = new Set(holidays)
  let count = 0
  const current = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (current <= end) {
    const iso = toISO(current)
    if (current.getDay() !== 5 && !phSet.has(iso)) count++
    current.setDate(current.getDate() + 1)
  }
  return count
}

// Build { weekStart: [dayName, ...] } for all billable days in the range
function getLeaveWeekMap(startDate, endDate, holidays = []) {
  const phSet = new Set(holidays)
  const map = {}
  const current = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (current <= end) {
    const iso = toISO(current)
    if (current.getDay() !== 5 && !phSet.has(iso)) {
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

// Write 'Leave' shifts to schedule for every billable day in the range
export async function applyLeaveToSchedule(staffId, storeId, startDate, endDate, holidays = []) {
  const weekMap = getLeaveWeekMap(startDate, endDate, holidays)
  for (const [weekStart, dayNames] of Object.entries(weekMap)) {
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStart)
    const snap = await getDoc(docRef)
    const data = snap.exists() ? snap.data() : {}
    const entries = { ...(data.entries || {}) }
    const staffEntry = { ...(entries[staffId] || {}) }
    for (const dayName of dayNames) staffEntry[dayName] = 'Leave'
    entries[staffId] = staffEntry
    await setDoc(docRef, { ...data, entries, storeId, weekStartDate: weekStart }, { merge: true })
  }
}

// Clear 'Leave' shifts (only days still marked Leave to avoid overwriting manual changes)
export async function removeLeaveFromSchedule(staffId, storeId, startDate, endDate, holidays = []) {
  const weekMap = getLeaveWeekMap(startDate, endDate, holidays)
  for (const [weekStart, dayNames] of Object.entries(weekMap)) {
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStart)
    const snap = await getDoc(docRef)
    if (!snap.exists()) continue
    const data = snap.data()
    const entries = { ...(data.entries || {}) }
    const staffEntry = { ...(entries[staffId] || {}) }
    for (const dayName of dayNames) {
      if (staffEntry[dayName] === 'Leave') staffEntry[dayName] = ''
    }
    entries[staffId] = staffEntry
    await setDoc(docRef, { ...data, entries }, { merge: true })
  }
}
