export default function IconBtn({ onClick, disabled, tooltip, icon, className = 'bg-surface-panel hover:bg-surface-panel text-content-muted hover:text-content-main' }) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors disabled:opacity-40 ${className}`}
      >
        {icon}
      </button>
      <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-[var(--tooltip-bg)] border border-border-subtle text-[var(--tooltip-text)] text-[10px] rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 z-50 transition-opacity">
        {tooltip}
      </span>
    </div>
  )
}
