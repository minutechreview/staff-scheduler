import { useState, useEffect, useRef } from 'react'
import { WEEK_DAYS, getWeekStartFriday, getWeekDates, formatDate, getStoreStatus, validateStaffWeek, SIC_POSITIONS } from '../data/stores'
import { useStoresContext } from '../contexts/StoresContext'
import { fetchAllStoresSummary } from '../hooks/useSchedule'
import WeekPicker from './WeekPicker'
import { importScheduleFromExcel } from '../utils/excelImport'

const CATEGORY_BADGE = {
  'regular':    { label: 'Regular',    color: 'text-content-muted bg-surface-panel' },
  'office-12h': { label: 'Office 12h', color: 'text-amber-400/70 bg-amber-900/20' },
  'office-8h':  { label: 'Office 8h',  color: 'text-sky-400/70 bg-sky-900/20' },
  'office-10h': { label: 'Office 10h', color: 'text-purple-400/70 bg-purple-900/20' },
}

export default function OverviewPage({ onNavigate }) {
  const { stores: STORES } = useStoresContext()
  const [weekStart, setWeekStart] = useState(getWeekStartFriday)
  const [summary, setSummary] = useState({})
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const fileInputRef = useRef(null)
  const weekDates = getWeekDates(weekStart)

  useEffect(() => {
    if (!STORES || STORES.length === 0) return
    setLoading(true)
    fetchAllStoresSummary(STORES, weekStart, { includeVisitors: true, includeRoster: true }).then((data) => {
      setSummary(data)
      setLoading(false)
    })
  }, [weekStart, STORES])

  async function handleImportExcel(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setImportResult(null)
    try {
      const result = await importScheduleFromExcel(file, weekStart)
      setImportResult({ success: true, message: `Imported ${result.imported} entries across ${result.stores.length} stores for week of ${formatDate(weekStart)}` })
      const data = await fetchAllStoresSummary(STORES, weekStart, { includeVisitors: true, includeRoster: true })
      setSummary(data)
    } catch (err) {
      setImportResult({ success: false, message: `Import failed: ${err.message}` })
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  function getOverviewStoreData(store) {
    const storeSummary = summary[store.id] || {}
    const rawEntries = storeSummary.entries || {}
    const visitors = storeSummary.visitors || {}
    const roster = storeSummary.roster || {}
    const visibleStaffIds = new Set([...Object.keys(roster), ...Object.keys(visitors)])
    const entries = Object.fromEntries(
      Object.entries(rawEntries).filter(([id]) => visibleStaffIds.has(id))
    )
    const hiddenEntryIds = Object.keys(rawEntries).filter((id) => !visibleStaffIds.has(id))
    return { entries, rawEntries, visitors, roster, hiddenEntryIds }
  }

  function getOverviewStatusDetails(store) {
    const { entries, visitors, roster, hiddenEntryIds } = getOverviewStoreData(store)
    const rosterMap = { ...roster, ...visitors }
    const excludeDayOffStaffIds = Object.keys(visitors)
    const status = getStoreStatus(store, entries, rosterMap, { excludeDayOffStaffIds })
    const messages = buildStatusMessages(store, entries, rosterMap, { excludeDayOffStaffIds, hiddenEntryIds })
    return { status, messages }
  }

  function getOverviewStatus(store) {
    return getOverviewStatusDetails(store).status
  }

  const okCount = STORES.filter((s) => getOverviewStatus(s) === 'ok').length
  const reviewCount = STORES.filter((s) => {
    const st = getOverviewStatus(s)
    return st === 'review' || st === 'days-off' || st === 'sic-missing'
  }).length

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 md:px-8 pt-5 md:pt-8 pb-4 md:pb-6 border-b border-border-subtle">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-content-main">Overview</h1>
            <p className="text-sm text-content-muted mt-1">
              {STORES.length} stores · {okCount} OK · {reviewCount} need attention
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImportExcel} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-primary/20 hover:bg-brand-primary/30 text-[#D8E8E2] text-sm transition-colors disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              {importing ? 'Importing…' : 'Import (.xlsx)'}
            </button>
          </div>
        </div>
        {importResult && (
          <div className={`mt-3 px-4 py-2.5 rounded-lg text-sm ${importResult.success ? 'bg-brand-primary/10 text-[#D8E8E2]' : 'bg-red-500/10 text-red-400'}`}>
            {importResult.message}
          </div>
        )}
      </div>

      <div className="px-8 py-2 flex justify-end border-b border-border-subtle">
        <button
          onClick={async () => {
            setLoading(true)
            const data = await fetchAllStoresSummary(STORES, weekStart, { includeVisitors: true, includeRoster: true })
            setSummary(data)
            setLoading(false)
          }}
          className="text-xs text-content-muted hover:text-content-muted transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-content-muted text-sm">Loading…</div>
      ) : (
        <div className="flex-1 overflow-auto px-4 md:px-8 py-6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider w-56">Store</th>
                  {WEEK_DAYS.map((day, i) => (
                    <th key={day} className="text-center px-2 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider">
                      <div>{day}</div>
                      <div className="text-[10px] text-content-muted font-normal mt-0.5">{formatDate(weekDates[i])}</div>
                    </th>
                  ))}
                  <th className="text-center px-2 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {STORES.map((store) => {
                  const { entries: storeEntries } = getOverviewStoreData(store)
                  const staffCount = Object.keys(storeEntries).length
                  const { status, messages } = getOverviewStatusDetails(store)
                  const badge = CATEGORY_BADGE[store.storeCategory] || CATEGORY_BADGE['regular']
                  return (
                    <tr key={store.id} className="hover:bg-surface-hover transition-colors">
                      <td className="px-4 py-3">
                        <button onClick={() => onNavigate?.(`store-${store.id}`)} className="text-left group">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-content-main font-medium text-sm group-hover:text-brand-primary transition-colors">{store.name}</span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${badge.color}`}>{badge.label}</span>
                          </div>
                          <div className="text-content-muted text-xs mt-0.5">{staffCount} staff scheduled</div>
                        </button>
                      </td>
                      {WEEK_DAYS.map((day, dayIndex) => {
                        const amCount = Object.values(storeEntries).filter((e) => e[day] === 'AM Shift' || e[day] === 'AM 8h').length
                        const pmCount = Object.values(storeEntries).filter((e) => e[day] === 'PM Shift').length
                        return (
                          <td key={dayIndex} className="text-center px-2 py-3">
                            {staffCount === 0 ? (
                              <span className="text-content-muted text-xs">—</span>
                            ) : (
                              <div className="flex flex-col gap-0.5 items-center">
                                <DayBadge count={amCount} label="AM" ok={amCount >= store.minAM} />
                                {store.minPM > 0 && <DayBadge count={pmCount} label="PM" ok={pmCount >= store.minPM} />}
                              </div>
                            )}
                          </td>
                        )
                      })}
                      <td className="text-center px-2 py-3">
                        <StatusBadge status={status} messages={messages} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs text-content-muted border-t border-border-subtle pt-4">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" /> OK — headcount met + correct days off + SIC covered</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400" /> No SIC — headcount OK but a shift has no SIC</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /> Days Off — headcount OK but days-off rules not met</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400" /> Review — headcount short on a shift</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-surface-panel" /> Not Set</span>
          </div>
        </div>
      )}
    </div>
  )
}

