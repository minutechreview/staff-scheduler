// End-to-end manager gestures against isolated synthetic loopback fixtures.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { wallTime } from '../src/scheduleEditing.mjs'

const { chromium } = await import(process.env.RELAY_PLAYWRIGHT_MODULE || '../.local/browser-tools/node_modules/playwright/index.mjs')

const base = process.env.RELAY_QOL_BASE || 'http://127.0.0.1:4330'
assert.equal(new URL(base).hostname, '127.0.0.1')
assert.ok(['4330', '4329'].includes(new URL(base).port))
const native = new URL(base).port === '4329'
const output = process.env.RELAY_QOL_OUTPUT || `output/playwright/schedule-editing-${native ? 'firebase' : 'sqlite'}`
const report = { base, synthetic_only: true, flows: [], page_errors: [], screenshots: [] }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
report.browser = browser.version()
const suffix = Date.now(), password = 'synthetic-manager-preview-123'
const email = `qol-owner-${suffix}@example.test`, employeeEmail = `qol-employee-${suffix}@example.test`
const week = '2026-10-12'
await mkdir(output, { recursive: true })
async function newPage(mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1050, height: 896 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' })
  await context.route('**/*', route => [base, 'http://127.0.0.1:9099'].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => report.page_errors.push(error.message))
  await page.goto(base)
  return page
}
async function capture(page, name) {
  assert.equal(await page.locator('input[type=password]').count(), 0)
  const path = `${output}/${name}.png`
  // Preserve fixed/sticky layout and open menus at the tested viewport.
  await page.screenshot({ path, fullPage: false }); report.screenshots.push(path)
}
async function verify(page) {
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Open local verification link' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded'); await popup.close()
  await page.getByRole('button', { name: 'Email verified — sign in' }).click()
}
async function signin(page, address) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  await page.getByLabel('Email', { exact: true }).fill(address)
  await page.getByLabel('Password', { exact: true }).fill(password)
  const response = page.waitForResponse(r => r.url().endsWith('/api/signin') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  if ((await response).status() === 202) { await verify(page); await page.getByRole('button', { name: 'Sign in', exact: true }).first().click() }
  await page.getByRole('heading', { name: /Build a better week|Your published week/ }).waitFor()
}
async function chooseWeek(page) {
  await page.getByRole('button', { name: 'Go to date', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Go to a planning week' })
  await dialog.getByLabel('Go to date').fill(week)
  await dialog.getByRole('button', { name: 'Open planning week' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(w => new URL(location.href).searchParams.get('week') === w, week)
}
async function me(page) { const r = await page.request.get(`${base}/api/me`); assert.equal(r.status(), 200); return r.json() }
let branch, zone
async function schedule(page) { const r = await page.request.get(`${base}/api/schedule?branch=${branch}&week=${week}`); assert.equal(r.status(), 200); return r.json() }
async function mutation(page, action, status = 200) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/schedule' && r.request().method() === 'POST')
  response.catch(() => {}) // The action may itself reject before this awaited response.
  await action()
  const result = await response
  assert.equal(result.status(), status, await result.text())
  if (status === 200) {
    await page.getByRole('button', { name: /Undo/ }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => ![...document.querySelectorAll('.schedule-toolbar button')].some(b => b.disabled && b.textContent.includes('History')))
  }
  return result.json()
}
async function drag(page, locator, pixels) {
  await locator.hover()
  const box = await locator.boundingBox()
  assert.ok(box)
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + pixels, y, { steps: 8 }); await page.mouse.up()
}
try {
  const owner = await newPage()
  await owner.getByRole('button', { name: 'Start your workspace' }).click()
  await owner.getByLabel('Your name').fill('Synthetic QOL Owner')
  await owner.getByLabel('Organization name').fill('Synthetic Editing Workspace')
  await owner.getByLabel('Email', { exact: true }).fill(email)
  await owner.getByLabel('Password', { exact: true }).fill(password)
  const signup = owner.waitForResponse(r => r.url().endsWith('/api/signup'))
  await owner.getByRole('button', { name: 'Create workspace' }).click()
  if ((await signup).status() === 202) {
    await verify(owner)
    await owner.getByLabel('Email', { exact: true }).fill(email)
    await owner.getByLabel('Password', { exact: true }).fill(password)
    await owner.getByRole('button', { name: 'Sign in', exact: true }).first().click()
  }
  await owner.getByRole('button', { name: 'Set up synthetic demo' }).click()
  await owner.getByRole('button', { name: 'Generate draft' }).waitFor()
  await chooseWeek(owner)
  await owner.getByRole('button', { name: 'Generate draft' }).click()
  await owner.getByRole('button', { name: 'Save reviewed draft' }).waitFor()
  assert.equal(await owner.getByRole('button', { name: 'Reload latest', exact: true }).isDisabled(), true, 'Reload never discards an unsaved generated proposal')
  await mutation(owner, () => owner.getByRole('button', { name: 'Save reviewed draft' }).click())
  const initial = await me(owner)
  branch = new URL(owner.url()).searchParams.get('branch')
  zone = initial.branches.find(b => b.id === branch).timezone
  let baseline = await schedule(owner)
  const source = baseline.shifts[0]
  const person = initial.employees.find(e => e.id === source.employee)
  const day = wallTime(source.start, zone).slice(0, 10)
  const card = () => owner.getByRole('button', { name: `Edit ${person.name}, ${day}, 09:00 to 17:00`, exact: true })
  await owner.getByRole('button', { name: 'Publish week' }).click()
  const publish = owner.getByRole('dialog', { name: 'Review and publish' })
  if (await publish.getByRole('checkbox').count()) await publish.getByRole('checkbox').check()
  await mutation(owner, () => publish.getByRole('button', { name: 'Publish this version' }).click())
  baseline = await schedule(owner)
  await capture(owner, '01-weekly-controls')
  await owner.getByRole('combobox', { name: 'Filter team by skill' }).selectOption('lead')
  const leadNames = initial.employees.filter(e => e.branch === branch && e.skills.includes('lead')).map(e => e.name)
  assert.equal(await owner.locator('.schedule-table tbody tr').count(), leadNames.length)
  await capture(owner, '08-skill-filter')
  await owner.getByRole('combobox', { name: 'Filter team by workload' }).selectOption('under')
  const assigned = id => baseline.shifts.filter(s => s.employee === id).reduce((sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)) / 3600000, 0)
  const under = initial.employees.filter(e => e.branch === branch && e.skills.includes('lead') && e.contract_hours > 0 && assigned(e.id) < e.contract_hours)
  assert.equal(await owner.locator('.schedule-table tbody tr').count(), under.length)
  await owner.getByRole('button', { name: 'Reset filters', exact: true }).click()
  await owner.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Find a team member')
  const gridOrigin = owner.locator('.schedule-table tbody tr').first().locator('button.shift, button.add-shift').first()
  await gridOrigin.focus()
  const position = await gridOrigin.evaluate(node => ({ row: Number(node.closest('[data-schedule-row]').dataset.scheduleRow), col: Number(node.closest('[data-schedule-column]').dataset.scheduleColumn) }))
  await owner.keyboard.press('ArrowRight')
  assert.equal(await owner.evaluate(() => Number(document.activeElement.closest('[data-schedule-column]').dataset.scheduleColumn)), position.col + 1)
  await owner.keyboard.press('ArrowDown')
  assert.equal(await owner.evaluate(() => Number(document.activeElement.closest('[data-schedule-row]').dataset.scheduleRow)), position.row + 1)
  await owner.keyboard.press('ArrowLeft'); await owner.keyboard.press('ArrowUp')
  assert.equal((await schedule(owner)).revision, baseline.revision, 'Grid navigation never mutates a shift')
  await chooseWeek(owner)
  await card().waitFor()
  report.flows.push('Skill and under-contract filters compose and reset; arrow keys navigate person/day cells without writes; same-week date jump retains the loaded grid')
  await owner.getByRole('textbox', { name: 'Find a team member' }).fill('no-such-person')
  await owner.getByRole('heading', { name: 'No team members match your search' }).waitFor()
  await capture(owner, '05-search-empty')
  await owner.getByRole('button', { name: 'Clear search', exact: true }).click()
  assert.equal(await owner.getByRole('textbox', { name: 'Find a team member' }).inputValue(), '')
  await owner.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Find a team member')
  await card().waitFor()
  report.flows.push('No-match search explains the filter rather than asking to add staff; Clear search restores the team and keyboard focus')
  const member = await owner.request.post(`${base}/api/members`, { data: { name: 'Synthetic Editing Employee', email: employeeEmail, password, role: 'employee', employee: person.id, branches: [branch] }, headers: { 'X-CSRF-Token': (await me(owner)).user.csrf } })
  assert.equal(member.status(), 200, await member.text())
  const employee = await newPage(true)
  await signin(employee, employeeEmail); await chooseWeek(employee)

  const moved = await mutation(owner, () => drag(owner, card(), 20))
  assert.equal(wallTime(moved.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:30')
  assert.equal(await owner.getByRole('dialog').count(), 0, 'Drag does not open the edit dialog')
  const published = await employee.request.get(`${base}/api/my-schedule?branch=${branch}&week=${week}`)
  assert.equal(wallTime((await published.json()).shifts.find(s => s.id === source.id).start, zone).slice(11), '09:00')
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  assert.equal(await owner.getByRole('button', { name: /^Redo/ }).isEnabled(), true)
  const redone = await mutation(owner, () => owner.getByRole('button', { name: /^Redo/ }).click())
  assert.equal(wallTime(redone.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:30')
  await mutation(owner, () => owner.getByRole('button', { name: /^Undo/ }).click())
  await card().focus()
  const keyboardRedo = await mutation(owner, () => owner.keyboard.press('Control+Shift+z'))
  assert.equal(wallTime(keyboardRedo.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:30')
  await mutation(owner, () => owner.getByRole('button', { name: /^Undo/ }).click())
  const beforeCancel = (await schedule(owner)).revision
  let cancelledWrites = 0
  const countWrites = request => { if (new URL(request.url()).pathname === '/api/schedule' && request.method() === 'POST') cancelledWrites++ }
  owner.on('request', countWrites)
  await card().hover()
  const cancelBox = await card().boundingBox()
  await owner.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
  await owner.mouse.down()
  await owner.mouse.move(cancelBox.x + cancelBox.width / 2 + 20, cancelBox.y + cancelBox.height / 2, { steps: 8 })
  await owner.locator('.drag-preview').waitFor()
  await owner.keyboard.press('Escape'); await owner.mouse.up()
  await owner.locator('.drag-preview').waitFor({ state: 'hidden' })
  await drag(owner, card(), 8)
  await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  owner.off('request', countWrites)
  assert.equal(cancelledWrites, 0, 'Cancelled or unsnapped drags never write')
  assert.equal((await schedule(owner)).revision, beforeCancel)
  assert.equal(await owner.getByRole('dialog').count(), 0)
  const resized = await mutation(owner, () => drag(owner, owner.getByRole('button', { name: `Adjust end of ${person.name} shift on ${day}` }), -20))
  assert.equal(wallTime(resized.shifts.find(s => s.id === source.id).end, zone).slice(11), '16:30')
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  assert.equal(await owner.getByRole('button', { name: /^Redo/ }).isEnabled(), true)
  await mutation(owner, () => drag(owner, owner.getByRole('button', { name: `Adjust start of ${person.name} shift on ${day}` }), 20))
  assert.equal(await owner.getByRole('button', { name: /^Redo/ }).isDisabled(), true, 'A fresh edit replaces the redo branch')
  await mutation(owner, () => owner.getByRole('button', { name: /^Undo/ }).click())
  const beforeInvalid = await schedule(owner)
  await mutation(owner, () => drag(owner, card(), -100), 422)
  await owner.getByRole('alert').waitFor()
  assert.equal((await schedule(owner)).revision, beforeInvalid.revision)
  assert.equal(wallTime((await schedule(owner)).shifts.find(s => s.id === source.id).start, zone).slice(11), '09:00')
  await owner.getByRole('button', { name: 'Dismiss error' }).click()
  report.flows.push('Mouse body move +30 minutes; end resize -30; undo as new validated draft versions; unavailable-time rejection preserves server revision; employee published time stays unchanged')
  report.flows.push('Redo button and Ctrl+Shift+Z restore an undone edit; a fresh edit clears redo; Escape and sub-snap drags issue zero writes; start handle adjusts independently')

  await card().click({ button: 'right' })
  await owner.getByRole('menu', { name: 'Schedule actions' }).waitFor()
  await capture(owner, '02-right-click-actions')
  await owner.getByRole('menuitem', { name: 'Copy shift' }).click()
  const emptyDay = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].find(d => !baseline.shifts.some(s => s.employee === person.id && wallTime(s.start, zone).startsWith(d)))
  assert.ok(emptyDay)
  const destination = owner.getByRole('button', { name: `Assign shift to ${person.name} on ${emptyDay}` })
  await destination.focus(); await owner.keyboard.press('Shift+F10')
  const pasted = await mutation(owner, () => owner.getByRole('menuitem', { name: 'Paste copied shift here' }).click())
  assert.equal(pasted.shifts.length, baseline.shifts.length + 1)
  assert.ok(pasted.shifts.some(s => s.employee === person.id && wallTime(s.start, zone) === `${emptyDay}T09:00`))
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  await card().focus(); await owner.keyboard.press('Control+c')
  await destination.focus()
  await mutation(owner, () => owner.keyboard.press('Control+v'))
  await destination.focus()
  await mutation(owner, () => owner.keyboard.press('Control+z'))
  const directPaste = await mutation(owner, () => owner.getByRole('button', { name: `Paste copied shift to ${person.name} on ${emptyDay}`, exact: true }).click())
  assert.equal(directPaste.shifts.length, baseline.shifts.length + 1)
  assert.equal(await owner.getByRole('button', { name: `Paste copied shift to ${person.name} on ${emptyDay}`, exact: true }).count(), 0, 'Direct paste only appears on empty days')
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  await capture(owner, '07-direct-paste')
  await card().click({ button: 'right' })
  const laterStart = await mutation(owner, () => owner.getByRole('menuitem', { name: 'Start 30 minutes later', exact: true }).click())
  assert.equal(wallTime(laterStart.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:30')
  assert.equal(wallTime(laterStart.shifts.find(s => s.id === source.id).end, zone).slice(11), '17:00')
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  await card().click({ button: 'right' })
  const earlierEnd = await mutation(owner, () => owner.getByRole('menuitem', { name: 'End 30 minutes earlier', exact: true }).click())
  assert.equal(wallTime(earlierEnd.shifts.find(s => s.id === source.id).end, zone).slice(11), '16:30')
  assert.equal(wallTime(earlierEnd.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:00')
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  report.flows.push('Visible one-click paste into an empty day saves a validated draft and disappears on occupied days; start later and end earlier menu actions each preserve the other endpoint; all three actions undo successfully')
  await card().click({ button: 'right' })
  const duplicateRevision = (await schedule(owner)).revision
  await owner.getByRole('menuitem', { name: 'Paste copied shift here' }).click()
  await owner.getByRole('alert').filter({ hasText: 'already assigned' }).waitFor()
  assert.equal((await schedule(owner)).revision, duplicateRevision)
  await owner.getByRole('button', { name: 'Dismiss error' }).click()
  report.flows.push('Right-click and Shift+F10 menus; copied shift pasted into another day; Ctrl+C/V/Z; duplicate rejected without API overwrite')

  const leadShift = baseline.shifts.find(s => s.role === 'lead')
  const leadPerson = initial.employees.find(e => e.id === leadShift.employee)
  await owner.getByRole('button', { name: `Edit ${leadPerson.name}, ${wallTime(leadShift.start, zone).slice(0, 10)}, 09:00 to 17:00`, exact: true }).focus()
  await owner.keyboard.press('Control+c')
  const incompatible = initial.employees.find(e => e.branch === branch && !e.skills.includes('lead'))
  const incompatibleDay = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].find(d => !baseline.shifts.some(s => s.employee === incompatible.id && wallTime(s.start, zone).startsWith(d)) && !initial.leaves.some(l => l.employee === incompatible.id && ['approved', 'cancel_requested', 'partially_cancelled'].includes(l.status) && l.start <= d && l.end >= d))
  assert.ok(incompatibleDay)
  const incompatiblePaste = owner.getByRole('button', { name: `Paste copied shift to ${incompatible.name} on ${incompatibleDay}`, exact: true })
  assert.equal(await incompatiblePaste.isDisabled(), true)
  assert.match(await incompatiblePaste.getAttribute('title'), /needs the lead skill/)
  await card().focus(); await owner.keyboard.press('Control+c')
  report.flows.push('Direct paste is disabled with a skill explanation when the copied role does not match the destination employee')
  const weekDays = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']
  const repeatDays = employee => weekDays.filter(d => !baseline.shifts.some(s => s.employee === employee.id && wallTime(s.start, zone).startsWith(d)) && !initial.leaves.some(l => l.employee === employee.id && ['approved', 'cancel_requested', 'partially_cancelled'].includes(l.status) && l.start <= d && l.end >= d)).slice(0, 2)
  const second = initial.employees.find(e => { const count = baseline.shifts.filter(s => s.employee === e.id).length; return e.branch === branch && e.id !== person.id && count > 0 && count <= 3 && repeatDays(e).length === 2 })
  assert.ok(second)
  const secondShift = baseline.shifts.find(s => s.employee === second.id)
  const secondDay = wallTime(secondShift.start, zone).slice(0, 10)
  await owner.getByRole('button', { name: `Shift actions for ${second.name} on ${secondDay}` }).click()
  await owner.getByRole('menuitem', { name: 'Repeat across days…' }).click()
  const repeat = owner.getByRole('dialog', { name: 'Repeat shift across days' })
  assert.equal(await repeat.getByRole('button', { name: 'Save repeated draft shifts' }).isDisabled(), true)
  assert.equal(await repeat.locator(`input[name="day_${secondDay}"]`).isDisabled(), true, 'Already assigned day is explained and disabled')
  await repeat.getByRole('button', { name: 'Select empty days', exact: true }).click()
  const expectedEmpty = weekDays.filter(d => !baseline.shifts.some(s => s.employee === second.id && wallTime(s.start, zone).startsWith(d)) && !initial.leaves.some(l => l.employee === second.id && ['approved', 'cancel_requested', 'partially_cancelled'].includes(l.status) && l.start <= d && l.end >= d))
  assert.equal(await repeat.locator('input:checked').count(), expectedEmpty.length)
  await repeat.getByRole('button', { name: 'Clear days', exact: true }).click()
  assert.equal(await repeat.locator('input:checked').count(), 0)
  const candidates = repeatDays(second)
  for (const d of candidates) await repeat.locator(`input[name="day_${d}"]`).check()
  await repeat.getByRole('status').filter({ hasText: '2 new draft shifts selected' }).waitFor()
  await capture(owner, '10-repeat-selection')
  const repeated = await mutation(owner, () => repeat.getByRole('button', { name: 'Save repeated draft shifts' }).click())
  assert.equal(repeated.shifts.length, baseline.shifts.length + 2)
  await capture(owner, '03-repeat-saved')
  await mutation(owner, () => owner.getByRole('button', { name: /Undo/ }).click())
  await card().focus()
  const keyboardMove = await mutation(owner, () => owner.keyboard.press('Alt+ArrowRight'))
  assert.equal(wallTime(keyboardMove.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:30')
  await owner.reload()
  await owner.getByRole('button', { name: `Edit ${person.name}, ${day}, 09:30 to 17:30` }).waitFor()
  assert.equal(new URL(owner.url()).searchParams.get('week'), week)
  assert.equal(new URL(owner.url()).searchParams.get('branch'), branch)
  report.flows.push('Two-day repeat saved atomically; keyboard time adjustment; selected branch/week and saved draft retained after reload')
  report.flows.push('Repeat form disables existing identical assignments, selects only empty non-leave days, clears selection, reports the selected count and saves all selected shifts in one draft transaction')

  const mobile = await newPage(true)
  await signin(mobile, email); await chooseWeek(mobile)
  await mobile.getByRole('button', { name: `Shift actions for ${person.name} on ${day}` }).click()
  await capture(mobile, '04-touch-actions')
  const menuBounds = await mobile.getByRole('menu', { name: 'Schedule actions' }).boundingBox()
  assert.ok(menuBounds.y >= 8 && menuBounds.y + menuBounds.height <= 836, 'Touch menu stays inside the 844px viewport with an 8px margin')
  assert.equal(await mobile.locator('.editing-help .touch-instructions').isVisible(), true)
  assert.equal(await mobile.locator('.editing-help .pointer-instructions').isVisible(), false)
  const touchChange = await mutation(mobile, () => mobile.getByRole('menuitem', { name: 'Move 30 minutes earlier' }).click())
  assert.equal(wallTime(touchChange.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:00')
  await mutation(owner, () => drag(owner, owner.getByRole('button', { name: `Edit ${person.name}, ${day}, 09:30 to 17:30` }), 20), 409)
  await owner.getByRole('alert').filter({ hasText: 'Another manager' }).waitFor()
  assert.equal((await schedule(owner)).revision, touchChange.revision)
  let releaseAnalytics
  const analyticsPaused = new Promise(resolve => { releaseAnalytics = resolve })
  let markAnalyticsReached
  const analyticsReached = new Promise(resolve => { markAnalyticsReached = resolve })
  await owner.route('**/api/analytics?*', async route => { markAnalyticsReached(); await analyticsPaused; await route.continue() })
  await owner.getByRole('button', { name: 'Reload latest', exact: true }).click()
  await analyticsReached
  try {
    assert.equal(await owner.getByRole('combobox', { name: 'Location', exact: true }).isDisabled(), true)
    assert.equal(await owner.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'People', exact: true }).isDisabled(), true)
    assert.equal(await owner.getByRole('button', { name: 'Generate draft', exact: true }).isDisabled(), true)
  } finally { releaseAnalytics() }
  await owner.getByRole('status').filter({ hasText: 'Latest draft loaded' }).waitFor()
  await owner.unroute('**/api/analytics?*')
  assert.equal(await owner.getByRole('alert').count(), 0)
  assert.equal(await owner.getByRole('button', { name: /^Undo/ }).isDisabled(), true)
  assert.equal(await owner.getByRole('button', { name: /^Redo/ }).isDisabled(), true)
  await card().waitFor()
  await capture(owner, '06-concurrent-recovery')
  await card().focus()
  const recovered = await mutation(owner, () => owner.keyboard.press('Alt+ArrowRight'))
  assert.equal(recovered.revision, touchChange.revision + 1)
  assert.equal(wallTime(recovered.shifts.find(s => s.id === source.id).start, zone).slice(11), '09:30')
  await mutation(owner, () => owner.getByRole('button', { name: /^Undo/ }).click())
  const recoveredBaseline = await schedule(owner)
  report.flows.push('Concurrent-edit rejection recovers through Reload latest without browser reload; stale undo is cleared and the next edit uses the current revision')
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await capture(mobile, '04-touch-manager')
  assert.equal(await employee.locator('.shift-resize, .shift-menu-trigger').count(), 0)
  const forbidden = await employee.request.post(`${base}/api/schedule`, { data: { branch, week, revision: touchChange.revision, shifts: [] }, headers: { 'X-CSRF-Token': (await me(employee)).user.csrf } })
  assert.equal(forbidden.status(), 403)
  assert.equal((await schedule(owner)).revision, recoveredBaseline.revision)
  await mobile.getByRole('button', { name: 'Today', exact: true }).click()
  const currentWeek = (await me(mobile)).calendar.planning.start
  await mobile.waitForFunction(w => new URL(location.href).searchParams.get('week') === w, currentWeek)
  await mobile.getByRole('button', { name: 'Generate draft', exact: true }).waitFor()
  await mobile.getByRole('button', { name: 'Today', exact: true }).click()
  await mobile.getByRole('button', { name: 'Generate draft', exact: true }).waitFor()
  await capture(mobile, '09-mobile-filters')
  report.flows.push('390px touch menu alternative without horizontal document overflow; concurrent stale gesture rejected with 409; employee has no editing controls and direct mutation is denied; Today navigates to current configured week')
  assert.deepEqual(report.page_errors, [])
  report.passed = true
} catch (error) {
  report.passed = false; report.failure = String(error)
  for (const context of browser.contexts()) {
    const page = context.pages()[0]
    if (page && !page.isClosed() && await page.locator('input[type=password]').count() === 0) {
      await capture(page, 'failure-state')
      report.failure_screen = await page.locator('body').innerText()
      break
    }
  }
  throw error
} finally {
  await writeFile(process.env.RELAY_QOL_REPORT || `docs/validation/qol-browser-${native ? 'firebase' : 'sqlite'}.json`, JSON.stringify(report, null, 2) + '\n')
  await browser.close(); console.log(JSON.stringify(report, null, 2))
}
