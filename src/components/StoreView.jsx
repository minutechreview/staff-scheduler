import { useState, useRef, useEffect } from 'react'
import { useRoster } from '../hooks/useRoster'
import ScheduleGrid from './ScheduleGrid'
import WeekPicker from './WeekPicker'
import { getWeekStartFriday, POSITIONS, WEEK_DAYS } from '../data/stores'
import { exportStorePDF, getStorePDFBlob } from '../utils/pdfExport'
import { exportStoreExcel } from '../utils/excelExport'
import { useSchedule, generateWeekSchedule } from '../hooks/useSchedule'
import { doc, deleteDoc } from 'firebase/firestore'
import { db } from '../firebase'
import LeavePlanModal from './LeavePlanModal'
import StoreImportModal from './StoreImportModal'
import TemplateModal from './TemplateModal'
import { isWeekBlank } from '../utils/isWeekBlank'
import { useRamadan } from '../contexts/RamadanContext'
import { usePresence } from '../hooks/usePresence'
import { useAor } from '../contexts/AorContext'

// Sub-components
import IconBtn from './IconBtn'
import StoreScheduleBoundary from './StoreScheduleBoundary'
import ManageStaffModal from './ManageStaffModal'
import FillWeekConfirmModal from './FillWeekConfirmModal'
import CopyWeekModal from './CopyWeekModal'
// HeatmapView archived — file preserved at components/HeatmapView.jsx
import SicRotationTracker from './SicRotationTracker'

