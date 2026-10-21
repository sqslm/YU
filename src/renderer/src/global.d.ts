import type { TypelessApi } from '@shared/api'

declare global {
  interface Window {
    api: TypelessApi
  }
}

export {}
