import { getWeekStartFriday, getWeekDates, formatDate, getWeekNumber } from '../data/stores'

export default function WeekPicker({ weekStart, onChange }) {
  const dates = getWeekDates(weekStart)
  const weekNo = getWeekNumber(weekStart)

  function shiftWeek(delta) {
    const current = new Date(weekStart + 'T00:00:00')
    current.setDate(current.getDate() + delta * 7)
    const y = current.getFullYear()
    const m = String(current.getMonth() + 1).padStart(2, '0')
    const d = String(current.getDate()).padStart(2, '0')
    onChange(`${y}-${m}-${d}`)
  }

  const isCurrentWeek = weekStart === getWeekStartFriday()

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => shiftWeek(-1)}
        className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-panel hover:bg-brand-primary/40 text-content-muted hover:text-content-main transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
      </button>

      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 rounded bg-brand-primary/30 text-content-muted text-xs font-semibold tracking-wide">
          WK {weekNo}
        </span>
        <span className="text-sm font-medium text-content-main">
          {formatDate(dates[0])} — {formatDate(dates[6])}
        </span>
        {isCurrentWeek && (
          <span className="text-xs text-content-muted font-normal hidden md:inline">This week</span>
        )}
      </div>

      <button
        onClick={() => shiftWeek(1)}
        className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-panel hover:bg-brand-primary/40 text-content-muted hover:text-content-main transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
      </button>

      {!isCurrentWeek && (
        <button
          onClick={() => onChange(getWeekStartFriday())}
          className="text-xs text-content-muted hover:text-[#D8E8E2] transition-colors"
        >
          Today
        </button>
      )}
    </div>
  )
}
