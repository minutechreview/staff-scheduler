import assert from 'node:assert/strict'
import { test } from 'node:test'
import { api, ApiError } from '../src/api.ts'

test('abort while reading a successful response remains cancellation', async () => {
  const original = globalThis.fetch
  const aborted = new DOMException('Cancelled body read', 'AbortError')
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw aborted } })
  try { await assert.rejects(api('/schedule'), error => error === aborted) } finally { globalThis.fetch = original }
})

test('malformed successful JSON rejects instead of replacing schedule state', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON') } })
  try { await assert.rejects(api('/schedule'), error => error instanceof ApiError && error.status === 502) } finally { globalThis.fetch = original }
})

test('unreadable unauthorized response preserves its HTTP authority status', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => { throw new SyntaxError('Invalid JSON') } })
  try { await assert.rejects(api('/schedule'), error => error instanceof ApiError && error.status === 401) } finally { globalThis.fetch = original }
})