function buildStatusMessages(store, entries, rosterMap, options = {}) {
  const staffIds = Object.keys(entries)
  const messages = []
  const hiddenEntryIds = options.hiddenEntryIds || []

  if (staffIds.length === 0) {
    messages.push('No schedule entries have been added for this store yet.')
  }

  // Headcount issues
  const headcountIssues = []
  for (const day of WEEK_DAYS) {
    const am = staffIds.filter((id) => {
      const v = entries[id]?.[day]
      return v === 'AM Shift' || v === 'AM 8h'
    }).length
    const pm = staffIds.filter((id) => entries[id]?.[day] === 'PM Shift').length
    if (am < store.minAM) headcountIssues.push(`${day} AM ${am}/${store.minAM}`)
    if (store.minPM > 0 && pm < store.minPM) headcountIssues.push(`${day} PM ${pm}/${store.minPM}`)
  }
  if (headcountIssues.length > 0) messages.push(`Headcount short: ${headcountIssues.join('; ')}.`)

  // SIC issues — visitors with SIC position count if they appear in supportDays for that day
  if (Object.keys(rosterMap).length > 0) {
    const SIC = ['SM', 'ASM', 'SSV', 'TSSV']
    const hasSIC = (day, shiftType) => Object.keys(rosterMap).some((id) => {
      const member = rosterMap[id]
      if (!SIC_POSITIONS.includes(member?.position)) return false
      const currentShift = entries[id]?.[day]
      if (currentShift === shiftType) return true
      if (shiftType === 'AM Shift' && currentShift === 'AM 8h') return true
      if (member?.supportDays?.includes(day)) return true
      return false
    })
    const sicIssues = []
    for (const day of WEEK_DAYS) {
      const hasAM = staffIds.some((id) => {
        const v = entries[id]?.[day]
        return v === 'AM Shift' || v === 'AM 8h'
      })
      const hasPM = staffIds.some((id) => entries[id]?.[day] === 'PM Shift')
      if (hasAM && !hasSIC(day, 'AM Shift')) sicIssues.push(`${day} AM`)
      if (hasPM && !hasSIC(day, 'PM Shift')) sicIssues.push(`${day} PM`)
    }
    if (sicIssues.length > 0) messages.push(`Missing SIC coverage: ${sicIssues.join('; ')}.`)
  }

  const excludeDayOffStaffIds = new Set(options.excludeDayOffStaffIds || [])
  const dayOffIssues = []
  for (const [id, entry] of Object.entries(entries)) {
    if (excludeDayOffStaffIds.has(id)) continue
    const warnings = validateStaffWeek(entry, store)
    if (warnings.length > 0) {
      const staffName = rosterMap[id]?.name || id
      dayOffIssues.push(`${staffName}: ${warnings.join(', ')}`)
    }
  }

  if (dayOffIssues.length > 0) {
    messages.push(...dayOffIssues.slice(0, 4))
    if (dayOffIssues.length > 4) messages.push(`Plus ${dayOffIssues.length - 4} more day-off issue${dayOffIssues.length - 4 === 1 ? '' : 's'}.`)
  }

  if (messages.length === 0) messages.push('All visible roster and support-in checks are OK.')
  return messages
}

