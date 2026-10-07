import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { activeEntry, newEntry, newSave, type Entry, type Save } from '../hooks/engine'
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

const BOUNDS = { '1': [28, 30, 35, 33], egg: [34, 34, 28, 30] }
const MESSAGES = [{ role: 'user' as const, text: 'hello', toolUses: [] }]

type Counters = { compacts: number; queuedCompacts: number; runQueued?: boolean; spriteReads: string[]; toasts: string[]; saveReads: number; onSaveRead?: (n: number) => void; store: Map<string, unknown>; agents?: Array<{ id: string; name?: string; description: string; type: string; status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' }>; toolGate?: Promise<void>; toolResult?: (e: { tool: string }) => unknown }

/** The engine beneath the plugin: fixed usage, the data files, a sprite, a compact that works. */
function world(on: On, percent = 62, options: { noSprites?: boolean; noLists?: boolean; compactRejects?: string; headless?: boolean } = {}): Counters {
  const seen: Counters = { compacts: 0, queuedCompacts: 0, spriteReads: [], toasts: [], saveReads: 0, store: new Map() }
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
  on('tool.list', () => {
    if (options.noLists) throw new Error('no tool list')
    return {
      value: [
        { name: 'Read', description: 'reads', mcp: false },
        { name: 'Bash', description: 'runs', mcp: false },
        { name: 'mcp__srv__thing', description: 'thing', mcp: true },
      ],
    }
  })
  on('agent.list', () => {
    if (options.noLists) throw new Error('no agent list')
    return {
      value: seen.agents ?? [
        { id: 'a1', description: 'scan', type: 'Explore', status: 'running' },
        { id: 'a2', description: 'plan', type: 'Plan', status: 'completed' },
      ],
    }
  })
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 't1', tool: 'Bash', input: {} },
          { tool_use_id: 't2', tool: 'Read', input: {} },
          { tool_use_id: 't3', tool: 'Read', input: {} },
        ],
      },
    ],
  }))
  on('tool.call', async (_$, e) => {
    await seen.toolGate // a test holds a call in flight by setting this
    return (seen.toolResult?.(e) ?? { result: { text: 'ok' } }) as { result: { text: string } }
  })
  on('config.list', () => ({ value: [] }))
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('pokedex.json')) return { value: JSON.stringify(SPECIES) }
    if (e.path.endsWith('growth.json')) return { value: JSON.stringify(GROWTH) }
    if (e.path.endsWith('sprite-bounds.json')) return { value: JSON.stringify(BOUNDS) }
    if (e.path.endsWith('.png')) {
      if (options.noSprites) throw new Error('no such file')
      seen.spriteReads.push(e.path)
      return { value: { base64: PNG } }
    }
    throw new Error(`unexpected read ${e.path}`)
  })
  // Headless (-p / SDK, the desktop Code tab): a plugin's own compact is refused; /compact is queued instead.
  on('session.compact', () => {
    if (options.compactRejects) throw new Error(options.compactRejects)
    if (options.headless && !seen.runQueued) throw new Error('not available in a headless (-p / SDK) session yet')
    seen.compacts += 1
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  if (options.headless) {
    on('command.run', { command: 'compact' }, () => {
      seen.queuedCompacts += 1
      return {}
    })
  }
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

const A = activeEntry
const ENTRY_KEYS = new Set(['phase', 'target', 'speciesId', 'chosen', 'xp', 'eggStage', 'compacts', 'branch', 'origin', 'eggClaimed'])

/** A one-entry save; `extra` mixes entry and save fields. */
function make(entry: Partial<Entry>, extra: Record<string, unknown> = {}): Save {
  const base = newSave()
  const saveExtra: Record<string, unknown> = {}
  const entryExtra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(extra)) (ENTRY_KEYS.has(k) ? entryExtra : saveExtra)[k] = v
  return { ...base, ...saveExtra, box: [{ ...base.box[0]!, ...entry, ...entryExtra }] }
}

function mon(id: number, xp: number, extra: Record<string, unknown> = {}): Save {
  return make({ phase: 'mon', speciesId: id, xp }, extra)
}

function hatchedEntry(id: string, speciesId: number, xp: number): Entry {
  return { ...newEntry(id, 'starter'), phase: 'mon', speciesId, xp }
}

describe('band', () => {
  test('desktop draws the sprite, name, level and an Evolve button', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000, { pending: 321 }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'tab-levels' })
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
    await ui.press({ key: 'tab-levels' })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bulbasaur/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /321/ })).toBeDefined()
    expect(await ui.find({ key: 'evolve' })).toBeDefined()
    await ui.unmount()
  })

  test('a hatched mon shows its rarity banner on both surfaces', async ($, on) => {
    const seen = world(on)
    for (const [id, label] of [[1, 'Starter'], [133, 'Rare']] as const) {
      seen.store.set('save', mon(id, 5000))
      for (const surface of ['terminal', 'desktop'] as const) {
        await $.session.start({ cwd: '.', surface, isInteractive: true })
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
        const text = surface === 'terminal' ? new RegExp('^\\[' + label + '\\]$') : new RegExp('^ ' + label + ' $')
        expect(await ui.find({ type: 'Text', text })).toBeDefined()
        await ui.unmount()
      }
    }
  })

  test('an egg shows no rarity banner', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', make({ target: 133, chosen: true, eggStage: 0, xp: 100 }))
    for (const surface of ['terminal', 'desktop'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /Egg Lv/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Starter|Common|Uncommon|Rare|Legendary/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('an egg shows its crack stage and the egg sprite', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', make({ target: 1, chosen: true, eggStage: 1, xp: 900 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /Egg Lv 2 \(Bulbasaur\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\d\/3|crack|hatch at/i })).toBeUndefined()
    expect(seen.spriteReads.some(p => p.endsWith('egg.png'))).toBe(true)
    await ui.unmount()
  })

  test('the context line shows real counts on both surfaces', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      await ui.press({ key: 'tab-levels' })
      expect(await ui.find({ type: 'Text', text: /Context 62% · 124K \/ 200K/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the title row shows !hint, milestone progress, and the box size when it holds more than one', async ($, on) => {
    const seen = world(on)
    for (const surface of ['desktop', 'terminal'] as const) {
      seen.store.set('save', { ...mon(1, 5000, { milestone: 24 }), box: [hatchedEntry('a1', 1, 5000), newEntry('a2', 'milestone', 4), newEntry('a3', 'milestone', 4)], activeId: 'a1' })
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      await ui.press({ key: 'tab-levels' })
      expect(await ui.find({ key: 'hint' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /New egg \(24\/25\) · Box 3/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a single entry shows no box count', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'tab-levels' })
    expect(await ui.find({ type: 'Text', text: /^New egg \(0\/25\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Box \d/ })).toBeUndefined()
    await ui.unmount()
  })

  test('!hint opens the help with the configured decay line, Cancel closes it, on both surfaces', async ($, on) => {
    const seen = world(on, 20)
    for (const surface of ['desktop', 'terminal'] as const) {
      seen.store.set('save', mon(1, 5000))
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, maxRows: 40 } })
      expect(await ui.find({ key: 'hint-cancel' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /Evolve = compact/ })).toBeUndefined()
      await ui.press({ key: 'hint' })
      expect(await ui.find({ type: 'Text', text: /Evolve = compact \+ apply pending XP/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /decays 2%\/turn at 80%\+/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\/clawd-mon switch <name\|#>/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\/clawd-mon reset-all confirm/ })).toBeDefined()
      expect(await ui.find({ key: 'hint-cancel' })).toBeDefined()
      await ui.press({ key: 'hint-cancel' })
      expect(await ui.find({ key: 'hint-cancel' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /Evolve = compact/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('/clawd-mon hint opens the help', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: PLUGIN, args: 'hint', ...COMMAND })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ key: 'hint-cancel' })).toBeDefined()
    await ui.unmount()
  })

  test('on a short terminal the commands collapse to one row and Cancel stays', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    await ui.press({ key: 'hint' })
    expect(await ui.find({ key: 'hint-cancel' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Commands: show · hide · hint · dex · status · box/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/clawd-mon switch <name\|#>:/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the dex view opens from the command on both surfaces: header, legendary rows, Cancel; Mew unmentioned', async ($, on) => {
    const seen = world(on, 20)
    for (const surface of ['desktop', 'terminal'] as const) {
      seen.store.set('save', mon(1, 5000, { dex: [1, 2, 3] }))
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, maxRows: 40 } })
      expect(await ui.find({ key: 'dex-cancel' })).toBeUndefined()
      await $.command.run({ command: PLUGIN, args: 'dex', ...COMMAND })
      const row = (re: RegExp) => ui.find({ type: 'Text', text: re })
      expect(await row(/Dex 3\/\d+ · ★ 0\/4/)).toBeDefined()
      expect(await row(/^Starters 3\/\d+ · Common 0\/\d+ · Uncommon 0\/\d+ · Rare 0\/\d+$/)).toBeDefined()
      expect(await row(/\?\?\?/)).toBeDefined()
      expect(await row(/Frozen bird of legend/)).toBeDefined()
      expect(await row(/Stay cool: 14 days without reaching 80% context/)).toBeDefined()
      expect(await row(/Born in a lab from a legend’s DNA/)).toBeDefined()
      expect(await row(/Mew\b/)).toBeUndefined()
      expect(await ui.find({ key: 'dex-cancel' })).toBeDefined()
      await ui.press({ key: 'dex-cancel' })
      expect(await ui.find({ key: 'dex-cancel' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the dex and the help never open together: opening one closes the other', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'hint' })
    expect(await ui.find({ key: 'hint-cancel' })).toBeDefined()
    await ui.press({ key: 'dex' })
    expect(await ui.find({ key: 'dex-cancel' })).toBeDefined()
    expect(await ui.find({ key: 'hint-cancel' })).toBeUndefined()
    await ui.press({ key: 'hint' })
    expect(await ui.find({ key: 'hint-cancel' })).toBeDefined()
    expect(await ui.find({ key: 'dex-cancel' })).toBeUndefined()
    await $.command.run({ command: PLUGIN, args: 'dex', ...COMMAND })
    expect(await ui.find({ key: 'hint-cancel' })).toBeUndefined()
    expect(await ui.find({ key: 'dex-cancel' })).toBeDefined()
    await ui.unmount()
  })

  test('an earned legendary shows its name and star; desktop draws a sprite for every row', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(1, 5000, { legendsEarned: [145] }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: PLUGIN, args: 'dex', ...COMMAND })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND, props: { ...BAND.props, maxRows: 40 } })
    expect(await ui.find({ type: 'Text', text: /★ Zapdos/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Dex 0\/\d+ · ★ 1\/4/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(5)
    await ui.unmount()
  })

  test('on a short terminal the dex keeps its header and Cancel and drops rows', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: PLUGIN, args: 'dex', ...COMMAND })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Dex \d+\/\d+ · ★/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Starters \d+\/\d+ · Common \d+\/\d+ · Uncommon \d+\/\d+ · Rare \d+\/\d+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Frozen bird of legend/ })).toBeUndefined()
    expect(await ui.find({ key: 'dex-cancel' })).toBeDefined()
    await ui.unmount()
    const big = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND, props: { ...BAND.props, maxRows: 40 } })
    expect(await big.find({ type: 'Text', text: /Frozen bird of legend/ })).toBeDefined()
    await big.unmount()
  })

  test('a cool day streak that completes earns Articuno at turn.complete, with its toast', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(25, 0, { streaks: { coolDays: 13, coolDay: '1969-12-31', coolBroken: false, strike: 0 } }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    const saved = seen.store.get('save') as Save
    expect(saved.legendsEarned).toEqual([144])
    expect(saved.box.some(e => e.origin === 'legendary' && e.target === 144)).toBe(true)
    expect(seen.toasts).toContain('A legendary egg arrived ★ — /clawd-mon switch to hatch it')
  })

  test('a turn at the danger percent breaks the cool streak', async ($, on) => {
    const seen = world(on, 85)
    seen.store.set('save', mon(25, 0, { streaks: { coolDays: 13, coolDay: '1969-12-31', coolBroken: false, strike: 0 } }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    const saved = seen.store.get('save') as Save
    expect(saved.streaks.coolDays).toBe(0)
    expect(saved.legendsEarned).toEqual([])
  })

  test('the 30th strike compact earns Zapdos; an auto-compact resets it', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { streaks: { coolDays: 0, coolDay: null, coolBroken: false, strike: 29 } }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    let saved = seen.store.get('save') as Save
    expect(saved.legendsEarned).toEqual([145])
    expect(seen.toasts).toContain('A legendary egg arrived ★ — /clawd-mon switch to hatch it')
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    saved = seen.store.get('save') as Save
    expect(saved.streaks.strike).toBe(0)
  })

  test('a legendary egg shows a star in the band title', async ($, on) => {
    const seen = world(on, 20)
    const base = make({}, {})
    seen.store.set('save', { ...base, box: [{ ...base.box[0]!, origin: 'legendary', target: 144 }] })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Egg Lv 1 ★$/ })).toBeDefined()
    await ui.unmount()
  })

  test('the stats line shows agents and tools, seeded from the transcript, on both surfaces', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      await ui.press({ key: 'tab-levels' })
      const line = /Context 62% · 124K \/ 200K · Agents 1 running · 2 spawned · Tools 3 avail \(1 MCP\) · 2 used · 3 calls/
      expect(await ui.find({ type: 'Text', text: line })).toBeDefined()
      await ui.unmount()
    }
  })

  test('tool calls bump the call count and the distinct tools used', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Grep', pattern: 'x' })
    await $.tool.call({ tool: 'Read', file_path: 'a' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'tab-levels' })
    expect(await ui.find({ type: 'Text', text: /3 used · 5 calls/ })).toBeDefined()
    await ui.unmount()
  })

  test('the transcript is seeded once, not again on the next session.start', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'tab-levels' })
    expect(await ui.find({ type: 'Text', text: /2 used · 3 calls/ })).toBeDefined()
    await ui.unmount()
  })

  test('agents and tools read n/a when the engine will not say', async ($, on) => {
    const seen = world(on, 62, { noLists: true })
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    await ui.press({ key: 'tab-levels' })
    expect(await ui.find({ type: 'Text', text: /Agents n\/a · Tools n\/a avail/ })).toBeDefined()
    await ui.unmount()
  })

  test('a random egg stays a surprise: no species name, and the species is stored', async ($, on) => {
    const seen = world(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const stored = seen.store.get('save') as Save
    expect(A(stored).target).not.toBeNull()
    expect(A(stored).chosen).toBe(false)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Egg Lv 1$/ })).toBeDefined()
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
      expect(A(saved).xp).toBe(1000)
      expect(A(saved).compacts).toBe(1) // 62% context qualifies
      expect(saved.lifetime.compacts).toBe(1) // applied once, not twice
      expect(seen.toasts.filter(x => /Level up/.test(x)).length).toBeLessThanOrEqual(1)
      await ui.unmount()
    }
  })

  test('one Evolve press moves an egg at most one stage and applies once', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', make({ target: 4 }, { pending: 5000 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    await ui.press({ key: 'evolve' })
    const saved = seen.store.get('save') as Save
    expect(seen.compacts).toBe(1)
    expect(A(saved).eggStage).toBe(1)
    expect(saved.lifetime.compacts).toBe(1)
    expect(A(saved).compacts).toBe(1)
    expect(seen.toasts.filter(x => x === 'The egg is cracking')).toHaveLength(1)
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

  test('headless: Evolve falls back to a queued /compact and applies the bank once', async ($, on) => {
    const seen = world(on, 62, { headless: true })
    seen.store.set('save', mon(25, 0, { pending: 1000, compacts: 0 }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'evolve' })
    expect(seen.queuedCompacts).toBe(1)
    expect(seen.compacts).toBe(0)
    expect(seen.toasts.some(t => /could not compact/.test(t))).toBe(false)
    expect((seen.store.get('save') as Save).pending).toBe(1000) // nothing applied until it runs
    // The engine runs the queued /compact once idle: the session.compact hook applies the bank.
    seen.runQueued = true
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    expect(seen.compacts).toBe(1)
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBe(0)
    expect(A(saved).xp).toBe(1000)
    expect(saved.lifetime.compacts).toBe(1) // applied once, not twice
    await ui.unmount()
  })

  test('a refused compact says why and keeps the bank', async ($, on) => {
    const seen = world(on, 62, { compactRejects: 'a turn is running' })
    seen.store.set('save', mon(25, 0, { pending: 1000 }))
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    await ui.press({ key: 'evolve' })
    // The engine skips a throwing hook, so the rejection the plugin sees is whatever the chain ends in;
    // what matters is that its reason reaches the toast instead of being swallowed.
    expect(seen.toasts.some(t => /^Clawd-mon: could not compact right now \(.+\)\.$/.test(t))).toBe(true)
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
    expect(A(saved).xp).toBe(0)
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
    expect(A(saved).xp).toBe(400)
  })

  test('a plugin-trigger compact through the hook applies once', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 400 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'plugin', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(A(saved).xp).toBe(400)
    expect(saved.lifetime.compacts).toBe(1)
  })

  test('an auto-compact applies half of the pending XP', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 400 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(saved.pending).toBe(0)
    expect(A(saved).xp).toBe(200)
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
    expect(A(seen.store.get('save') as Save).speciesId).toBe(3)
    const done = await $.command.run({ command: PLUGIN, args: 'reset-all confirm', ...COMMAND })
    expect(done.text).toMatch(/fresh/i)
    const after = seen.store.get('save') as Save | undefined
    expect(after === undefined || A(after).phase === 'egg').toBe(true)
    expect(seen.store.get('isHidden')).toBeUndefined()
  })

  test('release removes an entry and keeps the totals in the store', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', {
      ...make({}, {}),
      lifetime: { tokens: 9, xp: 9, compacts: 9, hatches: 1, evolutions: 2 },
      box: [hatchedEntry('a1', 3, 99_999), hatchedEntry('a2', 25, 5000)],
    })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ask = await $.command.run({ command: PLUGIN, args: 'release 1', ...COMMAND })
    expect(ask.text).toMatch(/confirm/)
    expect((seen.store.get('save') as Save).box).toHaveLength(2)
    await $.command.run({ command: PLUGIN, args: 'release 1 confirm', ...COMMAND })
    const saved = seen.store.get('save') as Save
    expect(saved.box.map(e => e.id)).toEqual(['a2'])
    expect(saved.activeId).toBe('a2')
    expect(saved.lifetime.evolutions).toBe(2)
  })

  test('switch changes who gains xp on the next compact', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', { ...make({}, { pending: 400 }), box: [hatchedEntry('a1', 25, 0), hatchedEntry('a2', 4, 0)] })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: PLUGIN, args: 'switch charmander', ...COMMAND })
    expect(r.text).toMatch(/Active: Charmander/)
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(saved.box[0]!.xp).toBe(0)
    expect(saved.box[1]!.xp).toBeGreaterThan(0)
  })

  test('box command lists the entries', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', { ...make({}, {}), box: [hatchedEntry('a1', 25, 5000), { ...newEntry('a2', 'milestone', 4) }] })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: PLUGIN, args: 'box', ...COMMAND })
    expect(r.text).toMatch(/Box \(2\)/)
    expect(r.text).toMatch(/1\. \* Pikachu Lv \d+/)
    expect(r.text).toMatch(/2\.   Egg Lv 1/)
  })

  test('a milestone compact toasts the new egg and adds it to the box', async ($, on) => {
    const seen = world(on, 70)
    seen.store.set('save', mon(25, 0, { pending: 10, milestone: 24 }))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    const saved = seen.store.get('save') as Save
    expect(saved.box).toHaveLength(2)
    expect(saved.milestone).toBe(0)
    expect(saved.activeId).toBe(saved.box[0]!.id)
    expect(seen.toasts).toContain('A new egg arrived — /clawd-mon switch to hatch it')
  })

  test('first run with an empty store starts an egg', async ($, on) => {
    const seen = world(on)
    await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /Egg Lv 1/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('actions tab', () => {
  const STATS = /Context 62% · 124K \/ 200K · Agents/
  const ACTION_ROWS = /^(Current action|Agent \d+) - /

  const agentRows = async (ui: { findAll: (q: object) => Promise<unknown[]> }) => (await ui.findAll({ type: 'Text', text: ACTION_ROWS })).length

  test('Actions is the default on both surfaces: Current action - Idle and the context percent', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ key: 'tab-actions' })).toBeDefined()
      expect(await ui.find({ key: 'tab-levels' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^62%$/ })).toBeDefined()
      // None of the Levels content is drawn.
      expect(await ui.find({ type: 'Text', text: STATS })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Pending \+/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^New egg \(/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the title row still has the title, rarity, !hint and dex on the Actions tab', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /Bulbasaur Lv \d+/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Starter/ })).toBeDefined()
      expect(await ui.find({ key: 'hint' })).toBeDefined()
      expect(await ui.find({ key: 'dex' })).toBeDefined()
      expect(await ui.find({ key: 'evolve' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('pressing Levels shows the Levels rows, pressing Actions goes back, on both surfaces', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000, { pending: 321 }))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      await ui.press({ key: 'tab-levels' })
      expect(await ui.find({ type: 'Text', text: STATS })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /321/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^New egg \(0\/25\)$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Current action - / })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^62%$/ })).toBeUndefined()
      await ui.press({ key: 'tab-actions' })
      expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: STATS })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^62%$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the Advice row shows on both tabs when Evolve is recommended', async ($, on) => {
    const seen = world(on, 62)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /Evolve recommended/ })).toBeDefined()
      await ui.press({ key: 'tab-levels' })
      expect(await ui.find({ type: 'Text', text: /Evolve recommended/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the context percent follows the thresholds in colour on the Actions tab', async ($, on) => {
    const seen = world(on, 20)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^20%$/ })).toBeDefined()
    await ui.unmount()
    await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] })
    const hot = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await hot.find({ type: 'Text', text: /^85%$/ })).toBeDefined()
    await hot.unmount()
  })

  test('terminal: the Actions band never has more rows than the Levels band, even with many agents', async ($, on) => {
    const seen = world(on, 62)
    seen.agents = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, description: `job ${id}`, type: 'Explore', status: 'running' as const }))
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    const actions = await agentRows(ui)
    expect(actions).toBe(3)
    expect(await ui.find({ type: 'Text', text: /\(\+4 more\)$/ })).toBeDefined()
    await ui.press({ key: 'tab-levels' })
    const levels = (await ui.findAll({ type: 'Text', text: /^[█░]{20} |^Pending \+/ })).length
    expect(levels).toBe(3)
    expect(actions).toBeLessThanOrEqual(levels)
    await ui.unmount()
  })

  test('agents from $.agent.list show as rows; finished ones do not', async ($, on) => {
    const seen = world(on)
    seen.agents = [
      { id: 'a1', name: 'scout', description: 'scan', type: 'Explore', status: 'running' },
      { id: 'a2', description: 'plan', type: 'Plan', status: 'completed' },
      { id: 'a3', description: 'review', type: 'Plan', status: 'idle' },
    ]
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /^Agent 1 - scout - scan$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Agent 2 - Waiting$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /plan/ })).toBeUndefined()
      expect(await agentRows(ui)).toBe(3)
      await ui.unmount()
    }
  })

  test('a tool call shows its label while in flight and clears after, on both surfaces', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      let release: () => void = () => undefined
      seen.toolGate = new Promise<void>(r => (release = r))
      const call = $.tool.call({ tool: 'Grep', pattern: 'x', tool_use_id: 'tu-grep' })
      await new Promise(r => setTimeout(r, 20))
      const busy = await $.ui.mount({ plugin: PLUGIN, surface, ...WORKING })
      expect(await busy.find({ type: 'Text', text: /^Current action - Gathering context$/ })).toBeDefined()
      await busy.unmount()
      release()
      await call
      const after = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await after.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
      expect(await after.find({ type: 'Text', text: /Gathering context/ })).toBeUndefined()
      await after.unmount()
      seen.toolGate = undefined
    }
  })

  test('a failing tool call still clears the label', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    seen.toolResult = () => {
      throw new Error('tool exploded')
    }
    await $.tool.call({ tool: 'Bash', command: 'x', tool_use_id: 'tu-bash' }).catch(() => undefined)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a Skill call names the skill', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    let release: () => void = () => undefined
    seen.toolGate = new Promise<void>(r => (release = r))
    const call = $.tool.call({ tool: 'Skill', skill: 'pdf', tool_use_id: 'tu-skill' })
    await new Promise(r => setTimeout(r, 20))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...WORKING })
    expect(await ui.find({ type: 'Text', text: /^Current action - Using pdf skill$/ })).toBeDefined()
    await ui.unmount()
    release()
    await call
  })

  test('a TodoWrite in_progress item shows as the Current action; none left goes back to Idle', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    for (const surface of ['desktop', 'terminal'] as const) {
      await $.session.start({ cwd: '.', surface, isInteractive: true })
      await $.tool.call({
        tool: 'TodoWrite',
        tool_use_id: 'tu-todo',
        todos: [
          { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
          { content: 'Ship it', activeForm: 'Shipping it', status: 'pending' },
        ],
      })
      let ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /^Current action - Writing tests$/ })).toBeDefined()
      await ui.unmount()
      await $.tool.call({
        tool: 'TodoWrite',
        tool_use_id: 'tu-todo2',
        todos: [{ content: 'Write tests', activeForm: 'Writing tests', status: 'completed' }],
      })
      ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a TodoWrite item with no activeForm uses its content', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'tu', todos: [{ content: 'Fix the bug', status: 'in_progress' }] })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Current action - Fix the bug$/ })).toBeDefined()
    await ui.unmount()
  })

  test('TaskCreate then TaskUpdate in_progress names the task; completing it clears it', async ($, on) => {
    const seen = world(on)
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    seen.toolResult = e => (e.tool === 'TaskCreate' ? { result: { task: { id: '7' } } } : { result: { text: 'ok' } })
    await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'tc', subject: 'Port the parser', activeForm: 'Porting the parser' })
    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined() // pending, not started
    await ui.unmount()
    await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'tu', taskId: '7', status: 'in_progress' })
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Current action - Porting the parser$/ })).toBeDefined()
    await ui.unmount()
    await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'tu2', taskId: '7', status: 'completed' })
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent tool call is not mistaken for the main loop, and its TodoWrite sets no task', async ($, on) => {
    const seen = world(on)
    seen.agents = [{ id: 'a1', description: 'scan', type: 'Explore', status: 'running' }]
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    let release: () => void = () => undefined
    seen.toolGate = new Promise<void>(r => (release = r))
    const call = $.tool.call({ tool: 'Edit', tool_use_id: 'tu-sub', agentId: 'a1' })
    await new Promise(r => setTimeout(r, 20))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...WORKING })
    expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Agent 1 - Editing files · scan$/ })).toBeDefined()
    await ui.unmount()
    release()
    await call
    seen.toolGate = undefined
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'tu-sub2', agentId: 'a1', todos: [{ content: 'x', activeForm: 'Sub work', status: 'in_progress' }] })
    const after = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await after.find({ type: 'Text', text: /Sub work/ })).toBeUndefined()
    await after.unmount()
  })

  test('the Actions tab stays quiet when the engine will not list agents', async ($, on) => {
    const seen = world(on, 62, { noLists: true })
    seen.store.set('save', mon(1, 5000))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Current action - Idle$/ })).toBeDefined()
    expect(await agentRows(ui)).toBe(1)
    await ui.unmount()
  })
})
