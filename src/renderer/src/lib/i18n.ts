import { useCallback } from 'react'
import { translate, type MessageKey } from '@shared/i18n'
import { getState, useStore } from '@/store'

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string

export const t: TFunction = (key, vars) => translate(getState().locale, key, vars)

export function useT(): TFunction {
  const locale = useStore((s) => s.locale)
  return useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale])
}
