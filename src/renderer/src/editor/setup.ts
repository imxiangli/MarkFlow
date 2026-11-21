import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { history } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { Settings } from '@shared/types'
import type { TabKind } from '@/store'
import { baseKeymap, sublimeKeymap } from './keymap'
import { findExtensions } from './findPanel'
import { languageExtension, tabLanguage } from './languages'
import { MINIMAP_WIDTH, minimap } from './minimap'
import { bookmarks } from './sublime'

export const compartments = {
  lineNumbers: new Compartment(),
  wrap: new Compartment(),
  font: new Compartment(),
  language: new Compartment(),
  minimap: new Compartment()
}

export const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.45em', color: 'var(--cm-heading)' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.3em', color: 'var(--cm-heading)' },
  { tag: tags.heading3, fontWeight: '700', fontSize: '1.15em', color: 'var(--cm-heading)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700', color: 'var(--cm-heading)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--cm-link)' },
  { tag: tags.quote, color: 'var(--cm-quote)', fontStyle: 'italic' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--cm-code)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--cm-meta)' },
  { tag: tags.list, color: 'var(--cm-list)' },
  { tag: tags.meta, color: 'var(--cm-meta)' },
  { tag: tags.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--cm-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--cm-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--cm-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--cm-property)' },
  { tag: [tags.tagName, tags.angleBracket], color: 'var(--cm-tag)' },
  { tag: [tags.standard(tags.variableName), tags.special(tags.variableName), tags.self], color: 'var(--cm-type)' },
  { tag: [tags.definition(tags.function(tags.variableName)), tags.macroName], color: 'var(--cm-function)' },
  { tag: [tags.escape, tags.character], color: 'var(--cm-number)' },
  { tag: [tags.inserted], color: 'var(--cm-string)' },
  { tag: [tags.deleted], color: 'var(--cm-invalid)' },
  { tag: tags.invalid, color: 'var(--cm-invalid)' }
])

// One instance, so reconfiguring other settings keeps the same minimap plugin.
const minimapExtension = minimap(markdownHighlight)
const minimapFor = (settings: Settings): Extension => (settings.minimap ? minimapExtension : [])

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { lineHeight: '1.7', overflowX: 'auto' },
  '.cm-content': { padding: '18px 0 40vh', caretColor: 'var(--accent)', maxWidth: '100%' },
  '.cm-line': { padding: '0 24px 0 16px' },
  // Unwrapped lines overflow their box, so padding doesn't count: a spacer after the text lets
  // the end of a long line scroll out from under the minimap.
  '.cm-scroller[data-minimap] .cm-content:not(.cm-lineWrapping) .cm-line::after': {
    content: "''",
    display: 'inline-block',
    width: `${MINIMAP_WIDTH}px`
  },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--text-faint)',
    border: 'none',
    paddingLeft: '6px'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--editor-selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-match)' },
  '.cm-foldGutter span': { color: 'var(--text-faint)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-bg)', border: '1px solid var(--border)' },
  '.cm-bookmark-gutter': { width: '10px', paddingLeft: '2px' },
  '.cm-bookmark-marker': {
    display: 'inline-block',
    width: '6px',
    height: '12px',
    marginTop: '5px',
    borderRadius: '1px 1px 3px 3px',
    backgroundColor: 'var(--accent)'
  }
})

function fontTheme(settings: Settings): Extension {
  const family = settings.editorFontFamily.trim()
  return EditorView.theme({
    '&': { fontSize: `${settings.editorFontSize}px` },
    '.cm-scroller': { fontFamily: family ? `${family}, var(--font-editor)` : 'var(--font-editor)' }
  })
}

export function languageFor(kind: TabKind): Extension {
  if (kind !== 'markdown') return []
  return markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, completeHTMLTags: false })
}

/**
 * Language extension for a tab: Markdown, or the code syntax of a text file (loaded lazily;
 * `onLoad` receives it when it wasn't loaded yet).
 */
export function tabLanguageExtension(
  tab: { kind: TabKind; name: string; language?: string; large?: boolean },
  content: string,
  onLoad: (ext: Extension) => void
): Extension {
  // Parsing hundreds of MB costs a lot of memory: large files are plain text unless the user
  // picks a syntax.
  if (tab.large && !tab.language) return []
  if (tab.kind === 'markdown' && !tab.language) return languageFor('markdown')
  if (tab.kind !== 'text') return []
  return languageExtension(tabLanguage(tab, content), onLoad)
}

export interface EditorHandlers {
  extensions: Extension[]
}

export function createEditorState(
  doc: string | Text,
  language: Extension,
  settings: Settings,
  handlers: EditorHandlers,
  options: { large?: boolean } = {}
): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      compartments.lineNumbers.of(settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
      compartments.wrap.of(wrapFor(settings, options.large)),
      compartments.font.of(fontTheme(settings)),
      compartments.language.of(language),
      compartments.minimap.of(minimapFor(settings)),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      findExtensions,
      syntaxHighlighting(markdownHighlight),
      baseTheme,
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      bookmarks,
      sublimeKeymap(window.mf.platform),
      baseKeymap(window.mf.platform),
      ...handlers.extensions
    ]
  })
}

/**
 * Line wrapping is off for large files: unwrapped, CodeMirror only draws the visible part of
 * very long lines (SQL dumps, minified files), wrapped it must lay out every character.
 */
function wrapFor(settings: Settings, large?: boolean): Extension {
  return settings.lineWrapping && !large ? EditorView.lineWrapping : []
}

/** Effects that bring an existing state in line with the current settings. */
export function settingsEffects(settings: Settings, large?: boolean) {
  return [
    compartments.lineNumbers.reconfigure(
      settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []
    ),
    compartments.wrap.reconfigure(wrapFor(settings, large)),
    compartments.font.reconfigure(fontTheme(settings)),
    compartments.minimap.reconfigure(minimapFor(settings))
  ]
}
