import { useState, useEffect } from 'react'
import { WEEK_DAYS, getWeekStartFriday, getWeekDates, formatDate } from '../data/stores'
import { useStoresContext } from '../contexts/StoresContext'
import { fetchAllStoresSummary } from '../hooks/useSchedule'
import WeekPicker from './WeekPicker'
import { exportSupportPoolPDF } from '../utils/pdfExport'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../firebase'

// Support Pool is auto-generated from store schedules.
// Any staff member with at least one "Support" shift day appears here,
// along with which store they are going to and which days.

export default function SupportPoolPage() {
  const { stores: STORES } = useStoresContext()
  const [weekStart, setWeekStart] = useState(getWeekStartFriday)
  const [poolEntries, setPoolEntries] = useState([]) // [{ staffName, homeStore, destStore, days }]
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    buildSupportPool(weekStart).then((entries) => {
      setPoolEntries(entries)
      setLoading(false)
    })
  }, [weekStart])

  async function buildSupportPool(weekStartDate) {
    // Fetch all rosters (to get staff names by ID)
    const rostersByStore = {}
    for (const store of STORES) {
      const snap = await getDocs(collection(db, 'stores', store.id, 'roster'))
      rostersByStore[store.id] = {}
      snap.docs.forEach((d) => { rostersByStore[store.id][d.id] = d.data() })
    }

    // Fetch all schedules for the week
    const summary = await fetchAllStoresSummary(STORES, weekStartDate)

    const entries = []

    for (const store of STORES) {
      const storeEntries = summary[store.id] || {}
      for (const [staffId, dayMap] of Object.entries(storeEntries)) {
        const supportDays = WEEK_DAYS.filter((day) => dayMap[day] === 'Support')
        if (supportDays.length === 0) continue

        const staffData = rostersByStore[store.id]?.[staffId]
        const staffName = staffData?.name || staffId

        // Group by destination store
        const destGroups = {}
        for (const day of supportDays) {
          const dest = dayMap[`${day}_dest`] || 'Unknown'
          if (!destGroups[dest]) destGroups[dest] = []
          destGroups[dest].push(day)
        }

        for (const [destStoreId, days] of Object.entries(destGroups)) {
          const destStore = STORES.find((s) => s.id === destStoreId)
          entries.push({
            staffName,
            staffId,
            position: staffData?.position || '',
            empNo: staffData?.empNo || '',
            homeStoreId: store.id,
            homeStoreName: store.name,
            destStoreId,
            destStoreName: destStore?.name || destStoreId,
            days,
          })
        }
      }
    }

    return entries
  }

  const weekDates = getWeekDates(weekStart)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-6 border-b border-border-subtle">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-content-main">Support Pool</h1>
            <p className="text-sm text-content-muted mt-1">
              Auto-populated from store schedules. Staff with "Support" shifts appear here.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
            <button
              onClick={() => exportSupportPoolPDF(poolEntries, weekStart).catch(console.error)}
              disabled={poolEntries.length === 0}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel disabled:opacity-40 text-content-muted text-sm transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export PDF
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-content-muted text-sm">Loading…</div>
        ) : poolEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-content-muted gap-3">
            <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
            <p className="text-sm">No support assignments this week.</p>
            <p className="text-xs text-content-muted max-w-xs text-center">
              Go to a store's schedule, set a staff member's shift to "Support", then select which store they're going to.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider">Staff</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider">Home Store</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider">Supporting</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {poolEntries.map((entry, idx) => (
                  <tr key={idx} className="hover:bg-surface-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="text-content-main font-medium">{entry.staffName}</div>
                      <div className="text-content-muted text-xs">{entry.position}{entry.empNo ? ` · ${entry.empNo}` : ''}</div>
                    </td>
                    <td className="px-4 py-3 text-content-muted text-sm">{entry.homeStoreName}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--shift-support-bg)] text-[var(--shift-support-text)] text-xs font-medium">
                        → {entry.destStoreName}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {entry.days.map((day) => (
                          <span key={day} className="px-2 py-0.5 rounded bg-surface-panel text-content-muted text-xs">{day}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