function DayBadge({ count, label, ok }) {
  return (
    <div className={`flex items-center gap-1 text-[10px] font-medium ${ok ? 'text-green-400' : count === 0 ? 'text-content-muted' : 'text-red-400'}`}>
      <span className="text-content-muted">{label}</span>
      <span>{count}</span>
    </div>
  )
}

function StatusBadge({ status, messages = [] }) {
  const config = {
    unset: { label: 'Not set', text: 'text-content-muted', dot: 'bg-surface-panel', fallback: 'No schedule entries have been added for this store yet.' },
    ok: { label: 'OK', text: 'text-green-400', dot: 'bg-green-400', fallback: 'All visible roster and support-in checks are OK.' },
    'sic-missing': { label: 'No SIC', text: 'text-orange-400', dot: 'bg-orange-400', fallback: 'Headcount is OK, but at least one shift has no SIC.' },
    'days-off': { label: 'Days Off', text: 'text-amber-400', dot: 'bg-amber-400', fallback: 'Headcount is OK, but one or more staff day-off rules are not met.' },
    review: { label: 'Review', text: 'text-red-400', dot: 'bg-red-400', fallback: 'At least one shift is short on headcount.' },
  }
  const current = config[status] || config.review
  const details = messages.length > 0 ? messages : [current.fallback]

  return (
    <span className="relative inline-flex justify-center group" title={details.join('\n')}>
      <span className={`inline-flex items-center gap-1 text-xs ${current.text} font-medium`}>
        <span className={`w-1.5 h-1.5 rounded-full ${current.dot}`} /> {current.label}
      </span>
      <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-72 rounded-xl border border-border-subtle bg-[#101a13] px-3 py-2 text-left text-xs leading-relaxed text-content-muted shadow-2xl group-hover:block">
        {details.map((message) => (
          <span key={message} className="block py-0.5">{message}</span>
        ))}
      </span>
    </span>
  )
}
