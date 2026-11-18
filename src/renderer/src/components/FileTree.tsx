import { memo, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import type { TreeNode } from '@shared/types'
import {
  createEntry,
  deleteEntry,
  expandTo,
  openFile,
  renameEntry,
  toggleExpanded
} from '@/actions'
import { useT } from '@/lib/i18n'
import { dirname, relative } from '@/lib/path'
import { activeTab, getState, isDirty, useStore } from '@/store'
import { openContextMenu, type MenuItem } from './ContextMenu'
import { FileIcon } from './FileIcon'

type EditState =
  | { mode: 'rename'; path: string }
  | { mode: 'create'; dir: string; type: 'file' | 'dir' }
  | null

export const useTreeEdit = create<{ edit: EditState }>(() => ({ edit: null }))

export function startCreate(dir: string, type: 'file' | 'dir'): void {
  toggleExpanded(dir, true)
  useTreeEdit.setState({ edit: { mode: 'create', dir, type } })
}

function InlineInput({ initial, onDone, depth, icon }: { initial: string; onDone: (v: string | null) => void; depth: number; icon: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chevron" />
      <span className="tree-icon">{icon}</span>
      <input
        ref={ref}
        className="tree-input"
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(e.currentTarget.value)
          else if (e.key === 'Escape') finish(null)
          e.stopPropagation()
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

function fileIcon(name: string) {
  return <FileIcon name={name} size={15} />
}

function useEntryMenu() {
  const t = useT()
  const platform = useStore((s) => s.platform)
  return (e: React.MouseEvent, node: TreeNode | null) => {
    const root = getState().root
    if (!root) return
    const target = node ?? { path: root, type: 'dir' as const, name: '' }
    const dir = target.type === 'dir' ? target.path : dirname(target.path)
    const items: MenuItem[] = [
      { label: t('ctx.newFile'), onClick: () => startCreate(dir, 'file') },
      { label: t('ctx.newFolder'), onClick: () => startCreate(dir, 'dir') }
    ]
    if (node) {
      items.push(
        { separator: true },
        { label: t('ctx.rename'), onClick: () => useTreeEdit.setState({ edit: { mode: 'rename', path: node.path } }) },
        { label: t('ctx.delete'), danger: true, onClick: () => void deleteEntry(node.path) }
      )
    }
    items.push(
      { separator: true },
      {
        label: t(platform === 'darwin' ? 'ctx.reveal.darwin' : platform === 'win32' ? 'ctx.reveal.win32' : 'ctx.reveal.linux'),
        onClick: () => window.mf.showItemInFolder(target.path)
      },
      { label: t('ctx.copyPath'), onClick: () => window.mf.copyText(target.path) },
      { label: t('ctx.copyRelativePath'), onClick: () => window.mf.copyText(relative(root, target.path)) }
    )
    if (node?.type === 'file') {
      items.push({ label: t('ctx.openDefault'), onClick: () => void window.mf.openPath(node.path) })
    }
    openContextMenu(e, items)
  }
}

const TreeRow = memo(function TreeRow({ node, depth, onMenu }: { node: TreeNode; depth: number; onMenu: ReturnType<typeof useEntryMenu> }) {
  const expanded = useStore((s) => !!s.expanded[node.path])
  const isActive = useStore((s) => activeTab(s)?.path === node.path)
  const dirty = useStore((s) => {
    if (node.type !== 'file') return false
    const tab = s.tabs.find((x) => x.path === node.path)
    return !!tab && isDirty(tab)
  })
  const edit = useTreeEdit((s) => s.edit)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isActive])

  const renaming = edit?.mode === 'rename' && edit.path === node.path
  if (renaming) {
    return (
      <InlineInput
        initial={node.name}
        depth={depth}
        icon={node.type === 'dir' ? <Folder size={15} /> : fileIcon(node.name)}
        onDone={(v) => {
          useTreeEdit.setState({ edit: null })
          if (v !== null) void renameEntry(node.path, v)
        }}
      />
    )
  }

  const creatingHere = edit?.mode === 'create' && edit.dir === node.path
  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
        onClick={() => (node.type === 'dir' ? toggleExpanded(node.path) : void openFile(node.path))}
        onContextMenu={(e) => onMenu(e, node)}
        draggable={node.type === 'file'}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', node.path)
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <span className="tree-chevron">
          {node.type === 'dir' ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
        </span>
        <span className={`tree-icon${node.type === 'dir' ? ' folder' : ''}`}>
          {node.type === 'dir' ? expanded ? <FolderOpen size={15} /> : <Folder size={15} /> : fileIcon(node.name)}
        </span>
        <span className="tree-name">{node.name}</span>
        {dirty && <span className="tree-dirty" />}
      </div>
      {node.type === 'dir' && expanded && (
        <>
          {creatingHere && (
            <InlineInput
              initial={edit.type === 'file' ? 'untitled.md' : 'folder'}
              depth={depth + 1}
              icon={edit.type === 'dir' ? <Folder size={15} /> : <FileText size={15} />}
              onDone={(v) => {
                useTreeEdit.setState({ edit: null })
                if (v) void createEntry(node.path, v, edit.type)
              }}
            />
          )}
          {node.children?.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} onMenu={onMenu} />)}
        </>
      )}
    </>
  )
})

export function FileTree() {
  const t = useT()
  const tree = useStore((s) => s.tree)
  const root = useStore((s) => s.root)
  const activePath = useStore((s) => activeTab(s)?.path ?? null)
  const edit = useTreeEdit((s) => s.edit)
  const onMenu = useEntryMenu()

  useEffect(() => {
    if (activePath) expandTo(activePath)
  }, [activePath, root])

  if (!tree || !root) return null
  const creatingAtRoot = edit?.mode === 'create' && edit.dir === root
  return (
    <div className="tree" onContextMenu={(e) => onMenu(e, null)}>
      {creatingAtRoot && (
        <InlineInput
          initial={edit.type === 'file' ? 'untitled.md' : 'folder'}
          depth={0}
          icon={edit.type === 'dir' ? <Folder size={15} /> : <FileText size={15} />}
          onDone={(v) => {
            useTreeEdit.setState({ edit: null })
            if (v) void createEntry(root, v, edit.type)
          }}
        />
      )}
      {tree.children?.map((c) => <TreeRow key={c.path} node={c} depth={0} onMenu={onMenu} />)}
      {!tree.children?.length && !creatingAtRoot && <div className="sidebar-empty">{t('sidebar.emptyFolder')}</div>}
    </div>
  )
}
