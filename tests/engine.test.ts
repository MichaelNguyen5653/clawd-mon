import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_CONFIG,
  activeEntry,
  crackLevels,
  eggLevel,
  eggXpAt,
  ensureTarget,
  hatchLevel,
  applyCompact,
  bankTokens,
  bst,
  configFrom,
  decayPending,
  dragFactor,
  execute,
  levelOf,
  newSave,
  nextEvolution,
  observeContext,
  progress,
  projectDays,
  recommendation,
  sanitizeSave,
  tokensToXp,
  dexView,
  newEntry,
  observeTurn,
  type Entry,
  type GameEvent,
  type Save,
} from '../hooks/engine'
import { DEX } from './fixtures'

const A = activeEntry

const CFG = DEFAULT_CONFIG
const DAY = '2026-10-06'

const ENTRY_KEYS = new Set(['phase', 'target', 'speciesId', 'chosen', 'xp', 'eggStage', 'compacts', 'branch', 'origin', 'eggClaimed'])

/** A one-entry save: `entry` overrides the starter egg, `extra` mixes entry and save fields. */
function make(entry: Partial<Entry>, extra: Record<string, unknown> = {}): Save {
  const base = newSave()
  const saveExtra: Record<string, unknown> = {}
  const entryExtra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(extra)) (ENTRY_KEYS.has(k) ? entryExtra : saveExtra)[k] = v
  return { ...base, ...saveExtra, box: [{ ...base.box[0]!, ...entry, ...entryExtra }] }
}

/** A hatched companion of `id` with the given effective XP and qualifying compacts. */
function mon(id: number, xp: number, compacts = 0, extra: Record<string, unknown> = {}): Save {
  return make({ phase: 'mon', speciesId: id, xp, compacts }, extra)
}

/** A hatched box entry at `level`. */
function hatched(id: number, level: number, over: Partial<Entry> = {}): Entry {
  const rate = DEX.species.find(s => s.id === id)!.growthRate
  return { ...newEntry('a1', 'starter'), phase: 'mon', speciesId: id, xp: DEX.growth[rate][level]!, ...over }
}

function eggEntry(over: Partial<Entry> = {}): Entry {
  return { ...newEntry('a1', 'starter'), ...over }
}

function withBox(box: Entry[], activeId: string, extra: Partial<Save> = {}): Save {
  return { ...newSave(), box, activeId, ...extra }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6
const species = (id: number) => DEX.species.find(s => s.id === id)!

describe('xp and levels', () => {
  test('tokens convert at xpRate per 1,000 tokens', async () => {
    expect(tokensToXp(1000, 1)).toBe(1)
    expect(tokensToXp(250_000, 2)).toBe(500)
    expect(tokensToXp(0, 1)).toBe(0)
    expect(tokensToXp(-5, 1)).toBe(0)
    expect(tokensToXp(Number.NaN, 1)).toBe(0)
  })

  test('base stat total and drag factor', async () => {
    expect(bst(species(1))).toBe(318)
    expect(bst(species(3))).toBe(525)
    // BST 320 is neutral; heavy species are slowed, light ones sped, within 0.6..1.1.
    expect(dragFactor(species(25))).toBe(1)
    expect(dragFactor(species(3))).toBeLessThan(0.9)
    expect(dragFactor(species(3))).toBeGreaterThan(0.6)
    const tiny = { hp: 1, attack: 1, defense: 1, spAttack: 1, spDefense: 1, speed: 1 }
    const huge = { hp: 255, attack: 255, defense: 255, spAttack: 255, spDefense: 255, speed: 255 }
    expect(dragFactor({ ...species(1), stats: tiny })).toBe(1.1)
    expect(dragFactor({ ...species(1), stats: huge })).toBe(0.6)
  })

  test('level comes from the growth table: index is the level', async () => {
    const g = DEX.growth
    expect(levelOf(0, 'medium', g)).toBe(1)
    expect(levelOf(g.medium[5]!, 'medium', g)).toBe(5)
    expect(levelOf(g.medium[5]! - 1, 'medium', g)).toBe(4)
    expect(levelOf(g.medium[100]!, 'medium', g)).toBe(100)
    expect(levelOf(g.medium[100]! * 5, 'medium', g)).toBe(100)
    expect(levelOf(-10, 'medium', g)).toBe(1)
  })

  test('progress reports level, bar fraction and pending for a hatched mon', async () => {
    const g = DEX.growth['medium-slow']
    const p = progress(mon(1, (g[10]! + g[11]!) / 2, 0, { pending: 77 }), DEX)
    expect(p.kind).toBe('mon')
    if (p.kind !== 'mon') return
    expect(p.level).toBe(10)
    expect(p.fraction).toBeGreaterThan(0.45)
    expect(p.fraction).toBeLessThan(0.55)
    expect(p.pending).toBe(77)
    expect(p.name).toBe('Bulbasaur')
  })
})

describe('pending bank and decay', () => {
  test('tokens go to pending, never to applied xp', async () => {
    const s = bankTokens(mon(1, 100), 500_000, DAY, CFG)
    expect(s.pending).toBe(500)
    expect(A(s).xp).toBe(100)
    expect(s.lifetime.tokens).toBe(500_000)
    expect(s.daily[DAY]).toBe(500)
  })

  test('xpRate scales the bank', async () => {
    const s = bankTokens(newSave(), 1_000_000, DAY, { ...CFG, xpRate: 3 })
    expect(s.pending).toBe(3000)
  })

  test('negative, zero and non-finite tokens bank nothing', async () => {
    for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bankTokens(newSave(), n, DAY, CFG).pending).toBe(0)
    }
  })

  test('pending decays 2% per turn at or above the danger percent only', async () => {
    const s = { ...newSave(), pending: 1000 }
    expect(decayPending(s, 79, CFG).pending).toBe(1000)
    expect(close(decayPending(s, 80, CFG).pending, 980)).toBe(true)
    expect(close(decayPending(decayPending(s, 95, CFG), 95, CFG).pending, 960.4)).toBe(true)
    expect(decayPending(s, undefined, CFG).pending).toBe(1000)
  })

  test('danger percent is configurable', async () => {
    const s = { ...newSave(), pending: 100 }
    expect(close(decayPending(s, 70, { ...CFG, dangerPercent: 70 }).pending, 98)).toBe(true)
  })

  test('daily history keeps the last 14 days', async () => {
    let s = newSave()
    for (let d = 1; d <= 20; d++) s = bankTokens(s, 1000, `2026-09-${String(d).padStart(2, '0')}`, CFG)
    expect(Object.keys(s.daily)).toHaveLength(14)
    expect(s.daily['2026-09-01']).toBeUndefined()
    expect(s.daily['2026-09-20']).toBe(1)
  })
})

describe('recommendation', () => {
  const base = { window: 200_000 }

  test('recommends at or above recommendPercent', async () => {
    expect(recommendation({ ...base, percent: 59 }, newSave(), CFG).recommend).toBe(false)
    expect(recommendation({ ...base, percent: 60 }, newSave(), CFG)).toEqual({ recommend: true, reason: 'high' })
  })

  test('recommends when growth projects past danger within 3 turns', async () => {
    // 50% now, +8% of the window per turn: 50 + 24 = 74, not enough.
    let s = newSave()
    for (const t of [100_000, 116_000, 132_000, 148_000]) s = observeContext(s, t)
    expect(recommendation({ ...base, percent: 50, tokens: 100_000 }, s, CFG).recommend).toBe(false)
    // 56% now at +12%/turn: 56 + 36 = 92 >= 80.
    let g = newSave()
    for (const t of [88_000, 112_000, 136_000]) g = observeContext(g, t)
    expect(recommendation({ ...base, percent: 56, tokens: 112_000 }, g, CFG)).toEqual({
      recommend: true,
      reason: 'projected',
    })
  })

  test('needs at least two growth samples to project', async () => {
    const s = observeContext(observeContext(newSave(), 100_000), 130_000)
    expect(s.growth).toHaveLength(1)
    expect(recommendation({ ...base, percent: 59, tokens: 130_000 }, s, CFG).recommend).toBe(false)
  })

  test('unknown percent never recommends', async () => {
    expect(recommendation({ ...base }, newSave(), CFG).recommend).toBe(false)
  })

  test('observeContext keeps only positive deltas, the last five, and ignores unknown readings', async () => {
    let s = newSave()
    for (const t of [10, 20, 15, 25, 35, 45, 55, 65, 75]) s = observeContext(s, t)
    expect(s.growth.length).toBe(5)
    expect(s.growth.every(n => n > 0)).toBe(true)
    expect(observeContext(s, undefined).growth).toEqual(s.growth)
  })

  test('thresholds follow config', async () => {
    expect(recommendation({ ...base, percent: 45 }, newSave(), { ...CFG, recommendPercent: 45 }).recommend).toBe(true)
  })
})

