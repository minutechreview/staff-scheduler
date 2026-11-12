import test from 'node:test'
import assert from 'node:assert/strict'
import { installLandingMotion } from '../src/motion.js'

function fixture(reduced = false) {
  const listeners = new Map(), animations = [], observed = [], stopped = []
  const preference = { matches: reduced, addEventListener: (_, fn) => listeners.set('preference', fn), removeEventListener: () => listeners.delete('preference') }
  const document = { hidden: false, activeElement: null, addEventListener: (_, fn) => listeners.set('visibility', fn), removeEventListener: () => listeners.delete('visibility') }
  let callback
  const observer = { observe: el => observed.push(el), unobserve: el => stopped.push(el), disconnect: () => { observed.length = 0 } }
  const environment = { document, matchMedia: () => preference, IntersectionObserver: class { constructor(fn) { callback = fn; return observer } } }
  const element = { contains: () => false, animate: (_frames, options) => { const animation = { canceled: false, cancel() { this.canceled = true }, options }; animations.push(animation); return animation } }
  const cleanup = installLandingMotion({ querySelectorAll: () => [element] }, environment)
  return { preference, document, animations, listeners, observed, stopped, reveal: () => callback([{ isIntersecting: true, target: element }]), cleanup }
}

test('reduced motion initially uses immediately visible static content', () => {
  const f = fixture(true); f.reveal()
  assert.equal(f.animations.length, 0); assert.equal(f.stopped.length, 1)
  f.cleanup(); assert.equal(f.listeners.size, 0)
})
test('changing motion preference cancels active movement and prevents new animation', () => {
  const f = fixture(); f.reveal(); assert.equal(f.animations.length, 1)
  f.preference.matches = true; f.listeners.get('preference')()
  assert.equal(f.animations[0].canceled, true); f.reveal(); assert.equal(f.animations.length, 1)
  f.cleanup()
})
test('hidden documents stop motion; unmount removes observer and listeners', () => {
  const f = fixture(); f.reveal(); f.document.hidden = true; f.listeners.get('visibility')()
  assert.equal(f.animations[0].canceled, true); f.reveal(); assert.equal(f.animations.length, 1)
  f.cleanup(); assert.equal(f.observed.length, 0); assert.equal(f.listeners.size, 0)
})
