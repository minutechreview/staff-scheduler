import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEmailAction } from '../src/emailActions.mjs'

test('ordinary workspace links remain ordinary navigation', () => {
  assert.equal(parseEmailAction('https://app.test/?branch=north&week=2026-10-12&view=schedule'), null)
})
test('supported links retain only mode/code, never provider configuration or redirects', () => {
  for (const mode of ['verifyEmail', 'resetPassword']) {
    assert.deepEqual(parseEmailAction(`https://app.test/?mode=${mode}&oobCode=fixture-code&apiKey=wrong-project-key&continueUrl=https://evil.test&lang=en`), { mode, code: 'fixture-code', error: '' })
  }
})
test('unsupported modes, missing codes, duplicate and escaped-equivalent fields fail closed', () => {
  for (const query of ['mode=recoverEmail&oobCode=x', 'mode=verifyEmail', 'mode=verifyEmail&mode=resetPassword&oobCode=x',
    'mode=verifyEmail&oobCode=x&oob%43ode=y', 'mode=verifyEmail&oobCode=x&apiKey=a&apiKey=b',
    'mode=verifyEmail&oobCode=x&tenantId=other', 'mode=verifyEmail&oobCode=bad%0acode']) {
    const parsed = parseEmailAction(`https://app.test/?${query}`)
    assert.ok(parsed.error)
    assert.equal(parsed.code, '')
  }
})
test('oversized, fragmented and non-ASCII codes are never accepted', () => {
  for (const suffix of [`?mode=verifyEmail&oobCode=${'x'.repeat(1025)}`, '?mode=verifyEmail&oobCode=%C3%A9', '#mode=verifyEmail&oobCode=x']) {
    assert.ok(parseEmailAction('https://app.test/' + suffix).error)
  }
})
