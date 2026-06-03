import { useState } from 'react'
import { useStoresContext } from '../contexts/StoresContext'
import { useTheme } from '../contexts/ThemeContext'
import { POSITIONS } from '../data/stores'
import { useAor } from '../contexts/AorContext'

// Admin PIN — stored in Firestore config/adminSettings (default: 1234)
// For now we use a hardcoded default; Settings page will allow changing it.
const DEFAULT_ADMIN_PIN = '1234'

const NAV_TOP = [
  { id: 'overview',        label: 'Overview',        icon: GridIcon },
  { id: 'analytics',       label: 'Analytics',       icon: ChartIcon },
  { id: 'leave-calendar',  label: 'Leave Calendar',  icon: CalendarIcon },
  { id: 'support-pool',    label: 'Support Pool',    icon: UsersIcon },
  { id: 'search',          label: 'Global Search',   icon: SearchIcon },
  { id: 'aor-manage',      label: 'Manage Area',     icon: SettingsIcon },
]

const NAV_BOTTOM = [
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

export default function Sidebar({ currentView, onNavigate, user, onSignOut }) {
  const { stores, addStore, removeStore } = useStoresContext()
  const { theme, toggleTheme } = useTheme()
  const { role, storeId, aorData, isDM, isAdmin } = useAor()
  
  const [showAddModal, setShowAddModal] = useState(false)
  const [removeTarget, setRemoveTarget] = useState(null)

  const homeStore = stores.find(s => s.id === storeId)
  const displayName = user?.displayName || 'Manager'
  const subTitle = role === 'DM' ? 'District Manager' : role === 'SM' ? 'Store Manager' : 'Admin'
  const initials = displayName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  const aorName = aorData?.name || 'RetailCo'

  return (
    <aside className="w-60 flex-shrink-0 bg-surface-panel border-r border-border-subtle flex flex-col h-full sticky top-0">
      {/* Brand */}
      <div className="px-5 py-5 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="RetailCo" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-content-main leading-tight truncate">Store Scheduler</div>
            <div className="text-[10px] text-content-muted uppercase tracking-wider truncate">{aorName}</div>
          </div>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-0.5 mb-4">
          {NAV_TOP.map(({ id, label, icon: Icon }) => {
            if (id === 'search' && !isDM) return null
            if (id === 'aor-manage' && !isDM) return null
            return <NavButton key={id} id={id} label={label} icon={<Icon />} active={currentView === id} onClick={() => onNavigate(id)} />
          })}
        </div>

        {/* Stores section */}
        <div className="px-2 py-1.5 mb-1 flex items-center justify-between" data-tour="stores">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-content-muted">
            Stores ({stores.length})
          </span>
          {isDM && (
            <button
              onClick={() => setShowAddModal(true)}
              title="Add store"
              className="w-5 h-5 flex items-center justify-center rounded text-content-muted hover:text-content-main hover:bg-surface-hover transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          )}
        </div>

        <div className="space-y-0.5">
          {stores.map((store) => (
            <StoreNavItem
              key={store.id}
              store={store}
              active={currentView === `store-${store.id}`}
              isHome={store.id === storeId}
              onClick={() => onNavigate(`store-${store.id}`)}
              onRemove={isDM ? (() => setRemoveTarget(store)) : null}
            />
          ))}
        </div>
      </nav>

      {/* Bottom nav + user footer */}
      <div className="px-3 pb-3 border-t border-border-subtle pt-3 space-y-0.5 shrink-0">
        {NAV_BOTTOM.map(({ id, label, icon: Icon }) => (
          <NavButton key={id} id={id} label={label} icon={<Icon />} active={currentView === id} onClick={() => onNavigate(id)} />
        ))}
        
        {/* Theme Toggle */}
        <button onClick={toggleTheme} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-sm text-content-muted hover:text-content-main hover:bg-surface-hover">
          <span className="flex-shrink-0 opacity-80">
            {theme === 'dark' ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
            )}
          </span>
          <span className="truncate">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>

        <div className="flex items-center gap-3 px-3 py-2 mt-1">
          <img
            src={user?.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(initials || 'M')}&background=006241&color=fff`}
            alt="avatar" className="w-7 h-7 rounded-full flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-content-main truncate" title={displayName}>{displayName}</div>
            <div className="text-[10px] text-content-muted truncate">{subTitle}</div>
          </div>
          <button onClick={onSignOut} title="Sign out" className="text-content-muted hover:text-content-main transition-colors flex-shrink-0">
            <LogoutIcon />
          </button>
        </div>
      </div>

      {/* Modals */}
      {showAddModal && (
        <AddStoreModal
          onConfirm={(storeData) => { addStore(storeData); setShowAddModal(false) }}
          onClose={() => setShowAddModal(false)}
        />
      )}
      {removeTarget && (
        <RemoveStoreModal
          store={removeTarget}
          onConfirm={() => { removeStore(removeTarget.id); setRemoveTarget(null) }}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </aside>
  )
}

// ── Store nav item with hover remove button ──────────────────────────────────

function StoreNavItem({ store, active, onClick, onRemove }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-xs ${
          active ? 'bg-brand-primary text-white' : 'text-content-muted hover:text-content-main hover:bg-surface-hover'
        }`}
      >
        <span className="truncate flex-1">{store.name}</span>
      </button>
      {hovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          title="Remove store"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-red-500/70 hover:text-red-500 hover:bg-red-500/10 transition-colors bg-surface-panel"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
          </svg>
        </button>
      )}
    </div>
  )
}

