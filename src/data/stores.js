// Master list of stores — example AOR configuration
// Replace these with your actual store list via the Settings page or Firestore seeding.
// storeCategory:
//   'regular'    — 8h shifts, 6 working days, 1 day off
//   'office-12h' — 12h shifts, 4 working days, 3 days off
//   'office-10h' — ~10h shifts, 5 working days (Sun–Thu), 2 days off (Fri+Sat)
//   'office-8h'  — 8h weekdays, 1 weekend Support day, 1 day off

export const STORES = [
  { id: 'Store01',   name: 'City Center',         storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 3, totalRoster: 8  },
  { id: 'Store02',   name: 'Mall East',            storeCategory: 'regular',    type: 'Regular',    minAM: 3, minPM: 3, totalRoster: 8  },
  { id: 'Store03',   name: 'North Mall',           storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 3, totalRoster: 7  },
  { id: 'Store04',   name: 'Twin Tower',           storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 5  },
  { id: 'Store05',   name: 'West Park',            storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 6  },
  { id: 'Store06',   name: 'Central Branch',       storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 5  },
  { id: 'Store07',   name: 'Market Square',        storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 3, totalRoster: 7  },
  { id: 'Store08',   name: 'Grand Hotel',          storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 6  },
  { id: 'Store09',   name: 'Office HQ',            storeCategory: 'office-12h', type: 'Office 12h', minAM: 2, minPM: 0, totalRoster: 5  },
  { id: 'Store10',   name: 'Business Park',        storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 5  },
  { id: 'Store11',   name: 'Crystal Galleria',     storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 5  },
  { id: 'Store12',   name: 'Corporate Tower A',    storeCategory: 'office-10h', type: 'Office 10h', minAM: 2, minPM: 0, totalRoster: 5  },
  { id: 'Store13',   name: 'Corporate Tower B',    storeCategory: 'office-10h', type: 'Office 10h', minAM: 2, minPM: 0, totalRoster: 5  },
  { id: 'Store14',   name: 'Finance District',     storeCategory: 'office-8h',  type: 'Office 8h',  minAM: 2, minPM: 0, totalRoster: 5  },
  { id: 'Store15',   name: 'Hospital Campus',      storeCategory: 'regular',    type: 'Regular',    minAM: 2, minPM: 2, totalRoster: 5  },
  { id: 'Store16',   name: 'Exchange Tower',       storeCategory: 'office-8h',  type: 'Office 8h',  minAM: 2, minPM: 0, totalRoster: 5  },
]

// Days off required per week by store category
export const DAYS_OFF_REQUIRED = {
  'regular':    1,
  'office-12h': 3,
  'office-10h': 2,  // Office 10h: Fri+Sat off, 5 working days
  'office-8h':  1,  // Office 8h: 1 day off like regular
}

// Positions that qualify as SIC (Shift In Charge)
export const SIC_POSITIONS = ['SM', 'ASM', 'SSV', 'TSSV', 'SIC']

// Days in work week order (Fri = week start)
export const WEEK_DAYS = ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU']

// Weekend day keys (office stores closed)
export const WEEKEND_DAYS = ['FRI', 'SAT']

export const SHIFT_OPTIONS = [
  { value: '',          label: '—',       color: 'bg-[var(--shift-off-bg)] text-[var(--shift-off-text)]' },
  { value: 'AM Shift',  label: 'AM',      color: 'bg-[var(--shift-am-bg)] text-[var(--shift-am-text)]' },
  { value: 'AM 8h',     label: 'AM 8h',   color: 'bg-[var(--shift-am-bg)] text-[var(--shift-am-text)]', restrictTo: 'office-12h' },
  { value: 'PM Shift',  label: 'PM',      color: 'bg-[var(--shift-pm-bg)] text-[var(--shift-pm-text)]' },
  { value: 'Mid Shift', label: 'Mid',     color: 'bg-[var(--shift-mid-bg)] text-[var(--shift-mid-text)]' },
  { value: 'GY Shift',  label: 'GY',      color: 'bg-[var(--shift-gy-bg)] text-[var(--shift-gy-text)]' },
  { value: 'Day Off',   label: 'Off',     color: 'bg-[var(--shift-off-bg)] text-[var(--shift-off-text)]' },
  { value: 'Support',   label: 'Support', color: 'bg-[var(--shift-support-bg)] text-[var(--shift-support-text)]' },
  { value: 'Leave',     label: 'Leave',   color: 'bg-[var(--shift-leave-bg)] text-[var(--shift-leave-text)]' },
  { value: 'Activity',  label: 'Act',     color: 'bg-[var(--shift-act-bg)] text-[var(--shift-act-text)]' },
  { value: 'LOP',       label: 'LOP',     color: 'bg-[var(--shift-lop-bg)] text-[var(--shift-lop-text)]' },
]

// Common activity presets shown in the activity picker
export const ACTIVITY_PRESETS = [
  'Workshop',
  'Medical Clearance',
  'CSR Activity',
  'Training',
  'Meeting',
  'Audit',
]

export const POSITIONS = ['SM', 'ASM', 'SSV', 'TSSV', 'B', 'Support']