export default function StoreView({ store }) {
  const { ramadan, toggleRamadan } = useRamadan()
  const { role, storeId: myStoreId, isDM, isAuthenticated } = useAor()
  
  // Case-insensitive comparison for store IDs to be robust
  const canEdit = isDM || (myStoreId?.toLowerCase() === store.id?.toLowerCase())
  const scheduleGridRef = useRef(null)
  const exportMenuRef = useRef(null)
  const [sharingImage, setSharingImage] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [weekStart, setWeekStart] = useState(getWeekStartFriday)
  const [clearing, setClearing] = useState(false)
  const [showManageStaff, setShowManageStaff] = useState(false)
  const [showLeavePlan, setShowLeavePlan] = useState(false)
  const [showCopyWeek, setShowCopyWeek] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showFillConfirm, setShowFillConfirm] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [filling, setFilling] = useState(false)

  const [showMoreActions, setShowMoreActions] = useState(false)
  const moreActionsRef = useRef(null)

  // Simplify mode: per-store minimal UI toggle
  const simplifyKey = `simplify_${store.id}`
  const [simplify, setSimplify] = useState(() => {
    try { return localStorage.getItem(simplifyKey) === '1' } catch { return false }
  })
  function toggleSimplify() {
    const next = !simplify
    setSimplify(next)
    localStorage.setItem(simplifyKey, next ? '1' : '0')
  }
  
  const { staff: rawStaff, loading, addStaffMember, updateStaffMember, removeStaffMember, transferStaffMember, reorderStaff } = useRoster(store.id)

  // Filter staff to only those present during the current week
  const staff = rawStaff.filter((s) => {
    if (s.transferredOut?.effectiveDate) {
      const transferWeek = getWeekStartFriday(s.transferredOut.effectiveDate)
      return weekStart < transferWeek
    }
    if (s.transferredFrom?.effectiveDate) {
      const transferWeek = getWeekStartFriday(s.transferredFrom.effectiveDate)
      return weekStart >= transferWeek
    }
    return true
  })
  const {
    scheduleEntries,
    visitors,
    dayNotes,
    loading: scheduleLoading,
    prevWeekEntries,
    updateShift,
    updateRemarks,
    updateDayNote,
    markDmAuth,
  } = useSchedule(store.id, weekStart)

  // Real-time co-editing presence
  const { viewers } = usePresence(store.id, weekStart)

  // Close export dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setShowExportMenu(false)
      }
      if (moreActionsRef.current && !moreActionsRef.current.contains(e.target)) {
        setShowMoreActions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Apply template to week
  async function handleApplyTemplate(template) {
    const shifts = template.shifts || {}
    let applied = 0

    for (const member of staff) {
      const position = member.position || 'B'
      const positionShifts = shifts[position]
      if (!positionShifts) continue

      for (const [day, shift] of Object.entries(positionShifts)) {
        const existing = scheduleEntries[member.id]?.[day]
        const PROTECTED = ['Leave', 'Support', 'Activity']
        if (existing && PROTECTED.includes(existing)) continue

        await updateShift(member.id, day, shift)
        applied++
      }
    }

    if (applied > 0) {
      alert(`Applied "${template.name}": ${applied} shifts`)
    } else {
      alert(`Template "${template.name}" applied — no new shifts written (all protected)`)
    }
  }

  // Exclude anyone already in this store's roster
  const rosterIds = new Set(staff.map((s) => s.id))
  const visitorStaffList = Object.entries(visitors || {})
    .filter(([id]) => !rosterIds.has(id))
    .map(([id, data]) => ({ id, ...data, isVisitor: true }))

  async function handleExportPDF() {
    await exportStorePDF(store, staff, visitorStaffList, scheduleEntries, weekStart, dayNotes)
  }

  async function handleExportExcel() {
    await exportStoreExcel(store, staff, scheduleEntries, weekStart)
  }

  async function handleSharePDF() {
    if (sharingImage) return
    setSharingImage(true)
    try {
      const blob = await getStorePDFBlob(store, staff, visitorStaffList, scheduleEntries, weekStart, dayNotes)
      const fileName = `${store.name}_${weekStart}.pdf`
      const pdfFile = new File([blob], fileName, { type: 'application/pdf' })

      if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
        await navigator.share({ files: [pdfFile], title: `${store.name} — Week of ${weekStart}` })
      } else {
        // Desktop fallback: download the PDF
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('[Share PDF] Error:', err)
      alert('Could not generate PDF. Please try again.')
    } finally {
      setSharingImage(false)
    }
  }

  async function handleClearSchedule() {
    if (!window.confirm(`Clear ${store.name}'s schedule for this week?`)) return
    setClearing(true)
    try {
      await deleteDoc(doc(db, 'schedules', store.id, 'weeks', weekStart))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 md:px-8 pt-5 md:pt-8 pb-4 md:pb-6 border-b border-border-subtle bg-surface-root">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg md:text-xl font-semibold text-content-main">{store.name}</h1>
              {viewers.length > 0 && (
                <div className="flex items-center gap-1.5 ml-1" title={`${viewers.length} viewing ${store.name}`}>
                  <span className="text-sm">👀</span>
                  <span className="text-[10px] text-content-muted">{viewers.length} viewing</span>
                </div>
              )}
            </div>
            <p className="text-xs md:text-sm text-content-muted mt-1">
              {store.type} · Min {store.minAM} AM / {store.minPM} PM · {staff.length} staff
            </p>
            {!canEdit && isAuthenticated && (
              <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[10px] font-medium text-amber-500 uppercase tracking-wider">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0 0v3m0-3h3m-3 0H9m12-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                View Only · {isDM ? 'Admin Override Disabled' : (myStoreId ? `Assigned to ${myStoreId}` : 'No Store Assigned')}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap" data-tour="actions">
            <WeekPicker weekStart={weekStart} onChange={setWeekStart} />

            {/* Simplify toggle */}
            <IconBtn
              onClick={toggleSimplify}
              tooltip={simplify ? 'Show all tools' : 'Simplify view'}
              className={simplify
                ? 'bg-brand-primary/20 text-brand-primary border border-brand-primary/30'
                : 'bg-surface-panel hover:bg-surface-hover text-content-muted hover:text-content-main border border-border-subtle'}
              icon={
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  {simplify ? (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                  )}
                </svg>
              }
            />

            {/* WhatsApp share — always visible */}
            <IconBtn
              onClick={handleSharePDF}
              disabled={sharingImage}
              tooltip={sharingImage ? 'Generating…' : 'Share Schedule'}
              icon={
                sharingImage ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                )
              }
            />

            {!simplify && (
              <>
                <div className="relative" ref={exportMenuRef}>
                  <button
                    onClick={() => setShowExportMenu((v) => !v)}
                    title="Export"
                    className="flex items-center gap-1 px-2.5 h-8 rounded-lg bg-surface-panel hover:bg-surface-hover text-content-muted hover:text-content-main transition-colors text-xs font-medium border border-border-subtle"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showExportMenu && (
                    <div className="absolute right-0 top-full mt-1 z-50 min-w-[130px] rounded-xl bg-surface-panel border border-border-subtle shadow-xl overflow-hidden">
                      <button
                        onClick={() => { setShowExportMenu(false); handleExportPDF() }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm text-content-muted hover:bg-surface-hover hover:text-content-main transition-colors text-left"
                      >
                        <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        Export PDF
                      </button>
                      <button
                        onClick={() => { setShowExportMenu(false); handleExportExcel() }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm text-content-muted hover:bg-surface-hover hover:text-content-main transition-colors text-left"
                      >
                        <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6M3 21h18M3 10l9-7 9 7M4 10v11" />
                        </svg>
                        Export Excel
                      </button>
                    </div>
                  )}
                </div>

                {store.storeCategory === 'regular' && (
                  <IconBtn
                    onClick={toggleRamadan}
                    disabled={!canEdit}
                    tooltip={!canEdit ? 'View Only' : (ramadan ? 'Ramadan Mode ON' : 'Ramadan Mode')}
                    className={ramadan
                      ? 'bg-amber-900/30 hover:bg-amber-900/50 border border-amber-500/30 text-amber-400 hover:text-amber-300'
                      : 'bg-surface-panel hover:bg-surface-hover text-content-muted hover:text-content-main'}
                    icon={
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                      </svg>
                    }
                  />
                )}

                <SicRotationTracker staff={staff} visitors={visitorStaffList} scheduleEntries={scheduleEntries} />

                <IconBtn
                  onClick={() => setShowLeavePlan(true)}
                  tooltip="Leave Plan"
                  className="bg-surface-panel hover:bg-surface-hover border border-border-subtle text-content-muted hover:text-content-main"
                  icon={
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  }
                />

                {canEdit && (
                  <IconBtn
                    onClick={() => setShowManageStaff(true)}
                    tooltip="Manage Staff"
                    className="btn-gradient rounded-lg"
                    icon={
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                      </svg>
                    }
                  />
                )}

                {/* More Actions Dropdown */}
                <div className="relative" ref={moreActionsRef}>
                  <button
                    onClick={() => setShowMoreActions((v) => !v)}
                    title="More Actions"
                    className="flex items-center gap-1 px-2.5 h-8 rounded-lg bg-surface-panel hover:bg-surface-hover text-content-muted hover:text-content-main transition-colors text-xs font-medium border border-border-subtle"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
                    </svg>
                  </button>
                  {showMoreActions && (
                    <div className="absolute right-0 top-full mt-1 z-50 min-w-[170px] rounded-xl bg-surface-panel border border-border-subtle shadow-xl overflow-hidden py-1">
                      {canEdit && (
                        <>
                          <button onClick={() => { setShowMoreActions(false); setShowImport(true); }} className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-content-muted hover:bg-surface-hover hover:text-content-main transition-colors text-left">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12m4.5-4.5V21" /></svg>
                            Import Schedule
                          </button>
                          <button onClick={() => { setShowMoreActions(false); setShowTemplates(true); }} className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-content-muted hover:bg-surface-hover hover:text-content-main transition-colors text-left">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                            Templates
                          </button>
                          <button onClick={() => { setShowMoreActions(false); setShowCopyWeek(true); }} className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-content-muted hover:bg-surface-hover hover:text-content-main transition-colors text-left">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                            Copy Last Week
                          </button>
                          {!scheduleLoading && isWeekBlank(staff, scheduleEntries) && staff.length > 0 && (
                            <button onClick={() => { setShowMoreActions(false); setShowFillConfirm(true); }} className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-brand-primary hover:bg-surface-hover transition-colors text-left font-medium">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              {filling ? 'Filling…' : 'Fill Week (Auto)'}
                            </button>
                          )}
                          <div className="border-t border-border-subtle my-1"></div>
                          <button onClick={() => { setShowMoreActions(false); handleClearSchedule(); }} disabled={clearing} className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-red-500 hover:bg-surface-hover transition-colors text-left">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                            {clearing ? 'Clearing…' : 'Clear Week'}
                          </button>
                        </>
                      )}
                      {!canEdit && (
                        <div className="px-4 py-2 text-xs text-content-muted italic">
                          View Only Mode
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showImport && (
        <StoreImportModal
          store={store}
          staff={staff}
          weekStart={weekStart}
          onClose={() => setShowImport(false)}
        />
      )}

      {showLeavePlan && (
        <LeavePlanModal store={store} staff={staff} scheduleEntries={scheduleEntries} onClose={() => setShowLeavePlan(false)} />
      )}

      {showTemplates && (
        <TemplateModal
          store={store}
          staff={staff}
          scheduleEntries={scheduleEntries}
          weekStart={weekStart}
          onClose={() => setShowTemplates(false)}
          onApply={handleApplyTemplate}
        />
      )}

      {showFillConfirm && (
        <FillWeekConfirmModal
          store={store}
          staffCount={staff.length}
          filling={filling}
          onConfirm={async () => {
            setFilling(true)
            setShowFillConfirm(false)
            try {
              await generateWeekSchedule(store.id, weekStart, staff, scheduleEntries, store, prevWeekEntries)
            } finally {
              setFilling(false)
            }
          }}
          onCancel={() => setShowFillConfirm(false)}
        />
      )}

      {showCopyWeek && (
        <CopyWeekModal
          store={store}
          weekStart={weekStart}
          prevWeekEntries={prevWeekEntries}
          onClose={() => setShowCopyWeek(false)}
        />
      )}

      {ramadan && store.storeCategory !== 'regular' && (
        <div className="mx-4 md:mx-8 mt-4 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-amber-900/20 border border-amber-500/20 text-amber-300 text-sm">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
          </svg>
          <span>Ramadan mode is active — <strong>this office is closed during Ramadan.</strong> Hours tracking is paused for this store.</span>
        </div>
      )}

      {/* Empty-week suggestion */}
      {!scheduleLoading && !loading && staff.length > 0 && canEdit && isWeekBlank(staff, scheduleEntries) && (
        <div className="mx-4 md:mx-8 mt-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-brand-primary/10 border border-brand-primary/20 text-content-main text-sm">
          <div className="flex items-center gap-2.5">
            <svg className="w-5 h-5 text-brand-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            <span>This week is empty. <span className="hidden sm:inline">Auto-fill shifts based on staffing rules?</span></span>
          </div>
          <button
            onClick={() => setShowFillConfirm(true)}
            disabled={filling}
            className="btn-gradient flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
          >
            {filling ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Filling…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                </svg>
                Auto Fill Week
              </>
            )}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto" ref={scheduleGridRef}>
        {loading || scheduleLoading ? (
          <div className="flex items-center justify-center py-20 text-content-muted text-sm">Loading…</div>
        ) : (
          <StoreScheduleBoundary storeId={store.id}>
            <ScheduleGrid
              store={store}
              staff={staff}
              weekStart={weekStart}
              onReorder={(orderedIds) => reorderStaff(store.id, orderedIds)}
              scheduleEntries={scheduleEntries}
              visitors={visitors}
              dayNotes={dayNotes}
              loading={scheduleLoading}
              canEdit={canEdit}
              prevWeekEntries={prevWeekEntries}
              updateShift={updateShift}
              updateRemarks={updateRemarks}
              updateDayNote={updateDayNote}
              markDmAuth={isDM ? markDmAuth : null}
            />
          </StoreScheduleBoundary>
        )}
      </div>

      {showManageStaff && (
        <ManageStaffModal
          storeId={store.id}
          storeName={store.name}
          existingStaff={rawStaff.filter((s) => !s.transferredOut)}
          onAdd={addStaffMember}
          onUpdate={updateStaffMember}
          onRemove={removeStaffMember}
          onTransfer={transferStaffMember}
          onClose={() => setShowManageStaff(false)}
        />
      )}
    </div>
  )
}
