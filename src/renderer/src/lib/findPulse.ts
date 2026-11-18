/**
 * The "bounce" that shows where a find landed, like find-on-page in Safari: a copy of the match
 * pops up over it, zooms and settles back, leaving the persistent highlight underneath.
 */
export interface MatchRect {
  left: number
  top: number
  width: number
  height: number
}

let active: HTMLElement | null = null

/** Short matches can zoom a lot; a long one would cover half the page. */
function zoomFor(width: number): number {
  if (width <= 60) return 1.75
  if (width <= 200) return 1.45
  if (width <= 500) return 1.2
  return 1.06
}

/**
 * `text` is drawn in `font` right over the match. Without text (a match spanning several lines)
 * only a glowing outline is shown.
 */
export function showMatchPulse(rect: MatchRect, text?: string, font?: CSSStyleDeclaration | null): void {
  active?.remove()
  const el = document.createElement('div')
  el.className = text ? 'mf-find-pulse' : 'mf-find-pulse outline'
  el.setAttribute('aria-hidden', 'true')
  const pad = 2
  el.style.left = `${rect.left - pad}px`
  el.style.top = `${rect.top - pad}px`
  el.style.width = `${rect.width + pad * 2}px`
  el.style.height = `${rect.height + pad * 2}px`
  el.style.setProperty('--pulse-zoom', String(zoomFor(rect.width)))
  if (text) {
    el.textContent = text
    if (font) {
      el.style.fontFamily = font.fontFamily
      el.style.fontSize = font.fontSize
      el.style.fontWeight = font.fontWeight
      el.style.fontStyle = font.fontStyle
    }
  }
  el.addEventListener('animationend', () => {
    el.remove()
    if (active === el) active = null
  })
  document.body.appendChild(el)
  active = el
}

/** Pulse a DOM range (a match in the rendered preview). */
export function pulseRange(range: Range): void {
  const rects = range.getClientRects()
  if (!rects.length) return
  const parent = range.startContainer.parentElement
  if (rects.length === 1) {
    showMatchPulse(rects[0], range.toString(), parent ? getComputedStyle(parent) : null)
  } else {
    showMatchPulse(range.getBoundingClientRect())
  }
}
