import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Check, ChevronRight } from 'lucide-react'

export interface MenuItem {
  label?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  /** Shortcut shown on the right, already formatted for display. */
  shortcut?: string
  /** Shows a check mark; a menu whose items set `checked` reserves room for it. */
  checked?: boolean
  submenu?: MenuItem[]
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
  /** Index of the open submenu item at each level. */
  sub: number[]
  /** Highlighted item at each level (mouse or keyboard). */
  active: number[]
}

const useMenu = create<MenuState>(() => ({ menu: null, sub: [], active: [] }))

/** Drop empty submenus and leading, trailing or doubled separators (menus built from context). */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const item of items) {
    if (item.separator) {
      if (out.length && !out[out.length - 1].separator) out.push(item)
      continue
    }
    if (item.submenu) {
      const submenu = tidy(item.submenu)
      if (submenu.length) out.push({ ...item, submenu })
      continue
    }
    out.push(item)
  }
  while (out.length && out[out.length - 1].separator) out.pop()
  return out
}

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  const tidied = tidy(items)
  useMenu.setState({ menu: tidied.length ? { x: e.clientX, y: e.clientY, items: tidied } : null, sub: [], active: [] })
}

export function closeContextMenu(): void {
  useMenu.setState({ menu: null, sub: [], active: [] })
}

const usable = (item: MenuItem | undefined): item is MenuItem => !!item && !item.separator && !item.disabled

/** The next usable item from `from` in direction `dir`, wrapping around. */
function step(items: MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n
    if (usable(items[i])) return i
  }
  return from
}

const firstUsable = (items: MenuItem[]): number => step(items, -1, 1)

/** The item lists shown: the menu itself, then each open submenu. */
function levelsOf(items: MenuItem[], sub: number[]): MenuItem[][] {
  const levels = [items]
  for (const i of sub) {
    const next = levels[levels.length - 1][i]?.submenu
    if (!next) break
    levels.push(next)
  }
  return levels
}

function run(item: MenuItem): void {
  closeContextMenu()
  item.onClick?.()
}

/** Open the submenu of item `i` at `level` and highlight its first item (keyboard) or nothing (mouse). */
function openSub(level: number, i: number, highlightFirst: boolean): void {
  const { menu, sub } = useMenu.getState()
  if (!menu) return
  const nextSub = [...sub.slice(0, level), i]
  const child = levelsOf(menu.items, nextSub)[level + 1]
  if (!child) return
  useMenu.setState({ sub: nextSub, active: highlightFirst ? [...nextSub, firstUsable(child)] : [...nextSub] })
}

const SUBMENU_DELAY = 160
const MARGIN = 6

interface PanelProps {
  items: MenuItem[]
  level: number
  /** Where the top-level menu opens. */
  point?: { x: number; y: number }
  /** The item a submenu belongs to. */
  anchor?: HTMLElement | null
  active: number | undefined
  openIndex: number | undefined
  register: (level: number, i: number, el: HTMLElement | null) => void
  onHover: (level: number, i: number) => void
  onEnter: (level: number) => void
  onLeave: (level: number) => void
}

function Panel({ items, level, point, anchor, active, openIndex, register, onHover, onEnter, onLeave }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = window.innerWidth
    const h = window.innerHeight
    let x: number
    let y: number
    if (point) {
      x = Math.min(point.x, w - r.width - MARGIN)
      y = point.y + r.height > h - MARGIN ? Math.max(MARGIN, point.y - r.height) : point.y
    } else if (anchor) {
      const a = anchor.getBoundingClientRect()
      x = a.right + 2
      if (x + r.width > w - MARGIN) x = a.left - r.width - 2
      y = Math.min(a.top - 5, h - r.height - MARGIN)
    } else return
    setPos({ x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) })
  }, [items, point, anchor])

  const checks = items.some((it) => it.checked !== undefined)
  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      // Keep the focus (and selection) where it was, e.g. in the editor.
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => onEnter(level)}
      onMouseLeave={() => onLeave(level)}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            ref={(el) => register(level, i, el)}
            className={`context-menu-item${item.danger ? ' danger' : ''}${active === i ? ' active' : ''}${openIndex === i ? ' open' : ''}`}
            disabled={item.disabled}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openIndex === i : undefined}
            tabIndex={-1}
            onMouseEnter={() => onHover(level, i)}
            onClick={() => {
              if (!usable(item)) return
              if (item.submenu) openSub(level, i, false)
              else run(item)
            }}
          >
            {checks && <span className="context-menu-check">{item.checked && <Check size={13} />}</span>}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-key">{item.shortcut}</span>}
            {item.submenu && <ChevronRight size={13} className="context-menu-arrow" />}
          </button>
        )
      )}
    </div>
  )
}

