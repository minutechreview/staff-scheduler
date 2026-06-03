import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { WEEK_DAYS, SHIFT_OPTIONS, STORES, SIC_POSITIONS, ACTIVITY_PRESETS, DAYS_OFF_REQUIRED, getWeekDates, formatDate } from '../data/stores'
import { useStoresContext } from '../contexts/StoresContext'
import { useRamadan } from '../contexts/RamadanContext'
import { logDmAuthorization } from '../utils/auditLog'

const SHIFT_COLORS = Object.fromEntries(SHIFT_OPTIONS.map((o) => [o.value, o.color]))
const SHIFT_LABELS = Object.fromEntries(SHIFT_OPTIONS.map((o) => [o.value, o.label || '—']))

export default function ScheduleGrid({
  store,
  staff,
  weekStart,
  onReorder,
  scheduleEntries = {},
  visitors = {},
  dayNotes = {},
  loading = false,
  prevWeekEntries = {},
  updateShift,
  updateRemarks,
  updateDayNote,
  markDmAuth,
  canEdit = true,
}) {
  const { ramadan } = useRamadan()
  const weekDates = getWeekDates(weekStart)
  const [saving, setSaving] = useState(null)
  const [conflictWarning, setConflictWarning] = useState(null)
  // { staffId, memberName } — for row-fill picker
  const [fillRowPicker, setFillRowPicker] = useState(null)
  const [undoState, setUndoState] = useState(null)
  const undoTimerRef = useRef(null)

  // ── Multi-select mode ──────────────────────────────────────────
  const [selectedCells, setSelectedCells] = useState(new Set()) // "staffId:dayIndex" strings
  const [copiedShift, setCopiedShift] = useState(null)
  const [hoveredCell, setHoveredCell] = useState(null)

  const [copyFlash, setCopyFlash] = useState(null) // { message, ts } for visual feedback
  const mousePosRef = useRef({ x: 0, y: 0 })

  // Track mouse position globally for keyboard shortcuts
  useEffect(() => {
    const onMove = (e) => { mousePosRef.current = { x: e.clientX, y: e.clientY } }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [])

  function getCellUnderMouse() {
    const { x, y } = mousePosRef.current
    const el = document.elementFromPoint(x, y)
    const cellBtn = el?.closest('[data-staff-id]')
    if (!cellBtn) return null
    const staffId = cellBtn.dataset.staffId
    const dayIndex = parseInt(cellBtn.dataset.dayIndex, 10)
    if (!staffId || Number.isNaN(dayIndex)) return null
    return { staffId, dayIndex }
  }

  // ── Excel-like Copy/Paste ────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e) {
      if (!canEdit) return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return

      const isCopy = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c'
      const isPaste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v'
      const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey
      const cell = getCellUnderMouse()

      if (isUndo) {
        e.preventDefault()
        if (undoState) {
          if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
          const { staffId, dayIndex, prevValue, prevDetail } = undoState
          setUndoState(null)
          setSaving(`${staffId}-${dayIndex}`)
          updateShift(staffId, WEEK_DAYS[dayIndex], prevValue, prevDetail)
            .finally(() => setSaving(null))
          setCopyFlash({ message: 'Undo: shift restored', ts: Date.now() })
        } else {
          setCopyFlash({ message: 'Nothing to undo', ts: Date.now() })
        }
        return
      }

      if (isCopy) {
        e.preventDefault()
        if (cell) {
          const { staffId, dayIndex } = cell
          const day = WEEK_DAYS[dayIndex]
          const value = scheduleEntries[staffId]?.[day] || ''
          const destStore = scheduleEntries[staffId]?.[`${day}_dest`] || null
          const activityText = scheduleEntries[staffId]?.[`${day}_activity`] || null
          setCopiedShift({ value, destStore, activityText })
          const label = SHIFT_LABELS[value] || value || 'Empty'
          setCopyFlash({ message: `Copied: ${label}`, ts: Date.now() })
          // eslint-disable-next-line no-console
          console.log('[Scheduler] Copied:', { value, destStore, activityText })
        } else {
          setCopyFlash({ message: 'Copy failed — hover a cell first', ts: Date.now() })
          // eslint-disable-next-line no-console
          console.log('[Scheduler] Copy skipped — no cell under mouse')
        }
      }

      if (isPaste) {
        e.preventDefault()
        if (!copiedShift) {
          setCopyFlash({ message: 'Paste failed — copy a cell first', ts: Date.now() })
          // eslint-disable-next-line no-console
          console.log('[Scheduler] Paste skipped — nothing copied yet')
          return
        }
        const detail = copiedShift.destStore || copiedShift.activityText
        const label = SHIFT_LABELS[copiedShift.value] || copiedShift.value || 'Empty'
        // eslint-disable-next-line no-console
        console.log('[Scheduler] Pasting:', copiedShift.value, detail)
        if (selectedCells.size > 0) {
          handleMultiSelectAssign(copiedShift.value, detail)
          setCopyFlash({ message: `Pasted ${label} to ${selectedCells.size} cells`, ts: Date.now() })
        } else if (cell) {
          const { staffId, dayIndex } = cell
          handleShiftChange(staffId, dayIndex, copiedShift.value, detail)
          setCopyFlash({ message: `Pasted ${label}`, ts: Date.now() })
        } else {
          setCopyFlash({ message: 'Paste failed — hover a cell first', ts: Date.now() })
          // eslint-disable-next-line no-console
          console.log('[Scheduler] Paste skipped — no cell under mouse')
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canEdit, copiedShift, scheduleEntries, selectedCells, undoState])


  function toggleCellSelection(staffId, dayIndex) {
    const key = `${staffId}:${dayIndex}`
    setSelectedCells(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleMultiSelectAssign(shiftValue, detail = null) {
    if (!canEdit || selectedCells.size === 0) return
    
    // Support and Activity require extra detail which multi-select doesn't support well in one go.
    // We'll block them or just use standard values. For now, let's block them or handle as base.
    if ((shiftValue === 'Support' || shiftValue === 'Activity') && !detail) {
      alert("Support and Activity shifts are not supported in multi-select mode yet.")
      return
    }

    setSaving('multi-select')
    try {
      // Process all selected cells
      for (const key of selectedCells) {
        const [staffId, dayIdxStr] = key.split(':')
        const dayIndex = parseInt(dayIdxStr)
        await updateShift(staffId, WEEK_DAYS[dayIndex], shiftValue, detail)
      }
      setSelectedCells(new Set())
    } finally {
      setSaving(null)
    }
  }

  // ── Drag-to-select (across rows & days, Excel-like) ─────────────
  const selectDragRef = useRef(null)

  // Exclude anyone already in this store's roster (e.g. after a permanent transfer)
  const rosterIds = new Set(staff.map((s) => s.id))
  const visitorStaff = Object.entries(visitors || {})
    .filter(([id]) => !rosterIds.has(id))
    .map(([id, data]) => ({
      id, ...data, isVisitor: true,
    }))

  // All staff + visitor IDs in display order for rectangular selection
  const allRowIds = [...staff, ...visitorStaff].map((s) => s.id)

  useEffect(() => {
    function onPointerUp() {
      selectDragRef.current = null
    }
    document.addEventListener('pointerup', onPointerUp)
    return () => document.removeEventListener('pointerup', onPointerUp)
  }, [])

  function onCellPointerDown(staffId, dayIndex, e) {
    if (!canEdit) return
    e.preventDefault()
    const ctrlHeld = e.ctrlKey || e.metaKey
    selectDragRef.current = { startStaffId: staffId, startDayIndex: dayIndex, ctrl: ctrlHeld }
    if (!ctrlHeld) {
      setSelectedCells(new Set())
    }
  }

  function onCellPointerEnter(staffId, dayIndex) {
    if (!selectDragRef.current || selectDragRef.current.ctrl) return
    const { startStaffId, startDayIndex } = selectDragRef.current
    const startRow = allRowIds.indexOf(startStaffId)
    const endRow = allRowIds.indexOf(staffId)
    if (startRow === -1 || endRow === -1) return
    const minRow = Math.min(startRow, endRow)
    const maxRow = Math.max(startRow, endRow)
    const minDay = Math.min(startDayIndex, dayIndex)
    const maxDay = Math.max(startDayIndex, dayIndex)

    const next = new Set()
    for (let r = minRow; r <= maxRow; r++) {
      for (let d = minDay; d <= maxDay; d++) {
        next.add(`${allRowIds[r]}:${d}`)
      }
    }
    setSelectedCells(next)
  }

  // ── Drag-to-reorder (staff rows) ─────────────────────────────────
  const [dragOverId, setDragOverId] = useState(null)
  const draggedIdRef = useRef(null)

  function onRowDragStart(staffId, e) {
    if (!canEdit) return
    draggedIdRef.current = staffId
    e.dataTransfer.effectAllowed = 'move'
  }

  function onRowDragOver(staffId, e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (staffId !== draggedIdRef.current) setDragOverId(staffId)
  }

  function onRowDrop(targetId) {
    const fromId = draggedIdRef.current
    if (!fromId || fromId === targetId) { setDragOverId(null); return }
    const ids = staff.map((s) => s.id)
    const fromIdx = ids.indexOf(fromId)
    const toIdx = ids.indexOf(targetId)
    ids.splice(fromIdx, 1)
    ids.splice(toIdx, 0, fromId)
    setDragOverId(null)
    draggedIdRef.current = null
    onReorder?.(ids)
  }

  function onRowDragEnd() {
    draggedIdRef.current = null
    setDragOverId(null)
  }

  // ── Shift changes ────────────────────────────────────────────────
  async function handleShiftChange(staffId, dayIndex, newValue, detail = null) {
    if (!canEdit) return
    const day = WEEK_DAYS[dayIndex]
    const currentShift = scheduleEntries[staffId]?.[day] || ''
    const prevDetail = currentShift === 'Support'
      ? (scheduleEntries[staffId]?.[`${day}_dest`] || null)
      : currentShift === 'Activity'
      ? (scheduleEntries[staffId]?.[`${day}_activity`] || null)
      : null

    // Guard: Rest-period — block AM if staff worked PM or GY the evening before.
    // Covers all consecutive day pairs within the week AND the Thu→Fri cross-week boundary.
    if (newValue === 'AM Shift') {
      let prevShift = null
      if (dayIndex === 0) {
        // FRI is the first day of the week — check prev week's THU
        prevShift = prevWeekEntries[staffId]?.THU
      } else {
        // Any other day — check the previous day in this week
        prevShift = scheduleEntries[staffId]?.[WEEK_DAYS[dayIndex - 1]]
      }
      if (prevShift === 'PM Shift' || prevShift === 'GY Shift') {
        const member = [...staff, ...visitorStaff].find((s) => s.id === staffId)
        setConflictWarning({
          staffId,
          staffName: member?.name || staffId,
          conflictType: 'rest-period',
          prevShift: prevShift === 'PM Shift' ? 'PM' : 'GY',
          prevDay: dayIndex === 0 ? 'THU (prev week)' : WEEK_DAYS[dayIndex - 1],
          day,
          pendingValue: newValue,
          pendingDetail: detail,
          dayIndex,
        })
        return
      }
    }

    const saveKey = `${staffId}-${dayIndex}`
    setSaving(saveKey)
    try {
      await updateShift(staffId, WEEK_DAYS[dayIndex], newValue, detail)
      // Set undo state
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
      setUndoState({ staffId, dayIndex, prevValue: currentShift, prevDetail, label: day })
      undoTimerRef.current = setTimeout(() => setUndoState(null), 5000)
    } finally {
      setSaving(null)
    }
  }

  async function handleUndo() {
    if (!undoState) return
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoState(null)
    const { staffId, dayIndex, prevValue, prevDetail } = undoState
    const saveKey = `${staffId}-${dayIndex}`
    setSaving(saveKey)
    try {
      await updateShift(staffId, WEEK_DAYS[dayIndex], prevValue, prevDetail)
    } finally {
      setSaving(null)
    }
  }

  async function handleDmAuthorized() {
    if (!conflictWarning) return
    const { staffId, pendingValue, pendingDetail, dayIndex, conflictType, prevShift } = conflictWarning
    setConflictWarning(null)
    const saveKey = `${staffId}-${dayIndex}`
    setSaving(saveKey)
    
    const member = [...staff, ...visitorStaff].find((s) => s.id === staffId)
    const day = WEEK_DAYS[dayIndex]
    
    try {
      await updateShift(staffId, day, pendingValue, pendingDetail)
      await markDmAuth?.(staffId, day)
      
      // Log to audit log (#6)
      await logDmAuthorization({
        storeId: store.id,
        storeName: store.name,
        staffId,
        staffName: member?.name || staffId,
        weekStart,
        day,
        fromShift: prevShift || null,
        toShift: pendingValue,
        reason: conflictType || 'manual_override',
      })
    } finally {
      setSaving(null)
    }
  }

  // ── Fill all empty days in a row with a chosen shift (#3) ─────────
  async function handleFillRow(staffId, shiftValue) {
    setFillRowPicker(null)
    if (!shiftValue) return
    const LOCKED = new Set(['Day Off', 'Leave', 'LOP', 'Support', 'Activity'])
    for (const day of WEEK_DAYS) {
      const current = scheduleEntries[staffId]?.[day] || ''
      if (current || LOCKED.has(current)) continue // skip already-set or protected days
      await updateShift(staffId, day, shiftValue)
    }
  }

  // Only show Mid/GY count rows if at least one person has that shift this week
  const hasMidShift = WEEK_DAYS.some((_, i) => countShift(i, 'Mid Shift') > 0)
  const hasGYShift  = WEEK_DAYS.some((_, i) => countShift(i, 'GY Shift') > 0)

  function countShift(dayIndex, shiftType) {
    return [...staff, ...visitorStaff].filter((s) => {
      const v = scheduleEntries[s.id]?.[WEEK_DAYS[dayIndex]]
      // AM 8h counts toward AM Shift headcount
      if (shiftType === 'AM Shift') return v === 'AM Shift' || v === 'AM 8h'
      return v === shiftType
    }).length
  }

  function hasSIC(dayIndex, shiftType) {
    const dayName = WEEK_DAYS[dayIndex]
    return [...staff, ...visitorStaff].some((s) => {
      if (!SIC_POSITIONS.includes(s.position)) return false
      const v = scheduleEntries[s.id]?.[dayName]
      // AM 8h counts as AM Shift for SIC coverage
      const effectiveShift = (v === 'AM 8h') ? 'AM Shift' : v
      if (effectiveShift === shiftType) return true
      // Visitor present via supportDays — counts as SIC even without an explicit shift cell
      if (s.isVisitor && s.supportDays?.includes(dayName)) return true
      return false
    })
  }

  if (loading) return <div className="flex items-center justify-center py-20 text-content-muted text-sm">Loading schedule…</div>

  if (staff.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-content-muted gap-2">
        <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
        <p className="text-sm">No staff added to this store yet.</p>
      </div>
    )
  }

  return (
    <>
      {/* Copy/paste flash toast */}
      <CopyFlashToast flash={copyFlash} />
      <div className="overflow-x-auto relative">
        {/* Mobile scroll hint — fades after scrolling */}
        <MobileScrollHint />
        <table className="w-full min-w-[720px] md:min-w-[900px] text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-2 md:px-4 py-2 md:py-3 text-[10px] md:text-xs font-semibold text-content-muted uppercase tracking-wider w-36 md:w-52 sticky left-0 z-10 bg-surface-panel border-b border-border-subtle">
                Staff
              </th>
              {WEEK_DAYS.map((day, i) => (
                <th key={day} className="text-center px-1 md:px-2 py-2 md:py-3 text-[10px] md:text-xs font-semibold text-content-muted uppercase tracking-wider border-b border-border-subtle">
                  <div>{day}</div>
                  <div className="text-[9px] opacity-70 font-normal mt-0.5">{formatDate(weekDates[i])}</div>
                </th>
              ))}
              <th className="hidden md:table-cell text-left px-3 py-3 text-xs font-semibold text-content-muted uppercase tracking-wider w-36 border-b border-border-subtle">
                Remarks
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {/* AM count */}
            <tr className="bg-surface-hover">
              <td className="px-2 md:px-4 py-1.5 md:py-2 text-[10px] md:text-xs text-content-muted font-medium sticky left-0 z-10 bg-surface-hover">AM count</td>
              {WEEK_DAYS.map((_, i) => {
                const count = countShift(i, 'AM Shift')
                const sicOk = count === 0 || hasSIC(i, 'AM Shift')
                const countColor = count < store.minAM ? 'text-red-400' : count > store.minAM ? 'text-blue-400' : 'text-green-400'
                return (
                  <td key={i} className="text-center px-1 md:px-2 py-1.5 md:py-2">
                    <span className={`text-[10px] md:text-xs font-semibold ${countColor}`}>
                      {count}<span className="text-content-muted font-normal">/{store.minAM}</span>
                    </span>
                    {!sicOk && <div className="text-[8px] md:text-[9px] text-amber-400 font-medium mt-0.5">No SIC</div>}
                  </td>
                )
              })}
              <td className="hidden md:table-cell" />
            </tr>
            {/* PM count */}
            <tr className="bg-surface-hover">
              <td className="px-2 md:px-4 py-1.5 md:py-2 text-[10px] md:text-xs text-content-muted font-medium sticky left-0 z-10 bg-surface-hover">PM count</td>
              {WEEK_DAYS.map((_, i) => {
                const count = countShift(i, 'PM Shift')
                const sicOk = count === 0 || hasSIC(i, 'PM Shift')
                const countColor = count < store.minPM ? 'text-red-400' : count > store.minPM ? 'text-blue-400' : 'text-green-400'
                return (
                  <td key={i} className="text-center px-1 md:px-2 py-1.5 md:py-2">
                    <span className={`text-[10px] md:text-xs font-semibold ${countColor}`}>
                      {count}<span className="text-content-muted font-normal">/{store.minPM}</span>
                    </span>
                    {!sicOk && <div className="text-[8px] md:text-[9px] text-amber-400 font-medium mt-0.5">No SIC</div>}
                  </td>
                )
              })}
              <td className="hidden md:table-cell" />
            </tr>
            {/* Mid count — only shown when Mid shifts are in use */}
            {hasMidShift && (
              <tr className="bg-surface-hover">
                <td className="px-2 md:px-4 py-1.5 md:py-2 text-[10px] md:text-xs text-teal-600 font-medium sticky left-0 z-10 bg-surface-hover">Mid count</td>
                {WEEK_DAYS.map((_, i) => {
                  const count = countShift(i, 'Mid Shift')
                  const sicOk = count === 0 || hasSIC(i, 'Mid Shift')
                  return (
                    <td key={i} className="text-center px-1 md:px-2 py-1.5 md:py-2">
                      {count > 0 ? (
                        <>
                          <span className="text-[10px] md:text-xs font-semibold text-teal-400">{count}</span>
                          {!sicOk && <div className="text-[8px] md:text-[9px] text-amber-400 font-medium mt-0.5">No SIC</div>}
                        </>
                      ) : (
                        <span className="text-[10px] md:text-xs text-content-muted">—</span>
                      )}
                    </td>
                  )
                })}
                <td className="hidden md:table-cell" />
              </tr>
            )}

            {/* GY count — only shown when GY shifts are in use */}
            {hasGYShift && (
              <tr className="bg-surface-hover">
                <td className="px-2 md:px-4 py-1.5 md:py-2 text-[10px] md:text-xs text-slate-500 font-medium sticky left-0 z-10 bg-surface-hover">GY count</td>
                {WEEK_DAYS.map((_, i) => {
                  const count = countShift(i, 'GY Shift')
                  const sicOk = count === 0 || hasSIC(i, 'GY Shift')
                  return (
                    <td key={i} className="text-center px-1 md:px-2 py-1.5 md:py-2">
                      {count > 0 ? (
                        <>
                          <span className="text-[10px] md:text-xs font-semibold text-slate-300">{count}</span>
                          {!sicOk && <div className="text-[8px] md:text-[9px] text-amber-400 font-medium mt-0.5">No SIC</div>}
                        </>
                      ) : (
                        <span className="text-[10px] md:text-xs text-content-muted">—</span>
                      )}
                    </td>
                  )
                })}
                <td className="hidden md:table-cell" />
              </tr>
            )}

            {/* Day notes */}
            <tr className="bg-surface-panel border-t border-border-subtle">
              <td className="px-2 md:px-4 py-1.5 md:py-1.5 text-[10px] md:text-xs text-brand-primary font-semibold sticky left-0 z-10 bg-surface-panel uppercase tracking-wider">Notes</td>
              {WEEK_DAYS.map((day) => (
                <td key={day} className="px-1 md:px-1.5 py-1 md:py-1.5 text-center">
                  <DayNoteCell value={dayNotes[day] || ''} onSave={(note) => updateDayNote(day, note)} />
                </td>
              ))}
              <td className="hidden md:table-cell" />
            </tr>
            <tr><td colSpan={9} className="py-0" /></tr>

            {/* Staff rows (draggable for reorder) */}
            {staff.map((member) => (
            <StaffRow
                key={member.id}
                member={member}
                store={store}
                scheduleEntries={scheduleEntries}
                saving={saving}
                handleShiftChange={handleShiftChange}
                onRemarksChange={(val) => updateRemarks(member.id, val)}
                onCellPointerDown={onCellPointerDown}
                onCellPointerEnter={onCellPointerEnter}
                isDragOver={dragOverId === member.id}
                onDragStart={(e) => onRowDragStart(member.id, e)}
                onDragOver={(e) => onRowDragOver(member.id, e)}
                onDrop={() => onRowDrop(member.id)}
                onDragEnd={onRowDragEnd}
                onFillRow={() => setFillRowPicker({ staffId: member.id, memberName: member.name })}
                ramadan={ramadan}
                selectedCells={selectedCells}
                toggleCellSelection={toggleCellSelection}
              />
            ))}

            {/* Visitors */}
            {visitorStaff.length > 0 && (
              <>
                <tr>
                  <td colSpan={9} className="px-4 pt-4 pb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-support)] opacity-80">
                      Support In — from other stores
                    </span>
                  </td>
                </tr>
                {visitorStaff.map((member) => (
                <StaffRow
                    key={member.id}
                    member={member}
                    store={store}
                    scheduleEntries={scheduleEntries}
                    saving={saving}
                    handleShiftChange={handleShiftChange}
                    onRemarksChange={(val) => updateRemarks(member.id, val)}
                    isVisitor
                    onCellPointerDown={onCellPointerDown}
                    onCellPointerEnter={onCellPointerEnter}
                    ramadan={ramadan}
                    selectedCells={selectedCells}
                    toggleCellSelection={toggleCellSelection}
                  />
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Undo toast */}
      {undoState && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-surface-panel border border-border-subtle rounded-xl shadow-2xl px-4 py-3">
          <span className="text-sm text-content-main">Shift changed</span>
          <button
            onClick={handleUndo}
            className="text-sm font-semibold text-brand-primary hover:text-brand-hover transition-colors"
          >
            Undo
          </button>
          <button onClick={() => { if(undoTimerRef.current) clearTimeout(undoTimerRef.current); setUndoState(null) }} className="text-content-muted hover:text-content-muted ml-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {conflictWarning && createPortal(
        <RestConflictModal
          warning={conflictWarning}
          onAuthorize={handleDmAuthorized}
          onCancel={() => setConflictWarning(null)}
        />,
        document.body
      )}

      {fillRowPicker && createPortal(
        <FillRowPicker
          memberName={fillRowPicker.memberName}
          storeCategory={store.storeCategory}
          onSelect={(shift) => handleFillRow(fillRowPicker.staffId, shift)}
          onClose={() => setFillRowPicker(null)}
        />,
        document.body
      )}

      {selectedCells.size > 0 && createPortal(
        <MultiSelectToolbar
          count={selectedCells.size}
          onSelect={handleMultiSelectAssign}
          onClear={() => setSelectedCells(new Set())}
          storeCategory={store.storeCategory}
          isSaving={saving === 'multi-select'}
        />,
        document.body
      )}
    </>
  )
}

function DayNoteCell({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef(null)

  function startEdit() { setDraft(value); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0) }
  function commit() { setEditing(false); if (draft !== value) onSave(draft.trim()) }
  function handleKey(e) {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') { setEditing(false); setDraft(value) }
  }

  if (editing) return (
    <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKey}
      placeholder="Add note…" className="w-full bg-surface-hover border border-border-subtle rounded px-2 py-1 text-[10px] text-content-main outline-none text-center" />
  )
  return (
    <button
      onClick={startEdit}
      title="Click to add a day note"
      className={`w-full px-1 py-1 rounded border transition-colors text-[10px]
        ${value
          ? 'border-border-subtle bg-surface-hover text-content-main'
          : 'border-dashed border-border-subtle bg-transparent text-content-muted hover:border-brand-primary'
        }`}
    >
      {value || <span className="opacity-40">+ note</span>}
    </button>
  )
}

function RemarksCell({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const inputRef = useRef(null)

  function startEdit() { setDraft(value || ''); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0) }
  function commit() { setEditing(false); if (draft !== (value || '')) onSave(draft.trim()) }
  function handleKey(e) {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') { setEditing(false); setDraft(value || '') }
  }

  if (editing) return (
    <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKey}
      placeholder="Add remark…" className="w-full bg-surface-hover border border-border-subtle rounded px-2 py-1 text-xs text-content-main outline-none" />
  )
  return (
    <button onClick={startEdit} className={`w-full text-left px-2 py-1 rounded text-xs transition-colors hover:bg-surface-hover ${value ? 'text-content-main' : 'text-content-muted hover:text-content-main'}`}>
      {value || '+ add'}
    </button>
  )
}

function ShiftCell({ value, destStore, activityText, dmAuth, colorClass, label, isSaving, isSelected, onSelectToggle, shiftOptions, onChange, onChangeWithDest, onPointerDown, onPointerEnter, onHover, ramadan }) {
  const options = shiftOptions || SHIFT_OPTIONS
  const [open, setOpen] = useState(false)
  const [showStorePicker, setShowStorePicker] = useState(false)
  const [showActivityInput, setShowActivityInput] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef(null)
  const didFillRef = useRef(false)

  // Ramadan reduced-hour labels — only for regular stores (office stores are closed)
  const RAMADAN_LABELS = { 'AM Shift': 'AM 6h', 'PM Shift': 'PM 6h', 'Mid Shift': 'Mid 6h', 'GY Shift': 'GY 6h', 'AM 8h': 'AM 6h' }
  const displayLabel = ramadan && RAMADAN_LABELS[value] ? RAMADAN_LABELS[value] : label

  function handlePointerDown(e) {
    didFillRef.current = false
    onPointerDown(e)
  }

  function handlePointerEnter(e) {
    onHover?.()
    if (e.buttons === 1) { didFillRef.current = true; onPointerEnter() }
  }

  function handleClick(e) {
    if (didFillRef.current) { didFillRef.current = false; return }
    if (isSaving) return

    // Multi-select toggle
    if (e.ctrlKey || e.metaKey) {
      onSelectToggle()
      return
    }

    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const menuWidth = 130
      const menuHeight = 224 // 7 options × ~32px
      let left = rect.left + rect.width / 2 - menuWidth / 2
      left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8))
      const spaceBelow = window.innerHeight - rect.bottom - 8
      const top = spaceBelow >= menuHeight
        ? rect.bottom + 4
        : Math.max(8, rect.top - menuHeight - 4)
      setMenuPos({ top, left, maxHeight: Math.min(menuHeight, window.innerHeight - 24) })
    }
    setOpen((o) => !o)
  }

  function handleSelect(shiftValue) {
    setOpen(false)
    if (shiftValue === 'Support') { setShowStorePicker(true) }
    else if (shiftValue === 'Activity') { setShowActivityInput(true) }
    else { onChange(shiftValue) }
  }

  const foundStore = destStore ? STORES.find((s) => s.id === destStore) : null
  const destLabel = foundStore ? foundStore.name.split(' ').slice(-1)[0] : destStore
  // Truncate activity text to fit the small cell
  const activityLabel = activityText ? activityText.slice(0, 9) + (activityText.length > 9 ? '…' : '') : null

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={() => onHover?.(null)}
        onClick={handleClick}
        className={`w-12 h-7 md:w-16 md:h-8 rounded-lg text-[10px] md:text-xs font-medium transition-all select-none ${
          isSelected
            ? 'ring-2 ring-brand-primary ring-offset-1 ring-offset-surface-root scale-105'
            : colorClass
        } ${isSaving ? 'opacity-50 cursor-wait' : 'hover:opacity-80 cursor-pointer'} flex flex-col items-center justify-center leading-tight`}
        disabled={isSaving}
      >
        {isSaving ? '…' : (
          <>
            <span>{displayLabel}</span>
            {value === 'Support' && destLabel && (
              <span className="text-[9px] opacity-70 truncate max-w-full px-1">{destLabel}</span>
            )}
            {value === 'Activity' && activityLabel && (
              <span className="text-[9px] opacity-70 truncate max-w-full px-1">{activityLabel}</span>
            )}
            {dmAuth && (
              <span className="text-[8px] font-bold text-orange-300 opacity-80 leading-none mt-0.5">DM✓</span>
            )}
          </>
        )}
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed z-50 bg-surface-hover border border-border-subtle rounded-xl shadow-2xl overflow-y-auto"
            style={{ top: menuPos.top, left: menuPos.left, width: 130, maxHeight: menuPos.maxHeight }}>
            {options.map((opt) => (
              <button key={opt.value} onClick={() => handleSelect(opt.value)}
                className={`w-full px-3 py-2 text-left text-xs transition-colors hover:bg-surface-panel ${value === opt.value ? 'text-content-main font-semibold' : 'text-content-muted'}`}>
                {opt.label || '— Clear'}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}

      {showStorePicker && createPortal(
        <StorePickerModal
          onSelect={(storeId) => { setShowStorePicker(false); onChangeWithDest('Support', storeId) }}
          onClose={() => setShowStorePicker(false)}
        />,
        document.body
      )}

      {showActivityInput && createPortal(
        <ActivityInputModal
          current={activityText}
          onSelect={(text) => { setShowActivityInput(false); onChangeWithDest('Activity', text) }}
          onClose={() => setShowActivityInput(false)}
        />,
        document.body
      )}
    </div>
  )
}

function StaffRow({ member, store, scheduleEntries, saving, handleShiftChange, onRemarksChange, isVisitor, onCellPointerDown, onCellPointerEnter, isDragOver, onDragStart, onDragOver, onDrop, onDragEnd, onFillRow, ramadan, selectedCells, toggleCellSelection }) {
  // Highlight row if staff has working shifts but insufficient Day Off (#1)
  const WORKING = new Set(['AM Shift', 'AM 8h', 'PM Shift', 'Mid Shift', 'GY Shift'])
  const entry = scheduleEntries[member.id] || {}
  const hasWorkingDays = WEEK_DAYS.some((d) => WORKING.has(entry[d]))
  const daysOffCount = WEEK_DAYS.filter((d) => entry[d] === 'Day Off').length
  const requiredOff = DAYS_OFF_REQUIRED[store?.storeCategory] || 1
  const missingDayOff = !isVisitor && hasWorkingDays && daysOffCount < requiredOff
  const offShortfall = requiredOff - daysOffCount

  // Per-store shift options (office-12h stores get AM 8h, others don't)
  const storeShiftOptions = SHIFT_OPTIONS.filter((o) => !o.restrictTo || o.restrictTo === store?.storeCategory)

  // Weekly hours counter — per store category
  // office-12h: 12h/shift, AM 8h = 8h, target 4×12=48h
  // office-10h: 9.6h/day, target 5×9.6=48h
  // regular + office-8h: 8h/shift, target 6×8=48h
  // Ramadan: office stores are CLOSED; regular stores reduce to 6h/shift
  function getShiftHours(cat, isRamadan) {
    // Support is always 8h — staff work a standard shift at the destination store
    if (cat === 'office-12h') return { 'AM Shift': 12, 'AM 8h': 8, 'PM Shift': 12, 'Mid Shift': 12, 'GY Shift': 12, 'Support': 8 }
    if (cat === 'office-10h') return { 'AM Shift': 9.6, 'AM 8h': 9.6, 'PM Shift': 9.6, 'Mid Shift': 9.6, 'GY Shift': 9.6, 'Support': 8 }
    // regular + office-8h
    if (isRamadan) return { 'AM Shift': 6, 'AM 8h': 6, 'PM Shift': 6, 'Mid Shift': 6, 'GY Shift': 6, 'Support': 8 }
    return { 'AM Shift': 8, 'AM 8h': 8, 'PM Shift': 8, 'Mid Shift': 8, 'GY Shift': 8, 'Support': 8 }
  }
  const isOfficeStore = store?.storeCategory !== 'regular'
  const SHIFT_HOURS = getShiftHours(store?.storeCategory, ramadan && !isOfficeStore)
  const weeklyHoursRaw = WEEK_DAYS.reduce((sum, d) => sum + (SHIFT_HOURS[entry[d]] || 0), 0)
  const weeklyHours = Number.isInteger(weeklyHoursRaw) ? weeklyHoursRaw : +weeklyHoursRaw.toFixed(1)

  // Detect completely empty row (no shift set for any day)
  const isRowEmpty = !isVisitor && WEEK_DAYS.every((d) => !entry[d])

  return (
    <tr
      className={`transition-colors ${isDragOver ? 'border-t-2 border-brand-primary' : ''} ${isRowEmpty ? 'ring-1 ring-inset ring-brand-primary/20' : ''} hover:bg-surface-hover`}
      draggable={!isVisitor}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <td className={`px-1.5 md:px-2 py-1.5 md:py-2.5 sticky left-0 z-10 ${isVisitor ? 'bg-visitor-bg' : missingDayOff ? 'bg-missing-bg' : isRowEmpty ? 'bg-brand-primary/5 border-l-2 border-brand-primary' : 'bg-surface-panel'}`}>
        <div className="flex items-center gap-1.5 md:gap-2">
          {/* Drag handle — hidden on mobile */}
          {!isVisitor && (
            <div className="hidden md:block cursor-grab active:cursor-grabbing text-content-muted hover:text-content-muted flex-shrink-0 select-none" title="Drag to reorder">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M7 2a1 1 0 000 2 1 1 0 000-2zm6 0a1 1 0 000 2 1 1 0 000-2zM7 8a1 1 0 000 2 1 1 0 000-2zm6 0a1 1 0 000 2 1 1 0 000-2zm-6 6a1 1 0 000 2 1 1 0 000-2zm6 0a1 1 0 000 2 1 1 0 000-2z" />
              </svg>
            </div>
          )}
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="text-content-main font-medium text-xs md:text-sm leading-tight truncate">{member.name}</span>
              {weeklyHours > 0 && (
                <span className="text-[8px] md:text-[9px] px-1 py-0.5 rounded bg-surface-panel text-content-muted font-medium flex-shrink-0">{weeklyHours}h</span>
              )}
              {isVisitor && (
                <span className="text-[8px] md:text-[9px] px-1 md:px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium flex-shrink-0">
                  {member.homeStoreName?.split(' ').slice(-1)[0]}
                </span>
              )}
              {missingDayOff && (
                <span className="text-[8px] text-red-400/70 font-medium flex-shrink-0">
                  {offShortfall > 1 ? `Need ${offShortfall} off` : 'No off'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 md:gap-2">
              <span className="text-content-muted text-[10px] md:text-[11px] mt-0.5">
                {member.position}{member.empNo ? <span className="hidden md:inline"> · {member.empNo}</span> : ''}
              </span>
              {/* Fill row button (#3) — hidden on mobile */}
              {!isVisitor && (
                <button
                  onClick={onFillRow}
                  title="Fill all empty days in this row"
                  className={`hidden md:block mt-0.5 transition-colors flex-shrink-0 ${isRowEmpty ? 'text-brand-primary hover:text-brand-hover animate-pulse' : 'text-content-muted hover:text-[#296044]'}`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </button>
              )}
              {isRowEmpty && (
                <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-brand-primary font-semibold mt-0.5 px-1.5 py-0.5 rounded-md bg-brand-primary/10 border border-brand-primary/20">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                  </svg>
                  Click to fill row
                </span>
              )}
            </div>
          </div>
        </div>
      </td>
      {WEEK_DAYS.map((day, dayIndex) => {
        const currentShift = scheduleEntries[member.id]?.[day] || ''
        const isSaving = saving === `${member.id}-${dayIndex}`
        const destStore = scheduleEntries[member.id]?.[`${day}_dest`] || null
        const activityText = scheduleEntries[member.id]?.[`${day}_activity`] || null
        const dmAuth = scheduleEntries[member.id]?.[`${day}_dm_auth`] || false

        return (
          <td key={day} className="text-center px-0.5 md:px-1.5 py-1 md:py-2" data-staff-id={member.id} data-day-index={dayIndex} {...(dayIndex === 0 ? { 'data-tour': 'shift-cell' } : {})}>
            <ShiftCell
              value={currentShift}
              destStore={destStore}
              activityText={activityText}
              dmAuth={dmAuth}
              colorClass={SHIFT_COLORS[currentShift] || SHIFT_COLORS['']}
              label={SHIFT_LABELS[currentShift] || '—'}
              isSaving={isSaving}
              shiftOptions={storeShiftOptions}
              isSelected={selectedCells?.has(`${member.id}:${dayIndex}`) ?? false}
              onSelectToggle={() => toggleCellSelection?.(member.id, dayIndex)}
              onChange={(val) => handleShiftChange(member.id, dayIndex, val)}
              onChangeWithDest={(val, dest) => handleShiftChange(member.id, dayIndex, val, dest)}
              onPointerDown={(e) => onCellPointerDown(member.id, dayIndex, e)}
              onPointerEnter={() => onCellPointerEnter(member.id, dayIndex)}
              onHover={(val = true) => val ? setHoveredCell({ staffId: member.id, dayIndex }) : setHoveredCell(null)}
              ramadan={ramadan && store?.storeCategory === 'regular'}
            />
          </td>
        )
      })}
      <td className="hidden md:table-cell px-1.5 py-2 min-w-[120px]">
        <RemarksCell value={scheduleEntries[member.id]?.remarks || ''} onSave={onRemarksChange} />
      </td>
    </tr>
  )
}

function StorePickerModal({ onSelect, onClose }) {
  const { stores } = useStoresContext()
  const [customStore, setCustomStore] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] border border-border-subtle rounded-2xl shadow-2xl w-full max-w-xs">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 className="text-sm font-semibold text-content-main">Supporting which store?</h3>
          <button onClick={onClose} className="text-content-muted hover:text-content-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto py-2">
          {stores.map((store) => (
            <button key={store.id} onClick={() => onSelect(store.id)}
              className="w-full px-5 py-2.5 text-left text-sm text-content-muted hover:bg-surface-panel hover:text-content-main transition-colors">
              {store.name}
            </button>
          ))}
          <div className="px-5 py-3 border-t border-border-subtle mt-1">
            <input 
              type="text" 
              value={customStore} 
              onChange={e => setCustomStore(e.target.value)} 
              onKeyDown={e => { if (e.key === 'Enter' && customStore.trim()) onSelect(customStore.trim()) }}
              placeholder="Other store name..."
              className="w-full bg-surface-hover border border-border-subtle rounded px-3 py-1.5 text-sm text-content-main placeholder-content-muted outline-none focus:border-brand-primary transition-colors"
            />
            <button 
              onClick={() => customStore.trim() && onSelect(customStore.trim())}
              disabled={!customStore.trim()}
              className="w-full mt-2 py-1.5 bg-brand-primary/20 hover:bg-brand-primary/40 text-brand-primary rounded text-xs font-semibold disabled:opacity-50 transition-colors"
            >
              Add Other Store
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActivityInputModal({ current, onSelect, onClose }) {
  const [text, setText] = useState(current || '')

  function submit() {
    const trimmed = text.trim()
    if (trimmed) onSelect(trimmed)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] border border-border-subtle rounded-2xl shadow-2xl w-full max-w-xs">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 className="text-sm font-semibold text-content-main">What activity?</h3>
          <button onClick={onClose} className="text-content-muted hover:text-content-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-3">
          {/* Quick-select presets */}
          <div className="flex flex-wrap gap-1.5">
            {ACTIVITY_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => onSelect(preset)}
                className={`px-2.5 py-1 rounded-lg text-xs transition-colors border ${
                  text === preset
                    ? 'bg-violet-900/60 border-violet-500/50 text-violet-200'
                    : 'bg-surface-panel border-border-subtle text-content-muted hover:border-violet-500/40 hover:text-violet-300'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          {/* Free text input */}
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() }}
            placeholder="Or type a custom activity…"
            autoFocus
            className="w-full bg-surface-hover border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-gray-700 outline-none focus:border-violet-500/50 transition-colors"
          />

          <button
            onClick={submit}
            disabled={!text.trim()}
            className="w-full py-2 rounded-lg bg-violet-800/60 hover:bg-violet-700/60 text-violet-200 text-sm font-medium transition-colors disabled:opacity-40"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

function FillRowPicker({ memberName, storeCategory, onSelect, onClose }) {
  const FILL_BASE = new Set(['AM Shift', 'AM 8h', 'PM Shift', 'Mid Shift', 'GY Shift', 'Day Off', 'Leave', 'LOP'])
  const FILL_OPTIONS = SHIFT_OPTIONS.filter((o) =>
    FILL_BASE.has(o.value) && (!o.restrictTo || o.restrictTo === storeCategory)
  )
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] border border-border-subtle rounded-2xl shadow-2xl w-full max-w-xs">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div>
            <h3 className="text-sm font-semibold text-content-main">Fill all empty days</h3>
            <p className="text-xs text-content-muted mt-0.5">{memberName}</p>
          </div>
          <button onClick={onClose} className="text-content-muted hover:text-content-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="py-2">
          <p className="px-5 py-1.5 text-[10px] text-content-muted uppercase tracking-wider font-semibold">Apply to unset days only</p>
          {FILL_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => onSelect(opt.value)}
              className="w-full px-5 py-2.5 text-left text-sm text-content-muted hover:bg-surface-panel hover:text-content-main transition-colors flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${opt.color.split(' ')[0]}`} />
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function RestConflictModal({ warning, onAuthorize, onCancel }) {
  const shiftLabel = warning.prevShift === 'GY' ? 'Graveyard (GY)' : 'PM'
  const prevDayLabel = warning.prevDay || 'the previous day'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-[#162118] border border-orange-500/30 rounded-2xl shadow-2xl w-full max-w-sm">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
          <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-content-main">Rest Period Conflict</h3>
            <p className="text-xs text-orange-400/80 mt-0.5">DM authorization required</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-content-muted leading-relaxed">
            <span className="text-content-main font-semibold">{warning.staffName}</span> worked a{' '}
            <span className="text-orange-300 font-medium">{shiftLabel} shift</span> on{' '}
            <span className="text-content-main font-medium">{prevDayLabel}</span>.
          </p>
          <p className="text-sm text-content-muted leading-relaxed">
            Scheduling <span className="text-blue-300 font-medium">AM on {warning.day}</span> may violate minimum rest period requirements.
          </p>
          <div className="bg-orange-950/40 border border-orange-500/20 rounded-lg px-3 py-2.5 text-xs text-orange-300/80">
            Only proceed if a District Manager has explicitly authorized this exception.
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-5 pb-5">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl bg-surface-panel hover:bg-surface-panel text-content-muted hover:text-content-main text-sm font-medium transition-colors">
            Cancel
          </button>
          <button onClick={onAuthorize} className="flex-1 py-2.5 rounded-xl bg-orange-600/80 hover:bg-orange-500/80 text-content-main text-sm font-semibold transition-colors">
            DM Authorized ✓
          </button>
        </div>
      </div>
    </div>
  )
}

function MultiSelectToolbar({ count, onSelect, onClear, storeCategory, isSaving }) {
  const options = SHIFT_OPTIONS.filter((o) => !o.restrictTo || o.restrictTo === storeCategory)

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 bg-surface-panel border border-brand-primary/40 rounded-2xl shadow-2xl px-4 py-3 min-w-[320px] animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex flex-col pr-4 border-r border-border-subtle">
        <span className="text-xs font-bold text-content-main">{count} selected</span>
        <button onClick={onClear} className="text-[10px] text-content-muted hover:text-red-400 text-left transition-colors">Clear</button>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            disabled={isSaving}
            title={opt.label}
            className={`w-10 h-8 rounded-lg flex items-center justify-center transition-all ${opt.color} hover:opacity-80 active:scale-95 disabled:opacity-50`}
          >
            <span className="text-[10px] font-bold">{opt.label?.slice(0, 2)}</span>
          </button>
        ))}
      </div>

      {isSaving && (
        <div className="absolute inset-0 bg-surface-panel/60 rounded-2xl flex items-center justify-center z-10 backdrop-blur-[1px]">
          <svg className="w-5 h-5 animate-spin text-brand-primary" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
        </div>
      )}
    </div>
  )
}

/* ── Mobile scroll hint — fades out after first scroll ── */
function MobileScrollHint() {
  const [hidden, setHidden] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const onScroll = () => {
      if (el.scrollLeft > 20) setHidden(true)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Auto-hide after 4 seconds even if not scrolled
    const t = setTimeout(() => setHidden(true), 4000)
    return () => {
      el.removeEventListener('scroll', onScroll)
      clearTimeout(t)
    }
  }, [])

  if (hidden) return null
  return (
    <div
      ref={ref}
      className="md:hidden absolute right-0 top-1/2 -translate-y-1/2 z-20 pointer-events-none animate-fade-in-up"
    >
      <div className="flex items-center gap-1.5 px-3 py-2 rounded-l-xl bg-brand-primary/90 text-white text-xs font-medium shadow-lg backdrop-blur-sm">
        <svg className="w-4 h-4 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
        </svg>
        Swipe for more
      </div>
    </div>
  )
}

/* ── Copy/paste flash toast ── */
function CopyFlashToast({ flash }) {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!flash) return
    setMessage(flash.message)
    setVisible(true)
    const t = setTimeout(() => setVisible(false), 1500)
    return () => clearTimeout(t)
  }, [flash?.ts])

  if (!visible) return null
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className="bg-surface-panel border border-brand-primary/40 text-content-main text-xs font-medium px-4 py-2 rounded-xl shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
        {message}
      </div>
    </div>
  )
}
