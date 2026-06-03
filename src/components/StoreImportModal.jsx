import { useState, useRef } from 'react'
import { doc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { parseStoreSheet, buildImportEntries, readFirstSheet } from '../utils/storeImport'
import { WEEK_DAYS } from '../data/stores'

// State machine: idle → parsing → preview → importing → done

export default function StoreImportModal({ store, staff, weekStart, onClose }) {
  const [phase, setPhase] = useState('idle')     // idle | parsing | preview | importing | done
  const [error, setError] = useState('')
  const [sheetNames, setSheetNames] = useState([])
  const [activeSheet, setActiveSheet] = useState('')
  const [workbookCache, setWorkbookCache] = useState(null)
  const [confirmed, setConfirmed] = useState([])      // user-adjusted rows
  const [importCount, setImportCount] = useState(0)
  const fileRef = useRef(null)

  // ── Parse ──────────────────────────────────────────────────────────────────

  async function handleFilePick(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setPhase('parsing')
    try {
      const { workbook, sheetNames: names, sheetName } = await readFirstSheet(file)
      setWorkbookCache(workbook)
      setSheetNames(names)
      setActiveSheet(sheetName)
      const { rowResults: parsed } = await parseStoreSheet(workbook.Sheets[sheetName], staff)
      if (parsed.length === 0) {
        setError('No staff rows found. Make sure day columns (FRI/SAT/SUN…) are in the header row.')
        setPhase('idle')
        return
      }
      setConfirmed(parsed.map((r) => ({ ...r })))
      setPhase('preview')
    } catch (err) {
      setError(`Failed to parse file: ${err.message}`)
      setPhase('idle')
    }
  }

  async function switchSheet(name) {
    setActiveSheet(name)
    try {
      const { rowResults: parsed } = await parseStoreSheet(workbookCache.Sheets[name], staff)
      setConfirmed(parsed.map((r) => ({ ...r })))
      setError(parsed.length === 0 ? 'No staff rows found in this sheet.' : '')
    } catch (err) {
      setError(`Failed to parse sheet: ${err.message}`)
    }
  }

  // ── Preview controls ───────────────────────────────────────────────────────

  function toggleRow(idx) {
    setConfirmed((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, rejected: !r.rejected } : r))
    )
  }

  function overrideMatch(idx, staffId) {
    const member = staff.find((s) => s.id === staffId)
    if (!member) return
    setConfirmed((prev) =>
      prev.map((r, i) =>
        i === idx
          ? { ...r, rejected: false, matched: { staffId, name: member.name, score: 1 } }
          : r
      )
    )
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  async function handleImport() {
    const activeRows = confirmed.filter((r) => r.matched && !r.rejected)
    if (activeRows.length === 0) {
      setError('No valid rows to import. Match or remove unmatched rows first.')
      return
    }
    setPhase('importing')
    setError('')
    try {
      const entries = buildImportEntries(activeRows)
      const docRef = doc(db, 'schedules', store.id, 'weeks', weekStart)
      await setDoc(docRef, { entries, storeId: store.id, weekStartDate: weekStart }, { merge: true })
      setImportCount(Object.keys(entries).length)
      setPhase('done')
    } catch (err) {
      setError(`Import failed: ${err.message}`)
      setPhase('preview')
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const matchedCount = confirmed.filter((r) => r.matched && !r.rejected).length
  const unmatchedCount = confirmed.filter((r) => !r.matched && !r.rejected).length

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface-panel border border-border-subtle rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-content-main">Import Schedule</h2>
            <p className="text-xs text-content-muted mt-0.5">
              {store.name} · Week of {weekStart}
            </p>
          </div>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* IDLE / PARSING */}
          {(phase === 'idle' || phase === 'parsing') && (
            <div className="flex flex-col items-center justify-center py-16 px-8 gap-5">
              <div className="w-16 h-16 rounded-2xl bg-[#1a3a2a] border border-brand-primary/50 flex items-center justify-center">
                <svg className="w-8 h-8 text-[#296044]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-sm text-content-main font-medium mb-1">Upload your schedule file</div>
                <div className="text-xs text-content-muted leading-relaxed max-w-sm">
                  Supports <strong className="text-content-muted">.xlsx</strong>, <strong className="text-content-muted">.xls</strong>, and <strong className="text-content-muted">.csv</strong>.
                  Day columns (FRI, SAT… or full day names) are auto-detected.
                  Shift values like "8-4", "Morning", "OFF" are normalised automatically.
                </div>
              </div>
              {error && <p className="text-xs text-red-400 text-center">{error}</p>}
              <label className="cursor-pointer">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleFilePick}
                  disabled={phase === 'parsing'}
                />
                <span className="px-5 py-2.5 rounded-xl bg-brand-primary hover:bg-brand-hover text-white text-sm font-medium transition-colors inline-block">
                  {phase === 'parsing' ? 'Parsing…' : 'Choose File'}
                </span>
              </label>
            </div>
          )}

          {/* PREVIEW */}
          {phase === 'preview' && (
            <div className="px-6 py-4 space-y-4">
              {/* Sheet selector */}
              {sheetNames.length > 1 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-content-muted uppercase tracking-wider">Sheet:</span>
                  {sheetNames.map((name) => (
                    <button
                      key={name}
                      onClick={() => switchSheet(name)}
                      className={`px-2 py-1 rounded text-xs transition-colors ${activeSheet === name ? 'bg-brand-primary text-white' : 'bg-surface-panel text-content-muted hover:text-content-main'}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}

              {/* Stats bar */}
              <div className="flex items-center gap-4 text-xs">
                <span className="text-green-400">{matchedCount} matched</span>
                {unmatchedCount > 0 && <span className="text-amber-400">{unmatchedCount} unmatched</span>}
                <span className="text-content-muted">{confirmed.filter((r) => r.rejected).length} excluded</span>
              </div>

              {error && <p className="text-xs text-red-400">{error}</p>}

              {/* Preview table */}
              <div className="overflow-x-auto rounded-xl border border-border-subtle">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-subtle bg-surface-panel">
                      <th className="text-left px-3 py-2 text-content-muted font-medium w-6"></th>
                      <th className="text-left px-3 py-2 text-content-muted font-medium">Raw Name</th>
                      <th className="text-left px-3 py-2 text-content-muted font-medium">Matched Staff</th>
                      {WEEK_DAYS.map((d) => (
                        <th key={d} className="px-2 py-2 text-content-muted font-medium text-center">{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {confirmed.map((row, idx) => {
                      const isRejected = row.rejected
                      const isUnmatched = !row.matched && !isRejected
                      return (
                        <tr
                          key={idx}
                          className={`border-b border-border-subtle transition-colors ${isRejected ? 'opacity-30' : isUnmatched ? 'bg-amber-950/10' : 'hover:bg-surface-panel'}`}
                        >
                          {/* Include/exclude toggle */}
                          <td className="px-3 py-2 text-center">
                            <button onClick={() => toggleRow(idx)} title={isRejected ? 'Include row' : 'Exclude row'}>
                              <div className={`w-4 h-4 rounded border transition-colors ${isRejected ? 'border-border-subtle bg-transparent' : 'border-[#296044] bg-brand-primary'}`}>
                                {!isRejected && (
                                  <svg className="w-full h-full text-content-main p-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                            </button>
                          </td>

                          {/* Raw name */}
                          <td className="px-3 py-2 text-content-muted whitespace-nowrap">{row.rawName}</td>

                          {/* Matched staff — dropdown if unmatched */}
                          <td className="px-3 py-2 whitespace-nowrap">
                            {row.matched ? (
                              <div className="flex items-center gap-1">
                                <span className="text-content-main">{row.matched.name}</span>
                                <span className={`text-[10px] ml-1 ${row.matched.score === 1 ? 'text-green-500' : 'text-amber-500'}`}>
                                  {row.matched.score === 1 ? 'exact' : `${Math.round(row.matched.score * 100)}%`}
                                </span>
                              </div>
                            ) : (
                              <select
                                className="bg-amber-950/30 border border-amber-500/30 rounded px-1.5 py-0.5 text-amber-300 text-xs outline-none focus:border-amber-500/60 max-w-[140px]"
                                defaultValue=""
                                onChange={(e) => overrideMatch(idx, e.target.value)}
                              >
                                <option value="" disabled>— pick staff —</option>
                                {staff.map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                            )}
                          </td>

                          {/* Shift cells */}
                          {WEEK_DAYS.map((day) => {
                            const raw = row.shifts[day]
                            const norm = row.normalizedShifts[day]
                            const changed = raw && norm !== raw
                            return (
                              <td key={day} className="px-2 py-2 text-center">
                                {norm ? (
                                  <span
                                    title={changed ? `Raw: "${raw}" → "${norm}"` : norm}
                                    className={`inline-block px-1 py-0.5 rounded text-[10px] font-medium ${shiftColor(norm)}`}
                                  >
                                    {shiftAbbr(norm)}
                                    {changed && <span className="ml-0.5 opacity-60">*</span>}
                                  </span>
                                ) : (
                                  <span className="text-content-muted">—</span>
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

              <p className="text-[10px] text-content-muted pb-1">
                * Shift values were normalised (hover to see original).
                Unmatched rows (amber) can be manually assigned using the dropdown.
                Deselect rows you don't want imported.
              </p>
            </div>
          )}

          {/* IMPORTING */}
          {phase === 'importing' && (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-content-muted text-sm">
              <svg className="w-8 h-8 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              Writing schedule to Firestore…
            </div>
          )}

          {/* DONE */}
          {phase === 'done' && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="w-14 h-14 rounded-full bg-green-900/30 border border-green-500/20 flex items-center justify-center">
                <svg className="w-7 h-7 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-sm text-content-main font-medium">Import complete</div>
                <div className="text-xs text-content-muted mt-1">
                  {importCount} staff member{importCount !== 1 ? 's' : ''} imported into {store.name}'s schedule for week {weekStart}.
                </div>
              </div>
              <button onClick={onClose} className="px-5 py-2 rounded-xl bg-brand-primary hover:bg-brand-hover text-white text-sm font-medium transition-colors">
                Done
              </button>
            </div>
          )}
        </div>

        {/* Footer actions (preview phase only) */}
        {phase === 'preview' && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border-subtle flex-shrink-0">
            <button
              onClick={() => { setPhase('idle'); setConfirmed([]); if (fileRef.current) fileRef.current.value = '' }}
              className="px-4 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-sm transition-colors"
            >
              ← Re-upload
            </button>
            <div className="flex items-center gap-3">
              <span className="text-xs text-content-muted">
                {matchedCount} of {confirmed.length - confirmed.filter((r) => r.rejected).length} rows will be imported
              </span>
              <button
                onClick={handleImport}
                disabled={matchedCount === 0}
                className="px-5 py-2 rounded-xl bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white text-sm font-medium transition-colors"
              >
                Import {matchedCount} Staff
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shiftAbbr(shift) {
  const map = {
    'AM Shift': 'AM',
    'PM Shift': 'PM',
    'Mid Shift': 'Mid',
    'GY Shift': 'GY',
    'Day Off': 'Off',
    'Leave': 'Lv',
    'Support': 'Sup',
    'Activity': 'Act',
    'LOP': 'LOP',
  }
  return map[shift] || shift
}

function shiftColor(shift) {
  const map = {
    'AM Shift': 'bg-[var(--shift-am-bg)] text-[var(--shift-am-text)]',
    'PM Shift': 'bg-[var(--shift-pm-bg)] text-[var(--shift-pm-text)]',
    'Mid Shift': 'bg-[var(--shift-mid-bg)] text-[var(--shift-mid-text)]',
    'GY Shift': 'bg-[var(--shift-gy-bg)] text-[var(--shift-gy-text)]',
    'Day Off': 'bg-[var(--shift-off-bg)] text-[var(--shift-off-text)]',
    'Leave': 'bg-[var(--shift-leave-bg)] text-[var(--shift-leave-text)]',
    'Support': 'bg-[var(--shift-support-bg)] text-[var(--shift-support-text)]',
    'Activity': 'bg-[var(--shift-act-bg)] text-[var(--shift-act-text)]',
    'LOP': 'bg-[var(--shift-lop-bg)] text-[var(--shift-lop-text)]',
  }
  return map[shift] || 'bg-surface-panel text-content-main'
}
