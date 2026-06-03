import { useState, useEffect, useMemo } from 'react'
import { collection, query, where, onSnapshot, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import { useAor } from '../contexts/AorContext'
import { useStoresContext } from '../contexts/StoresContext'

// ─── Colour palette for staff / stores ────────────────────────────────────────
const PALETTE = [
  { bg: 'bg-[var(--cal-p1-bg)]', text: 'text-[var(--cal-p1-text)]', dot: 'bg-[var(--cal-p1-dot)]', border: 'border-[var(--cal-p1-border)]' },
  { bg: 'bg-[var(--cal-p2-bg)]', text: 'text-[var(--cal-p2-text)]', dot: 'bg-[var(--cal-p2-dot)]', border: 'border-[var(--cal-p2-border)]' },
  { bg: 'bg-[var(--cal-p3-bg)]', text: 'text-[var(--cal-p3-text)]', dot: 'bg-[var(--cal-p3-dot)]', border: 'border-[var(--cal-p3-border)]' },
  { bg: 'bg-[var(--cal-p4-bg)]', text: 'text-[var(--cal-p4-text)]', dot: 'bg-[var(--cal-p4-dot)]', border: 'border-[var(--cal-p4-border)]' },
  { bg: 'bg-[var(--cal-p5-bg)]', text: 'text-[var(--cal-p5-text)]', dot: 'bg-[var(--cal-p5-dot)]', border: 'border-[var(--cal-p5-border)]' },
  { bg: 'bg-[var(--cal-p6-bg)]', text: 'text-[var(--cal-p6-text)]', dot: 'bg-[var(--cal-p6-dot)]', border: 'border-[var(--cal-p6-border)]' },
  { bg: 'bg-[var(--cal-p7-bg)]', text: 'text-[var(--cal-p7-text)]', dot: 'bg-[var(--cal-p7-dot)]', border: 'border-[var(--cal-p7-border)]' },
  { bg: 'bg-[var(--cal-p8-bg)]', text: 'text-[var(--cal-p8-text)]', dot: 'bg-[var(--cal-p8-dot)]', border: 'border-[var(--cal-p8-border)]' },
  { bg: 'bg-[var(--cal-p9-bg)]', text: 'text-[var(--cal-p9-text)]', dot: 'bg-[var(--cal-p9-dot)]', border: 'border-[var(--cal-p9-border)]' },
  { bg: 'bg-[var(--cal-p10-bg)]', text: 'text-[var(--cal-p10-text)]', dot: 'bg-[var(--cal-p10-dot)]', border: 'border-[var(--cal-p10-border)]' },
]

function getPalette(index) {
  return PALETTE[index % PALETTE.length]
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function toDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfWeekFri(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const day = d.getDay() // 0=Sun, 5=Fri
  const diff = (d.getDay() - 5 + 7) % 7
  d.setDate(d.getDate() - diff)
  return toDateStr(d)
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return toDateStr(d)
}

function addWeeks(dateStr, n) { return addDays(dateStr, n * 7) }

function fmtDay(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtMonth(year, month) {
  return new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

// ISO week number (week 1 = week with first Thursday)
function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const tmp = new Date(d)
  tmp.setHours(0, 0, 0, 0)
  tmp.setDate(tmp.getDate() + 4 - (tmp.getDay() || 7))
  const yearStart = new Date(tmp.getFullYear(), 0, 1)
  return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7)
}

// Does a leave plan overlap a given single date?
function planCoversDate(plan, dateStr) {
  return plan.startDate <= dateStr && plan.endDate >= dateStr
}

// Does a leave plan touch any date in [fromStr, toStr]?
function planInRange(plan, fromStr, toStr) {
  return plan.startDate <= toStr && plan.endDate >= fromStr
}

// Get all calendar days for a month (including leading/trailing days to fill weeks)
function getMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  // Adjust so week starts on Friday (day 5)
  const startOffset = (firstDay.getDay() - 5 + 7) % 7
  const cells = []
  for (let i = -startOffset; i <= lastDay.getDate() + (6 - lastDay.getDay() + 5) % 7 - 1; i++) {
    const d = new Date(year, month, 1 + i)
    cells.push({ dateStr: toDateStr(d), inMonth: d.getMonth() === month })
  }
  return cells
}

const WEEK_LABELS = ['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']

// ─── Firestore hook ───────────────────────────────────────────────────────────
function useLeavePlansForStores(storeIds) {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!storeIds || storeIds.length === 0) {
      setPlans([])
      setLoading(false)
      return
    }

    // Firestore `in` is limited to 30 items — batch if needed
    const batches = []
    for (let i = 0; i < storeIds.length; i += 30) {
      batches.push(storeIds.slice(i, i + 30))
    }

    const unsubscribers = []
    const batchResults = batches.map(() => [])
    let settledCount = 0

    function merge() {
      const all = batchResults.flat()
      // De-duplicate by document ID to handle overlapping batches or store duplicates
      const uniqueMap = new Map()
      all.forEach(p => uniqueMap.set(p.id, p))
      const unique = Array.from(uniqueMap.values())
      unique.sort((a, b) => a.startDate.localeCompare(b.startDate))
      setPlans(unique)
      if (settledCount === batches.length) setLoading(false)
    }

    batches.forEach((batch, idx) => {
      const q = query(collection(db, 'leavePlans'), where('storeId', 'in', batch))
      const unsub = onSnapshot(q, (snap) => {
        batchResults[idx] = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        settledCount = Math.max(settledCount, idx + 1)
        merge()
      })
      unsubscribers.push(unsub)
    })

    return () => unsubscribers.forEach((u) => u())
  }, [storeIds.join(',')])

  return { plans, loading }
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function LeaveCalendarPage() {
  const { isDM, storeId: myStoreId, role } = useAor()
  const { stores } = useStoresContext()

  const [viewMode, setViewMode] = useState('month') // 'week' | 'month' | 'year'
  const [weekStart, setWeekStart] = useState(() => startOfWeekFri(toDateStr(new Date())))
  const [calMonth, setCalMonth] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const [calYear, setCalYear] = useState(() => new Date().getFullYear())
  const [hiddenStores, setHiddenStores] = useState(new Set())
  const [selectedDate, setSelectedDate] = useState(null) // 'YYYY-MM-DD'

  // Determine which stores to query
  const targetStoreIds = useMemo(() => {
    if (isDM && stores.length > 0) return [...new Set(stores.map((s) => s.id))]
    if (myStoreId) return [myStoreId]
    return []
  }, [isDM, stores, myStoreId])

  const { plans: allPlans, loading } = useLeavePlansForStores(targetStoreIds)

  // Assign stable colours to each store/staff pair
  const colourMap = useMemo(() => {
    const map = {}
    let idx = 0
    allPlans.forEach((p) => {
      const key = isDM ? p.storeId : p.staffId
      if (!map[key]) { map[key] = getPalette(idx++); }
    })
    return map
  }, [allPlans, isDM])

  const visiblePlans = useMemo(() => {
    if (!isDM) return allPlans
    return allPlans.filter((p) => !hiddenStores.has(p.storeId))
  }, [allPlans, hiddenStores, isDM])

  const allStoreIds = useMemo(() => [...new Set(allPlans.map((p) => p.storeId))], [allPlans])

  function storeName(storeId) {
    return stores.find((s) => s.id === storeId)?.name || storeId
  }

  function toggleStore(sid) {
    setHiddenStores((prev) => {
      const next = new Set(prev)
      next.has(sid) ? next.delete(sid) : next.add(sid)
      return next
    })
  }

  const totalOnLeave = useMemo(() => {
    const today = toDateStr(new Date())
    return visiblePlans.filter((p) => planCoversDate(p, today)).length
  }, [visiblePlans])

  return (
    <div className="flex flex-col h-full bg-surface-root">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="px-4 md:px-8 pt-5 md:pt-8 pb-4 border-b border-border-subtle bg-surface-root">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-xl font-semibold text-content-main">
              {isDM ? 'AOR Leave Calendar' : 'Leave Calendar'}
            </h1>
            <p className="text-sm text-content-muted mt-1">
              {isDM
                ? `${stores.length} stores · ${totalOnLeave} on leave today`
                : `${myStoreId || '—'} · ${totalOnLeave} on leave today`}
            </p>
          </div>

          {/* View mode tabs */}
          <div className="flex items-center gap-1 bg-surface-panel rounded-xl p-1 border border-border-subtle">
            {['week', 'month', 'year'].map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all capitalize ${
                  viewMode === m
                    ? 'bg-brand-primary text-white shadow-sm'
                    : 'text-content-muted hover:text-content-main hover:bg-surface-hover'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* DM store filter chips */}
        {isDM && allStoreIds.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-4">
            {allStoreIds.map((sid) => {
              const c = colourMap[sid] || getPalette(0)
              const hidden = hiddenStores.has(sid)
              return (
                <button
                  key={sid}
                  onClick={() => toggleStore(sid)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                    hidden
                      ? 'bg-surface-panel border-border-subtle text-content-muted opacity-50'
                      : `${c.bg} ${c.border} ${c.text}`
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${hidden ? 'bg-content-muted' : c.dot}`} />
                  {storeName(sid)}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-content-muted text-sm animate-pulse">
            Loading leave data…
          </div>
        ) : viewMode === 'week' ? (
          <WeekView
            plans={visiblePlans}
            weekStart={weekStart}
            onPrev={() => setWeekStart((w) => addWeeks(w, -1))}
            onNext={() => setWeekStart((w) => addWeeks(w, 1))}
            colourMap={colourMap}
            isDM={isDM}
            storeName={storeName}
            onSelectDate={setSelectedDate}
          />
        ) : viewMode === 'month' ? (
          <MonthView
            plans={visiblePlans}
            year={calMonth.year}
            month={calMonth.month}
            onPrev={() =>
              setCalMonth(({ year, month }) =>
                month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }
              )
            }
            onNext={() =>
              setCalMonth(({ year, month }) =>
                month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }
              )
            }
            colourMap={colourMap}
            isDM={isDM}
            storeName={storeName}
            onSelectDate={setSelectedDate}
          />
        ) : (
          <YearView
            plans={visiblePlans}
            year={calYear}
            onPrev={() => setCalYear((y) => y - 1)}
            onNext={() => setCalYear((y) => y + 1)}
            colourMap={colourMap}
            isDM={isDM}
            storeName={storeName}
            onSelectDate={setSelectedDate}
          />
        )}
      </div>

      {selectedDate && (
        <DayDetailsModal
          dateStr={selectedDate}
          plans={visiblePlans.filter(p => planCoversDate(p, selectedDate))}
          isDM={isDM}
          storeName={storeName}
          colourMap={colourMap}
          onClose={() => setSelectedDate(null)}
        />
      )}
    </div>
  )
}

// ─── Week View ────────────────────────────────────────────────────────────────
function WeekView({ plans, weekStart, onPrev, onNext, colourMap, isDM, storeName, onSelectDate }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const weekPlans = plans.filter((p) => planInRange(p, weekStart, days[6]))

  // Group by staff
  const staffMap = {}
  weekPlans.forEach((p) => {
    const key = p.staffId
    if (!staffMap[key]) staffMap[key] = { name: p.staffName, storeId: p.storeId, plans: [] }
    staffMap[key].plans.push(p)
  })
  const staffRows = Object.values(staffMap)

  return (
    <div className="px-4 md:px-8 py-6">
      {/* Nav */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={onPrev} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main transition-colors text-sm">
          ← Prev Week
        </button>
        <span className="text-sm font-medium text-content-main">
          {fmtDay(weekStart)} — {fmtDay(days[6])}
          <span className="ml-2 text-xs text-content-muted/60 font-normal">
            Week {getISOWeek(days[6])}
          </span>
        </span>
        <button onClick={onNext} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main transition-colors text-sm">
          Next Week →
        </button>
      </div>

      {staffRows.length === 0 ? (
        <EmptyState message="No leave plans this week." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] border-collapse">
            <thead>
              <tr>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider w-44">
                  Staff
                </th>
                {days.map((d, i) => (
                  <th key={d} className="text-center px-1 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">
                    <div>{WEEK_LABELS[i]}</div>
                    <div className="text-[10px] font-normal mt-0.5 text-content-muted/60">
                      {new Date(d + 'T00:00:00').getDate()}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {staffRows.map((row) => {
                const colKey = isDM ? row.storeId : row.plans[0]?.staffId
                const c = colourMap[colKey] || getPalette(0)
                return (
                  <tr key={row.name + row.storeId} className="hover:bg-surface-hover/40 transition-colors">
                    <td className="px-3 py-3">
                      <div className="text-sm font-medium text-content-main">{row.name}</div>
                      {isDM && (
                        <div className={`text-[10px] mt-0.5 ${c.text}`}>{storeName(row.storeId)}</div>
                      )}
                    </td>
                    {days.map((d) => {
                      const onLeave = row.plans.some((p) => planCoversDate(p, d))
                      return (
                        <td key={d} className="px-1 py-2 text-center">
                          {onLeave ? (
                            <button 
                              onClick={() => onSelectDate(d)}
                              className={`mx-auto w-8 h-8 rounded-lg flex items-center justify-center ${c.bg} ${c.border} border hover:scale-110 active:scale-95 transition-transform`}
                            >
                              <span className={`text-[10px] font-bold ${c.text}`}>L</span>
                            </button>
                          ) : (
                            <div className="mx-auto w-8 h-8 rounded-lg bg-surface-panel/30" />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Month View ───────────────────────────────────────────────────────────────
function MonthView({ plans, year, month, onPrev, onNext, colourMap, isDM, storeName, onSelectDate }) {
  const cells = getMonthGrid(year, month)
  const monthStart = toDateStr(new Date(year, month, 1))
  const monthEnd = toDateStr(new Date(year, month + 1, 0))
  const monthPlans = plans.filter((p) => planInRange(p, monthStart, monthEnd))
  const today = toDateStr(new Date())

  function plansOnDate(dateStr) {
    const raw = monthPlans.filter((p) => planCoversDate(p, dateStr))
    // De-duplicate by staffId so each person only appears once per day
    const seen = new Set()
    return raw.filter(p => {
      if (seen.has(p.staffId)) return false
      seen.add(p.staffId)
      return true
    })
  }

  return (
    <div className="px-4 md:px-8 py-6">
      {/* Nav */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={onPrev} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main transition-colors text-sm">
          ← Prev
        </button>
        <span className="text-base font-semibold text-content-main">{fmtMonth(year, month)}</span>
        <button onClick={onNext} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main transition-colors text-sm">
          Next →
        </button>
      </div>

      {/* Week rows with ISO week numbers */}
      {(() => {
        const weeks = []
        for (let i = 0; i < cells.length; i += 7) {
          weeks.push(cells.slice(i, i + 7))
        }
        return (
          <div className="space-y-1.5">
            {/* Header row */}
            <div className="grid grid-cols-[2rem_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-1.5">
              <div />
              {WEEK_LABELS.map((d) => (
                <div key={d} className="text-center text-[11px] font-semibold text-content-muted uppercase tracking-wider py-2">
                  {d}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => {
              const thursday = week[6]?.dateStr
              const weekNum = thursday ? getISOWeek(thursday) : ''
              return (
                <div key={wi} className="grid grid-cols-[2rem_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-1.5">
                  <div className="flex items-start justify-end pr-1 pt-2">
                    {weekNum && (
                      <span className="text-[10px] font-bold text-content-muted/30">W{weekNum}</span>
                    )}
                  </div>
                  {week.map(({ dateStr, inMonth }) => {
                    const dayPlans = plansOnDate(dateStr)
                    const isToday = dateStr === today
                    return (
                      <div
                        key={dateStr}
                        onClick={() => onSelectDate(dateStr)}
                        className={`min-h-[90px] rounded-xl p-2 transition-all cursor-pointer group ${
                          inMonth
                            ? isToday
                              ? 'bg-brand-primary/10 border border-brand-primary/30 ring-1 ring-brand-primary/20'
                              : 'bg-surface-panel/60 hover:bg-surface-hover/90 border border-border-subtle/40 hover:border-border-subtle hover:translate-y-[-2px]'
                            : 'bg-transparent opacity-30 pointer-events-none'
                        }`}
                      >
                        <div className={`text-xs font-semibold mb-1.5 ${
                          isToday ? 'text-brand-primary' : inMonth ? 'text-content-muted' : 'text-content-muted/40'
                        }`}>
                          {new Date(dateStr + 'T00:00:00').getDate()}
                        </div>
                        {dayPlans.slice(0, 3).map((p) => {
                          const colKey = isDM ? p.storeId : p.staffId
                          const c = colourMap[colKey] || getPalette(0)
                          return (
                            <div
                              key={p.id}
                              title={isDM ? `${p.staffName} · ${storeName(p.storeId)}` : p.staffName}
                              className={`truncate text-[10px] font-medium px-1.5 py-0.5 rounded-md mb-0.5 ${c.bg} ${c.text} border ${c.border}`}
                            >
                              {isDM
                                ? `${p.staffName.split(' ')[0]} · ${storeName(p.storeId)}`
                                : p.staffName.split(' ')[0]}
                            </div>
                          )
                        })}
                        {dayPlans.length > 3 && (
                          <div className="text-[9px] text-content-muted mt-0.5 font-medium">
                            +{dayPlans.length - 3} more
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Legend total */}
      <div className="mt-4 pt-4 border-t border-border-subtle flex items-center gap-2 text-xs text-content-muted">
        <span className="font-medium text-content-main">{monthPlans.length}</span> leave plan{monthPlans.length !== 1 ? 's' : ''} in {fmtMonth(year, month)}
      </div>
    </div>
  )
}

// ─── Year View ────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function YearView({ plans, year, onPrev, onNext, colourMap, isDM, storeName, onSelectDate }) {
  const today = toDateStr(new Date())

  function countOnDate(dateStr) {
    return plans.filter((p) => planCoversDate(p, dateStr)).length
  }

  function plansOnDate(dateStr) {
    return plans.filter((p) => planCoversDate(p, dateStr))
  }

  function getDensityStyle(count) {
    if (count === 0) return { backgroundColor: 'var(--cal-d0)' }
    if (count === 1) return { backgroundColor: 'var(--cal-d1)' }
    if (count <= 3) return { backgroundColor: 'var(--cal-d2)' }
    if (count <= 6) return { backgroundColor: 'var(--cal-d3)' }
    return { backgroundColor: 'var(--cal-d4)' }
  }

  return (
    <div className="px-4 md:px-8 py-6">
      {/* Nav */}
      <div className="flex items-center justify-between mb-8">
        <button onClick={onPrev} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main transition-colors text-sm">
          ← {year - 1}
        </button>
        <span className="text-2xl font-bold text-content-main">{year}</span>
        <button onClick={onNext} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main transition-colors text-sm">
          {year + 1} →
        </button>
      </div>

      {/* 12-month grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {Array.from({ length: 12 }, (_, m) => {
          const mStart = toDateStr(new Date(year, m, 1))
          const mEnd = toDateStr(new Date(year, m + 1, 0))

          return (
            <div key={m} className="bg-surface-panel/50 rounded-2xl p-4 border border-border-subtle/50">
              {/* Month header */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-content-main">{MONTH_NAMES[m]}</span>
                <span className="text-[10px] text-content-muted">
                  {plans.filter((p) => planInRange(p, mStart, mEnd)).length} plans
                </span>
              </div>

              {/* Day squares grid with week numbers */}
              {(() => {
                const firstDay = new Date(year, m, 1).getDay()
                const offset = (firstDay - 5 + 7) % 7
                const daysInMonth = new Date(year, m + 1, 0).getDate()

                // Build explicit weeks
                const weeks = []
                let currentWeek = Array(offset).fill(null)
                for (let d = 1; d <= daysInMonth; d++) {
                  currentWeek.push(toDateStr(new Date(year, m, d)))
                  if (currentWeek.length === 7) {
                    weeks.push(currentWeek)
                    currentWeek = []
                  }
                }
                if (currentWeek.length > 0) {
                  while (currentWeek.length < 7) currentWeek.push(null)
                  weeks.push(currentWeek)
                }

                return (
                  <div className="space-y-0.5">
                    {/* Header row */}
                    <div className="grid grid-cols-[1.25rem_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-0.5">
                      <div />
                      {WEEK_LABELS.map((d) => (
                        <div key={d} className="text-[8px] text-content-muted/50 text-center font-medium pb-1 uppercase">
                          {d[0]}
                        </div>
                      ))}
                    </div>
                    {/* Week rows */}
                    {weeks.map((week, wi) => {
                      const thursday = week[6]
                      const weekNum = thursday ? getISOWeek(thursday) : ''
                      return (
                        <div key={wi} className="grid grid-cols-[1.25rem_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-0.5 items-center">
                          <div className="text-[8px] text-content-muted/40 font-medium text-right pr-0.5">
                            {weekNum && `W${weekNum}`}
                          </div>
                          {week.map((dateStr, di) => {
                            if (!dateStr) return <div key={di} className="h-5" />
                            const count = countOnDate(dateStr)
                            const isToday = dateStr === today
                            const dayPlans = plansOnDate(dateStr)
                            const tooltip = dayPlans.map(p =>
                              isDM ? `${p.staffName} (${storeName(p.storeId)})` : p.staffName
                            ).join(', ')
                            const dayNum = Number(dateStr.split('-')[2])
                            return (
                              <button
                                key={di}
                                title={count > 0 ? `${dayNum}: ${tooltip}` : `${dayNum}`}
                                onClick={() => onSelectDate(dateStr)}
                                style={getDensityStyle(count)}
                                className={`h-5 rounded-sm transition-all hover:scale-125 hover:z-10 relative ${
                                  isToday ? 'ring-1 ring-brand-primary ring-offset-1 ring-offset-surface-root' : ''
                                }`}
                              />
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="mt-6 pt-4 border-t border-border-subtle flex flex-wrap items-center gap-4 text-xs text-content-muted">
        <span className="font-medium text-content-main/60 uppercase tracking-wider text-[10px]">Leave density</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'var(--cal-d0)' }} /> None</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'var(--cal-d1)' }} /> 1</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'var(--cal-d2)' }} /> 2–3</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'var(--cal-d3)' }} /> 4–6</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'var(--cal-d4)' }} /> 7+</span>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ message }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-content-muted gap-3">
      <svg className="w-12 h-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2}
          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <p className="text-sm">{message}</p>
    </div>
  )
}

function DayDetailsModal({ dateStr, plans, isDM, storeName, colourMap, onClose }) {
  const formattedDate = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-panel border border-border-subtle w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="p-6 border-b border-border-subtle flex items-center justify-between bg-surface-root/50">
          <div>
            <h3 className="text-lg font-bold text-content-main">{formattedDate}</h3>
            <p className="text-xs text-content-muted mt-0.5">{plans.length} staff member{plans.length !== 1 ? 's' : ''} on leave</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-surface-hover text-content-muted transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
          {(() => {
            // De-duplicate by staffId for the list view as well
            const seen = new Set()
            const uniquePlans = plans.filter(p => {
              if (seen.has(p.staffId)) return false
              seen.add(p.staffId)
              return true
            })

            if (uniquePlans.length === 0) {
              return (
                <div className="py-12 text-center text-content-muted italic text-sm">
                  No staff members scheduled for leave on this day.
                </div>
              )
            }

            return uniquePlans.map(p => {
              const colKey = isDM ? p.storeId : p.staffId
              const c = colourMap[colKey] || getPalette(0)
              return (
                <div key={p.id} className="flex items-start gap-4 p-4 rounded-2xl bg-surface-root/40 border border-border-subtle/30 hover:border-border-subtle transition-colors group">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${c.bg} ${c.border} border shadow-sm`}>
                    <span className={`font-bold ${c.text}`}>{p.staffName[0]}</span>
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-bold text-content-main truncate">{p.staffName}</h4>
                      {isDM && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${c.bg} ${c.text} border ${c.border}`}>
                          {storeName(p.storeId)}
                        </span>
                      )}
                    </div>
                    
                    {p.note && (
                      <p className="text-xs text-content-muted mt-1 leading-relaxed bg-surface-panel/50 px-2 py-1.5 rounded-lg border border-border-subtle/20 italic">
                        "{p.note}"
                      </p>
                    )}

                    <div className="flex items-center gap-3 mt-2">
                       <span className="text-[10px] text-content-muted flex items-center gap-1">
                         <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                         {p.startDate} — {p.endDate}
                       </span>
                    </div>
                  </div>
                </div>
              )
            })
          })()}
        </div>

        <div className="p-4 border-t border-border-subtle bg-surface-root/30 flex justify-end">
          <button 
            onClick={onClose}
            className="px-6 py-2 rounded-xl bg-content-main text-surface-root text-sm font-bold hover:opacity-90 transition-opacity"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
