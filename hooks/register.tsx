import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { CiState, Limit, RepoInfo, Snapshot, Tokens } from '../types'
import {
  addSample,
  ago,
  ciFromRollup,
  inputTotal,
  limitLabel,
  projectFull,
  repoName,
  spentSince,
  usd,
  weightOf,
  when,
  windowStart,
  type Sample,
  type Spend,
} from './calc'

const snapshot = atom({ plugin: 'token-meter', key: 'snapshot' } as const, null as Snapshot | null)
const tokens = atom({ plugin: 'token-meter', key: 'tokens' } as const, {
  mainW: 0,
  subW: 0,
  cacheRead: 0,
  inputTotal: 0,
} as Tokens)
const repo = atom({ plugin: 'token-meter', key: 'repo' } as const, null as RepoInfo | null)
const branchUsd = atom({ plugin: 'token-meter', key: 'branchUsd' } as const, null as number | null)
const lastUsd = atom({ plugin: 'token-meter', key: 'lastUsd' } as const, null as number | null)
const hideRepo = atom({ plugin: 'token-meter', key: 'hideRepo' } as const, false)
const showHelp = atom({ plugin: 'token-meter', key: 'showHelp' } as const, true)
const showChecks = atom({ plugin: 'token-meter', key: 'showChecks' } as const, false)
const showLegend = atom({ plugin: 'token-meter', key: 'showLegend' } as const, false)
const tick = atom({ plugin: 'token-meter', key: 'tick' } as const, 0)

let sessionId = ''

type Prefs = { hideRepo?: boolean; showHelp?: boolean }
type Usage = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const branchKey = (r: RepoInfo) => `branch:${r.name}@${r.branch}`

async function savePrefs($: EngineInterface) {
  const prefs: Prefs = { hideRepo: await read($, hideRepo), showHelp: await read($, showHelp) }
  await $.store.set('prefs', prefs)
}

/** Guarda una medición: coste, contexto, límites con proyección y coste por rama. */
async function record($: EngineInterface, u: Usage) {
  const now = await $.clock.now()

  // Registro de gasto de esta sesión, para saber cuánto se gastó en cada ventana.
  if (u.cost) {
    const before = await read($, lastUsd)
    if (before !== null && u.cost.usd > before) {
      const key = `ledger:${sessionId || 'unknown'}`
      const prev = ((await $.store.get(key)) as Spend[] | undefined) ?? []
      const kept = prev.filter(x => now - x.t <= 8 * 24 * 3600_000)
      await $.store.set(key, [...kept, { t: now, d: u.cost.usd - before }].slice(-5000))
    }
  }
  const ledgers: Spend[][] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('ledger:')) continue
    const l = ((await $.store.get(k)) as Spend[] | undefined) ?? []
    if (l.length > 0 && l.every(x => now - x.t > 8 * 24 * 3600_000)) await $.store.delete(k)
    else ledgers.push(l)
  }

  const limits: Limit[] = []
  for (const rl of u.rateLimits) {
    const key = `samples:${rl.kind}:${rl.resetsAt ?? ''}`
    const prev = ((await $.store.get(key)) as Sample[] | undefined) ?? []
    const samples = addSample(prev, { t: now, p: rl.percentUsed })
    await $.store.set(key, samples)
    limits.push({
      kind: rl.kind,
      percentUsed: rl.percentUsed,
      resetsAt: rl.resetsAt,
      fullAt: projectFull(samples, now, rl.percentUsed),
      blockUsd: (() => {
        const start = windowStart(rl.kind, rl.resetsAt)
        return start === null ? null : spentSince(ledgers, start)
      })(),
    })
  }

  if (u.cost) {
    const before = await read($, lastUsd)
    const r = await read($, repo)
    if (before !== null && u.cost.usd > before && r) {
      const key = branchKey(r)
      const total = Number((await $.store.get(key)) ?? 0) + (u.cost.usd - before)
      await $.store.set(key, total)
      await update($, branchUsd, () => total)
    }
    const spent = u.cost.usd
    await update($, lastUsd, () => spent)
  }

  const snap: Snapshot = { usd: u.cost?.usd, contextPercent: u.context.percent, limits, measuredAt: now }
  await update($, snapshot, () => snap)

  const parts: string[] = []
  if (snap.usd !== undefined) parts.push(`sesión ${usd(snap.usd)}`)
  if (snap.contextPercent !== undefined) parts.push(`contexto ${snap.contextPercent}%`)
  $.ui.status(parts.join(' · '))
}

