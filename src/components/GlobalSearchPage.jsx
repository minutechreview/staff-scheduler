import { useState, useEffect, useMemo } from 'react'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useStoresContext } from '../contexts/StoresContext'
import { useAor } from '../contexts/AorContext'
import { POSITIONS, getWeekStartFriday, WEEK_DAYS, SHIFT_OPTIONS } from '../data/stores'
import WeekPicker from './WeekPicker'

/**
 * GlobalSearchPage
 * Allows District Managers to search for staff members across ALL stores in their AOR.
 * Now includes weekly schedule overview for searched staff.
 */
export default function GlobalSearchPage() {
  const { stores, updateStore } = useStoresContext()
  const { isDM, isAdmin } = useAor()
  const [weekStart, setWeekStart] = useState(getWeekStartFriday)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [allStaff, setAllStaff] = useState([])
  const [managerRows, setManagerRows] = useState([])
  const [activeTab, setActiveTab] = useState('partners')
  const [savingManagerStoreId, setSavingManagerStoreId] = useState('')

  useEffect(() => {
    async function fetchAorStaff() {
      if (!stores || stores.length === 0) return
      setLoading(true)
      try {
        const storeSummaries = await Promise.all(stores.map(async (store) => {
          const rosterRef = collection(db, 'stores', store.id, 'roster')
          const rosterSnap = await getDocs(rosterRef)
          const scheduleRef = doc(db, 'schedules', store.id, 'weeks', weekStart)
          const scheduleSnap = await getDoc(scheduleRef)
          const scheduleData = scheduleSnap.exists() ? scheduleSnap.data().entries || {} : {}
          const roster = rosterSnap.docs
            .map((rosterDoc) => ({ id: rosterDoc.id, ...rosterDoc.data() }))
            .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

          const staffPool = roster.map((member) => ({
              id: member.id,
              ...member,
              storeName: store.name,
              storeId: store.id,
              schedule: scheduleData[member.id] || {}
          }))

          const assignedManagerId = store.managerStaffId || roster[0]?.id || ''
          const assignedManager = roster.find((member) => member.id === assignedManagerId) || roster[0] || null

          return {
            store,
            roster,
            staffPool,
            manager: assignedManager ? {
              storeId: store.id,
              storeName: store.name,
              staffId: assignedManager.id,
              name: assignedManager.name || 'Unassigned',
              empNo: assignedManager.empNo || '',
              position: assignedManager.position || '',
              schedule: scheduleData[assignedManager.id] || {},
              scheduleByStaff: scheduleData,
              roster,
              isFallbackManager: !store.managerStaffId && !!roster[0],
            } : {
              storeId: store.id,
              storeName: store.name,
              staffId: '',
              name: 'Unassigned',
              empNo: '',
              position: '',
              schedule: {},
              scheduleByStaff: scheduleData,
              roster,
              isFallbackManager: false,
            },
          }
        }))

        setAllStaff(storeSummaries.flatMap((summary) => summary.staffPool))
        setManagerRows(storeSummaries.map((summary) => summary.manager))
      } catch (err) {
        console.error('[GlobalSearch] Error fetching staff pool:', err)
      } finally {
        setLoading(false)
      }
    }

    if (stores && stores.length > 0) {
      fetchAorStaff()
    }
  }, [stores, weekStart])

  const queryText = searchQuery.trim().toLowerCase()

  const partnerResults = useMemo(() => {
    if (!queryText) return []
    return allStaff.filter((staff) =>
      staff.name?.toLowerCase().includes(queryText) ||
      staff.empNo?.toLowerCase().includes(queryText) ||
      staff.position?.toLowerCase().includes(queryText) ||
      staff.storeName?.toLowerCase().includes(queryText) ||
      staff.storeId?.toLowerCase().includes(queryText)
    ).slice(0, 50)
  }, [allStaff, queryText])

  const managerResults = useMemo(() => {
    const source = managerRows || []
    if (!queryText) return source
    return source.filter((manager) =>
      manager.name?.toLowerCase().includes(queryText) ||
      manager.empNo?.toLowerCase().includes(queryText) ||
      manager.position?.toLowerCase().includes(queryText) ||
      manager.storeName?.toLowerCase().includes(queryText) ||
      manager.storeId?.toLowerCase().includes(queryText)
    )
  }, [managerRows, queryText])

  async function handleManagerAssignment(storeId, staffId) {
    setSavingManagerStoreId(storeId)
    try {
      await updateStore(storeId, { managerStaffId: staffId || null })
      setManagerRows((prev) => prev.map((manager) => {
        if (manager.storeId !== storeId) return manager
        const selected = manager.roster.find((member) => member.id === staffId) || null
        return {
          ...manager,
          staffId: selected?.id || '',
          name: selected?.name || 'Unassigned',
          empNo: selected?.empNo || '',
          position: selected?.position || '',
          schedule: selected ? (manager.scheduleByStaff?.[selected.id] || {}) : {},
          isFallbackManager: false,
        }
      }))
    } catch (err) {
      console.error('[GlobalSearch] Failed to update manager assignment:', err)
      alert('Could not update the assigned manager. Please try again.')
    } finally {
      setSavingManagerStoreId('')
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-surface-root overflow-hidden">
      {/* Search Header */}
      <div className="p-6 md:p-8 bg-surface-panel border-b border-border-subtle shrink-0">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-content-main">Regional Partner Search</h1>
              <p className="text-sm text-content-muted mt-1 italic">
                Search across {stores.length} stores in your Area.
                {(isDM || isAdmin) ? ' Managers tab included for Admin/DM review.' : ''}
              </p>
            </div>
            <div className="bg-surface-root p-1 rounded-xl border border-border-subtle shadow-sm flex items-center">
              <span className="text-[10px] font-bold text-content-muted uppercase tracking-wider px-3 mr-1">Week</span>
              <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
            </div>
          </div>

          {(isDM || isAdmin) && (
            <div className="mb-5 inline-flex rounded-2xl border border-border-subtle bg-surface-root p-1 shadow-sm">
              <SearchTabButton active={activeTab === 'partners'} onClick={() => setActiveTab('partners')}>
                Partners
              </SearchTabButton>
              <SearchTabButton active={activeTab === 'managers'} onClick={() => setActiveTab('managers')}>
                Managers
              </SearchTabButton>
            </div>
          )}
          
          <div className="relative">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-content-muted">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'managers'
                ? 'Search by manager name, employee number, or store name...'
                : 'Search by name, employee number, position, or store name...'}
              className="w-full h-14 pl-12 pr-4 bg-surface-root border border-border-subtle rounded-2xl text-content-main focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent transition-all shadow-sm text-lg"
              autoFocus
            />
          </div>
        </div>
      </div>

      {/* Results Area */}
      <div className="flex-1 overflow-y-auto p-6 md:p-8">
        <div className="max-w-4xl mx-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-12 h-12 border-4 border-brand-primary/20 border-t-brand-primary rounded-full animate-spin" />
              <p className="text-content-muted text-sm font-medium animate-pulse tracking-wide">FETCHING REGIONAL STORE DATA...</p>
            </div>
          ) : activeTab === 'managers' ? (
            <ManagersTab
              managerResults={managerResults}
              weekStart={weekStart}
              onAssignManager={handleManagerAssignment}
              savingManagerStoreId={savingManagerStoreId}
            />
          ) : !searchQuery ? (
            <div className="text-center py-20">
              <div className="w-16 h-16 bg-surface-panel rounded-2xl flex items-center justify-center mx-auto mb-4 text-content-muted border border-border-subtle shadow-sm">
                <svg className="w-8 h-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-content-main italic">Ready to search</h3>
              <p className="text-sm text-content-muted">Type at least one character to see results.</p>
            </div>
          ) : partnerResults.length === 0 ? (
            <div className="text-center py-20 bg-surface-panel/50 rounded-3xl border border-dashed border-border-subtle">
              <p className="text-content-muted font-medium">No partners found in your Area for "{searchQuery}"</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {partnerResults.map((partner) => (
                <div key={`${partner.id}-${partner.storeId}`} className="p-5 md:p-6 bg-surface-panel border border-border-subtle rounded-3xl hover:border-brand-primary/50 transition-all shadow-sm group">
                  <div className="flex flex-col md:flex-row md:items-center gap-6">
                    <div className="flex items-center gap-4 flex-1">
                      <div className="w-14 h-14 rounded-2xl bg-surface-root border border-border-subtle flex items-center justify-center text-brand-primary text-xl font-bold shadow-inner">
                        {partner.name?.charAt(0) || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-bold text-content-main text-lg truncate">{partner.name}</h4>
                          <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded-md bg-brand-primary/10 text-brand-primary border border-brand-primary/20 uppercase tracking-tighter">
                            {partner.position}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-content-muted">
                          <span>Emp No: {partner.empNo || 'N/A'}</span>
                          <span className="w-1 h-1 rounded-full bg-border-subtle" />
                          <div className="flex items-center gap-1 font-medium text-brand-primary">
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                            {partner.storeName}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Weekly Schedule Summary */}
                    <div className="md:w-auto border-t md:border-t-0 md:border-l border-border-subtle pt-4 md:pt-0 md:pl-6">
                      <div className="text-[10px] font-bold text-content-muted uppercase tracking-widest mb-3 flex items-center justify-between md:justify-start">
                        <span>Weekly Schedule</span>
                      </div>
                      <div className="grid grid-cols-7 gap-1.5">
                        {WEEK_DAYS.map((day) => {
                          const shiftValue = partner.schedule[day] || ''
                          const shift = SHIFT_OPTIONS.find(s => s.value === shiftValue) || SHIFT_OPTIONS[0]
                          const displayLabel = shift.label === '—' ? '-' : shift.label
                          return (
                            <div key={day} className="flex flex-col items-center gap-1.5">
                              <span className="text-[9px] font-semibold text-content-muted">{day.charAt(0)}</span>
                              <div 
                                title={`${day}: ${shift.label || 'Not scheduled'}`}
                                className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold shadow-sm transition-transform hover:scale-110 ${shift.color} ${!shiftValue ? 'opacity-30 border border-border-subtle' : ''}`}
                              >
                                {displayLabel}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SearchTabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
        active ? 'bg-brand-primary text-white shadow-sm' : 'text-content-muted hover:text-content-main'
      }`}
    >
      {children}
    </button>
  )
}

function ManagersTab({ managerResults, weekStart, onAssignManager, savingManagerStoreId }) {
  if (managerResults.length === 0) {
    return (
      <div className="text-center py-20 bg-surface-panel/50 rounded-3xl border border-dashed border-border-subtle">
        <p className="text-content-muted font-medium">No stores or manager assignments found for this Area.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-content-main">Store Manager Weekly View</h3>
          <p className="text-sm text-content-muted">Admin and DM can review, assign, and reassign the manager record for each store.</p>
        </div>
        <div className="text-xs text-content-muted uppercase tracking-wider">Week of {weekStart}</div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {managerResults.map((manager) => (
          <div key={manager.storeId} className="p-5 md:p-6 bg-surface-panel border border-border-subtle rounded-3xl shadow-sm">
            <div className="flex flex-col xl:flex-row xl:items-center gap-6">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h4 className="font-bold text-content-main text-lg">{manager.storeName}</h4>
                  {manager.isFallbackManager && (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20 uppercase tracking-tighter">
                      Using top row
                    </span>
                  )}
                </div>
                <div className="text-sm text-content-main">{manager.name || 'Unassigned'}</div>
                <div className="flex items-center gap-3 text-xs text-content-muted mt-1 flex-wrap">
                  <span>Emp No: {manager.empNo || 'N/A'}</span>
                  <span className="w-1 h-1 rounded-full bg-border-subtle" />
                  <span>{manager.position || 'No position set'}</span>
                </div>
              </div>

              <div className="xl:w-[280px]">
                <label className="block text-[10px] font-bold text-content-muted uppercase tracking-widest mb-2">
                  Assign Manager
                </label>
                <select
                  value={manager.staffId || ''}
                  onChange={(e) => onAssignManager(manager.storeId, e.target.value)}
                  disabled={savingManagerStoreId === manager.storeId}
                  className="w-full bg-surface-root border border-border-subtle rounded-xl px-3 py-2 text-sm text-content-main focus:outline-none focus:border-brand-primary"
                >
                  <option value="">— Select manager —</option>
                  {manager.roster.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} {member.empNo ? `· ${member.empNo}` : ''} {member.position ? `· ${member.position}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="border-t xl:border-t-0 xl:border-l border-border-subtle pt-4 xl:pt-0 xl:pl-6">
                <div className="text-[10px] font-bold text-content-muted uppercase tracking-widest mb-3">
                  Weekly Shift
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {WEEK_DAYS.map((day) => {
                    const shiftValue = manager.schedule?.[day] || ''
                    const shift = SHIFT_OPTIONS.find((option) => option.value === shiftValue) || SHIFT_OPTIONS[0]
                    const displayLabel = shift.label === '—' ? '-' : shift.label
                    return (
                      <div key={`${manager.storeId}-${day}`} className="flex flex-col items-center gap-1.5">
                        <span className="text-[9px] font-semibold text-content-muted">{day.charAt(0)}</span>
                        <div
                          title={`${day}: ${shift.label || 'Not scheduled'}`}
                          className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold shadow-sm ${shift.color} ${!shiftValue ? 'opacity-30 border border-border-subtle' : ''}`}
                        >
                          {displayLabel}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
