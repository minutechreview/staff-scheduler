import { doc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { WEEK_DAYS } from '../data/stores'

// Map Excel sheet names to Firestore store IDs.
// Update these to match your actual store IDs from src/data/stores.js.
const SHEET_TO_STORE_ID = {
  'Store01': 'Store01',
  'Store02': 'Store02',
  'Store03': 'Store03',
  'Store04': 'Store04',
  'Store05': 'Store05',
  'Store06': 'Store06',
  'Store07': 'Store07',
  'Store08': 'Store08',
  'Store09': 'Store09',
  'Store10': 'Store10',
  'Store11': 'Store11',
  'Store12': 'Store12',
  'Store13': 'Store13',
  'Store14': 'Store14',
  'Store15': 'Store15',
  'Store16': 'Store16',
}

// Row 8 (0-indexed row 7) is the header row with FRI/SAT/SUN...
// Rows 9–23 (0-indexed 8–22) are staff rows
// Columns: 0=#, 1=Name, 2=EmpNo, 3=Position, 4=Gender, 5=FRI, 6=SAT, 7=SUN, 8=MON, 9=TUE, 10=WED, 11=THU, 12=Remarks

const DAY_COL_INDEX = { FRI: 5, SAT: 6, SUN: 7, MON: 8, TUE: 9, WED: 10, THU: 11 }

export async function importScheduleFromExcel(file, weekStartDate) {
  const { read, utils } = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = read(arrayBuffer, { type: 'array' })

  const results = { imported: 0, stores: [], errors: [] }

  for (const [sheetName, storeId] of Object.entries(SHEET_TO_STORE_ID)) {
    if (!workbook.SheetNames.includes(sheetName)) continue

    const sheet = workbook.Sheets[sheetName]
    const rows = utils.sheet_to_json(sheet, { header: 1, defval: null })

    // Find staff rows: rows where column 0 is a number and column 1 has a name
    const entries = {}
    for (let rowIdx = 8; rowIdx <= 25; rowIdx++) {
      const row = rows[rowIdx]
      if (!row) continue
      const rowNum = row[0]
      const name = row[1]
      if (!rowNum || typeof rowNum !== 'number' || !name) continue

      // Build a stable staff ID matching what we seeded
      const staffId = String(name).trim().replace(/\s+/g, '_').replace(/'/g, '').toLowerCase().slice(0, 30)

      const dayShifts = {}
      for (const [day, colIdx] of Object.entries(DAY_COL_INDEX)) {
        const cellValue = row[colIdx]
        if (cellValue && typeof cellValue === 'string' && cellValue.trim()) {
          dayShifts[day] = cellValue.trim()
        }
      }

      if (Object.keys(dayShifts).length > 0) {
        entries[staffId] = dayShifts
      }
    }

    if (Object.keys(entries).length > 0) {
      const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
      await setDoc(docRef, { entries, storeId, weekStartDate }, { merge: true })
      results.imported += Object.keys(entries).length
      results.stores.push(storeId)
    }
  }

  return results
}
