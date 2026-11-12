import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowLeft, CalendarDays, ChartNoAxesCombined, Check, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Clock3, Globe2, Layers3, LayoutDashboard, LogOut, Plus, Search, Settings2, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react'
import { ShiftCard, ScheduleMenu, RepeatShiftForm } from './ScheduleInteractions'
import { emptyDraftHistory, canTravelDraft, rememberDraft, travelDraft } from './draftHistory.mjs'
import { adjustShift, shiftTemplate, pasteShift, duplicateExists } from './scheduleEditing.mjs'
import { scheduleRows, filterScheduleRows } from './scheduleGrid.mjs'
import { installLandingMotion } from './motion'
import EmailAction from './EmailAction'
import { parseEmailAction } from './emailActions.mjs'
import schedulerPlans from './scheduler-plans.json'
import { api, clock, dateLabel, dayPlus, duration, firstDay, formData, localDate, today, setAcceptanceSecret } from './api'

function formatPlanPrice(plan) {
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency })
  return formatter.format(plan.amount_minor / 10 ** formatter.resolvedOptions().maximumFractionDigits)
}

async function openBillingProvider(path, body) {
  const result = await api(path, body)
  const url = new URL(result.url)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.lemonsqueezy.com') || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Billing link is unavailable.')
  window.location.assign(url.href)
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Administrator', area_manager: 'Area manager', branch_manager: 'Branch manager', employee: 'Employee' }
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const NAV = [['schedule', CalendarDays, 'Schedule'], ['overview', LayoutDashboard, 'Overview'], ['people', UsersRound, 'People'], ['requests', CheckCheck, 'Requests'], ['demand', ChartNoAxesCombined, 'Demand & labor'], ['insights', Layers3, 'Insights'], ['assistant', Sparkles, 'Assistant'], ['settings', Settings2, 'Settings'], ['account', ShieldCheck, 'Account']]

function Brand({ light = false }) {
  return <span className={`brand ${light ? 'light' : ''}`}><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>relay<span className="brand-dot">.</span></span>
}

function Button({ children, primary, ...props }) {
  return <button className={`button ${primary ? 'primary' : ''}`} {...props}>{children}</button>
}

function Field({ label, children, ...props }) {
  const id = useId()
  return <label className="field" htmlFor={id}><span>{label}</span>{children ? cloneElement(children, { id, 'aria-label': label }) : <input id={id} {...props} />}</label>
}

function AvailabilityFields({ initial }) {
  const [windows, setWindows] = useState(() => Object.fromEntries(WEEKDAYS.map((_, i) => [String(i), (initial?.[i]?.length ? initial[i] : [{ start: '08:00', end: '22:00' }]).map((window, key) => ({ ...window, key }))])))
  return <fieldset className="availability-fields"><legend>Weekly availability</legend><p className="help">Enable each available day and enter local time windows. An end before the start continues into the following day.</p>{WEEKDAYS.map((day, i) => <div className="availability-day" key={day}><label className="check-field"><input type="checkbox" name={`available_${i}`} defaultChecked={initial ? Boolean(initial[i]?.length) : true} />{day}</label><div>{windows[i].map((w, j) => <div className="availability-window" key={w.key}><Field label={`${day} start ${j + 1}`} name={`window_${i}_${j}_start`} type="time" defaultValue={w.start} required /><span>to</span><Field label={`${day} end ${j + 1}`} name={`window_${i}_${j}_end`} type="time" defaultValue={w.end} required />{j > 0 && <button type="button" className="icon-button" aria-label={`Remove ${day} window ${j + 1}`} onClick={() => setWindows(previous => ({ ...previous, [i]: previous[i].filter((_, index) => index !== j) }))}><X size={16} /></button>}</div>)}<button type="button" className="text-button" disabled={windows[i].length >= 8} onClick={() => setWindows(previous => ({ ...previous, [i]: [...previous[i], { start: '08:00', end: '22:00', key: Math.max(...previous[i].map(window => window.key)) + 1 }] }))}><Plus size={14} />Add window</button></div></div>)}</fieldset>
}

function readAvailability(fields) {
  const result = {}
  for (let i = 0; i < 7; i++) {
    result[i] = []
    if (fields[`available_${i}`] === 'on') {
      for (let j = 0; j < 8; j++) if (fields[`window_${i}_${j}_start`]) result[i].push({ start: fields[`window_${i}_${j}_start`], end: fields[`window_${i}_${j}_end`] })
    }
  }
  return result
}

function CoverageFields({ initial }) {
  const [rules, setRules] = useState(() => initial.map((rule, key) => ({ ...rule, key })))
  return <div className="coverage-fields">{rules.map((r, i) => <div className="coverage-rule" key={r.key}><div className="form-grid"><Field label={`Coverage role ${i + 1}`} name={`coverage_${i}_role`} defaultValue={r.role} required /><Field label={`Required people ${i + 1}`} name={`coverage_${i}_required`} type="number" min="1" max="100" defaultValue={r.required} required /><Field label={`Coverage start ${i + 1}`} name={`coverage_${i}_start`} type="time" defaultValue={r.start} required /><Field label={`Coverage end ${i + 1}`} name={`coverage_${i}_end`} type="time" defaultValue={r.end} required /></div><div className="day-options">{WEEKDAYS.map((day, d) => <label key={day}><input type="checkbox" name={`coverage_${i}_day_${d}`} defaultChecked={(r.days || [0, 1, 2, 3, 4, 5, 6]).includes(d)} />{day.slice(0, 3)}</label>)}</div>{rules.length > 1 && <Button type="button" onClick={() => setRules(old => old.filter((_, index) => index !== i))}>Remove window</Button>}</div>)}<Button type="button" disabled={rules.length >= 20} onClick={() => setRules(old => [...old, { start: '09:00', end: '17:00', role: 'associate', required: 1, key: Math.max(...old.map(rule => rule.key)) + 1 }])}><Plus size={16} />Add coverage window</Button></div>
}

function readCoverage(fields) {
  const result = []
  for (let i = 0; i < 20; i++) if (fields[`coverage_${i}_role`]) result.push({ role: fields[`coverage_${i}_role`], required: Number(fields[`coverage_${i}_required`]), start: fields[`coverage_${i}_start`], end: fields[`coverage_${i}_end`], days: WEEKDAYS.map((_, d) => d).filter(d => fields[`coverage_${i}_day_${d}`] === 'on') })
  return result
}

function Empty({ title, children }) {
  return <div className="empty"><CalendarDays size={28} /><h2>{title}</h2><p>{children}</p></div>
}

