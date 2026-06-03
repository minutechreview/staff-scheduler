import { useState, useEffect } from 'react'
import { fetchAllStoresSummary, assignSupportShift } from '../hooks/useSchedule'
import { getAvailableStaffForDay } from '../utils/schedulingAssistant'

export default function SupportPickerModal({ day, shiftType, thisStoreId, weekStart, onClose, onAssigned }) {
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState([])
  const [assigning, setAssigning] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const summary = await fetchAllStoresSummary(weekStart, { includeRoster: true })
        const available = getAvailableStaffForDay(day, summary, thisStoreId)
        setGroups(available)
      } catch (err) {
        setError('Failed to load staff. Please try again.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [day, weekStart, thisStoreId])

  async function handleSelect(sourceStoreId, staffId) {
    setAssigning(staffId)
    setError('')
    try {
      await assignSupportShift(sourceStoreId, staffId, day, thisStoreId, weekStart)
      onAssigned?.()
      onClose()
    } catch (err) {
      setError('Failed to assign support. Please try again.')
      setAssigning(null)
    }
  }

  const shiftLabel = shiftType === 'AM Shift' ? 'AM' : 'PM'
  const totalAvailable = groups.reduce((sum, g) => sum + g.staff.length, 0)

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-md shadow-2xl max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-content-main">Request Support</h2>
            <p className="text-xs text-content-muted mt-0.5">
              {shiftLabel} shift · {day}
              {!loading && totalAvailable > 0 && (
                <span className="ml-2 text-content-muted">· {totalAvailable} available</span>
              )}
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
          {loading ? (
            <div className="flex items-center justify-center py-12 text-xs text-content-muted gap-2">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Loading available staff…
            </div>
          ) : error ? (
            <div className="px-6 py-8 text-xs text-red-400 text-center">{error}</div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-content-muted">
              <svg className="w-8 h-8 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              <p className="text-sm">No staff available on {day}.</p>
              <p className="text-xs">All staff are on leave, support, or day off.</p>
            </div>
          ) : (
            <div className="py-1">
              {groups.map((group) => (
                <div key={group.storeId}>
                  <div className="px-6 pt-4 pb-1 text-[10px] text-content-muted uppercase tracking-wider font-semibold">
                    {group.storeName}
                  </div>
                  {group.staff.map((member) => (
                    <button
                      key={member.id}
                      onClick={() => handleSelect(group.storeId, member.id)}
                      disabled={!!assigning}
                      className="w-full flex items-center justify-between px-6 py-3 hover:bg-surface-panel transition-colors disabled:opacity-60 text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-content-main">{member.name}</span>
                          {member.isSIC && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-900/40 text-amber-300 border border-amber-500/20 flex-shrink-0">
                              SIC
                            </span>
                          )}
                          {member.isSurplus && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-green-900/30 text-green-400 border border-green-500/20 flex-shrink-0">
                              Surplus
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-content-muted mt-0.5">
                          {member.position}{member.empNo ? ` · ${member.empNo}` : ''}
                          {member.currentShift ? ` · ${member.currentShift === 'AM Shift' ? 'AM' : member.currentShift === 'PM Shift' ? 'PM' : member.currentShift}` : ''}
                        </div>
                      </div>
                      {assigning === member.id ? (
                        <span className="text-xs text-content-muted flex-shrink-0">Assigning…</span>
                      ) : (
                        <div className="w-7 h-7 rounded-lg bg-[#1a3a2a] border border-brand-primary/50 flex items-center justify-center flex-shrink-0 ml-2">
                          <svg className="w-3.5 h-3.5 text-[#296044]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                          </svg>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
