/** Matcher for the preview find bar (DOM-free so it can be unit tested). */

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

/** The matcher behind the preview find bar; null when the pattern is not a valid regex. */
export function findPattern(query: string, o: FindOptions): RegExp | null {
  let source = o.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // \b doesn't understand CJK, so "whole word" means no letter/digit on either side.
  if (o.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  try {
    return new RegExp(source, `gu${o.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}
