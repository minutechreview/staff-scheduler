import { useCallback, useEffect, useRef, useState } from 'react'
import EmailAction from './EmailAction'
import { api } from './api'
import { parsePreviewEmailLink } from './previewEmailLink.mjs'

function PreviewBrand() { return <strong className="brand light">relay<span className="brand-dot">.</span></strong> }

export default function PreviewEmailActionEntry() {
  const [config, setConfig] = useState(null)
  const [screen, setScreen] = useState('welcome')
  const [action, setAction] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState(null)
  const [signupAttempted, setSignupAttempted] = useState(false)
  const [resetAttempted, setResetAttempted] = useState(false)
  const [now, setNow] = useState(() => Date.now() / 1000)
  const locked = useRef(false)
  const request = useRef(null)
  const generation = useRef(0)
  const active = config && now >= config.starts_at && now < config.expires_at
  const navigate = useCallback(next => { setAction(null); setLink(''); setPassword(''); setScreen(next === 'signin' ? 'signin' : 'welcome') }, [])
  const forget = useCallback(() => setAction(old => old ? { ...old, code: '' } : old), [])

  useEffect(() => {
    // This preview accepts links only in the form, never through a URL.
    const hadAction = window.location.search || window.location.hash
    window.history.replaceState(null, '', window.location.pathname)
    if (hadAction) setError('URL actions are not accepted. Copy the original email link into the protected form.')
    const controller = new AbortController()
    api('/preview', undefined, controller.signal).then(setConfig).catch(error => {
      if (!controller.signal.aborted) setError(error.message)
    })
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000)
    const hide = () => { generation.current++; request.current?.abort(); setLink(''); setPassword(''); setAction(null) }
    window.addEventListener('pagehide', hide)
    window.addEventListener('popstate', hide)
    return () => { controller.abort(); request.current?.abort(); clearInterval(tick); window.removeEventListener('pagehide', hide); window.removeEventListener('popstate', hide) }
  }, [])

  useEffect(() => {
    if (config && !active) {
      generation.current++; request.current?.abort(); setLink(''); setPassword(''); setAction(null)
    }
  }, [active, config])

  async function run(operation, type) {
    if (locked.current || !active) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    const controller = new AbortController(); request.current = controller
    const timer = setTimeout(() => controller.abort(), 50000)
    try {
      if (type === 'signup') setSignupAttempted(true)
      if (type === 'reset') setResetAttempted(true)
      await operation(controller.signal)
    } catch (error) {
      if (error.status === 401) setSession(null)
      setError(error.name === 'AbortError' ? 'Stopped waiting. The request may have completed. No send will be retried; ask the operator to check the result.' : error.message)
    } finally { clearTimeout(timer); locked.current = false; setBusy(false); setPassword('') }
  }

  if (action && active) return <EmailAction action={action} brand={<PreviewBrand />} onNavigate={navigate} onForget={forget} />
  return <div className="auth-page email-preview-page">
    <aside className="auth-story"><PreviewBrand /><h1>One inbox.<br />Two messages.<br /><span>A bounded test.</span></h1><p>Relay staging test. Protected owner access and a fictional workspace.</p><p>Enter passwords and email links yourself. Keep automation and recordings paused for those steps.</p></aside>
    <main className="auth-form" aria-busy={busy}>
      <span className="section-label">PROTECTED EMAIL ACCEPTANCE</span><h2>{screen === 'signup' ? 'Create the test account.' : screen === 'signin' ? 'Sign in to the test account.' : screen === 'paste' ? 'Paste your email link.' : 'Relay staging test.'}</h2>
      {!config && !error && <p role="status">Checking the approved preview window…</p>}
      {config && <><p>Approved inbox: <strong>{config.recipient}</strong></p><p className="help">Window ends {new Date(config.expires_at * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC. One verification and one reset attempt; no resends.</p></>}
      {config && !active && <div className="inline-warning" role="alert">The preview window is closed. No account or email action can be submitted.</div>}
      {error && <div className="inline-warning" role="alert">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {active && screen === 'welcome' && <>
        <ol className="preview-checklist"><li>Create the fictional account and request one verification message.</li><li>Copy the message link into this preview, verify, then sign in.</li><li>Request one reset, paste its link and choose a new staging password.</li></ol>
        <div className="preview-actions">
        <button className="button primary" disabled={busy || signupAttempted} onClick={() => setScreen('signup')}>Create test account</button>
        <button className="button" disabled={busy} onClick={() => setScreen('paste')}>Paste email link</button>
        <button className="button" disabled={busy} onClick={() => setScreen('signin')}>Sign in</button>
        <button className="button" disabled={busy} onClick={() => run(async signal => { const result = await api('/me', undefined, signal); setSession(result.user); setNotice('The current test session is valid.') })}>Check current session</button>
        <button className="button" disabled={busy || !session || resetAttempted} onClick={() => run(async signal => { const result = await api('/recovery/request', { email: config.recipient }, signal); setNotice(result.message) }, 'reset')}>Request the one reset email</button>
        {session && <><p className="help">Signed in as {session.email}. Workspace: Relay email acceptance.</p><button className="button" disabled={busy} onClick={() => run(async signal => { await api('/signout', {}, signal); setSession(null); setNotice('Signed out of the test workspace.') })}>Sign out</button></>}
        </div>
      </>}
      {active && ['signup', 'signin'].includes(screen) && <form onSubmit={event => {
        event.preventDefault()
        const signup = screen === 'signup'
        run(async signal => {
          const result = await api(signup ? '/signup' : '/signin', { email: config.recipient, password, ...(signup ? { name: 'Relay staging test', organization: 'Relay email acceptance' } : {}) }, signal)
          if (result.verification_required) setNotice(result.message)
          else { setSession(result.user); setNotice('Signed in to the fictional test workspace.') }
          setScreen('welcome')
        }, signup ? 'signup' : 'signin')
      }}>
        <label className="field"><span>Email</span><input type="email" value={config.recipient} readOnly autoComplete="username" /></label>
        <label className="field"><span>Staging password</span><input type="password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} autoComplete={screen === 'signup' ? 'new-password' : 'current-password'} required disabled={busy} /></label>
        <p className="help">Use a unique test password, never your Google-account password. Do not share it in chat.</p>
        <button className="button primary" disabled={busy || (screen === 'signup' && signupAttempted)}>{screen === 'signup' ? 'Create and request verification' : 'Sign in to test workspace'}</button>
      </form>}
      {active && screen === 'paste' && <form onSubmit={async event => {
        event.preventDefault()
        if (locked.current) return
        locked.current = true; setBusy(true); setError('')
        const pasted = link, current = generation.current; setLink('')
        try {
          const parsed = await parsePreviewEmailLink(pasted, config)
          if (current === generation.current && Date.now() / 1000 < config.expires_at) setAction(parsed)
        }
        catch (error) { setError(error.message) }
        finally { locked.current = false; setBusy(false) }
      }}>
        <label className="field"><span>Original email link</span><textarea value={link} onChange={event => setLink(event.target.value)} maxLength={4096} autoComplete="off" spellCheck="false" required disabled={busy} /></label>
        <p className="help">Copy the link without opening the default provider page. It is read in memory and is never added to this page’s URL or storage. Continuing here does not apply it.</p>
        <button className="button primary" disabled={busy}>Review this email action</button>
      </form>}
      {active && screen !== 'welcome' && <button className="text-button" disabled={busy} onClick={() => navigate('welcome')}>Back to test steps</button>}
      {busy && <button className="text-button" onClick={() => request.current?.abort()}>Stop waiting</button>}
      <p className="help">This preview has no staff or schedule editing. Direct email-to-app routing and provider expiry are separate acceptance gates.</p>
      <a href="/third-party-notices.html">License notices</a>
    </main>
  </div>
}
