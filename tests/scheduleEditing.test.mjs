import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjustShift, shiftTemplate, pasteShift, wallTime, dragMinutes, duplicateExists } from '../src/scheduleEditing.mjs'

const shift = { id: 'original', employee: 'source-person', branch: 'source-branch', role: 'lead', start: '2026-10-12T08:00:00Z', end: '2026-10-12T16:00:00Z' }
test('time move uses branch wall time and keeps original authority fields immutable', () => {
  const moved = adjustShift(shift, 'Europe/London', 'move', 30)
  assert.equal(moved.start, '2026-10-12T09:30')
  assert.equal(moved.end, '2026-10-12T17:30')
  assert.equal(moved.id, shift.id)
  assert.equal(moved.employee, shift.employee)
  assert.equal(shift.start, '2026-10-12T08:00:00Z')
})
test('separate start and end adjustment preserves the other endpoint', () => {
  assert.equal(adjustShift(shift, 'Europe/London', 'start', -30).end, '2026-10-12T17:00')
  assert.equal(adjustShift(shift, 'Europe/London', 'end', 30).start, '2026-10-12T09:00')
  assert.throws(() => adjustShift(shift, 'Europe/London', 'start', 480), /End must stay after start/)
  assert.throws(() => adjustShift(shift, 'Europe/London', 'move', 15), /30-minute/)
})
test('drag snapping is symmetric, including half-step and tiny movements', () => {
  assert.equal(dragMinutes(4), 0)
  assert.equal(dragMinutes(10), 30)
  assert.equal(dragMinutes(-10), -30)
  assert.equal(dragMinutes(40), 60)
})
test('copy and paste carries local times and overnight date, never source identity or ID', () => {
  const overnight = { ...shift, start: '2026-12-31T22:00:00Z', end: '2027-01-01T06:00:00Z' }
  const template = shiftTemplate(overnight, 'Europe/London')
  assert.deepEqual(pasteShift(template, 'destination-person', '2027-01-08'), { employee: 'destination-person', role: 'lead', start: '2027-01-08T22:00', end: '2027-01-09T06:00' })
  assert.equal(Object.hasOwn(template, 'employee'), false)
  assert.equal(Object.hasOwn(template, 'id'), false)
})
test('paste resolves destination day independently of original UTC offset', () => {
  const template = shiftTemplate(shift, 'Europe/London')
  assert.equal(pasteShift(template, 'new', '2026-11-02').start, '2026-11-02T09:00')
  assert.equal(wallTime('2026-10-12T09:00', 'Asia/Kuwait'), '2026-10-12T09:00')
})
test('clock-change edits remain local inputs for server validation rather than inventing offsets', () => {
  const spring = { ...shift, start: '2027-03-28T00:30:00Z', end: '2027-03-28T02:30:00Z' }
  assert.equal(adjustShift(spring, 'Europe/London', 'start', 30).start, '2027-03-28T01:00')
  const repeated = { ...shift, start: '2026-10-25T00:30:00Z', end: '2026-10-25T01:30:00Z' }
  assert.throws(() => shiftTemplate(repeated, 'Europe/London'), /repeated clock-change/)
})
test('duplicate detection compares canonical branch-local times without clobbering other people', () => {
  const pasted = pasteShift(shiftTemplate(shift, 'Europe/London'), shift.employee, '2026-10-12')
  assert.equal(duplicateExists([shift], pasted, 'Europe/London'), true)
  assert.equal(duplicateExists([shift], { ...pasted, employee: 'other' }, 'Europe/London'), false)
})
