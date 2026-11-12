// Synthetic, loopback-only end-to-end recovery; never sends mail or captures codes.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '../.local/browser-tools/node_modules/playwright/index.mjs'

const base = 'http://127.0.0.1:4329'
const auth = 'http://127.0.0.1:9099'
const report = { synthetic_only: true, base, flows: [], errors: [], recovery_responses: [], screenshots: [] }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
report.browser = browser.version()
await mkdir('output/playwright/recovery', { recursive: true })
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  await context.route('**/*', route => [base, auth].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/api/recovery/')) report.recovery_responses.push({ path, status: response.status() })
  })
  page.setDefaultTimeout(30000)
  return page
}
async function shot(page, name) {
  assert.equal(await page.locator('input[type="password"]').count(), 0, 'Never capture passwords')
  const path = `output/playwright/recovery/${name}.png`
  await page.screenshot({ path, fullPage: true })
  report.screenshots.push(path)
}
async function signin(page, email, password) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await page.getByRole('button', { name: 'Generate draft', exact: true }).waitFor()
}
async function me(page) {
  const response = await page.request.get(`${base}/api/me`)
  assert.equal(response.status(), 200)
  return response.json()
}
async function resetCode(page, email) {
  const response = await page.request.get(`${auth}/emulator/v1/projects/demo-relay-scheduler/oobCodes`)
  assert.equal(response.status(), 200)
  const codes = (await response.json()).oobCodes.filter(row => row.email === email && row.requestType === 'PASSWORD_RESET')
  assert.ok(codes.length)
  return codes.at(-1).oobCode
}
try {
  const desktop = await pageFor({ width: 1440, height: 1000 })
  const email = `recovery-browser-${Date.now()}@example.test`
  const oldPassword = 'synthetic-old-password-123'
  const newPassword = 'synthetic-new-password-456'
  await desktop.goto(base)
  await desktop.getByRole('button', { name: 'Start your workspace' }).click()
  await desktop.getByLabel('Your name').fill('Synthetic Recovery Owner')
  await desktop.getByLabel('Organization name').fill('Synthetic Recovery Workspace')
  await desktop.getByLabel('Email', { exact: true }).fill(email)
  await desktop.getByLabel('Password', { exact: true }).fill(oldPassword)
  await desktop.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await desktop.getByText('Verify your synthetic email before signing in.', { exact: true }).waitFor()
  const popupPromise = desktop.waitForEvent('popup')
  await desktop.getByRole('link', { name: 'Open local verification link' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await popup.close()
  await desktop.getByRole('button', { name: 'Email verified — sign in' }).click()
  await desktop.getByLabel('Email', { exact: true }).fill(email)
  await desktop.getByLabel('Password', { exact: true }).fill(oldPassword)
  await desktop.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await desktop.getByRole('button', { name: 'Set up synthetic demo' }).click()
  await desktop.getByRole('button', { name: 'Generate draft', exact: true }).waitFor()
  const before = await me(desktop)
  assert.equal(before.employees.length, 24)
  await shot(desktop, 'desktop-workspace')

  const mobile = await pageFor({ width: 390, height: 844 })
  await mobile.goto(base)
  await mobile.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await signin(mobile, email, oldPassword)
  const oldCookies = await mobile.context().cookies(base)
  await desktop.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true }).click()
  await desktop.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await desktop.getByRole('button', { name: 'Forgot your password?' }).click()
  await desktop.getByLabel('Synthetic email').fill(email)
  await desktop.getByRole('button', { name: 'Request recovery', exact: true }).click()
  const generic = desktop.getByRole('status').filter({ hasText: 'If this identity is eligible' })
  await generic.waitFor()
  await desktop.getByLabel('Synthetic email').fill('')
  await shot(desktop, 'desktop-recovery-request')
  const code = await resetCode(desktop, email)
  await desktop.getByRole('button', { name: 'Enter a recovery code' }).click()
  await desktop.getByLabel('Recovery code').fill(code)
  await desktop.getByLabel('New password').fill(newPassword)
  await desktop.getByRole('button', { name: 'Reset password', exact: true }).click()
  await desktop.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  assert.equal((await mobile.request.get(`${base}/api/me`)).status(), 401, 'Other existing session revoked')
  const old = await desktop.request.post(`${base}/api/signin`, { data: { email, password: oldPassword } })
  assert.equal(old.status(), 401)
  const reused = await desktop.request.post(`${base}/api/recovery/complete`, { data: { code, password: newPassword } })
  assert.equal(reused.status(), 401, 'Reset code is one-use')
  assert.ok(oldCookies.some(cookie => cookie.name === '__session'))
  await signin(desktop, email, newPassword)
  const restored = await me(desktop)
  assert.equal(restored.user.org, before.user.org)
  assert.deepEqual(restored.employees.map(row => row.id).sort(), before.employees.map(row => row.id).sort())
  await desktop.reload()
  await desktop.getByRole('button', { name: 'Generate draft', exact: true }).waitFor()
  report.flows.push('desktop signup, local verification, onboarding, generic recovery request, password reset, other-session/old-password/used-code denial, same-organization/staff and reload persistence')

  await mobile.reload()
  await mobile.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await mobile.getByRole('button', { name: 'Forgot your password?' }).click()
  await mobile.getByLabel('Synthetic email').fill(email)
  await mobile.getByRole('button', { name: 'Request recovery', exact: true }).click()
  await mobile.getByRole('status').filter({ hasText: 'If this identity is eligible' }).waitFor()
  await mobile.getByLabel('Synthetic email').fill('')
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await shot(mobile, 'mobile-recovery-request')
  const mobileCode = await resetCode(mobile, email)
  await mobile.goto(`${base}/?mode=resetPassword&oobCode=${encodeURIComponent(mobileCode)}`)
  await mobile.getByLabel('Recovery code').waitFor()
  assert.equal(await mobile.getByLabel('Recovery code').inputValue(), mobileCode)
  await mobile.getByLabel('New password').fill('synthetic-mobile-password-789')
  await mobile.getByRole('button', { name: 'Reset password', exact: true }).click()
  await mobile.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  assert.equal(new URL(mobile.url()).search, '', 'Remove action code from address bar')
  await signin(mobile, email, 'synthetic-mobile-password-789')
  assert.equal((await me(mobile)).user.org, before.user.org)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await mobile.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true }).click()
  await mobile.getByRole('heading', { name: /A better week/ }).waitFor()
  assert.equal((await mobile.request.get(`${base}/api/me`)).status(), 401)
  report.flows.push('390px recovery request, action-link code prefill, password reset and URL cleanup, same-organization signin and signout, no horizontal overflow')
  assert.deepEqual(report.errors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = String(error).replace(/oobCode=[^&\s]+/g, 'oobCode=[redacted]')
  throw error
} finally {
  await writeFile('docs/validation/production-browser-recovery.json', JSON.stringify(report, null, 2) + '\n')
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
