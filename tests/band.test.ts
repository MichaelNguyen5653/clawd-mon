import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { newSave, type Save } from '../hooks/engine'
import { GROWTH, SPECIES } from './fixtures'

const PLUGIN = 'clawd-mon'
// A 1x1 PNG, base64.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const WORKING = { ...BAND, props: { ...BAND.props, isWorking: true } } as const

const COMMAND = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const MESSAGES = [{ role: 'user' as const, text: 'hello', toolUses: [] }]

type Counters = { compacts: number; spriteReads: string[]; toasts: string[]; saveReads: number; onSaveRead?: (n: number) => void; store: Map<string, unknown> }

/** The engine beneath the plugin: fixed usage, the data files, a sprite, a compact that works. */
function world(on: On, percent = 62, options: { noSprites?: boolean } = {}): Counters {
  const seen: Counters = { compacts: 0, spriteReads: [], toasts: [], saveReads: 0, store: new Map() }
  on('store.get', (_$, e) => {
    if (e.key === 'save') seen.onSaveRead?.(++seen.saveReads)
    return { value: seen.store.get(e.key) }
  })
  on('store.set', (_$, e) => {
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    seen.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: percent * 2000, window: 200_000, percent },
      rateLimits: [],
    },
  }))
  on('config.list', () => ({ value: [] }))
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('pokedex.json')) return { value: JSON.stringify(SPECIES) }
    if (e.path.endsWith('growth.json')) return { value: JSON.stringify(GROWTH) }
    if (e.path.endsWith('.png')) {
      if (options.noSprites) throw new Error('no such file')
      seen.spriteReads.push(e.path)
      return { value: { base64: PNG } }
    }
    throw new Error(`unexpected read ${e.path}`)
  })
  on('session.compact', () => {
    seen.compacts += 1
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({})
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return seen
}

function mon(id: number, xp: number, extra: Partial<Save> = {}): Save {
  return { ...newSave(), phase: 'mon', speciesId: id, xp, ...extra }
}

describe('band', () => {
  test('desktop draws the sprite, name, level and an Evolve button', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000, { pending: 321 }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Svg' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bulbasaur/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Lv \d+/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /321/ })).toBeDefined()
    expect(await ui.find({ key: 'evolve' })).toBeDefined()
    expect(await ui.find({ key: 'hide' })).toBeDefined()
    expect(seen.spriteReads.some(p => p.endsWith('1.png'))).toBe(true)
    await ui.unmount()
  })

  test('terminal draws the Image and the same facts as text', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000, { pending: 321 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bulbasaur/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /321/ })).toBeDefined()
    expect(await ui.find({ key: 'evolve' })).toBeDefined()
    await ui.unmount()
  })

  test('an egg shows its crack stage and the egg sprite', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', { ...newSave(), eggStage: 1, xp: 900 })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /Egg/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    expect(seen.spriteReads.some(p => p.endsWith('egg.png'))).toBe(true)
    await ui.unmount()
  })

  test('a missing sprite file still draws the band, with no picture', async ($, on) => {
    const seen = world(on, 62, { noSprites: true })
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Bulbasaur/ })).toBeDefined()
    await ui.unmount()
  })

  test('recommends evolving at 60% context, not below', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /Evolve recommended/ })).toBeDefined()
    await ui.unmount()
    await $.session.measure({
      context: { tokens: 40_000, window: 200_000, percent: 20 },
      rateLimits: [],
      changed: ['context'],
    })
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /Evolve recommended/ })).toBeUndefined()
    await ui.unmount()
  })

  test('Evolve compacts and applies the pending XP on both surfaces', async ($, on) => {
    const seen = world(on)
    for (const surface of ['desktop', 'terminal'] as const) {
      seen.compacts = 0
      seen.toasts.length = 0
      seen.store.set('save', mon(25, 0, { pending: 1000, compacts: 0 }))
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      await ui.press({ key: 'evolve' })
      expect(seen.compacts).toBe(1)
      const saved = seen.store.get('save') as Save
      expect(saved.pending).toBe(0)
      expect(saved.xp).toBe(1000)
      expect(saved.compacts).toBe(1) // 62% context qualifies
      expect(saved.lifetime.compacts).toBe(1) // applied once, not twice
      expect(seen.toasts.filter(x => /Level up/.test(x)).length).toBeLessThanOrEqual(1)
      await ui.unmount()
    }
  })

  test('one Evolve press moves an egg at most one stage and applies once', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', { ...newSave(), pending: 5000 })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    await ui.press({ key: 'evolve' })
    const saved = seen.store.get('save') as Save
    expect(seen.compacts).toBe(1)
    expect(saved.eggStage).toBe(1)
    expect(saved.lifetime.compacts).toBe(1)
    expect(saved.compacts).toBe(1)
    expect(seen.toasts.filter(x => /cracked/.test(x))).toHaveLength(1)
    await ui.unmount()
  })

  test('Evolve does nothing while a turn is running', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(25, 0, { pending: 1000 }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...WORKING })
    await ui.press({ key: 'evolve' })
    expect(seen.compacts).toBe(0)
    expect((seen.store.get('save') as Save).pending).toBe(1000)
    await ui.unmount()
  })

  test('x hides the band and /clawd-mon show brings it back', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'hide' })
    expect(seen.store.get('isHidden')).toBe(true)
    await ui.unmount()
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ key: 'evolve' })).toBeUndefined()
    await $.command.run({ command: PLUGIN, args: 'show', ...COMMAND })
    await ui.unmount()
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ key: 'evolve' })).toBeDefined()
    await ui.unmount()
  })

  test('a survey in the band slot gets out of the way', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      ...BAND,
      props: { ...BAND.props, hasSurvey: true },
    })
    expect(await ui.find({ key: 'evolve' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('hooks', () => {
  test('turn.complete banks real token usage as pending XP, not applied XP', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(25, 0))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.turn.complete({
      answer: 'ok',
      durationMs: 10,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: {
        model: 'm',
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 900_000,
      },
    })
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBe(2) // 2,000 new tokens; cache reads do not count
    expect(saved.xp).toBe(0)
  })

  test('a turn at 80%+ context decays pending by 2%', async ($, on) => {
    const seen = world(on, 85)
    seen.store.set('save', mon(25, 0, { pending: 1000 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBeLessThan(1000)
    expect(saved.pending).toBeGreaterThan(970)
  })

  test('a compact from another plugin applies the bank through the session.compact hook', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 400 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBe(0)
    expect(saved.xp).toBe(400)
  })

  test('a plugin-trigger compact through the hook applies once', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 400 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'plugin', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(saved.xp).toBe(400)
    expect(saved.lifetime.compacts).toBe(1)
  })

  test('an auto-compact applies half of the pending XP', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 400 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBe(0)
    expect(saved.xp).toBe(200)
  })

  test('a precompute applies nothing', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 400 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
    expect((seen.store.get('save') as Save).pending).toBe(400)
  })

  test('a write by another session between load and set is not lost', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(25, 0, { pending: 100 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    // The second read of the save in the next mutation is the re-check: another session
    // writes just before it answers.
    seen.saveReads = 0
    seen.onSaveRead = n => {
      if (n !== 2) return
      const other = seen.store.get('save') as Save
      seen.store.set('save', { ...other, rev: other.rev + 1, pending: other.pending + 500 })
    }
    await $.turn.complete({
      answer: '',
      durationMs: 1,
      isAborted: false,
      turnId: 't',
      reason: 'answer',
      usage: { model: 'm', input_tokens: 2000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBe(602) // 100 + the other session's 500 + our 2
    expect(saved.rev).toBeGreaterThanOrEqual(2)
  })

  test('the command registers and reset-all needs confirm, then wipes the store', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(3, 99_999, { pending: 5 }))
    seen.store.set('isHidden', true)
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ask = await $.command.run({ command: PLUGIN, args: 'reset-all', ...COMMAND })
    expect(ask.text).toMatch(/confirm/)
    expect((seen.store.get('save') as Save).speciesId).toBe(3)
    const done = await $.command.run({ command: PLUGIN, args: 'reset-all confirm', ...COMMAND })
    expect(done.text).toMatch(/fresh/i)
    const after = seen.store.get('save') as Save | undefined
    expect(after === undefined || after.phase === 'egg').toBe(true)
    expect(seen.store.get('isHidden')).toBeUndefined()
  })

  test('reset keeps lifetime totals in the store', async ($, on) => {
    const seen = world(on)
    const s = mon(3, 99_999)
    seen.store.set('save', { ...s, lifetime: { tokens: 9, xp: 9, compacts: 9, hatches: 1, evolutions: 2 } })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: PLUGIN, args: 'reset', ...COMMAND })
    const saved = seen.store.get('save') as Save
    expect(saved.phase).toBe('egg')
    expect(saved.lifetime.evolutions).toBe(2)
  })

  test('first run with an empty store starts an egg', async ($, on) => {
    const seen = world(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /Egg/ })).toBeDefined()
    await ui.unmount()
  })
})