function toLocalISO(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function getWeekStartFriday(date = new Date()) {
  const d = new Date(date)
  const dayOfWeek = d.getDay()
  const daysFromFriday = (dayOfWeek + 2) % 7
  d.setDate(d.getDate() - daysFromFriday)
  return toLocalISO(d)
}

export function getWeekDates(fridayDateString) {
  const friday = new Date(fridayDateString + 'T00:00:00')
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(friday)
    d.setDate(friday.getDate() + i)
    return toLocalISO(d)
  })
}

export function formatDate(dateString) {
  if (!dateString) return ''
  const d = new Date(dateString + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// Fri-start week number.
// Fiscal year N starts on the Friday closest to Jan 1 of year N.
// Late-December weeks that belong to year N+1 fiscal calendar are handled.
export function getWeekNumber(weekStartDateStr) {
  const thisWeek = new Date(weekStartDateStr + 'T00:00:00')
  let year = thisWeek.getFullYear()

  // If the week falls in December, it might belong to the next fiscal year
  if (thisWeek.getMonth() === 11) {
    const nextJan1 = new Date(year + 1, 0, 1)
    const nextDaysBack = (nextJan1.getDay() + 2) % 7
    const nextFirstFriday = new Date(nextJan1)
    nextFirstFriday.setDate(1 - nextDaysBack)
    if (thisWeek >= nextFirstFriday) year = year + 1
  }

  const jan1 = new Date(year, 0, 1)
  const daysBack = (jan1.getDay() + 2) % 7
  const firstWeekFriday = new Date(jan1)
  firstWeekFriday.setDate(1 - daysBack)
  const diffDays = Math.round((thisWeek - firstWeekFriday) / 86400000)
  return Math.floor(diffDays / 7) + 1
}

// Previous Friday date string
export function getPrevWeekStart(fridayDateString) {
  const d = new Date(fridayDateString + 'T00:00:00')
  d.setDate(d.getDate() - 7)
  return toLocalISO(d)
}

// Validate a staff member's week against business rules.
// Returns array of warning strings (empty = OK).
export function validateStaffWeek(staffEntry, store) {
  if (!staffEntry) return []
  const warnings = []

  const daysOff = WEEK_DAYS.filter((d) => staffEntry[d] === 'Day Off').length
  const required = DAYS_OFF_REQUIRED[store.storeCategory] || 1

  if (daysOff < required) {
    warnings.push(`Needs ${required} day(s) off — has ${daysOff}`)
  } else if (daysOff > required) {
    warnings.push(`Too many days off (${daysOff})`)
  }

  // Office stores: no AM/PM shifts on weekends (Fri/Sat)
  if (store.storeCategory === 'office-10h' || store.storeCategory === 'office-8h') {
    const weekendWork = WEEKEND_DAYS.filter((d) =>
      staffEntry[d] === 'AM Shift' || staffEntry[d] === 'PM Shift'
    )
    if (weekendWork.length > 0) warnings.push('No AM/PM shifts on weekends for office store')
  }

  return warnings
}

// Check if store's schedule meets all status conditions.
// Returns: 'ok' | 'sic-missing' | 'days-off' | 'review' | 'unset'
export function getStoreStatus(store, storeEntries, rosterMap = {}, options = {}) {
  const staffIds = Object.keys(storeEntries)
  if (staffIds.length === 0) return 'unset'
  const excludeDayOffStaffIds = new Set(options.excludeDayOffStaffIds || [])

  // Office stores are closed on weekends — skip headcount check for those days
  const checkDays = store.storeCategory !== 'regular'
    ? WEEK_DAYS.filter((d) => !WEEKEND_DAYS.includes(d))
    : WEEK_DAYS

  // Headcount check (AM 8h counts toward AM headcount for office-12h stores)
  const headcountOk = checkDays.every((day) => {
    const am = staffIds.filter((id) => {
      const v = storeEntries[id]?.[day]
      return v === 'AM Shift' || v === 'AM 8h'
    }).length
    const pm = store.minPM > 0 ? staffIds.filter((id) => storeEntries[id]?.[day] === 'PM Shift').length : 0
    return am >= store.minAM && (store.minPM === 0 || pm >= store.minPM)
  })
  if (!headcountOk) return 'review'

  // SIC check per shift (only if roster data provided)
  // Visitors with an SIC position count if they appear in supportDays for that day
  if (Object.keys(rosterMap).length > 0) {
    const sicMissing = checkDays.some((day) => {
      const hasSIC = (shiftType) => Object.keys(rosterMap).some((id) => {
        const member = rosterMap[id]
        if (!SIC_POSITIONS.includes(member?.position)) return false
        const currentShift = storeEntries[id]?.[day]
        if (currentShift === shiftType) return true
        if (shiftType === 'AM Shift' && currentShift === 'AM 8h') return true
        if (member?.supportDays?.includes(day)) return true
        return false
      })
      const hasAM = staffIds.some((id) => {
        const v = storeEntries[id]?.[day]
        return v === 'AM Shift' || v === 'AM 8h'
      })
      const hasPM = staffIds.some((id) => storeEntries[id]?.[day] === 'PM Shift')
      return (hasAM && !hasSIC('AM Shift')) || (hasPM && !hasSIC('PM Shift'))
    })
    if (sicMissing) return 'sic-missing'
  }

  // Days-off check
  const daysOffOk = staffIds.every((id) => {
    if (excludeDayOffStaffIds.has(id)) return true
    return validateStaffWeek(storeEntries[id], store).length === 0
  })
  if (!daysOffOk) return 'days-off'

  return 'ok'
}
