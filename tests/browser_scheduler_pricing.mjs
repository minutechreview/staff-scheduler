// Local built frontend with synthetic route responses; no external provider.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
const { chromium } = await import('../.local/browser-tools/node_modules/playwright/index.mjs')
const root = resolve('dist')
const output = 'output/playwright/scheduler-pricing-20261110'
await mkdir(output, { recursive: true })
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const path = resolve(root, '.' + pathname)
  if (!path.startsWith(root + '/') && path !== root) { res.writeHead(403).end(); return }
  try {
    const actual = extname(pathname) ? path : root + '/index.html'
    const data = await readFile(actual)
    res.writeHead(200, { 'Content-Type': actual.endsWith('.js') ? 'text/javascript' : actual.endsWith('.css') ? 'text/css' : actual.endsWith('.html') ? 'text/html' : 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404).end() }
})
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
let browser
const report = { synthetic_only: true, provider_calls: 0, checkout_requests: 0, flows: [], errors: [] }
try {
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', e => report.errors.push(e.message))
    await page.route('**/*', async route => {
      const u = new URL(route.request().url())
      if (u.origin !== base) { report.provider_calls++; return route.abort() }
      if (!u.pathname.startsWith('/api/')) return route.continue()
      if (u.pathname === '/api/capabilities') return route.fulfill({ json: { synthetic_only: true } })
      if (u.pathname === '/api/me') return route.fulfill({ status: 401, json: { error: 'Sign in' } })
      if (u.pathname.includes('/billing/checkout')) report.checkout_requests++
      return route.fulfill({ status: 404, json: { error: 'Not available' } })
    })
    const checkPrice = async () => {
      const section = page.locator('#pricing')
      await section.getByText(/LKR\s*3,990\.00 \/ month/).waitFor()
      await section.getByText('Up to 3 branches and 50 active staff.', { exact: true }).waitFor()
      await section.getByText('7-day free trial. No card required.', { exact: true }).waitFor()
      await section.getByText('Checkout is not yet available.', { exact: true }).waitFor()
      assert.equal(await section.locator('button, a').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    await page.goto(base)
    await checkPrice()
    await page.locator('#pricing').screenshot({ path: `${output}/${label}-pricing.png` })
    await page.getByRole('button', { name: 'Build your first week' }).click()
    await page.getByRole('heading', { name: 'Let’s build a better week.' }).waitFor()
    await page.getByRole('button', { name: 'Back to Relay' }).click()
    await checkPrice()
    await page.reload()
    await checkPrice()
    report.flows.push(`${label}: LKR 3,990/month, confirmed limits and 7-day no-card trial, checkout unavailable after signup cancellation and reload`)
    await context.close()
  }
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const role of ['owner', 'employee']) {
      const context = await browser.newContext({ viewport, locale: 'en-US', reducedMotion: 'reduce' })
      const page = await context.newPage()
      let signedOut = false
      page.on('pageerror', e => report.errors.push(e.message))
      await page.route('**/*', async route => {
        const u = new URL(route.request().url())
        if (u.origin !== base) { report.provider_calls++; return route.abort() }
        if (!u.pathname.startsWith('/api/')) return route.continue()
        if (u.pathname === '/api/capabilities') return route.fulfill({ json: { synthetic_only: true } })
        if (u.pathname === '/api/me') return signedOut ? route.fulfill({ status: 401, json: { error: 'Sign in' } }) : route.fulfill({ json: { user: { id: 'fixture', name: 'Fixture', org: 'fixture-org', role, csrf: 'fixture' }, billing_required: true } })
        if (u.pathname === '/api/billing') return route.fulfill({ json: { status: 'trial_expired', entitled: false, trial_days: 7, card_required: false, automatic_charge: false, checkout_available: false, portal_available: false, plans: [] } })
        if (u.pathname === '/api/signout') { signedOut = true; return route.fulfill({ json: {} }) }
        if (u.pathname.includes('/billing/checkout')) report.checkout_requests++
        return route.fulfill({ status: 404, json: { error: 'Not available' } })
      })
      await page.goto(base)
      await page.getByRole('heading', { name: 'Your 7-day trial has ended.' }).waitFor()
      await page.getByText('You will not be charged automatically.', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: /^Choose |Manage subscription/ }).count(), 0)
      if (role === 'owner') {
        await page.getByText('Checkout is not available yet. Please check back later.', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Check access again' }).click()
        await page.getByRole('heading', { name: 'Your 7-day trial has ended.' }).waitFor()
      } else {
        await page.getByText('Please ask your organization owner to review the subscription.', { exact: true }).waitFor()
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `${output}/${label}-${role}-trial-expired.png` })
      await page.getByRole('button', { name: 'Sign out' }).click()
      await page.getByRole('button', { name: 'Build your first week' }).waitFor()
      report.flows.push(`${label} ${role}: expired trial, no automatic charge, checkout disabled, sign-out available`)
      await context.close()
    }
  }
  assert.deepEqual(report.errors, [])
  assert.equal(report.provider_calls, 0)
  assert.equal(report.checkout_requests, 0)
  report.passed = true
} catch (e) { report.passed = false; report.failure = e.message; throw e }
finally {
  await writeFile('docs/validation/scheduler-pricing-browser-20261110.json', JSON.stringify(report, null, 2) + '\n')
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
  console.log(JSON.stringify(report))
}
