import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useStoresContext } from '../contexts/StoresContext'
import { useStores } from '../hooks/useStores'

// ── Tour Steps Definition ──────────────────────────────────────────────
const TOUR_STEPS = [
  {
    target: 'overview',
    title: 'Cross-Store Overview',
    description: 'See all 16 stores at a glance. Check headcount, SIC coverage, and status for the entire week.',
    position: 'right',
    view: 'overview',
  },
  {
    target: 'analytics',
    title: 'Analytics Dashboard',
    description: 'Track leave utilization, support patterns, and SIC gaps across the last 12 weeks.',
    position: 'right',
    view: 'analytics',
  },
  {
    target: 'leave-calendar',
    title: 'Leave Calendar',
    description: 'Visualise your team\'s leave plans in a weekly, monthly, or yearly calendar. DMs see leave across all stores in their AOR at once.',
    position: 'right',
    view: 'leave-calendar',
  },
  {
    target: 'stores',
    title: 'Your Stores',
    description: 'Click any store to open its weekly schedule. Drag to reorder your list.',
    position: 'right',
    view: 'overview',
  },
  {
    target: 'actions',
    title: 'Navigate Weeks',
    description: 'Jump between weeks with the arrows. The schedule always opens to the current week.',
    position: 'bottom',
    view: 'store-home',
  },
  {
    target: 'actions',
    title: 'Quick Actions',
    description: 'Export PDF, manage staff, request support, auto-fill schedules, and more from here.',
    position: 'bottom',
    view: 'store-home',
  },
  {
    target: 'shift-cell',
    title: 'Tap to Schedule',
    description: 'Click any cell to assign a shift. Hold Ctrl/Cmd + click for multi-select. Drag across to bulk-fill.',
    position: 'bottom',
    view: 'store-home',
  },
  {
    target: 'settings',
    title: 'Settings & Directory',
    description: 'Manage store configs, browse the full staff directory, and review leave history.',
    position: 'right',
    view: 'settings',
  },
]

// ── Main Component ─────────────────────────────────────────────────────

// Configure admin/DM emails via environment variables or update these directly
const DM_EMAIL = import.meta.env.VITE_DM_EMAIL || ''
const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || ''

