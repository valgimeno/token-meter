import { expect, mock, test } from 'claude-code/testing'

import { ciFromRollup, projectFull, weightOf, when } from '../hooks/calc'

const usage = (i: number, o: number, cr: number, cw: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
})

test('el peso de coste refleja tipo de token y familia de modelo', async () => {
  expect(weightOf(usage(100, 0, 0, 0), 'claude-haiku-5-5')).toBe(100)
  expect(weightOf(usage(0, 100, 0, 0), 'claude-haiku-5-5')).toBe(500)
  expect(weightOf(usage(0, 0, 1000, 0), 'claude-sonnet-5-5')).toBe(300)
  expect(weightOf(usage(100, 0, 0, 0), 'claude-opus-5-5')).toBe(500)
})

test('la proyección necesita ritmo y lo extrapola', async () => {
  const h = 3600_000
  expect(projectFull([], 10 * h, 20)).toBe(null)
  expect(projectFull([{ t: 9.9 * h, p: 10 }], 10 * h, 20)).toBe(null)
  expect(projectFull([{ t: 0, p: 10 }], 10 * h, 10)).toBe(null)
  // 10 puntos en 10 h → faltan 80 → 80 h más
  expect(projectFull([{ t: 0, p: 10 }], 10 * h, 20)).toBe(90 * h)
  expect(projectFull([{ t: 0, p: 10 }], 10 * h, 100)).toBe(10 * h)
})

test('el estado de CI sale de los checks del PR', async () => {
  expect(ciFromRollup([]).ci).toBe('none')
  expect(ciFromRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }]).ci).toBe('pass')
  expect(ciFromRollup([{ name: 'a', status: 'IN_PROGRESS', conclusion: '' }]).ci).toBe('pending')
  expect(
    ciFromRollup([
      { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'b', state: 'FAILURE' },
    ]).ci,
  ).toBe('fail')
})

test('las fechas se muestran como día y hora de Madrid', async () => {
  // domingo 11-10-2026 22:15 UTC = lunes 00:15 en Madrid (UTC+2)
  expect(when(Date.parse('2026-10-11T22:15:00Z'))).toBe('lun 00:15')
})

const BAND = {
  plugin: 'token-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('la banda muestra PR, coste, subagentes, caché, contexto y límite', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  mock.store(on, {
    'samples:seven_day:2026-10-15T07:00:00Z': [{ t: Date.parse('2026-10-08T10:00:00Z'), p: 6 }],
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('session.repo', () => ({
    value: { root: '/r', remote: 'git@github.com:acme/gao-strategy.git', internal: false, name: null },
  }))
  on('process.run', (_$, e) => {
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'git') return ok('worktree-f49-guidance-gaps\n')
    return ok(
      JSON.stringify({
        number: 410,
        additions: 222,
        deletions: 36,
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
    )
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))

  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })

  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { ...usage(100, 100, 9000, 100), model: 'claude-opus-5-5' },
  })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    agentId: 'a1',
    reason: 'answer',
    usage: { ...usage(1000, 1000, 9000, 1000), model: 'claude-opus-5-5' },
  })

  await $.session.measure({
    context: { window: 200_000, tokens: 30_000, percent: 15 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 16, resetsAt: '2026-10-15T07:00:00Z' }],
    cost: { usd: 7.04 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  void clock

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(texts).toContain('#410')
    expect(texts).toContain('gao-strategy')
    expect(texts).toContain('worktree-f49-guidance-gaps')
    expect(texts).toContain('+222')
    expect(texts).toContain('● pasan')
    expect(texts).toContain('$7.04')
    expect(texts).toContain('Coste en esta rama')
    expect(texts).toContain('Subagentes')
    expect(texts).toContain('Reutilizado de caché')
    expect(texts).toContain('Contexto usado')
    expect(texts).toContain('15%')
    expect(texts).toContain('Límite semanal')
    // 10 puntos en 24 h → faltan 84 → 8,4 días: después del reinicio
    expect(texts).toContain('16% → 100% ~sáb 21:36')
    expect(texts).toContain('reinicio jue 09:00')

    await ui.press({ key: 'repo' })
    const after = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(after).not.toContain('#410')
    await ui.press({ key: 'repo' })
    await ui.unmount()
  }
})
