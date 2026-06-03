import { useState, useEffect } from 'react'
import { collection, query, where, getDocs, doc, setDoc, getDoc, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { useAor } from '../contexts/AorContext'
import { useStoresContext } from '../contexts/StoresContext'

export default function AorManagementPage() {
  const { role, aorId, aorData, isDM, isAdmin } = useAor()
  const { stores } = useStoresContext()
  const [tab, setTab] = useState('Team') // 'Team' | 'Bulk Import' | 'Settings'
  
  const [team, setTeam] = useState([])
  const [loadingTeam, setLoadingTeam] = useState(false)

  // Fetch all users belonging to this AOR
  useEffect(() => {
    if (!aorId) return
    async function fetchTeam() {
      setLoadingTeam(true)
      try {
        const q = query(collection(db, 'users'), where('aorId', '==', aorId))
        const snap = await getDocs(q)
        setTeam(snap.docs.map(d => ({ email: d.id, ...d.data() })))
      } catch (err) {
        console.error('[AorManage] Error fetching team:', err)
      } finally {
        setLoadingTeam(false)
      }
    }
    fetchTeam()
  }, [aorId])

  async function handleUpdateUser(email, updates) {
    if (!isDM && !isAdmin) return
    await setDoc(doc(db, 'users', email), updates, { merge: true })
    setTeam(prev => prev.map(u => u.email === email ? { ...u, ...updates } : u))
  }

  async function handleDeleteUser(email) {
    if (!isDM && !isAdmin) return
    if (!window.confirm(`Are you sure you want to PERMANENTLY delete account ${email}? This cannot be undone.`)) return
    
    try {
      const { deleteDoc, doc } = await import('firebase/firestore')
      await deleteDoc(doc(db, 'users', email))
      setTeam(prev => prev.filter(u => u.email !== email))
    } catch (err) {
      console.error('[AorManage] Error deleting user:', err)
      alert('Failed to delete user. Check permissions.')
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-surface-root overflow-hidden">
      <div className="px-8 pt-8 pb-4 bg-surface-panel border-b border-border-subtle">
        <h1 className="text-2xl font-bold text-content-main mb-1">Area Management</h1>
        <p className="text-sm text-content-muted">{aorData?.name || 'Loading Area...'} · Administration</p>

        <div className="flex gap-4 mt-6">
          {['Team', 'Bulk Import', 'Area Settings'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-3 text-sm font-medium transition-all relative ${
                tab === t ? 'text-brand-primary' : 'text-content-muted hover:text-content-main'
              }`}
            >
              {t}
              {tab === t && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-primary rounded-full" />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto">
          {tab === 'Team' && (
            <TeamTab team={team} loading={loadingTeam} onUpdate={handleUpdateUser} onDelete={handleDeleteUser} stores={stores} currentRole={role} />
          )}
          {tab === 'Bulk Import' && (
            <BulkImportTab aorId={aorId} />
          )}
          {tab === 'Area Settings' && (
            <div className="text-content-muted italic">Area settings and timing overrides coming soon...</div>
          )}
        </div>
      </div>
    </div>
  )
}

function TeamTab({ team, loading, onUpdate, onDelete, stores, currentRole }) {
  const [saving, setSaving] = useState(null) // email being saved
  const [editing, setEditing] = useState(null) // email being edited (name)
  const [editName, setEditName] = useState('')

  async function handleRoleChange(email, newRole) {
    setSaving(email)
    try {
      await onUpdate(email, { role: newRole })
    } finally {
      setSaving(null)
    }
  }

  async function handleNameSave(email) {
    if (!editName.trim()) return
    setSaving(email + '-name')
    try {
      await onUpdate(email, { displayName: editName.trim() })
      setEditing(null)
    } finally {
      setSaving(null)
    }
  }

  async function handleStoreChange(email, newStoreId) {
    setSaving(email + '-store')
    try {
      await onUpdate(email, { storeId: newStoreId || null })
    } finally {
      setSaving(null)
    }
  }

  if (loading) return <div className="py-20 text-center text-content-muted">Loading team roster...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-content-main">Authorized Managers</h2>
          <p className="text-sm text-content-muted">Manage roles and store assignments for managers in your Area.</p>
        </div>
      </div>

      <div className="bg-surface-panel border border-border-subtle rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-root/50 text-left border-b border-border-subtle">
              <th className="px-6 py-4 font-semibold text-content-muted uppercase tracking-widest text-[10px]">Manager</th>
              <th className="px-6 py-4 font-semibold text-content-muted uppercase tracking-widest text-[10px]">Assigned Store</th>
              <th className="px-6 py-4 font-semibold text-content-muted uppercase tracking-widest text-[10px]">Role</th>
              <th className="px-6 py-4 font-semibold text-content-muted uppercase tracking-widest text-[10px] text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {team.length === 0 && (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-content-muted italic text-sm">
                  No managers found in this area. Managers will appear here after they sign in for the first time.
                </td>
              </tr>
            )}
            {team.map(user => {
              const isSavingRole = saving === user.email
              const isSavingStore = saving === user.email + '-store'

              return (
                <tr key={user.email} className="hover:bg-surface-root/30 transition-colors">
                  <td className="px-6 py-4">
                    {editing === user.email ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="bg-surface-root border border-brand-primary rounded-lg px-2 py-1 text-xs text-content-main outline-none w-32"
                          onKeyDown={(e) => e.key === 'Enter' && handleNameSave(user.email)}
                        />
                        <button onClick={() => handleNameSave(user.email)} className="p-1 text-brand-primary hover:bg-brand-primary/10 rounded">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                        </button>
                        <button onClick={() => setEditing(null)} className="p-1 text-content-muted hover:bg-surface-root rounded">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ) : (
                      <div className="group flex items-center gap-2">
                        <div>
                          <div className="font-bold text-content-main">{user.displayName || 'Manager'}</div>
                          <div className="text-[10px] text-content-muted">{user.email}</div>
                        </div>
                        <button 
                          onClick={() => { setEditing(user.email); setEditName(user.displayName || '') }}
                          className="opacity-0 group-hover:opacity-100 p-1 text-content-muted hover:text-brand-primary transition-all"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                      </div>
                    )}
                  </td>

                  {/* Editable Store Assignment */}
                  <td className="px-6 py-4">
                    {isSavingStore ? (
                      <span className="text-content-muted text-xs animate-pulse">Saving...</span>
                    ) : (
                      <select
                        value={user.storeId || ''}
                        onChange={(e) => handleStoreChange(user.email, e.target.value)}
                        className="bg-surface-root border border-border-subtle rounded-lg px-2 py-1.5 text-xs text-content-main outline-none focus:border-brand-primary transition-colors max-w-[180px] truncate cursor-pointer"
                      >
                        <option value="">— Unassigned —</option>
                        {stores.map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    )}
                  </td>

                  {/* Editable Role — SM only for store users */}
                  <td className="px-6 py-4">
                    {isSavingRole ? (
                      <span className="text-content-muted text-xs animate-pulse">Saving...</span>
                    ) : (
                      <select
                        value={user.role || 'SM'}
                        onChange={(e) => handleRoleChange(user.email, e.target.value)}
                        className={`border rounded-lg px-2 py-1 text-[11px] font-bold uppercase outline-none focus:ring-1 focus:ring-brand-primary cursor-pointer transition-colors ${
                          user.role === 'AOR_ADMIN'
                            ? 'bg-brand-primary/10 text-brand-primary border-brand-primary/30'
                            : 'bg-surface-root text-content-muted border-border-subtle'
                        }`}
                      >
                        <option value="SM">SM</option>
                        <option value="AOR_ADMIN">AOR Admin</option>
                      </select>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => onDelete(user.email)}
                        className="p-2 rounded-lg bg-red-500/5 text-red-500/40 hover:text-red-500 hover:bg-red-500/10 transition-all"
                        title="Delete User"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>

                      <div className="w-px h-4 bg-border-subtle mx-1" />

                      {user.role === 'AOR_ADMIN' ? (
                        <button
                          onClick={() => handleRoleChange(user.email, 'SM')}
                          disabled={isSavingRole}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all disabled:opacity-40"
                        >
                          Revoke Admin
                        </button>
                      ) : (
                        <button
                          onClick={() => handleRoleChange(user.email, 'AOR_ADMIN')}
                          disabled={isSavingRole}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/20 transition-all disabled:opacity-40"
                        >
                          Promote to Admin
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BulkImportTab({ aorId }) {
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState(null)

  async function handleImport() {
    if (!file) return
    setImporting(true)
    setStatus({ type: 'info', message: 'Parsing regional data...' })
    
    try {
      const { importAreaFromExcel } = await import('../utils/aorImport')
      const result = await importAreaFromExcel(file, aorId)
      setStatus({ type: 'success', message: `Successfully bootstrapped ${result.stores} stores and ${result.staff} partners!` })
    } catch (err) {
      console.error(err)
      setStatus({ type: 'error', message: err.message })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold text-content-main mb-2">Regional Bulk Bootstrapping</h2>
      <p className="text-sm text-content-muted mb-8">
        Upload a Regional Data Sheet to automatically create stores, assign categories, and pre-populate rosters.
      </p>

      <div className="p-8 border-2 border-dashed border-border-subtle rounded-3xl bg-surface-panel flex flex-col items-center text-center">
        <div className="w-16 h-16 bg-brand-primary/10 rounded-2xl flex items-center justify-center text-brand-primary mb-4">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        
        <label className="cursor-pointer">
          <span className="bg-brand-primary hover:bg-brand-hover text-white px-6 py-3 rounded-2xl text-sm font-bold shadow-lg shadow-brand-primary/20 transition-all inline-block">
            {file ? file.name : 'Select Regional Excel File'}
          </span>
          <input type="file" className="hidden" accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files[0])} />
        </label>
        
        <p className="text-[10px] text-content-muted mt-4 uppercase tracking-widest font-bold">Supported: .xlsx, .xls</p>
      </div>

      {status && (
        <div className={`mt-6 p-4 rounded-2xl border ${
          status.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-500' : 
          status.type === 'success' ? 'bg-brand-primary/10 border-brand-primary/20 text-brand-primary' :
          'bg-surface-panel border-border-subtle text-content-main'
        }`}>
          <div className="flex items-center gap-3">
            {status.type === 'info' && <div className="w-4 h-4 rounded-full border-2 border-t-transparent border-content-main animate-spin" />}
            <span className="text-sm font-medium">{status.message}</span>
          </div>
        </div>
      )}

      <div className="flex gap-4 mt-8">
        <button 
          onClick={handleImport}
          disabled={!file || importing}
          className="flex-1 bg-content-main text-surface-root h-12 rounded-2xl font-bold disabled:opacity-30 transition-all flex items-center justify-center gap-2"
        >
          {importing ? 'Processing Area...' : 'Begin Regional Import'}
        </button>
        <button 
          onClick={async () => {
            const { generateAorTemplate } = await import('../utils/aorImport')
            const blob = await generateAorTemplate()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'Area_Bootstrap_Template.xlsx'
            a.click()
          }}
          className="px-6 bg-surface-panel border border-border-subtle text-content-muted h-12 rounded-2xl font-bold hover:text-content-main transition-colors text-sm"
        >
          Download Template
        </button>
      </div>
    </div>
  )
}
