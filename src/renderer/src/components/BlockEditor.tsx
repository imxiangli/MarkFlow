import { useEffect, useRef } from 'react'
import { EditorSelection, EditorState, Prec } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { history } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { findExtensions } from '@/editor/findPanel'
import { markdownPaste } from '@/editor/paste'
import { languageFor, markdownHighlight } from '@/editor/setup'
import { baseKeymap, sublimeKeymap } from '@/editor/keymap'
import { useT } from '@/lib/i18n'
import { useStore } from '@/store'

const inlineTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--editor-bg)', color: 'var(--text)', maxHeight: '70vh' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-editor)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 14px' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--editor-selection) !important'
  },
  '.cm-placeholder': { color: 'var(--text-faint)' }
})

interface Props {
  initial: string
  /** Character offset for the caret, or -1 for the end. */
  cursor: number
  /** Called with the new text, or null to discard. */
  onDone: (text: string | null) => void
  /** Lets the owner read the current text (to commit when focus moves elsewhere). */
  textRef: React.MutableRefObject<() => string>
}

/** A small CodeMirror editor shown in place of one rendered block (reading-mode editing). */
export function BlockEditor({ initial, cursor, onDone, textRef }: Props) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const fontSize = useStore((s) => s.settings.editorFontSize)
  const platform = useStore((s) => s.platform)

  useEffect(() => {
    const finish = (save: boolean) => {
      const view = viewRef.current
      if (!view) return true
      doneRef.current(save ? view.state.doc.toString() : null)
      return true
    }
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: initial,
        selection: EditorSelection.cursor(cursor < 0 || cursor > initial.length ? initial.length : cursor),
        extensions: [
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: () => finish(true) },
              { key: 'Escape', run: () => finish(true) }
            ])
          ),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          languageFor('markdown'),
          syntaxHighlighting(markdownHighlight),
          inlineTheme,
          cmPlaceholder(t('block.placeholder')),
          markdownPaste(),
          findExtensions,
          sublimeKeymap(window.mf.platform),
          baseKeymap(window.mf.platform)
        ]
      })
    })
    viewRef.current = view
    textRef.current = () => view.state.doc.toString()
    // ⌘↩ arrives through the app menu on macOS; it finishes the block edit here.
    const onFinish = () => finish(true)
    view.dom.addEventListener('mf-block-finish', onFinish)
    view.focus()
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // The editor is created once per editing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+'
  return (
    <div className="mf-block-editor" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="mf-block-editor-cm" ref={hostRef} style={{ fontSize }} />
      <div className="mf-block-editor-bar">
        <span className="mf-block-editor-hint">{t('block.hint', { mod })}</span>
        <button type="button" className="btn small" onClick={() => onDone(null)}>
          {t('block.cancel')}
        </button>
        <button
          type="button"
          className="btn small primary"
          onClick={() => viewRef.current && onDone(viewRef.current.state.doc.toString())}
        >
          {t('block.done')}
        </button>
      </div>
    </div>
  )
}
