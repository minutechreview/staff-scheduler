import { useState, useRef, useEffect } from 'react'
import { db } from '../firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'

const CATEGORIES = [
  { id: 'schedule', label: 'Schedule', icon: '📅' },
  { id: 'staff', label: 'Staff', icon: '👥' },
  { id: 'theme', label: 'Theme / UI', icon: '🎨' },
  { id: 'leave', label: 'Leave Plan', icon: '🌴' },
  { id: 'feature', label: 'Request Feature', icon: '💡' },
  { id: 'other', label: 'Other', icon: '💬' },
]

const TELEGRAM_BOT_TOKEN = import.meta.env.VITE_TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = import.meta.env.VITE_TELEGRAM_CHAT_ID

export default function FeedbackButton() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(1)
  const [category, setCategory] = useState('')
  const [message, setMessage] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef(null)
  const sheetRef = useRef(null)

  // Focus textarea when reaching step 2
  useEffect(() => {
    if (step === 2 && textareaRef.current) {
      setTimeout(() => textareaRef.current.focus(), 300)
    }
  }, [step])

  // Close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') handleClose()
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Close on click outside
  useEffect(() => {
    function onClick(e) {
      if (sheetRef.current && !sheetRef.current.contains(e.target)) {
        // Only close if clicking the backdrop, not the FAB
        if (!e.target.closest('[data-feedback-fab]')) {
          handleClose()
        }
      }
    }
    if (open) {
      // Small delay to avoid immediate close on open
      const t = setTimeout(() => document.addEventListener('mousedown', onClick), 100)
      return () => {
        clearTimeout(t)
        document.removeEventListener('mousedown', onClick)
      }
    }
  }, [open])

  function handleClose() {
    setOpen(false)
    setTimeout(() => {
      setStep(1)
      setCategory('')
      setMessage('')
      setName('')
      setSent(false)
      setError('')
      setSubmitting(false)
    }, 300)
  }

  function selectCategory(catId) {
    setCategory(catId)
    setStep(2)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!message.trim() || submitting) return

    setSubmitting(true)
    setError('')

    const catLabel = CATEGORIES.find(c => c.id === category)?.label || category
    const payload = {
      category,
      categoryLabel: catLabel,
      message: message.trim(),
      name: name.trim() || 'Anonymous',
      createdAt: serverTimestamp(),
      userAgent: navigator.userAgent,
      url: window.location.href,
      resolved: false,
    }

    try {
      // 1. Save to Firestore
      await addDoc(collection(db, 'feedback'), payload)

      // 2. Send Telegram notification
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const telegramText = `
🎫 <b>New Scheduler Feedback</b>

<b>Category:</b> ${catLabel}
<b>From:</b> ${name.trim() || 'Anonymous'}
<b>Message:</b>
${message.trim()}

<i>${new Date().toLocaleString()}</i>
        `.trim()

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: telegramText,
            parse_mode: 'HTML',
          }),
        })
      }

      setSent(true)
      setTimeout(() => handleClose(), 2500)
    } catch (err) {
      console.error('Feedback submit error:', err)
      setError('Failed to send. Please try again or contact support directly.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {/* Floating Action Button */}
      <button
        data-feedback-fab
        onClick={() => setOpen(!open)}
        className={`
          fixed bottom-5 right-5 z-[100]
          w-11 h-11 md:w-14 md:h-14 rounded-full
          flex items-center justify-center
          shadow-lg shadow-black/30
          transition-all duration-300 ease-out
          active:scale-90
          ${open
            ? 'bg-red-500 hover:bg-red-600 rotate-45'
            : 'bg-[#006241] hover:bg-[#00704A] hover:scale-110'
          }
        `}
        aria-label={open ? 'Close feedback' : 'Send feedback'}
      >
        {open ? (
          <svg className="w-5 h-5 md:w-6 md:h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-5 h-5 md:w-6 md:h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        )}
      </button>

      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm transition-opacity" />
      )}

      {/* Bottom Sheet / Modal */}
      <div
        ref={sheetRef}
        className={`
          fixed z-[95] transition-all duration-300 ease-out
          ${open ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full pointer-events-none'}
          bottom-0 left-0 right-0
          sm:bottom-auto sm:left-auto sm:right-5 sm:top-auto
          sm:w-[400px] sm:rounded-2xl sm:mb-24
          rounded-t-2xl
          bg-surface-panel border border-border-subtle
          shadow-2xl shadow-black/40
          max-h-[85vh] overflow-hidden flex flex-col
        `}
        style={{ marginBottom: open ? undefined : undefined }}
      >
        {/* Handle bar (mobile) */}
        <div className="w-full flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-10 h-1 rounded-full bg-border-subtle" />
        </div>

        {/* Header */}
        <div className="px-5 pt-2 pb-3 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-content-main">
              {sent
                ? 'Thank You!'
                : step === 1
                  ? 'Send Feedback'
                  : category === 'feature'
                    ? 'Request a Feature'
                    : 'Describe the Issue'}
            </h3>
            <p className="text-xs text-content-muted mt-0.5">
              {sent
                ? 'Your feedback has been logged.'
                : step === 1
                  ? 'What would you like to share?'
                  : `${CATEGORIES.find(c => c.id === category)?.label} — tell us more`
              }
            </p>
          </div>
          {step === 2 && !sent && (
            <button
              onClick={() => setStep(1)}
              className="text-xs text-brand-primary hover:underline"
            >
              Back
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {sent ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-content-main font-medium">Ticket submitted successfully</p>
              <p className="text-xs text-content-muted mt-1">You'll be notified when it's resolved.</p>
            </div>
          ) : step === 1 ? (
            <div className="grid grid-cols-2 gap-3">
              {CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => selectCategory(cat.id)}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border-subtle bg-surface-root hover:bg-surface-hover hover:border-brand-primary/40 transition-all active:scale-95 text-center"
                >
                  <span className="text-2xl">{cat.icon}</span>
                  <span className="text-xs font-medium text-content-main">{cat.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-content-muted mb-1.5">
                  Your Name <span className="text-content-muted/50">(optional)</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Alex"
                  className="w-full px-3 py-2.5 rounded-lg bg-surface-root border border-border-subtle text-sm text-content-main placeholder:text-content-muted/40 focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-content-muted mb-1.5">
                  Details <span className="text-red-400">*</span>
                </label>
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder={category === 'feature'
                    ? "Describe the feature you'd like to see..."
                    : "Describe the issue or suggestion..."
                  }
                  rows={4}
                  required
                  className="w-full px-3 py-2.5 rounded-lg bg-surface-root border border-border-subtle text-sm text-content-main placeholder:text-content-muted/40 focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20 resize-none"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-content-muted/50">
                    {message.length}/500
                  </span>
                </div>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={!message.trim() || submitting}
                className={`
                  w-full py-3 rounded-xl text-sm font-semibold text-white
                  transition-all active:scale-[0.98]
                  flex items-center justify-center gap-2
                  ${message.trim() && !submitting
                    ? 'bg-[#006241] hover:bg-[#00704A] shadow-lg shadow-[#006241]/20'
                    : 'bg-white/10 opacity-50 cursor-not-allowed'
                  }
                `}
              >
                {submitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-t-transparent border-white rounded-full animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    Submit Ticket
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  )
}
