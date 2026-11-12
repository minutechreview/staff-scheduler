// Wall-clock edits deliberately return local input. The server resolves the
// branch timezone and rejects nonexistent/ambiguous times and all conflicts.
const dateFormat = new Map()
function formatter(zone) {
  if (!dateFormat.has(zone)) dateFormat.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
  return dateFormat.get(zone)
}
export function wallTime(value, zone) {
  // Unsaved edits already have a local timestamp: never interpret it in the
  // browser's own timezone, which might differ from this branch.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(value)).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}
function calendarMinutes(value) {
  return Date.parse(value + ':00Z') / 60000
}
function localFromMinutes(value) {
  return new Date(value * 60000).toISOString().slice(0, 16)
}
export function adjustShift(shift, zone, edge, minutes) {
  if (!['move', 'start', 'end'].includes(edge) || !Number.isInteger(minutes) || minutes % 30) throw new Error('Adjust shifts in 30-minute steps.')
  const start = calendarMinutes(wallTime(shift.start, zone)) + (edge !== 'end' ? minutes : 0)
  const end = calendarMinutes(wallTime(shift.end, zone)) + (edge !== 'start' ? minutes : 0)
  if (end <= start) throw new Error('End must stay after start. Use Edit for a repeated clock-change time.')
  return { ...shift, start: localFromMinutes(start), end: localFromMinutes(end) }
}
export function shiftTemplate(shift, zone) {
  const start = wallTime(shift.start, zone), end = wallTime(shift.end, zone)
  const days = (Date.parse(end.slice(0, 10) + 'T00:00Z') - Date.parse(start.slice(0, 10) + 'T00:00Z')) / 86400000
  if (calendarMinutes(end) <= calendarMinutes(start)) throw new Error('Use Edit for a repeated clock-change time; it cannot be copied as a wall-clock template.')
  return { role: shift.role, start: start.slice(11), end: end.slice(11), days }
}
export function pasteShift(template, employee, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(template.days) || template.days < 0 || template.days > 2) throw new Error('Choose a valid destination day.')
  const endDay = new Date(Date.parse(day + 'T12:00Z') + template.days * 86400000).toISOString().slice(0, 10)
  // Never copy source employee, branch or shift IDs to the destination.
  return { employee, role: template.role, start: `${day}T${template.start}`, end: `${endDay}T${template.end}` }
}
export function duplicateExists(shifts, candidate, zone) {
  return shifts.some(s => s.employee === candidate.employee && s.role === candidate.role && wallTime(s.start, zone) === candidate.start && wallTime(s.end, zone) === candidate.end)
}
export function dragMinutes(pixels) {
  return Math.sign(pixels) * Math.round(Math.abs(pixels) / 20) * 30
}
