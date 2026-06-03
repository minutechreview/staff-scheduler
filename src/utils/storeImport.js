import { WEEK_DAYS } from '../data/stores'

// ── Shift normalisation ───────────────────────────────────────────────────────
// Maps any raw cell value the user might have → a system shift string.
// Keys are lowercase for case-insensitive matching.

const SHIFT_ALIASES = {
  // AM variants
  'am':          'AM Shift',
  'am shift':    'AM Shift',
  'morning':     'AM Shift',
  'a.m':         'AM Shift',
  '8-4':         'AM Shift',
  '8:00-16:00':  'AM Shift',
  '9-5':         'AM Shift',
  '9:00-17:00':  'AM Shift',
  '0800-1600':   'AM Shift',
  '0900-1700':   'AM Shift',
  // AM 8h variants (office-12h short shift)
  'am 8h':       'AM 8h',
  'am8h':        'AM 8h',
  'am (8h)':     'AM 8h',
  '8h':          'AM 8h',
  '8 hour':      'AM 8h',
  '8hr':         'AM 8h',
  // PM variants
  'pm':          'PM Shift',
  'pm shift':    'PM Shift',
  'evening':     'PM Shift',
  'afternoon':   'PM Shift',
  'p.m':         'PM Shift',
  '2-10':        'PM Shift',
  '14:00-22:00': 'PM Shift',
  '3-11':        'PM Shift',
  '15:00-23:00': 'PM Shift',
  '1400-2200':   'PM Shift',
  '1500-2300':   'PM Shift',
  // Mid Shift
  'mid':         'Mid Shift',
  'mid shift':   'Mid Shift',
  'midshift':    'Mid Shift',
  'middle':      'Mid Shift',
  '11-7':        'Mid Shift',
  '11:00-19:00': 'Mid Shift',
  // GY Shift
  'gy':          'GY Shift',
  'gy shift':    'GY Shift',
  'night':       'GY Shift',
  'graveyard':   'GY Shift',
  // Day Off
  'off':         'Day Off',
  'day off':     'Day Off',
  'rest':        'Day Off',
  'rd':          'Day Off',
  'off day':     'Day Off',
  'dayoff':      'Day Off',
  'do':          'Day Off',
  // Leave
  'leave':       'Leave',
  'annual':      'Leave',
  'al':          'Leave',
  'annual leave':'Leave',
  'vacation':    'Leave',
  'vac':         'Leave',
  // Support
  'support':     'Support',
  'sup':         'Support',
  // Activity
  'activity':    'Activity',
  'act':         'Activity',
  'training':    'Activity',
  // LOP
  'lop':         'LOP',
  'loss of pay': 'LOP',
  'unpaid':      'LOP',
  'lwp':         'LOP', // Leave Without Pay (common alias)
}

/**
 * Normalise a raw cell value to a system shift string.
 * Returns the raw value unchanged if no mapping found.
 */
export function normalizeShift(rawValue) {
  if (!rawValue) return ''
  const key = String(rawValue).trim().toLowerCase()
  return SHIFT_ALIASES[key] || rawValue
}

// ── Fuzzy name matching ───────────────────────────────────────────────────────

function normalizeNameForMatch(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/\s+/g, ' ')
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/**
 * Find the best roster match for a raw name from a sheet.
 * Returns { staffId, name, score } where score is 0–1 (1 = exact).
 * Returns null if best score < threshold.
 */
export function fuzzyMatchName(rawName, roster, threshold = 0.75) {
  const normalised = normalizeNameForMatch(rawName)
  let best = null
  let bestScore = -1

  for (const member of roster) {
    const memberNorm = normalizeNameForMatch(member.name)
    const maxLen = Math.max(normalised.length, memberNorm.length)
    if (maxLen === 0) continue
    const dist = levenshtein(normalised, memberNorm)
    const score = 1 - dist / maxLen
    if (score > bestScore) {
      bestScore = score
      best = { staffId: member.id, name: member.name, score }
    }
  }

  return best && bestScore >= threshold ? best : null
}

// ── Day column detection ──────────────────────────────────────────────────────

const DAY_HEADER_ALIASES = {
  fri: 'FRI', friday: 'FRI',
  sat: 'SAT', saturday: 'SAT',
  sun: 'SUN', sunday: 'SUN',
  mon: 'MON', monday: 'MON',
  tue: 'TUE', tuesday: 'TUE',
  wed: 'WED', wednesday: 'WED',
  thu: 'THU', thursday: 'THU',
}

/**
 * Scan a header row (array of cell values) and return { [DAY]: colIndex }.
 * Handles full day names, abbreviations, and dates (extracts day of week from date).
 */
