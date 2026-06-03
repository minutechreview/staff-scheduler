import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { StoresProvider, useStoresContext } from './contexts/StoresContext'
import { RamadanProvider } from './contexts/RamadanContext'
import { ThemeProvider } from './contexts/ThemeContext'
import Sidebar from './components/Sidebar'
import OverviewPage from './components/OverviewPage'
import SupportPoolPage from './components/SupportPoolPage'
import StoreView from './components/StoreView'
import SettingsPage from './components/SettingsPage'
import LoginPage from './components/LoginPage'
import OnboardingFlow from './components/OnboardingFlow'

const AnalyticsPage = lazy(() => import('./components/AnalyticsPage'))
const GlobalSearchPage = lazy(() => import('./components/GlobalSearchPage'))
const AorManagementPage = lazy(() => import('./components/AorManagementPage'))
const LeaveCalendarPage = lazy(() => import('./components/LeaveCalendarPage'))
import { AorProvider, useAor } from './contexts/AorContext'
import FeedbackButton from './components/FeedbackButton'

function AppInner({ user, setUser }) {
  const { role, storeId, isAuthenticated, loading: aorLoading, updateProfile, isDM } = useAor()
  
  const [onboardingDone, setOnboardingDone] = useState(() => {
    // Check if user already has a Firestore profile; if so, skip onboarding
    return isAuthenticated
  })

  const [currentView, setCurrentView] = useState('overview')
  const [isTouring, setIsTouring] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarHovered, setSidebarHovered] = useState(false)
  const sidebarVisible = sidebarOpen || sidebarHovered
  const { stores, loading: storesLoading } = useStoresContext()

  // Sync onboarding state with Firestore auth status
  useEffect(() => {
    if (!aorLoading && isAuthenticated) {
      setOnboardingDone(true)
    }
  }, [aorLoading, isAuthenticated])

  // Initialize view once stores are loaded
  useEffect(() => {
    if (stores && stores.length > 0 && currentView === 'overview') {
      const homeStore = localStorage.getItem('home_store')
      if (homeStore && stores.some(s => s.id === homeStore)) {
        setCurrentView(`store-${homeStore}`)
      }
    }
  }, [stores])

  function handleLogin(userData) {
    setUser(userData)
    localStorage.setItem('scheduler_user', JSON.stringify(userData))
  }

  function handleSignOut() {
    setUser(null)
    localStorage.removeItem('scheduler_user')
  }

  function handleOnboardingComplete() {
    setOnboardingDone(true)
    localStorage.setItem('onboarding_complete', '1')
  }

  // Show login if not authenticated in browser
  if (!user) {
    return (
      <>
        <LoginPage onLogin={handleLogin} />
        <FeedbackButton />
      </>
    )
  }

  // Show splash if searching for Firestore profile
  if (aorLoading) {
    return (
      <>
        <div className="h-screen bg-surface-root flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-4 border-[#006241]/20 border-t-[#006241] rounded-full animate-spin" />
          <p className="text-content-muted text-sm animate-pulse">Syncing profile...</p>
        </div>
        <FeedbackButton />
      </>
    )
  }

  // Show onboarding if no profile in Firestore OR touring
  if (!isAuthenticated || !onboardingDone || isTouring) {
    return (
      <>
        {/* Render the app underneath so tour spotlight targets exist */}
        <div className="flex h-screen bg-surface-root text-content-main overflow-hidden transition-colors">
          {/* Sidebar always visible for tour target */}
          <div className="flex flex-shrink-0">
            <Sidebar
              currentView={currentView}
              onNavigate={(v) => setCurrentView(v)}
              user={user}
              onSignOut={handleSignOut}
            />
          </div>
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <main className="flex-1 overflow-auto bg-surface-root">
              {renderContent(currentView, stores, setCurrentView)}
            </main>
          </div>
        </div>
        <OnboardingFlow 
          user={user} 
          onNavigate={setCurrentView} 
          onProfileSave={(profile) => {
            if (profile) updateProfile(profile)
            setIsTouring(true)
          }}
          onComplete={() => {
            handleOnboardingComplete()
            setIsTouring(false)
          }} 
        />
        <FeedbackButton />
      </>
    )
  }

  // After onboarding: SM with no store assigned → prompt to pick one
  if (isAuthenticated && !isDM && !storeId && onboardingDone) {
    return (
      <>
        <StorePickerPrompt user={user} onSignOut={handleSignOut} onSave={(profile) => updateProfile(profile)} />
        <FeedbackButton />
      </>
    )
  }

  function handleNavigate(view) {
    setCurrentView(view)
    setSidebarOpen(false)
  }

  return (
    <div className="flex h-screen bg-surface-root text-content-main overflow-hidden transition-colors">
      {/* Overlay - only for click-open (mobile/modal feel) */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/60" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Hover trigger strip - desktop hint */}
      <div
        className="fixed inset-y-0 left-0 z-40 w-3 hidden md:block"
        onMouseEnter={() => setSidebarHovered(true)}
      >
        <div className="absolute inset-y-0 left-0 w-px bg-border-subtle/40" />
      </div>

      <div className={`
        fixed inset-y-0 left-0 z-40
        transform transition-transform duration-200 ease-in-out
        ${sidebarVisible ? 'translate-x-0' : '-translate-x-full'}
      `}
        onMouseEnter={() => setSidebarHovered(true)}
        onMouseLeave={() => setSidebarHovered(false)}
      >
        <Sidebar
          currentView={currentView}
          onNavigate={handleNavigate}
          user={user}
          onSignOut={handleSignOut}
        />
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 bg-surface-panel border-b border-border-subtle flex-shrink-0">
          <button onClick={() => setSidebarOpen((v) => !v)} className="p-1.5 rounded-lg text-content-muted hover:text-content-main hover:bg-surface-hover transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <img src="/logo.png" alt="RetailCo" className="w-7 h-7 rounded-full object-cover" />
          <span className="text-sm font-semibold">Store Scheduler</span>
        </div>
        <main className="flex-1 overflow-auto bg-surface-root">
          {renderContent(currentView, stores, (v) => handleNavigate(v))}
        </main>
      </div>

      {/* Feedback button — accessible to everyone, no auth required */}
      <FeedbackButton />
    </div>
  )
}

