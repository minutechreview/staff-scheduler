import { useState } from 'react'
import { POSITIONS } from '../data/stores'
import { useStoresContext } from '../contexts/StoresContext'

export default function ManageStaffModal({ storeId, storeName, existingStaff, onAdd, onUpdate, onRemove, onTransfer, onClose }) {
  const [name, setName] = useState('')
  const [empNo, setEmpNo] = useState('')
  const [position, setPosition] = useState('B')
  const [gender, setGender] = useState('')
  const [saving, setSaving] = useState(false)
  const [transferTarget, setTransferTarget] = useState(null)
  const [editTarget, setEditTarget] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    await onAdd(storeId, {
      name: name.trim(),
      empNo: empNo.trim(),
      position,
      gender,
      order: existingStaff.length + 1,
    })
    setName('')
    setEmpNo('')
    setSaving(false)
  }

  if (editTarget) {
    return (
      <EditStaffModal
        staff={editTarget}
        onConfirm={async (updates) => {
          await onUpdate(storeId, editTarget.id, updates)
          setEditTarget(null)
        }}
        onCancel={() => setEditTarget(null)}
      />
    )
  }

  if (transferTarget) {
    return (
      <TransferModal
        staff={transferTarget}
        fromStoreId={storeId}
        fromStoreName={storeName}
        onConfirm={async (toStoreId, effectiveDate) => {
          await onTransfer(storeId, toStoreId, transferTarget.id, effectiveDate)
          setTransferTarget(null)
          onClose()
        }}
        onCancel={() => setTransferTarget(null)}
      />
    )
  }

  const inputClass = "w-full bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-[#D8E8E2]/20 focus:outline-none focus:border-brand-primary"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-content-main">Manage Staff</h2>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 max-h-[80vh] overflow-y-auto">
          {existingStaff.length > 0 && (
            <div className="mb-5">
              <div className="text-xs text-content-muted font-semibold uppercase tracking-wider mb-2">
                Current Staff ({existingStaff.length})
              </div>
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {existingStaff.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-surface-panel">
                    <div>
                      <span className="text-sm text-content-main">{s.name}</span>
                      <span className="text-xs text-content-muted ml-2">{s.position}</span>
                      {s.transferredFrom && (
                        <span className="text-[10px] text-amber-500 ml-2">
                          transferred {s.transferredFrom.effectiveDate}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 ml-2 flex-shrink-0">
                      <button
                        onClick={() => setEditTarget(s)}
                        className="text-content-muted hover:text-sky-400 transition-colors text-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setTransferTarget(s)}
                        className="text-content-muted hover:text-amber-400 transition-colors text-xs"
                      >
                        Transfer
                      </button>
                      <button
                        onClick={() => onRemove(storeId, s.id)}
                        className="text-content-muted hover:text-red-400 transition-colors text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs text-content-muted font-semibold uppercase tracking-wider mb-3">Add New Staff</div>
          <form onSubmit={handleSubmit} className="space-y-3">
            <input type="text" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            <div className="flex gap-2">
              <input type="text" placeholder="Emp No (optional)" value={empNo} onChange={(e) => setEmpNo(e.target.value)} className={`flex-1 ${inputClass}`} />
              <select value={position} onChange={(e) => setPosition(e.target.value)} className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main focus:outline-none focus:border-brand-primary">
                {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputClass}>
              <option value="">Gender (optional)</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="w-full bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white rounded-lg py-2 text-sm font-medium transition-colors"
            >
              {saving ? 'Adding…' : 'Add Staff Member'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

function EditStaffModal({ staff, onConfirm, onCancel }) {
  const [name, setName] = useState(staff.name || "")
  const [empNo, setEmpNo] = useState(staff.empNo || "")
  const [position, setPosition] = useState(staff.position || "B")
  const [gender, setGender] = useState(staff.gender || "")
  const [saving, setSaving] = useState(false)
  const inputClass = "w-full bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-[#D8E8E2]/20 focus:outline-none focus:border-brand-primary"

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await onConfirm({
        name: name.trim(),
        empNo: empNo.trim(),
        position,
        gender,
      })
    } catch (err) {
      console.error("Failed to update staff member", err)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-content-main">Edit Staff</h2>
          <button onClick={onCancel} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-3">
          <input type="text" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          <div className="flex gap-2">
            <input type="text" placeholder="Emp No (optional)" value={empNo} onChange={(e) => setEmpNo(e.target.value)} className={["flex-1", inputClass].join(" ")} />
            <select value={position} onChange={(e) => setPosition(e.target.value)} className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main focus:outline-none focus:border-brand-primary">
              {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputClass}>
            <option value="">Gender (optional)</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
          </select>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onCancel} className="flex-1 px-4 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-sm transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="flex-1 px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function TransferModal({ staff, fromStoreId, fromStoreName, onConfirm, onCancel }) {
  const { stores } = useStoresContext()
  const otherStores = stores.filter((s) => s.id !== fromStoreId)
  const [toStoreId, setToStoreId] = useState(otherStores[0]?.id || '')
  const [effectiveDate, setEffectiveDate] = useState(() => {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  })
  const [transferring, setTransferring] = useState(false)

  async function handleConfirm() {
    if (!toStoreId || !effectiveDate) return
    setTransferring(true)
    await onConfirm(toStoreId, effectiveDate)
    setTransferring(false)
  }

  const destStoreName = stores.find((s) => s.id === toStoreId)?.name || ''
  const inputClass = "w-full bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main focus:outline-none focus:border-brand-primary"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-content-main">Transfer Partner</h2>
          <button onClick={onCancel} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="px-4 py-3 rounded-xl bg-surface-panel">
            <div className="text-content-main font-medium text-sm">{staff.name}</div>
            <div className="text-content-muted text-xs mt-0.5">{staff.position} · {fromStoreName}</div>
          </div>

          <div>
            <label className="text-xs text-content-muted font-semibold uppercase tracking-wider block mb-1.5">Transfer to</label>
            <select value={toStoreId} onChange={(e) => setToStoreId(e.target.value)} className={inputClass}>
              {otherStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-content-muted font-semibold uppercase tracking-wider block mb-1.5">Effective date</label>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputClass} />
          </div>

          {toStoreId && effectiveDate && (
            <div className="text-xs text-content-muted px-1">
              <span className="text-content-main">{staff.name}</span> moves to{' '}
              <span className="text-[#D8E8E2]">{destStoreName}</span> from{' '}
              <span className="text-content-main">{effectiveDate}</span>. History at {fromStoreName} is preserved.
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={onCancel} className="flex-1 px-4 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-sm transition-colors">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!toStoreId || !effectiveDate || transferring}
              className="flex-1 px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              {transferring ? 'Transferring…' : 'Confirm Transfer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
