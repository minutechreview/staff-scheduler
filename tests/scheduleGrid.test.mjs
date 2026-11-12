import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterScheduleRows, scheduleRows } from '../src/scheduleGrid.mjs'

const employees = [
  { id: 'a', name: 'Alex', skills: ['lead'], contract_hours: 8 },
  { id: 'b', name: 'Sam', skills: ['associate'], contract_hours: 10 },
  { id: 'c', name: 'Support', skills: ['lead'], contract_hours: null },
]
const dates = ['2026-10-24', '2026-10-25', '2026-10-26']
const shifts = [
  { id: 'first', employee: 'a', start: '2026-10-24T20:00Z', end: '2026-10-25T04:00Z' },
  { id: 'second', employee: 'a', start: '2026-10-26T09:00Z', end: '2026-10-26T10:00Z' },
  { id: 'unknown', employee: 'out-of-scope', start: '2026-10-24T09:00Z', end: '2026-10-24T17:00Z' },
]
test('grid groups in branch-local dates and uses elapsed hours over an overnight DST boundary', () => {
  const rows = scheduleRows(employees, shifts, [], dates, 'Europe/London')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].hours, 9)
  assert.equal(rows[0].shifts.get('2026-10-24')[0].id, 'first')
  assert.equal(rows[0].shifts.has('2026-10-25'), false)
  assert.equal(scheduleRows(employees, shifts, [], dates, 'Asia/Tokyo')[0].shifts.get('2026-10-25')[0].id, 'first')
  assert.equal(shifts.length, 3)
})
test('leave filters include still-reserved days and exclude pending and cancelled leave', () => {
  const leaves = [
    { employee: 'a', status: 'approved', start: '2026-10-24', end: '2026-10-25' },
    { employee: 'b', status: 'pending', start: '2026-10-24', end: '2026-10-26' },
    { employee: 'c', status: 'cancel_requested', start: '2026-10-26', end: '2026-10-26' },
    { employee: 'b', status: 'cancelled', start: '2026-10-24', end: '2026-10-26' },
  ]
  const rows = scheduleRows(employees, shifts, leaves, dates, 'Europe/London')
  assert.deepEqual(filterScheduleRows(rows, '', '', 'leave').map(r => r.employee.id), ['a', 'c'])
  assert.equal(rows[0].leave.size, 2)
})
test('search, skill, workload compose; unknown support contracts never imply spare capacity', () => {
  const rows = scheduleRows(employees, shifts, [], dates, 'Europe/London')
  assert.deepEqual(filterScheduleRows(rows, ' ALEX ', 'lead', 'over').map(r => r.employee.id), ['a'])
  assert.deepEqual(filterScheduleRows(rows, '', '', 'under').map(r => r.employee.id), ['b'])
  assert.deepEqual(filterScheduleRows(rows, '', '', 'unassigned').map(r => r.employee.id), ['b', 'c'])
  assert.equal(filterScheduleRows(rows, 'Alex', 'associate', 'all').length, 0)
  const exact = scheduleRows(employees, shifts.slice(0, 1), [], dates, 'Europe/London')
  assert.equal(filterScheduleRows(exact, 'Alex', '', 'under').length, 0)
  assert.equal(filterScheduleRows(exact, 'Alex', '', 'over').length, 0)
})
