import { useDeferredValue, useMemo } from 'react'
import { reopenWithEncoding, saveWithEncoding, setDocumentType, setDocumentTypeAuto, setLineEnding } from '@/actions'
import { COMMON_TYPES, PLAIN_TEXT, documentType, tabLanguage } from '@/editor/languages'
import { formatSize } from '@/lib/fileTypes'
import { t as translate, useT } from '@/lib/i18n'
import { relative } from '@/lib/path'
import { activeTab, isDirty, isEditable, isNewDocument, setState, useStore, type Tab } from '@/store'
import { ENCODING_LABELS } from '@shared/constants'
import type { LineEnding, TextEncoding } from '@shared/types'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { updatePercent } from './UpdatePanel'

const ENCODINGS = Object.keys(ENCODING_LABELS) as TextEncoding[]

function encodingMenu(e: React.MouseEvent, tab: Tab): void {
  const current = tab.encoding ?? 'utf8'
  const item = (enc: TextEncoding, run: (enc: TextEncoding) => void, disabled = false): MenuItem => ({
    label: `${enc === current ? '✓ ' : '\u2003'}${ENCODING_LABELS[enc]}`,
    onClick: () => run(enc),
    disabled
  })
  openContextMenu(e, [
    { label: translate('status.reopenWithEncoding'), disabled: true },
    ...ENCODINGS.map((enc) => item(enc, (x) => void reopenWithEncoding(tab.id, x), !tab.path)),
    { separator: true },
    { label: translate('status.saveWithEncoding'), disabled: true },
    ...ENCODINGS.map((enc) => item(enc, (x) => void saveWithEncoding(tab.id, x)))
  ])
}

const typeLabel = (type: string): string => (type === PLAIN_TEXT ? translate('status.plainText') : type)

/** What a new document is: the common types, and the palette for all the others. */
function typeMenu(e: React.MouseEvent, tab: Tab, current: string): void {
  const auto = !!tab.autoType
  openContextMenu(e, [
    {
      label: `${auto ? '✓ ' : ' '}${translate('cmd.syntaxAuto')}`,
      onClick: () => setDocumentTypeAuto(tab.id)
    },
    { separator: true },
    ...COMMON_TYPES.map((type) => ({
      label: `${!auto && type === current ? '✓ ' : ' '}${typeLabel(type)}`,
      onClick: () => setDocumentType(tab.id, type)
    })),
    { separator: true },
    {
      label: ` ${translate('status.otherTypes')}`,
      onClick: () => setState({ palette: `>${translate('cmd.setType', { name: '' })}` })
    }
  ])
}

function eolMenu(e: React.MouseEvent, tab: Tab): void {
  const current = tab.eol ?? 'lf'
  openContextMenu(
    e,
    (['lf', 'crlf'] as LineEnding[]).map((eol) => ({
      label: `${eol === current ? '✓ ' : '\u2003'}${eol.toUpperCase()}`,
      onClick: () => setLineEnding(tab.id, eol)
    }))
  )
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g

export function countWords(text: string): { words: number; chars: number } {
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.replace(CJK, ' ').match(/[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g)?.length ?? 0
  return { words: cjk + latin, chars: text.replace(/\s/g, '').length }
}

function UpdateIndicator() {
  const t = useT()
  const u = useStore((s) => s.update)
  if (!u) return null
  let label = ''
  if (u.status === 'downloading' || u.status === 'full-downloading') label = t('status.updating', { percent: updatePercent(u) })
  else if (u.status === 'ready' || (u.status === 'full-ready' && u.autoInstall))
    label = t('status.updateReady', { version: u.latestVersion ?? '' })
  else if (u.status === 'available' || u.status === 'full-available' || u.status === 'full-ready')
    label = t('status.updateAvailable', { version: u.latestVersion ?? '' })
  if (!label) return null
  return (
    <button
      className={`status-update ${u.status}`}
      onClick={() => {
        if (u.status === 'ready' || (u.status === 'full-ready' && u.autoInstall)) void window.mf.installUpdate()
        else setState({ settingsOpen: true, settingsSection: 'update' })
      }}
    >
      {label}
    </button>
  )
}

export function StatusBar() {
  const t = useT()
  const tab = useStore((s) => activeTab(s))
  const root = useStore((s) => s.root)
  const cursor = useStore((s) => s.cursor)
  const viewMode = useStore((s) => s.viewMode)
  const docLines = useStore((s) => s.docLines)
  const content = useDeferredValue(isEditable(tab) ? (tab?.content ?? '') : '')
  const stats = useMemo(() => countWords(content), [content])

  if (!tab)
    return (
      <footer className="statusbar">
        <span className="status-spacer" />
        <UpdateIndicator />
      </footer>
    )
  const showCursor = tab.kind === 'text' || (tab.kind === 'markdown' && (viewMode !== 'preview' || !!tab.large))
  const location = tab.path ? (root && tab.path.startsWith(root) ? relative(root, tab.path) : tab.path) : tab.name
  return (
    <footer className="statusbar">
      <span className="status-path" title={tab.path ?? ''}>
        {location}
      </span>
      {isEditable(tab) && (
        <span className={`status-saved${isDirty(tab) && !tab.builtin ? ' dirty' : ''}`}>
          {isDirty(tab) && !tab.builtin ? t('status.unsaved') : tab.path ? t('status.saved') : ''}
        </span>
      )}
      <span className="status-spacer" />
      {showCursor && (
        <span>
          {t('status.line', { line: cursor.line, col: cursor.col })}
          {cursor.selected > 0 ? ` · ${t('status.selected', { n: cursor.selected })}` : ''}
        </span>
      )}
      {isEditable(tab) && (
        <>
          {tab.large ? (
            <>
              <span className="status-large" title={t('large.modeTip')}>
                {t('large.mode')}
              </span>
              <span>{t('status.lines', { n: docLines.toLocaleString() })}</span>
              <span>{formatSize(tab.size)}</span>
            </>
          ) : (
            <>
              <span>{t('status.words', { n: stats.words })}</span>
              <span>{t('status.chars', { n: stats.chars })}</span>
              {tab.kind === 'markdown' && <span>{t('status.readingTime', { n: Math.max(1, Math.round(stats.words / 300)) })}</span>}
            </>
          )}
          <button className="status-btn" title={t('status.encodingTip')} onClick={(e) => encodingMenu(e, tab)}>
            {ENCODING_LABELS[tab.encoding ?? 'utf8']}
          </button>
          <button className="status-btn" title={t('status.eolTip')} onClick={(e) => eolMenu(e, tab)}>
            {(tab.eol ?? 'lf').toUpperCase()}
          </button>
          {isNewDocument(tab) ? (
            <button
              className="status-btn status-syntax"
              title={t(tab.autoType ? 'status.typeAutoTip' : 'status.typeTip')}
              onClick={(e) => typeMenu(e, tab, documentType(tab, content))}
            >
              {tab.autoType
                ? t('status.typeAuto', { name: typeLabel(documentType(tab, content)) })
                : typeLabel(documentType(tab, content))}
            </button>
          ) : tab.kind === 'markdown' && !tab.large ? (
            <span>Markdown</span>
          ) : (
            <button
              className="status-btn status-syntax"
              title={t('status.syntaxTip')}
              onClick={() => setState({ palette: `>${t('cmd.setSyntax', { name: '' })}` })}
            >
              {(tab.large && !tab.language ? null : tabLanguage(tab, content)?.name) ?? t('status.plainText')}
            </button>
          )}
        </>
      )}
      {tab.kind === 'binary' && <span>{formatSize(tab.size)}</span>}
      <UpdateIndicator />
    </footer>
  )
}
