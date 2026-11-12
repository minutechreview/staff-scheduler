// Optional local validation runner. Requires Playwright in .local/browser-tools.
// Uses a dedicated loopback test DB; never targets a public deployment.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '../.local/browser-tools/node_modules/playwright/index.mjs'

const base = process.env.RELAY_BROWSER_BASE_URL || 'http://127.0.0.1:4329'
assert.equal(new URL(base).hostname, '127.0.0.1')
assert.equal(new URL(base).port, '4329', 'Use the isolated browser database on port 4329')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const report = { browser: browser.version(), base, synthetic_only: true, flows: [], page_errors: [], console_errors: [], unexpected_api_failures: [], schedule_response_shapes: [], screenshots: [] }
const contexts = []
const suffix = Date.now()
const emails = { owner: `patch-owner-${suffix}@example.test`, manager: `patch-manager-${suffix}@example.test`, employee: `patch-employee-${suffix}@example.test` }
const password = 'synthetic-patch-preview-123'
await mkdir('output/playwright/firebase', { recursive: true })
async function newPage(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  contexts.push(context)
  await context.route('**/*', route => [new URL(base).origin, 'http://127.0.0.1:9099'].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', error => report.page_errors.push(error.stack || error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('401')) report.console_errors.push(message.text()) })
  page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400 && response.status() !== 401) report.unexpected_api_failures.push({ path: new URL(response.url()).pathname, status: response.status() }) })
  page.on('response', async response => { if (/\/api\/(schedule|generate)(?:\?|$)/.test(response.url())) { const body = await response.json().catch(() => ({})); report.schedule_response_shapes.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status(), keys: Object.keys(body), shift_count: body.shifts?.length, shift_type: typeof body.shifts }); } })
  await page.goto(base)
  return page
}
async function shot(page, name) {
  const path = `output/playwright/firebase/${name}.png`
  await page.screenshot({ path, fullPage: true })
  report.screenshots.push(path)
}
async function nav(page, name) { await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name, exact: true }).click() }
async function signIn(page, email) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await page.getByText('Verify your synthetic email before signing in.', { exact: true }).waitFor()
  await verify(page)
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await page.getByRole('heading', { name: /Build a better week|Your published week/ }).waitFor()
}
async function verify(page) {
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open local verification link' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await popup.close()
  await page.getByRole('button', { name: 'Email verified — sign in' }).click()
}
async function me(page) { const response = await page.request.get(`${base}/api/me`); assert.equal(response.status(), 200); return response.json() }
async function fixture(page, path, body) {
  const state = await me(page)
  const response = await page.request.post(`${base}/api${path}`, { data: body, headers: { 'X-CSRF-Token': state.user.csrf } })
  assert.equal(response.status(), 200, await response.text())
  return response.json()
}
try {
  const owner = await newPage()
  await owner.getByRole('heading', { name: /A better week/ }).waitFor()
  await owner.keyboard.press('Tab')
  assert.ok(await owner.locator(':focus').count(), 'Landing supports keyboard focus')
  await shot(owner, 'landing-desktop')
  await owner.getByRole('button', { name: 'Start your workspace' }).click()
  await owner.getByLabel('Your name').fill('Synthetic Patch Owner')
  await owner.getByLabel('Organization name').fill('Synthetic Dependency Validation')
  await owner.getByLabel('Email', { exact: true }).fill(emails.owner)
  await owner.getByLabel('Password', { exact: true }).fill(password)
  await owner.getByRole('button', { name: 'Create workspace' }).click()
  await owner.getByText('Verify your synthetic email before signing in.', { exact: true }).waitFor()
  await shot(owner, 'verify-email-desktop')
  await verify(owner)
  await owner.getByLabel('Email', { exact: true }).fill(emails.owner)
  await owner.getByLabel('Password', { exact: true }).fill(password)
  await owner.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await owner.getByRole('button', { name: 'Set up synthetic demo' }).click()
  await owner.getByRole('button', { name: 'Generate draft' }).waitFor()
  await owner.getByRole('button', { name: 'Next week', exact: true }).click()
  await owner.getByRole('button', { name: 'Next week', exact: true }).click()
  await owner.getByRole('button', { name: 'Generate draft' }).click()
  await owner.getByRole('button', { name: 'Save reviewed draft' }).click()
  await owner.getByRole('status').filter({ hasText: 'Draft saved' }).waitFor()
  await owner.getByRole('button', { name: 'Publish week', exact: true }).click()
  const publish = owner.getByRole('dialog', { name: 'Review and publish' })
  const acknowledge = publish.getByRole('checkbox')
  if (await acknowledge.count()) await acknowledge.check()
  await publish.getByRole('button', { name: 'Publish this version' }).click()
  await owner.getByRole('status').filter({ hasText: 'Published.' }).waitFor()
  await owner.getByRole('button', { name: 'History', exact: true }).click()
  await owner.getByRole('heading', { name: 'Version history' }).waitFor()
  assert.ok(await owner.locator('.shift').count() > 0)
  await shot(owner, 'schedule-desktop')
  report.flows.push('desktop Firebase signup → local OOB email verification → Firebase signin → native Firestore synthetic onboarding → next-week navigation → generation/review/save → publish → history')

  await nav(owner, 'People')
  await owner.getByRole('button', { name: 'Edit', exact: true }).first().click()
  const edit = owner.getByRole('dialog', { name: 'Edit team member' })
  await edit.getByLabel('Hourly rate (optional, configured currency units)').fill('17.25')
  await edit.getByRole('button', { name: 'Save team member' }).click()
  await edit.waitFor({ state: 'hidden' })
  const state = await me(owner)
  const branch = state.branches[0]
  const person = state.employees.find(employee => employee.branch === branch.id && employee.hourly_rate === 17.25)
  assert.ok(person)
  await fixture(owner, '/members', { name: 'Synthetic Patch Manager', email: emails.manager, password, role: 'branch_manager', branches: [branch.id] })
  await fixture(owner, '/members', { name: 'Synthetic Patch Employee', email: emails.employee, password, role: 'employee', employee: person.id, branches: [branch.id] })
  // Fixtures establish roles via the authorized API; member creation UI is not claimed here.
  const manager = await newPage()
  await signIn(manager, emails.manager)
  await nav(manager, 'People')
  await manager.getByRole('button', { name: 'Edit', exact: true }).first().click()
  const managerEdit = manager.getByRole('dialog', { name: 'Edit team member' })
  assert.equal(await managerEdit.getByLabel('Hourly rate (optional, configured currency units)').count(), 0)
  await managerEdit.getByRole('button', { name: 'Save team member' }).click()
  await managerEdit.waitFor({ state: 'hidden' })
  assert.ok((await me(manager)).employees.every(employee => !Object.hasOwn(employee, 'hourly_rate')))
  assert.equal((await me(owner)).employees.find(employee => employee.id === person.id).hourly_rate, 17.25)
  report.flows.push('owner wage edit; manager form omits wages; ordinary manager save preserves hidden rate')

  await nav(owner, 'Demand & labor')
  await owner.getByLabel('Transactions per labor hour target').fill('20')
  await owner.getByRole('button', { name: 'Save approved baseline' }).click()
  const csv = 'start,end,transactions,kind,granularity,role,units\n2026-10-12T09:00,2026-10-12T10:00,40,forecast,interval,associate,transactions'
  await owner.getByLabel('Or paste / manually enter CSV').fill(csv)
  await owner.getByRole('button', { name: 'Validate & preview' }).click()
  await owner.getByRole('heading', { name: '1 valid row(s) ready' }).waitFor()
  await owner.getByRole('button', { name: 'Confirm validated import' }).click()
  await owner.getByRole('button', { name: 'Confirm validated import' }).waitFor({ state: 'hidden' })
  await shot(owner, 'demand-desktop')
  report.flows.push('configured labor baseline → CSV preview → explicit confirmed import')
  await nav(owner, 'Assistant')
  await owner.getByRole('button', { name: 'How many active employees?', exact: true }).click()
  await owner.getByRole('button', { name: 'Get sourced answer' }).click()
  await owner.getByRole('heading', { name: /24 active employee/ }).waitFor()
  report.flows.push('read-only scoped deterministic assistant answer')

  const employee = await newPage({ width: 390, height: 844 })
  await signIn(employee, emails.employee)
  await employee.getByRole('button', { name: 'Next week', exact: true }).click()
  await employee.getByRole('button', { name: 'Next week', exact: true }).click()
  await employee.locator('.employee-shift').first().waitFor()
  assert.equal(await employee.locator('.schedule-table').count(), 0)
  assert.ok((await me(employee)).employees.every(employee => !Object.hasOwn(employee, 'hourly_rate')))
  await employee.getByRole('button', { name: 'Edit availability' }).click()
  await employee.getByRole('button', { name: 'Save availability' }).click()
  await employee.getByRole('button', { name: 'Save availability' }).waitFor({ state: 'hidden' })
  await employee.getByRole('button', { name: 'View your leave ledger' }).click()
  await employee.getByRole('dialog', { name: 'Your annual leave ledger' }).waitFor()
  await employee.getByRole('button', { name: 'Close dialog' }).click()
  await shot(employee, 'employee-mobile')
  assert.equal(await employee.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await employee.reload()
  await employee.getByRole('heading', { name: 'Your published week.' }).waitFor()
  await employee.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true }).click()
  await employee.getByRole('heading', { name: /A better week/ }).waitFor()
  report.flows.push('390px employee signin → personal published shifts → availability save → ledger → reload persistence → signout; no horizontal document overflow')
  assert.deepEqual(report.page_errors, [])
  assert.deepEqual(report.console_errors, [])
  assert.deepEqual(report.unexpected_api_failures, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = String(error)
  if (contexts[0]?.pages()[0]) await shot(contexts[0].pages()[0], 'failure-owner')
  throw error
} finally {
  await writeFile('docs/validation/firebase-browser-results.json', JSON.stringify(report, null, 2) + '\n')
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
