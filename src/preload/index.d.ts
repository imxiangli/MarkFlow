import type { MarkFlowAPI } from '../shared/types'

declare global {
  interface Window {
    mf: MarkFlowAPI
  }
}

export {}
