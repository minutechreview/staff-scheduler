import { WEEK_DAYS, getWeekDates, formatDate } from '../data/stores'

/**
 * Exports the current store schedule as an Excel file (.xlsx).
 * The output format mirrors the import format so files can be re-imported.
 *
 * Columns: #, Name, EmpNo, Position, Gender, FRI, SAT, SUN, MON, TUE, WED, THU, Remarks
 */
export async function exportStoreExcel(store, staff, scheduleEntries, weekStart) {
  const { utils, writeFile } = await import('xlsx')

  const weekDates = getWeekDates(weekStart)

  // Build header rows
  const titleRow = [`${store.name} — Weekly Schedule`]
  const weekRow = [`Week of ${formatDate(weekStart)} – ${formatDate(weekDates[weekDates.length - 1])}`]
  const emptyRow = []

  const columnHeaders = ['#', 'Name', 'EmpNo', 'Position', 'Gender', ...WEEK_DAYS, 'Remarks']

  // Build one data row per staff member
  const staffRows = staff.map((member, index) => {
    const entry = scheduleEntries[member.id] || {}
    const dayShifts = WEEK_DAYS.map((day) => entry[day] || '')
    const remarks = entry.remarks || ''
    return [
      index + 1,
      member.name || '',
      member.empNo || '',
      member.position || '',
      member.gender || '',
      ...dayShifts,
      remarks,
    ]
  })

  const worksheetData = [
    titleRow,
    weekRow,
    emptyRow,
    columnHeaders,
    ...staffRows,
  ]

  const worksheet = utils.aoa_to_sheet(worksheetData)

  // Column widths
  worksheet['!cols'] = [
    { wch: 4 },   // #
    { wch: 22 },  // Name
    { wch: 10 },  // EmpNo
    { wch: 12 },  // Position
    { wch: 8 },   // Gender
    ...WEEK_DAYS.map(() => ({ wch: 10 })),
    { wch: 20 },  // Remarks
  ]

  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, worksheet, store.name)

  const fileName = `${store.name}_${weekStart}.xlsx`
  writeFile(workbook, fileName)
}
