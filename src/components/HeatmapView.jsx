export default function HeatmapView({ store, staff, weekStart, scheduleEntries }) {
  const WEEK_DAYS = ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU']

  // Generate 4 weeks starting from weekStart
  const weeks = []
  const start = new Date(weekStart + 'T00:00:00')
  for (let i = 0; i < 4; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + (i * 7))
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const dateStr = `${y}-${m}-${day}`
    weeks.push({
      startDate: dateStr,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    })
  }

  // Calculate headcount for each day
  function getHeadcount(day) {
    let am = 0, pm = 0
    staff.forEach((s) => {
      const shift = scheduleEntries[s.id]?.[day]
      if (shift === 'AM Shift' || shift === 'AM 8h') am++
      else if (shift === 'PM Shift') pm++
    })
    return { am, pm }
  }

  function getCoverageColor(am, pm) {
    const amShort = am < store.minAM
    const pmShort = pm < store.minPM
    if (amShort && pmShort) return 'bg-[var(--status-error-bg)] text-[var(--status-error-text)]'
    if (amShort || pmShort) return 'bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]'
    const surplus = am > store.minAM + 1 || pm > store.minPM + 1
    if (surplus) return 'bg-[var(--status-surplus-bg)] text-[var(--status-surplus-text)]'
    return 'bg-[var(--status-ok-bg)] text-[var(--status-ok-text)]'
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-content-main">4-Week Coverage Heatmap</h3>
        <p className="text-xs text-content-muted">Headcount per day across 4 weeks</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left px-3 py-2 text-content-muted font-medium w-20">Day</th>
              {weeks.map((week) => (
                <th key={week.startDate} className="text-center px-2 py-2 text-content-muted font-medium min-w-[80px]">
                  <div>{week.label}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEK_DAYS.map((day) => (
              <tr key={day} className="border-t border-border-subtle">
                <td className="px-3 py-3 text-content-muted font-medium">{day}</td>
                {weeks.map((week) => {
                  const { am, pm } = getHeadcount(day)
                  const color = getCoverageColor(am, pm)

                  return (
                    <td key={`${week.startDate}-${day}`} className="px-1 py-1 text-center">
                      <div className={`rounded-lg px-3 py-3 ${color} transition-colors`}>
                        <div className="text-content-main font-semibold text-sm">{am}A/{pm}P</div>
                        <div className="opacity-80 text-[10px] mt-0.5">
                          {am < store.minAM && <span className="">-{store.minAM - am}A </span>}
                          {pm < store.minPM && <span className="">-{store.minPM - pm}P </span>}
                          {am >= store.minAM && pm >= store.minPM && <span className="">OK</span>}
                        </div>
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mt-4 pt-4 border-t border-border-subtle text-xs text-content-muted">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[var(--status-ok-bg)]"></span> Full</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[var(--status-warning-bg)]"></span> Low</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[var(--status-error-bg)]"></span> Short</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[var(--status-surplus-bg)]"></span> Surplus</span>
      </div>

      <div className="mt-4 p-3 bg-surface-panel rounded-lg">
        <div className="text-[10px] text-content-muted uppercase tracking-wider mb-2">Minimums</div>
        <div className="flex gap-6 text-xs">
          <span className="text-blue-400">Min AM: <strong>{store.minAM}</strong></span>
          <span className="text-amber-400">Min PM: <strong>{store.minPM}</strong></span>
          <span className="text-content-muted">Staff: <strong>{staff.length}</strong></span>
        </div>
      </div>
    </div>
  )
}
