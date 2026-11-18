import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'

export interface MenuItem {
  label?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
}

const useMenu = create<MenuState>(() => ({ menu: null }))

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

export function closeContextMenu(): void {
  useMenu.setState({ menu: null })
}

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const x = Math.min(menu.x, window.innerWidth - r.width - 6)
    const y = menu.y + r.height > window.innerHeight - 6 ? Math.max(6, menu.y - r.height) : menu.y
    setPos({ x: Math.max(6, x), y })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return
      closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu()
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x || menu.x, top: pos.y || menu.y }} role="menu">
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              closeContextMenu()
              item.onClick?.()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
