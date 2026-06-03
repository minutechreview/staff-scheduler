import { useState } from 'react'
import IconBtn from './IconBtn'

export default function SicRotationTracker({ staff, visitors = [], scheduleEntries }) {
  const SIC_POSITIONS = ['SM', 'ASM', 'SSV', 'TSSV', 'SIC']
  const DAYS = ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU']

  const sicStaff = staff.filter((s) => SIC_POSITIONS.includes(s.position))
  // SIC-eligible visitors (supporting from another store)
  const sicVisitors = visitors.filter((v) => SIC_POSITIONS.includes(v.position))

  const [showPanel, setShowPanel] = useState(false)

  // Compute AM/PM/Off counts for roster SIC staff this week
  const rotation = sicStaff.map((s) => {
    let am = 0, pm = 0, off = 0
    const entry = scheduleEntries?.[s.id] || {}
    DAYS.forEach((day) => {
      const shift = entry[day]
      if (!shift || shift === 'Day Off') off++
      else if (shift.startsWith('AM') || shift === 'Mid Shift' || shift === 'GY Shift') am++
      else if (shift.startsWith('PM')) pm++
    })
    return { id: s.id, name: s.name, position: s.position, am, pm, off, isVisitor: false }
  })

  // Helper: is a visitor present on a given day?
  // Checks both supportDays array (set via Support Picker) and scheduleEntries (set via grid click)
  function visitorActiveOnDay(v, day) {
    const inSupportDays = (v.supportDays || []).includes(day)
    const entryShift = scheduleEntries?.[v.id]?.[day]
    const inEntries = entryShift && entryShift !== 'Day Off'
    return inSupportDays || inEntries
  }

  // Visitor SIC staff — count days they're present (either source)
  const visitorRotation = sicVisitors.map((v) => {
    const activeDays = DAYS.filter((day) => visitorActiveOnDay(v, day))
    const support = activeDays.length
    const off = DAYS.length - support
    return { id: v.id, name: v.name, position: v.position, support, off, isVisitor: true,
             homeStoreName: v.homeStoreName || v.homeStoreId || '?' }
  })

  // Daily coverage: does each day have at least one SIC person on AM AND PM?
  // Visitors count as covering both AM+PM on days they're present (physically there as SIC)
  const amCoverage = DAYS.map((day) => {
    const rosterAM = sicStaff.some((s) => {
      const sh = scheduleEntries?.[s.id]?.[day]
      return sh && (sh.startsWith('AM') || sh === 'Mid Shift' || sh === 'GY Shift')
    })
    const rosterPM = sicStaff.some((s) => scheduleEntries?.[s.id]?.[day]?.startsWith('PM'))
    const visitorPresent = sicVisitors.some((v) => visitorActiveOnDay(v, day))
    return { day, am: rosterAM || visitorPresent, pm: rosterPM || visitorPresent }
  })

  const uncoveredAM = amCoverage.filter((d) => !d.am).length
  const uncoveredPM = amCoverage.filter((d) => !d.pm).length
  const hasGap = uncoveredAM > 0 || uncoveredPM > 0

  if (sicStaff.length === 0) return null

  return (
    <div className="relative">
      <IconBtn
        onClick={() => setShowPanel(!showPanel)}
        tooltip="SIC Rotation"
        className={showPanel
          ? 'bg-brand-primary text-white'
          : hasGap
            ? 'bg-red-900/30 hover:bg-red-900/50 text-red-400 hover:text-red-300'
            : 'bg-surface-panel hover:bg-surface-panel text-content-muted hover:text-content-main'
        }
        icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        }
      />

      {showPanel && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-[#162118] border border-border-subtle rounded-xl shadow-2xl p-4 z-50">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-content-main">SIC Rotation</h4>
            <button onClick={() => setShowPanel(false)} className="text-content-muted hover:text-content-main">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Day-by-day coverage matrix */}
          <div className="mb-4">
            <div className="text-[10px] text-content-muted uppercase tracking-wider mb-1.5">Daily Coverage</div>
            <div className="flex gap-1">
              {amCoverage.map(({ day, am, pm }) => (
                <div key={day} className="flex-1 text-center">
                  <div className="text-[9px] text-content-muted mb-1">{day[0]}</div>
                  <div className={`w-full h-1.5 rounded-sm mb-0.5 ${am ? 'bg-blue-400' : 'bg-red-500/60'}`} title={`AM ${am ? '✓' : '✗'}`} />
                  <div className={`w-full h-1.5 rounded-sm ${pm ? 'bg-amber-400' : 'bg-red-500/60'}`} title={`PM ${pm ? '✓' : '✗'}`} />
                </div>
              ))}
            </div>
            <div className="flex gap-3 mt-2 text-[9px] text-content-muted">
              <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-blue-400 inline-block"></span>AM covered</span>
              <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-amber-400 inline-block"></span>PM covered</span>
              <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-red-500/60 inline-block"></span>Gap</span>
            </div>
          </div>

          {/* Per-staff breakdown */}
          <div className="text-[10px] text-content-muted uppercase tracking-wider mb-1.5">Staff This Week</div>
          <div className="space-y-1.5">
            {rotation.map((r) => (
              <div key={r.id} className="flex items-center justify-between p-2 bg-surface-panel rounded-lg">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-content-main truncate">{r.name}</div>
                  <div className="text-[10px] text-content-muted">{r.position}</div>
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  <div className="text-center px-2 py-1 bg-blue-500/20 rounded">
                    <div className="text-xs font-semibold text-blue-400">{r.am}</div>
                    <div className="text-[8px] text-blue-400/60">AM</div>
                  </div>
                  <div className="text-center px-2 py-1 bg-amber-500/20 rounded">
                    <div className="text-xs font-semibold text-amber-400">{r.pm}</div>
                    <div className="text-[8px] text-amber-400/60">PM</div>
                  </div>
                  <div className="text-center px-2 py-1 bg-surface-panel rounded">
                    <div className="text-xs font-semibold text-content-muted">{r.off}</div>
                    <div className="text-[8px] text-content-muted">Off</div>
                  </div>
                </div>
              </div>
            ))}

            {/* Visitor SIC staff */}
            {visitorRotation.map((r) => (
              <div key={r.id} className="flex items-center justify-between p-2 bg-amber-900/10 border border-amber-500/20 rounded-lg">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-content-main truncate">{r.name}</div>
                  <div className="text-[10px] text-amber-400/60">{r.position} · from {r.homeStoreName}</div>
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  <div className="text-center px-2 py-1 bg-amber-500/20 rounded">
                    <div className="text-xs font-semibold text-amber-300">{r.support}</div>
                    <div className="text-[8px] text-amber-400/60">Supp</div>
                  </div>
                  <div className="text-center px-2 py-1 bg-surface-panel rounded">
                    <div className="text-xs font-semibold text-content-muted">{r.off}</div>
                    <div className="text-[8px] text-content-muted">Off</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between text-[10px]">
            <span className="text-content-muted">
              {sicStaff.length} roster{sicVisitors.length > 0 ? ` + ${sicVisitors.length} support-in` : ''}
            </span>
            {hasGap ? (
              <span className="text-red-400">{uncoveredAM}d AM gap · {uncoveredPM}d PM gap</span>
            ) : (
              <span className="text-green-400">Full coverage ✓</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
