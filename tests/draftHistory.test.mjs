import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyDraftHistory, canTravelDraft, rememberDraft, travelDraft } from '../src/draftHistory.mjs'

test('multiple undo/redo steps follow fresh server revisions and preserve snapshots', () => {
  const first = [{ id: 'a', start: '09:00' }], second = [{ id: 'a', start: '09:30' }], third = [{ id: 'a', start: '10:00' }]
  let history = rememberDraft(emptyDraftHistory(), first, 1, 2)
  history = rememberDraft(history, second, 2, 3)
  assert.deepEqual(history.past.at(-1).shifts, second)
  history = travelDraft(history, 'past', third, 3, 4)
  assert.deepEqual(history.past.at(-1).shifts, first)
  assert.equal(canTravelDraft(history, 'past', 4), true)
  history = travelDraft(history, 'past', second, 4, 5)
  assert.equal(canTravelDraft(history, 'past', 5), false)
  assert.deepEqual(history.future.at(-1).shifts, second)
  history = travelDraft(history, 'future', first, 5, 6)
  assert.deepEqual(history.future.at(-1).shifts, third)
  history = travelDraft(history, 'future', second, 6, 7)
  assert.equal(history.future.length, 0)
  assert.deepEqual(history.past.at(-1).shifts, second)
  assert.equal(canTravelDraft(history, 'past', 7), true)
  assert.deepEqual(first, [{ id: 'a', start: '09:00' }])
})

test('editing after undo discards redo; a changed revision invalidates old history', () => {
  let history = rememberDraft(emptyDraftHistory(), [], 0, 1)
  history = travelDraft(history, 'past', [{ id: 'new' }], 1, 2)
  assert.equal(canTravelDraft(history, 'future', 2), true)
  history = rememberDraft(history, [], 2, 3)
  assert.equal(history.future.length, 0)
  assert.equal(canTravelDraft(history, 'past', 4), false)
  assert.deepEqual(travelDraft(history, 'past', [], 4, 5), emptyDraftHistory())
  assert.equal(rememberDraft(history, [], 4, 5).past.length, 1)
})

test('draft history caps retained snapshots and does not alias input arrays', () => {
  let history = emptyDraftHistory()
  const source = []
  for (let revision = 1; revision <= 25; revision++) history = rememberDraft(history, source, revision - 1, revision)
  source.push({ id: 'later' })
  assert.equal(history.past.length, 20)
  assert.deepEqual(history.past.at(-1).shifts, [])
})
