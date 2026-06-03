import { WEEK_DAYS, getWeekDates } from '../data/stores'
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import { countLeaveDays } from './leaveUtils'

// ── Fetch ──────────────────────────────────────────────────────────────────────

/**
 * Fetch all schedule week entries for a store in the given year.
 * Returns { [weekStartDate]: { [staffId]: { FRI, SAT, ... } } }
 */
export async function fetchStoreYearSchedule(storeId, year) {
  const weeksRef = collection(db, 'schedules', storeId, 'weeks')
  const snap = await getDocs(weeksRef)
  const schedule = {}
  snap.docs.forEach((d) => {
    // Include weeks that start in the target year
    if (d.id.startsWith(String(year))) {
      schedule[d.id] = d.data().entries || {}
    }
  })
  return schedule
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Collect all ISO calendar dates where staffId has a 'Leave' shift in the year schedule.
 */
function collectLeaveDates(staffId, yearSchedule) {
  const dates = []
  for (const [weekStart, entries] of Object.entries(yearSchedule)) {
    const staffEntry = entries[staffId]
    if (!staffEntry) continue
    const weekDates = getWeekDates(weekStart) // index matches WEEK_DAYS order
    WEEK_DAYS.forEach((day, i) => {
      if (staffEntry[day] === 'Leave') {
        dates.push(weekDates[i])
      }
    })
  }
  return dates.sort()
}

/**
 * Group a sorted array of ISO date strings into date ranges.
 * Adjacent dates separated by 1 day are consecutive.
 * A 2-day gap is allowed to bridge Fridays (Thu→Sat) within the same leave block.
 */
function groupIntoRanges(sortedDates) {
  if (sortedDates.length === 0) return []
  const ranges = []
  let rangeStart = sortedDates[0]
  let rangeEnd = sortedDates[0]

  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(rangeEnd + 'T00:00:00')
    const curr = new Date(sortedDates[i] + 'T00:00:00')
    const gapDays = Math.round((curr - prev) / 86400000)
    // gap === 1 → consecutive; gap === 2 → Friday bridged (Thu→Sat)
    if (gapDays <= 2) {
      rangeEnd = sortedDates[i]
    } else {
      ranges.push({ startDate: rangeStart, endDate: rangeEnd })
      rangeStart = sortedDates[i]
      rangeEnd = sortedDates[i]
    }
  }
  ranges.push({ startDate: rangeStart, endDate: rangeEnd })
  return ranges
}

/**
 * Return true if the given [startDate, endDate] range is fully covered by an existing plan.
 */
function isCoveredByPlan(startDate, endDate, plans) {
  return plans.some((p) => p.startDate <= startDate && p.endDate >= endDate)
}

/**
 * Detect leave date ranges found in the schedule that are not backed by any leave plan.
 * @param {string}   staffId       - Staff member ID
 * @param {object[]} existingPlans - All plans for this staff member
 * @param {object}   yearSchedule  - Output of fetchStoreYearSchedule
 * @returns {{ startDate: string, endDate: string }[]}
 */
export function detectOrphanedLeave(staffId, existingPlans, yearSchedule) {
  const leaveDates = collectLeaveDates(staffId, yearSchedule)
  const ranges = groupIntoRanges(leaveDates)
  return ranges.filter((r) => !isCoveredByPlan(r.startDate, r.endDate, existingPlans))
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Create auto-plan docs for orphaned leave ranges and deduct from balance.
 * Idempotent — uses a deterministic doc ID so double-runs are safe.
 *
 * @param {string}   staffId        - Staff member ID
 * @param {string}   staffName      - Display name
 * @param {string}   storeId        - Store ID
 * @param {{ startDate, endDate }[]} orphanedRanges
 * @param {string[]} holidays       - Public holidays list
 * @param {Function} deductFn       - async (staffId, staffName, days) => void
 * @returns {object[]} - newly created plan records
 */
export async function syncOrphanedLeave(
  staffId, staffName, storeId, orphanedRanges, holidays, deductFn
) {
  const year = new Date().getFullYear()
  const created = []

  for (const { startDate, endDate } of orphanedRanges) {
    const docId = `auto_${staffId}_${startDate}_${endDate}`
    const ref = doc(db, 'leavePlans', docId)
    const snap = await getDoc(ref)
    if (snap.exists()) continue // already synced

    const daysCount = countLeaveDays(startDate, endDate, holidays)
    const planData = {
      staffId, staffName, storeId, year,
      startDate, endDate, daysCount,
      note: 'Auto-synced from schedule',
      createdAt: new Date().toISOString(),
      autoSynced: true,
    }
    await setDoc(ref, planData)
    await deductFn(staffId, staffName, daysCount)
    created.push({ id: docId, ...planData })
  }

  return created
}
