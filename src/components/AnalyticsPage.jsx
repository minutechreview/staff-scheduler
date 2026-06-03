import { useState, useEffect, useMemo } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import { useStoresContext } from '../contexts/StoresContext'
import { fetchAllStoresSummary } from '../hooks/useSchedule'
import { WEEK_DAYS, SIC_POSITIONS, getWeekStartFriday, getPrevWeekStart } from '../data/stores'

export default function AnalyticsPage() {
  const { stores } = useStoresContext()
  const [loading, setLoading] = useState(true)
  const [weekSummaries, setWeekSummaries] = useState({}) // { weekStart: summary }
  const [leaveBalances, setLeaveBalances] = useState([])
  const [refreshCount, setRefreshCount] = useState(0)

  // Generate last 12 week-start dates
  const weeks = useMemo(() => {
    const dates = []
    let current = getWeekStartFriday()
    for (let i = 0; i < 12; i++) {
      dates.push(current)
      current = getPrevWeekStart(current)
    }
    return dates.reverse()
  }, [])

  useEffect(() => {
    if (!stores || stores.length === 0) return
    async function loadAll() {
      setLoading(true)
      try {
        // Fetch schedule summaries for all 12 weeks in parallel
        const summaryResults = await Promise.all(
          weeks.map(async (w) => {
            const data = await fetchAllStoresSummary(stores, w, { includeRoster: true })
            return [w, data]
          })
        )
        const summaryMap = {}
        for (const [w, data] of summaryResults) summaryMap[w] = data

        // Fetch leave balances
        const balSnap = await getDocs(collection(db, 'leaveBalances'))
        const bals = balSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

        setWeekSummaries(summaryMap)
        setLeaveBalances(bals)
      } catch (err) {
        console.error('[Analytics] Load error:', err)
      } finally {
        setLoading(false)
      }
    }
    loadAll()
  }, [weeks, stores, refreshCount])

  // ── Computed Analytics ──────────────────────────────────────────────

  // 1. Leave Utilization — per store
  const leaveStats = useMemo(() => {
    const byStore = {}
    for (const store of stores) {
      byStore[store.id] = { name: store.name, staff: [], totalUsed: 0, totalBalance: 0, lowCount: 0 }
    }
    for (const bal of leaveBalances) {
      const bucket = byStore[bal.storeId]
      if (!bucket) continue
      const used = bal.used || 0
      const total = bal.totalBalance || 30
      const remaining = bal.remaining ?? (total - used)
      bucket.staff.push({ name: bal.staffName || bal.staffId, used, total, remaining })
      bucket.totalUsed += used
      bucket.totalBalance += total
      if (remaining <= 5) bucket.lowCount++
    }
    return Object.entries(byStore)
      .map(([id, data]) => ({ id, ...data }))
      .filter((s) => s.staff.length > 0)
      .sort((a, b) => (b.totalUsed / (b.totalBalance || 1)) - (a.totalUsed / (a.totalBalance || 1)))
  }, [stores, leaveBalances])

  // 2. Support Frequency — who sends and receives the most support
  const supportStats = useMemo(() => {
    const sent = {} // storeId → count of Support shifts sent out
    const received = {} // storeId → count of support-in visitors
    const pairs = {} // "from→to" → count

    for (const store of stores) {
      sent[store.id] = 0
      received[store.id] = 0
    }

    for (const weekData of Object.values(weekSummaries)) {
      for (const [storeId, storeSummary] of Object.entries(weekData)) {
        const entries = storeSummary.entries || {}
        // Count Support shifts sent FROM this store
        for (const staffEntry of Object.values(entries)) {
          for (const day of WEEK_DAYS) {
            if (staffEntry[day] === 'Support') {
              sent[storeId] = (sent[storeId] || 0) + 1
              const dest = staffEntry[`${day}_dest`]
              if (dest) {
                received[dest] = (received[dest] || 0) + 1
                const pairKey = `${storeId}→${dest}`
                pairs[pairKey] = (pairs[pairKey] || 0) + 1
              }
            }
          }
        }
      }
    }

    const storeStats = stores.map((s) => ({
      id: s.id,
      name: s.name,
      sent: sent[s.id] || 0,
      received: received[s.id] || 0,
      net: (received[s.id] || 0) - (sent[s.id] || 0),
    })).sort((a, b) => b.sent + b.received - (a.sent + a.received))

    const topPairs = Object.entries(pairs)
      .map(([key, count]) => {
        const [fromId, toId] = key.split('→')
        const fromName = stores.find((s) => s.id === fromId)?.name?.split(' ').slice(-1)[0] || fromId
        const toName = stores.find((s) => s.id === toId)?.name?.split(' ').slice(-1)[0] || toId
        return { fromName, toName, count }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    return { storeStats, topPairs }
  }, [stores, weekSummaries])

  // 3. SIC Coverage Gaps
  const sicStats = useMemo(() => {
    const gapsByStore = {}
    for (const store of stores) gapsByStore[store.id] = { name: store.name, gaps: 0, details: [] }

    for (const [weekStart, weekData] of Object.entries(weekSummaries)) {
      for (const store of stores) {
        const storeSummary = weekData[store.id]
        if (!storeSummary) continue
        const entries = storeSummary.entries || {}
        const roster = storeSummary.roster || {}
        const staffIds = Object.keys(entries)
        if (staffIds.length === 0) continue

        for (const day of WEEK_DAYS) {
          const hasAM = staffIds.some((id) => {
            const v = entries[id]?.[day]
            return v === 'AM Shift' || v === 'AM 8h'
          })
          const hasPM = staffIds.some((id) => entries[id]?.[day] === 'PM Shift')

          const hasSIC = (shiftType) => staffIds.some((id) => {
            const member = roster[id]
            if (!SIC_POSITIONS.includes(member?.position)) return false
            const v = entries[id]?.[day]
            if (v === shiftType) return true
            if (shiftType === 'AM Shift' && v === 'AM 8h') return true
            return false
          })

          if (hasAM && !hasSIC('AM Shift')) {
            gapsByStore[store.id].gaps++
          }
          if (hasPM && !hasSIC('PM Shift')) {
            gapsByStore[store.id].gaps++
          }
        }
      }
    }

    return Object.entries(gapsByStore)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.gaps - a.gaps)
  }, [stores, weekSummaries])

  // 4. Shift Distribution — aggregate across all weeks
  const shiftDistribution = useMemo(() => {
    const SHIFT_TYPES = ['AM Shift', 'PM Shift', 'Mid Shift', 'GY Shift', 'Day Off', 'Leave', 'Support']
    const byStore = {}
    for (const store of stores) {
      byStore[store.id] = { name: store.name, counts: {} }
      for (const t of SHIFT_TYPES) byStore[store.id].counts[t] = 0
      byStore[store.id].counts['AM 8h'] = 0
    }

    for (const weekData of Object.values(weekSummaries)) {
      for (const [storeId, storeSummary] of Object.entries(weekData)) {
        if (!byStore[storeId]) continue
        const entries = storeSummary.entries || {}
        for (const staffEntry of Object.values(entries)) {
          for (const day of WEEK_DAYS) {
            const v = staffEntry[day]
            if (v && byStore[storeId].counts[v] !== undefined) {
              byStore[storeId].counts[v]++
            }
          }
        }
      }
    }

    return Object.entries(byStore)
      .map(([id, data]) => {
        const total = Object.values(data.counts).reduce((s, c) => s + c, 0)
        const am = data.counts['AM Shift'] + data.counts['AM 8h']
        const pm = data.counts['PM Shift']
        const amPmRatio = (am + pm) > 0 ? Math.round((am / (am + pm)) * 100) : 50
        return { id, name: data.name, counts: data.counts, total, amPmRatio }
      })
      .filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total)
  }, [stores, weekSummaries])

  const totalSicGaps = sicStats.reduce((s, st) => s + st.gaps, 0)
  const totalLeaveUsed = leaveStats.reduce((s, st) => s + st.totalUsed, 0)
  const totalLeaveBalance = leaveStats.reduce((s, st) => s + st.totalBalance, 0)
  const overallUtilization = totalLeaveBalance > 0 ? Math.round((totalLeaveUsed / totalLeaveBalance) * 100) : 0

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 md:px-8 pt-5 md:pt-8 pb-4 md:pb-6 border-b border-border-subtle">
          <h1 className="text-xl font-semibold text-content-main">Analytics</h1>
          <p className="text-sm text-content-muted mt-1">Loading 12 weeks of data…</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-content-muted">
            <svg className="w-8 h-8 animate-spin text-brand-primary" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            <span className="text-sm">Aggregating schedule data…</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 md:px-8 pt-5 md:pt-8 pb-4 md:pb-6 border-b border-border-subtle flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-content-main">Analytics</h1>
          <p className="text-sm text-content-muted mt-1">
            {stores.length} stores · Last 12 weeks · {totalLeaveUsed} leave days used({overallUtilization}%)
          </p>
        </div>
        <button
          onClick={() => setRefreshCount(c => c + 1)}
          className="text-xs text-content-muted hover:text-content-main transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-surface-panel"
        >
          <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Dashboard Grid */}
      <div className="flex-1 overflow-auto px-4 md:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Card 1: Leave Utilization ────────────────────────── */}
          <DashboardCard
            title="Leave Utilization"
            subtitle={`${totalLeaveUsed} of ${totalLeaveBalance} days used (${overallUtilization}%)`}
            icon={<CalendarIcon />}
            accent="text-red-400"
          >
            <div className="space-y-2.5">
              {leaveStats.map((store) => {
                const pct = store.totalBalance > 0 ? Math.round((store.totalUsed / store.totalBalance) * 100) : 0
                return (
                  <div key={store.id}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-content-main font-medium truncate pr-2">{store.name}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {store.lowCount > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 font-medium">
                            {store.lowCount} low
                          </span>
                        )}
                        <span className="text-[10px] text-content-muted">{store.totalUsed}/{store.totalBalance}d</span>
                      </div>
                    </div>
                    <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-green-500'}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
              {leaveStats.length === 0 && (
                <p className="text-xs text-content-muted text-center py-4">No leave balance data found.</p>
              )}
            </div>
          </DashboardCard>

          {/* ── Card 2: Support Frequency ────────────────────────── */}
          <DashboardCard
            title="Support Frequency"
            subtitle={`${supportStats.storeStats.reduce((s, st) => s + st.sent, 0)} support shifts in 12 weeks`}
            icon={<ArrowsIcon />}
            accent="text-amber-400"
          >
            <div className="space-y-2">
              {supportStats.storeStats.filter((s) => s.sent + s.received > 0).map((store) => {
                const maxVal = Math.max(...supportStats.storeStats.map((s) => s.sent + s.received), 1)
                const barW = Math.round(((store.sent + store.received) / maxVal) * 100)
                return (
                  <div key={store.id} className="flex items-center gap-2">
                    <span className="text-[10px] text-content-muted w-20 truncate flex-shrink-0">{store.name.split(' ').slice(-1)[0]}</span>
                    <div className="flex-1 flex h-3 rounded-full overflow-hidden bg-surface-hover">
                      <div className="bg-amber-600/60 h-full" style={{ width: `${Math.round((store.sent / Math.max(store.sent + store.received, 1)) * barW)}%` }} title={`Sent: ${store.sent}`} />
                      <div className="bg-blue-600/60 h-full" style={{ width: `${Math.round((store.received / Math.max(store.sent + store.received, 1)) * barW)}%` }} title={`Received: ${store.received}`} />
                    </div>
                    <span className="text-[10px] text-content-muted w-12 text-right flex-shrink-0">
                      {store.net > 0 ? `+${store.net}` : store.net}
                    </span>
                  </div>
                )
              })}
            </div>
            {supportStats.topPairs.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border-subtle">
                <p className="text-[10px] text-content-muted uppercase tracking-wider mb-2">Top Routes</p>
                <div className="flex flex-wrap gap-1.5">
                  {supportStats.topPairs.map((pair, i) => (
                    <span key={i} className="text-[10px] px-2 py-1 rounded-lg bg-surface-hover text-content-muted">
                      {pair.fromName} → {pair.toName} <span className="text-amber-400 font-semibold">×{pair.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-4 mt-3 text-[10px] text-content-muted">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-600/60" />Sent</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-600/60" />Received</span>
            </div>
          </DashboardCard>

          {/* ── Card 3: SIC Coverage Gaps ────────────────────────── */}
          <DashboardCard
            title="SIC Coverage Gaps"
            subtitle={`${totalSicGaps} gap${totalSicGaps !== 1 ? 's' : ''} detected across 12 weeks`}
            icon={<ShieldIcon />}
            accent={totalSicGaps > 0 ? 'text-orange-400' : 'text-green-400'}
          >
            {totalSicGaps === 0 ? (
              <div className="flex items-center justify-center py-6 gap-2 text-green-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm font-medium">All shifts covered by SIC</span>
              </div>
            ) : (
              <div className="space-y-2">
                {sicStats.filter((s) => s.gaps > 0).map((store) => {
                  const maxGaps = Math.max(...sicStats.map((s) => s.gaps), 1)
                  const barW = Math.round((store.gaps / maxGaps) * 100)
                  return (
                    <div key={store.id} className="flex items-center gap-2">
                      <span className="text-[10px] text-content-muted w-24 truncate flex-shrink-0">{store.name.split(' ').slice(-1)[0]}</span>
                      <div className="flex-1 h-2.5 bg-surface-hover rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${store.gaps > 10 ? 'bg-red-500' : store.gaps > 3 ? 'bg-orange-500' : 'bg-amber-500'}`}
                          style={{ width: `${barW}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-content-muted w-8 text-right font-medium">{store.gaps}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </DashboardCard>

          {/* ── Card 4: Shift Distribution ────────────────────────── */}
          <DashboardCard
            title="Shift Distribution"
            subtitle="AM / PM balance across stores"
            icon={<PieIcon />}
            accent="text-blue-400"
          >
            <div className="space-y-3">
              {shiftDistribution.map((store) => {
                const am = store.counts['AM Shift'] + store.counts['AM 8h']
                const pm = store.counts['PM Shift']
                const mid = store.counts['Mid Shift'] + store.counts['GY Shift']
                const off = store.counts['Day Off']
                const leave = store.counts['Leave']
                const support = store.counts['Support']
                const total = store.total || 1

                return (
                  <div key={store.id}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-content-main font-medium truncate pr-2">{store.name.split(' ').slice(-1)[0]}</span>
                      <span className={`text-[10px] font-semibold ${
                        store.amPmRatio > 60 || store.amPmRatio < 40 ? 'text-amber-400' : 'text-green-400'
                      }`}>
                        {store.amPmRatio}% AM
                      </span>
                    </div>
                    <div className="flex h-3 rounded-full overflow-hidden gap-px">
                      {am > 0 && <div className="bg-blue-500/70 h-full" style={{ width: `${(am / total) * 100}%` }} title={`AM: ${am}`} />}
                      {pm > 0 && <div className="bg-indigo-500/70 h-full" style={{ width: `${(pm / total) * 100}%` }} title={`PM: ${pm}`} />}
                      {mid > 0 && <div className="bg-teal-500/70 h-full" style={{ width: `${(mid / total) * 100}%` }} title={`Mid/GY: ${mid}`} />}
                      {off > 0 && <div className="bg-[var(--shift-off-bg)] h-full" style={{ width: `${(off / total) * 100}%` }} title={`Off: ${off}`} />}
                      {leave > 0 && <div className="bg-[var(--shift-leave-bg)] h-full" style={{ width: `${(leave / total) * 100}%` }} title={`Leave: ${leave}`} />}
                      {support > 0 && <div className="bg-[var(--shift-support-bg)] h-full" style={{ width: `${(support / total) * 100}%` }} title={`Support: ${support}`} />}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-border-subtle text-[10px] text-content-muted">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500/70" />AM</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-500/70" />PM</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal-500/70" />Mid/GY</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--shift-off-bg)]" />Off</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--shift-leave-bg)]" />Leave</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[var(--shift-support-bg)]" />Support</span>
            </div>
          </DashboardCard>
        </div>
      </div>
    </div>
  )
}

// ── Shared Components ──────────────────────────────────────────────────

function DashboardCard({ title, subtitle, icon, accent, children }) {
  return (
    <div className="bg-surface-panel border border-border-subtle rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
        <div className={`w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center flex-shrink-0 ${accent}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-content-main">{title}</h3>
          <p className="text-[10px] text-content-muted truncate">{subtitle}</p>
        </div>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  )
}

// ── Icons ──────────────────────────────────────────────────────────────

function CalendarIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function ArrowsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  )
}

function PieIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5z" />
    </svg>
  )
}
