// schedulingAssistant.js — Pure rule-based scheduling logic
// No Firebase, no React. All functions accept data as plain parameters.

import { WEEK_DAYS, WEEKEND_DAYS, SIC_POSITIONS, DAYS_OFF_REQUIRED, STORES } from '../data/stores'

// ---------------------------------------------------------------------------
// computeShortfalls
// Returns all day/shift combinations where headcount is below store minimum.
// Only checks AM Shift and PM Shift (the two required shift types).
// ---------------------------------------------------------------------------
// visitors: the visitors map from useSchedule ({ [staffId]: { supportDays: [...] } })
// Visitors who have the day in their supportDays count toward filling headcount shortfalls.
export function computeShortfalls(store, staff, scheduleEntries, visitors = {}) {
  const shortfalls = []
  for (const day of WEEK_DAYS) {
    const am = staff.filter((s) => {
      const v = scheduleEntries[s.id]?.[day]
      return v === 'AM Shift' || v === 'AM 8h'
    }).length
    const pm = staff.filter((s) => scheduleEntries[s.id]?.[day] === 'PM Shift').length

    // Count support-in visitors present on this day
    const visitorCount = Object.values(visitors).filter(
      (v) => v.supportDays?.includes(day)
    ).length

    // Visitors fill whichever shift type is shortest first (AM priority)
    const amShort = Math.max(0, store.minAM - am)
    const visitorFillsAM = Math.min(visitorCount, amShort)
    const visitorFillsPM = visitorCount - visitorFillsAM

    const effectiveAM = am + visitorFillsAM
    const effectivePM = pm + visitorFillsPM

    if (effectiveAM < store.minAM) {
      shortfalls.push({ day, shiftType: 'AM Shift', current: effectiveAM, required: store.minAM, short: store.minAM - effectiveAM })
    }
    if (effectivePM < store.minPM) {
      shortfalls.push({ day, shiftType: 'PM Shift', current: effectivePM, required: store.minPM, short: store.minPM - effectivePM })
    }
  }
  return shortfalls
}

