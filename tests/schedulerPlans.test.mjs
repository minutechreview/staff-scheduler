import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const plans = JSON.parse(readFileSync(new URL('../src/scheduler-plans.json', import.meta.url), 'utf8'))

test('approved Team plan is LKR 3990 monthly with the confirmed limits and 7-day no-card trial', () => {
  assert.deepEqual(plans, [{ id: 'team', name: 'Team', amount_minor: 399000, currency: 'LKR', interval: 'month', max_branches: 3, max_active_staff: 50, trial_days: 7, trial_card_required: false }])
})

test('LKR minor units format as 3990 rather than 12 or 399000', () => {
  const plan = plans[0]
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: plan.currency })
  assert.equal(formatter.resolvedOptions().maximumFractionDigits, 2)
  assert.equal(formatter.format(plan.amount_minor / 10 ** formatter.resolvedOptions().maximumFractionDigits).replace(/\s/g, ' '), 'LKR 3,990.00')
})

test('price and trial approval do not add provider identifiers or activation', () => {
  for (const field of ['variant_id', 'store_id', 'price_id', 'checkout_enabled', 'billing_enabled']) {
    assert.equal(Object.hasOwn(plans[0], field), false)
  }
})