function renderContent(currentView, stores, handleNavigate) {
  if (currentView === 'overview') return <OverviewPage onNavigate={handleNavigate} />
  if (currentView === 'support-pool') return <SupportPoolPage />
  if (currentView === 'analytics') return <Suspense fallback={<div className="flex items-center justify-center h-full text-content-muted text-sm">Loading…</div>}><AnalyticsPage /></Suspense>
  if (currentView === 'search') return <Suspense fallback={<div className="flex items-center justify-center h-full text-content-muted text-sm">Loading indices…</div>}><GlobalSearchPage /></Suspense>
  if (currentView === 'aor-manage') return <Suspense fallback={<div className="flex items-center justify-center h-full text-content-muted text-sm">Opening Area Management…</div>}><AorManagementPage /></Suspense>
  if (currentView === 'leave-calendar') return <Suspense fallback={<div className="flex items-center justify-center h-full text-content-muted text-sm">Loading calendar…</div>}><LeaveCalendarPage /></Suspense>
  if (currentView === 'settings') return <SettingsPage />

  if (currentView.startsWith('store-')) {
    const storeId = currentView.replace('store-', '')
    const store = stores.find((s) => s.id === storeId)
    if (store) return <StoreView store={store} />
  }

  return <OverviewPage onNavigate={handleNavigate} />
}

export default function App() {
  return (
    <ThemeProvider>
      <RamadanProvider>
        <AppWithAor />
      </RamadanProvider>
    </ThemeProvider>
  )
}

function AppWithAor() {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('scheduler_user')
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  })

  return (
    <AorProvider user={user}>
      <StoresProvider>
        <AppInner user={user} setUser={setUser} />
      </StoresProvider>
    </AorProvider>
  )
}

// Blocking prompt: shown when a Store Manager is authenticated but has no store assignment
function StorePickerPrompt({ user, onSignOut, onSave }) {
  const { stores } = useStoresContext()
  const { aorId } = useAor()
  const [selectedStore, setSelectedStore] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleContinue() {
    if (!selectedStore) return
    setSaving(true)
    try {
      await onSave({ storeId: selectedStore })
      localStorage.setItem('home_store', selectedStore)
    } finally {
      setSaving(false)
    }
  }

  const firstName = user?.displayName?.split(' ')[0] || 'there'

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-4"
      style={{
        background: 'linear-gradient(-45deg, #0A100D, #1E3932, #162118, #006241)',
        backgroundSize: '400% 400%',
        animation: 'aurora 15s ease infinite',
      }}
    >
      <div className="w-full max-w-md animate-card-enter">
        <div className="backdrop-blur-xl bg-white/[0.07] border border-white/[0.12] rounded-3xl p-8 shadow-2xl">
          
          <div className="flex items-center gap-3 mb-8">
            <img
              src={user?.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(firstName)}&background=006241&color=fff&size=48`}
              alt="" className="w-11 h-11 rounded-full border border-white/20 shadow-lg"
            />
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">Welcome back, {firstName}</h2>
              <p className="text-[10px] text-white/40 uppercase tracking-widest">{user?.email}</p>
            </div>
          </div>

          <div className="mb-6 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm text-amber-300">
              You don't have a store assigned yet. Please select your store to continue.
            </p>
          </div>

          <h3 className="text-white font-medium mb-1">Select Your Store</h3>
          <p className="text-sm text-white/40 mb-4">Choose the store you manage to unlock full scheduling access.</p>

          <div className="grid grid-cols-2 gap-2 max-h-[240px] overflow-y-auto mb-6 pr-1">
            {stores.length === 0 ? (
              <div className="col-span-2 py-6 text-center text-white/20 text-xs animate-pulse">Loading stores...</div>
            ) : stores.map(s => (
              <button
                key={s.id}
                onClick={() => setSelectedStore(s.id)}
                className={`text-left p-3 rounded-2xl border transition-all ${
                  selectedStore === s.id
                    ? 'bg-[#006241]/40 border-[#00704A] shadow-lg'
                    : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'
                }`}
              >
                <div className="text-xs font-semibold text-white truncate">{s.name}</div>
                <div className="text-[10px] text-white/30 mt-0.5">{s.type}</div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={onSignOut}
              className="text-white/30 hover:text-white/60 text-xs font-medium transition-colors underline decoration-white/10 underline-offset-4"
            >
              Sign Out
            </button>
            <button
              onClick={handleContinue}
              disabled={!selectedStore || saving}
              className={`px-6 py-2.5 rounded-xl text-white text-sm font-semibold flex items-center gap-2 transition-all ${
                selectedStore && !saving
                  ? 'btn-gradient'
                  : 'bg-white/10 opacity-50 cursor-not-allowed'
              }`}
            >
              {saving && <div className="w-4 h-4 border-2 border-t-transparent border-white rounded-full animate-spin" />}
              {saving ? 'Saving...' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
