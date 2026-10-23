export type Limit = {
  kind: string
  percentUsed: number
  resetsAt?: string
  /** Cuándo se llegaría al 100 % al ritmo reciente (ms), o null si no hay ritmo suficiente. */
  fullAt: number | null
  /** Coste equivalente gastado desde que empezó esta ventana (todas las sesiones), o null si no se sabe. */
  blockUsd: number | null
}

export type Snapshot = {
  usd?: number
  contextPercent?: number
  limits: Limit[]
  /** Cuándo se tomó la medición (ms). */
  measuredAt: number
}

export type Tokens = {
  /** Peso de coste relativo del hilo principal y de los subagentes. */
  mainW: number
  subW: number
  /** Tokens de entrada servidos por la caché y tokens de entrada totales. */
  cacheRead: number
  inputTotal: number
}

export type CiState = 'pass' | 'fail' | 'pending' | 'none'

export type Check = { name: string; state: CiState }

export type RepoInfo = {
  name: string
  branch: string
  /** Por qué no hay PR: no existe, o no se pudo consultar GitHub (falta gh o no tiene sesión). */
  prNote?: 'none' | 'unavailable'
  pr: {
    number: number
    additions: number
    deletions: number
    ci: CiState
    checks: Check[]
  } | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      snapshot: Snapshot | null
      tokens: Tokens
      repo: RepoInfo | null
      branchUsd: number | null
      lastUsd: number | null
      hideRepo: boolean
      showHelp: boolean
      showChecks: boolean
      showLegend: boolean
      tick: number
    }
  }
}
