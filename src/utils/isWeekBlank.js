import { WEEK_DAYS } from '../data/stores'

/**
 * Returns true only when no WEEK_DAYS shift value is set for any staff member.
 * Ignores remarks and _dest/_activity/_dm_auth suffix keys.
 */
export function isWeekBlank(staff, scheduleEntries) {
  for (const s of staff) {
    const entry = scheduleEntries[s.id] || {}
    for (const day of WEEK_DAYS) {
      if (entry[day]) return false
    }
  }
  return true
}
