import { useState } from 'react'
import { copyWeekSchedule } from '../hooks/useSchedule'

export default function CopyWeekModal({ store, weekStart, prevWeekEntries, onClose }) {
  const [mode, setMode] = useState('week') // 'week' | 'month' | 'year'
  const [copying, setCopying] = useState(false)
  const [done, setDone] = useState(false)

  function getFridaysInMonth(fromFriday) {
    const start = new Date(fromFriday + 'T00:00:00')
    const month = start.getMonth()
    const year = start.getFullYear()
    const fridays = []
    while (d.getMonth() === month || (month === 11 && d.getFullYear() === year)) {
      if (d.getMonth() !== month) break
      const curY = d.getFullYear()
      const curM = String(d.getMonth() + 1).padStart(2, '0')
      const curD = String(d.getDate()).padStart(2, '0')
      fridays.push(`${curY}-${curM}-${curD}`)
      d.setDate(d.getDate() + 7)
    }
    return fridays
  }

  function getFridaysInYear(fromFriday) {
    const start = new Date(fromFriday + 'T00:00:00')
    const year = start.getFullYear()
    const fridays = []
    const d = new Date(start)
    d.setDate(d.getDate() + 7)
    while (d.getFullYear() === year) {
      const curY = d.getFullYear()
      const curM = String(d.getMonth() + 1).padStart(2, '0')
      const curD = String(d.getDate()).padStart(2, '0')
      fridays.push(`${curY}-${curM}-${curD}`)
      d.setDate(d.getDate() + 7)
    }
    return fridays
  }

  async function handleCopy() {
    if (Object.keys(prevWeekEntries).length === 0) return
    setCopying(true)
    try {
      let targets = []
      if (mode === 'week') {
        targets = [weekStart]
      } else if (mode === 'month') {
        targets = getFridaysInMonth(weekStart)
      } else {
        targets = getFridaysInYear(weekStart)
      }
      await copyWeekSchedule(store.id, prevWeekEntries, targets)
      setDone(true)
    } finally {
      setCopying(false)
    }
  }

  const hasPrevEntries = Object.keys(prevWeekEntries).length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-content-main">Copy Last Week's Schedule</h2>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {done ? (
            <div className="text-center py-4">
              <div className="text-green-400 text-sm font-medium">Schedule copied successfully!</div>
              <div className="text-content-muted text-xs mt-1">Existing Leave entries were preserved.</div>
              <button onClick={onClose} className="mt-4 px-5 py-2 rounded-lg bg-brand-primary text-white text-sm">Done</button>
            </div>
          ) : (
            <>
              {!hasPrevEntries && (
                <div className="px-4 py-3 rounded-xl bg-amber-900/20 border border-amber-500/20 text-amber-300 text-xs">
                  No schedule found for last week — nothing to copy.
                </div>
              )}

              <div className="text-xs text-content-muted leading-relaxed">
                Copies last week's shifts to the selected range. Any existing <span className="text-red-400">Leave</span> or <span className="text-amber-400">Support</span> entries in the target weeks are preserved. Leave entries from last week are <em>not</em> copied.
              </div>

              <div className="space-y-2">
                <div className="text-xs text-content-muted font-semibold uppercase tracking-wider">Apply to</div>
                {[
                  { value: 'week', label: 'This week only' },
                  { value: 'month', label: 'Rest of this month' },
                  { value: 'year', label: 'Rest of this year' },
                ].map((opt) => (
                  <label key={opt.value} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-panel hover:bg-surface-panel cursor-pointer">
                    <input type="radio" name="copyMode" value={opt.value} checked={mode === opt.value}
                      onChange={() => setMode(opt.value)}
                      className="accent-[#296044]" />
                    <span className="text-sm text-content-main">{opt.label}</span>
                  </label>
                ))}
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-sm transition-colors">
                  Cancel
                </button>
                <button
                  onClick={handleCopy}
                  disabled={!hasPrevEntries || copying}
                  className="flex-1 px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white text-sm font-medium transition-colors"
                >
                  {copying ? 'Copying…' : 'Copy Schedule'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
