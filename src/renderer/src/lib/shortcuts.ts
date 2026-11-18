/**
 * Shortcuts the menu bar can't deliver: alternates (⌃Tab, ⇧⌘], …), find-field toggles
 * (⌥⌘R / ⌥⌘W) and ⌘K chords, which the main process intercepts and forwards.
 */
import { runMenuCommand } from '@/actions'
import { getState, setState } from '@/store'
import { COMMAND_MAP, COMMANDS, commandForKey, displayKey, isChord, keysOf, normalizeStroke, rendererOnlyKeys, strokeFromEvent } from '@shared/keybindings'
import type { MenuCommand } from '@shared/types'

const FIND_FIELDS = '.cm-find-panel, .findbar, .search-box'

function localKeys(platform: string): Map<string, MenuCommand> {
  const map = new Map<string, MenuCommand>()
  for (const { key, command } of rendererOnlyKeys(platform)) map.set(normalizeStroke(key), command)
  // "native" global shortcuts have no menu accelerator, so they are dispatched here.
  for (const def of COMMANDS) {
    if (!def.native || def.scope !== 'global') continue
    for (const k of keysOf(def, platform)) if (!isChord(k)) map.set(normalizeStroke(k), def.id)
  }
  return map
}

export function installShortcuts(): () => void {
  const platform = getState().platform
  const keys = localKeys(platform)

  const onKeyDown = (e: KeyboardEvent) => {
    // CodeMirror marks the keys it handled; the menu has already taken its accelerators.
    if (e.defaultPrevented || e.isComposing) return
    const stroke = strokeFromEvent(e, platform)
    if (!stroke) return
    const id = keys.get(normalizeStroke(stroke))
    if (!id) return
    const target = e.target as HTMLElement | null
    if (id.startsWith('find-toggle-') && !target?.closest?.(FIND_FIELDS)) return
    if (COMMAND_MAP.get(id)?.scope === 'editor' && target?.closest?.('.cm-editor')) return
    e.preventDefault()
    e.stopPropagation()
    runMenuCommand(id)
  }
  window.addEventListener('keydown', onKeyDown)

  const offChord = window.mf.onChord((key) => {
    const id = commandForKey(key, platform)
    if (id) runMenuCommand(id)
  })
  const offPending = window.mf.onChordPending((prefix) => {
    setState({ chordPending: prefix ? displayKey(prefix, platform) : null })
  })

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    offChord()
    offPending()
  }
}
