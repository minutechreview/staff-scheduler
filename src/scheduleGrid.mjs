import { wallTime } from './scheduleEditing.mjs'

// Build each employee's visible week once, rather than rescanning the complete
// schedule for every person/day cell. This contains only already scoped data.
export function scheduleRows(employees, shifts, leaves, dates, zone) {
  const rows = new Map(employees.map(employee => [employee.id, { employee, hours: 0, shifts: new Map(), leave: new Set() }]))
  const days = new Set(dates)
  for (const shift of shifts) {
    const row = rows.get(shift.employee)
    if (!row) continue
    row.hours += (Date.parse(shift.end) - Date.parse(shift.start)) / 3600000
    const day = wallTime(shift.start, zone).slice(0, 10)
    if (days.has(day)) {
      if (!row.shifts.has(day)) row.shifts.set(day, [])
      row.shifts.get(day).push(shift)
    }
  }
  for (const leave of leaves) {
    const row = rows.get(leave.employee)
    if (!row || !['approved', 'cancel_requested', 'partially_cancelled'].includes(leave.status)) continue
    for (const day of dates) if (leave.start <= day && leave.end >= day) row.leave.add(day)
  }
  return [...rows.values()]
}

export function filterScheduleRows(rows, search, skill, workload) {
  const name = search.trim().toLocaleLowerCase()
  return rows.filter(({ employee, hours, shifts, leave }) => {
    if (!employee.name.toLocaleLowerCase().includes(name) || (skill && !employee.skills.includes(skill))) return false
    if (workload === 'unassigned') return shifts.size === 0
    if (workload === 'under') return Number.isFinite(employee.contract_hours) && employee.contract_hours > 0 && hours < employee.contract_hours
    if (workload === 'over') return Number.isFinite(employee.contract_hours) && hours > employee.contract_hours
    if (workload === 'leave') return leave.size > 0
    return true
  })
}