// ---------------------------------------------------------------------------
// isWeekBlank
// Returns true only when no WEEK_DAYS shift value is set for any staff member.
// Ignores remarks and _dest/_activity/_dm_auth suffix keys.
// ---------------------------------------------------------------------------
export function isWeekBlank(staff, scheduleEntries) {
  for (const s of staff) {
    const entry = scheduleEntries[s.id] || {}
    for (const day of WEEK_DAYS) {
      if (entry[day]) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// getAvailableStaffForDay
// Given the full cross-store summary (from fetchAllStoresSummary with includeRoster),
// returns staff available to support on a given day, grouped by their home store.
// Returns staff who are either SURPLUS at their home store on the given day,
// or hold an SIC position (SM/ASM/SSV/TSSV/SIC) — since they may be needed
// to fill a SIC coverage gap even if their store isn't over the minimum.
// Staff on Day Off / Leave / LOP / Support / Activity are always excluded.
// ---------------------------------------------------------------------------
export function getAvailableStaffForDay(day, allStoresSummary, excludeStoreId) {
  const BLOCKED = new Set(['Day Off', 'Leave', 'LOP', 'Support', 'Activity'])
  const result = []

  for (const [storeId, storeData] of Object.entries(allStoresSummary)) {
    if (storeId === excludeStoreId) continue
    const { entries = {}, roster = {} } = storeData

    const storeConfig = STORES.find((s) => s.id === storeId)
    if (!storeConfig) continue

    const staffIds = Object.keys(roster)

    // Count headcount at home store on this day
    const amCount = staffIds.filter((id) => entries[id]?.[day] === 'AM Shift').length
    const pmCount = staffIds.filter((id) => entries[id]?.[day] === 'PM Shift').length
    let amSurplus = Math.max(0, amCount - storeConfig.minAM)
    let pmSurplus = Math.max(0, pmCount - storeConfig.minPM)

    // Sort: SIC positions first so they appear at the top
    const sortedEntries = Object.entries(roster).sort(([, a], [, b]) =>
      (SIC_POSITIONS.includes(a.position) ? 0 : 1) - (SIC_POSITIONS.includes(b.position) ? 0 : 1)
    )

    const available = []
    for (const [staffId, staffInfo] of sortedEntries) {
      const shift = entries[staffId]?.[day] || ''
      if (BLOCKED.has(shift) || !shift) continue

      const isSIC = SIC_POSITIONS.includes(staffInfo.position)

      // Is this staff member surplus at their home store?
      let isSurplus = false
      if (shift === 'AM Shift' && amSurplus > 0) {
        isSurplus = true
        amSurplus-- // decrement so we don't over-count
      } else if (shift === 'PM Shift' && pmSurplus > 0) {
        isSurplus = true
        pmSurplus--
      }

      // Only include surplus staff or SIC-position staff
      if (!isSurplus && !isSIC) continue

      available.push({
        id: staffId,
        name: staffInfo.name || staffId,
        position: staffInfo.position || '',
        empNo: staffInfo.empNo || '',
        currentShift: shift,
        isSIC,
        isSurplus,
      })
    }

    if (available.length > 0) {
      const storeName = STORES.find((s) => s.id === storeId)?.name || storeId
      result.push({ storeId, storeName, staff: available })
    }
  }

  result.sort((a, b) => a.storeName.localeCompare(b.storeName))
  return result
}

// ---------------------------------------------------------------------------
// planWeekForStaff
// Core auto-generation algorithm. Returns a full entries object for the week.
// Carries forward any existing Leave or Support entries.
// Does NOT write to Firestore — caller handles that.
// ---------------------------------------------------------------------------
export function planWeekForStaff(staff, store, existingEntries = {}, prevWeekEntries = {}) {
  const { storeCategory } = store

  // --- Step 0: Initialize draft, preserve ALL existing entries ---
  const draft = {}
  for (const s of staff) {
    draft[s.id] = {}
    const existing = existingEntries[s.id] || {}
    // Always carry forward remarks
    if (existing.remarks) draft[s.id].remarks = existing.remarks
    // Preserve every existing shift (AM, PM, Day Off, Leave, LOP, Support, Activity, etc.)
    for (const day of WEEK_DAYS) {
      if (existing[day]) {
        draft[s.id][day] = existing[day]
        if (existing[`${day}_dest`]) draft[s.id][`${day}_dest`] = existing[`${day}_dest`]
        if (existing[`${day}_activity`]) draft[s.id][`${day}_activity`] = existing[`${day}_activity`]
      }
    }
  }

  // --- Step 1: Assign days off ---
  const dayOffMap = assignDaysOff(staff, store, draft, prevWeekEntries)
  for (const s of staff) {
    const offs = dayOffMap[s.id]
    if (!offs) continue
    const offArr = Array.isArray(offs) ? offs : [offs]
    for (const d of offArr) {
      if (!draft[s.id][d]) draft[s.id][d] = 'Day Off'
    }
  }

  // --- Step 2: office-8h — assign 1 weekend Support day per staff ---
  if (storeCategory === 'office-8h') {
    staff.forEach((s, i) => {
      const supportDay = i % 2 === 0 ? 'FRI' : 'SAT'
      if (!draft[s.id][supportDay]) {
        draft[s.id][supportDay] = 'Support'
        draft[s.id][`${supportDay}_dest`] = ''
      }
    })
  }

  // --- Step 3 & 4: Fill remaining days with working shifts ---
  if (storeCategory === 'regular') {
    assignAmPm(staff, store, draft)
  } else {
    // All office types: use AM Shift for working days
    for (const s of staff) {
      for (const day of WEEK_DAYS) {
        if (draft[s.id][day]) continue
        // office-10h: weekends are always off (already assigned), skip any remaining
        if (storeCategory === 'office-10h' && WEEKEND_DAYS.includes(day)) continue
        draft[s.id][day] = 'AM Shift'
      }
    }
  }

  return draft
}

// ---------------------------------------------------------------------------
// assignDaysOff (internal)
// Returns { [staffId]: string | string[] } — the day(s) off for each staff member.
// ---------------------------------------------------------------------------
function assignDaysOff(staff, store, draft, prevWeekEntries) {
  const { storeCategory } = store
  const result = {}

  // office-10h: always FRI + SAT
  if (storeCategory === 'office-10h') {
    for (const s of staff) result[s.id] = ['FRI', 'SAT']
    return result
  }

  // office-12h: FRI + SAT + 1 rotating weekday
  if (storeCategory === 'office-12h') {
    const weekdays = WEEK_DAYS.filter((d) => !WEEKEND_DAYS.includes(d)) // SUN MON TUE WED THU
    for (let i = 0; i < staff.length; i++) {
      const s = staff[i]
      let weekdayOff = weekdays[i % weekdays.length]
      // Skip if that weekday is locked (e.g. Leave)
      if (draft[s.id][weekdayOff]) {
        weekdayOff = weekdays.find((d) => !draft[s.id][d]) || weekdays[0]
      }
      result[s.id] = ['FRI', 'SAT', weekdayOff]
    }
    return result
  }

  // office-8h: 1 day off — THU by default, shift if locked
  if (storeCategory === 'office-8h') {
    for (const s of staff) {
      let dayOff = 'THU'
      if (draft[s.id]['THU']) {
        // THU is locked, find another available weekday
        dayOff = WEEK_DAYS
          .filter((d) => !WEEKEND_DAYS.includes(d) && d !== 'THU')
          .find((d) => !draft[s.id][d]) || 'WED'
      }
      result[s.id] = dayOff
    }
    return result
  }

  // regular: 1 day off, distributed across the week with rotation from prev week
  // Track how many staff will be off on each day (to spread evenly)
  const offCount = Object.fromEntries(WEEK_DAYS.map((d) => [d, 0]))
  // Pre-count existing Leave days as "off" for balancing purposes
  for (const s of staff) {
    for (const day of WEEK_DAYS) {
      if (draft[s.id][day] === 'Leave') offCount[day]++
    }
  }

  for (const s of staff) {
    // Candidate days: not already locked
    const candidates = WEEK_DAYS.filter((d) => !draft[s.id][d])
    if (candidates.length === 0) continue

    // Sort candidates by current off count (ascending) for spread
    candidates.sort((a, b) => offCount[a] - offCount[b])

    // Find the day this staff had off last week (for rotation)
    const prevDayOff = WEEK_DAYS.find((d) => prevWeekEntries[s.id]?.[d] === 'Day Off') || null

    // Prefer a different day than last week, but still prefer the lowest-count day
    let dayOff = candidates[0]
    if (prevDayOff && candidates.length > 1) {
      const rotated = candidates.find((d) => d !== prevDayOff)
      if (rotated) dayOff = rotated
    }

    result[s.id] = dayOff
    offCount[dayOff]++
  }

  return result
}

// ---------------------------------------------------------------------------
// assignAmPm (internal — regular stores only)
// Writes 'AM Shift' or 'PM Shift' into draft for each working day slot.
// Ensures SIC coverage on both shifts and meets minAM / minPM headcounts.
// ---------------------------------------------------------------------------
function assignAmPm(staff, store, draft) {
  const { minAM, minPM } = store

  // Per-staff running AM/PM counts for fairness balancing
  const amCount = {}
  const pmCount = {}
  for (const s of staff) {
    amCount[s.id] = 0
    pmCount[s.id] = 0
  }

  for (const day of WEEK_DAYS) {
    // Workers = staff with no shift assigned yet on this day
    const workers = staff.filter((s) => !draft[s.id][day])
    if (workers.length === 0) continue

    const sics = workers.filter((s) => SIC_POSITIONS.includes(s.position))
    const amAssigned = new Set()
    const pmAssigned = new Set()

    // --- SIC mandatory coverage ---
    // Sort SICs: those with fewer AM (relative to PM) go to AM first
    const sortedSics = [...sics].sort(
      (a, b) => (amCount[a.id] - pmCount[a.id]) - (amCount[b.id] - pmCount[b.id])
    )

    if (sortedSics.length >= 2) {
      amAssigned.add(sortedSics[0].id)
      const pmSic = sortedSics.find((s) => !amAssigned.has(s.id))
      if (pmSic) pmAssigned.add(pmSic.id)
    } else if (sortedSics.length === 1) {
      const sic = sortedSics[0]
      if (amCount[sic.id] <= pmCount[sic.id]) amAssigned.add(sic.id)
      else pmAssigned.add(sic.id)
    }

    // --- Fill remaining workers to meet minAM / minPM ---
    const remaining = workers.filter((s) => !amAssigned.has(s.id) && !pmAssigned.has(s.id))
    // Sort remaining: those with fewer AM relative to PM prefer AM
    remaining.sort(
      (a, b) => (amCount[a.id] - pmCount[a.id]) - (amCount[b.id] - pmCount[b.id])
    )

    let amStillNeeded = Math.max(0, minAM - amAssigned.size)
    let pmStillNeeded = Math.max(0, minPM - pmAssigned.size)

    for (const s of remaining) {
      if (amStillNeeded > 0) {
        amAssigned.add(s.id)
        amStillNeeded--
      } else if (pmStillNeeded > 0) {
        pmAssigned.add(s.id)
        pmStillNeeded--
      } else {
        // Extra staff: assign to whichever shift they've had fewer of
        if (amCount[s.id] <= pmCount[s.id]) amAssigned.add(s.id)
        else pmAssigned.add(s.id)
      }
    }

    // Write into draft and update running counts
    for (const s of workers) {
      if (amAssigned.has(s.id)) {
        draft[s.id][day] = 'AM Shift'
        amCount[s.id]++
      } else if (pmAssigned.has(s.id)) {
        draft[s.id][day] = 'PM Shift'
        pmCount[s.id]++
      }
    }
  }
}
