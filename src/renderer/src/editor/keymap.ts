import { Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView, type KeyBinding } from '@codemirror/view'
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { foldKeymap, language } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { COMMANDS, isChord, isMacPlatform, keysOf, normalizeStroke, toCodeMirrorKey } from '@shared/keybindings'
import type { MenuCommand, Platform } from '@shared/types'
import { runFormat, type FormatCommand } from './commands'
import { pasteAndIndent, runEditorCommand } from './sublime'

/** Run a registry command that acts on an editor view. */
export function editorCommand(id: MenuCommand, view: EditorView): boolean {
  // Markdown formatting (⌘B, ⌃⌘1…) only applies to Markdown, not to code or plain text.
  if (id.startsWith('format-')) return view.state.facet(language)?.name === 'markdown' && runFormat(view, id.slice(7) as FormatCommand)
  if (id === 'paste-indent') {
    void window.mf.readClipboardText().then((text) => {
      if (text) pasteAndIndent(view, text)
    })
    return true
  }
  return runEditorCommand(id, view)
}

const CM_TO_KEY: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' }

/** "Shift-Mod-k" → "Shift+Cmd+K" (mac) / "Ctrl+Shift+K" (others), for collision checks. */
function cmKeyToStroke(cmKey: string, mac: boolean): string {
  const parts = cmKey.split(/-(?!$)/)
  const key = parts.pop()!
  const mods = parts.map((m) => (m === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : m === 'Meta' ? 'Cmd' : m))
  return normalizeStroke([...mods, CM_TO_KEY[key] ?? key].join('+'))
}

/** Strokes owned by the shared registry on this platform. */
function claimedStrokes(platform: Platform): Set<string> {
  const set = new Set<string>()
  for (const def of COMMANDS) {
    if (def.native) continue
    for (const k of keysOf(def, platform)) if (!isChord(k)) set.add(normalizeStroke(k))
  }
  return set
}

/**
 * CodeMirror's default bindings minus those that collide with MarkFlow / Sublime shortcuts,
 * so a key always means the same thing whether the editor or the menu sees it first.
 */
export function baseKeymap(platform: Platform): Extension {
  const mac = isMacPlatform(platform)
  const claimed = claimedStrokes(platform)
  const keep = (b: KeyBinding) => {
    const k = (mac ? b.mac : b.win ?? b.linux) ?? b.key
    return !k || !claimed.has(cmKeyToStroke(k, mac))
  }
  return keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap].filter(keep).concat(indentWithTab))
}

/** Highest-precedence bindings for every editor-scope command in the registry. */
export function sublimeKeymap(platform: Platform): Extension {
  const bindings: KeyBinding[] = []
  for (const def of COMMANDS) {
    if (def.scope !== 'editor' || def.native) continue
    for (const k of keysOf(def, platform)) {
      if (isChord(k)) continue
      bindings.push({ key: toCodeMirrorKey(k), run: (view) => editorCommand(def.id, view), preventDefault: true })
    }
  }
  return Prec.highest(keymap.of(bindings))
}
