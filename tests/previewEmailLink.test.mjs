import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { parsePreviewEmailLink } from '../src/previewEmailLink.mjs'

const callback = 'https://relay-saas-stg-746234651365.firebaseapp.com/__/auth/action'
const key = 'synthetic-public-key'
const config = { provider_callback: callback, api_key_sha256: createHash('sha256').update(key).digest('hex') }
const link = `${callback}?mode=verifyEmail&oobCode=synthetic-code&apiKey=${key}`
test('pasted link yields only memory action, discarding redirect/config fields', async () => {
  assert.deepEqual(await parsePreviewEmailLink(`${link}&continueUrl=https%3A%2F%2Fevil.test&lang=en`, config), { mode: 'verifyEmail', code: 'synthetic-code', error: '' })
})
test('wrong project, transport, port, path, key and missing fields fail locally', async () => {
  for (const url of [link.replace('relay-saas-stg-', 'other-'), link.replace('https:', 'http:'), link.replace('.com/', '.com:444/'), link.replace('/__/auth/action', '/elsewhere'), link.replace(key, 'wrong'), callback, `${link}#fragment`, `${link}&tenantId=other`]) await assert.rejects(parsePreviewEmailLink(url, config))
})
test('duplicates, unsupported modes, user info and oversized input fail', async () => {
  for (const url of [`${link}&mode=resetPassword`, link.replace('verifyEmail', 'recoverEmail'), link.replace('https://', 'https://owner@'), link + 'x'.repeat(4096)]) await assert.rejects(parsePreviewEmailLink(url, config))
})
