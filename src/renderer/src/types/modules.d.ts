declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  export const full: PluginSimple
  export const light: PluginSimple
  export const bare: PluginSimple
}

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-sub' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-sup' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-mark' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-ins' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-abbr' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-deflist' {
  import type { MarkdownIt } from 'markdown-it'
  type PluginSimple = (md: MarkdownIt) => void
  const plugin: PluginSimple
  export default plugin
}

declare module 'markdown-it-container' {
  import type { MarkdownIt } from 'markdown-it'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PluginWithParams = (md: MarkdownIt, ...params: any[]) => void
  const plugin: PluginWithParams
  export default plugin
}

declare module 'katex/contrib/mhchem'
