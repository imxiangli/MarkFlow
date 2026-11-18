import { activeTab, setState } from '@/store'
import { basename } from '@/lib/path'

function viewerName(kind: string): string {
  const base = (activeTab()?.name ?? 'diagram').replace(/\.[^.]+$/, '')
  return `${basename(base)}-${kind}`
}

/** Open the zoom viewer for the diagram or image in / around `el`. Returns false if none. */
export function openViewerFor(el: Element): boolean {
  const diagram = el.closest('.mf-diagram') ?? el.querySelector('.mf-diagram')
  const svg = diagram?.querySelector('.mf-diagram-svg svg')
  if (svg) {
    setState({ viewer: { kind: 'svg', content: svg.outerHTML, name: viewerName(diagram!.getAttribute('data-kind') ?? 'diagram') } })
    return true
  }
  const img = (el.tagName === 'IMG' ? el : el.querySelector('img')) as HTMLImageElement | null
  if (img) {
    setState({ viewer: { kind: 'image', content: img.currentSrc || img.src, name: viewerName('image') } })
    return true
  }
  return false
}