export default function OnboardingFlow({ user, onNavigate, onProfileSave, onComplete }) {
  const isDmUser = DM_EMAIL && user?.email === DM_EMAIL
  const isAdminUser = ADMIN_EMAIL && user?.email === ADMIN_EMAIL
  const [step, setStep] = useState('profile-setup') // 'profile-setup' | 'tour'
  const [setupStep, setSetupStep] = useState(isDmUser ? 'role' : isAdminUser ? 'aor' : 'aor') // 'role' | 'aor' | 'store'

  const [selectedRole, setSelectedRole] = useState(isDmUser ? null : isAdminUser ? 'ADMIN' : 'SM')
  const [selectedAor, setSelectedAor] = useState('MainDistrict') // Default AOR
  const [selectedStore, setSelectedStore] = useState(isAdminUser ? 'Store01' : null)
  
  const [tourStep, setTourStep] = useState(0)
  const { stores: aorStores, loading: aorStoresLoading } = useStores(selectedAor)

  // Auto-navigate during tour
  useEffect(() => {
    if (step !== 'tour') return
    
    const stepData = TOUR_STEPS[tourStep]
    if (!stepData?.view) return

    let targetView = stepData.view
    if (targetView === 'store-home') {
      const homeStore = localStorage.getItem('home_store')
      if (homeStore) targetView = `store-${homeStore}`
      else targetView = 'overview'
    }

    onNavigate?.(targetView)
  }, [step, tourStep, onNavigate])

  function handleProfileComplete() {
    const isAdmin = selectedRole === 'ADMIN'
    const storeId = isAdmin ? 'Store01' : selectedStore

    const profile = {
      role: selectedRole,
      aorId: selectedAor,
      storeId: storeId
    }

    if (isAdmin) {
      localStorage.setItem('home_store', 'Store01')
    }

    // Save profile now, so it's persisted even if they don't finish the tour
    onProfileSave(profile)
    setStep('tour')
  }

  function handleFinishAll() {
    localStorage.setItem('onboarding_complete', '1')
    // Just mark onboarding as done in state/localstorage
    onComplete() 
  }

  function handleTourNext() {
    if (tourStep >= TOUR_STEPS.length - 1) {
      handleFinishAll()
    } else {
      setTourStep((s) => s + 1)
    }
  }

  function handleTourBack() {
    if (tourStep > 0) setTourStep((s) => s - 1)
  }

  // Keyboard navigation
  useEffect(() => {
    if (step !== 'tour') return
    function handleKey(e) {
      if (e.key === 'Escape') handleFinishAll()
      if (e.key === 'ArrowRight' || e.key === 'Enter') handleTourNext()
      if (e.key === 'ArrowLeft') handleTourBack()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [step, tourStep])

  if (step === 'profile-setup') {
    return (
      <ProfileSelector 
        user={user}
        stores={aorStores}
        storesLoading={aorStoresLoading}
        setupStep={setupStep}
        setSetupStep={setSetupStep}
        role={selectedRole}
        setRole={setSelectedRole}
        aor={selectedAor}
        setAor={setSelectedAor}
        store={selectedStore}
        setStore={setSelectedStore}
        onComplete={handleProfileComplete}
        onSkip={() => handleFinishAll()}
      />
    )
  }

  return (
    <TourOverlay
      step={tourStep}
      total={TOUR_STEPS.length}
      tourData={TOUR_STEPS[tourStep]}
      onNext={handleTourNext}
      onBack={handleTourBack}
      onSkip={handleFinishAll}
    />
  )
}

// ── Profile Selector ───────────────────────────────────────────────────

function ProfileSelector({ user, stores, storesLoading, setupStep, setSetupStep, role, setRole, aor, setAor, store, setStore, onComplete, onSkip }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { requestAnimationFrame(() => setMounted(true)) }, [])

  const firstName = user?.displayName?.split(' ')[0] || 'there'
  const isDmUser = user?.email === DM_EMAIL
  const isAdminUser = user?.email === ADMIN_EMAIL

  // AORs list (update these to match your organization's districts/areas)
  const AORS = [
    { id: 'MainDistrict', name: 'Main District', region: 'Region 1' },
    { id: 'EastDistrict', name: 'East District', region: 'Region 1' },
    { id: 'WestDistrict', name: 'West District', region: 'Region 2' },
  ]

  const stepIndicators = isDmUser ? ['role', 'aor', 'store'] : isAdminUser ? ['aor'] : ['aor', 'store']

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{
        background: 'linear-gradient(-45deg, #0A100D, #1E3932, #162118, #006241)',
        backgroundSize: '400% 400%',
        animation: 'aurora 15s ease infinite',
      }}
    >
      <div className={`w-full max-w-lg transition-all duration-700 ${mounted ? 'animate-card-enter' : 'opacity-0'}`}>
        <div className="backdrop-blur-xl bg-white/[0.07] border border-white/[0.12] rounded-3xl p-8 shadow-2xl">
          
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <img
                src={user?.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(firstName)}&background=006241&color=fff&size=48`}
                alt="" className="w-11 h-11 rounded-full border border-white/20 shadow-lg"
              />
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">Setup Profile</h2>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">{user?.email}</p>
              </div>
            </div>
            
            {/* Step Indicators */}
            <div className="flex gap-1">
              {stepIndicators.map(s => (
                <div key={s} className={`h-1 w-4 rounded-full transition-colors ${setupStep === s ? 'bg-[#00704A]' : 'bg-white/10'}`} />
              ))}
            </div>
          </div>

          {/* STEP 1: ROLE */}
          {setupStep === 'role' && isDmUser && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
              <h3 className="text-white font-medium mb-1">Assing your role</h3>
              <p className="text-sm text-white/40 mb-6">Determine your access level across the region.</p>
              
              <div className="grid grid-cols-1 gap-3 mb-8">
                <button
                  onClick={() => { setRole('DM'); setSetupStep('aor') }}
                  className={`flex items-center gap-4 p-4 rounded-2xl border transition-all ${
                    role === 'DM' ? 'bg-[#006241]/40 border-[#00704A] shadow-lg' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'
                  }`}
                >
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-500">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                  </div>
                  <div className="text-left">
                    <div className="text-white font-semibold">District Manager</div>
                    <div className="text-[10px] text-white/40">Full access to an entire Area (AOR)</div>
                  </div>
                </button>

                <button
                  onClick={() => { setRole('SM'); setSetupStep('aor') }}
                  className={`flex items-center gap-4 p-4 rounded-2xl border transition-all ${
                    role === 'SM' ? 'bg-[#006241]/40 border-[#00704A] shadow-lg' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'
                  }`}
                >
                  <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-500">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                  </div>
                  <div className="text-left">
                    <div className="text-white font-semibold">Store Manager</div>
                    <div className="text-[10px] text-white/40">Assigned to a specific home store</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: AOR */}
          {setupStep === 'aor' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
              <h3 className="text-white font-medium mb-1">Select your Area</h3>
              <p className="text-sm text-white/40 mb-6">Choose the district you manage or work within.</p>
              
              <div className="grid grid-cols-1 gap-2 max-h-[280px] overflow-y-auto mb-8 pr-1">
                {AORS.map(area => (
                  <button
                    key={area.id}
                    onClick={() => { setAor(area.id); role === 'SM' ? setSetupStep('store') : onComplete() }}
                    className={`flex items-center justify-between p-4 rounded-2xl border transition-all ${
                      aor === area.id ? 'bg-[#006241]/40 border-[#00704A]' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'
                    }`}
                  >
                    <div className="text-left">
                      <div className="text-xs font-semibold text-white">{area.name}</div>
                      <div className="text-[10px] text-white/30">{area.region}</div>
                    </div>
                    {aor === area.id && <svg className="w-5 h-5 text-[#00704A]" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>}
                  </button>
                ))}
              </div>
              
              {isDmUser && (
                <button onClick={() => setSetupStep('role')} className="text-white/30 hover:text-white/60 text-xs font-medium transition-colors underline decoration-white/10 underline-offset-4">← Back to role</button>
              )}
            </div>
          )}

          {/* STEP 3: STORE */}
          {setupStep === 'store' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
              <h3 className="text-white font-medium mb-1">Assign Home Store</h3>
              <p className="text-sm text-white/40 mb-6">Select your primary store location in {aor}.</p>
              
              <div className="grid grid-cols-2 gap-2 max-h-[280px] overflow-y-auto mb-8 pr-1">
                {storesLoading ? (
                  <div className="col-span-2 py-8 text-center text-white/20 text-xs animate-pulse">Loading stores...</div>
                ) : stores.length === 0 ? (
                  <div className="col-span-2 py-8 text-center text-white/20 text-xs italic">No stores found in this area.</div>
                ) : stores.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setStore(s.id)}
                    className={`text-left p-3 rounded-2xl border transition-all ${
                      store === s.id ? 'bg-[#006241]/40 border-[#00704A]' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'
                    }`}
                  >
                    <div className="text-xs font-semibold text-white truncate">{s.name}</div>
                    <div className="text-[10px] text-white/30 mt-0.5">{s.type}</div>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <button onClick={() => setSetupStep('aor')} className="text-white/30 hover:text-white/60 text-xs font-medium transition-colors underline decoration-white/10 underline-offset-4">← Back to Area</button>
                <button 
                  onClick={onComplete}
                  disabled={!store}
                  className={`px-6 py-2 rounded-xl text-white text-sm font-semibold transition-all ${
                    store ? 'bg-[#006241] hover:bg-[#00704A] shadow-lg shadow-[#006241]/30' : 'bg-white/10 opacity-50 cursor-not-allowed'
                  }`}
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {setupStep === 'role' && (
            <div className="mt-8 pt-8 border-t border-white/10 flex justify-center">
              <button onClick={onSkip} className="text-white/20 hover:text-white/50 text-[10px] uppercase tracking-widest transition-colors">Skip Setup & Use Guest Mode</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Tour Overlay ───────────────────────────────────────────────────────

function TourOverlay({ step, total, tourData, onNext, onBack, onSkip }) {
  const [targetRect, setTargetRect] = useState(null)
  const [tooltipStyle, setTooltipStyle] = useState({})
  const overlayRef = useRef(null)

  const recalculate = useCallback(() => {
    // We use a small delay/retry to ensure the DOM has settled, 
    // especially after a page navigation.
    const findAndSet = (retryCount = 0) => {
      const el = document.querySelector(`[data-tour="${tourData.target}"]`)
      if (!el) {
        if (retryCount < 5) {
          requestAnimationFrame(() => findAndSet(retryCount + 1))
        } else {
          setTargetRect(null)
        }
        return
      }
      const rect = el.getBoundingClientRect()
      setTargetRect({
        top: rect.top - 8,
        left: rect.left - 8,
        width: rect.width + 16,
        height: rect.height + 16,
      })

      // Position tooltip logic below...
      const pad = 16
      const tooltipW = 320
      const tooltipH = 180
      let top, left

      if (tourData.position === 'right') {
        top = Math.max(pad, rect.top)
        left = rect.right + pad
        if (left + tooltipW > window.innerWidth - pad) {
          left = rect.left - tooltipW - pad
        }
      } else if (tourData.position === 'bottom') {
        top = rect.bottom + pad
        left = Math.max(pad, rect.left)
        if (top + tooltipH > window.innerHeight - pad) {
          top = rect.top - tooltipH - pad
        }
      } else {
        top = rect.bottom + pad
        left = rect.left
      }

      left = Math.max(pad, Math.min(left, window.innerWidth - tooltipW - pad))
      top = Math.max(pad, Math.min(top, window.innerHeight - tooltipH - pad))

      setTooltipStyle({ top, left, width: tooltipW })
    }

    findAndSet()
  }, [tourData])

  useEffect(() => {
    recalculate()
    window.addEventListener('resize', recalculate)
    window.addEventListener('scroll', recalculate, true)
    return () => {
      window.removeEventListener('resize', recalculate)
      window.removeEventListener('scroll', recalculate, true)
    }
  }, [recalculate])

  // Build clip-path to create spotlight hole
  const clipPath = targetRect
    ? `polygon(
        0% 0%, 0% 100%, 
        ${targetRect.left}px 100%, 
        ${targetRect.left}px ${targetRect.top}px, 
        ${targetRect.left + targetRect.width}px ${targetRect.top}px, 
        ${targetRect.left + targetRect.width}px ${targetRect.top + targetRect.height}px, 
        ${targetRect.left}px ${targetRect.top + targetRect.height}px, 
        ${targetRect.left}px 100%, 
        100% 100%, 100% 0%
      )`
    : 'none'

  return createPortal(
    <div ref={overlayRef} className="fixed inset-0 z-[200] tour-spotlight">
      {/* Dark overlay with spotlight hole */}
      <div
        className="absolute inset-0 bg-black/70 transition-all duration-300"
        style={{ clipPath }}
        onClick={onSkip}
      />

      {/* Spotlight ring glow */}
      {targetRect && (
        <div
          className="absolute border-2 border-[#00704A] rounded-xl pointer-events-none transition-all duration-300"
          style={{
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
            boxShadow: '0 0 0 4px rgba(0, 112, 74, 0.3), 0 0 30px rgba(0, 98, 65, 0.4)',
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        className="absolute animate-tooltip-enter"
        style={tooltipStyle}
      >
        <div className="bg-surface-panel border border-border-subtle rounded-2xl shadow-2xl p-5">
          {/* Step indicator */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] text-white/30 uppercase tracking-widest font-semibold">
              Step {step + 1} of {total}
            </span>
            <button
              onClick={onSkip}
              className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
            >
              Skip All
            </button>
          </div>

          {/* Content */}
          <h3 className="text-base font-semibold text-white mb-1.5">{tourData.title}</h3>
          <p className="text-sm text-white/50 leading-relaxed mb-5">{tourData.description}</p>

          {/* Progress dots + nav */}
          <div className="flex items-center justify-between">
            <div className="flex gap-1.5">
              {Array.from({ length: total }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === step ? 'w-4 bg-[#00704A]' : i < step ? 'w-1.5 bg-[#00704A]/50' : 'w-1.5 bg-white/10'
                  }`}
                />
              ))}
            </div>
            <div className="flex gap-2">
              {step > 0 && (
                <button
                  onClick={onBack}
                  className="px-3 py-1.5 rounded-lg text-xs text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-colors"
                >
                  ← Back
                </button>
              )}
              <button
                onClick={onNext}
                className="px-4 py-1.5 rounded-lg bg-[#006241] hover:bg-[#00704A] text-white text-xs font-semibold transition-all hover:shadow-lg hover:shadow-[#006241]/30"
              >
                {step >= total - 1 ? 'Get Started' : 'Next →'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Keyboard hint */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex gap-2 text-[10px] text-white/20">
        <kbd className="px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.03]">←</kbd>
        <kbd className="px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.03]">→</kbd>
        <span className="ml-1">navigate</span>
        <kbd className="px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.03] ml-2">Esc</kbd>
        <span>skip</span>
      </div>
    </div>,
    document.body
  )
}
