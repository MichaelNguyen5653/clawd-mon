import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_CONFIG,
  EGG_XP,
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
  type Save,
} from '../hooks/engine'
import { DEX } from './fixtures'

const CFG = DEFAULT_CONFIG
const DAY = '2026-10-06'

/** A hatched companion of `id` with the given effective XP and qualifying compacts. */
function mon(id: number, xp: number, compacts = 0, extra: Partial<Save> = {}): Save {
  return { ...newSave(), phase: 'mon', speciesId: id, xp, compacts, ...extra }
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
    expect(s.xp).toBe(100)
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
      expect(r.save.xp).toBe(1000) // Pikachu drag is 1
      expect(r.save.lifetime.xp).toBe(1000)
    }
  })

  test('auto compact applies 50% and forfeits the rest', async () => {
    const r = applyCompact(mon(25, 0, 0, { pending: 1000 }), DEX, { trigger: 'auto', percent: 90 }, CFG)
    expect(r.save.xp).toBe(500)
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
    expect(heavy.save.xp).toBeLessThan(light.save.xp)
    expect(close(heavy.save.xp, 1000 * dragFactor(species(3)))).toBe(true)
  })

  test('qualifying gate: counts only at context >= 40%', async () => {
    const at = (percent: number | undefined) =>
      applyCompact(mon(25, 0, 0, { pending: 10 }), DEX, { trigger: 'manual', percent }, CFG).save
    expect(at(39).compacts).toBe(0)
    expect(at(40).compacts).toBe(1)
    expect(at(100).compacts).toBe(1)
    expect(at(undefined).compacts).toBe(0)
    expect(at(39).xp).toBe(10) // xp still applies when the compact does not qualify
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
  const egg = (xp: number, eggStage: 0 | 1 | 2 = 0, extra: Partial<Save> = {}): Save => ({
    ...newSave(),
    xp,
    eggStage,
    ...extra,
  })

  test('thresholds', async () => {
    expect(EGG_XP).toEqual([800, 1800, 3000])
  })

  test('crack 1 needs 800 xp AND a qualifying compact', async () => {
    const low = applyCompact(egg(0, 0, { pending: 799 }), DEX, { trigger: 'manual', percent: 60 }, CFG)
    expect(low.save.eggStage).toBe(0)
    const noQual = applyCompact(egg(0, 0, { pending: 800 }), DEX, { trigger: 'manual', percent: 30 }, CFG)
    expect(noQual.save.eggStage).toBe(0)
    expect(noQual.save.xp).toBe(800)
    const ok = applyCompact(egg(0, 0, { pending: 800 }), DEX, { trigger: 'manual', percent: 40 }, CFG)
    expect(ok.save.eggStage).toBe(1)
    expect(ok.events).toContainEqual({ kind: 'crack', stage: 1 })
  })

  test('only one stage per compact, each stage needs its own qualifying compact', async () => {
    let r = applyCompact(egg(0, 0, { pending: 3000 }), DEX, { trigger: 'manual', percent: 70 }, CFG)
    expect(r.save.eggStage).toBe(1)
    r = applyCompact(r.save, DEX, { trigger: 'manual', percent: 70 }, CFG)
    expect(r.save.eggStage).toBe(2)
    expect(r.events).toContainEqual({ kind: 'crack', stage: 2 })
    r = applyCompact(r.save, DEX, { trigger: 'manual', percent: 70 }, CFG)
    expect(r.save.phase).toBe('mon')
    expect(r.events.some(e => e.kind === 'hatch')).toBe(true)
  })

  test('one compact never advances more than one egg stage, however much xp', async () => {
    const r = applyCompact(egg(99_999, 0, { pending: 99_999 }), DEX, { trigger: 'manual', percent: 90 }, CFG)
    expect(r.save.eggStage).toBe(1)
    expect(r.events.filter(x => x.kind === 'crack' || x.kind === 'hatch')).toHaveLength(1)
  })

  test('a late non-qualifying compact does not crack even if xp is there', async () => {
    const r = applyCompact(egg(1900, 1, { pending: 0 }), DEX, { trigger: 'manual', percent: 10 }, CFG)
    expect(r.save.eggStage).toBe(1)
  })

  test('hatch uses the chosen starter at level 5 with a fresh compact count', async () => {
    const r = applyCompact(egg(3000, 2, { target: 25, compacts: 2 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(r.save.phase).toBe('mon')
    expect(r.save.speciesId).toBe(25)
    expect(levelOf(r.save.xp, 'medium', DEX.growth)).toBe(5)
    expect(r.save.compacts).toBe(0)
    expect(r.save.eggStage).toBe(0)
    expect(r.save.lifetime.hatches).toBe(1)
    expect(r.events).toContainEqual({ kind: 'hatch', speciesId: 25 })
  })

  test('default hatch is a random first-stage non-legendary species', async () => {
    const seen = new Set<number>()
    for (const roll of [0, 0.2, 0.5, 0.99]) {
      const r = applyCompact(egg(3000, 2), DEX, { trigger: 'manual', percent: 50 }, CFG, () => roll)
      const id = r.save.speciesId!
      const s = species(id)
      expect(s.stage).toBe(0)
      expect(s.legendary).toBe(false)
      seen.add(id)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  test('progress of an egg shows crack stage and next threshold', async () => {
    const p = progress(egg(1000, 1), DEX)
    expect(p.kind).toBe('egg')
    if (p.kind !== 'egg') return
    expect(p.stage).toBe(1)
    expect(p.cracks).toBe(3)
    expect(p.nextXp).toBe(1800)
  })
})

describe('evolution', () => {
  const med = DEX.growth['medium-slow']

  test('needs level AND compacts: 3 for the first evolution', async () => {
    const enough = med[16]! + 1
    const noCompacts = applyCompact(mon(1, enough, 2, { pending: 0 }), DEX, { trigger: 'manual', percent: 20 }, CFG)
    expect(noCompacts.save.speciesId).toBe(1) // 2 compacts + a non-qualifying one
    const noLevel = applyCompact(mon(1, med[15]!, 3, { pending: 0 }), DEX, { trigger: 'manual', percent: 20 }, CFG)
    expect(noLevel.save.speciesId).toBe(1)
    const both = applyCompact(mon(1, enough, 2, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(both.save.speciesId).toBe(2)
    expect(both.events).toContainEqual({ kind: 'evolve', from: 1, to: 2 })
    expect(both.save.lifetime.evolutions).toBe(1)
  })

  test('second evolution needs 8 compacts', async () => {
    const xp = med[32]! + 100
    const seven = applyCompact(mon(2, xp, 6, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(seven.save.speciesId).toBe(2)
    const eight = applyCompact(mon(2, xp, 7, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(eight.save.speciesId).toBe(3)
  })

  test('evolution keeps level (effective xp) and clears the branch pick', async () => {
    const xp = med[16]! + 50
    const r = applyCompact(mon(1, xp, 3, { pending: 0, branch: 2 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(r.save.xp).toBe(xp)
    expect(r.save.branch).toBeNull()
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
    expect(at29.save.speciesId).toBe(25)
    const at30 = applyCompact(
      mon(25, DEX.growth.medium[30]!, 3, { pending: 0 }),
      DEX,
      { trigger: 'manual', percent: 50 },
      CFG,
    )
    expect(at30.save.speciesId).toBe(26)
  })

  test('final stage has no next evolution', async () => {
    expect(nextEvolution(mon(3, 0, 99), DEX)).toBeNull()
    expect(nextEvolution(newSave(), DEX)).toBeNull()
  })

  test('multi-branch species default to the first, branch pick overrides', async () => {
    const xp = DEX.growth.medium[30]!
    const dflt = applyCompact(mon(133, xp, 3, { pending: 0 }), DEX, { trigger: 'manual', percent: 50 }, CFG)
    expect(dflt.save.speciesId).toBe(134)
    const pick = applyCompact(
      mon(133, xp, 3, { pending: 0, branch: 136 }),
      DEX,
      { trigger: 'manual', percent: 50 },
      CFG,
    )
    expect(pick.save.speciesId).toBe(136)
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

  test('status for an egg mentions the egg; for a mon, level and name', async () => {
    expect(run(newSave(), 'status').text).toMatch(/egg/i)
    const t = run(mon(1, DEX.growth['medium-slow'][12]!, 1), 'status').text
    expect(t).toMatch(/Bulbasaur/)
    expect(t).toMatch(/Lv 12/)
  })

  test('choose sets the egg starter, normalising names, resolving to the first stage', async () => {
    expect(run(newSave(), 'choose Pikachu').save.target).toBe(25)
    expect(run(newSave(), 'choose  ivysaur ').save.target).toBe(1)
    expect(run(newSave(), 'choose mr. mime').save.target).toBe(122)
  })

  test('choose rejects unknown names', async () => {
    const s = newSave()
    const r = run(s, 'choose missingno')
    expect(r.save).toEqual(s)
    expect(r.text).toMatch(/unknown|no such/i)
    expect(run(s, 'choose').text).toMatch(/usage|name/i)
  })

  test('choose on a hatched mon needs confirm, then swaps to the first stage at level 5', async () => {
    const s = mon(1, DEX.growth['medium-slow'][20]!, 5, { pending: 40 })
    const ask = run(s, 'choose pikachu')
    expect(ask.save).toEqual(s)
    expect(ask.text).toMatch(/confirm/)
    const done = run(s, 'choose pikachu confirm')
    expect(done.save.speciesId).toBe(25)
    expect(levelOf(done.save.xp, 'medium', DEX.growth)).toBe(5)
    expect(done.save.compacts).toBe(0)
    expect(done.save.pending).toBe(40)
  })

  test('branch must name an evolution of the current species', async () => {
    const eevee = mon(133, 0, 0)
    expect(run(eevee, 'branch jolteon').save.branch).toBe(135)
    const bad = run(eevee, 'branch venusaur')
    expect(bad.save.branch).toBeNull()
    expect(bad.text).toMatch(/not|no /i)
    expect(run(mon(1, 0), 'branch ivysaur').text).toMatch(/only|no choice|one/i)
    expect(run(newSave(), 'branch jolteon').text).toMatch(/egg|hatch/i)
  })

  test('reset sends the companion back to an egg and keeps lifetime totals', async () => {
    const s = mon(3, 99999, 12, {
      pending: 50,
      lifetime: { tokens: 1e7, xp: 9000, compacts: 20, hatches: 2, evolutions: 4 },
      daily: { [DAY]: 5 },
    })
    const r = run(s, 'reset')
    expect(r.save.phase).toBe('egg')
    expect(r.save.speciesId).toBeNull()
    expect(r.save.xp).toBe(0)
    expect(r.save.pending).toBe(0)
    expect(r.save.compacts).toBe(0)
    expect(r.save.eggStage).toBe(0)
    expect(r.save.lifetime).toEqual(s.lifetime)
    expect(r.wipe).toBeUndefined()
    expect(r.text).toMatch(/pending/i)
    expect(r.text).toMatch(/starter/i)
  })

  test('reset-all needs confirm; with it the whole save is fresh and the store is wiped', async () => {
    const s = mon(3, 99999, 12, { lifetime: { tokens: 1e7, xp: 9000, compacts: 20, hatches: 2, evolutions: 4 } })
    const ask = run(s, 'reset-all')
    expect(ask.save).toEqual(s)
    expect(ask.wipe).toBeUndefined()
    expect(ask.text).toMatch(/reset-all confirm/)
    const done = run(s, 'reset-all confirm')
    expect(done.save).toEqual(newSave())
    expect(done.wipe).toBe(true)
    expect(done.save.lifetime.tokens).toBe(0)
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

  test('egg projects days to hatch', async () => {
    const s = { ...newSave(), xp: 1000, daily: { '2026-10-05': 500, '2026-10-06': 500 } }
    expect(projectDays(s, DEX, '2026-10-06')).toBe(4) // 2000 left at 500/day
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
    expect(bad.phase).toBe('egg')
    const good = sanitizeSave(mon(25, 123, 2, { pending: 9 }), DEX)
    expect(good.speciesId).toBe(25)
    expect(good.xp).toBe(123)
    expect(good.pending).toBe(9)
  })
})

describe('pace', () => {
  test('Bulbasaur reaches Venusaur in 20-45 days at ~1.5M tokens a day', async () => {
    // One compact a day, alternating manual (100%) and auto (50%): 75% of the bank counts.
    let s: Save = { ...newSave(), target: 1 }
    let day = 0
    let hatchedOn = 0
    while (s.speciesId !== 3 && day < 200) {
      day += 1
      const stamp = `2026-11-${String(day).padStart(3, '0')}`
      s = bankTokens(s, 1_500_000, stamp, CFG)
      s = decayPending(s, 55, CFG) // healthy context: no decay
      const trigger = day % 2 === 0 ? 'auto' : 'manual'
      s = applyCompact(s, DEX, { trigger, percent: 55 }, CFG).save
      if (hatchedOn === 0 && s.phase === 'mon') hatchedOn = day
    }
    expect(s.speciesId).toBe(3)
    expect(day).toBeGreaterThanOrEqual(20)
    expect(day).toBeLessThanOrEqual(45)
    expect(hatchedOn).toBeGreaterThanOrEqual(3) // each egg stage needs its own compact
    expect(hatchedOn).toBeLessThanOrEqual(5)
  })
})
