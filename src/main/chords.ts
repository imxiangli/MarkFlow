import type { WebContents } from 'electron'
import { chordPrefix, normalizeStroke, strokeFromEvent } from '@shared/keybindings'

const CHORD_TIMEOUT = 2500

/**
 * Sublime-style two-stroke shortcuts (⌘K ⌘U …). Handled here, before the page and the
 * application menu see the keys, so the second stroke (e.g. ⌘B = bold) can't fire a menu item.
 * The renderer receives the full chord and runs the matching command.
 */
export function attachChords(wc: WebContents): void {
  const prefix = normalizeStroke(chordPrefix(process.platform))
  let pending = false
  let timer: NodeJS.Timeout | null = null

  const reset = () => {
    pending = false
    if (timer) clearTimeout(timer)
    timer = null
    if (!wc.isDestroyed()) wc.send('mf:chord-pending', null)
  }

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const stroke = strokeFromEvent(
      { code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift },
      process.platform
    )
    if (!stroke) return // modifier-only key: keep waiting
    if (pending) {
      event.preventDefault()
      reset()
      if (stroke !== 'Escape') wc.send('mf:chord', `${prefix} ${normalizeStroke(stroke)}`)
      return
    }
    if (normalizeStroke(stroke) === prefix && !input.isAutoRepeat) {
      event.preventDefault()
      pending = true
      wc.send('mf:chord-pending', prefix)
      timer = setTimeout(reset, CHORD_TIMEOUT)
    }
  })
}
