/**
 * Jump back / forward (⌃- / ⌃⇧-), like Sublime: remembers where you were before tab
 * switches, heading / line jumps, search results, links and large cursor moves.
 */
import { activeTab, getState } from '@/store'
import { samePath } from '@/lib/path'

export interface NavLocation {
  tabId: string
  path: string | null
  line: number
}

const MAX = 100
const back: NavLocation[] = []
const forward: NavLocation[] = []
let navigating = false
let lineOf: (tabId: string) => number | null = () => null

/** Where the reader is in a tab right now (cursor line, or top line in reading mode). */
export function setLocationProvider(fn: (tabId: string) => number | null): void {
  lineOf = fn
}

export function currentLocation(): NavLocation | null {
  const tab = activeTab(getState())
  if (!tab) return null
  return { tabId: tab.id, path: tab.path, line: Math.max(0, lineOf(tab.id) ?? 0) }
}

/** Record a jump from `line` of the active tab (large cursor moves in the editor). */
export function recordJumpFromLine(line: number): void {
  const tab = activeTab(getState())
  if (tab) recordJump({ tabId: tab.id, path: tab.path, line })
}

function near(a: NavLocation, b: NavLocation): boolean {
  return (a.tabId === b.tabId || (!!a.path && samePath(a.path, b.path))) && Math.abs(a.line - b.line) < 3
}

/** Call before navigating away from `from` (defaults to the current location). */
export function recordJump(from: NavLocation | null = currentLocation()): void {
  if (navigating || !from) return
  const top = back[back.length - 1]
  if (top && near(top, from)) return
  back.push(from)
  if (back.length > MAX) back.shift()
  forward.length = 0
}

export type NavGo = (loc: NavLocation) => Promise<boolean>

async function move(fromStack: NavLocation[], toStack: NavLocation[], go: NavGo): Promise<boolean> {
  const here = currentLocation()
  while (fromStack.length) {
    const loc = fromStack.pop()!
    if (here && near(loc, here)) continue
    navigating = true
    try {
      if (await go(loc)) {
        if (here) toStack.push(here)
        return true
      }
    } finally {
      setTimeout(() => (navigating = false), 80)
    }
  }
  return false
}

export const jumpBack = (go: NavGo) => move(back, forward, go)
export const jumpForward = (go: NavGo) => move(forward, back, go)

export function isNavigating(): boolean {
  return navigating
}
