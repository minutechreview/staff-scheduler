// Entry UX fixtures only. Actual Auth/Firestore policy is tested natively.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
const { chromium } = await import('../.local/browser-tools/node_modules/playwright/index.mjs')
const base = 'http://127.0.0.1:4333'
const callback = 'https://relay-saas-stg-746234651365.firebaseapp.com/__/auth/action'
const key = 'synthetic-browser-public-key'
const password = 'synthetic-browser-old-password-123', newPassword = 'synthetic-browser-new-password-456'
const output = 'output/playwright/email-preview-20261020'
const report = { real_email: false, transport: 'Loopback static HTTP with stateful API fixtures; not hosted IAP/TLS proof', flows: [], screenshots: [], page_errors: [] }
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
report.browser = browser.version()
const contexts = []
const started = Date.now()
async function pageFor(mobile = false, expired = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1050, height: 896 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' })
  contexts.push(context)
  const state = { verified: false, password, signed: false, signup: 0, reset: 0, checks: 0, completes: 0, requests: 0, posts: 0, used: new Set(), actionUrls: 0 }
  const config = { recipient: 'owner@example.test', starts_at: Date.now() / 1000 - 10, expires_at: Date.now() / 1000 + (expired ? -1 : 300), provider_callback: callback, api_key_sha256: createHash('sha256').update(key).digest('hex') }
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== base) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    state.requests++
    if (route.request().method() === 'POST') state.posts++
    if (url.search) state.actionUrls++
    const path = url.pathname.slice(4), body = route.request().postDataJSON() || {}
    let status = 200, result = {}
    if (path === '/preview') result = config
    else if (expired) { status = 503; result = { error: 'The preview window is closed.' } }
    else if (path === '/capabilities') result = { email_actions: true, recovery: true }
    else if (path === '/signup') { state.signup++; result = { verification_required: true, message: 'The single verification message was requested.' } }
    else if (path === '/signin') {
      if (!state.verified || body.password !== state.password) { status = 401; result = { error: 'Invalid credentials.' } }
      else { state.signed = true; result = { user: { email: config.recipient, id: 'synthetic-preview-owner', org: 'synthetic-preview-org', csrf: 'synthetic-csrf' } } }
    } else if (path === '/me') {
      if (!state.signed) { status = 401; result = { error: 'Sign in to continue.' } }
      else result = { user: { email: config.recipient } }
    } else if (path === '/signout') state.signed = false
    else if (path === '/recovery/request') { state.reset++; result = { message: 'If eligible, the one reset message was requested.' } }
    else if (path === '/auth/action/check') {
      state.checks++
      if (state.used.has(body.code)) { status = 401; result = { error: 'Invalid or used.' } }
      else result = { valid: true, submitted_before: false }
    } else if (path === '/auth/action/complete') {
      state.completes++; state.used.add(body.code)
      if (body.mode === 'verifyEmail') { state.verified = true; result = { verified: true } }
      else { state.password = body.password; state.signed = false; result = { signed_out: true } }
    } else { status = 403; result = { error: 'Outside scope.' } }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) })
  })
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.page_errors.push(error.message))
  await page.goto(base + '/preview.html')
  await page.getByText('Approved inbox:').waitFor()
  return { page, state, config }
}
function link(mode = 'verifyEmail', code = 'synthetic-verification-code') { return `${callback}?mode=${mode}&oobCode=${code}&apiKey=${key}&continueUrl=https%3A%2F%2Fevil.test` }
async function paste(page, value) {
  await page.getByRole('button', { name: 'Paste email link', exact: true }).click()
  await page.getByLabel('Original email link').fill(value)
  await page.getByRole('button', { name: 'Review this email action' }).click()
}
async function screenshot(page, name) {
  assert.equal(await page.locator('input[type=password],textarea').count(), 0)
  assert.equal(new URL(page.url()).search, '')
  const path = `${output}/${name}.png`; await page.screenshot({ path }); report.screenshots.push(path)
}
try {
  const { page, state } = await pageFor()
  await screenshot(page, '01-owner-test-steps')
  await page.getByRole('button', { name: 'Create test account', exact: true }).click()
  assert.equal(await page.getByLabel('Email', { exact: true }).isEditable(), false)
  await page.getByLabel('Staging password').fill(password)
  await page.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await page.getByRole('status').filter({ hasText: 'single verification' }).waitFor()
  assert.equal(state.signup, 1)
  assert.equal(await page.getByRole('button', { name: 'Create test account', exact: true }).isDisabled(), true)
  report.flows.push('Approved inbox is read-only; double signup submission is locked and no resend control appears')

  await paste(page, link().replace(key, 'wrong-project-key'))
  await page.getByRole('alert').filter({ hasText: 'original verification or reset link' }).waitFor()
  assert.equal(await page.getByLabel('Original email link').inputValue(), '')
  assert.equal(state.checks + state.completes, 0)
  await page.getByLabel('Original email link').fill(link())
  await page.getByRole('button', { name: 'Review this email action' }).click()
  await page.getByRole('heading', { name: 'Verify your email.' }).waitFor()
  assert.equal(state.checks + state.completes, 0, 'Review never applies a code')
  await page.getByRole('button', { name: 'Verify email', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Email verified.' }).waitFor()
  assert.equal(state.completes, 1)
  await screenshot(page, '02-verification-complete')
  report.flows.push('Wrong project fails locally; valid pasted code stays out of URL/storage and explicit confirmation applies once')

  await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click()
  await page.getByLabel('Staging password').fill(password)
  await page.getByRole('button', { name: 'Sign in to test workspace', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Signed in to the fictional' }).waitFor()
  await page.getByRole('button', { name: 'Request the one reset email' }).click()
  await page.getByRole('status').filter({ hasText: 'one reset message' }).waitFor()
  assert.equal(state.reset, 1)
  assert.equal(await page.getByRole('button', { name: 'Request the one reset email' }).isDisabled(), true)
  await paste(page, link('resetPassword', 'synthetic-reset-code'))
  await page.getByRole('heading', { name: 'Reset your password.' }).waitFor()
  await page.getByLabel('New password').fill(newPassword)
  await page.getByRole('button', { name: 'Reset password', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Password updated.' }).waitFor()
  await screenshot(page, '03-reset-complete')
  await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click()
  await page.getByLabel('Staging password').fill(password)
  await page.getByRole('button', { name: 'Sign in to test workspace', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Invalid credentials' }).waitFor()
  assert.equal(await page.getByLabel('Staging password').inputValue(), '')
  await page.getByLabel('Staging password').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in to test workspace', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Signed in to the fictional' }).waitFor()
  assert.equal(state.actionUrls, 0)
  assert.equal(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length), 0)
  report.flows.push('Owner-mediated reset asks once; passwords clear after response, old-password error and new-password sign-in work through UI fixtures')

  const mobile = await pageFor(true)
  await screenshot(mobile.page, '04-mobile-test-steps')
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  await mobile.page.getByRole('button', { name: 'Paste email link', exact: true }).click()
  await mobile.page.getByLabel('Original email link').fill(link())
  await mobile.page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await mobile.page.waitForFunction(() => document.querySelector('textarea')?.value === '')
  assert.equal(await mobile.page.getByLabel('Original email link').inputValue(), '')
  assert.equal(mobile.state.checks + mobile.state.completes, 0)
  report.flows.push('390px touch layout fits viewport; page hiding clears an unsubmitted link without applying it')

  const closed = await pageFor(false, true)
  await closed.page.getByRole('alert').filter({ hasText: 'window is closed' }).waitFor()
  assert.equal(await closed.page.getByRole('button', { name: 'Create test account', exact: true }).count(), 0)
  assert.equal(closed.state.posts, 0)
  report.flows.push('Expired preview displays a closed state and exposes no account, send or action submission')

  const expiry = await pageFor()
  await expiry.page.clock.install()
  await expiry.page.getByRole('button', { name: 'Paste email link', exact: true }).click()
  await expiry.page.getByLabel('Original email link').fill(link())
  await expiry.page.clock.fastForward(301000)
  await expiry.page.getByRole('alert').filter({ hasText: 'window is closed' }).waitFor()
  assert.equal(await expiry.page.locator('textarea,input[type=password]').count(), 0)
  assert.equal(expiry.state.completes, 0)
  report.flows.push('Absolute client expiry removes sensitive fields; server-side expiry is independently tested')

  assert.deepEqual(report.page_errors, [])
  report.success = true
} catch (error) {
  report.success = false; report.failure = error.constructor.name
  // Assertion details may contain synthetic passwords/action links. Keep them
  // inside the test process rather than emitting them in console/tool output.
  process.exitCode = 1
} finally {
  for (const context of contexts) await context.close()
  await browser.close()
  report.seconds = (Date.now() - started) / 1000
  await writeFile('docs/validation/email-preview-browser-20261020.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ success: report.success, flows: report.flows.length, page_errors: report.page_errors.length, seconds: report.seconds, failure: report.failure }))
}
