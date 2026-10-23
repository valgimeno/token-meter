import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { CiState, Limit, RepoInfo, Snapshot, Tokens } from '../types'
import {
  addSample,
  ciFromRollup,
  inputTotal,
  limitLabel,
  projectFull,
  repoName,
  usd,
  weightOf,
  when,
  type Sample,
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

  const snap: Snapshot = { usd: u.cost?.usd, contextPercent: u.context.percent, limits }
  await update($, snapshot, () => snap)

  const parts = ['token-meter']
  if (snap.usd !== undefined) parts.push(usd(snap.usd))
  if (snap.contextPercent !== undefined) parts.push(`ctx ${snap.contextPercent}%`)
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
      }
    } catch {
      pr = null
    }

    const info: RepoInfo = { name, branch, pr }
    await update($, repo, () => info)
    const stored = await $.store.get(branchKey(info))
    await update($, branchUsd, () => (stored === undefined ? null : Number(stored)))
  } finally {
    isRefreshing = false
  }
}

// Qué es y por qué importa cada métrica: se muestra al pasar el puntero.
const HELP: Record<string, string> = {
  pr: 'El pull request abierto desde esta rama: la propuesta de cambios que espera revisión y fusión.',
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
    const prefs = (await $.store.get('prefs')) as Prefs | undefined
    if (prefs?.hideRepo !== undefined) await update($, hideRepo, () => Boolean(prefs.hideRepo))
    if (prefs?.showHelp !== undefined) await update($, showHelp, () => Boolean(prefs.showHelp))

    const u = await $.session.usage()
    if ((await read($, lastUsd)) === null) {
      // Solo cuenta para la rama lo gastado desde ahora.
      const start = u.cost?.usd ?? 0
      await update($, lastUsd, () => start)
    }
    await refreshRepo($)
    await record($, u)
    $.clock.every(60_000, () => void refreshRepo($))

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

    if (!snap && !r) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const shown: string[] = []

    const metric = (id: string, label: string, value: string, color: string, extra?: string) => {
      shown.push(id)
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
    const repoRow =
      r && !isRepoHidden ? (
        <Box flexWrap="wrap" columnGap={2}>
          {r.pr
            ? metric('pr', 'PR', `#${r.pr.number}`, 'success')
            : metric('pr', 'PR', 'ninguno abierto', 'subtle')}
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
      ) : null
    if (r?.pr && !isRepoHidden) shown.push('diff')

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
      const resetText = Number.isNaN(reset) ? '' : ` · reinicio ${when(reset)}`
      const helpId = HELP[l.kind] ? l.kind : 'seven_day'
      items.push(metric(helpId, limitLabel(l.kind), `${l.percentUsed}%${proj}`, color, resetText))
    }

    const meterRow = items.length > 0 ? <Box flexWrap="wrap" columnGap={2}>{items as any}</Box> : null

    // Fila 3: la explicación de la métrica bajo el puntero
    const helpRow = isHelpOn ? (
      <Box>
        <Text dimColor>ⓘ </Text>
        {shown.map(id => (
          <Box key={`h-${id}`} display="none" hover={{ scope: `tm-${id}`, display: 'flex' }}>
            <Text>{HELP[id] ?? ''}</Text>
          </Box>
        ))}
        <Text dimColor> (pasa el puntero por una métrica para ver qué es y por qué importa)</Text>
      </Box>
    ) : null

    // Fila 4: controles
    const controls = (
      <Box columnGap={1} flexWrap="wrap">
        <Button
          key="help"
          plain
          label={isHelpOn ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
          onPress={async () => {
            await update($, showHelp, v => !v)
            await savePrefs($)
          }}
        />
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
