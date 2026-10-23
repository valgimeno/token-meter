// Cálculos puros del medidor: sin $ ni efectos, para poder probarlos.

import type { CiState, Check } from '../types'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * Peso de precio relativo de cada familia de modelos (Haiku = 1).
 * Las proporciones entre familias han sido estables; lo desconocido se trata
 * como el nivel más caro para no infravalorar el gasto.
 */
export function modelMultiplier(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 3
  return 5
}

/**
 * Coste relativo de una respuesta: la salida cuesta ~5x la entrada, leer de
 * caché ~0,1x y escribir en caché ~1,25x. Sirve para repartir el coste real
 * de la sesión, no para calcular dólares por sí solo.
 */
export function weightOf(u: Usage, model: string): number {
  return (
    modelMultiplier(model) *
    (u.input_tokens +
      5 * u.output_tokens +
      0.1 * u.cache_read_input_tokens +
      1.25 * u.cache_creation_input_tokens)
  )
}

export function inputTotal(u: Usage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

export type Sample = { t: number; p: number }

/** Añade una muestra y descarta las de más de 24 h o de otra ventana. */
export function addSample(samples: Sample[], s: Sample): Sample[] {
  const kept = samples.filter(x => s.t - x.t <= 24 * 3600_000 && x.p <= s.p)
  const last = kept[kept.length - 1]
  if (last && last.p === s.p) return kept
  return [...kept, s].slice(-200)
}

/**
 * Cuándo se llegaría al 100 % al ritmo de las últimas 24 h (o desde la
 * primera muestra). null si hay menos de 20 minutos de historia o el uso no
 * ha subido.
 */
export function projectFull(samples: Sample[], now: number, percent: number): number | null {
  if (percent >= 100) return now
  const first = samples[0]
  if (!first) return null
  const dt = now - first.t
  const dp = percent - first.p
  if (dt < 20 * 60_000 || dp <= 0) return null
  return now + ((100 - percent) * dt) / dp
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

/** "dom 00:15" en la zona horaria indicada (por defecto Madrid). */
export function when(ms: number, timeZone = 'Europe/Madrid'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const get = (k: string) => parts.find(p => p.type === k)?.value ?? ''
    const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
    return `${DAYS[idx] ?? get('weekday')} ${get('hour')}:${get('minute')}`
  } catch {
    const d = new Date(ms)
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    return `${DAYS[d.getUTCDay()]} ${hh}:${mm} UTC`
  }
}

export function limitLabel(kind: string): string {
  if (kind === 'seven_day') return 'Límite semanal'
  if (kind === 'five_hour') return 'Límite de 5 h'
  if (kind === 'spend_limit') return 'Límite de gasto'
  return `Límite ${kind}`
}

/** Traduce el statusCheckRollup de `gh pr view` a un estado de CI. */
export function ciFromRollup(rollup: unknown): { ci: CiState; checks: Check[] } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { ci: 'none', checks: [] }
  const checks: Check[] = rollup.map((r: any) => {
    const name = String(r?.name ?? r?.context ?? 'check')
    const conclusion = String(r?.conclusion ?? '').toUpperCase()
    const status = String(r?.status ?? '').toUpperCase()
    const state = String(r?.state ?? '').toUpperCase()
    let s: CiState = 'pass'
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion) ||
        ['FAILURE', 'ERROR'].includes(state)) s = 'fail'
    else if ((status && status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(state)) s = 'pending'
    return { name, state: s }
  })
  const ci: CiState = checks.some(c => c.state === 'fail')
    ? 'fail'
    : checks.some(c => c.state === 'pending')
      ? 'pending'
      : 'pass'
  return { ci, checks }
}

/** Nombre corto del repo a partir del remote (git@…:owner/name.git o https://…/owner/name). */
export function repoName(remote: string | null, root: string): string {
  const src = remote ?? root
  const last = src.replace(/\/+$/, '').split(/[/:]/).pop() ?? src
  return last.replace(/\.git$/, '')
}

/** "ahora", "hace 5 min", "hace 2 h", "hace 3 días". */
export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 2) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `hace ${h} h`
  return `hace ${Math.floor(h / 24)} días`
}

/** Cuándo empezó la ventana de un límite, a partir de su reinicio. */
export function windowStart(kind: string, resetsAt?: string): number | null {
  if (!resetsAt) return null
  const reset = Date.parse(resetsAt)
  if (Number.isNaN(reset)) return null
  if (kind === 'five_hour') return reset - 5 * 3600_000
  if (kind === 'seven_day') return reset - 7 * 24 * 3600_000
  return null
}

export type Spend = { t: number; d: number }

/** Suma lo gastado desde `since` en todos los registros. */
export function spentSince(ledgers: Spend[][], since: number): number {
  let total = 0
  for (const l of ledgers) for (const x of l) if (x.t >= since) total += x.d
  return total
}
