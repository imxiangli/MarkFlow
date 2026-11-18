import hljsLight from 'highlight.js/styles/github.css?raw'
import hljsDark from 'highlight.js/styles/github-dark.css?raw'
import { resolvedTheme, setState, useStore } from '@/store'

let styleEl: HTMLStyleElement | null = null
let current: 'light' | 'dark' | null = null

function apply(theme: 'light' | 'dark'): void {
  if (theme === current) return
  current = theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'mf-hljs-theme'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = theme === 'dark' ? hljsDark : hljsLight
}

export function startTheme(): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', () => setState({ systemDark: media.matches }))
  apply(resolvedTheme(useStore.getState()))
  useStore.subscribe((s) => apply(resolvedTheme(s)))
}

export const hljsThemes = { light: hljsLight, dark: hljsDark }
