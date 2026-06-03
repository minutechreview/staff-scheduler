import { useState, useEffect, useRef } from 'react'

// ── Web Audio chime ────────────────────────────────────────────────────
function playWelcomeChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const now = ctx.currentTime

    // Pleasant C5 + E5 major third chord
    const notes = [523.25, 659.25]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.08, now + 0.05)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5 + i * 0.1)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.08)
      osc.stop(now + 0.6 + i * 0.1)
    })

    // Clean up
    setTimeout(() => ctx.close(), 1000)
  } catch {
    // Silently fail if AudioContext is blocked
  }
}

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [mounted, setMounted] = useState(false)
  const [typing, setTyping] = useState(false)
  const inputRef = useRef(null)
  const chimePlayed = useRef(false)

  useEffect(() => {
    // Trigger entrance animation
    requestAnimationFrame(() => setMounted(true))
  }, [])

  // Typewriter effect for headline
  useEffect(() => {
    const timer = setTimeout(() => setTyping(true), 400)
    return () => clearTimeout(timer)
  }, [])

  const allowedDomain = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN || ''

  function handleSubmit(e) {
    e.preventDefault()
    setError('')
    playWelcomeChime()

    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }

    const trimmed = email.trim().toLowerCase()
    if (allowedDomain && !trimmed.endsWith(`@${allowedDomain}`)) {
      setError(`Access is restricted to @${allowedDomain} email addresses.`)
      return
    }

    // Extract display name from email
    const namePart = trimmed.split('@')[0]
    const displayName = namePart
      .split('.')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')

    onLogin({
      email: trimmed,
      displayName,
      photoURL: null,
    })
  }

  function handleDemo() {
    playWelcomeChime()
    onLogin({
      email: 'demo@example.com',
      displayName: 'Demo Manager',
      photoURL: null,
      isDemo: true,
    })
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      {/* Aurora gradient background */}
      <div
        className="absolute inset-0 animate-aurora"
        style={{
          background: 'linear-gradient(-45deg, #0A100D, #006241, #1E3932, #00704A, #162118, #006241)',
          backgroundSize: '400% 400%',
        }}
      />

      {/* Subtle noise texture overlay */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
      }} />

      {/* Card */}
      <div className={`relative z-10 w-full max-w-md transition-all duration-700 ${mounted ? 'animate-card-enter' : 'opacity-0'}`}>
        {/* Glassmorphic container */}
        <div className="backdrop-blur-xl bg-white/[0.07] border border-white/[0.12] rounded-3xl p-8 md:p-10 shadow-2xl">
          {/* Logo with glow */}
          <div className="flex justify-center mb-8">
            <div className="relative">
              <div className="absolute inset-0 rounded-full animate-glow-pulse" />
              <img
                src="/logo.png"
                alt="RetailCo"
                className="w-20 h-20 rounded-full object-cover relative z-10 border-2 border-white/20 animate-float"
              />
            </div>
          </div>

          {/* Typewriter headline */}
          <div className="text-center mb-2">
            <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
              {typing ? (
                <span className="inline-block overflow-hidden whitespace-nowrap border-r-2 border-white/60"
                  style={{
                    animation: 'typewriter 1.2s steps(24) 0.3s forwards, blink-caret 0.7s step-end infinite',
                    width: 0,
                  }}
                >
                  Store Scheduler
                </span>
              ) : (
                <span className="opacity-0">Store Scheduler</span>
              )}
            </h1>
          </div>

          <p className="text-center text-white/50 text-sm mb-8">
            RetailCo — Staff Scheduling
          </p>

          {/* Email login form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[10px] text-white/40 uppercase tracking-widest mb-2 font-medium">
                Store Email
              </label>
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError('') }}
                placeholder={allowedDomain ? `your.name@${allowedDomain}` : 'your.name@example.com'}
                className="w-full bg-white/[0.06] border border-white/[0.15] rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 outline-none focus:border-[#00704A] focus:bg-white/[0.08] transition-all duration-200"
                autoComplete="email"
                autoFocus
              />
            </div>

            {error && (
              <div className="px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-xs text-center">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-gradient w-full font-semibold text-sm rounded-xl px-4 py-3.5"
            >
              Sign In
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="text-center mt-6 space-y-2">
          <p className="text-white/20 text-[10px] tracking-wide">
            {allowedDomain ? `@${allowedDomain} · ` : ''}Store Scheduler
          </p>
        </div>
      </div>

      {/* Bottom-right utility links */}
      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-3">
        <button
          onClick={handleDemo}
          className="text-white/15 hover:text-white/50 text-[9px] uppercase tracking-widest transition-colors"
        >
          Try Demo
        </button>
        <span className="text-white/10 text-[9px]">·</span>
        <button
          onClick={() => {
            localStorage.clear();
            window.location.reload();
          }}
          className="text-white/15 hover:text-white/50 text-[9px] uppercase tracking-widest transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  )
}
