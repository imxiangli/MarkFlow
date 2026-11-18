import { app } from 'electron'
import { resolveLocale, translate, type Locale, type MessageKey } from '@shared/i18n'
import { getStore } from './store'

export function systemLocale(): string {
  try {
    return app.getPreferredSystemLanguages()[0] || app.getLocale()
  } catch {
    return app.getLocale()
  }
}

export function currentLocale(): Locale {
  return resolveLocale(getStore().settings.language, systemLocale())
}

export function mt(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale(), key, vars)
}
