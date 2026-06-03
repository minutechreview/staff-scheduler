import { useState, useEffect, useRef } from 'react'
import { useLeaveBalances, useLeavePlans } from '../hooks/useLeave'
import { countLeaveDays, validateLeaveDates } from '../utils/leaveUtils'
import { fetchStoreYearSchedule, detectOrphanedLeave, syncOrphanedLeave } from '../utils/leaveSync'

export default function LeavePlanModal({ store, staff, scheduleEntries, onClose }) {
  const { balances, loading: balLoading, ensureBalance, setCarryForward, deductLeave, restoreLeave } = useLeaveBalances(store.id)
  const { plans, loading: plansLoading, holidays, addPlan, deletePlan, updatePlan } = useLeavePlans(store.id)
  const [selectedStaffId, setSelectedStaffId] = useState(null)
  const [editingCarry, setEditingCarry] = useState(null) // staffId
  const [carryDraft, setCarryDraft] = useState('')

  // ── Leave Sync Banner ─────────────────────────────────────────────────────
  const syncRanDone = useRef(false)
  const [orphanedByStaff, setOrphanedByStaff] = useState([]) // [{ staffId, staffName, ranges }]
  const [syncing, setSyncing] = useState(false)
  const [syncDone, setSyncDone] = useState(false)

  // Detect orphaned leave once after data is loaded
  useEffect(() => {
    if (balLoading || plansLoading) return
    if (syncRanDone.current) return
    syncRanDone.current = true

    async function detectAll() {
      const year = new Date().getFullYear()
      let yearSchedule
      try {
        yearSchedule = await fetchStoreYearSchedule(store.id, year)
      } catch {
        return // silently skip on fetch error
      }
      const found = []
      for (const s of staff) {
        const staffPlans = plans.filter((p) => p.staffId === s.id)
        const orphaned = detectOrphanedLeave(s.id, staffPlans, yearSchedule)
        if (orphaned.length > 0) {
          found.push({ staffId: s.id, staffName: s.name, ranges: orphaned })
        }
      }
      setOrphanedByStaff(found)
    }
    detectAll()
  }, [balLoading, plansLoading, store.id, staff, plans])

  async function handleSyncNow() {
    setSyncing(true)
    try {
      for (const { staffId, staffName, ranges } of orphanedByStaff) {
        await ensureBalance(staffId, staffName)
        await syncOrphanedLeave(staffId, staffName, store.id, ranges, holidays, deductLeave)
      }
      setOrphanedByStaff([])
      setSyncDone(true)
    } finally {
      setSyncing(false)
    }
  }

  const loading = balLoading || plansLoading
  const selectedStaff = staff.find((s) => s.id === selectedStaffId)
  const staffPlans = plans.filter((p) => p.staffId === selectedStaffId)

  function getBalance(staffId) {
    return balances[staffId] || {
      annualEntitlement: 30, carryForward: 0, totalBalance: 30, used: 0, remaining: 30,
    }
  }

  function startEditCarry(s) {
    setEditingCarry(s.id)
    setCarryDraft(String(getBalance(s.id).carryForward || 0))
  }

  async function saveCarry(s) {
    const days = Math.max(0, parseInt(carryDraft, 10) || 0)
    await setCarryForward(s.id, s.name, days)
    setEditingCarry(null)
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface-panel border border-border-subtle rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div>
            <h2 className="text-base font-semibold text-content-main">Leave Plan</h2>
            <p className="text-xs text-content-muted mt-0.5">{store.name} · {new Date().getFullYear()}</p>
          </div>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Orphaned leave sync banner */}
        {orphanedByStaff.length > 0 && (
          <div className="flex items-center justify-between gap-4 px-6 py-3 bg-amber-100 border-b border-amber-300 dark:bg-amber-950/30 dark:border-amber-500/20">
            <div className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
              <span className="font-semibold">Leave shift mismatch detected.</span>{' '}
              Found {orphanedByStaff.reduce((sum, s) => sum + s.ranges.length, 0)} untracked leave{' '}
              block{orphanedByStaff.reduce((sum, s) => sum + s.ranges.length, 0) !== 1 ? 's' : ''} across{' '}
              {orphanedByStaff.length} staff member{orphanedByStaff.length !== 1 ? 's' : ''}.
              These are marked Leave in the schedule but have no leave plan or balance deduction.
            </div>
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
        )}
        {syncDone && (
          <div className="px-6 py-2.5 bg-green-100 border-b border-green-300 text-xs text-green-700 dark:bg-green-950/30 dark:border-green-500/20 dark:text-green-400">
            ✓ Leave balances synced successfully.
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          {/* Staff list (left panel) */}
          <div className="w-64 flex-shrink-0 border-r border-border-subtle overflow-y-auto">
            {loading ? (
              <div className="p-4 text-xs text-content-muted">Loading…</div>
            ) : staff.length === 0 ? (
              <div className="p-4 text-xs text-content-muted">No staff in this store.</div>
            ) : (
              <ul className="py-2">
                {staff.map((s) => {
                  const bal = getBalance(s.id)
                  const pct = Math.max(0, Math.min(100, (bal.remaining / bal.totalBalance) * 100))
                  const isSelected = selectedStaffId === s.id
                  return (
                    <li key={s.id}>
                      <button
                        onClick={() => setSelectedStaffId(isSelected ? null : s.id)}
                        className={`w-full text-left px-4 py-3 transition-colors ${isSelected ? 'bg-surface-hover' : 'hover:bg-surface-panel'}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm text-content-main font-medium truncate pr-2">{s.name}</span>
                          <span className={`text-xs font-semibold flex-shrink-0 ${bal.remaining < 5 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                            {bal.remaining}/{bal.totalBalance}d
                          </span>
                        </div>
                        <div className="h-1 bg-surface-root dark:bg-surface-panel rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${bal.remaining < 5 ? 'bg-red-500' : 'bg-green-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-content-muted mt-1">{s.position} · {bal.used}d used</div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Right panel */}
          <div className="flex-1 overflow-y-auto p-6">
            {!selectedStaffId ? (
              <div className="flex flex-col items-center justify-center h-full text-content-muted gap-2">
                <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-sm">Select a staff member to manage their leave</p>
              </div>
            ) : (
              <StaffLeavePanel
                store={store}
                allStaff={staff}
                scheduleEntries={scheduleEntries}
                staff={selectedStaff}
                balance={getBalance(selectedStaffId)}
                plans={staffPlans}
                holidays={holidays}
                editingCarry={editingCarry === selectedStaffId}
                carryDraft={carryDraft}
                onStartEditCarry={() => startEditCarry(selectedStaff)}
                onCarryDraftChange={setCarryDraft}
                onSaveCarry={() => saveCarry(selectedStaff)}
                onCancelCarry={() => setEditingCarry(null)}
                onAddPlan={(data) => addPlan(data, deductLeave)}
                onDeletePlan={(plan) => deletePlan(plan, restoreLeave)}
                onUpdatePlan={(plan, data) => updatePlan(plan, data, deductLeave, restoreLeave)}
                onEnsureBalance={(id, name) => ensureBalance(id, name)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StaffLeavePanel({
  store, allStaff, scheduleEntries,
  staff, balance, plans, holidays,
  editingCarry, carryDraft, onStartEditCarry, onCarryDraftChange, onSaveCarry, onCancelCarry,
  onAddPlan, onDeletePlan, onUpdatePlan, onEnsureBalance,
}) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingPlan, setEditingPlan] = useState(null)
  const [saving, setSaving] = useState(false)

  async function handleAdd(formData) {
    setSaving(true)
    try {
      await onEnsureBalance(staff.id, staff.name)
      await onAddPlan({ staffId: staff.id, staffName: staff.name, ...formData })
      setShowAddForm(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate(plan, formData) {
    setSaving(true)
    try {
      await onUpdatePlan(plan, formData)
      setEditingPlan(null)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(plan) {
    if (!window.confirm(`Delete ${plan.daysCount}-day leave plan for ${staff.name}?\nThis will clear those days from the schedule.`)) return
    await onDeletePlan(plan)
  }

  return (
    <div>
      {/* Staff header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-base font-semibold text-content-main">{staff.name}</h3>
          <p className="text-xs text-content-muted">{staff.position} · {staff.empNo}</p>
        </div>
        <button
          onClick={() => { setShowAddForm(true); setEditingPlan(null) }}
          disabled={showAddForm}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium transition-colors disabled:opacity-40"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Leave
        </button>
      </div>

      {/* Balance summary */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <BalanceCard label="Annual Entitlement" value={`${balance.annualEntitlement}d`} />
        <div className="bg-surface-hover rounded-xl p-3 flex flex-col gap-1">
          <span className="text-[10px] text-content-muted uppercase tracking-wider">Carry Forward</span>
          {editingCarry ? (
            <div className="flex items-center gap-1 mt-0.5">
              <input
                type="number" min="0" max="60" value={carryDraft}
                onChange={(e) => onCarryDraftChange(e.target.value)}
                className="w-14 bg-surface-panel border border-brand-primary/50 rounded px-1.5 py-0.5 text-sm text-content-main outline-none"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') onSaveCarry(); if (e.key === 'Escape') onCancelCarry() }}
              />
              <button onClick={onSaveCarry} className="text-green-600 hover:text-green-500 dark:text-green-400 dark:hover:text-green-300 text-xs">✓</button>
              <button onClick={onCancelCarry} className="text-content-muted hover:text-content-main text-xs">✕</button>
            </div>
          ) : (
            <button onClick={onStartEditCarry} className="text-left mt-0.5 group flex items-center gap-1.5">
              <span className="text-xl font-bold text-amber-600 dark:text-amber-400">{balance.carryForward || 0}d</span>
              <svg className="w-3 h-3 text-content-muted group-hover:text-content-main transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          )}
        </div>
        <BalanceCard label="Remaining" value={`${balance.remaining ?? balance.totalBalance}d`} highlight={balance.remaining < 5 ? 'red' : 'green'} sub={`of ${balance.totalBalance}d total`} />
      </div>

      {/* Add form */}
      {showAddForm && (
        <LeaveForm
          holidays={holidays}
          balance={balance}
          saving={saving}
          onSave={handleAdd}
          onCancel={() => setShowAddForm(false)}
          store={store}
          staff={staff}
          allStaff={allStaff}
          scheduleEntries={scheduleEntries}
        />
      )}

      {/* Plans list */}
      {plans.length === 0 && !showAddForm ? (
        <div className="text-center py-8 text-content-muted text-sm">No leave plans yet. Click "Add Leave" to create one.</div>
      ) : (
        <div className="space-y-2">
          {plans.map((plan) => (
            <div key={plan.id}>
              {editingPlan === plan.id ? (
                <LeaveForm
                  holidays={holidays}
                  balance={balance}
                  saving={saving}
                  initialStart={plan.startDate}
                  initialEnd={plan.endDate}
                  initialNote={plan.note}
                  onSave={(data) => handleUpdate(plan, data)}
                  onCancel={() => setEditingPlan(null)}
                  store={store}
                  staff={staff}
                  allStaff={allStaff}
                  scheduleEntries={scheduleEntries}
                />
              ) : (
                <PlanCard
                  plan={plan}
                  onEdit={() => { setEditingPlan(plan.id); setShowAddForm(false) }}
                  onDelete={() => handleDelete(plan)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BalanceCard({ label, value, highlight, sub }) {
  const valueColor = highlight === 'red' ? 'text-red-600 dark:text-red-400' : highlight === 'green' ? 'text-green-600 dark:text-green-400' : 'text-content-main'
  return (
    <div className="bg-surface-hover rounded-xl p-3 flex flex-col gap-1">
      <span className="text-[10px] text-content-muted uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold mt-0.5 ${valueColor}`}>{value}</span>
      {sub && <span className="text-[10px] text-content-muted">{sub}</span>}
    </div>
  )
}

function PlanCard({ plan, onEdit, onDelete }) {
  const start = new Date(plan.startDate + 'T00:00:00')
  const end = new Date(plan.endDate + 'T00:00:00')
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="flex items-center justify-between bg-surface-hover rounded-xl px-4 py-3 group">
      <div className="flex items-center gap-4">
        <div className="w-1 h-10 bg-red-500/60 rounded-full flex-shrink-0" />
        <div>
          <div className="text-sm text-content-main font-medium">{fmt(start)} → {fmt(end)}</div>
          <div className="text-xs text-content-muted mt-0.5">
            {plan.daysCount} day{plan.daysCount !== 1 ? 's' : ''} leave
            {plan.note && <span className="ml-2 text-content-muted">· {plan.note}</span>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
        <button onClick={onEdit} className="p-1.5 rounded hover:bg-surface-panel text-content-muted hover:text-content-main transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
        <button onClick={onDelete} className="p-1.5 rounded hover:bg-red-100 text-content-muted hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function LeaveForm({ holidays, balance, saving, initialStart = '', initialEnd = '', initialNote = '', onSave, onCancel, store, staff, allStaff, scheduleEntries }) {
  const [startDate, setStartDate] = useState(initialStart)
  const [endDate, setEndDate] = useState(initialEnd)
  const [note, setNote] = useState(initialNote)
  const [error, setError] = useState('')

  const preview = startDate && endDate && endDate >= startDate
    ? countLeaveDays(startDate, endDate, holidays)
    : null
  const remaining = balance.remaining ?? balance.totalBalance
  const overBalance = preview !== null && preview > remaining

  // ── Leave Impact Preview (#5) ────────────────────────────────────────────────
  // Calculate which days would fall below minimum if this leave is added
  const impactPreview = (() => {
    if (!preview || !store || !staff || !scheduleEntries) return null
    
    const WEEK_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
    const impactedShifts = []
    
    // For each day in the leave range
    const start = new Date(startDate + 'T00:00:00')
    const end = new Date(endDate + 'T00:00:00')
    const current = new Date(start)
    
    while (current <= end) {
      const dayName = WEEK_DAYS[current.getDay() === 0 ? 6 : current.getDay() - 1]
      const isFriday = current.getDay() === 5
      const curYear = current.getFullYear()
      const curMonth = String(current.getMonth() + 1).padStart(2, '0')
      const curDay = String(current.getDate()).padStart(2, '0')
      const curDateStr = `${curYear}-${curMonth}-${curDay}`
      const isHoliday = holidays.some(h => h === curDateStr)
      
      // Skip Fridays and holidays (they don't count as leave days anyway)
      if (isFriday || isHoliday) {
        current.setDate(current.getDate() + 1)
        continue
      }
      
      // Check if staff member is currently working that day
      const currentShift = scheduleEntries[staff?.id]?.[dayName]
      const isWorking = currentShift && ['AM Shift', 'AM 8h', 'PM Shift', 'Mid Shift', 'GY Shift'].includes(currentShift)
      
      if (isWorking) {
        // Count how many would be on AM/PM after this leave
        const amCount = allStaff.filter((s) => {
          const v = scheduleEntries[s.id]?.[dayName]
          return v === 'AM Shift' || v === 'AM 8h'
        }).length
        const pmCount = allStaff.filter((s) => scheduleEntries[s.id]?.[dayName] === 'PM Shift').length
        
        // Simulate removing this staff member
        const amAfter = currentShift === 'AM Shift' || currentShift === 'AM 8h' ? amCount - 1 : amCount
        const pmAfter = currentShift === 'PM Shift' ? pmCount - 1 : pmCount
        
        if (amAfter < store.minAM) {
          impactedShifts.push({
            day: dayName,
            date: curDateStr,
            shift: 'AM',
            current: amAfter,
            min: store.minAM,
            short: store.minAM - amAfter
          })
        }
        if (pmAfter < store.minPM) {
          impactedShifts.push({
            day: dayName,
            date: current.toISOString().slice(0, 10),
            shift: 'PM',
            current: pmAfter,
            min: store.minPM,
            short: store.minPM - pmAfter
          })
        }
      }
      
      current.setDate(current.getDate() + 1)
    }
    
    return impactedShifts.length > 0 ? impactedShifts : null
  })()

  function handleSubmit(e) {
    e.preventDefault()
    const err = validateLeaveDates(startDate, endDate)
    if (err) { setError(err); return }
    if (overBalance) { setError(`This plan uses ${preview} days but only ${remaining} remain.`); return }
    setError('')
    onSave({ startDate, endDate, note })
  }

  return (
    <form onSubmit={handleSubmit} className="bg-surface-hover border border-brand-primary/50 rounded-xl p-4 mb-3 space-y-3">
      <div className="text-xs font-medium text-content-muted uppercase tracking-wider mb-1">
        {initialStart ? 'Edit Leave Plan' : 'New Leave Plan'}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">Start Date</label>
          <input
            type="date" required value={startDate}
            onChange={(e) => { setStartDate(e.target.value); setError('') }}
            className="w-full bg-surface-root border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary transition-colors"
          />
        </div>
        <div>
          <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">End Date</label>
          <input
            type="date" required value={endDate} min={startDate}
            onChange={(e) => { setEndDate(e.target.value); setError('') }}
            className="w-full bg-surface-root border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary transition-colors"
          />
        </div>
      </div>

      {preview !== null && (
        <div className={`text-xs rounded-lg px-3 py-2 ${overBalance ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-surface-hover text-green-600 dark:text-green-400'}`}>
          {preview} day{preview !== 1 ? 's' : ''} leave · {remaining - (overBalance ? 0 : preview)} remaining after
          {overBalance && ` (exceeds balance by ${preview - remaining})`}
        </div>
      )}

      {/* Leave Impact Preview (#5) */}
      {impactPreview && (
        <div className="bg-amber-100 border border-amber-300 rounded-xl p-3 space-y-1.5 dark:bg-amber-950/20 dark:border-amber-500/30">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-xs font-semibold">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Coverage Impact
          </div>
          <p className="text-[10px] text-amber-700/70 dark:text-amber-300/60">
            This staff member is currently scheduled. Adding leave would create shortfalls:
          </p>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {impactPreview.map((item, idx) => (
              <div key={idx} className="flex items-center gap-1 px-2 py-1 rounded bg-amber-200 text-amber-800 text-[10px] dark:bg-amber-900/30 dark:text-amber-200">
                <span className="font-medium">{item.day} {item.shift}</span>
                <span className="text-amber-700/60 dark:text-amber-400/60">{item.current}/{item.min}</span>
                <span className="text-amber-700 dark:text-amber-500">-{item.short}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">Note (optional)</label>
        <input
          type="text" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Annual leave, Medical, Personal…"
          className="w-full bg-surface-root border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-content-muted/50 outline-none focus:border-brand-primary transition-colors"
        />
      </div>

      <p className="text-[10px] text-content-muted">Fridays and public holidays are excluded from the day count.</p>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs text-content-muted hover:text-content-main hover:bg-surface-panel transition-colors">Cancel</button>
        <button
          type="submit" disabled={saving || !startDate || !endDate}
          className="px-4 py-1.5 rounded-lg bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium transition-colors disabled:opacity-40"
        >
          {saving ? 'Saving…' : initialStart ? 'Update' : 'Add Leave'}
        </button>
      </div>
    </form>
  )
}