export function ContextMenuHost() {
  const { menu, sub, active } = useMenu()
  const items = useRef(new Map<string, HTMLElement>())
  const timer = useRef(0)

  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if ((e.type === 'mousedown' || e.type === 'wheel') && (e.target as Element | null)?.closest?.('.context-menu')) return
      closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      const s = useMenu.getState()
      if (!s.menu) return
      const levels = levelsOf(s.menu.items, s.sub)
      const depth = levels.length - 1
      const list = levels[depth]
      const subPath = s.sub.slice(0, depth)
      const cur = s.active.length > depth ? s.active[depth] : -1
      const stop = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      switch (e.key) {
        case 'ArrowDown':
          stop()
          useMenu.setState({ active: [...subPath, step(list, cur, 1)] })
          return
        case 'ArrowUp':
          stop()
          useMenu.setState({ active: [...subPath, step(list, cur < 0 ? list.length : cur, -1)] })
          return
        case 'Home':
        case 'End':
          stop()
          useMenu.setState({ active: [...subPath, e.key === 'Home' ? firstUsable(list) : step(list, list.length, -1)] })
          return
        case 'ArrowRight':
          stop()
          if (usable(list[cur]) && list[cur].submenu) openSub(depth, cur, true)
          return
        case 'ArrowLeft':
        case 'Escape':
          stop()
          if (depth > 0) useMenu.setState({ sub: s.sub.slice(0, depth - 1), active: s.sub.slice(0, depth) })
          else if (e.key === 'Escape') closeContextMenu()
          return
        case 'Enter':
        case ' ': {
          stop()
          const item = list[cur]
          if (!usable(item)) return
          if (item.submenu) openSub(depth, cur, true)
          else run(item)
          return
        }
        case 'Shift':
        case 'Control':
        case 'Alt':
        case 'Meta':
          return
        default:
          closeContextMenu()
      }
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('keydown', onKey, true)
      window.clearTimeout(timer.current)
    }
  }, [menu])

  if (!menu) return null

  const register = (level: number, i: number, el: HTMLElement | null) => {
    if (el) items.current.set(`${level}:${i}`, el)
    else items.current.delete(`${level}:${i}`)
  }

  // Highlight at once; open / close submenus after a short pause, so moving diagonally
  // towards an open submenu across other items doesn't switch it.
  const onHover = (level: number, i: number) => {
    window.clearTimeout(timer.current)
    const s = useMenu.getState()
    const list = levelsOf(menu.items, s.sub)[level]
    const item = list?.[i]
    useMenu.setState({ active: [...s.active.slice(0, level), i] })
    if (s.sub[level] === i && s.sub.length === level + 1) return
    timer.current = window.setTimeout(() => {
      if (usable(item) && item.submenu) openSub(level, i, false)
      else useMenu.setState((st) => ({ sub: st.sub.slice(0, level) }))
    }, SUBMENU_DELAY)
  }

  // Reaching a submenu keeps it (and its parent item highlighted).
  const onEnter = (level: number) => {
    if (level === 0) return
    window.clearTimeout(timer.current)
    const s = useMenu.getState()
    useMenu.setState({ active: [...s.sub.slice(0, level), ...s.active.slice(level, level + 1)] })
  }

  const onLeave = (level: number) => {
    const s = useMenu.getState()
    // An item whose submenu is open stays highlighted; otherwise nothing is.
    useMenu.setState({ active: s.sub[level] !== undefined ? s.sub.slice(0, level + 1) : s.active.slice(0, level) })
  }

  const levels = levelsOf(menu.items, sub)
  return (
    <>
      {levels.map((list, level) => (
        <Panel
          key={level === 0 ? 'root' : `${level}:${sub.slice(0, level).join('.')}`}
          items={list}
          level={level}
          point={level === 0 ? menu : undefined}
          anchor={level > 0 ? (items.current.get(`${level - 1}:${sub[level - 1]}`) ?? null) : undefined}
          active={active[level]}
          openIndex={sub[level]}
          register={register}
          onHover={onHover}
          onEnter={onEnter}
          onLeave={onLeave}
        />
      ))}
    </>
  )
}