// ── Add Store Modal ──────────────────────────────────────────────────────────

const STORE_CATEGORY_OPTIONS = [
  { value: 'regular',    label: 'Regular (8h, 6 days, 1 off)' },
  { value: 'office-12h', label: 'Office 12h (4 days, 12h shifts)' },
  { value: 'office-10h', label: 'Office 10h (5 days, weekdays only)' },
  { value: 'office-8h',  label: 'Office 8h (weekdays + 1 support day)' },
]

function AddStoreModal({ onConfirm, onClose }) {
  const [step, setStep] = useState('pin') // 'pin' | 'form'
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [form, setForm] = useState({
    name: '', id: '', storeCategory: 'regular', type: 'Regular',
    minAM: 2, minPM: 2, totalRoster: 5,
  })
  const [saving, setSaving] = useState(false)

  function checkPin() {
    if (pin === DEFAULT_ADMIN_PIN) { setStep('form'); setPinError('') }
    else { setPinError('Incorrect PIN') }
  }

  function handleField(k, v) {
    setForm((f) => {
      const updated = { ...f, [k]: v }
      // Auto-derive type label from category
      if (k === 'storeCategory') {
        const opt = STORE_CATEGORY_OPTIONS.find((o) => o.value === v)
        updated.type = v === 'regular' ? 'Regular' : v === 'office-12h' ? 'Office 12h' : v === 'office-10h' ? 'Office 10h' : 'Office 8h'
      }
      // Auto-generate ID from name
      if (k === 'name') {
        updated.id = v.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)
      }
      return updated
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.id.trim()) return
    setSaving(true)
    await onConfirm({ ...form, name: form.name.trim(), id: form.id.trim(), minAM: Number(form.minAM), minPM: Number(form.minPM), totalRoster: Number(form.totalRoster) })
    setSaving(false)
  }

  const inputClass = "w-full bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-[#D8E8E2]/20 focus:outline-none focus:border-brand-primary"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-content-main">Add Store</h2>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {step === 'pin' ? (
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-content-muted">Enter admin PIN to add a store.</p>
            <input
              type="password"
              placeholder="Admin PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && checkPin()}
              className={inputClass}
              autoFocus
            />
            {pinError && <p className="text-xs text-red-400">{pinError}</p>}
            <button onClick={checkPin} className="w-full bg-brand-primary hover:bg-brand-hover text-white rounded-lg py-2 text-sm font-medium transition-colors">
              Continue
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-3">
            <input type="text" placeholder="Store name" value={form.name} onChange={(e) => handleField('name', e.target.value)} className={inputClass} autoFocus required />
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">Store ID</label>
                <input type="text" value={form.id} onChange={(e) => handleField('id', e.target.value)} className={inputClass} required />
              </div>
            </div>
            <select value={form.storeCategory} onChange={(e) => handleField('storeCategory', e.target.value)} className={inputClass}>
              {STORE_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">Min AM</label>
                <input type="number" min={1} max={10} value={form.minAM} onChange={(e) => handleField('minAM', e.target.value)} className={inputClass} />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">Min PM</label>
                <input type="number" min={1} max={10} value={form.minPM} onChange={(e) => handleField('minPM', e.target.value)} className={inputClass} />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-content-muted uppercase tracking-wider block mb-1">Roster</label>
                <input type="number" min={1} max={50} value={form.totalRoster} onChange={(e) => handleField('totalRoster', e.target.value)} className={inputClass} />
              </div>
            </div>
            <button type="submit" disabled={!form.name.trim() || !form.id.trim() || saving}
              className="w-full bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white rounded-lg py-2 text-sm font-medium transition-colors">
              {saving ? 'Adding…' : 'Add Store'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Remove Store Modal ───────────────────────────────────────────────────────

function RemoveStoreModal({ store, onConfirm, onClose }) {
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [removing, setRemoving] = useState(false)

  async function handleConfirm() {
    if (pin !== DEFAULT_ADMIN_PIN) { setPinError('Incorrect PIN'); return }
    setRemoving(true)
    await onConfirm()
    setRemoving(false)
  }

  const inputClass = "w-full bg-surface-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-content-main placeholder-[#D8E8E2]/20 focus:outline-none focus:border-red-500/50"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-content-main">Remove Store</h2>
          <button onClick={onClose} className="text-content-muted hover:text-content-main transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="px-4 py-3 rounded-xl bg-red-900/10 border border-red-500/20">
            <p className="text-sm text-content-main font-medium">{store.name}</p>
            <p className="text-xs text-red-400/80 mt-1">
              This removes the store from the sidebar. Schedule data is preserved in Firestore.
            </p>
          </div>
          <input
            type="password"
            placeholder="Admin PIN to confirm"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            className={inputClass}
            autoFocus
          />
          {pinError && <p className="text-xs text-red-400">{pinError}</p>}
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-sm transition-colors">
              Cancel
            </button>
            <button onClick={handleConfirm} disabled={removing}
              className="flex-1 px-4 py-2 rounded-lg bg-red-900/40 hover:bg-red-900/60 disabled:opacity-50 text-red-300 text-sm font-medium transition-colors">
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Nav components ───────────────────────────────────────────────────────────

function NavButton({ id, label, icon, active, onClick }) {
  return (
    <button onClick={onClick}
      data-tour={id}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-sm ${
        active ? 'bg-brand-primary text-white' : 'text-content-muted hover:text-content-main hover:bg-surface-hover'
      }`}
    >
      <span className="flex-shrink-0 opacity-80">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function SearchIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )
}

function GridIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  )
}

function ChartIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function LogoutIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5m-9-6h.008v.008H12v-.008zM12 15h.008v.008H12V15zm0 2.25h.008v.008H12v-.008zM9.75 15h.008v.008H9.75V15zm0 2.25h.008v.008H9.75v-.008zM7.5 15h.008v.008H7.5V15zm0 2.25h.008v.008H7.5v-.008zm6.75-4.5h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V15zm0 2.25h.008v.008h-.008v-.008zm2.25-4.5h.008v.008H16.5v-.008zm0 2.25h.008v.008H16.5V15z" />
    </svg>
  )
}
