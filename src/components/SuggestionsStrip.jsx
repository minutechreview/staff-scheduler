import { useMemo } from 'react'
import { computeShortfalls } from '../utils/schedulingAssistant'

export default function SuggestionsStrip({ store, staff, scheduleEntries, visitors, onRequestSupport }) {
  const shortfalls = useMemo(
    () => computeShortfalls(store, staff, scheduleEntries, visitors),
    [store, staff, scheduleEntries, visitors]
  )

  if (shortfalls.length === 0) return null

  return (
    <div className="bg-amber-950/10 border-b border-amber-500/10 px-4 md:px-8 py-2.5 flex items-center gap-3 flex-wrap">
      <span className="text-[10px] text-amber-400/60 font-semibold uppercase tracking-wider flex-shrink-0">
        Shortfalls
      </span>
      {shortfalls.map((s) => (
        <div key={`${s.day}-${s.shiftType}`} className="flex items-center gap-1.5 flex-shrink-0">
          <span className="px-2.5 py-1 rounded-full bg-amber-900/30 border border-amber-500/20 text-xs text-amber-300 whitespace-nowrap">
            Short {s.short} {s.shiftType === 'AM Shift' ? 'AM' : 'PM'} · {s.day}
          </span>
          <button
            onClick={() => onRequestSupport(s.day, s.shiftType)}
            className="px-2.5 py-1 rounded-full bg-brand-primary hover:bg-brand-hover text-white text-[10px] font-medium transition-colors whitespace-nowrap"
          >
            Request Support
          </button>
        </div>
      ))}
    </div>
  )
}