let isRefreshing = false

/** Lee rama, repo y PR/CI con git y gh. Sin repo, la fila del PR desaparece. */
async function refreshRepo($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    let branch: string | null = null
    try {
      const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
      if (r.exitCode === 0) branch = r.stdout.trim() || null
    } catch {
      branch = null
    }
    if (!branch) {
      await update($, repo, () => null)
      return
    }

    const sr = await $.session.repo()
    const name = sr ? repoName(sr.remote, sr.root) : 'repo'

    let pr: RepoInfo['pr'] = null
    let prNote: RepoInfo['prNote'] = 'unavailable'
    try {
      const r = await $.process.run(
        ['gh', 'pr', 'view', '--json', 'number,additions,deletions,statusCheckRollup'],
        { timeoutMs: 20_000 },
      )
      if (r.exitCode === 0) {
        const j = JSON.parse(r.stdout)
        const { ci, checks } = ciFromRollup(j.statusCheckRollup)
        pr = {
          number: Number(j.number),
          additions: Number(j.additions ?? 0),
          deletions: Number(j.deletions ?? 0),
          ci,
          checks,
        }
        prNote = undefined
      } else if (/no (open )?pull requests? found/i.test(r.stderr)) {
        prNote = 'none'
      }
    } catch {
      pr = null
    }

    const info: RepoInfo = { name, branch, pr, prNote }
    await update($, repo, () => info)
    const stored = await $.store.get(branchKey(info))
    await update($, branchUsd, () => (stored === undefined ? null : Number(stored)))
  } finally {
    isRefreshing = false
  }
}

// Qué es y por qué importa cada métrica: al pasar el puntero, o en la leyenda.
const HELP: Record<string, string> = {
  pr: 'El pull request abierto desde esta rama: la propuesta de cambios que espera revisión y fusión.',
  prgh: 'No se pudo preguntar a GitHub por el PR: en este ordenador falta la herramienta gh o no tiene la sesión iniciada (instálala y ejecuta “gh auth login”).',
  diff: 'Líneas añadidas (+) y quitadas (−) por el PR. Cuanto más grande, más cuesta revisarlo.',
  ci: 'Las pruebas automáticas del PR. Verde: se puede fusionar con tranquilidad; rojo: algo se rompió.',
  session:
    'Lo que costaría esta sesión al precio de la API, subagentes incluidos. Con suscripción no lo pagas así: sirve para comparar cuánto pesa cada cosa.',
  branch:
    'Coste acumulado mientras trabajabas en esta rama, sumando todas las sesiones. Te dice cuánto te está costando esta línea de trabajo. Aproximado.',
  sub: 'Coste estimado de los ayudantes que Claude lanza en paralelo, y su peso sobre el total. Si domina, delegar te está saliendo caro.',
  cache:
    'Parte del texto de entrada que Claude reutiliza de caché en vez de procesarlo de nuevo. Alto es más barato y rápido; si cae, la conversación se está recalculando.',
  ctx: 'Cuánto de la memoria de trabajo de esta conversación está ocupado. Por encima del 80 % Claude resume y pierde detalle: conviene abrir un chat nuevo.',
  seven_day:
    'Cuánto has usado de tu cuota semanal. La flecha estima cuándo la agotarías al ritmo de las últimas 24 h; en rojo si sería antes de que se reinicie.',
  five_hour:
    'Cuánto has usado de tu cuota de 5 horas. La flecha estima cuándo la agotarías a este ritmo; en rojo si sería antes de que se reinicie.',
  block:
    'Lo gastado (en coste equivalente) desde que empezó cada ventana, sumando todas tus sesiones con el Mod activo. Te dice cuánto “vale” cada punto de cuota. Aproximado.',
  age: 'Cuándo llegó el último dato. Las cifras solo se actualizan cuando Claude responde en esta sesión: si es antiguo, escribe algo para refrescarlo.',
}

const CI_TEXT: Record<CiState, string> = {
  pass: '● pasan',
  fail: '● fallan',
  pending: '● en curso',
  none: 'sin pruebas',
}
const CI_COLOR: Record<CiState, string> = {
  pass: 'success',
  fail: 'error',
  pending: 'warning',
  none: 'subtle',
}

