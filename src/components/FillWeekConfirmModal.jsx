export default function FillWeekConfirmModal({ store, staffCount, filling, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-[#162118] rounded-2xl border border-border-subtle w-full max-w-sm shadow-2xl">
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#1a3a2a] border border-brand-primary/50 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-[#296044]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-content-main">Fill Week</div>
              <div className="text-xs text-content-muted mt-0.5">{store.name}</div>
            </div>
          </div>
          <p className="text-xs text-content-muted leading-relaxed">
            Auto-generate a schedule for all <span className="text-content-main">{staffCount} staff</span> following store rules
            (correct days off, SIC AM+PM coverage, fair AM/PM rotation).
            Existing Leave and Support entries will be preserved.
          </p>
          <div className="flex gap-2 pt-1">
            <button onClick={onCancel} className="flex-1 px-4 py-2 rounded-lg bg-surface-panel hover:bg-surface-panel text-content-muted text-sm transition-colors">
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={filling}
              className="flex-1 px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-hover disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              {filling ? 'Filling…' : 'Fill Week'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
