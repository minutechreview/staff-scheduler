// Reproduce CPU preparation measurements; this is not browser interaction latency.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { scheduleRows } from '../src/scheduleGrid.mjs'
const dates = Array.from({ length: 7 }, (_, i) => `2026-10-${12 + i}`)
const staff = Array.from({ length: 1200 }, (_, i) => ({ id: `person-${i}`, name: `Synthetic ${i}`, skills: ['associate'], contract_hours: 40 }))
const shifts = staff.flatMap(e => dates.slice(0, 5).map(day => ({ employee: e.id, start: `${day}T08:00:00Z`, end: `${day}T16:00:00Z` })))
const leaves = staff.slice(0, 100).map(e => ({ employee: e.id, start: dates[5], end: dates[6], status: 'approved' }))
function localDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const part = name => parts.find(p => p.type === name).value
  return `${part('year')}-${part('month')}-${part('day')}`
}
function oldPage() {
  return staff.slice(0, 30).map(e => ({
    hours: shifts.filter(s => s.employee === e.id).reduce((sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)) / 3600000, 0),
    days: dates.map(day => ({ shifts: shifts.filter(s => s.employee === e.id && localDate(s.start) === day), leave: leaves.some(l => l.employee === e.id && l.start <= day && l.end >= day) })),
  }))
}
const indexed = () => scheduleRows(staff, shifts, leaves, dates, 'Europe/London')
const expected = oldPage(), actual = indexed()
for (let i = 0; i < 30; i++) {
  assert.equal(actual[i].hours, expected[i].hours)
  dates.forEach((day, d) => {
    assert.deepEqual(actual[i].shifts.get(day) || [], expected[i].days[d].shifts)
    assert.equal(actual[i].leave.has(day), expected[i].days[d].leave)
  })
}
const timings = fn => {
  fn()
  return Array.from({ length: 7 }, () => { const start = performance.now(); fn(); return performance.now() - start }).sort((a, b) => a - b)
}
const before = timings(oldPage), after = timings(indexed)
const result = { synthetic_only: true, employees: 1200, shifts: 6000, leaves: 100, visible_page: 30, repetitions: 7, equivalence_checked: true, old_visible_page_median_ms: before[3], new_entire_week_index_median_ms: after[3], scope: 'CPU data preparation only; excludes API, React render, layout and interaction latency', before_ms: before, after_ms: after }
writeFileSync('docs/validation/convenience-grid-benchmark-20261013.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