describe('compact triggers', () => {
  test('manual and plugin compacts apply 100% of pending', async () => {
    for (const trigger of ['manual', 'plugin'] as const) {
      const r = applyCompact(mon(25, 0, 0, { pending: 1000 }), DEX, { trigger, percent: 70 }, CFG)
      expect(r.save.pending).toBe(0)
      expect(A(r.save).xp).toBe(1000) // Pikachu drag is 1
      expect(r.save.lifetime.xp).toBe(1000)
    }
  })

  test('auto compact applies 50% and forfeits the rest', async () => {
    const r = applyCompact(mon(25, 0, 0, { pending: 1000 }), DEX, { trigger: 'auto', percent: 90 }, CFG)
    expect(A(r.save).xp).toBe(500)
    expect(r.save.pending).toBe(0)
  })

  test('precompute applies nothing', async () => {
    const s = mon(25, 0, 0, { pending: 1000 })
    const r = applyCompact(s, DEX, { trigger: 'precompute', percent: 90 }, CFG)
    expect(r.save).toEqual(s)
    expect(r.events).toEqual([])
  })

  test('BST drag lowers applied xp for heavier species', async () => {
    const light = applyCompact(mon(25, 0, 0, { pending: 1000 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    const heavy = applyCompact(mon(3, 0, 0, { pending: 1000 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(A(heavy.save).xp).toBeLessThan(A(light.save).xp)
    expect(close(A(heavy.save).xp, 1000 * dragFactor(species(3)))).toBe(true)
  })

  test('qualifying gate: counts only at context >= 40%', async () => {
    const at = (percent: number | undefined) =>
      applyCompact(mon(25, 0, 0, { pending: 10 }), DEX, { trigger: 'manual', percent }, CFG).save
    expect(A(at(39)).compacts).toBe(0)
    expect(A(at(40)).compacts).toBe(1)
    expect(A(at(100)).compacts).toBe(1)
    expect(A(at(undefined)).compacts).toBe(0)
    expect(A(at(39)).xp).toBe(10) // xp still applies when the compact does not qualify
    expect(at(40).lifetime.compacts).toBe(1)
    expect(at(39).lifetime.compacts).toBe(0)
  })

  test('level-up emits an event', async () => {
    const g = DEX.growth.medium
    const r = applyCompact(mon(25, 0, 0, { pending: g[12]! }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(r.events).toContainEqual({ kind: 'levelup', level: 12 })
  })
})

describe('egg', () => {
  // Bulbasaur: BST 318 -> hatch level 5, cracks at Lv 2 and Lv 4, 3,000 XP to hatch.
  const egg = (xp: number, eggStage: 0 | 1 | 2 = 0, extra: Record<string, unknown> = {}): Save =>
    make({ target: 1, xp, eggStage }, extra)
  const qual = { trigger: 'manual' as const, percent: 60 }

  test('hatch level is round(BST/60) clamped to 4..10', async () => {
    const caterpie = { hp: 45, attack: 30, defense: 35, spAttack: 20, spDefense: 20, speed: 45 } // BST 195
    expect(hatchLevel({ ...species(1), stats: caterpie })).toBe(4)
    expect(hatchLevel(species(1))).toBe(5)
    expect(hatchLevel(species(150))).toBe(10) // Mewtwo, BST 680
    expect(hatchLevel(species(122))).toBe(8)
    expect(hatchLevel({ ...species(1), stats: { hp: 1, attack: 1, defense: 1, spAttack: 1, spDefense: 1, speed: 1 } })).toBe(4)
  })

  test('crack levels: 40% and 70% of the hatch level, strictly rising, first at least 2', async () => {
    expect(crackLevels(4)).toEqual([2, 3, 4])
    expect(crackLevels(5)).toEqual([2, 4, 5])
    expect(crackLevels(10)).toEqual([4, 7, 10])
    for (let h = 4; h <= 10; h++) {
      const [c1, c2, hatch] = crackLevels(h)
      expect(c1).toBeGreaterThanOrEqual(2)
      expect(c2).toBeGreaterThan(c1)
      expect(hatch).toBeGreaterThan(c2)
      expect(hatch).toBe(h)
    }
  })

  test('egg xp to hatch is 600 x H, and egg levels follow a 1.5 power curve', async () => {
    expect(eggXpAt(1, 5)).toBe(0)
    expect(eggXpAt(5, 5)).toBe(3000)
    expect(eggXpAt(10, 10)).toBe(6000)
    expect(close(eggXpAt(2, 5), 375)).toBe(true)
    expect(eggLevel(0, 5)).toBe(1)
    expect(eggLevel(374, 5)).toBe(1)
    expect(eggLevel(376, 5)).toBe(2)
    expect(eggLevel(2999, 5)).toBe(4)
    expect(eggLevel(3000, 5)).toBe(5)
    expect(eggLevel(99_999, 5)).toBe(5)
  })

  test('first crack needs the crack level AND a qualifying compact', async () => {
    const low = applyCompact(egg(0, 0, { pending: 370 }), DEX, qual, CFG)
    expect(A(low.save).eggStage).toBe(0)
    const noQual = applyCompact(egg(0, 0, { pending: 400 }), DEX, { trigger: 'manual', percent: 30 }, CFG)
    expect(A(noQual.save).eggStage).toBe(0)
    expect(A(noQual.save).xp).toBe(400)
    const ok = applyCompact(egg(0, 0, { pending: 400 }), DEX, { trigger: 'manual', percent: 40 }, CFG)
    expect(A(ok.save).eggStage).toBe(1)
    expect(ok.events).toContainEqual({ kind: 'crack', stage: 1 })
  })

  test('stages are one per compact, each on its own qualifying compact', async () => {
    let r = applyCompact(egg(0, 0, { pending: 3000 }), DEX, qual, CFG)
    expect(A(r.save).eggStage).toBe(1)
    r = applyCompact(r.save, DEX, qual, CFG)
    expect(A(r.save).eggStage).toBe(2)
    expect(r.events).toContainEqual({ kind: 'crack', stage: 2 })
    r = applyCompact(r.save, DEX, qual, CFG)
    expect(A(r.save).phase).toBe('mon')
    expect(r.events.some(e => e.kind === 'hatch')).toBe(true)
  })

  test('one compact never advances more than one egg stage, however much xp', async () => {
    const r = applyCompact(egg(99_999, 0, { pending: 99_999 }), DEX, { trigger: 'manual', percent: 90 }, CFG)
    expect(A(r.save).eggStage).toBe(1)
    expect(r.events.filter(x => x.kind === 'crack' || x.kind === 'hatch')).toHaveLength(1)
  })

  test('a late non-qualifying compact does not crack even if xp is there', async () => {
    const r = applyCompact(egg(1900, 1, { pending: 0 }), DEX, { trigger: 'manual', percent: 10 }, CFG)
    expect(A(r.save).eggStage).toBe(1)
  })

  test('a bigger species needs more xp: Mewtwo cracks at Lv 4', async () => {
    const mewtwo = egg(0, 0, { target: 150, pending: 1000 })
    expect(A(applyCompact(mewtwo, DEX, qual, CFG).save).eggStage).toBe(0) // still egg Lv 3
    expect(A(applyCompact({ ...mewtwo, pending: 4000 }, DEX, qual, CFG).save).eggStage).toBe(1)
  })

  test('hatch: the stored species at its hatch level, fresh compact count', async () => {
    const r = applyCompact(egg(3000, 2, { target: 25, chosen: true, compacts: 2 }), DEX, qual, CFG)
    expect(A(r.save).phase).toBe('mon')
    expect(A(r.save).speciesId).toBe(25)
    expect(levelOf(A(r.save).xp, 'medium', DEX.growth)).toBe(5) // Pikachu BST 320
    expect(A(r.save).compacts).toBe(0)
    expect(A(r.save).eggStage).toBe(0)
    expect(A(r.save).chosen).toBe(false)
    expect(r.save.lifetime.hatches).toBe(1)
    expect(r.events).toContainEqual({ kind: 'hatch', speciesId: 25 })
  })

  test('Mewtwo hatches at Lv 10', async () => {
    const r = applyCompact(egg(6000, 2, { target: 150 }), DEX, qual, CFG)
    expect(levelOf(A(r.save).xp, 'slow', DEX.growth)).toBe(10)
  })

  test('with no stored species the hatch is a random first-stage non-legendary one', async () => {
    const seen = new Set<number>()
    for (const roll of [0, 0.2, 0.5, 0.99]) {
      const r = applyCompact(egg(3000, 2, { target: null }), DEX, qual, CFG, () => roll)
      const s = species(A(r.save).speciesId!)
      expect(s.stage).toBe(0)
      expect(s.legendary).toBe(false)
      seen.add(s.id)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  test('ensureTarget rolls a hidden first-stage non-legendary species once and keeps it', async () => {
    const rolled = ensureTarget(newSave(), DEX, () => 0.5)
    expect(A(rolled).target).not.toBeNull()
    expect(A(rolled).chosen).toBe(false)
    const s = species(A(rolled).target!)
    expect(s.stage).toBe(0)
    expect(s.legendary).toBe(false)
    expect(A(ensureTarget(rolled, DEX, () => 0)).target).toBe(A(rolled).target)
    const hatched = mon(25, 0)
    expect(ensureTarget(hatched, DEX, () => 0)).toEqual(hatched)
  })

  test('the hidden target survives a save and reload', async () => {
    const rolled = ensureTarget(newSave(), DEX, () => 0.3)
    const again = sanitizeSave(JSON.parse(JSON.stringify(rolled)), DEX)
    expect(A(again).target).toBe(A(rolled).target)
    expect(A(again).chosen).toBe(false)
    expect(A(sanitizeSave({ ...rolled, box: [{ ...A(rolled), target: 99_999 }] }, DEX)).target).toBeNull()
  })

  test('progress of an egg: level, next stage level, into/need, name only when chosen', async () => {
    const hidden = progress(egg(1000, 1), DEX)
    expect(hidden.kind).toBe('egg')
    if (hidden.kind !== 'egg') return
    expect(hidden.level).toBe(2) // Lv 2 from 375 XP, Lv 3 from 1,061
    expect(hidden.targetName).toBeNull()
    const chosen = progress(egg(1000, 1, { chosen: true }), DEX)
    if (chosen.kind !== 'egg') return
    expect(chosen.targetName).toBe('Bulbasaur')
    expect(JSON.stringify(chosen)).not.toMatch(/nextLevel|nextKind|hatchLevel/) // no hints
    expect(chosen.need).toBeGreaterThan(0)
    expect(chosen.into).toBeGreaterThanOrEqual(0)
  })
})

describe('evolution', () => {
  const med = DEX.growth['medium-slow']

  test('needs level AND compacts: 3 for the first evolution', async () => {
    const enough = med[16]! + 1
    const noCompacts = applyCompact(mon(1, enough, 2, { pending: 0 }), DEX, { trigger: 'manual', percent: 20 }, CFG)
    expect(A(noCompacts.save).speciesId).toBe(1) // 2 compacts + a non-qualifying one
    const noLevel = applyCompact(mon(1, med[15]!, 3, { pending: 0 }), DEX, { trigger: 'manual', percent: 20 }, CFG)
    expect(A(noLevel.save).speciesId).toBe(1)
    const both = applyCompact(mon(1, enough, 2, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(A(both.save).speciesId).toBe(2)
    expect(both.events).toContainEqual({ kind: 'evolve', from: 1, to: 2 })
    expect(both.save.lifetime.evolutions).toBe(1)
  })

  test('second evolution needs 8 compacts', async () => {
    const xp = med[32]! + 100
    const seven = applyCompact(mon(2, xp, 6, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(A(seven.save).speciesId).toBe(2)
    const eight = applyCompact(mon(2, xp, 7, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(A(eight.save).speciesId).toBe(3)
  })

  test('evolution keeps level (effective xp) and clears the branch pick', async () => {
    const xp = med[16]! + 50
    const r = applyCompact(mon(1, xp, 3, { pending: 0, branch: 2 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(A(r.save).xp).toBe(xp)
    expect(A(r.save).branch).toBeNull()
  })

  test('item trigger evolves at level 30, trade at level 36', async () => {
    const pika = nextEvolution(mon(25, 0, 3), DEX)!
    expect(pika.to.id).toBe(26)
    expect(pika.level).toBe(30)
    const kad = nextEvolution(mon(64, 0, 8), DEX)!
    expect(kad.to.id).toBe(65)
    expect(kad.level).toBe(36)
    expect(kad.compactsNeeded).toBe(8)
    const at29 = applyCompact(
      mon(25, DEX.growth.medium[29]!, 3, { pending: 0 }),
      DEX,
      { trigger: 'manual', percent: 50 },
      CFG,
    )
    expect(A(at29.save).speciesId).toBe(25)
    const at30 = applyCompact(
      mon(25, DEX.growth.medium[30]!, 3, { pending: 0 }),
      DEX,
      { trigger: 'manual', percent: 50 },
      CFG,
    )
    expect(A(at30.save).speciesId).toBe(26)
  })

  test('final stage has no next evolution', async () => {
    expect(nextEvolution(mon(3, 0, 99), DEX)).toBeNull()
    expect(nextEvolution(newSave(), DEX)).toBeNull()
  })

  test('multi-branch species default to the first, branch pick overrides', async () => {
    const xp = DEX.growth.medium[30]!
    const dflt = applyCompact(mon(133, xp, 3, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(A(dflt.save).speciesId).toBe(134)
    const pick = applyCompact(
      mon(133, xp, 3, { pending: 0, branch: 136 }),
      DEX,
      { trigger: 'manual', percent: 50 },
      CFG,
    )
    expect(A(pick.save).speciesId).toBe(136)
  })
})

describe('commands', () => {
  const ctx = { day: DAY, rng: () => 0 }
  const run = (s: Save, args: string) => execute(s, DEX, args, ctx)

  test('show, hide and bare command', async () => {
    expect(run(newSave(), '').show).toBe(true)
    expect(run(newSave(), 'show').show).toBe(true)
    expect(run(newSave(), 'hide').hide).toBe(true)
  })

  test('unknown subcommand prints usage and changes nothing', async () => {
    const s = newSave()
    const r = run(s, 'dance')
    expect(r.save).toEqual(s)
    expect(r.text).toMatch(/reset-all/)
  })

  test('choose sets the starter egg, normalising names, resolving to the first stage', async () => {
    expect(A(run(newSave(), 'choose Pikachu').save).target).toBe(25)
    expect(A(run(newSave(), 'choose  ivysaur ').save).target).toBe(1)
    expect(A(run(newSave(), 'choose mr. mime').save).target).toBe(122)
    expect(A(run(newSave(), 'choose Pikachu').save).chosen).toBe(true)
  })

  test('choose rejects unknown names and legendaries', async () => {
    const s = newSave()
    const r = run(s, 'choose missingno')
    expect(r.save).toEqual(s)
    expect(r.text).toMatch(/unknown|no such/i)
    expect(run(s, 'choose').text).toMatch(/usage|name/i)
    const mewtwo = run(s, 'choose mewtwo')
    expect(mewtwo.save).toEqual(s)
    expect(mewtwo.text).toMatch(/legendary/i)
  })

  test('choose is only for the starter egg, before anything has hatched', async () => {
    const hatched = mon(1, 5000, 2)
    const a = run(hatched, 'choose pikachu')
    expect(a.save).toEqual(hatched)
    expect(a.text).toMatch(/starter egg/i)
    const bonusEgg = make({ origin: 'milestone', target: 1 })
    expect(run(bonusEgg, 'choose pikachu').save).toEqual(bonusEgg)
    const afterHatch = make({ target: 1 }, { lifetime: { tokens: 0, xp: 0, compacts: 0, hatches: 1, evolutions: 0 } })
    expect(run(afterHatch, 'choose pikachu').save).toEqual(afterHatch)
    expect(run(afterHatch, 'choose pikachu').text).toMatch(/starter egg/i)
    // reset-all gives a fresh starter egg: choosing works again
    const fresh = run(afterHatch, 'reset-all confirm').save
    expect(A(run(fresh, 'choose pikachu').save).target).toBe(25)
  })

  test('branch must name an evolution of the active Pokémon', async () => {
    const eevee = mon(133, 0, 0)
    expect(A(run(eevee, 'branch jolteon').save).branch).toBe(135)
    const bad = run(eevee, 'branch venusaur')
    expect(A(bad.save).branch).toBeNull()
    expect(bad.text).toMatch(/not|no /i)
    expect(run(mon(1, 0), 'branch ivysaur').text).toMatch(/only|no choice|one/i)
    expect(run(newSave(), 'branch jolteon').text).toMatch(/egg|hatch/i)
  })

  test('hint opens the in-band help', async () => {
    expect(run(newSave(), 'hint').hint).toBe(true)
    expect(run(newSave(), 'status').hint).toBeUndefined()
  })

  test('reset is gone: it points at release and reset-all and changes nothing', async () => {
    const s = mon(3, 99999, 12, { pending: 50 })
    const r = run(s, 'reset')
    expect(r.save).toEqual(s)
    expect(r.text).toMatch(/release/)
    expect(r.text).toMatch(/reset-all confirm/)
  })

  test('reset-all needs confirm; with it the whole save is fresh, hidden egg re-rolled, store wiped', async () => {
    const s = mon(3, 99999, 12, { lifetime: { tokens: 1e7, xp: 9000, compacts: 20, hatches: 2, evolutions: 4 } })
    const ask = run(s, 'reset-all')
    expect(ask.save).toEqual(s)
    expect(ask.wipe).toBeUndefined()
    expect(ask.text).toMatch(/reset-all confirm/)
    const done = run(s, 'reset-all confirm')
    expect(done.save).toEqual(ensureTarget(newSave(), DEX, ctx.rng))
    expect(done.wipe).toBe(true)
    expect(done.save.lifetime.tokens).toBe(0)
    const roll = (n: number) => execute(s, DEX, 'reset-all confirm', { day: DAY, rng: () => n })
    expect(A(roll(0).save).target).not.toBe(A(roll(0.99).save).target)
    expect(species(A(roll(0.5).save).target!).stage).toBe(0)
    expect(A(roll(0.5).save).chosen).toBe(false)
    expect(A(roll(0.5).save).origin).toBe('starter')
  })

  test('status of an egg: level and totals, no stage hints, species hidden', async () => {
    const text = run(ensureTarget(newSave(), DEX, () => 0), 'status').text
    expect(text).toMatch(/Egg Lv 1/)
    expect(text).toMatch(/Box: 1/)
    expect(text).toMatch(/Next egg: 0\/25/)
    expect(text).not.toMatch(/crack|hatch at|next hatch/i)
    expect(text).not.toMatch(/Bulbasaur/)
    const withPace = { ...newSave(), daily: { [DAY]: 900 } }
    expect(run(withPace, 'status').text).not.toMatch(/days? to/)
  })

  test('status of a Pokémon: level, evolution line, projection, box and milestone', async () => {
    const s = mon(25, DEX.growth.medium[30]! - 10_000, 3, { daily: { [DAY]: 1000 }, milestone: 7 })
    const text = run(s, 'status').text
    expect(text).toMatch(/Active: Pikachu Lv 2\d/)
    expect(text).toMatch(/Next: Raichu at Lv 30/)
    expect(text).toMatch(/10 days/)
    expect(text).toMatch(/Next egg: 7\/25/)
  })

  test('box lists numbers, an active marker, names for Pokémon and Egg for eggs', async () => {
    const s = withBox([hatched(1, 12), eggEntry({ id: 'a2', origin: 'milestone', target: 4 }), hatched(25, 30, { id: 'a3' })], 'a1')
    const lines = run(s, 'box').text.split('\n')
    expect(lines[0]).toMatch(/Box \(3\)/)
    expect(lines[1]).toMatch(/^1\. \* Bulbasaur Lv 12$/)
    expect(lines[2]).toMatch(/^2\.   Egg Lv 1$/)
    expect(lines[2]).not.toMatch(/Charmander/) // a random egg stays hidden
    expect(lines[3]).toMatch(/^3\.   Pikachu Lv 30$/)
  })

  test('switch by number or name moves the active marker; no cost, no confirm', async () => {
    const s = withBox([hatched(1, 12), eggEntry({ id: 'a2', origin: 'milestone', target: 4 }), hatched(25, 30, { id: 'a3' })], 'a1')
    expect(run(s, 'switch 3').save.activeId).toBe('a3')
    expect(run(s, 'switch #2').save.activeId).toBe('a2')
    expect(run(s, 'switch pikachu').save.activeId).toBe('a3')
    expect(run(s, 'switch Egg').save.activeId).toBe('a2')
    expect(run(s, 'switch 3').save.pending).toBe(s.pending)
    expect(run(s, 'switch 3').save.box).toEqual(s.box)
  })

  test('switch edge cases: nothing matches, out of range, already active, no argument', async () => {
    const s = withBox([hatched(1, 12), eggEntry({ id: 'a2', origin: 'milestone', target: 4 })], 'a1')
    for (const bad of ['switch 9', 'switch 0', 'switch mewtwo', 'switch zzz']) {
      const r = run(s, bad)
      expect(r.save).toEqual(s)
      expect(r.text).toMatch(/nothing|matches/i)
    }
    expect(run(s, 'switch 1').text).toMatch(/already active/)
    expect(run(s, 'switch').text).toMatch(/usage/i)
  })

  test('release needs confirm and removes only that entry', async () => {
    const s = withBox([hatched(1, 12), hatched(25, 30, { id: 'a2' }), hatched(4, 8, { id: 'a3' })], 'a1')
    const ask = run(s, 'release pikachu')
    expect(ask.save).toEqual(s)
    expect(ask.text).toMatch(/release pikachu confirm/)
    const done = run(s, 'release pikachu confirm')
    expect(done.save.box.map(e => e.id)).toEqual(['a1', 'a3'])
    expect(done.save.activeId).toBe('a1')
  })

  test('releasing the active entry makes the first remaining one active', async () => {
    const s = withBox([hatched(1, 12), hatched(25, 30, { id: 'a2' }), hatched(4, 8, { id: 'a3' })], 'a2')
    const done = run(s, 'release 2 confirm')
    expect(done.save.box.map(e => e.id)).toEqual(['a1', 'a3'])
    expect(done.save.activeId).toBe('a1')
  })

  test('releasing the last entry adds a fresh random egg and makes it active', async () => {
    const s = withBox([hatched(1, 12)], 'a1', { pending: 77 })
    const done = run(s, 'release 1 confirm')
    expect(done.save.box).toHaveLength(1)
    const e = A(done.save)
    expect(e.phase).toBe('egg')
    expect(e.chosen).toBe(false)
    expect(species(e.target!).stage).toBe(0)
    expect(done.save.pending).toBe(77)
    expect(done.text).toMatch(/new egg/i)
  })

  test('release rejects unknown entries and a missing argument', async () => {
    const s = newSave()
    expect(run(s, 'release 4 confirm').save).toEqual(s)
    expect(run(s, 'release').text).toMatch(/usage/i)
  })
})

describe('box: earning eggs', () => {
  const med = DEX.growth['medium-slow']
  const manual = { trigger: 'manual' as const, percent: 50 }
  const cfg = CFG

  test('evolving into a final form earns one egg (origin evolved), not activated', async () => {
    const r = applyCompact(mon(2, med[32]! + 100, 7, { pending: 0 }), DEX, manual, cfg, () => 0.5)
    expect(A(r.save).speciesId).toBe(3)
    expect(r.save.box).toHaveLength(2)
    const egg = r.save.box[1]!
    expect(egg.phase).toBe('egg')
    expect(egg.origin).toBe('evolved')
    expect(egg.chosen).toBe(false)
    expect(species(egg.target!).stage).toBe(0)
    expect(species(egg.target!).legendary).toBe(false)
    expect(r.save.activeId).toBe(A(r.save).id)
    expect(egg.id).not.toBe(r.save.activeId)
    expect(r.events).toContainEqual({ kind: 'egg', origin: 'evolved' })
  })

  test('evolving to a middle form earns nothing', async () => {
    const r = applyCompact(mon(1, med[16]! + 10, 2, { pending: 0 }), DEX, manual, cfg)
    expect(A(r.save).speciesId).toBe(2)
    expect(r.save.box).toHaveLength(1)
    expect(r.events.some(e => e.kind === 'egg')).toBe(false)
  })

  test('a single-stage species reaching Lv 40 earns one egg, once', async () => {
    const med40 = DEX.growth.medium[40]!
    const start = mon(122, med40 - 50, 1, { pending: 400 })
    const first = applyCompact(start, DEX, manual, cfg)
    expect(first.save.box).toHaveLength(2)
    expect(first.save.box[1]!.origin).toBe('mastery')
    expect(A(first.save).eggClaimed).toBe(true)
    expect(first.events).toContainEqual({ kind: 'egg', origin: 'mastery' })
    const again = applyCompact({ ...first.save, pending: 5000 }, DEX, manual, cfg)
    expect(again.save.box).toHaveLength(2)
  })

  test('a single-stage species below Lv 40 earns nothing', async () => {
    const r = applyCompact(mon(122, DEX.growth.medium[39]!, 1, { pending: 10 }), DEX, manual, cfg)
    expect(r.save.box).toHaveLength(1)
  })

  test('every 25th counted compact earns an egg and the counter restarts', async () => {
    let s = mon(25, 0, 0)
    let eggs = 0
    for (let i = 1; i <= 24; i++) {
      const r = applyCompact({ ...s, pending: 0 }, DEX, manual, cfg)
      s = r.save
      eggs += r.events.filter(e => e.kind === 'egg').length
      expect(s.milestone).toBe(i)
    }
    expect(eggs).toBe(0)
    const r = applyCompact(s, DEX, manual, cfg)
    expect(r.save.milestone).toBe(0)
    expect(r.save.box).toHaveLength(2)
    expect(r.save.box[1]!.origin).toBe('milestone')
    expect(r.events).toContainEqual({ kind: 'egg', origin: 'milestone' })
  })

  test('only counted (qualifying) compacts move the milestone', async () => {
    const s = mon(25, 0, 0, { milestone: 24 })
    const low = applyCompact(s, DEX, { trigger: 'manual', percent: 39 }, cfg)
    expect(low.save.milestone).toBe(24)
    expect(low.save.box).toHaveLength(1)
    const none = applyCompact(s, DEX, { trigger: 'precompute', percent: 90 }, cfg)
    expect(none.save).toEqual(s)
  })

  test('new eggs are never auto-activated, and only the active entry gains xp', async () => {
    const s = withBox([hatched(25, 10), hatched(4, 10, { id: 'a2' })], 'a1', { pending: 1000, milestone: 24 })
    const r = applyCompact(s, DEX, manual, cfg)
    expect(r.save.activeId).toBe('a1')
    expect(r.save.box[0]!.xp).toBeGreaterThan(s.box[0]!.xp)
    expect(r.save.box[1]).toEqual(s.box[1])
    expect(r.save.box).toHaveLength(3)
    expect(r.save.box[2]!.xp).toBe(0)
  })

  test('a switch sends the next compact to the other entry', async () => {
    const s = withBox([hatched(25, 10), hatched(4, 10, { id: 'a2' })], 'a2', { pending: 1000 })
    const r = applyCompact(s, DEX, manual, cfg)
    expect(r.save.box[0]).toEqual(s.box[0])
    expect(r.save.box[1]!.xp).toBeGreaterThan(s.box[1]!.xp)
  })
})

describe('save migration and hygiene (v2)', () => {
  const v1 = {
    v: 1,
    rev: 6,
    phase: 'mon',
    eggStage: 0,
    target: null,
    chosen: false,
    speciesId: 25,
    xp: 4321,
    pending: 99,
    compacts: 4,
    branch: null,
    lifetime: { tokens: 5e6, xp: 800, compacts: 9, hatches: 1, evolutions: 0 },
    daily: { '2026-10-05': 700 },
    growth: [1000, 2000],
    lastContext: 5000,
  }

  test('a v1 save becomes box[0], active, origin starter, with totals kept', async () => {
    const s = sanitizeSave(v1, DEX)
    expect(s.version).toBe(2)
    expect(s.box).toHaveLength(1)
    expect(s.activeId).toBe(s.box[0]!.id)
    expect(A(s)).toMatchObject({ phase: 'mon', speciesId: 25, xp: 4321, compacts: 4, origin: 'starter', eggClaimed: false })
    expect(s.pending).toBe(99)
    expect(s.rev).toBe(6)
    expect(s.milestone).toBe(0)
    expect(s.lifetime).toEqual({ ...v1.lifetime, fullLines: 0 })
    expect(s.daily).toEqual(v1.daily)
    expect(s.growth).toEqual([1000, 2000])
  })

  test('a v1 egg migrates with its hidden species and chosen flag', async () => {
    const s = sanitizeSave({ ...v1, phase: 'egg', speciesId: null, target: 4, chosen: true, eggStage: 1, xp: 700 }, DEX)
    expect(A(s)).toMatchObject({ phase: 'egg', target: 4, chosen: true, eggStage: 1, xp: 700, speciesId: null })
  })

  test('a v1 save with an unknown species falls back to a fresh egg but keeps lifetime totals', async () => {
    const s = sanitizeSave({ ...v1, speciesId: 999 }, DEX)
    expect(A(s).phase).toBe('egg')
    expect(s.lifetime).toEqual({ ...v1.lifetime, fullLines: 0 })
  })

  test('a v2 save round-trips unchanged', async () => {
    const s = withBox([hatched(1, 12), eggEntry({ id: 'a2', origin: 'evolved', target: 4 })], 'a2', { pending: 5, milestone: 3, rev: 2 })
    expect(sanitizeSave(JSON.parse(JSON.stringify(s)), DEX)).toEqual(s)
  })

  test('bad entries are dropped, a bad activeId falls back to the first, an empty box gets an egg', async () => {
    const s = withBox([hatched(1, 12), hatched(25, 5, { id: 'a2' })], 'a1')
    const dirty = {
      ...s,
      activeId: 'nope',
      milestone: 99,
      box: [...s.box, { ...s.box[1]!, id: 'a2' }, { ...s.box[1]!, id: 'a9', speciesId: 999 }, 'junk'],
    }
    const clean = sanitizeSave(dirty, DEX)
    expect(clean.box.map(e => e.id)).toEqual(['a1', 'a2'])
    expect(clean.activeId).toBe('a1')
    expect(clean.milestone).toBe(24)
    const empty = sanitizeSave({ ...s, box: [] }, DEX)
    expect(empty.box).toHaveLength(1)
    expect(empty.box[0]!.phase).toBe('egg')
  })

  test('ensureTarget fills every egg in the box that has no species yet', async () => {
    const s = withBox([hatched(1, 12), eggEntry({ id: 'a2', origin: 'milestone' }), eggEntry({ id: 'a3', origin: 'milestone' })], 'a1')
    const r = ensureTarget(s, DEX, () => 0.4)
    expect(r.box[1]!.target).not.toBeNull()
    expect(r.box[2]!.target).not.toBeNull()
    expect(r.box[0]).toEqual(s.box[0])
  })
})

describe('legendaries', () => {
  const manual = { trigger: 'manual' as const, percent: 50 }
  const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`
  const eggs = (s: Save) => s.box.filter(e => e.origin === 'legendary')
  const turn = (s: Save, d: number, percent: number | undefined, rng: () => number = () => 0.5) =>
    observeTurn(s, { day: day(d), percent }, DEX, CFG, rng)

  /** Runs one turn per listed day at the given percent, collecting events. */
  function run(s: Save, days: number[], percent = 50) {
    const events: GameEvent[] = []
    for (const d of days) {
      const r = turn(s, d, percent)
      s = r.save
      events.push(...r.events)
    }
    return { save: s, events }
  }
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

  test('Articuno: 14 finished days under the danger line earn a legendary egg, once', async () => {
    const early = run(newSave(), range(1, 14))
    expect(early.save.streaks.coolDays).toBe(13) // day 14 is still in progress
    expect(eggs(early.save)).toHaveLength(0)
    const done = run(early.save, [15])
    expect(done.save.streaks.coolDays).toBe(14)
    expect(eggs(done.save)).toHaveLength(1)
    expect(eggs(done.save)[0]).toMatchObject({ phase: 'egg', target: 144, origin: 'legendary', chosen: false })
    expect(done.save.legendsEarned).toEqual([144])
    expect(done.events).toContainEqual({ kind: 'legend', id: 144 })
    expect(done.save.activeId).toBe('a1') // never auto-activated
    expect(eggs(run(done.save, range(16, 40)).save)).toHaveLength(1)
  })

  test('Articuno: a day that reaches the danger percent resets the streak', async () => {
    let r = run(newSave(), range(1, 10))
    expect(r.save.streaks.coolDays).toBe(9)
    r = run(r.save, [11], 85)
    expect(r.save.streaks.coolDays).toBe(0)
    expect(r.save.streaks.coolBroken).toBe(true)
    r = run(r.save, [11], 50) // later in the same day: stays broken
    expect(r.save.streaks.coolBroken).toBe(true)
    r = run(r.save, [12], 50) // day 11 does not count
    expect(r.save.streaks.coolDays).toBe(0)
    r = run(r.save, [13], 50)
    expect(r.save.streaks.coolDays).toBe(1) // day 12 finished
  })

  test('Articuno: days without turns neither count nor reset; unknown percent never breaks', async () => {
    const r = run(newSave(), [1, 2, 6, 7])
    expect(r.save.streaks.coolDays).toBe(3)
    const unknown = turn(newSave(), 1, undefined)
    expect(unknown.save.streaks.coolBroken).toBe(false)
  })

  test('Articuno: the danger line follows config', async () => {
    const r = observeTurn(newSave(), { day: day(1), percent: 70 }, DEX, { ...CFG, dangerPercent: 70 }, () => 0.5)
    expect(r.save.streaks.coolBroken).toBe(true)
  })

  test('Zapdos: 30 qualifying non-auto compacts in a row earn an egg', async () => {
    let s = mon(25, 0, 0)
    for (let i = 1; i <= 29; i++) {
      s = applyCompact({ ...s, pending: 0 }, DEX, i % 2 ? manual : { trigger: 'plugin', percent: 60 }, CFG).save
      expect(s.streaks.strike).toBe(i)
    }
    expect(eggs(s)).toHaveLength(0)
    const r = applyCompact(s, DEX, manual, CFG)
    expect(r.save.streaks.strike).toBe(30)
    expect(eggs(r.save)[0]).toMatchObject({ target: 145, origin: 'legendary' })
    expect(r.save.legendsEarned).toContain(145)
    expect(r.events).toContainEqual({ kind: 'legend', id: 145 })
  })

  test('Zapdos: an auto-compact resets the strike; a non-qualifying manual one changes nothing', async () => {
    let s = mon(25, 0, 0, { streaks: { coolDays: 0, coolDay: null, coolBroken: false, strike: 12 } })
    s = applyCompact(s, DEX, { trigger: 'manual', percent: 10 }, CFG).save
    expect(s.streaks.strike).toBe(12)
    s = applyCompact(s, DEX, { trigger: 'auto', percent: 90 }, CFG).save
    expect(s.streaks.strike).toBe(0)
    s = applyCompact(s, DEX, { trigger: 'auto', percent: 10 }, CFG).save
    expect(s.streaks.strike).toBe(0)
    s = applyCompact(s, DEX, manual, CFG).save
    expect(s.streaks.strike).toBe(1)
  })

  test('Moltres: the third fully evolved line earns an egg; mastery claims count too', async () => {
    const med = DEX.growth['medium-slow']
    const life = (fullLines: number) => ({ tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines })
    const two = mon(2, med[32]! + 100, 7, { lifetime: life(2) })
    const r = applyCompact(two, DEX, manual, CFG)
    expect(r.save.lifetime.fullLines).toBe(3)
    expect(eggs(r.save)[0]).toMatchObject({ target: 146, origin: 'legendary' })
    // a Lv 40 single-stage claim is the third line
    const claim = applyCompact(mon(122, DEX.growth.medium[40]! - 50, 1, { pending: 400, lifetime: life(2) }), DEX, manual, CFG)
    expect(claim.save.lifetime.fullLines).toBe(3)
    expect(claim.save.legendsEarned).toContain(146)
    // a middle-stage evolution is not a full line
    const mid = applyCompact(mon(1, med[16]! + 10, 2, { lifetime: life(2) }), DEX, manual, CFG)
    expect(mid.save.lifetime.fullLines).toBe(2)
  })

  test('Mewtwo: locked until all three birds are owned, then 10 full lines', async () => {
    const med = DEX.growth['medium-slow']
    const life = (n: number) => ({ tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines: n })
    const evolve = (extra: Record<string, unknown>) => applyCompact(mon(2, med[32]! + 100, 7, extra), DEX, manual, CFG)
    // ten lines but a bird is missing: nothing
    const locked = evolve({ lifetime: life(9), legendsEarned: [145, 146] })
    expect(locked.save.lifetime.fullLines).toBe(10)
    expect(locked.save.legendsEarned).not.toContain(150)
    // all three birds, nine lines: this evolution is the tenth
    const open = evolve({ lifetime: life(9), legendsEarned: [144, 145, 146] })
    expect(eggs(open.save).map(e => e.target)).toContain(150)
    expect(open.save.legendsEarned).toContain(150)
    // all birds but fewer lines: nothing yet
    expect(evolve({ lifetime: life(5), legendsEarned: [144, 145, 146] }).save.legendsEarned).not.toContain(150)
  })

  test('each legendary is earned once per save', async () => {
    const med = DEX.growth['medium-slow']
    const life = { tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines: 2 }
    const r = applyCompact(mon(2, med[32]! + 100, 7, { lifetime: life, legendsEarned: [146] }), DEX, manual, CFG)
    expect(eggs(r.save)).toHaveLength(0)
    expect(r.events.some(e => e.kind === 'legend')).toBe(false)
  })

  test('Mew: after Mewtwo, a milestone egg has a 1% chance to be Mew; never before, never twice', async () => {
    const base = { milestone: 24, legendsEarned: [144, 145, 146, 150] }
    const lucky = applyCompact(mon(25, 0, 0, base), DEX, manual, CFG, () => 0.005)
    expect(eggs(lucky.save)[0]).toMatchObject({ target: 151, origin: 'legendary' })
    expect(lucky.save.legendsEarned).toContain(151)
    expect(lucky.events).toContainEqual({ kind: 'legend', id: 151 })
    const unlucky = applyCompact(mon(25, 0, 0, base), DEX, manual, CFG, () => 0.5)
    expect(eggs(unlucky.save)).toHaveLength(0)
    expect(unlucky.save.box[1]!.origin).toBe('milestone')
    const early = applyCompact(mon(25, 0, 0, { milestone: 24, legendsEarned: [144] }), DEX, manual, CFG, () => 0.001)
    expect(early.save.legendsEarned).not.toContain(151)
    const twice = applyCompact(mon(25, 0, 0, { ...base, legendsEarned: [...base.legendsEarned, 151] }), DEX, manual, CFG, () => 0.001)
    expect(eggs(twice.save)).toHaveLength(0)
  })

  test('legendaries never come from choose or from random eggs', async () => {
    expect(run0('choose mewtwo').text).toMatch(/legendary/i)
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      const e = A(ensureTarget(newSave(), DEX, () => roll))
      expect(species(e.target!).legendary).toBe(false)
    }
    function run0(args: string) {
      return execute(newSave(), DEX, args, { day: DAY, rng: () => 0 })
    }
  })

  test('hatching a legendary egg uses the normal hatch rule (Mewtwo at Lv 10)', async () => {
    const e = eggEntry({ id: 'a2', origin: 'legendary', target: 150, xp: 6000, eggStage: 2 })
    const s = withBox([e], 'a2')
    const r = applyCompact(s, DEX, manual, CFG)
    expect(levelOf(A(r.save).xp, 'slow', DEX.growth)).toBe(10)
    expect(r.save.dex).toContain(150)
  })

  test('reset-all clears legends and streaks', async () => {
    const s = mon(25, 0, 0, { legendsEarned: [144], streaks: { coolDays: 5, coolDay: day(3), coolBroken: false, strike: 9 }, dex: [25] })
    const r = execute(s, DEX, 'reset-all confirm', { day: DAY, rng: () => 0 })
    expect(r.save.legendsEarned).toEqual([])
    expect(r.save.dex).toEqual([])
    expect(r.save.streaks.strike).toBe(0)
  })
})

describe('dex', () => {
  const caught = (ids: number[], extra: Record<string, unknown> = {}) => mon(25, 0, 0, { dex: ids, ...extra })

  test('species are caught on hatch and on evolution', async () => {
    const hatch = applyCompact(
      withBox([eggEntry({ id: 'a1', target: 4, xp: 6000, eggStage: 2 })], 'a1'),
      DEX,
      { trigger: 'manual', percent: 50 },
      CFG,
    )
    expect(hatch.save.dex).toEqual([4])
    const med = DEX.growth['medium-slow']
    const evo = applyCompact(mon(1, med[16]! + 10, 2, { dex: [1] }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(evo.save.dex).toEqual([1, 2])
  })

  test('migration builds the dex from the box, earlier forms included, and the legends from legendary eggs', async () => {
    const v2 = withBox(
      [hatched(3, 40), eggEntry({ id: 'a2', origin: 'legendary', target: 144 }), hatched(25, 5, { id: 'a3' })],
      'a1',
    )
    const old = { ...v2 } as Record<string, unknown>
    delete old.dex
    delete old.legendsEarned
    delete old.streaks
    old.lifetime = { ...v2.lifetime, fullLines: undefined }
    const s = sanitizeSave(old, DEX)
    expect(s.dex).toEqual([1, 2, 3, 25])
    expect(s.legendsEarned).toEqual([144])
    expect(s.streaks).toEqual({ coolDays: 0, coolDay: null, coolBroken: false, strike: 0 })
    expect(s.lifetime.fullLines).toBe(1) // Venusaur is a finished line
  })

  test('the dex round-trips and junk values are dropped', async () => {
    const s = sanitizeSave({ ...caught([25, 1]), dex: [25, 1, 25, 9999, 'x'], legendsEarned: [144, 144, 25, 'y'] }, DEX)
    expect(s.dex).toEqual([1, 25])
    expect(s.legendsEarned).toEqual([144])
    expect(sanitizeSave(JSON.parse(JSON.stringify(s)), DEX)).toEqual(s)
  })

  test('counts: caught over total, legends over 4 (5 once Mew is owned)', async () => {
    const v = dexView(caught([1, 2, 25]), DEX, CFG)
    expect(v.caught).toBe(3)
    expect(v.total).toBe(DEX.species.length)
    expect(v.legendsOwned).toBe(0)
    expect(v.legendsTotal).toBe(4)
    expect(v.rows.map(r => r.id)).toEqual([144, 145, 146, 150])
    const withMew = dexView(caught([1], { legendsEarned: [144, 150, 151] }), DEX, CFG)
    expect(withMew.legendsOwned).toBe(3)
    expect(withMew.legendsTotal).toBe(5)
    expect(withMew.rows.map(r => r.id)).toEqual([144, 145, 146, 150, 151])
  })

  test('counts: starters (ids 1-9) and common species, legendaries in neither', async () => {
    const view = (extra: Record<string, unknown>) => dexView(caught([], extra), DEX, CFG)
    const v = view({ dex: [1, 2, 4, 25, 133, 63, 144, 150] })
    expect(v.starters).toEqual({ n: 3, total: 4 }) // fixture species with ids 1-9: 1, 2, 3, 4
    expect(v.common).toEqual({ n: 3, total: DEX.species.filter(s => s.id > 9 && !s.legendary).length })
    expect(v.caught).toBe(8) // the header still counts everything caught
    const none = view({})
    expect(none.starters.n).toBe(0)
    expect(none.common.n).toBe(0)
    expect(view({ dex: [144, 145, 146, 150, 151] }).common.n).toBe(0)
    expect(view({ dex: [3] }).starters.n).toBe(1)
  })

  test('dex text: header, then the counts line, then the legendary rows', async () => {
    const text = execute(caught([1, 2, 25, 133]), DEX, 'dex', { day: DAY, rng: () => 0 }).text.split('\n')
    expect(text[0]).toMatch(/^Dex 4\/\d+ · ★ 0\/4$/)
    expect(text[1]).toMatch(/^Starters 2\/\d+ · Common 2\/\d+$/)
    expect(text[2]).toMatch(/^\?\?\? · Frozen bird of legend/)
    expect(text.join('\n')).not.toMatch(/Bulbasaur|Pikachu/) // numbers only, no species rows
  })

  test('rows: unknown names until earned, progress and locked states', async () => {
    const s = caught([], {
      streaks: { coolDays: 3, coolDay: '2026-10-03', coolBroken: false, strike: 12 },
      lifetime: { tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines: 1 },
      legendsEarned: [145],
    })
    const rows = dexView(s, DEX, CFG).rows
    const by = (id: number) => rows.find(r => r.id === id)!
    expect(by(144)).toMatchObject({ earned: false, name: '???', progress: { n: 3, goal: 14 } })
    expect(by(145)).toMatchObject({ earned: true, name: 'Zapdos' })
    expect(by(146)).toMatchObject({ earned: false, name: '???', progress: { n: 1, goal: 3 } })
    expect(by(150)).toMatchObject({ earned: false, name: '???', locked: true })
    expect(by(144).lore).toBe('Frozen bird of legend')
    expect(by(144).goal).toBe('Stay cool: 14 days without reaching 80% context')
    expect(by(145).lore).toBe('Storm bird of legend')
    expect(by(146).goal).toBe('Rebirth: fully evolve 3 lines')
    expect(by(150).lore).toBe('Born in a lab from a legend’s DNA')
    const all = dexView({ ...s, legendsEarned: [144, 145, 146] }, DEX, CFG).rows
    expect(all.find(r => r.id === 150)).toMatchObject({ locked: false, progress: { n: 1, goal: 10 } })
  })

  test('invariant: an unearned row never shows a full counter, for all four legendaries', async () => {
    const life = { tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines: 10 }
    const atGoal = caught([], {
      streaks: { coolDays: 14, coolDay: '2026-10-05', coolBroken: false, strike: 30 },
      lifetime: { ...life, fullLines: 3 },
    })
    const r1 = dexView(atGoal, DEX, CFG).rows
    for (const r of r1.filter(x => x.id !== 150)) {
      expect(r.earned).toBe(false)
      expect(r.progress!.n).toBeLessThan(r.progress!.goal)
    }
    expect(r1.find(r => r.id === 144)!.progress).toEqual({ n: 13, goal: 14 })
    expect(r1.find(r => r.id === 145)!.progress).toEqual({ n: 29, goal: 30 })
    expect(r1.find(r => r.id === 146)!.progress).toEqual({ n: 2, goal: 3 })
    const birds = caught([], { legendsEarned: [144, 145, 146], lifetime: life })
    const m = dexView(birds, DEX, CFG).rows.find(r => r.id === 150)!
    expect(m.earned).toBe(false)
    expect(m.progress).toEqual({ n: 9, goal: 10 })
    // earned rows show the whole goal
    const done = dexView(caught([], { legendsEarned: [144, 145, 146, 150], lifetime: life }), DEX, CFG).rows
    for (const r of done) expect(r.progress!.n).toBe(r.progress!.goal)
  })

  test('a saved game at or over a goal gets its egg when it is read, not a full unearned bar', async () => {
    const life = (n: number) => ({ tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines: n })
    const s = sanitizeSave(mon(1, 5000, 0, { lifetime: life(3) }), DEX)
    expect(s.legendsEarned).toEqual([146])
    expect(s.box.some(e => e.origin === 'legendary' && e.target === 146)).toBe(true)
    // all three birds already owned and ten lines: Mewtwo comes with it
    const m = sanitizeSave(mon(1, 5000, 0, { lifetime: life(10), legendsEarned: [144, 145, 146] }), DEX)
    expect(m.legendsEarned).toEqual([144, 145, 146, 150])
    // reading again grants nothing twice
    expect(sanitizeSave(JSON.parse(JSON.stringify(m)), DEX)).toEqual(m)
    // below goal: untouched
    expect(sanitizeSave(mon(1, 5000, 0, { lifetime: life(2) }), DEX).legendsEarned).toEqual([])
  })

  test('the goal line follows the configured danger percent', async () => {
    const r = dexView(caught([]), DEX, { ...CFG, dangerPercent: 70 }).rows[0]!
    expect(r.goal).toBe('Stay cool: 14 days without reaching 70% context')
  })

  test('/clawd-mon dex prints the catalog and opens the view; Mew stays unmentioned until earned', async () => {
    const ctx = { day: DAY, rng: () => 0 }
    const r = execute(caught([1, 2, 3]), DEX, 'dex', ctx)
    expect(r.dex).toBe(true)
    expect(r.text.split('\n')[0]).toBe(`Dex 3/${DEX.species.length} · ★ 0/4`)
    expect(r.text).toMatch(/\?\?\?/)
    expect(r.text).not.toMatch(/Mew\b/)
    const owned = execute(caught([1], { legendsEarned: [144, 145, 146, 150, 151] }), DEX, 'dex', ctx)
    expect(owned.text).toMatch(/Mew\b/)
    expect(owned.text.split('\n')[0]).toMatch(/★ 5\/5/)
    expect(execute(newSave(), DEX, 'status', ctx).dex).toBeUndefined()
  })

  test('box and status show a star by legendary eggs and Pokémon', async () => {
    const s = withBox([hatched(1, 12), eggEntry({ id: 'a2', origin: 'legendary', target: 144 })], 'a1')
    expect(execute(s, DEX, 'box', { day: DAY }).text).toMatch(/2\.   Egg Lv 1 ★/)
  })
})

describe('projection', () => {
  test('days to next evolution from recent daily xp', async () => {
    const g = DEX.growth.medium
    // Pikachu needs level 30 effective xp; 1000/day for 3 days recorded.
    const s = mon(25, g[30]! - 10_000, 3, {
      daily: { '2026-10-04': 1000, '2026-10-05': 1000, '2026-10-06': 1000 },
    })
    expect(projectDays(s, DEX, '2026-10-06')).toBe(10)
  })

  test('null without history, or with nothing left to evolve into', async () => {
    expect(projectDays(mon(25, 0, 0), DEX, DAY)).toBeNull()
    expect(projectDays(mon(3, 0, 0, { daily: { [DAY]: 500 } }), DEX, DAY)).toBeNull()
  })

  test('eggs have no projection', async () => {
    const s = { ...newSave(), daily: { '2026-10-05': 500, '2026-10-06': 500 } }
    expect(projectDays(s, DEX, '2026-10-06')).toBeNull()
  })

  test('status text carries the projection', async () => {
    const s = mon(25, DEX.growth.medium[30]! - 10_000, 3, { daily: { [DAY]: 1000 } })
    expect(execute(s, DEX, 'status', { day: DAY }).text).toMatch(/10 days/)
  })
})

describe('config and save hygiene', () => {
  test('configFrom fills defaults and rejects nonsense', async () => {
    expect(configFrom({})).toEqual(DEFAULT_CONFIG)
    expect(configFrom({ xpRate: 2, recommendPercent: 50, dangerPercent: 90 })).toEqual({
      xpRate: 2,
      recommendPercent: 50,
      dangerPercent: 90,
    })
    expect(configFrom({ xpRate: -1, recommendPercent: 'x', dangerPercent: 500 })).toEqual({
      ...DEFAULT_CONFIG,
      dangerPercent: 100,
    })
  })

  test('sanitizeSave survives junk and unknown species', async () => {
    for (const junk of [null, undefined, 5, 'x', [], {}]) {
      expect(sanitizeSave(junk, DEX)).toEqual(newSave())
    }
    const bad = sanitizeSave(mon(999, 5), DEX)
    expect(A(bad).phase).toBe('egg')
    const good = sanitizeSave(mon(25, 123, 2, { pending: 9 }), DEX)
    expect(A(good).speciesId).toBe(25)
    expect(A(good).xp).toBe(123)
    expect(good.pending).toBe(9)
  })
})

describe('pace', () => {
  test('Bulbasaur reaches Venusaur in 20-45 days at ~1.5M tokens a day', async () => {
    // One compact a day, alternating manual (100%) and auto (50%): 75% of the bank counts.
    let s: Save = make({ target: 1 })
    let day = 0
    let hatchedOn = 0
    while (A(s).speciesId !== 3 && day < 200) {
      day += 1
      const stamp = `2026-11-${String(day).padStart(3, '0')}`
      s = bankTokens(s, 1_500_000, stamp, CFG)
      s = decayPending(s, 55, CFG) // healthy context: no decay
      const trigger = day % 2 === 0 ? 'auto' : 'manual'
      s = applyCompact(s, DEX, { trigger, percent: 55 }, CFG).save
      if (hatchedOn === 0 && A(s).phase === 'mon') hatchedOn = day
    }
    expect(A(s).speciesId).toBe(3)
    expect(day).toBeGreaterThanOrEqual(20)
    expect(day).toBeLessThanOrEqual(45)
    expect(hatchedOn).toBeGreaterThanOrEqual(3) // each egg stage needs its own compact
    expect(hatchedOn).toBeLessThanOrEqual(5)
  })
})
