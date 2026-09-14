/**
 * Settings-nav icon decoration for this plugin's own row (子代理库).
 *
 * The official settings shell's navIcon(id) table is closed — official ids
 * get drawn icons and everything else falls back to a generic gear. This
 * replaces that fallback <svg> inside OUR nav button (matched by our own
 * registered label text) with the drawn robot-head icon. A MutationObserver
 * re-applies the icon when the panel re-renders; gated on the settings
 * dialog being present so idle chat streams never pay the query cost.
 */

const NAV_ICON_INNER =
  '<path d="M8 6.5V3.9"/>'
  + '<circle cx="8" cy="2.6" r="0.85"/>'
  + '<rect x="3.25" y="6.5" width="9.5" height="6.5" rx="1.5"/>'
  + '<path d="M5.75 9.25v1.25"/>'
  + '<path d="M10.25 9.25v1.25"/>'
  + '<path d="M1.75 9.25h1.5"/>'
  + '<path d="M12.75 9.25h1.5"/>'

const NAV_LABELS = new Set(['子代理库'])

interface EffectCapableContext {
  // Loose on purpose: cordis effect signatures vary across harness builds and
  // the decoration only forwards its own (fn, label) pair.
  effect: (...args: any[]) => unknown
}

export function decorateSettingsNavIcon(ctx: EffectCapableContext): void {
  ctx.effect(() => {
    const decorate = (): void => {
      if (document.querySelector('[role="dialog"]') === null) return
      for (const button of Array.from(document.querySelectorAll('button'))) {
        const label = button.querySelector(':scope > span')
        if (label === null || !NAV_LABELS.has(label.textContent ?? '')) continue
        const existing = button.firstElementChild
        if (existing instanceof SVGElement) {
          if (existing.dataset.navIcon === '1') continue
          const template = document.createElement('template')
          template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-nav-icon="1">${NAV_ICON_INNER}</svg>`
          existing.replaceWith(template.content.firstElementChild as SVGElement)
        }
      }
    }
    const observer = new MutationObserver(() => decorate())
    observer.observe(document.body, { childList: true, subtree: true })
    decorate()
    return () => observer.disconnect()
  }, 'subagent-library: nav icon decoration')
}
