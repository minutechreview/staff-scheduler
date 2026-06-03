import { useState, useEffect } from 'react'
import { collection, getDocs, doc, setDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { POSITIONS, getWeekStartFriday, getPrevWeekStart } from '../data/stores'
import { useStoresContext } from '../contexts/StoresContext'
import { useAor } from '../contexts/AorContext'

const TABS = ['Stores', 'Staff Directory', 'Leave History']

export default function SettingsPage() {
  const [tab, setTab] = useState('Stores')

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 md:px-8 pt-5 md:pt-8 pb-4 border-b border-border-subtle">
        <h1 className="text-xl font-semibold text-content-main">Settings</h1>
        <p className="text-sm text-content-muted mt-1">Manage stores, staff directory, and configuration</p>

        <div className="flex gap-1 mt-4">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-brand-primary text-white' : 'text-content-muted hover:text-content-main hover:bg-surface-hover'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 md:px-8 py-6">
        {tab === 'Stores' && <StoresTab />}
        {tab === 'Staff Directory' && <StaffDirectoryTab />}
        {tab === 'Leave History' && <LeaveHistoryTab />}
      </div>
    </div>
  )
}

// ── Stores Tab ──────────────────────────────────────────────────────────────

function StoresTab() {
  const { stores: STORES } = useStoresContext()
  const [overrides, setOverrides] = useState({})
  const [editing, setEditing] = useState(null) // storeId being edited
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({})

  useEffect(() => {
    getDoc(doc(db, 'config', 'storeSettings')).then((snap) => {
      if (snap.exists()) setOverrides(snap.data())
    })
  }, [])

  function startEdit(store) {
    const current = overrides[store.id] || {}
    setDraft({
      minAM: current.minAM ?? store.minAM,
      minPM: current.minPM ?? store.minPM,
      totalRoster: current.totalRoster ?? store.totalRoster,
    })
    setEditing(store.id)
  }

  async function saveEdit(storeId) {
    setSaving(true)
    const updated = { ...overrides, [storeId]: draft }
    await setDoc(doc(db, 'config', 'storeSettings'), updated)
    setOverrides(updated)
    setEditing(null)
    setSaving(false)
  }

  const CATEGORY_COLOR = {
    'regular':    'text-content-muted bg-surface-panel',
    'office-12h': 'text-amber-400/70 bg-amber-900/20',
    'office-8h':  'text-sky-400/70 bg-sky-900/20',
    'office-10h': 'text-purple-400/70 bg-purple-900/20',
  }

  return (
    <div>
      <p className="text-xs text-content-muted mb-4">
        Edit minimum headcount per shift. Changes apply immediately to new schedule validation.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Store</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Category</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Min AM</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Min PM</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Roster Size</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {STORES.map((store) => {
              const ov = overrides[store.id] || {}
              const isEditing = editing === store.id
              const hasOverride = ov.minAM !== undefined || ov.minPM !== undefined

              return (
                <tr key={store.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-3">
                    <div className="text-content-main font-medium text-sm">{store.name}</div>
                    {hasOverride && <div className="text-[10px] text-brand-primary mt-0.5">Custom settings</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLOR[store.storeCategory]}`}>
                      {store.type}
                    </span>
                  </td>
                  {isEditing ? (
                    <>
                      <td className="px-4 py-2 text-center">
                        <input type="number" min={1} max={10} value={draft.minAM}
                          onChange={(e) => setDraft({ ...draft, minAM: Number(e.target.value) })}
                          className="w-14 text-center bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none" />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <input type="number" min={1} max={10} value={draft.minPM}
                          onChange={(e) => setDraft({ ...draft, minPM: Number(e.target.value) })}
                          className="w-14 text-center bg-surface-panel border border-brand-primary/50] rounded px-2 py-1 text-sm text-content-main outline-none" />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <input type="number" min={1} max={30} value={draft.totalRoster}
                          onChange={(e) => setDraft({ ...draft, totalRoster: Number(e.target.value) })}
                          className="w-14 text-center bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none" />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-2">
                          <button onClick={() => saveEdit(store.id)} disabled={saving}
                            className="px-3 py-1 rounded-lg bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium disabled:opacity-50">
                            {saving ? '…' : 'Save'}
                          </button>
                          <button onClick={() => setEditing(null)} className="px-3 py-1 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-xs">
                            Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-center">
                        <span className="text-content-main font-semibold">{ov.minAM ?? store.minAM}</span>
                        {ov.minAM !== undefined && ov.minAM !== store.minAM && (
                          <span className="text-content-muted text-xs ml-1">(was {store.minAM})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-content-main font-semibold">{ov.minPM ?? store.minPM}</span>
                        {ov.minPM !== undefined && ov.minPM !== store.minPM && (
                          <span className="text-content-muted text-xs ml-1">(was {store.minPM})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-content-muted">
                        {ov.totalRoster ?? store.totalRoster}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => startEdit(store)}
                          className="text-xs text-content-muted hover:text-[#D8E8E2] transition-colors px-2 py-1 rounded hover:bg-surface-panel">
                          Edit
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Staff Directory Tab ─────────────────────────────────────────────────────

function StaffDirectoryTab() {
  const { stores: STORES } = useStoresContext()
  const { isDM } = useAor()
  const [allStaff, setAllStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterPos, setFilterPos] = useState('')
  const [filterGender, setFilterGender] = useState('')
  const [filterStore, setFilterStore] = useState('')
  const [filterIncharge, setFilterIncharge] = useState('')
  const [selectedStaff, setSelectedStaff] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      const entries = []
      await Promise.all(
        STORES.map(async (store) => {
          const snap = await getDocs(collection(db, 'stores', store.id, 'roster'))
          snap.docs.forEach((d) => {
            const data = d.data()
            if (data.transferredOut) return
            entries.push({ ...data, id: d.id, storeId: store.id, storeName: store.name })
          })
        })
      )
      entries.sort((a, b) => a.name?.localeCompare(b.name))
      setAllStaff(entries)
      setLoading(false)
    }
    load()
  }, [STORES])

  const genders = Array.from(new Set(allStaff.map((s) => s.gender).filter(Boolean))).sort()

  const filtered = allStaff.filter((s) => {
    const matchSearch = !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.empNo?.includes(search)
    const matchPos = !filterPos || s.position === filterPos
    const matchGender = !filterGender || s.gender === filterGender
    const matchStore = !filterStore || s.storeId === filterStore
    const matchIncharge = !filterIncharge || (filterIncharge === 'yes' ? s.isStoreIncharge === true : s.isStoreIncharge !== true)
    return matchSearch && matchPos && matchGender && matchStore && matchIncharge
  })

  function startEdit(staff) {
    setEditingId(`${staff.storeId}-${staff.id}`)
    setEditDraft({
      name: staff.name || '',
      empNo: staff.empNo || '',
      position: staff.position || '',
      gender: staff.gender || '',
      storeId: staff.storeId,
      isStoreIncharge: staff.isStoreIncharge || false,
    })
    setSelectedStaff(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft({})
  }

  async function saveEdit(original) {
    setSaving(true)
    try {
      const { storeId: newStoreId, ...updates } = editDraft
      const oldStoreId = original.storeId
      const staffId = original.id

      if (newStoreId && newStoreId !== oldStoreId) {
        const fromRef = doc(db, 'stores', oldStoreId, 'roster', staffId)
        const snap = await getDoc(fromRef)
        if (!snap.exists()) throw new Error('Staff not found')
        const staffData = snap.data()
        const toRef = doc(db, 'stores', newStoreId, 'roster', staffId)
        const effectiveDate = new Date().toISOString().split('T')[0]

        await setDoc(toRef, {
          ...staffData,
          ...updates,
          transferredFrom: { storeId: oldStoreId, effectiveDate },
        })
        await setDoc(fromRef, {
          transferredOut: { storeId: newStoreId, effectiveDate },
          active: false,
        }, { merge: true })

        setAllStaff((prev) => prev.map((s) => {
          if (s.id === staffId && s.storeId === oldStoreId) {
            return {
              ...s,
              ...updates,
              storeId: newStoreId,
              storeName: STORES.find((st) => st.id === newStoreId)?.name || newStoreId,
              transferredFrom: { storeId: oldStoreId, effectiveDate },
            }
          }
          return s
        }))
      } else {
        await setDoc(doc(db, 'stores', oldStoreId, 'roster', staffId), updates, { merge: true })
        setAllStaff((prev) => prev.map((s) => {
          if (s.id === staffId && s.storeId === oldStoreId) {
            return { ...s, ...updates }
          }
          return s
        }))
      }
      setEditingId(null)
    } catch (err) {
      console.error('Failed to save staff:', err)
      alert('Failed to save changes. Check console.')
    } finally {
      setSaving(false)
    }
  }

  const isEditing = (s) => editingId === `${s.storeId}-${s.id}`

  return (
    <div>
      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <input
          type="text"
          placeholder="Search by name or emp no…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-content-muted outline-none focus:border-brand-primary"
        />
        <select
          value={filterStore}
          onChange={(e) => setFilterStore(e.target.value)}
          className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary"
        >
          <option value="">All stores</option>
          {STORES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          value={filterPos}
          onChange={(e) => setFilterPos(e.target.value)}
          className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary"
        >
          <option value="">All positions</option>
          {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={filterGender}
          onChange={(e) => setFilterGender(e.target.value)}
          className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary"
        >
          <option value="">All genders</option>
          {genders.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select
          value={filterIncharge}
          onChange={(e) => setFilterIncharge(e.target.value)}
          className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary"
        >
          <option value="">All incharge</option>
          <option value="yes">Incharge</option>
          <option value="no">Non-incharge</option>
        </select>
        <div className="text-xs text-content-muted self-center">{filtered.length} of {allStaff.length} staff</div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-content-muted text-sm">Loading…</div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">#</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Emp No</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Position</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Store</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Gender</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Incharge</th>
                  {isDM && <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filtered.map((s, idx) => (
                  <tr
                    key={`${s.storeId}-${s.id}`}
                    className={`hover:bg-white/[0.02] ${!isEditing(s) ? 'cursor-pointer' : ''} ${selectedStaff?.id === s.id && selectedStaff?.storeId === s.storeId ? 'bg-surface-hover' : ''}`}
                    onClick={() => {
                      if (!isEditing(s)) {
                        setSelectedStaff(selectedStaff?.id === s.id && selectedStaff?.storeId === s.storeId ? null : s)
                      }
                    }}
                  >
                    <td className="px-4 py-2.5 text-content-muted text-xs">{idx + 1}</td>
                    {isEditing(s) ? (
                      <>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={editDraft.name}
                            onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                            className="w-full bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={editDraft.empNo}
                            onChange={(e) => setEditDraft({ ...editDraft, empNo: e.target.value })}
                            className="w-24 bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="px-4 py-2">
                          <select
                            value={editDraft.position}
                            onChange={(e) => setEditDraft({ ...editDraft, position: e.target.value })}
                            className="bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">—</option>
                            {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <select
                            value={editDraft.storeId}
                            onChange={(e) => setEditDraft({ ...editDraft, storeId: e.target.value })}
                            className="bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {STORES.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <select
                            value={editDraft.gender}
                            onChange={(e) => setEditDraft({ ...editDraft, gender: e.target.value })}
                            className="bg-surface-panel border border-brand-primary/50 rounded px-2 py-1 text-sm text-content-main outline-none"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">—</option>
                            {genders.map((g) => <option key={g} value={g}>{g}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <label className="flex items-center gap-2 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={editDraft.isStoreIncharge}
                              onChange={(e) => setEditDraft({ ...editDraft, isStoreIncharge: e.target.checked })}
                              className="w-4 h-4 accent-brand-primary"
                            />
                            <span className="text-xs text-content-muted">Store Incharge</span>
                          </label>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); saveEdit(s) }}
                              disabled={saving}
                              className="px-2.5 py-1 rounded bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium disabled:opacity-50"
                            >
                              {saving ? '…' : 'Save'}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); cancelEdit() }}
                              className="px-2.5 py-1 rounded bg-surface-panel hover:bg-surface-hover text-content-muted text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-2.5">
                          <div className="text-content-main font-medium">{s.name}</div>
                          {s.transferredFrom && (
                            <div className="text-[10px] text-amber-500">transferred {s.transferredFrom.effectiveDate}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-content-muted text-xs">{s.empNo || '—'}</td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs px-2 py-0.5 rounded bg-surface-panel text-content-muted">{s.position || '—'}</span>
                        </td>
                        <td className="px-4 py-2.5 text-content-muted text-xs">{s.storeName}</td>
                        <td className="px-4 py-2.5 text-content-muted text-xs">{s.gender || '—'}</td>
                        <td className="px-4 py-2.5">
                          {s.isStoreIncharge ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-primary/20 text-brand-primary font-medium">Incharge</span>
                          ) : (
                            <span className="text-content-muted text-xs">—</span>
                          )}
                        </td>
                        {isDM && (
                          <td className="px-4 py-2.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); startEdit(s) }}
                              className="text-xs text-content-muted hover:text-[#D8E8E2] transition-colors px-2 py-1 rounded hover:bg-surface-panel"
                            >
                              Edit
                            </button>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-center py-10 text-content-muted text-sm">No staff match your search.</div>
            )}
          </div>

          {selectedStaff && !editingId && (
            <AvailabilityPanel
              staff={selectedStaff}
              onClose={() => setSelectedStaff(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Availability Pattern Panel (#7) ────────────────────────────────────────

function AvailabilityPanel({ staff, onClose }) {
  const [schedule, setSchedule] = useState(null)
  const [loading, setLoading] = useState(true)
  const [weeks] = useState(() => {
    const dates = []
    let current = getWeekStartFriday()
    for (let i = 0; i < 12; i++) {
      dates.push(current)
      current = getPrevWeekStart(current)
    }
    return dates.reverse()
  })

  useEffect(() => {
    async function loadSchedule() {
      setLoading(true)
      try {
        const results = {}
        await Promise.all(
          weeks.map(async (weekStart) => {
            const docSnap = await getDoc(doc(db, 'schedules', staff.storeId, 'weeks', weekStart))
            if (docSnap.exists()) {
              results[weekStart] = docSnap.data().entries || {}
            }
          })
        )
        setSchedule(results)
      } catch (err) {
        console.error('Failed to load schedule:', err)
        setSchedule({})
      } finally {
        setLoading(false)
      }
    }
    loadSchedule()
  }, [staff.storeId, staff.id, weeks])



  // Calculate AM vs PM ratio
  let amCount = 0, pmCount = 0, midCount = 0
  weeks.forEach((weekStart) => {
    const weekData = schedule?.[weekStart]?.[staff.id] || {}
    const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
    days.forEach((day) => {
      const shift = weekData[day]
      if (shift === 'AM Shift' || shift === 'AM 8h') amCount++
      else if (shift === 'PM Shift') pmCount++
      else if (shift === 'Mid Shift' || shift === 'GY Shift') midCount++
    })
  })

  const totalShifts = amCount + pmCount + midCount
  const amRatio = totalShifts > 0 ? Math.round((amCount / totalShifts) * 100) : 0
  const pmRatio = totalShifts > 0 ? Math.round((pmCount / totalShifts) * 100) : 0

  return (
    <>
      {/* Background backdrop on mobile only */}
      <div 
        className="fixed inset-0 bg-black/40 z-40 lg:hidden"
        onClick={onClose}
      />
      
      <div className="fixed inset-x-4 bottom-4 top-20 z-50 lg:relative lg:inset-auto lg:z-0 lg:w-80 flex-shrink-0 bg-surface-panel rounded-2xl p-5 border border-border-subtle shadow-2xl lg:shadow-none flex flex-col overflow-hidden lg:h-fit lg:sticky lg:top-6 lg:rounded-xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base lg:text-sm font-semibold text-content-main">{staff.name}</h3>
            <p className="text-[11px] lg:text-[10px] text-content-muted">{staff.position} · {staff.storeName}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 -mr-1 flex items-center justify-center text-content-muted hover:text-content-main bg-surface-hover rounded-full transition-colors"
            aria-label="Close panel"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1">

      {/* Shift ratio summary */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-surface-panel rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-blue-400">{amRatio}%</div>
          <div className="text-[10px] text-content-muted">AM</div>
        </div>
        <div className="bg-surface-panel rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-amber-400">{pmRatio}%</div>
          <div className="text-[10px] text-content-muted">PM</div>
        </div>
      </div>

      {/* 12-week heatmap */}
      <div className="text-[10px] text-content-muted uppercase tracking-wider mb-2">Last 12 weeks</div>
      {loading ? (
        <div className="text-xs text-content-muted py-4 text-center">Loading…</div>
      ) : (
        <div className="space-y-1">
          {weeks.map((weekStart) => {
            const weekData = schedule?.[weekStart] || {}
            const staffEntry = weekData[staff.id] || {}
            
            // Count shifts per type for this week
            const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
            let am = 0, pm = 0, off = 0
            days.forEach((d) => {
              const s = staffEntry[d]
              if (s === 'AM Shift' || s === 'AM 8h') am++
              else if (s === 'PM Shift') pm++
              else if (s === 'Day Off') off++
            })

            const weekDate = new Date(weekStart + 'T00:00:00')
            const weekLabel = weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

            return (
              <div key={weekStart} className="flex items-center gap-2 text-xs">
                <span className="text-content-muted w-16 flex-shrink-0">{weekLabel}</span>
                <div className="flex gap-0.5 flex-1">
                  {days.map((d) => {
                    const s = staffEntry[d]
                    let bg = 'bg-[var(--shift-off-bg)]'
                    let text = 'text-[var(--shift-off-text)]'
                    if (s === 'AM Shift' || s === 'AM 8h') { bg = 'bg-[var(--shift-am-bg)]'; text = 'text-[var(--shift-am-text)]' }
                    else if (s === 'PM Shift') { bg = 'bg-[var(--shift-pm-bg)]'; text = 'text-[var(--shift-pm-text)]' }
                    else if (s === 'Mid Shift' || s === 'GY Shift') { bg = 'bg-[var(--shift-mid-bg)]'; text = 'text-[var(--shift-mid-text)]' }
                    else if (s === 'Day Off') { bg = 'bg-[var(--shift-off-bg)]'; text = 'text-[var(--shift-off-text)]' }
                    else if (s === 'Leave') { bg = 'bg-[var(--shift-leave-bg)]'; text = 'text-[var(--shift-leave-text)]' }
                    
                    return (
                      <div
                        key={d}
                        title={`${d}: ${s || '—'}`}
                        className={`w-5 h-4 rounded-sm ${bg} ${text} transition-colors flex items-center justify-center text-[8px] font-medium`}
                      >
                        {d[0]}
                      </div>
                    )
                  })}
                </div>
                <span className="text-[10px] text-content-muted w-12 text-right">
                  {am}A/{pm}P/{off}O
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-3 mt-4 pt-3 border-t border-border-subtle text-[10px] text-content-muted">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500/60"></span>AM</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/60"></span>PM</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/40"></span>Off</span>
      </div>
        </div>
      </div>
    </>
  )
}

// ── Leave History Tab ────────────────────────────────────────────────────────

function LeaveHistoryTab() {
  const { stores: STORES } = useStoresContext()
  const [balances, setBalances] = useState({}) // staffId → balance doc
  const [plans, setPlans] = useState([])       // array of leave plan docs
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStore, setFilterStore] = useState('')
  const [expandedId, setExpandedId] = useState(null)

  // Real-time balance data — keyed by staffId (not doc ID)
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'leaveBalances'), (snap) => {
      const currentYear = new Date().getFullYear()
      const map = {}
      snap.docs.forEach((d) => {
        const data = d.data()
        if (data.year === currentYear && data.staffId) {
          // Key by staffId so it merges correctly with plans
          map[data.staffId] = { ...data, docId: d.id }
        }
      })
      setBalances(map)
    })
    return () => unsub()
  }, [])

  // Fetch leave plans once
  useEffect(() => {
    async function load() {
      const snap = await getDocs(collection(db, 'leavePlans'))
      setPlans(snap.docs.map((d) => ({ ...d.data(), id: d.id })))
      setLoading(false)
    }
    load()
  }, [])

  // Build a name map from balances (staffId → name) and also from roster if available
  // We'll use what we have from balances
  const staffIds = Array.from(new Set([...Object.keys(balances), ...plans.map((p) => p.staffId)]))

  // Group plans by staffId
  const plansByStaff = {}
  plans.forEach((p) => {
    if (!plansByStaff[p.staffId]) plansByStaff[p.staffId] = []
    plansByStaff[p.staffId].push(p)
  })

  function getStoreName(storeId) {
    return STORES.find((s) => s.id === storeId)?.name || storeId || '—'
  }

  const rows = staffIds
    .map((id) => {
      const bal = balances[id] || {}
      const staffPlans = plansByStaff[id] || []
      const storeId = bal.storeId || staffPlans[0]?.storeId || ''
      return {
        id,
        name: bal.staffName || staffPlans[0]?.staffName || id,
        storeId,
        storeName: getStoreName(storeId),
        used: bal.used ?? 0,
        remaining: bal.remaining ?? 0,
        total: bal.totalBalance ?? (bal.annualEntitlement != null ? bal.annualEntitlement + (bal.carryForward ?? 0) : 0),
        plans: staffPlans,
      }
    })
    .filter((r) => {
      const matchSearch = !search || r.name.toLowerCase().includes(search.toLowerCase())
      const matchStore = !filterStore || r.storeId === filterStore
      return matchSearch && matchStore
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  function statusBadge(status) {
    if (status === 'approved') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 font-medium">Approved</span>
    if (status === 'pending')  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 font-medium">Pending</span>
    if (status === 'cancelled') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 font-medium line-through">Cancelled</span>
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-panel text-content-muted font-medium">{status || '—'}</span>
  }

  return (
    <div>
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-[#D8E8E2]/20 outline-none focus:border-brand-primary"
        />
        <select
          value={filterStore}
          onChange={(e) => setFilterStore(e.target.value)}
          className="bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main outline-none focus:border-brand-primary"
        >
          <option value="">All stores</option>
          {STORES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="text-xs text-content-muted self-center">{rows.length} staff</div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-content-muted text-sm">Loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Staff Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Store</th>
                <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Used</th>
                <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Remaining</th>
                <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Total</th>
                <th className="text-center px-4 py-2.5 text-xs font-semibold text-content-muted uppercase tracking-wider">Leave Plans</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((row) => (
                <>
                  <tr
                    key={row.id}
                    className="hover:bg-white/[0.02] cursor-pointer"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <td className="px-4 py-3 text-content-main font-medium">{row.name}</td>
                    <td className="px-4 py-3 text-content-muted text-xs">{row.storeName}</td>
                    <td className="px-4 py-3 text-center text-amber-400 font-semibold">{row.used}</td>
                    <td className="px-4 py-3 text-center text-green-400 font-semibold">{row.remaining}</td>
                    <td className="px-4 py-3 text-center text-content-muted">{row.total}</td>
                    <td className="px-4 py-3 text-center">
                      {row.plans.length > 0 ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-surface-panel text-content-muted">{row.plans.length}</span>
                      ) : (
                        <span className="text-content-muted text-xs">—</span>
                      )}
                    </td>
                  </tr>
                  {expandedId === row.id && row.plans.length > 0 && (
                    <tr key={`${row.id}-plans`} className="bg-surface-hover">
                      <td colSpan={6} className="px-6 py-3">
                        <div className="flex flex-col gap-1.5">
                          {row.plans.map((p) => (
                            <div key={p.id} className="flex items-center gap-3 text-xs">
                              <span className="text-content-muted">{p.startDate} → {p.endDate}</span>
                              <span className="text-content-muted">{p.daysCount} day{p.daysCount !== 1 ? 's' : ''}</span>
                              {statusBadge(p.status)}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="text-center py-10 text-content-muted text-sm">No leave data found.</div>
          )}
        </div>
      )}
    </div>
  )
}