const level = (v: number, warn: number, bad: number) => (v >= bad ? 'error' : v >= warn ? 'warning' : 'success')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const prefs = (await $.store.get('prefs')) as Prefs | undefined
    if (prefs?.hideRepo !== undefined) await update($, hideRepo, () => Boolean(prefs.hideRepo))
    if (prefs?.showHelp !== undefined) await update($, showHelp, () => Boolean(prefs.showHelp))

    const u = await $.session.usage()
    if ((await read($, lastUsd)) === null) {
      // Solo cuenta para la rama y las ventanas lo gastado desde ahora.
      const start = u.cost?.usd ?? 0
      await update($, lastUsd, () => start)
    }
    await refreshRepo($)
    await record($, u)
    $.clock.every(60_000, () => {
      void refreshRepo($)
      void update($, tick, n => n + 1)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await record($, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      const w = weightOf(u, u.model)
      const isSub = e.agentId !== undefined
      await update($, tokens, t => ({
        mainW: t.mainW + (isSub ? 0 : w),
        subW: t.subW + (isSub ? w : 0),
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        inputTotal: t.inputTotal + inputTotal(u),
      }))
    }
    if (e.agentId === undefined) void refreshRepo($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const snap = await read($, snapshot)
    const tok = await read($, tokens)
    const r = await read($, repo)
    const bUsd = await read($, branchUsd)
    const isRepoHidden = await read($, hideRepo)
    const isHelpOn = await read($, showHelp)
    const isChecksOn = await read($, showChecks)
    const isLegendOn = await read($, showLegend)
    await read($, tick) // redibuja cada minuto, para que "hace X min" avance
    const now = await $.clock.now()

    if (!snap && !r) return next(e)

    // En la terminal el puntero no siempre llega: allí, leyenda con botón.
    const isTerminal = e.surface === 'terminal'
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown: { id: string; label: string }[] = []

    const metric = (id: string, label: string, value: string, color: string, extra?: string) => {
      if (!shown.some(x => x.id === id)) shown.push({ id, label })
      return (
        <Box key={`m-${id}`} hover={{ scope: `tm-${id}` }}>
          <Text dimColor>{label} </Text>
          <Text color={color} bold>
            {value}
          </Text>
          {extra ? <Text dimColor>{extra}</Text> : null}
        </Box>
      )
    }

    // Fila 1: repositorio, rama, PR y pruebas
    let repoRow = null
    if (r && !isRepoHidden) {
      const prCell = r.pr
        ? metric('pr', 'PR', `#${r.pr.number}`, 'success')
        : r.prNote === 'none'
          ? metric('pr', 'PR', 'ninguno abierto', 'subtle')
          : metric('pr', 'PR', 'no se pudo consultar GitHub', 'warning')
      repoRow = (
        <Box flexWrap="wrap" columnGap={2}>
          {prCell}
          <Box>
            <Text dimColor>Repo </Text>
            <Text>{r.name}</Text>
          </Box>
          <Box>
            <Text dimColor>Rama </Text>
            <Text>{r.branch}</Text>
          </Box>
          {r.pr ? (
            <Box key="m-diff" hover={{ scope: 'tm-diff' }}>
              <Text dimColor>Cambios del PR </Text>
              <Text color="diffAdded">+{r.pr.additions} </Text>
              <Text color="diffRemoved">−{r.pr.deletions}</Text>
            </Box>
          ) : null}
          {r.pr ? metric('ci', 'Pruebas (CI)', CI_TEXT[r.pr.ci], CI_COLOR[r.pr.ci]) : null}
        </Box>
      )
      if (r.pr) shown.push({ id: 'diff', label: 'Cambios del PR' })
      if (!r.pr && r.prNote !== 'none') shown.push({ id: 'prgh', label: 'PR: no se pudo consultar GitHub' })
    }

    const checksRow =
      r?.pr && !isRepoHidden && isChecksOn && r.pr.checks.length > 0 ? (
        <Box flexWrap="wrap" columnGap={2}>
          {r.pr.checks.map(c => (
            <Text color={CI_COLOR[c.state]}>● {c.name}</Text>
          ))}
        </Box>
      ) : null

    // Fila 2: medidor de consumo
    const items: unknown[] = []
    if (snap?.usd !== undefined) {
      items.push(metric('session', 'Coste de la sesión', usd(snap.usd), 'text'))
      if (bUsd !== null && r) items.push(metric('branch', 'Coste en esta rama', `~${usd(bUsd)}`, 'text'))
      const totalW = tok.mainW + tok.subW
      if (tok.subW > 0 && totalW > 0) {
        const share = tok.subW / totalW
        items.push(
          metric(
            'sub',
            'Subagentes',
            `~${usd(snap.usd * share)}`,
            share > 0.6 ? 'warning' : 'text',
            ` (${Math.round(share * 100)}%)`,
          ),
        )
      }
    }
    if (tok.inputTotal > 0) {
      const pct = Math.round((tok.cacheRead / tok.inputTotal) * 100)
      items.push(metric('cache', 'Reutilizado de caché', `${pct}%`, pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'error'))
    }
    if (snap?.contextPercent !== undefined) {
      items.push(metric('ctx', 'Contexto usado', `${snap.contextPercent}%`, level(snap.contextPercent, 50, 80)))
    }
    for (const l of snap?.limits ?? []) {
      const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const isBeforeReset = l.fullAt !== null && (Number.isNaN(reset) || l.fullAt < reset)
      const color = isBeforeReset ? 'error' : level(l.percentUsed, 70, 90)
      const proj = l.fullAt !== null ? ` → 100% ~${when(l.fullAt)}` : ''
      const spent = l.blockUsd !== null && l.blockUsd > 0 ? ` · ~${usd(l.blockUsd)} gastados` : ''
      const resetText = Number.isNaN(reset) ? '' : ` · reinicio ${when(reset)}`
      const helpId = HELP[l.kind] ? l.kind : 'seven_day'
      items.push(metric(helpId, limitLabel(l.kind), `${l.percentUsed}%${proj}`, color, `${spent}${resetText}`))
      if (spent) shown.push({ id: 'block', label: '“~$ gastados” junto a un límite' })
    }
    if (snap) {
      const age = now - snap.measuredAt
      items.push(metric('age', 'Datos', ago(age), age > 30 * 60_000 ? 'warning' : 'subtle'))
    }

    const meterRow = items.length > 0 ? <Box flexWrap="wrap" columnGap={2}>{items as any}</Box> : null

    // Fila 3: explicaciones. Escritorio: la de la métrica bajo el puntero. Terminal: leyenda completa.
    let helpRow = null
    if (isTerminal && isLegendOn) {
      helpRow = (
        <Box flexDirection="column">
          {shown.map(x => (
            <Text>
              <Text bold>{x.label}: </Text>
              {HELP[x.id] ?? ''}
            </Text>
          ))}
        </Box>
      )
    } else if (!isTerminal && isHelpOn) {
      helpRow = (
        <Box>
          <Text dimColor>ⓘ </Text>
          {shown.map(x => (
            <Box key={`h-${x.id}`} display="none" hover={{ scope: `tm-${x.id}`, display: 'flex' }}>
              <Text>{HELP[x.id] ?? ''}</Text>
            </Box>
          ))}
          <Text dimColor> (pasa el puntero por una métrica para ver qué es y por qué importa)</Text>
        </Box>
      )
    }

    // Fila 4: controles
    const controls = (
      <Box columnGap={1} flexWrap="wrap">
        {isTerminal ? (
          <Button
            key="legend"
            plain
            label={isLegendOn ? 'Ocultar significados' : 'Qué significa cada cosa'}
            onPress={() => update($, showLegend, v => !v)}
          />
        ) : (
          <Button
            key="help"
            plain
            label={isHelpOn ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
            onPress={async () => {
              await update($, showHelp, v => !v)
              await savePrefs($)
            }}
          />
        )}
        {r ? (
          <Button
            key="repo"
            plain
            label={isRepoHidden ? 'Mostrar repo' : 'Ocultar repo'}
            onPress={async () => {
              await update($, hideRepo, v => !v)
              await savePrefs($)
            }}
          />
        ) : null}
        {r?.pr && !isRepoHidden && r.pr.checks.length > 0 ? (
          <Button
            key="checks"
            plain
            label={isChecksOn ? 'Ocultar pruebas' : 'Ver pruebas'}
            onPress={() => update($, showChecks, v => !v)}
          />
        ) : null}
        {r ? <Button key="refresh" plain label="Actualizar PR" onPress={() => void refreshRepo($)} /> : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {repoRow}
        {checksRow}
        {meterRow}
        {helpRow}
        {controls}
      </Box>
    )
  })
}
