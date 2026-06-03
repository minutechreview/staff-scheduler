import { useState, useEffect } from 'react'
import { getTemplates, deleteTemplate, saveAsTemplate } from '../utils/templates'

export default function TemplateModal({ store, staff, scheduleEntries, weekStart, onClose, onApply }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('browse') // 'browse' | 'save'
  const [templateName, setTemplateName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  useEffect(() => {
    loadTemplates()
  }, [store.id])

  async function loadTemplates() {
    setLoading(true)
    try {
      const tmpl = await getTemplates(store.id)
      setTemplates(tmpl)
    } catch (err) {
      setError('Failed to load templates')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    if (!templateName.trim()) {
      setError('Please enter a template name')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await saveAsTemplate(store.id, store.name, staff, scheduleEntries, templateName)
      setSuccess(`Saved "${result.name}" with ${result.shiftCount} shifts`)
      setTemplateName('')
      await loadTemplates()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(templateId, templateName) {
    if (!window.confirm(`Delete template "${templateName}"?`)) return
    try {
      await deleteTemplate(store.id, templateId)
      await loadTemplates()
    } catch (err) {
      setError('Failed to delete template')
    }
  }

  function handleApply(template) {
    onApply(template)
    onClose()
  }

  const hasShifts = staff.some((s) => {
    const entry = scheduleEntries[s.id] || {}
    return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].some(
      (d) => entry[d] && ['AM Shift', 'PM Shift', 'Day Off', 'Mid Shift', 'GY Shift', 'AM 8h'].includes(entry[d])
    )
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-content-main">Schedule Templates</h2>
            <p className="text-xs text-content-muted mt-0.5">{store.name} templates</p>
          </div>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle flex-shrink-0">
          <button
            onClick={() => setTab('browse')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === 'browse'
                ? 'text-[#296044] border-b-2 border-[#296044]'
                : 'text-content-muted hover:text-content-muted'
            }`}
          >
            Browse ({templates.length})
          </button>
          <button
            onClick={() => setTab('save')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === 'save'
                ? 'text-[#296044] border-b-2 border-[#296044]'
                : 'text-content-muted hover:text-content-muted'
            }`}
          >
            Save Current
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-900/30 border border-red-500/30 text-red-300 text-xs">
              {error}
            </div>
          )}
          
          {success && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-green-900/30 border border-green-500/30 text-green-300 text-xs">
              {success}
            </div>
          )}

          {tab === 'browse' && (
            <div>
              {loading ? (
                <div className="flex items-center justify-center py-12 text-content-muted text-sm">Loading…</div>
              ) : templates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <svg className="w-10 h-10 text-content-muted mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  <p className="text-content-muted text-sm">No templates yet</p>
                  <p className="text-content-muted text-xs mt-1">Save a week to create your first template</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {templates.map((tmpl) => {
                    const shiftCount = Object.values(tmpl.shifts || {})
                      .reduce((sum, days) => sum + Object.keys(days).length, 0)
                    const created = tmpl.createdAt?.toDate?.() || new Date(tmpl.createdAt)
                    const dateStr = created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    
                    return (
                      <div key={tmpl.id} className="flex items-center justify-between p-3 rounded-xl bg-surface-panel hover:bg-surface-panel group">
                        <div className="flex-1 min-w-0">
                          <div className="text-content-main text-sm font-medium">{tmpl.name}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-content-muted">{shiftCount} shifts</span>
                            <span className="text-[10px] text-content-muted">·</span>
                            <span className="text-[10px] text-content-muted">{dateStr}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-3">
                          <button
                            onClick={() => handleApply(tmpl)}
                            className="px-3 py-1.5 rounded-lg bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium transition-colors"
                          >
                            Apply
                          </button>
                          <button
                            onClick={() => handleDelete(tmpl.id, tmpl.name)}
                            className="px-2 py-1.5 rounded-lg text-content-muted hover:text-red-400 hover:bg-red-900/20 text-xs transition-colors opacity-0 group-hover:opacity-100"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'save' && (
            <div className="space-y-4">
              {!hasShifts ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <svg className="w-10 h-10 text-content-muted mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <p className="text-content-muted text-sm">No shifts to save</p>
                  <p className="text-content-muted text-xs mt-1">Add some AM/PM/Day Off shifts first</p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs text-content-muted font-semibold uppercase tracking-wider block mb-1.5">
                      Template Name
                    </label>
                    <input
                      type="text"
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder="e.g., Morning Shift Pattern, Weekend Heavy…"
                      className="w-full bg-surface-panel border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-content-main placeholder-[#D8E8E2]/20 outline-none focus:border-brand-primary transition-colors"
                      onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                    />
                  </div>
                  
                  <div className="text-xs text-content-muted leading-relaxed">
                    <p>This will save all AM, PM, Day Off, Mid, and GY shifts grouped by position (B, SIC, A, etc.).</p>
                    <p className="mt-1 text-content-muted">Leave, Support, and Activity entries are <em>not</em> saved.</p>
                  </div>

                  <button
                    onClick={handleSave}
                    disabled={!templateName.trim() || saving}
                    className="w-full py-2.5 rounded-xl bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white text-sm font-medium transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save as Template'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