function Stat({ label, value, note, warning }) {
  return <div className={`stat ${warning ? 'warning' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
}

function Dialog({ title, children, onClose, error, onDismissError, returnFocus, focusFallback }) {
  const titleId = useId()
  const ref = useRef(null)
  useEffect(() => {
    const node = ref.current
    node.showModal()
    return () => {
      node.close()
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return
        const target = returnFocus?.isConnected && !returnFocus.disabled ? returnFocus
          : focusFallback?.isConnected ? focusFallback.querySelector('button:not(:disabled), input:not(:disabled)')
            : document.querySelector('.main-content h1, main h2')
        if (target) { if (!target.matches('button, input, select, a, [tabindex]')) target.tabIndex = -1; target.focus({ preventScroll: true }) }
      })
    }
  }, [returnFocus, focusFallback])
  return <dialog ref={ref} onCancel={onClose} className="dialog" aria-labelledby={titleId}><div className="dialog-header"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{error && <div role="alert" className="dialog-error"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={onDismissError}><X size={18} /></button></div>}{children}</dialog>
}

function Landing({ navigate, customerMode }) {
  const root = useRef(null)
  useEffect(() => {
    return installLandingMotion(root.current)
  }, [])
  return <div className="landing" ref={root}>
    <header className="landing-nav"><Brand /><nav aria-label="Website"><a href="#how">How it works</a><a href="#features">Features</a><Button onClick={() => navigate('signin')}>Sign in</Button><Button primary onClick={() => navigate('signup')}>Start your workspace <ArrowRight size={16} /></Button></nav></header>
    <main>
    <section className="hero">
      <div className="hero-copy"><span className="release-pill"><span />{customerMode ? "Plan together, week by week" : "Local release candidate · synthetic demo"}</span><h1>A better week.<br /><span>For every team.</span></h1><p>Bring people, demand, and decisions into one clear schedule. Plan across locations, resolve the gaps, and give everyone a week they can count on.</p><div className="hero-actions"><Button primary onClick={() => navigate('signup')}>Build your first week <ArrowRight size={18} /></Button><a href="#how">Explore the workflow <ChevronRight size={18} /></a></div><div className="hero-proof"><ShieldCheck size={19} /><span>Scoped access. Reviewed drafts. A clear history.</span></div></div>
      <div className="hero-product" role="group" aria-label="Example schedule with fictional employees"><div className="preview-bar"><Brand /><span>Northbank · Weekly schedule</span><span className="status">Draft</span></div><div className="preview-heading"><h2>Your team. In sync.</h2><span>12–18 Oct</span></div><table className="preview-table"><thead><tr><th>Team member</th>{['Mon', 'Tue', 'Wed', 'Thu'].map(d => <th key={d}>{d}</th>)}</tr></thead><tbody>{['Alex Morgan', 'Sam Rivera', 'Jules Park', 'Casey Reed', 'Robin Hayes'].map((name, i) => <tr key={name}><th><span className="avatar">{name[0]}{name.split(' ')[1][0]}</span>{name}</th>{[0, 1, 2, 3].map(d => <td key={d}><span className={`preview-shift ${(i + d) % 4 === 0 ? 'off' : i < 2 ? 'lead' : ''}`}>{(i + d) % 4 === 0 ? 'Day off' : '09:00 – 17:00'}<small>{(i + d) % 4 === 0 ? 'Unassigned' : i < 2 ? 'Team lead' : 'Associate'}</small></span></td>)}</tr>)}</tbody></table><div className="preview-note"><div><Check size={18} /><span>People first. Constraints respected.</span></div><span>Review → Publish</span></div><div className="floating-note"><span className="notification-dot" /><div><strong>Know where you stand</strong><span>Interval coverage, not guesswork.</span></div></div></div>
    </section>
    <div className="feature-strip"><span><Globe2 size={19} />Many locations. One workspace.</span><span><UsersRound size={19} />The right access for every role.</span><span><Clock3 size={19} />Local time. Clear boundaries.</span></div>
    <section id="how" className="how"><div><span className="section-label">FROM PLAN TO PUBLISHED</span><h2>A workflow that<br />keeps people in the loop.</h2><p>Automation proposes a feasible draft. Your team makes the decision.</p></div><ol><li><span>01</span><div><h3>Start with the real picture</h3><p>Set your locations, coverage, working rules, availability, and leave. Add demand when you have it.</p></div></li><li><span>02</span><div><h3>Build, explain, refine</h3><p>Generate a draft with hard constraints. See unfilled roles and why they remain open. Review every change.</p></div></li><li><span>03</span><div><h3>Publish with confidence</h3><p>Acknowledge remaining gaps. Employees see the published week; managers keep a version history.</p></div></li></ol></section>
    <section id="features" className="feature-section"><h2>The details that make a week work.</h2><div className="feature-grid">{[['Coverage with context', 'See required versus scheduled staffing by role, interval, and branch.'], ['Support with permission', 'Request another branch’s help, secure approval, and prevent overlapping assignments.'], ['Time off, accounted for', 'Review leave requests, configured allowances, and availability before shifts are assigned.'], ['Demand without assumptions', 'Import actuals or forecasts and configure transactions per labor hour. Coarse data stays coarse.'], ['One clear source of truth', 'Server-enforced scopes and versioned data keep access and edits accountable.'], ['Answers you can trace', 'Ask operational questions with a stated source, date range, scope, and freshness.']].map(([h, p]) => <article key={h}><h3>{h}</h3><p>{p}</p></article>)}</div></section>
    {schedulerPlans.length > 0 && <section id="pricing" className="feature-section"><h2>Plans for your team.</h2><div className="feature-grid">{schedulerPlans.map(plan => <article key={plan.id}><h3>{plan.name}</h3><p>{formatPlanPrice(plan)} / {plan.interval}</p><p>Up to {plan.max_branches} branches and {plan.max_active_staff} active staff.</p>{plan.trial_days > 0 && <p>{plan.trial_days}-day free trial.{plan.trial_card_required === false ? " No card required." : ""}</p>}<p>Checkout is not yet available.</p></article>)}</div></section>}
    <section className="landing-cta"><img className="rhythm-art" src="/team-rhythm.jpg" width="1200" height="800" loading="lazy" decoding="async" alt="" /><div><h2>Give your next week<br />a clearer starting point.</h2><p>{customerMode ? "Build schedules around your team and their availability." : "No external accounts or paid services needed for this local candidate."}</p></div><Button onClick={() => navigate('signup')}>{customerMode ? "Create a workspace" : "Create a local workspace"} <ArrowRight size={20} /></Button></section>
    </main>
    <footer><Brand />{customerMode ? <span>Thoughtful scheduling for your team.</span> : <><span>Local-first release candidate. Production integration and security review remain required.</span><a href="/release-notes.html">Release status</a></>}<a href="/third-party-notices.html">Licence notices</a></footer>
  </div>
}

function Auth({ mode, navigate, onAuthenticated, busy, run }) {
  const signup = mode === 'signup'
  const recovery = mode === 'recovery'
  const [verification, setVerification] = useState(null)
  const [capabilities, setCapabilities] = useState(null)
  const [recoveryCode, setRecoveryCode] = useState(() => new URLSearchParams(window.location.search).get('oobCode') || '')
  const [enterCode, setEnterCode] = useState(Boolean(recoveryCode))
  const [recoveryMessage, setRecoveryMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api('/capabilities', undefined, controller.signal).then(setCapabilities).catch(() => {})
    return () => controller.abort()
  }, [])
  return <div className="auth-page"><aside className="auth-story" aria-label="About Relay"><a href="#" onClick={() => navigate('landing')}><Brand light /></a><h1>Good weeks<br />start with<br /><span>clear plans.</span></h1><p>One workspace for your people, locations, and the decisions that connect them.</p><div className="auth-caption"><Layers3 size={25} /><span>{capabilities?.synthetic_only === false ? <>Secure account access.<br />Your team, in one place.</> : <>Server-backed accounts.<br />Synthetic release candidate.</>}</span></div></aside><main className="auth-form"><button className="text-button" onClick={() => navigate('landing')}><ArrowLeft size={16} />Back to Relay</button><span className="section-label">YOUR WORKSPACE</span><h2>{recovery ? 'Recover your access.' : signup ? 'Let’s build a better week.' : 'Welcome back.'}</h2><p>{recovery ? 'Use a recovery code to set a new password. Previous sessions will be signed out.' : signup ? 'Create an organization, then configure its locations and rules.' : 'Sign in to your Relay workspace.'}</p>{recovery ? <form onSubmit={e => { const d = formData(e); if (capabilities?.signup_invite_required) setAcceptanceSecret(String(d.enrollment_code || '')); run(async () => { const result = await api(enterCode ? '/recovery/complete' : '/recovery/request', d); setRecoveryMessage(result.message || 'Password updated. Sign in with your new password.'); if (enterCode) { window.history.replaceState(null, '', window.location.pathname); setRecoveryCode(''); navigate('signin') } }) }}>
    {enterCode ? <><Field label="Recovery code" name="code" value={recoveryCode} onChange={e => setRecoveryCode(e.target.value)} maxLength={1024} required autoComplete="off" /><Field label="New password" name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" /></> : <><Field label="Email" name="email" type="email" required autoComplete="username" /></>}{capabilities?.signup_invite_required && <Field label="Acceptance access code" name="enrollment_code" type="password" autoComplete="off" minLength={64} maxLength={64} required />}
    <Button primary disabled={busy}>{busy ? 'Please wait…' : enterCode ? 'Reset password' : 'Request recovery'}</Button><button className="text-button" type="button" onClick={() => setEnterCode(v => !v)}>{enterCode ? 'Request a fresh code' : 'Enter a recovery code'}</button><p className="help">{capabilities?.synthetic_only === false ? 'If eligible, recovery instructions will be sent to your email.' : 'Local emulators keep recovery instructions in their test inbox. Live delivery remains disabled until approved.'}</p>
  </form> : <form onSubmit={e => { const d = formData(e); if (capabilities?.signup_invite_required) setAcceptanceSecret(String(d.enrollment_code || '')); run(async () => { const result = await api(signup ? '/signup' : '/signin', d); if (result.verification_required) setVerification(result); else await onAuthenticated(result) }) }}>
    {signup && <><Field label="Your name" name="name" required autoComplete="name" /><Field label="Organization name" name="organization" required /></>}
    {capabilities?.signup_invite_required && <Field label="Acceptance access code" name="enrollment_code" type="password" autoComplete="off" minLength={64} maxLength={64} required />}<Field label="Email" name="email" type="email" required autoComplete="username" /><Field label="Password" name="password" type="password" minLength={12} maxLength={128} required autoComplete={signup ? 'new-password' : 'current-password'} />
    <p className="help">{signup ? (capabilities?.synthetic_only === false ? 'Use at least 12 characters. After verification, choose a fresh password from the setup email.' : 'Use at least 12 characters. Account creation does not send an email.') : 'Use your account password.'}</p><Button primary disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create workspace' : 'Sign in'}<ArrowRight size={16} /></Button>
  </form>}{recoveryMessage && <p role="status">{recoveryMessage}</p>}{verification && <div className="inline-warning" role="status"><strong>{capabilities?.synthetic_only === false ? 'Check your email before signing in.' : 'Verify your synthetic email before signing in.'}</strong><p>{verification.message}</p>{verification.local_verification_url && <a href={verification.local_verification_url} target="_blank" rel="noreferrer">Open local verification link</a>}<p><button className="text-button" onClick={() => { setVerification(null); navigate('signin') }}>Email verified — sign in</button></p></div>}{!signup && !recovery && capabilities?.recovery && <button className="text-button" onClick={() => navigate('recovery')}>Forgot your password?</button>}<p className="auth-switch">{recovery ? 'Ready to return?' : signup ? 'Already have a workspace?' : 'New to Relay?'} <button className="text-button" onClick={() => navigate(recovery || signup ? 'signin' : 'signup')}>{recovery || signup ? 'Sign in' : 'Create an organization'}</button></p></main></div>
}

function BranchFields({ initial = {}, policy, hierarchy }) {
  return <div className="form-grid"><Field label="Branch name" name="name" defaultValue={initial.name || ''} required />{hierarchy?.areas.length ? <Field label="Area"><select name="area_id" defaultValue={initial.area_id} required>{hierarchy.areas.map(a => { const market = hierarchy.markets.find(m => m.id === a.parent); const country = hierarchy.countries.find(c => c.id === market?.parent); return <option key={a.id} value={a.id}>{country?.name} / {market?.name} / {a.name}</option> })}</select></Field> : <><Field label="Country" name="country" defaultValue={initial.country || ''} required /><Field label="Market / city" name="market" defaultValue={initial.market || ''} required /><Field label="Area" name="area" defaultValue={initial.area || ''} required /></>}<Field label="Branch timezone" name="timezone" defaultValue={initial.timezone || policy.timezone} required /><Field label="Minimum associates" name="required" type="number" min="1" max="100" defaultValue={initial.coverage?.[0]?.required || 2} required /><Field label="Coverage start" name="start" type="time" defaultValue={initial.coverage?.[0]?.start || '09:00'} required /><Field label="Coverage end" name="end" type="time" defaultValue={initial.coverage?.[0]?.end || '17:00'} required /></div>
}

function Onboarding({ data, run, refresh, busy }) {
  return <div className="onboarding"><span className="section-label">WORKSPACE SETUP</span><h1>Make it your organization.</h1><p>Start with one branch. Country, market, and area organize your locations; roles govern who can access them.</p><div className="onboarding-layout"><section className="panel"><h2>Your first branch</h2><form onSubmit={e => { const d = formData(e); run(async () => { await api('/branches', { ...d, coverage: [{ role: 'associate', required: Number(d.required), start: d.start, end: d.end }] }); await refresh() }) }}><BranchFields policy={data.settings} /><Button primary disabled={busy}>Create branch <ArrowRight size={16} /></Button></form></section><aside className="demo-setup"><span className="demo-art"><UsersRound size={40} /></span><h2>Explore with a fictional team.</h2><p>Three branches and 24 clearly synthetic employees. No previous staff or customer records are imported.</p><Button disabled={busy} onClick={() => run(async () => { await api('/demo', {}); await refresh() })}>Set up synthetic demo</Button><p className="help">You can also start empty and add your own local test records.</p></aside></div></div>
}

function BillingRequired({ user, run, busy, onRefresh, onSignout }) {
  const owner = user.role === 'owner'
  const [billing, setBilling] = useState(null)
  const [loadError, setLoadError] = useState('')
  useEffect(() => { const controller = new AbortController(); api('/billing', undefined, controller.signal).then(setBilling).catch(error => { if (error.name !== 'AbortError') setLoadError('Billing details are unavailable. Try again later.') }); return () => controller.abort() }, [])
  const trialExpired = billing?.status === 'trial_expired'
  const trialUnavailable = billing?.status === 'trial_unavailable'
  return <main className="auth-page">
    <aside className="auth-story"><Brand light /><h1>Your workspace<br />is waiting.</h1><p>Your team’s data remains in your workspace.</p></aside>
    <section className="auth-form">
      <span className="section-label">WORKSPACE ACCESS</span>
      <h2>{trialExpired ? 'Your 7-day trial has ended.' : trialUnavailable ? 'Review your workspace access.' : 'Review your subscription.'}</h2>
      <p>{trialUnavailable ? 'Your trial could not be verified. Please contact support.' : owner ? 'Your workspace needs an active subscription.' : 'Please ask your organization owner to review the subscription.'}</p>
      {billing?.automatic_charge === false && <p>You will not be charged automatically.</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {owner && billing && <>
        <p>Billing status: {billing.status.replaceAll('_',' ')}.</p>
        {billing.checkout_available ? billing.plans.map(plan => <div key={plan.id}><p>{plan.name} · {formatPlanPrice(plan)} / {plan.interval}</p><Button disabled={busy} onClick={() => run(() => openBillingProvider('/billing/checkout',{plan:plan.id}))}>Choose {plan.name}</Button></div>) : !billing.portal_available && <p>Checkout is not available yet. Please check back later.</p>}
        {billing.portal_available && <Button disabled={busy} onClick={() => run(() => openBillingProvider('/billing/portal',{}))}>Manage subscription</Button>}
      </>}
      {owner && <Button disabled={busy} onClick={() => run(onRefresh)}>Check access again</Button>}
      <Button disabled={busy} onClick={() => run(onSignout)}>Sign out</Button>
    </section>
  </main>
}

export default function App() {
  const [data, setData] = useState(null)
  const [customerMode, setCustomerMode] = useState(false)
  useEffect(() => { const controller = new AbortController(); api('/capabilities', undefined, controller.signal).then(result => setCustomerMode(result.synthetic_only === false)).catch(() => {}); return () => controller.abort() }, [])
  const [emailAction, setEmailAction] = useState(() => parseEmailAction(window.location.href))
  const actionOnEntry = useRef(Boolean(emailAction))
  const [screen, setScreen] = useState(emailAction ? 'email-action' : 'landing')
  useLayoutEffect(() => { if (actionOnEntry.current) window.history.replaceState(null, '', window.location.pathname) }, [])
  const forgetEmailCode = useCallback(() => setEmailAction(old => old ? { ...old, code: '' } : old), [])
  const [view, setView] = useState('schedule')
  const [branch, setBranch] = useState('')
  const [week, setWeek] = useState(firstDay(today(), 0))
  const [schedule, setSchedule] = useState(null)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [dialog, setDialogState] = useState(null)
  const setDialog = useCallback(next => {
    if (!next) { setDialogState(null); return }
    const origin = next.returnFocus || document.activeElement
    setDialogState({ ...next, returnFocus: origin, focusFallback: origin?.closest('[data-schedule-cell]') })
  }, [])
  const [dirty, setDirty] = useState(false)
  const [scheduleClipboard, setScheduleClipboard] = useState(null)
  const mutationLock = useRef(false)
  const manager = data && data.user.role !== 'employee'
  const isAdmin = data && ['owner', 'admin'].includes(data.user.role)
  const activeBranch = data?.branches?.find(b => b.id === branch)

  async function authenticated(next) {
    if (next.billing_required) { setData(next); setBranch(''); setScreen('billing'); setError(''); return }
    const params = new URLSearchParams(window.location.search)
    const savedBranch = next.branches.find(b => b.id === params.get('branch'))
    let selectedWeek = next.calendar.planning.start
    if (/^\d{4}-\d{2}-\d{2}$/.test(params.get('week') || '')) {
      try { selectedWeek = (await api(`/calendar?day=${encodeURIComponent(params.get('week'))}`)).planning.start }
      catch { setNotice('The saved week is unavailable. Showing the current planning week.') }
    }
    const allowedViews = NAV.filter(([id]) => next.user.role !== 'employee' || ['schedule', 'requests', 'assistant', 'account'].includes(id)).filter(([id]) => id !== 'settings' || ['owner', 'admin'].includes(next.user.role))
    setData(next)
    setScheduleClipboard(null)
    setBranch(savedBranch?.id || next.branches[0]?.id || '')
    setWeek(selectedWeek)
    setScreen('app')
    setView(allowedViews.some(([id]) => id === params.get('view')) ? params.get('view') : 'schedule')
    setDirty(false)
    setSchedule(null)
    setReport(null)
    setDialog(null)
    setError('')
  }

  useEffect(() => {
    const controller = new AbortController()
    if (actionOnEntry.current) { setLoading(false); return () => controller.abort() }
    api('/me', undefined, controller.signal).then(authenticated).catch(e => { if (e.name !== 'AbortError' && e.status !== 401) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!data || !branch) return
    const controller = new AbortController()
    const query = `?branch=${encodeURIComponent(branch)}&week=${week}`
    Promise.all([api(`${manager ? '/schedule' : '/my-schedule'}${query}`, undefined, controller.signal), manager ? api(`/analytics${query}`, undefined, controller.signal) : Promise.resolve(null)]).then(([s, r]) => { setSchedule(s); setReport(r); setDirty(false) }).catch(e => { if (e.name !== 'AbortError') { setError(e.message); setSchedule(null) } })
    return () => controller.abort()
  }, [branch, week, tick, manager, data])

  useEffect(() => {
    if (screen !== 'app' || !data || !branch) return
    const params = new URLSearchParams({ branch, week, view })
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
  }, [screen, data, branch, week, view])

  async function run(action) {
    if (mutationLock.current) return
    mutationLock.current = true
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError(e.message); if (e.status === 401 && screen === 'app') { setData(null); setDialog(null); setSchedule(null); setScreen('signin') } } finally { setBusy(false); mutationLock.current = false }
  }

  async function refresh() {
    const next = await api('/me')
    setData(next)
    const calendar = await api(`/calendar?day=${week}`)
    setWeek(calendar.planning.start)
    if (!next.branches.some(b => b.id === branch)) setBranch(next.branches[0]?.id || '')
    setTick(t => t + 1)
  }

  function changeWeek(amount) { if (dirty) { setError('Save or discard your reviewed proposal before changing weeks.'); return } setSchedule(null); setWeek(amount > 0 ? schedule?.next_week || dayPlus(week, amount) : schedule?.previous_week || dayPlus(week, amount)) }
  async function jumpWeek(day) {
    if (dirty) { setError('Save or discard your reviewed proposal before changing weeks.'); return false }
    const calendar = await api(`/calendar?day=${encodeURIComponent(day)}`)
    // A date jump within the current week does not change the effect's key.
    // Keep the loaded grid instead of leaving it on a permanent skeleton.
    if (calendar.planning.start !== week) { setSchedule(null); setWeek(calendar.planning.start) }
    return true
  }
  function chooseDate() {
    if (dirty) { setError('Save or discard your proposal before changing weeks.'); return }
    setDialog({ title: 'Go to a planning week', render: () => <form onSubmit={event => { const fields = formData(event); run(async () => { if (await jumpWeek(fields.day)) setDialog(null) }) }}><Field label="Go to date" name="day" type="date" defaultValue={week} required /><p className="help">Choose any date. Your configured planning week and policy boundaries determine the week shown.</p><Button primary disabled={busy}>Open planning week</Button></form> })
  }
  const navigate = useCallback(next => { setEmailAction(null); setScreen(next); setError('') }, [])
  const props = { data, branch, week, schedule, report, run, refresh, busy, setDialog, setNotice, setError, activeBranch, setSchedule, setReport, setDirty, dirty, scheduleClipboard, setScheduleClipboard, customerMode }

  return <>
    {error && !dialog && <div className="global-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={18} /></button></div>}
    {notice && <div className="toast" role="status"><Check size={18} />{notice}<button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {loading ? <div className="loading-page"><Brand /><div className="skeleton" /><p>Connecting to your workspace…</p></div> : screen === 'billing' && data ? <BillingRequired user={data.user} run={run} busy={busy} onRefresh={async () => authenticated(await api('/me'))} onSignout={async () => { await api('/signout', {}); setData(null); setScreen('landing') }} /> : screen !== 'app' ? screen === 'landing' ? <Landing navigate={navigate} customerMode={customerMode} /> : screen === 'email-action' && emailAction ? <EmailAction action={emailAction} brand={<Brand light />} onNavigate={navigate} onForget={forgetEmailCode} /> : <Auth mode={screen} navigate={navigate} onAuthenticated={authenticated} busy={busy} run={run} /> : data && <div className="app-shell">
      <aside className="sidebar"><Brand light /><div className="workspace-tag"><span className="workspace-icon">{data.organization.name[0]}</span><div><strong>{data.organization.name}</strong><small>{customerMode ? "Team workspace" : "Local workspace"}</small></div></div><span className="nav-label">WORKSPACE</span><nav aria-label="Workspace">{NAV.filter(([id]) => manager || ['schedule', 'requests', 'assistant', 'account'].includes(id)).filter(([id]) => id !== 'settings' || isAdmin).map(([id, Icon, label]) => <button key={id} className={view === id ? 'active' : ''} disabled={busy} onClick={() => { if (dirty) return setError('Save or discard your proposal before changing views.'); setView(id) }}><Icon size={18} /><span>{label}</span>{id === 'requests' && data.leaves.filter(l => l.status === 'pending').length > 0 && <small>{data.leaves.filter(l => l.status === 'pending').length}</small>}</button>)}</nav><div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={18} /><p>{customerMode ? "Workspace" : "Local candidate"}<br /><span>{customerMode ? "Role-based access" : "Production gates open"}</span></p></div><div className="user-row"><span className="avatar">{data.user.name.slice(0, 2).toUpperCase()}</span><div><strong>{data.user.name}</strong><small>{ROLE_LABEL[data.user.role]}</small></div><button className="icon-button" title="Sign out" aria-label="Sign out" disabled={busy} onClick={() => run(async () => { await api('/signout', {}); setData(null); setScheduleClipboard(null); setSchedule(null); setScreen('landing'); setDirty(false) })}><LogOut size={18} /></button></div></div></aside>
      <div className="workspace"><header className="workspace-header"><div className="breadcrumb"><span>{data.organization.name}</span><ChevronRight size={14} /><strong>{NAV.find(x => x[0] === view)?.[2]}</strong></div><div className="header-actions">{!customerMode && <span className="local-badge">LOCAL PREVIEW</span>}<span>{ROLE_LABEL[data.user.role]}</span><button className="mobile-signout icon-button" aria-label="Sign out" onClick={() => run(async () => { await api('/signout', {}); setData(null); setScheduleClipboard(null); setScreen('landing') })}><LogOut size={18} /></button></div></header>
      <nav className="mobile-nav" aria-label="Mobile workspace"><Brand /><label>View<select value={view} disabled={busy} onChange={e => { if (dirty) return setError('Save or discard your proposal before changing views.'); setView(e.target.value) }}>{NAV.filter(([id]) => manager || ['schedule', 'requests', 'assistant', 'account'].includes(id)).filter(([id]) => id !== 'settings' || isAdmin).map(([id, , label]) => <option value={id} key={id}>{label}</option>)}</select></label></nav>
      <main className="main-content">
        {view === 'account' ? <Account data={data} run={run} busy={busy} signedOut={() => { setData(null); setSchedule(null); setScreen('signin') }} /> : !data.branches.length ? isAdmin ? <Onboarding data={data} run={run} refresh={refresh} busy={busy} /> : <Empty title="No branch assigned">Ask your organization owner to assign a branch before continuing.</Empty> : <>
          <div className="location-toolbar"><div className="location-select"><Globe2 size={18} /><label><span>Location</span><select aria-label="Location" value={branch} disabled={busy} onChange={e => { if (dirty) return setError('Save or discard your proposal first.'); setSchedule(null); setBranch(e.target.value) }}>{data.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label><span className="location-path">{activeBranch?.country} / {activeBranch?.market} / {activeBranch?.area}</span></div><span className="timezone"><Clock3 size={14} />{activeBranch?.timezone}</span></div>
          <div className="page-title" key={view}><div><h1>{view === 'schedule' ? manager ? 'Build a better week.' : 'Your published week.' : NAV.find(x => x[0] === view)?.[2]}</h1><p>{({ schedule: manager ? 'Bring the right people together, one clear shift at a time.' : 'Your approved shifts, in each branch’s local time.', overview: 'The work ahead, with the details that matter.', people: 'Skills, availability, and a place on the team.', requests: 'Make time off and cross-branch support explicit.', demand: 'Separate what happened, what you expect, and how you staff.', insights: 'Find the gaps. Understand the tradeoffs.', assistant: 'Operational answers with a visible source.', settings: 'Your organization, your calendar, your working rules.', account: 'Manage your local identity and sessions.' })[view]}</p></div>{['schedule', 'overview', 'insights', 'demand'].includes(view) && <div className="week-navigation"><Button disabled={busy} onClick={() => run(() => jumpWeek(today(activeBranch?.timezone || data.settings.timezone)))}>Today</Button><button className="icon-button date-jump" aria-label="Go to date" title="Go to any planning week" disabled={busy} onClick={chooseDate}><CalendarDays size={18} /></button><div className="week-control"><button disabled={!schedule || busy} aria-label="Previous week" onClick={() => changeWeek(-7)}><ChevronLeft size={17} /></button><span>{dateLabel(week)} – {dateLabel(schedule?.period_end || dayPlus(week, 6))}</span><button disabled={!schedule || busy} aria-label="Next week" onClick={() => changeWeek(7)}><ChevronRight size={17} /></button></div></div>}</div>
          {['schedule', 'overview', 'insights', 'demand'].includes(view) && <CalendarSummary data={data} week={week} />}
          {['schedule', 'overview', 'insights'].includes(view) && !schedule ? <div className="skeleton-stack" aria-label="Loading schedule"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><Button onClick={() => setTick(t => t + 1)}>Retry loading</Button></div> : view === 'schedule' ? <SchedulePage key={`${data.user.id}/${branch}/${week}`} {...props} manager={manager} /> : view === 'overview' ? <Overview {...props} /> : view === 'people' ? <People {...props} isAdmin={isAdmin} /> : view === 'requests' ? <Requests {...props} manager={manager} /> : view === 'insights' ? <Insights {...props} /> : view === 'settings' ? <Settings {...props} /> : view === 'demand' ? <Demand {...props} /> : <Assistant {...props} />}
        </>}
      </main><footer className="app-footer"><span>Relay · persistent local adapter</span><a href="/release-notes.html">Release status & limitations <ArrowRight size={13} /></a><a href="/third-party-notices.html">Licence notices</a></footer></div>
    </div>}
    {dialog && <Dialog title={dialog.title} returnFocus={dialog.returnFocus} focusFallback={dialog.focusFallback} error={error} onDismissError={() => setError('')} onClose={() => setDialog(null)}>{dialog.render()}</Dialog>}
  </>
}

function Summary({ report }) {
  return <div className="stats-row"><Stat label="Scheduled hours" value={`${report?.assigned_hours ?? '—'}h`} note="Planning view · actual elapsed shift time" /><Stat label="Required coverage" value={`${report?.required_hours ?? '—'}h`} note="Minimums plus configured forecast targets" /><Stat label="Unfilled coverage" value={`${report?.gap_hours ?? '—'}h`} note="Review gaps before publishing" warning={report?.gap_hours > 0} /><Stat label="Over contract hours" value={report?.overtime_risk ?? '—'} note="Employee contract thresholds" warning={report?.overtime_risk > 0} /></div>
}

function SchedulePage(props) {
  const { data, branch, week, schedule, report, run, refresh, busy, setDialog, setNotice, activeBranch, setSchedule, setReport, setDirty, dirty, manager, setError, scheduleClipboard, setScheduleClipboard } = props
  const [search, setSearch] = useState('')
  const [skill, setSkill] = useState('')
  const [workload, setWorkload] = useState('all')
  const [page, setPage] = useState(0)
  const [proposal, setProposal] = useState(null)
  const [history, setHistory] = useState(null)
  const [editHistory, setEditHistory] = useState(emptyDraftHistory)
  const [menu, setMenu] = useState(null)
  const [lastUsed, setLastUsed] = useState(null)
  const searchInput = useRef(null)
  const menuAnchor = useRef(null)
  const closeMenu = useCallback((restoreFocus = false) => { setMenu(null); if (restoreFocus) menuAnchor.current?.focus({ preventScroll: true }) }, [])
  const dates = useMemo(() => Array.from({ length: schedule.period_days || 7 }, (_, i) => dayPlus(week, i)), [schedule.period_days, week])
  const ownStaff = useMemo(() => data.employees.filter(e => e.branch === branch), [data.employees, branch])
  const approvedSupport = useMemo(() => data.support.filter(r => r.to_branch === branch && r.status === 'approved'), [data.support, branch])
  const borrowed = useMemo(() => approvedSupport.filter((r, i) => approvedSupport.findIndex(x => x.employee === r.employee) === i && !ownStaff.some(e => e.id === r.employee)).map(r => ({ id: r.employee, name: r.employee_name || `Support · ${r.employee.slice(0, 6)}`, skills: [r.role], contract_hours: null })), [approvedSupport, ownStaff])
  const allStaff = useMemo(() => [...ownStaff, ...borrowed], [ownStaff, borrowed])
  const zone = activeBranch.timezone
  const shifts = schedule.shifts
  const indexedRows = useMemo(() => scheduleRows(allStaff, shifts, data.leaves, dates, zone), [allStaff, shifts, data.leaves, dates, zone])
  const rows = filterScheduleRows(indexedRows, search, skill, workload)
  const staff = rows.map(row => row.employee)
  const visible = rows.slice(page * 30, (page + 1) * 30)
  const skills = [...new Set(allStaff.flatMap(e => e.skills))].sort()
  const filtered = Boolean(search || skill || workload !== 'all')
  const proposedIds = new Set(proposal?.shifts.filter(s => !schedule.published.some(x => x.id === s.id)).map(s => s.id) || [])

  const clipboard = scheduleClipboard?.org === data.user.org ? scheduleClipboard : null
  const canUndo = !dirty && canTravelDraft(editHistory, 'past', schedule.revision)
  const canRedo = !dirty && canTravelDraft(editHistory, 'future', schedule.revision)
  function clearSearch() {
    setSearch(''); setSkill(''); setWorkload('all'); setPage(0)
    requestAnimationFrame(() => searchInput.current?.focus())
  }
  function reloadLatest() {
    if (busy || dirty) return
    run(async () => {
      const query = `?branch=${encodeURIComponent(branch)}&week=${week}`
      const [latest, analytics] = await Promise.all([api(`/schedule${query}`), api(`/analytics${query}`)])
      setSchedule(latest); setReport(analytics); setEditHistory(emptyDraftHistory()); setHistory(null); setMenu(null)
      setNotice('Latest draft loaded. Review the changes before continuing.')
    })
  }
  async function save(next, action = 'save', acknowledge = false, recordUndo = true, message = '') {
    const s = await api('/schedule', { branch, week, revision: schedule.revision, shifts: next, action, acknowledge_gaps: acknowledge })
    if (action === 'publish' || dirty) setEditHistory(emptyDraftHistory())
    else if (recordUndo) setEditHistory(old => rememberDraft(old, shifts, schedule.revision, s.revision))
    setSchedule(s); setDirty(false); setProposal(null); await refresh(); setNotice(message || (action === 'publish' ? 'Published. Employees can now see this version.' : 'Draft saved. Published schedules remain visible to employees.'))
    return s
  }
  function undoEdit(direction = 'past') {
    if (busy || dirty || !canTravelDraft(editHistory, direction, schedule.revision)) return
    run(async () => {
      const saved = await save(editHistory[direction].at(-1).shifts, 'save', false, false, `Draft edit ${direction === 'past' ? 'undone' : 'redone'}. Published shifts are unchanged.`)
      setEditHistory(old => travelDraft(old, direction, shifts, schedule.revision, saved.revision))
    })
  }
  function openMenu(event, employee, day, shift) {
    if (busy || dirty) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    menuAnchor.current = event.currentTarget
    setMenu({ employee, day, shift, zone, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom })
  }
  function copyShift(shift, employee) {
    try {
      const template = shiftTemplate(shift, zone)
      setScheduleClipboard({ ...template, org: data.user.org, from: employee.name })
      setNotice(`Copied ${template.start}–${template.end}${template.days ? ' (overnight)' : ''} · ${template.role}. Choose a person/day to paste.`)
    } catch (error) { setError(error.message) }
  }
  function paste(employee, day) {
    if (!clipboard || busy || dirty) return
    run(async () => {
      const candidate = pasteShift(clipboard, employee.id, day)
      if (duplicateExists(shifts, candidate, zone)) throw new Error('That exact shift is already assigned here. Nothing was changed.')
      await save([...shifts, candidate])
    })
  }
  function quickEdit(shift, edge, minutes) {
    if (busy || dirty) return
    run(async () => { const edited = adjustShift(shift, zone, edge, minutes); await save(shifts.map(s => s.id === shift.id ? edited : s)) })
  }
  function repeatForm(shift, employee) {
    let template
    try { template = shiftTemplate(shift, zone) } catch (error) { setError(error.message); return }
    const row = indexedRows.find(item => item.employee.id === employee.id)
    const days = dates.map(day => ({ day, label: dateLabel(day, { weekday: 'short', day: 'numeric', month: 'short' }), duplicate: duplicateExists(shifts, pasteShift(template, employee.id, day), zone), leave: row.leave.has(day), occupied: Boolean(row.shifts.get(day)?.length) }))
    setDialog({ title: 'Repeat shift across days', render: () => <RepeatShiftForm employee={employee} template={template} days={days} onSubmit={selected => run(async () => {
      if (!selected.length) throw new Error('Choose at least one day.')
      const candidates = selected.map(day => pasteShift(template, employee.id, day)).filter(candidate => !duplicateExists(shifts, candidate, zone))
      if (!candidates.length) throw new Error('Those days already have this exact shift. Nothing was changed.')
      await save([...shifts, ...candidates], 'save', false, true, `${candidates.length} repeated shifts saved as a draft.${candidates.length < selected.length ? ' Identical shifts were skipped.' : ''}`)
      setDialog(null)
    })} /> })
  }
  function navigateCells(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    if (!(event.target instanceof Element) || event.target.closest('.shift-resize')) return
    const cell = event.target.closest('[data-schedule-column]')
    const row = cell?.closest('[data-schedule-row]')
    if (!cell || !row) return
    const rowIndex = Number(row.dataset.scheduleRow) + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)
    const column = Number(cell.dataset.scheduleColumn) + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)
    const destination = event.currentTarget.querySelector(`[data-schedule-row="${rowIndex}"] [data-schedule-column="${column}"]`)
    event.preventDefault()
    if (!destination) return
    const control = destination.querySelector('button.shift:not(:disabled), button.paste-shift:not(:disabled), button.add-shift:not(:disabled)') || destination
    control.focus({ preventScroll: true })
    destination.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }
  function cellKeys(event, employee, day) {
    if (busy || dirty) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); paste(employee, day) }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event, employee, day)
  }
  const menuActions = menu ? [
    ...(menu.shift ? [
      { label: 'Edit shift…', run: () => shiftForm(menu.employee, menu.day, menu.shift) },
      { label: 'Copy shift', shortcut: 'Ctrl/Cmd C', run: () => copyShift(menu.shift, menu.employee) },
      { label: 'Repeat across days…', run: () => repeatForm(menu.shift, menu.employee) },
      { label: 'Move 30 minutes earlier', text: 'Move −30 min', adjustment: true, run: () => quickEdit(menu.shift, 'move', -30) },
      { label: 'Move 30 minutes later', text: 'Move +30 min', adjustment: true, run: () => quickEdit(menu.shift, 'move', 30) },
      { label: 'Start 30 minutes earlier', text: 'Start −30 min', adjustment: true, run: () => quickEdit(menu.shift, 'start', -30) },
      { label: 'Start 30 minutes later', text: 'Start +30 min', adjustment: true, run: () => quickEdit(menu.shift, 'start', 30) },
      { label: 'End 30 minutes earlier', text: 'End −30 min', adjustment: true, run: () => quickEdit(menu.shift, 'end', -30) },
      { label: 'End 30 minutes later', text: 'End +30 min', adjustment: true, run: () => quickEdit(menu.shift, 'end', 30) },
    ] : [{ label: 'Assign a shift…', run: () => shiftForm(menu.employee, menu.day) }]),
    { label: 'Paste copied shift here', shortcut: 'Ctrl/Cmd V', disabled: !clipboard, run: () => paste(menu.employee, menu.day) },
    ...(menu.shift ? [{ label: 'Remove draft shift', shortcut: 'Delete', run: () => run(() => save(shifts.filter(s => s.id !== menu.shift.id))) }] : []),
  ] : []

  function shiftForm(employee, day, shift) {
    setDialog({ title: shift ? 'Edit shift' : 'Assign a shift', render: () => <form onSubmit={event => { const d = formData(event); run(async () => { const endDay = d.overnight === 'on' ? dayPlus(d.day, 1) : d.day; const s = { id: shift?.id, employee: d.employee, role: d.role, start: `${d.day}T${d.start}`, end: `${endDay}T${d.end}` }; await save([...shifts.filter(x => x.id !== shift?.id), s]); setLastUsed(shiftTemplate(s, zone)); setDialog(null) }) }}>
      <div className="form-grid"><Field label="Employee"><select name="employee" defaultValue={employee.id}>{allStaff.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field><Field label="Date" name="day" type="date" min={week} max={schedule?.period_end || dayPlus(week, 6)} defaultValue={day} required /><Field label="Role" name="role" defaultValue={shift?.role || (lastUsed && employee.skills.includes(lastUsed.role) ? lastUsed.role : employee.skills[0])} required /><Field label="Start time" name="start" type="time" defaultValue={shift ? clock(shift.start, zone) : lastUsed?.start || '09:00'} required /><Field label="End time" name="end" type="time" defaultValue={shift ? clock(shift.end, zone) : lastUsed?.end || '17:00'} required /></div><label className="check-field"><input type="checkbox" name="overnight" defaultChecked={shift ? localDate(shift.end, zone) !== day : Boolean(lastUsed?.days)} />Ends the following day</label><p className="help">Times use {zone}. Clock-change ambiguities are rejected; use an explicit-offset import/API for those occurrences. Skills, availability, leave, overlap, rest, and hours are checked by the server.</p><div className="form-actions">{shift && <Button type="button" disabled={busy} onClick={() => run(async () => { await save(shifts.filter(x => x.id !== shift.id)); setDialog(null) })}>Remove shift</Button>}<Button primary disabled={busy}>Save draft shift</Button></div>
    </form> })
  }

  if (!manager) return <EmployeeSchedule {...props} />
  return <><Summary report={report} /><section className="schedule-panel"><div className="schedule-toolbar"><div className="schedule-status"><span className={`status ${schedule.state === 'published' ? 'published' : ''}`}>{dirty ? 'Proposal · unsaved' : schedule.state}</span><span>Version {schedule.revision}</span></div><div className="toolbar-buttons"><Button disabled={busy || dirty} onClick={reloadLatest} title="Reload this week after another manager changes it">Reload latest</Button><Button disabled={busy || !canUndo} onClick={() => undoEdit()} title="Undo the last saved draft edit (Ctrl/Cmd Z)">Undo{canUndo ? ` (${editHistory.past.length})` : ''}</Button><Button disabled={busy || !canRedo} onClick={() => undoEdit('future')} title="Redo the last undone draft edit (Ctrl/Cmd Shift Z)">Redo{canRedo ? ` (${editHistory.future.length})` : ''}</Button><Button disabled={busy || dirty} onClick={() => run(async () => { setHistory(await api(`/versions?branch=${branch}&week=${week}`)) })}>History</Button><Button disabled={busy || dirty || !ownStaff.length} onClick={() => run(async () => { const p = await api('/generate', { branch, week, revision: schedule.revision }); setProposal(p); setSchedule({ ...schedule, shifts: p.shifts }); setReport(p.report); setDirty(true) })}><Sparkles size={16} />Generate draft</Button><Button primary disabled={busy || dirty || !shifts.length} onClick={() => setDialog({ title: 'Review and publish', render: () => <form onSubmit={e => { const d = formData(e); run(async () => { await save(shifts, 'publish', d.acknowledge === 'on'); setDialog(null) }) }}><p>Publish {shifts.length} shifts for {activeBranch.name}, {dateLabel(week)}–{dateLabel(schedule?.period_end || dayPlus(week, 6))}. The existing published snapshot stays visible until this transaction succeeds.</p>{report?.gap_hours > 0 && <div className="inline-warning"><strong>{report.gap_hours} required staff-hours remain unfilled.</strong><p>Review the interval gaps in Insights before acknowledging them.</p><label className="check-field"><input type="checkbox" name="acknowledge" required />I reviewed and acknowledge the remaining coverage gaps.</label></div>}<Button primary disabled={busy}>Publish this version <Check size={16} /></Button></form> })}><Check size={16} />Publish week</Button></div></div>
    {dirty && <div className="proposal"><div><strong>Review your proposed week</strong><p>{proposal?.explanation} {proposal?.unfilled.length || 0} unfilled placement(s). Proposed changes: {shifts.filter(s => !schedule.published.some(x => x.employee === s.employee && x.start === s.start && x.end === s.end && x.role === s.role)).length} added/changed, {schedule.published.filter(s => !shifts.some(x => x.employee === s.employee && x.start === s.start && x.end === s.end && x.role === s.role)).length} removed versus the published snapshot.</p></div><div><Button disabled={busy} onClick={() => run(async () => { setProposal(null); setDirty(false); await refresh() })}>Discard proposal</Button><Button primary disabled={busy} onClick={() => run(() => save(shifts))}>Save reviewed draft</Button></div></div>}
    <div className="editing-help" id="shift-edit-help"><span className="pointer-instructions">Drag ↔: 30-min steps. Side handles change start/end. Right-click or use ••• for actions.</span><span className="touch-instructions">Use ••• to adjust times in 30-min steps, copy or repeat shifts.</span><small>Alt + ←/→ move times · Ctrl/Cmd C/V copy/paste · Ctrl/Cmd Z undo · Ctrl/Cmd Shift Z redo · Arrow keys navigate days/people</small></div>
    {clipboard && <div className="clipboard-bar"><span>Copied: <strong>{clipboard.start}–{clipboard.end}{clipboard.days ? ' +1 day' : ''}</strong> · {clipboard.role} · paste into any chosen person/day</span><Button onClick={() => setScheduleClipboard(null)}>Clear copy</Button></div>}
    <div className="grid-controls"><div className="schedule-filters"><label className="search-field"><Search size={16} /><input ref={searchInput} placeholder="Find a team member" aria-label="Find a team member" value={search} onKeyDown={event => { if (event.key === 'Escape') clearSearch() }} onChange={e => { setSearch(e.target.value); setPage(0) }} /></label><label className="schedule-filter">Skill<select aria-label="Filter team by skill" value={skill} onChange={event => { setSkill(event.target.value); setPage(0) }}><option value="">All skills</option>{skills.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="schedule-filter">Workload<select aria-label="Filter team by workload" value={workload} onChange={event => { setWorkload(event.target.value); setPage(0) }}><option value="all">Everyone</option><option value="unassigned">No shifts this week</option><option value="under">Under contract hours</option><option value="over">Over contract hours</option><option value="leave">Approved leave this week</option></select></label>{filtered && <Button onClick={clearSearch}>Reset filters</Button>}</div><span role="status" aria-live="polite">{staff.length} of {allStaff.length} team members · {shifts.length} shifts · {zone}</span></div>
    {!staff.length ? <Empty title={allStaff.length ? 'No team members match your search' : 'Add your people first'}>{allStaff.length ? <><p>Try a different name, skill, or workload.</p><Button onClick={clearSearch}>Clear search</Button></> : 'Open People to create fictional employees, set skills, and configure availability.'}</Empty> : <div className="table-scroll schedule-scroll" role="region" tabIndex="0" aria-label="Weekly schedule, scroll horizontally" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); undoEdit(event.shiftKey || event.key.toLowerCase() === 'y' ? 'future' : 'past') } else navigateCells(event) }}><table className="schedule-table"><thead><tr><th>Team member <small>Role · assigned hours</small></th>{dates.map(day => <th key={day} className={day === today(zone) ? 'today' : ''}>{dateLabel(day, { weekday: 'short' })}<strong>{dateLabel(day, { day: 'numeric' })}</strong></th>)}</tr></thead><tbody>{visible.map((row, rowIndex) => { const e = row.employee, assigned = row.hours; return <tr key={e.id} data-schedule-row={rowIndex}><th><div className="person-cell"><span className={`avatar ${e.skills.includes('lead') ? 'lead' : ''}`}>{e.name.split(' ').map(x => x[0]).slice(0, 2).join('')}</span><div><strong>{e.name}</strong><small>{e.skills.join(', ')} · {assigned.toFixed(1)}h</small></div></div></th>{dates.map((day, dayIndex) => { const matches = row.shifts.get(day) || []; const onLeave = row.leave.has(day); return <td key={day} tabIndex={-1} aria-label={`${e.name}, ${day}${onLeave ? ', approved leave' : ''}`} data-schedule-column={dayIndex} data-schedule-cell={`${e.id}/${day}`} onContextMenu={event => openMenu(event, e, day)}>{matches.map(s => <ShiftCard key={s.id} shift={s} employee={e} day={day} zone={zone} disabled={dirty || busy} proposed={proposedIds.has(s.id) && dirty} onEdit={() => shiftForm(e, day, s)} onChange={edited => run(() => save(shifts.map(x => x.id === s.id ? edited : x)))} onError={setError} onMenu={event => openMenu(event, e, day, s)} onCopy={() => copyShift(s, e)} onPaste={() => paste(e, day)} onRemove={() => run(() => save(shifts.filter(x => x.id !== s.id)))} />)}{onLeave ? <span className="leave-cell">Approved leave</span> : <>{clipboard && !matches.length && <button disabled={dirty || busy || !e.skills.includes(clipboard.role)} title={e.skills.includes(clipboard.role) ? "Paste as a draft; scheduling rules are checked on save" : `${e.name} needs the ${clipboard.role} skill for this shift`} className="paste-shift" aria-label={`Paste copied shift to ${e.name} on ${day}`} onKeyDown={event => cellKeys(event, e, day)} onClick={() => paste(e, day)}><span>Paste {clipboard.start}–{clipboard.end}{clipboard.days ? ' +1 day' : ''}</span><small>{clipboard.role} · {e.skills.includes(clipboard.role) ? 'draft' : 'skill required'}</small></button>}<button disabled={dirty || busy} className="add-shift" aria-label={`Assign shift to ${e.name} on ${day}`} onKeyDown={event => cellKeys(event, e, day)} onClick={() => shiftForm(e, day)}><Plus size={15} /><span>{matches.length ? 'Add' : clipboard ? 'Custom shift' : 'Unassigned'}</span></button></>}</td> })}</tr> })}</tbody></table></div>}
    <div className="grid-footer"><div><span className="legend associate" />Associate<span className="legend lead" />Lead<span className="legend leave" />Approved leave</div><span>Showing {Math.min(page * 30 + 1, staff.length)}–{Math.min((page + 1) * 30, staff.length)} of {staff.length}</span><div><Button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button><Button disabled={(page + 1) * 30 >= staff.length} onClick={() => setPage(p => p + 1)}>Next</Button></div></div></section>
    {menu && <ScheduleMenu menu={menu} actions={menuActions} onClose={closeMenu} />}
    {proposal?.unfilled.length > 0 && <section className="panel"><h2>Why coverage remains open</h2><ul className="reason-list">{proposal.unfilled.map((u, i) => <li key={i}><strong>{u.date} · {u.role}</strong><span>{u.reason}</span></li>)}</ul></section>}
    {history && <section className="panel"><div className="section-heading"><h2>Version history</h2><Button onClick={() => setHistory(null)}>Close</Button></div>{!history.length ? <p>No versions yet. Save a draft to start the history.</p> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Version</th><th>Action</th><th>Saved</th><th>Shifts</th><th>Review</th></tr></thead><tbody>{history.map(v => <tr key={v.revision}><td>v{v.revision}</td><td>{v.action}</td><td>{new Date(v.created * 1000).toLocaleString()}</td><td>{v.shifts.length}</td><td><Button disabled={busy || dirty} onClick={() => { setSchedule({ ...schedule, shifts: v.shifts }); setDirty(true); setProposal({ shifts: v.shifts, unfilled: [], explanation: `Restored v${v.revision} as an unsaved proposal. Current leave and constraints are rechecked when saved.` }) }}>Review as draft</Button></td></tr>)}</tbody></table></div>}</section>}
    <div className="schedule-footnote"><CircleHelp size={16} /><p>Generation is a deterministic greedy draft, not a guarantee of optimal staffing or labor-law compliance. Existing assignments stay fixed. Hard conflicts are never silently relaxed.</p></div>
  </>
}

function EmployeeSchedule({ data, schedule, activeBranch, week, run, refresh, busy, setDialog }) {
  const [available, setAvailable] = useState(null)
  const employee = data.employees.find(e => e.id === data.user.employee)
  const zone = activeBranch.timezone
  const balance = data.balances.find(b => b.employee === employee?.id)
  return <><div className="employee-banner"><CheckCheck size={25} /><div><h2>Published means confirmed.</h2><p>Draft changes remain with your managers until they publish. Times below use {zone}.</p></div></div><div className="employee-days">{Array.from({ length: schedule.period_days || 7 }, (_, i) => dayPlus(week, i)).map(day => { const shifts = schedule.shifts.filter(s => localDate(s.start, zone) === day); return <section key={day}><header><strong>{dateLabel(day, { weekday: 'long' })}</strong><span>{dateLabel(day)}</span></header>{shifts.length ? shifts.map(s => <div className="employee-shift" key={s.id}><span>{clock(s.start, s.timezone || zone)} – {clock(s.end, s.timezone || zone)}{localDate(s.end, s.timezone || zone) !== localDate(s.start, s.timezone || zone) && ' +1 day'}</span><strong>{s.role}</strong><small>{s.branch_name || activeBranch.name} · {s.timezone || zone} · {duration(s).toFixed(1)}h</small></div>) : <p>{data.leaves.some(l => ['approved', 'cancel_requested', 'partially_cancelled'].includes(l.status) && l.start <= day && l.end >= day) ? 'Approved leave' : 'No published shift'}</p>}</section> })}</div><div className="panel"><h2>Your leave balance</h2><p>{balance?.remaining ?? '—'} days remaining · {balance?.pending ?? 0} pending · {balance?.used ?? 0} approved/reserved in {balance?.period_start}–{balance?.period_end}.</p><p className="help">{balance?.earned}d earned · {balance?.carryover}d carryover · {balance?.consumed}d consumed · {balance?.reserved}d reserved for future leave. Accrual: {balance?.accrual.replaceAll('_', ' ')}. Projected period-end balance: {balance?.projected_remaining}d.</p><Button disabled={busy} onClick={() => run(async () => { const ledger = await api(`/leave/ledger?employee=${employee.id}`); setDialog({ title: 'Your annual leave ledger', render: () => <LeaveLedger initial={ledger} employee={employee} data={data} run={run} refresh={refresh} busy={busy} /> }) })}>View your leave ledger</Button></div><section className="panel"><div className="section-heading"><h2>Your availability</h2><Button onClick={() => setAvailable(true)}>Edit availability</Button></div><p>Availability is interpreted in your home branch timezone. Assigned shifts must be resolved before conflicting availability can be saved.</p>{available !== null && <form onSubmit={e => { const d = formData(e); run(async () => { await api('/availability', { id: employee.id, availability: readAvailability(d) }); await refresh(); setAvailable(null) }) }}><AvailabilityFields initial={employee?.availability} /><Button primary disabled={busy}>Save availability</Button></form>}</section></>
}

function Overview({ report, data, branch, activeBranch, week, run }) {
  const [aggregate, setAggregate] = useState(null)
  return <><Summary report={aggregate || report} /><section className="panel"><div className="section-heading"><h2>This week’s priorities</h2><Button onClick={() => run(async () => setAggregate(await api(`/analytics?week=${week}`)))}>Aggregate assigned branches</Button></div><div className="priority-list"><div><span className="priority-number">01</span><div><strong>Resolve uncovered roles</strong><p>{(aggregate || report)?.gap_hours ?? 0} staff-hours unfilled. Open Insights for exact intervals and roles.</p></div></div><div><span className="priority-number">02</span><div><strong>Review people’s requests</strong><p>{data.leaves.filter(l => l.status === 'pending').length} leave request(s), {data.support.filter(r => r.status === 'pending').length} support request(s) pending within your scope.</p></div></div><div><span className="priority-number">03</span><div><strong>Check availability before publishing</strong><p>{data.employees.filter(e => e.branch === branch && e.active).length} active team members at {activeBranch.name}. Drafts remain distinct from employee-visible snapshots.</p></div></div></div></section><section className="panel"><h2>Your authorized locations</h2><div className="table-scroll"><table className="data-table"><thead><tr><th>Branch</th><th>Country</th><th>Market</th><th>Area</th><th>Timezone</th></tr></thead><tbody>{data.branches.map(b => <tr key={b.id}><td><strong>{b.name}</strong></td><td>{b.country}</td><td>{b.market}</td><td>{b.area}</td><td>{b.timezone}</td></tr>)}</tbody></table></div></section></>
}

function People({ data, branch, activeBranch, run, refresh, busy, setDialog, isAdmin, customerMode }) {
  const [search, setSearch] = useState('')
  const staff = data.employees.filter(e => e.branch === branch && e.name.toLowerCase().includes(search.toLowerCase()))
  function employeeForm(e) {
    setDialog({ title: e ? 'Edit team member' : 'Add a fictional team member', render: () => <form onSubmit={event => { const d = formData(event); run(async () => { await api('/employees', { id: e?.id, name: d.name, branch, skills: d.skills.split(',').map(x => x.trim()).filter(Boolean), contract_hours: Number(d.contract_hours), start_date: d.start_date, availability: readAvailability(d), active: d.active === 'on', ...(isAdmin ? { hourly_rate: d.hourly_rate === '' ? null : Number(d.hourly_rate) } : {}) }); await refresh(); setDialog(null) }) }}><div className="form-grid"><Field label="Full name" name="name" defaultValue={e?.name || ''} required /><Field label="Skills / roles (comma separated)" name="skills" defaultValue={e?.skills.join(', ') || 'associate'} required /><Field label="Contract hours per week" name="contract_hours" type="number" min="1" max="168" defaultValue={e?.contract_hours || 40} required /><Field label="Employment start date" name="start_date" type="date" defaultValue={e?.start_date || today(activeBranch.timezone)} required />{isAdmin && <Field label="Hourly rate (optional, configured currency units)" name="hourly_rate" type="number" min="0" step="0.01" defaultValue={e?.hourly_rate ?? ''} />}</div><AvailabilityFields initial={e?.availability} /><label className="check-field"><input name="active" type="checkbox" defaultChecked={e?.active ?? true} />Active team member</label><p className="help">Times are in {activeBranch.timezone}. Branch transfers and pay currencies require production integration. Use fictional local test records.</p><Button primary disabled={busy}>Save team member</Button></form> })
  }
  function accountForm(member) {
    const edit = Boolean(member)
    setDialog({ title: edit ? 'Manage member access' : 'Create a member account', render: () => <form onSubmit={event => { const d = formData(event); run(async () => { const body = { ...d, id: member?.id, branches: data.branches.filter(b => d[`branch_${b.id}`] === 'on').map(b => b.id), areas: d.role === 'area_manager' ? data.hierarchy.areas.filter(a => d[`area_${a.id}`] === 'on').map(a => a.id) : [], employee: d.role === 'employee' ? d.employee || null : null, enabled: edit ? d.enabled === 'on' : true }; await api(edit ? '/members/update' : '/members', body); await refresh(); setDialog(null) }) }}><div className="form-grid">{!edit && <><Field label="Name" name="name" required /><Field label="Email" name="email" type="email" required /><Field label="Temporary password" name="password" type="password" minLength={12} required /></>}<Field label="Role"><select name="role" defaultValue={member?.role || 'employee'}><option value="employee">Employee</option><option value="branch_manager">Branch manager</option><option value="area_manager">Area manager</option>{data.user.role === 'owner' && <option value="admin">Administrator</option>}</select></Field><Field label="Employee record (required for employee role)"><select name="employee" defaultValue={member?.employee || ''}><option value="">Manager account</option>{data.employees.map(e => <option key={e.id} value={e.id}>{e.name} · {data.branches.find(b => b.id === e.branch)?.name}</option>)}</select></Field></div><fieldset className="branch-options"><legend>Assigned branches</legend>{data.branches.map(b => <label className="check-field" key={b.id}><input type="checkbox" name={`branch_${b.id}`} defaultChecked={edit ? member.branches.includes(b.id) : b.id === branch} />{b.name} · {b.market} / {b.area}</label>)}</fieldset><fieldset className="branch-options"><legend>Assigned areas (area managers only)</legend>{data.hierarchy.areas.map(a => <label className="check-field" key={a.id}><input type="checkbox" name={`area_${a.id}`} defaultChecked={member?.areas.includes(a.id)} />{a.name} · {data.hierarchy.markets.find(m => m.id === a.parent)?.name}</label>)}</fieldset>{edit && <label className="check-field"><input type="checkbox" name="enabled" defaultChecked={member.enabled} />Account enabled</label>}<p className="help">Employees and branch managers require exactly one branch. Area managers can include named areas and explicit branches; newly added branches in assigned areas are included automatically. {edit ? 'Saving revokes this member’s sessions immediately. Owner access is protected.' : customerMode ? 'Share the temporary password securely. The member uses it to request verification, then chooses a new password by email. No invitation is sent now.' : 'This creates a local account without sending an invitation or email.'}</p><Button primary disabled={busy}>{edit ? 'Save access and revoke sessions' : 'Create account'}</Button></form> })
  }
  return <><section className="panel"><div className="section-heading"><div><h2>{activeBranch.name} team</h2><p>{staff.length} records · skills and contract hours</p></div><div className="toolbar-buttons">{isAdmin && <Button onClick={() => accountForm(null)}>Add member account</Button>}<Button primary onClick={() => employeeForm(null)}><Plus size={16} />Add team member</Button></div></div><label className="search-field"><Search size={16} /><input placeholder="Search people" aria-label="Search people" value={search} onChange={e => setSearch(e.target.value)} /></label>{!staff.length ? <Empty title="Your roster starts here">Add a team member with skills, contract hours, and availability.</Empty> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Team member</th><th>Skills</th><th>Contract</th><th>Status</th><th>Manage</th></tr></thead><tbody>{staff.slice(0, 200).map(e => <tr key={e.id}><td><strong>{e.name}</strong></td><td>{e.skills.join(', ')}</td><td>{e.contract_hours}h / week</td><td><span className={`status ${e.active ? 'published' : ''}`}>{e.active ? 'Active' : 'Inactive'}</span></td><td><Button onClick={() => employeeForm(e)}>Edit</Button></td></tr>)}</tbody></table></div>}</section>{isAdmin && <section className="panel"><h2>Local access accounts</h2><div className="table-scroll"><table className="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branch / area scope</th><th>Status</th><th>Manage</th></tr></thead><tbody>{data.members.map(m => <tr key={m.id}><td>{m.name}</td><td>{m.email}</td><td>{ROLE_LABEL[m.role]}</td><td>{['owner', 'admin'].includes(m.role) ? 'Organization' : [...m.branches.map(b => data.directory.find(x => x.id === b)?.name || b), ...m.areas.map(a => `Area: ${data.hierarchy.areas.find(x => x.id === a)?.name || a}`)].join(', ')}</td><td>{m.enabled ? 'Enabled' : 'Disabled'}</td><td>{m.role !== 'owner' && (data.user.role === 'owner' || m.role !== 'admin') ? <Button onClick={() => accountForm(m)}>Edit access</Button> : 'Protected'}</td></tr>)}</tbody></table></div></section>}</>
}

function Requests({ data, branch, week, run, refresh, busy, setDialog, manager }) {
  const names = Object.fromEntries(data.employees.map(e => [e.id, e.name]))
  const branchName = id => data.directory.find(b => b.id === id)?.name || data.branches.find(b => b.id === id)?.name || id.slice(0, 6)
  function cancellationForm(l) {
    if (l.status === 'pending') return run(async () => { await api('/leave/cancel', { id: l.id }); await refresh() })
    const zone = data.branches.find(b => b.id === l.branch)?.timezone || data.settings.timezone
    const tomorrow = dayPlus(today(zone), 1)
    const earliest = tomorrow > l.start ? tomorrow : l.start
    setDialog({ title: manager ? 'Cancel future leave' : 'Request leave cancellation', render: () => <form onSubmit={e => { const d = formData(e); run(async () => { await api('/leave/cancel', { id: l.id, cancel_from: d.cancel_from }); await refresh(); setDialog(null) }) }}><Field label="Cancel from" name="cancel_from" type="date" min={earliest} max={l.end} defaultValue={earliest} required /><p className="help">Today and past dates remain consumed in history. Future reservations are released only when a manager approves cancellation.</p><Button primary disabled={busy}>{manager ? 'Approve cancellation' : 'Request cancellation'}</Button></form> })
  }
  function ledgerForm(employee) { run(async () => { const ledger = await api(`/leave/ledger?employee=${employee.id}`); setDialog({ title: `Annual leave: ${employee.name}`, render: () => <LeaveLedger initial={ledger} employee={employee} data={data} run={run} refresh={refresh} busy={busy} /> }) }) }
  function leaveForm() {
    const staff = data.employees.filter(e => e.branch === branch)
    setDialog({ title: 'Request leave', render: () => <form onSubmit={event => { const d = formData(event); run(async () => { await api('/leave', d); await refresh(); setDialog(null) }) }}><div className="form-grid"><Field label="Employee"><select name="employee" required>{staff.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field><Field label="Start date" name="start" type="date" defaultValue={week} required /><Field label="End date" name="end" type="date" defaultValue={week} required /><Field label="Request note (avoid medical details)" name="reason" defaultValue="Time off" maxLength={500} required /></div><p className="help">Approval checks your configured fiscal allowance and existing shift reservations. This adapter has no medical absence category.</p><Button primary disabled={busy}>Submit for approval</Button></form> })
  }
  async function supportForm() {
    const candidates = await api(`/support-candidates?to_branch=${branch}`)
    setDialog({ title: 'Request cross-branch support', render: () => <form onSubmit={event => { const d = formData(event); const e = candidates.find(e => e.id === d.employee); run(async () => { await api('/support', { employee: e.id, from_branch: e.branch, to_branch: branch, role: d.role, start: d.start, end: d.end }); await refresh(); setDialog(null) }) }}><div className="form-grid"><Field label="Available candidate directory"><select name="employee" required><option value="">Select a candidate</option>{candidates.map(e => <option key={e.id} value={e.id}>{e.name} · {branchName(e.branch)} · {e.skills.join(', ')}</option>)}</select></Field><Field label="Requested role" name="role" defaultValue="associate" required /><Field label="Start, destination local time" name="start" type="datetime-local" defaultValue={`${week}T09:00`} required /><Field label="End, destination local time" name="end" type="datetime-local" defaultValue={`${week}T17:00`} required /></div><p className="help">Your request explicitly approves the receiving branch. A manager of the home branch must approve next. No pay, availability or schedules are exposed in the candidate directory. After approval, add the support employee to the destination draft.</p><Button primary disabled={busy}>Request home-branch approval</Button></form> })
  }
  return <><div className="page-actions"><Button primary disabled={!data.employees.length} onClick={leaveForm}><Plus size={16} />Request leave</Button>{manager && <Button disabled={busy} onClick={() => run(supportForm)}>Request support</Button>}</div><section className="panel"><h2>Leave requests</h2>{!data.leaves.length ? <Empty title="No leave requests yet">Submit a request to start an auditable approval flow.</Empty> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Person</th><th>Dates</th><th>Workdays</th><th>Status</th><th>Decision</th></tr></thead><tbody>{data.leaves.map(l => <tr key={l.id}><td><strong>{names[l.employee] || 'Authorized employee'}</strong></td><td>{l.start} → {l.end}</td><td>{l.days}</td><td><span className={`status ${l.status === 'approved' ? 'published' : ''}`}>{l.status.replaceAll('_', ' ')}</span></td><td><div className="toolbar-buttons">{manager && l.status === 'pending' && ['approved', 'rejected'].map(status => <Button key={status} disabled={busy} onClick={() => run(async () => { await api('/leave/decide', { id: l.id, status }); await refresh() })}>{status === 'approved' ? 'Approve' : 'Reject'}</Button>)}{manager && l.status === 'cancel_requested' && <><Button disabled={busy} onClick={() => run(async () => { await api('/leave/cancel', { id: l.id }); await refresh() })}>Approve cancellation</Button><Button disabled={busy} onClick={() => run(async () => { await api('/leave/cancel', { id: l.id, decision: 'reject' }); await refresh() })}>Reject cancellation</Button></>}{['pending', 'approved', 'partially_cancelled'].includes(l.status) && (l.status === 'pending' || l.end > today(data.branches.find(b => b.id === l.branch)?.timezone || data.settings.timezone)) && <Button disabled={busy} onClick={() => cancellationForm(l)}>{l.status === 'pending' ? 'Cancel request' : manager ? 'Cancel future leave' : 'Request cancellation'}</Button>}</div></td></tr>)}</tbody></table></div>}</section><section className="panel"><h2>Annual leave balances & reservations</h2><p className="help">Earned credits, signed adjustments and carryover fund dated reservations. Future bookings can use projected accrual; see the ledger to distinguish posted and projected credits.</p><div className="table-scroll"><table className="data-table"><thead><tr><th>Person</th><th>Earned + carryover</th><th>Consumed</th><th>Reserved future</th><th>Pending</th><th>Available now</th><th>Projected end</th><th>Ledger</th></tr></thead><tbody>{data.balances.map(b => <tr key={b.employee}><td>{names[b.employee]}</td><td>{b.earned + b.carryover}d</td><td>{b.consumed}d</td><td>{b.reserved}d</td><td>{b.pending}d</td><td>{b.remaining}d</td><td>{b.projected_remaining}d</td><td><Button disabled={busy} onClick={() => ledgerForm(data.employees.find(e => e.id === b.employee))}>View ledger</Button></td></tr>)}</tbody></table></div></section>{manager && <section className="panel"><h2>Cross-branch support</h2>{!data.support.length ? <Empty title="Help starts with a request">Request a person and interval. The home manager approves before destination assignment.</Empty> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Employee</th><th>From → To</th><th>Interval (UTC)</th><th>Status</th><th>Home decision</th></tr></thead><tbody>{data.support.map(r => <tr key={r.id}><td>{names[r.employee] || r.employee_name || `Support ${r.employee.slice(0, 6)}`}</td><td>{branchName(r.from_branch)} → {branchName(r.to_branch)}</td><td>{r.start} → {r.end}</td><td>{r.status}</td><td>{r.status === 'pending' && data.branches.some(b => b.id === r.from_branch) ? <div className="toolbar-buttons">{['approved', 'rejected'].map(status => <Button disabled={busy} key={status} onClick={() => run(async () => { await api('/support/decide', { id: r.id, status }); await refresh() })}>{status === 'approved' ? 'Approve' : 'Reject'}</Button>)}</div> : '—'}</td></tr>)}</tbody></table></div>}</section>}</>
}

function Insights({ report, activeBranch, data }) {
  const names = Object.fromEntries(data.branches.map(b => [b.id, b.name]))
  const gaps = report?.coverage.filter(g => g.gap > 0) || []
  return <><Summary report={report} /><section className="panel"><div className="section-heading"><div><h2>Coverage gaps by interval</h2><p>Required versus scheduled people · {activeBranch.timezone} · draft</p></div><span className={`status ${gaps.length ? '' : 'published'}`}>{gaps.length} uncovered intervals</span></div>{!gaps.length ? <Empty title="Configured coverage is filled">Check working rules and human preferences before publishing.</Empty> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Date</th><th>Interval</th><th>Location / role</th><th>Required</th><th>Scheduled</th><th>Gap</th><th>Source</th></tr></thead><tbody>{gaps.map((g, i) => <tr key={i}><td>{g.date}</td><td>{g.start ? `${clock(g.start, activeBranch.timezone)}–${clock(g.end, activeBranch.timezone)}` : 'Clock change requires review'}</td><td>{names[g.branch]} · {g.role}</td><td>{g.required}</td><td>{g.scheduled}</td><td><span className="gap-number">{g.gap}</span></td><td>{g.source || g.reason}</td></tr>)}</tbody></table></div>}</section><section className="panel"><h2>Available versus assigned hours</h2><p className="help">Available windows are merged and clipped to the planning period, then reduced by working days, whole-day approved leave, daily limits, contract and weekly caps. Distribution ratios compare assigned hours to individual contracts. This is not an employee performance score.</p><div className="table-scroll"><table className="data-table"><thead><tr><th>Person</th><th>Available capacity</th><th>Assigned</th><th>Contract</th><th>Allocation</th><th>Overtime risk</th></tr></thead><tbody>{report?.distribution.map(d => <tr key={d.employee}><td>{d.name}</td><td>{d.available_hours}h</td><td>{d.assigned_hours}h</td><td>{d.contract_hours}h</td><td><div className="allocation"><progress max={1} value={Math.min(d.ratio, 1)} /><span>{Math.round(d.ratio * 100)}%</span></div></td><td>{d.overtime_risk ? 'Above contract' : 'Within contract'}</td></tr>)}</tbody></table></div><p className="help">Allocation spread: {report?.fairness_spread ?? '—'} (max minus min contract ratio). Constraint feasibility takes priority.</p></section><section className="panel"><h2>Data quality & leave outlook</h2><div className="quality-grid"><p><strong>{report?.data_quality.missing_rates ?? 0}</strong> employees without configured rates</p><p><strong>{report?.data_quality.invalid_assignments.length ?? 0}</strong> invalid draft assignments</p><p><strong>{report?.leave_outlook.filter(l => ['approved', 'cancel_requested', 'partially_cancelled'].includes(l.status)).length ?? 0}</strong> approved requests intersect this week</p><p><strong>{report?.support_requests.filter(r => r.status === 'pending').length ?? 0}</strong> support decisions pending</p></div><p>{report?.cost != null ? `Configured rate × scheduled hours: ${report.cost.toFixed(2)} rate units. Currency and overtime premiums are not configured.` : 'Cost is unavailable: all assigned rates must be configured and organization-level rate permission is required.'}</p></section></>
}

function HierarchyForm({ data, initial, run, refresh, busy, done }) {
  const [kind, setKind] = useState(initial?.kind || 'country')
  const parents = kind === 'market' ? data.hierarchy.countries : data.hierarchy.markets
  return <form onSubmit={e => { const d = formData(e); run(async () => { await api('/hierarchy', { ...d, id: initial?.id, kind, parent: initial?.parent || d.parent }); await refresh(); done() }) }}><div className="form-grid"><Field label="Location level"><select value={kind} onChange={e => setKind(e.target.value)} disabled={Boolean(initial)}><option value="country">Country</option><option value="market">Market</option><option value="area">Area</option></select></Field><Field label="Location name" name="name" defaultValue={initial?.name || ''} required />{kind !== 'country' && <Field label={kind === 'market' ? 'Parent country' : 'Parent market'}><select name="parent" defaultValue={initial?.parent} disabled={Boolean(initial)} required>{parents.map(n => <option value={n.id} key={n.id}>{n.name}</option>)}</select></Field>}</div><p className="help">Names are unique within each parent. Renaming updates branch display labels; existing parent relationships retain their identity.</p><Button primary disabled={busy}>Save hierarchy node</Button></form>
}

function Settings({ data, run, refresh, busy, setDialog }) {
  const s = data.settings
  const editNode = node => setDialog({ title: node ? 'Rename location' : 'Create location', render: () => <HierarchyForm data={data} initial={node} run={run} refresh={refresh} busy={busy} done={() => setDialog(null)} /> })
  function branchForm(b) {
    setDialog({ title: b ? 'Edit branch location' : 'Add branch', render: () => <form onSubmit={e => { const d = formData(e); run(async () => { await api('/branches', { ...b, ...d, coverage: b?.coverage || [{ role: 'associate', start: d.start, end: d.end, required: Number(d.required) }] }); await refresh(); setDialog(null) }) }}><BranchFields policy={s} hierarchy={data.hierarchy} initial={b} /><p className="help">Branch timezone changes are blocked when schedules exist. Area reassignment changes dynamic area-manager scope; explicit branch assignments remain explicit.</p><Button primary disabled={busy}>Save branch</Button></form> })
  }
  return <><section className="panel"><h2>Effective-dated calendar & work rules</h2><p>Policies are versioned business rules. Historical schedules and posted leave credits retain their original context.</p><form key={JSON.stringify(s)} onSubmit={e => { const d = formData(e); run(async () => { const next = { ...d, week_start: Number(d.week_start), fiscal_start_month: Number(d.fiscal_start_month), fiscal_start_day: Number(d.fiscal_start_day), max_week_hours: Number(d.max_week_hours), max_day_hours: Number(d.max_day_hours), min_rest_hours: Number(d.min_rest_hours), annual_leave_days: Number(d.annual_leave_days), pay_split_day: Number(d.pay_split_day), max_carryover_days: Number(d.max_carryover_days), leave_prorate_joiners: d.leave_prorate_joiners === 'on', workdays: WEEKDAYS.map((_, i) => i).filter(i => d[`workday_${i}`] === 'on'), leave_workdays: WEEKDAYS.map((_, i) => i).filter(i => d[`leave_day_${i}`] === 'on') }; await api('/settings', next); await refresh() }) }}><div className="form-grid"><Field label="Effective from" name="effective" type="date" defaultValue={dayPlus(today(s.timezone), 1)} required /><Field label="Default timezone" name="timezone" defaultValue={s.timezone} required /><Field label="First day of week"><select name="week_start" defaultValue={s.week_start}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field><Field label="Fiscal year starts in month"><select name="fiscal_start_month" defaultValue={s.fiscal_start_month}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></Field><Field label="Fiscal start day" name="fiscal_start_day" type="number" min="1" max="28" defaultValue={s.fiscal_start_day} required /><Field label="Pay cycle"><select name="pay_cycle" defaultValue={s.pay_cycle}><option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="semimonthly">Semimonthly</option><option value="monthly">Monthly</option></select></Field><Field label="Pay anchor date" name="pay_anchor" type="date" defaultValue={s.pay_anchor} required /><Field label="Semimonthly split day" name="pay_split_day" type="number" min="2" max="28" defaultValue={s.pay_split_day} required /><Field label="Maximum weekly hours" name="max_week_hours" type="number" min="1" max="168" defaultValue={s.max_week_hours} required /><Field label="Maximum daily hours" name="max_day_hours" type="number" min="1" max="24" defaultValue={s.max_day_hours} required /><Field label="Minimum rest between shifts (hours)" name="min_rest_hours" type="number" min="0" max="48" defaultValue={s.min_rest_hours} required /><Field label="Annual leave allowance (workdays)" name="annual_leave_days" type="number" min="0" max="366" defaultValue={s.annual_leave_days} required /><Field label="Accrual method"><select name="leave_accrual" defaultValue={s.leave_accrual}><option value="annual_upfront">Annual upfront</option><option value="monthly">Monthly on fiscal-month start</option><option value="daily">Daily calendar accrual</option></select></Field><Field label="Maximum carryover days" name="max_carryover_days" type="number" min="0" max="366" step="0.01" defaultValue={s.max_carryover_days} required /></div><fieldset className="branch-options"><legend>Working weekdays</legend>{WEEKDAYS.map((d, i) => <label className="check-field" key={d}><input type="checkbox" name={`workday_${i}`} defaultChecked={s.workdays.includes(i)} />Working {d}</label>)}</fieldset><fieldset className="branch-options"><legend>Days charged for annual leave</legend>{WEEKDAYS.map((d, i) => <label className="check-field" key={d}><input type="checkbox" name={`leave_day_${i}`} defaultChecked={s.leave_workdays.includes(i)} />Leave {d}</label>)}</fieldset><label className="check-field"><input type="checkbox" name="leave_prorate_joiners" defaultChecked={s.leave_prorate_joiners} />Prorate annual upfront grants for mid-period joiners</label><p className="help">A changed first weekday activates on that weekday, with a short transition week if needed. Fiscal-calendar/accrual-mode changes start a new fiscal period. Changes that invalidate saved commitments or projected leave funding are rejected. These settings are not a legal-compliance certification or payroll calculation.</p><Button primary disabled={busy}>Create policy version</Button></form></section><section className="panel"><h2>Policy history</h2><div className="table-scroll"><table className="data-table"><thead><tr><th>Effective</th><th>Version</th><th>Week starts</th><th>Pay cycle</th><th>Leave accrual</th></tr></thead><tbody>{data.policies.map(p => <tr key={p.effective}><td>{p.effective === '0001-01-01' ? 'Initial configuration' : p.effective}</td><td>{p.revision}</td><td>{WEEKDAYS[p.policy.week_start]}</td><td>{p.policy.pay_cycle}</td><td>{p.policy.leave_accrual.replaceAll('_', ' ')}</td></tr>)}</tbody></table></div></section><section className="panel"><div className="section-heading"><div><h2>Country → market → area → branch</h2><p>First-class tenant-owned records. Area assignments include branches subsequently created in that area.</p></div><div className="toolbar-buttons"><Button onClick={() => editNode(null)}>Add location level</Button><Button primary onClick={() => branchForm(null)}><Plus size={16} />Add branch</Button></div></div><div className="hierarchy-tree">{data.hierarchy.countries.map(country => <div key={country.id}><div className="hierarchy-node"><strong>{country.name}</strong><Button onClick={() => editNode({ ...country, kind: 'country' })}>Rename country</Button></div>{data.hierarchy.markets.filter(m => m.parent === country.id).map(m => <div className="hierarchy-indent" key={m.id}><div className="hierarchy-node"><strong>{m.name}</strong><Button onClick={() => editNode({ ...m, kind: 'market' })}>Rename market</Button></div>{data.hierarchy.areas.filter(a => a.parent === m.id).map(a => <div className="hierarchy-indent" key={a.id}><div className="hierarchy-node"><span>{a.name} · {data.branches.filter(b => b.area_id === a.id).length} branches</span><Button onClick={() => editNode({ ...a, kind: 'area' })}>Rename area</Button></div></div>)}</div>)}</div>)}</div><div className="table-scroll"><table className="data-table"><thead><tr><th>Branch</th><th>Hierarchy</th><th>Coverage policy</th><th>Manage</th></tr></thead><tbody>{data.branches.map(b => <tr key={b.id}><td>{b.name}</td><td>{b.country} / {b.market} / {b.area}</td><td>{b.coverage.map(r => `${r.required} ${r.role}, ${r.start}–${r.end}`).join('; ')}</td><td><div className="toolbar-buttons"><Button onClick={() => branchForm(b)}>Edit location</Button><Button onClick={() => setDialog({ title: `Coverage: ${b.name}`, render: () => <form onSubmit={e => { const d = formData(e); run(async () => { await api('/branches', { ...b, coverage: readCoverage(d) }); await refresh(); setDialog(null) }) }}><CoverageFields initial={b.coverage} /><Button primary disabled={busy}>Save coverage policy</Button></form> })}>Edit coverage</Button></div></td></tr>)}</tbody></table></div></section></>
}

function Demand({ data, branch, week, activeBranch, run, refresh, busy }) {
  const [csv, setCsv] = useState(`start,end,transactions,kind,granularity,role,units\n${week}T09:00,${week}T10:00,40,forecast,interval,associate,transactions`)
  const [preview, setPreview] = useState(null)
  const [report, setReport] = useState(null)
  useEffect(() => { const c = new AbortController(); api(`/demand?branch=${branch}&week=${week}`, undefined, c.signal).then(setReport).catch(() => {}); return () => c.abort() }, [branch, week, data])
  const policy = report?.policies[0]
  const canBaseline = ['owner', 'admin', 'area_manager'].includes(data.user.role)
  return <><section className="demand-intro"><ChartNoAxesCombined size={27} /><div><strong>Transactions need a period and a denominator.</strong><p>400 transactions ÷ 11 people is not transactions per labor hour. Use dated actuals or forecasts, then configure scheduled paid or productive hours. No automatic demand forecast is invented.</p></div></section><section className="panel"><h2>{canBaseline ? 'Area-approved labor baseline' : 'Branch labor override'}</h2><form key={branch + (policy?.id || '')} onSubmit={e => { const d = formData(e); run(async () => { await api('/labor-policy', { branch, transactions_per_hour: Number(d.transactions_per_hour), denominator: d.denominator, productive_factor: Number(d.productive_factor), allowed_override_percent: Number(d.allowed_override_percent || 0), role: d.role }); await refresh() }) }}><div className="form-grid"><Field label="Transactions per labor hour target" name="transactions_per_hour" type="number" min="0.01" step="0.01" defaultValue={policy?.transactions_per_hour || ''} required /><Field label="Denominator"><select name="denominator" defaultValue={policy?.denominator || 'scheduled_paid_hours'} disabled={!canBaseline && !policy}><option value="scheduled_paid_hours">Scheduled paid hours</option><option value="scheduled_productive_hours">Scheduled productive hours × factor</option></select></Field><Field label="Productive factor (breaks/training adjustment)" name="productive_factor" type="number" min="0.01" max="1" step="0.01" defaultValue={policy?.productive_factor || 1} required /><Field label="Covered role" name="role" defaultValue={policy?.role || 'associate'} required />{canBaseline && <Field label="Allowed branch override deviation (%)" name="allowed_override_percent" type="number" min="0" max="50" defaultValue={policy?.allowed_override_percent || 0} />}</div><p className="help">Every assigned person’s shift hours count for its assigned role, including managers and borrowed staff. Paid hours include all shift time; productive hours use your explicit factor. Break segments and actual worked hours are not recorded. Targets are configurable assumptions, not universal benchmarks.</p><Button primary disabled={busy || (!canBaseline && !policy)}>Save {canBaseline ? 'approved baseline' : 'permitted override'}</Button></form></section><section className="panel"><div className="section-heading"><div><h2>Preview transaction data</h2><p>{activeBranch.name} · {activeBranch.timezone} · transactions</p></div><a download="relay-demand-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent('start,end,transactions,kind,granularity,role,units\n2026-10-12T09:00,2026-10-12T10:00,40,forecast,interval,associate,transactions')}`}>Download CSV template</a></div><Field label="Upload a CSV file"><input type="file" accept=".csv,text/csv" onChange={async e => { if (e.target.files[0]) { setCsv(await e.target.files[0].text()); setPreview(null) } }} /></Field><Field label="Or paste / manually enter CSV"><textarea rows={8} value={csv} onChange={e => { setCsv(e.target.value); setPreview(null) }} /></Field><p className="help">Interval rows must be 15, 30, or 60 minutes. Day/week rows remain coarse. Use ISO local dates/times or explicit UTC offsets. Actual and forecast records remain separate. Duplicate period/kind/role rows are rejected.</p><Button disabled={busy} onClick={() => run(async () => setPreview(await api('/demand/preview', { branch, csv })))}>Validate & preview</Button>{preview && <div className="import-preview"><h3>{preview.valid ? `${preview.rows.length} valid row(s) ready` : 'Fix these rows before importing'}</h3>{preview.errors.map(e => <p className="error-text" key={e.row}>CSV row {e.row}: {e.error}</p>)}<div className="table-scroll"><table className="data-table"><thead><tr><th>Period</th><th>Transactions</th><th>Kind</th><th>Detail</th></tr></thead><tbody>{preview.rows.slice(0, 100).map(r => <tr key={r.id}><td>{r.start} → {r.end}</td><td>{r.transactions}</td><td>{r.kind}</td><td>{r.granularity} · {r.role}</td></tr>)}</tbody></table></div>{preview.valid && <Button primary disabled={busy} onClick={() => run(async () => { await api('/demand/import', { branch, csv, confirm: true }); setPreview(null); await refresh() })}>Confirm validated import</Button>}</div>}</section><section className="panel"><h2>Demand & scheduled labor</h2>{!report?.records.length ? <Empty title="No imported demand for this week">Coverage uses your minimum staffing rules until dated demand and an approved baseline are available.</Empty> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Start (UTC)</th><th>Kind / detail</th><th>Transactions</th><th>Scheduled paid hours</th><th>Transactions / scheduled hour</th></tr></thead><tbody>{report.records.map(r => <tr key={r.id}><td>{r.start}</td><td>{r.kind} · {r.granularity}</td><td>{r.transactions}</td><td>{r.scheduled_paid_hours}h</td><td>{r.transactions_per_scheduled_hour ?? 'No scheduled labor'}</td></tr>)}</tbody></table></div>}<p className="help">These are ratios against scheduled hours, not actual productivity. Interval forecasts can increase role targets; day/week totals cannot infer peaks. Fixed opening, closing, and task coverage still applies.</p></section></>
}

