import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
const source = stripTypeScriptTypes(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'))
const { dayPlus, firstDay, duration, localDate, clock } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
test('Friday week crosses month and calendar year', () => {
  assert.equal(firstDay('2026-01-01', 4), '2025-12-26')
  assert.equal(firstDay('2026-10-15', 4), '2026-10-09')
})
test('Calendar day arithmetic is independent of host DST', () => {
  assert.equal(dayPlus('2026-03-08', 1), '2026-03-09')
  assert.equal(dayPlus('2026-12-31', 1), '2027-01-01')
})
test('Overnight and spring DST shifts count elapsed hours', () => {
  assert.equal(duration({ start: '2026-03-08T00:00:00-05:00', end: '2026-03-08T08:00:00-04:00' }), 7)
  assert.equal(duration({ start: '2026-10-12T22:00:00Z', end: '2026-10-13T06:00:00Z' }), 8)
})
test('Employee display uses destination timezone, not host date', () => {
  assert.equal(localDate('2026-10-12T01:00:00Z', 'America/New_York'), '2026-10-11')
  assert.equal(clock('2026-10-12T01:00:00Z', 'America/New_York'), '21:00')
})
