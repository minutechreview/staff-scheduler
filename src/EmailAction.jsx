import { useEffect, useRef, useState } from 'react'
import { api, setAcceptanceSecret } from './api'

export default function EmailAction({ action, brand, onNavigate, onForget }) {
  const code = useRef(action.code)
  const [phase, setPhase] = useState(action.error ? 'invalid' : 'loading')
  const [message, setMessage] = useState(action.error || '')
  const [password, setPassword] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [passwordSetupRequired, setPasswordSetupRequired] = useState(false)
  const [workspaceDetailsRequired, setWorkspaceDetailsRequired] = useState(false)
  const [ownerName, setOwnerName] = useState('')
  const [organization, setOrganization] = useState('')
  const [acceptanceRequired, setAcceptanceRequired] = useState(false)
  const [acceptanceCode, setAcceptanceCode] = useState('')
  const request = useRef(null)
  const locked = useRef(false)
  const mounted = useRef(false)
  const reset = action.mode === 'resetPassword'
  const pending = ['checking', 'saving'].includes(phase)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current?.abort(); code.current = '' }
  }, [])
  useEffect(() => {
    // StrictMode's initial cleanup must not erase a still-mounted action code.
    code.current = action.code
  }, [action.code])
  useEffect(() => {
    if (action.error) return
    const controller = new AbortController()
    api('/capabilities', undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setAcceptanceRequired(Boolean(result.signup_invite_required))
      setPhase(result.email_actions ? 'ready' : 'unavailable')
      if (!result.email_actions) setMessage('Email actions are unavailable in this preview. Use the original email link when the service is available.')
    }).catch(error => {
      if (controller.signal.aborted) return
      setPhase('unavailable')
      setMessage(error.status === 503 ? 'The service is currently paused or unavailable. No email action was submitted.' : 'Availability could not be checked. No email action was submitted.')
    })
    return () => controller.abort()
  }, [action.error, attempt])
  useEffect(() => {
    const leave = () => { request.current?.abort(); code.current = ''; setAcceptanceSecret(''); onNavigate('landing') }
    const hide = () => { request.current?.abort(); code.current = ''; setAcceptanceSecret(''); onForget() }
    const show = event => { if (event.persisted) { setAcceptanceSecret(''); setPhase('invalid'); setMessage('Reopen the original email link to continue.'); onForget() } }
    window.addEventListener('popstate', leave)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    return () => { setAcceptanceSecret(''); window.removeEventListener('popstate', leave); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show) }
  }, [onNavigate, onForget])

  function forget() { code.current = ''; setPassword(''); setOwnerName(''); setOrganization(''); setAcceptanceCode(''); setAcceptanceSecret(''); onForget() }
  function stopWaiting() {
    request.current?.abort()
    setPassword(''); setPhase('uncertain')
    setMessage('Stopped waiting. This does not undo a submitted action; it may still complete. Try signing in or explicitly check the link status.')
  }
  async function perform(checkOnly = false) {
    if (locked.current || !code.current || (!checkOnly && phase !== 'ready')) return
    if (acceptanceRequired) setAcceptanceSecret(acceptanceCode)
    locked.current = true
    const controller = new AbortController()
    request.current = controller
    let completing = false
    const timeout = setTimeout(() => { if (mounted.current && request.current === controller) stopWaiting() }, 50000)
    setPhase('checking'); setMessage('Checking the link…')
    try {
      const checked = await api('/auth/action/check', { mode: action.mode, code: code.current }, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      if (checked.submitted_before) {
        setPassword(''); setPhase('uncertain'); setMessage('This link was already submitted. Its outcome may still be pending. Try signing in or request a fresh link; this action will not be submitted again.'); return
      }
      if (reset && checked.workspace_details_required && !workspaceDetailsRequired) {
        setWorkspaceDetailsRequired(true); setPhase('ready'); setMessage('Confirm your name and workspace name to finish reclaiming this address.'); return
      }
      if (checkOnly) { setPhase('ready'); setMessage('The link is still valid. You can explicitly submit the action again.'); return }
      completing = true
      setPhase('saving'); setMessage(reset ? 'Updating your password…' : 'Verifying your email…')
      const completed = await api('/auth/action/complete', { mode: action.mode, code: code.current, ...(reset ? { password } : {}), ...(workspaceDetailsRequired ? { name: ownerName, organization } : {}) }, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      forget(); setPhase('done')
      setPasswordSetupRequired(Boolean(completed.password_setup_required))
      setMessage(reset ? (completed.verification_required ? 'Password updated. Check your inbox for a verification link before signing in.' : 'Password updated. Previous sessions are signed out. Sign in with your new password.') : completed.password_setup_required ? 'Email verified. Check your inbox for a password setup link before signing in. If it does not arrive, request a new link from the sign-in page.' : 'Email verified. Sign in to continue setting up your workspace.')
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return
      setPassword('')
      if ([401, 422].includes(error.status)) {
        forget(); setPhase('invalid'); setMessage('This link is invalid, expired or already used. Try signing in, or request a new link.')
      } else if (completing) {
        setPhase('uncertain'); setMessage('The result could not be confirmed. The action may have completed. Try signing in or check the link status before submitting again. Nothing will be retried automatically.')
      } else {
        setPhase('uncertain'); setMessage(error.status === 429 ? 'Too many attempts. Wait before checking the link again.' : 'The link could not be checked. Check its status when the service is available. Nothing was submitted for completion.')
      }
    } finally { clearTimeout(timeout); if (request.current === controller) locked.current = false }
  }
  const heading = reset ? 'Reset your password.' : action.mode === 'verifyEmail' ? 'Verify your email.' : 'Check your email link.'
  return <div className="auth-page"><aside className="auth-story" aria-label="About Relay">{brand}<h1>A clear path<br />back to<br /><span>your workspace.</span></h1><p>Email actions complete here. Continue by signing in after success.</p></aside><main className="auth-form" aria-busy={pending}>
    <button className="text-button" disabled={pending} onClick={() => { forget(); onNavigate('signin') }}>Back to sign in</button>
    <span className="section-label">ACCOUNT ACCESS</span><h2>{heading}</h2>
    <p>Complete this step to return to your workspace. For your security, this link is not kept after you leave or reload.</p>
    {phase === 'ready' && <form onSubmit={event => { event.preventDefault(); perform() }}>
      {acceptanceRequired && <label className="field"><span>Acceptance access code</span><input type="password" value={acceptanceCode} onChange={event => setAcceptanceCode(event.target.value)} minLength={64} maxLength={64} autoComplete="off" required /></label>}
      {reset && <label className="field"><span>New password</span><input type="password" name="password" minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>}
      {reset && workspaceDetailsRequired && <><label className="field"><span>Your name</span><input name="name" value={ownerName} onChange={event => setOwnerName(event.target.value)} maxLength={100} autoComplete="name" required /></label><label className="field"><span>Workspace name</span><input name="organization" value={organization} onChange={event => setOrganization(event.target.value)} maxLength={100} autoComplete="organization" required /></label></>}
      <button className="button primary" disabled={pending}>{reset ? 'Reset password' : 'Verify email'}</button>
    </form>}
    {message && <div className="inline-warning" style={phase === 'done' ? { background: 'var(--green-bg)', color: 'var(--green)', borderColor: 'transparent' } : undefined} role={['invalid', 'unavailable', 'uncertain'].includes(phase) ? 'alert' : 'status'}>{message}</div>}
    {phase === 'loading' && <p role="status">Checking service availability…</p>}
    {pending && <button className="button" type="button" onClick={stopWaiting}>Stop waiting</button>}
    {phase === 'unavailable' && <button className="button" onClick={() => { setPhase('loading'); setAttempt(value => value + 1) }}>Check availability</button>}
    {phase === 'uncertain' && <button className="button" disabled={pending} onClick={() => perform(true)}>Check link status</button>}
    {phase === 'done' && <button className="button primary" onClick={() => onNavigate('signin')}>{passwordSetupRequired ? 'Back to sign in' : 'Continue to sign in'}</button>}
    <p className="help">If you close this page before seeing confirmation, try signing in or reopen the original email. Do not share the link.</p>
  </main></div>
}
