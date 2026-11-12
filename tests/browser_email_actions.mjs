// Real browser + real local HTTP/lifecycle routes + synthetic in-memory issuer.
// Never connects to Firebase, sends email, or records action codes/passwords.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const { chromium } = await import(process.env.RELAY_PLAYWRIGHT_MODULE || '../.local/browser-tools/node_modules/playwright/index.mjs')
const base = 'http://127.0.0.1:4331'
const output = 'output/playwright/email-actions-20261020'
const report = { base, synthetic_only: true, real_email_delivery: false, flows: [], page_errors: [], screenshots: [] }
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
report.browser = browser.version()
const pages = []
async function pageFor(mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1050, height: 896 }, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' })
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const stats = { checks: 0, completes: 0, bootstrap: 0 }
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === '/api/auth/action/check') stats.checks++
    if (path === '/api/auth/action/complete') stats.completes++
    if (path === '/api/me') stats.bootstrap++
  })
  page.on('pageerror', error => report.page_errors.push(error.message))
  pages.push(page)
  return { page, stats }
}
async function open(page, mode, code, extra = '') {
  await page.goto(`${base}/?mode=${mode}&oobCode=${encodeURIComponent(code)}${extra}`)
  await page.getByRole('heading', { name: mode === 'resetPassword' ? 'Reset your password.' : 'Verify your email.' }).waitFor()
  await page.waitForFunction(() => location.search === '' && location.hash === '')
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).length + Object.keys(localStorage).length), 0)
}
async function capture(page, name) {
  assert.equal(await page.locator('input[type=password]').count(), 0)
  assert.equal(new URL(page.url()).search, '')
  const path = `${output}/${name}.png`; await page.screenshot({ path }); report.screenshots.push(path)
}
try {
  const { page: verify, stats: verification } = await pageFor()
  await verify.context().addCookies([{ name: 'relay_session', value: 'synthetic-existing-session', url: base }])
  await open(verify, 'verifyEmail', 'fixture-verify', '&apiKey=untrusted-other-project&continueUrl=https%3A%2F%2Fevil.test')
  await verify.getByRole('button', { name: 'Verify email', exact: true }).click()
  await verify.getByRole('status').filter({ hasText: 'Email verified.' }).waitFor()
  assert.equal(verification.bootstrap, 0, 'Existing cookies never override an incoming action')
  assert.equal(verification.completes, 1)
  assert.equal(new URL(verify.url()).origin, base)
  await capture(verify, '01-verification-complete')
  await verify.getByRole('button', { name: 'Continue to sign in', exact: true }).click()
  await verify.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  report.flows.push('Verification completes via local server, ignores supplied API key/redirect, scrubs URL/storage and does not bootstrap or mint a session from an existing cookie')

  for (const code of ['fixture-expired', 'fixture-used', 'invalid', 'fixture-reset']) {
    const { page, stats } = await pageFor()
    await open(page, 'verifyEmail', code)
    await page.getByRole('button', { name: 'Verify email', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'invalid, expired or already used' }).waitFor()
    assert.equal(stats.completes, 0)
  }
  report.flows.push('Invalid, expired, reused and wrong-purpose links stop before completion')

  const { page: invalid, stats: invalidStats } = await pageFor()
  await invalid.goto(`${base}/?mode=verifyEmail&mode=resetPassword&oobCode=fixture-verify`)
  await invalid.getByRole('alert').filter({ hasText: 'ambiguous' }).waitFor()
  assert.equal(new URL(invalid.url()).search, '')
  assert.equal(invalidStats.checks + invalidStats.completes + invalidStats.bootstrap, 0)
  await invalid.goto(`${base}/?mode=recoverEmail&oobCode=fixture-recover`)
  await invalid.getByRole('alert').filter({ hasText: 'unsupported' }).waitFor()
  assert.equal(invalidStats.checks + invalidStats.completes, 0)
  report.flows.push('Duplicate query and unsupported recover-email mode fail locally without identity calls')

  const { page: double, stats: doubleStats } = await pageFor()
  let releaseDouble, reachedDouble
  const heldDouble = new Promise(resolve => { releaseDouble = resolve })
  const doubleReached = new Promise(resolve => { reachedDouble = resolve })
  await double.route('**/api/auth/action/complete', async route => { reachedDouble(); await heldDouble; await route.continue() })
  await open(double, 'verifyEmail', 'fixture-verify-double')
  await double.getByRole('button', { name: 'Verify email', exact: true }).waitFor()
  await double.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await doubleReached
  assert.equal(await double.getByRole('button', { name: 'Back to sign in', exact: true }).isDisabled(), true)
  assert.equal(doubleStats.completes, 1)
  releaseDouble()
  await double.getByRole('status').filter({ hasText: 'Email verified.' }).waitFor()
  assert.equal(doubleStats.checks, 1)
  report.flows.push('Repeated submits share one locked attempt; navigation is disabled while completion is pending')

  const { page: interrupted, stats: interruption } = await pageFor()
  let releaseInterrupted, markApplied
  const heldInterrupted = new Promise(resolve => { releaseInterrupted = resolve })
  const applied = new Promise(resolve => { markApplied = resolve })
  await interrupted.route('**/api/auth/action/complete', async route => {
    const response = await route.fetch(); markApplied(); await heldInterrupted
    try { await route.fulfill({ response }) } catch { /* client may already be disconnected */ }
  })
  await open(interrupted, 'verifyEmail', 'fixture-verify-interrupted')
  await interrupted.getByRole('button', { name: 'Verify email', exact: true }).click()
  await applied
  await interrupted.getByRole('button', { name: 'Stop waiting', exact: true }).click()
  await interrupted.getByRole('alert').filter({ hasText: 'does not undo' }).waitFor()
  releaseInterrupted()
  await interrupted.getByRole('button', { name: 'Check link status', exact: true }).click()
  await interrupted.getByRole('alert').filter({ hasText: 'invalid, expired or already used' }).waitFor()
  assert.equal(interruption.completes, 1, 'An applied-but-disconnected action is never replayed')
  report.flows.push('Stopping after server apply reports uncertainty; explicit status check discovers consumed code without replay')

  const { page: pending, stats: pendingStats } = await pageFor()
  await open(pending, 'verifyEmail', 'fixture-verify-pending')
  await pending.getByRole('button', { name: 'Verify email', exact: true }).click()
  await pending.getByRole('alert').filter({ hasText: 'already submitted' }).waitFor()
  await pending.getByRole('button', { name: 'Check link status', exact: true }).click()
  await pending.getByRole('alert').filter({ hasText: 'already submitted' }).waitFor()
  assert.equal(pendingStats.completes, 0)
  report.flows.push('A valid code with a prior transactional submission remains fenced after repeated status checks')

  const { page: navigation, stats: navigationStats } = await pageFor()
  await navigation.goto(base)
  await open(navigation, 'verifyEmail', 'fixture-verify-navigation')
  await navigation.getByRole('button', { name: 'Back to sign in', exact: true }).click()
  await navigation.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  assert.equal(navigationStats.checks + navigationStats.completes, 0)
  await navigation.goBack(); await navigation.goForward()
  assert.equal(new URL(navigation.url()).search, '')
  assert.equal(navigationStats.completes, 0)
  const { page: reload, stats: reloadStats } = await pageFor()
  await open(reload, 'verifyEmail', 'fixture-verify-reload')
  await reload.getByRole('button', { name: 'Verify email', exact: true }).waitFor()
  await reload.reload()
  await reload.getByRole('heading', { name: /A better week/ }).waitFor()
  assert.equal(reloadStats.checks + reloadStats.completes, 0)
  report.flows.push('Cancel/back/forward and reload retain no action code and never consume a link automatically')

  const { page: popstate, stats: popstateStats } = await pageFor()
  let releaseNavigation, markChecking
  const heldNavigation = new Promise(resolve => { releaseNavigation = resolve })
  const checking = new Promise(resolve => { markChecking = resolve })
  await popstate.route('**/api/auth/action/check', async route => { markChecking(); await heldNavigation; try { await route.abort() } catch { /* canceled by navigation */ } })
  await open(popstate, 'verifyEmail', 'fixture-verify-popstate')
  await popstate.getByRole('button', { name: 'Verify email', exact: true }).click()
  await checking
  await popstate.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')) })
  await popstate.getByRole('heading', { name: /A better week/ }).waitFor()
  releaseNavigation()
  assert.equal(popstateStats.completes, 0)
  report.flows.push('Browser navigation during a pending check aborts the client wait and never submits completion')

  const { page: timeout, stats: timeoutStats } = await pageFor()
  await timeout.clock.install()
  let releaseTimeout, markTimeout
  const heldTimeout = new Promise(resolve => { releaseTimeout = resolve })
  const timeoutReached = new Promise(resolve => { markTimeout = resolve })
  await timeout.route('**/api/auth/action/check', async route => { markTimeout(); await heldTimeout; try { await route.abort() } catch { /* client timed out */ } })
  await open(timeout, 'verifyEmail', 'fixture-verify-timeout')
  await timeout.getByRole('button', { name: 'Verify email', exact: true }).click()
  await timeoutReached
  await timeout.clock.fastForward(50001)
  await timeout.getByRole('alert').filter({ hasText: 'Stopped waiting' }).waitFor()
  releaseTimeout()
  assert.equal(timeoutStats.completes, 0)
  report.flows.push('A 50-second bounded client wait reports uncertainty without automatic retries or completion')

  const { page: disabled, stats: disabledStats } = await pageFor()
  await disabled.route('**/api/capabilities', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic disabled provider' }) }))
  await open(disabled, 'verifyEmail', 'fixture-verify-navigation')
  await disabled.getByRole('alert').filter({ hasText: 'paused or unavailable' }).waitFor()
  await disabled.getByRole('button', { name: 'Check availability', exact: true }).click()
  await disabled.getByRole('alert').filter({ hasText: 'paused or unavailable' }).waitFor()
  assert.equal(disabledStats.checks + disabledStats.completes, 0)
  report.flows.push('Disabled service stays unavailable; availability retry sends no completion or email request')

  for (const [mobile, code] of [[false, 'fixture-reset'], [true, 'fixture-reset-mobile']]) {
    const { page, stats } = await pageFor(mobile)
    await open(page, 'resetPassword', code)
    await page.getByLabel('New password', { exact: true }).fill('synthetic-new-password-456')
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Password updated.' }).waitFor()
    assert.equal(stats.checks, 1); assert.equal(stats.completes, 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await capture(page, mobile ? '03-mobile-reset-complete' : '02-desktop-reset-complete')
    await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click()
    await page.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  }
  report.flows.push('Desktop and 390px mobile reset through actual local lifecycle routes, clear password/code after success and return to sign-in without horizontal overflow')
  assert.deepEqual(report.page_errors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = 'A browser assertion failed; action URLs and credentials are intentionally omitted.'
  throw error
} finally {
  await writeFile('docs/validation/email-actions-browser-20261020.json', JSON.stringify(report, null, 2) + '\n')
  await browser.close(); console.log(JSON.stringify(report, null, 2))
}