export function detectDayColumns(headerRow) {
  const dayCols = {}
  if (!Array.isArray(headerRow)) return dayCols

  headerRow.forEach((cell, colIndex) => {
    if (!cell) return
    const raw = String(cell).trim().toLowerCase()
    // Direct name match
    if (DAY_HEADER_ALIASES[raw]) {
      dayCols[DAY_HEADER_ALIASES[raw]] = colIndex
      return
    }
    // Date-like: parse and get day name
    const d = new Date(raw)
    if (!isNaN(d.getTime())) {
      const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      const abbr = dayNames[d.getDay()]
      if (DAY_HEADER_ALIASES[abbr]) {
        dayCols[DAY_HEADER_ALIASES[abbr]] = colIndex
      }
    }
  })

  return dayCols
}

// ── Sheet parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a single worksheet against the store roster.
 * Returns an array of row results:
 *   { rawName, matched: { staffId, name, score } | null, shifts: { [DAY]: rawValue }, normalizedShifts: { [DAY]: systemShift } }
 *
 * @param {object} worksheet - xlsx worksheet object
 * @param {Array}  roster    - store roster: [{ id, name, position, ... }]
 */
export async function parseStoreSheet(worksheet, roster) {
  const { utils } = await import('xlsx')
  const rows = utils.sheet_to_json(worksheet, { header: 1, defval: null })
  if (rows.length < 2) return { dayColumns: {}, rowResults: [] }

  // Find the header row — the first row containing a recognised day name
  let headerRowIdx = -1
  let dayColumns = {}

  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const dc = detectDayColumns(rows[i])
    if (Object.keys(dc).length >= 3) { // at least 3 day columns found
      headerRowIdx = i
      dayColumns = dc
      break
    }
  }

  if (headerRowIdx === -1) return { dayColumns: {}, rowResults: [] }

  // Find the name column — the first column with the most non-empty string values
  // heuristic: check columns 0–4 across data rows
  const nameColCandidates = [0, 1, 2, 3, 4]
  let nameCol = 1 // default
  let maxStringCount = 0
  for (const col of nameColCandidates) {
    // Skip if this column is already a day column
    if (Object.values(dayColumns).includes(col)) continue
    const count = rows.slice(headerRowIdx + 1).filter((r) => r && typeof r[col] === 'string' && r[col].trim().length > 2).length
    if (count > maxStringCount) {
      maxStringCount = count
      nameCol = col
    }
  }

  // Parse data rows
  const rowResults = []
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const rawName = row[nameCol]
    if (!rawName || typeof rawName !== 'string' || rawName.trim().length < 2) continue
    // Skip rows that look like totals/headers
    const lc = rawName.trim().toLowerCase()
    if (lc === 'total' || lc === 'remarks' || lc === 'name' || lc === 'staff') continue

    const shifts = {}
    const normalizedShifts = {}
    let hasAnyShift = false
    for (const [day, colIdx] of Object.entries(dayColumns)) {
      const rawVal = row[colIdx]
      if (rawVal !== null && rawVal !== undefined && String(rawVal).trim()) {
        shifts[day] = String(rawVal).trim()
        normalizedShifts[day] = normalizeShift(rawVal)
        hasAnyShift = true
      }
    }
    if (!hasAnyShift) continue

    const matched = fuzzyMatchName(rawName.trim(), roster)
    rowResults.push({ rawName: rawName.trim(), matched, shifts, normalizedShifts })
  }

  return { dayColumns, rowResults }
}

// ── Build Firestore entries ───────────────────────────────────────────────────

/**
 * Convert confirmed row results into the Firestore entries object.
 * Only includes rows where matched is confirmed (not rejected by user).
 */
export function buildImportEntries(confirmedRows) {
  const entries = {}
  for (const row of confirmedRows) {
    if (!row.matched || row.rejected) continue
    const staffEntry = {}
    for (const day of WEEK_DAYS) {
      if (row.normalizedShifts[day]) {
        staffEntry[day] = row.normalizedShifts[day]
      }
    }
    if (Object.keys(staffEntry).length > 0) {
      entries[row.matched.staffId] = staffEntry
    }
  }
  return entries
}

// ── File reader ───────────────────────────────────────────────────────────────

/**
 * Read an .xlsx / .xls / .csv file and return the first worksheet that has
 * enough day columns. Falls back to the first sheet.
 */
export async function readFirstSheet(file) {
  const { read } = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = read(arrayBuffer, { type: 'array' })
  const sheetName = workbook.SheetNames[0]
  return {
    workbook,
    sheetName,
    worksheet: workbook.Sheets[sheetName],
    sheetNames: workbook.SheetNames,
  }
}