function Assistant({ data, run, busy }) {
  const [answer, setAnswer] = useState(null)
  const [question, setQuestion] = useState('Who is on leave this month?')
  const base = today(data.settings.timezone)
  return <><section className="assistant-head"><span className="assistant-orb"><Sparkles size={26} /></span><div><h2>Ask about the work ahead.</h2><p>Local deterministic answers. External language model: <strong>unconfigured</strong>. Read-only, scoped to your authorized branches.</p></div></section><section className="panel"><form onSubmit={e => { const d = formData(e); run(async () => setAnswer(await api('/assistant', d))) }}><div className="suggestions">{['Who is on leave this month?', 'How many active employees?', 'Which branches have surplus coverage?', 'When are the quieter periods?'].map(q => <button key={q} type="button" onClick={() => setQuestion(q)}>{q}</button>)}</div><Field label="Operational question"><textarea name="question" value={question} rows={3} onChange={e => setQuestion(e.target.value)} maxLength={1000} required /></Field><div className="form-grid"><Field label="Source range starts" name="start" type="date" defaultValue={`${base.slice(0, 7)}-01`} required /><Field label="Source range ends" name="end" type="date" defaultValue={dayPlus(`${base.slice(0, 7)}-01`, new Date(Number(base.slice(0, 4)), Number(base.slice(5, 7)), 0).getDate() - 1)} required /></div><Button primary disabled={busy}>Get sourced answer <ArrowRight size={16} /></Button></form></section>{answer && <section className="assistant-answer"><span className="section-label">ANSWER FROM YOUR WORKSPACE</span><h2>{answer.answer}</h2><div className="answer-provenance"><span>Source: {answer.source}</span><span>Range: {answer.start} – {answer.end}</span><span>Scope: {ROLE_LABEL[answer.scope.role]} · {answer.scope.branches.length} assigned branches</span><span>Refreshed: {answer.refreshed_at}</span></div>{answer.records.length > 0 && <div className="table-scroll"><table className="data-table"><thead><tr>{Object.keys(answer.records[0]).map(k => <th key={k}>{k.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{answer.records.slice(0, 100).map((r, i) => <tr key={i}>{Object.entries(r).map(([key, v], j) => <td key={j}>{String(key === 'branch' ? data.branches.find(b => b.id === v)?.name || v : v)}</td>)}</tr>)}</tbody></table></div>}<p className="help">No messages are sent to an external model. Responses do not authorize mutations and never use leave reasons to infer sickness.</p></section>}</>
}

function LeaveLedger({ initial, employee, data, run, refresh, busy }) {
  const [ledger, setLedger] = useState(initial)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const b = ledger.balance
  const rows = [...ledger.entries.map(r => ({ ...r, state: 'Posted' })), ...ledger.unposted_earned.map(r => ({ ...r, reason: 'Configured accrual projection', state: 'Earned · not posted yet' }))].sort((a, b) => a.effective.localeCompare(b.effective))
  const admin = ['owner', 'admin'].includes(data.user.role)
  return <><p><strong>{employee.name}</strong> · {b.period_start}–{b.period_end} · {b.accrual.replaceAll('_', ' ')}</p><div className="quality-grid"><p><strong>{b.earned}d</strong> earned</p><p><strong>{b.carryover}d</strong> carryover</p><p><strong>{b.consumed}d</strong> consumed</p><p><strong>{b.reserved}d</strong> future reservations</p></div><p>{b.remaining}d available after all reservations now; {b.projected_remaining}d projected at period end. Future bookings can depend on projected accrual, which is checked at each charged date.</p><form onSubmit={e => { const d = formData(e); run(async () => setLedger(await api(`/leave/ledger?employee=${employee.id}&on=${d.on}`))) }}><Field label="Ledger as of" name="on" type="date" defaultValue={b.on} required /><Button disabled={busy}>View period</Button></form><div className="table-scroll"><table className="data-table"><thead><tr><th>Effective</th><th>Entry</th><th>Days</th><th>Reason</th><th>State</th></tr></thead><tbody>{rows.map(r => <tr key={r.source}><td>{r.effective}</td><td>{r.kind}</td><td>{r.days > 0 ? '+' : ''}{r.days}d</td><td>{r.reason}</td><td>{r.state}</td></tr>)}</tbody></table></div>{admin && <form className="ledger-adjustment" onSubmit={e => { const form = e.currentTarget; const d = formData(e); run(async () => { await api('/leave/adjust', { employee: employee.id, days: Number(d.days), effective: d.effective, reason: d.reason, idempotency_key: key }); setLedger(await api(`/leave/ledger?employee=${employee.id}&on=${b.on}`)); await refresh(); form.reset(); setKey(crypto.randomUUID()) }) }}><h3>Reasoned balance adjustment</h3><div className="form-grid"><Field label="Adjustment days (positive or negative)" name="days" type="number" min="-366" max="366" step="0.0001" required /><Field label="Adjustment effective date" name="effective" type="date" defaultValue={today(data.settings.timezone)} required /><Field label="Adjustment reason" name="reason" maxLength={500} required /></div><p className="help">Entries are appended and cannot be overwritten. Corrections require a new signed adjustment. Requests that would leave approved bookings unfunded are rejected.</p><Button primary disabled={busy}>Post adjustment</Button></form>}</>
}

function BillingManage({ run, busy }) {
  const [billing,setBilling] = useState(null)
  useEffect(() => { const controller=new AbortController(); api('/billing',undefined,controller.signal).then(setBilling).catch(() => {}); return () => controller.abort() },[])
  if (!billing) return null
  return <section className="panel"><h2>Subscription</h2><p>Status: {billing.status.replaceAll('_',' ')}.</p>{billing.portal_available ? <Button disabled={busy} onClick={() => run(() => openBillingProvider('/billing/portal',{}))}>Manage subscription</Button> : <p>Subscription management is not available yet.</p>}</section>
}

function Account({ data, run, busy, signedOut }) {
  const [sessions, setSessions] = useState(null)
  const [loadError, setLoadError] = useState('')
  useEffect(() => { const controller = new AbortController(); api('/sessions', undefined, controller.signal).then(setSessions).catch(e => { if (e.name !== 'AbortError') setLoadError(e.message) }); return () => controller.abort() }, [])
  return <>{data.user.role === 'owner' && <BillingManage run={run} busy={busy} />}<section className="panel"><h2>Your active sessions</h2><p>Local sessions expire after 30 idle minutes or 12 hours. Password changes and account scope changes revoke existing sessions.</p>{loadError && <p role="alert">{loadError}</p>}{!sessions ? <p>Loading sessions…</p> : <><div className="table-scroll"><table className="data-table"><thead><tr><th>Started</th><th>Last active</th><th>Session</th><th>Action</th></tr></thead><tbody>{sessions.map(s => <tr key={s.id}><td>{new Date(s.created * 1000).toLocaleString()}</td><td>{new Date(s.last_seen * 1000).toLocaleString()}</td><td>{s.current ? 'This session' : 'Other local session'}</td><td>{!s.current && <Button disabled={busy} onClick={() => run(async () => { await api('/sessions/revoke', { id: s.id }); setSessions(await api('/sessions')) })}>Revoke session</Button>}</td></tr>)}</tbody></table></div><Button disabled={busy} onClick={() => run(async () => { await api('/sessions/revoke', { all_others: true }); setSessions(await api('/sessions')) })}>Sign out other sessions</Button></>}</section><section className="panel"><h2>Change your local password</h2><form onSubmit={e => { const d = formData(e); run(async () => { await api('/password', d); signedOut() }) }}><div className="form-grid"><Field label="Current password" name="current_password" type="password" autoComplete="current-password" required /><Field label="New password" name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></div><p className="help">Changing your password signs out all sessions. Live recovery delivery, MFA and external identity providers require separate configuration.</p><Button primary disabled={busy}>Change password & sign out</Button></form></section><p className="help">Signed in as {data.user.email} · {ROLE_LABEL[data.user.role]}.</p></>
}

function CalendarSummary({ data, week }) {
  const [calendar, setCalendar] = useState(null)
  useEffect(() => { const controller = new AbortController(); api(`/calendar?day=${week}`, undefined, controller.signal).then(setCalendar).catch(() => {}); return () => controller.abort() }, [data, week])
  return calendar && <div className="calendar-summary"><span>Pay period <strong>{calendar.pay.start}–{calendar.pay.end}</strong></span><span>Fiscal period <strong>{calendar.fiscal.start}–{calendar.fiscal.end}</strong></span><span>{calendar.planning.days}-day planning period · policy v{calendar.policy.revision}</span></div>
}
