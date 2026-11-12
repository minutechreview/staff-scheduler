export function installLandingMotion(element, environment = window) {
  const { document, IntersectionObserver } = environment
    const preference = environment.matchMedia('(prefers-reduced-motion: reduce)')
    const running = new Set()
    const cancel = () => { running.forEach(animation => animation.cancel()); running.clear() }
    const onPreference = () => { if (preference.matches) cancel() }
    const onVisibility = () => { if (document.hidden) cancel() }
    const observer = new IntersectionObserver(entries => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) return
        observer.unobserve(entry.target)
        if (preference.matches || document.hidden || entry.target.contains(document.activeElement)) return
        const animation = entry.target.animate([{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }], { duration: 520, delay: Math.min(index, 2) * 60, easing: 'cubic-bezier(.2,.65,.3,1)' })
        running.add(animation)
        animation.onfinish = () => running.delete(animation)
      })
    }, { threshold: 0.12 })
    element.querySelectorAll('.hero-copy > *, .hero-product, .how > div, .how li, .feature-grid article, .landing-cta').forEach(element => observer.observe(element))
    preference.addEventListener('change', onPreference)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { observer.disconnect(); cancel(); preference.removeEventListener('change', onPreference); document.removeEventListener('visibilitychange', onVisibility) }
}
