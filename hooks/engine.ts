// Clawd-mon engine: pure rules, no engine `$`, no I/O. Everything the band and the
// hooks do to the save goes through here so it can be unit-tested.
//
// Model: tokens you spend bank as `pending` XP. A compact applies the bank to the ACTIVE
// entry of the box (manual or plugin: all of it, auto: half, the rest is forfeited). Decay
// eats pending while the context is dangerously full. Level comes from the species' growth
// table with a base-stat-total drag; evolution needs a level and a number of qualifying
// compacts. Finishing a line, hitting Lv 40 with a single-stage species, or every 25
// qualifying compacts earns a new egg in the box.

import type { ClawdMonEntry, ClawdMonLifetime, ClawdMonSave, ClawdMonStreaks } from '../types'

export type Rate = 'fast' | 'medium' | 'medium-slow' | 'slow'

export type Evolution = {
  to: number
  trigger: string
  level: number | null
  item: string | null
}

export type Species = {
  id: number
  name: string
  types: string[]
  stats: { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number }
  growthRate: Rate
  stage: number
  evolvesFrom: number | null
  evolutions: Evolution[]
  legendary: boolean
}

export type Dex = {
  species: Species[]
  /** Cumulative XP by level: `growth[rate][level]` is the XP at which `level` starts. */
  growth: Record<Rate, number[]>
}

export type Config = {
  /** XP banked per 1,000 tokens. */
  xpRate: number
  /** Recommend a compact at or above this context percent. */
  recommendPercent: number
  /** At or above this context percent pending XP decays each turn. */
  dangerPercent: number
}

export type Lifetime = ClawdMonLifetime
export type Streaks = ClawdMonStreaks
export type Entry = ClawdMonEntry

/** The save; its shape is the plugin's state contract in types/index.d.ts. */
export type Save = ClawdMonSave

export type GameEvent =
  | { kind: 'levelup'; level: number }
  | { kind: 'crack'; stage: number }
  | { kind: 'hatch'; speciesId: number }
  | { kind: 'evolve'; from: number; to: number }
  | { kind: 'egg'; origin: 'evolved' | 'milestone' | 'mastery' }
  | { kind: 'legend'; id: number }

export type CompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'

export const DEFAULT_CONFIG: Config = { xpRate: 1, recommendPercent: 60, dangerPercent: 80 }

/** Egg XP to hatch is this many per hatch level. */
export const EGG_XP_PER_LEVEL = 600
/** Hatch level of an egg whose species is not known yet. */
export const DEFAULT_HATCH_LEVEL = 5
/** A compact counts toward gates only at or above this context percent. */
export const QUALIFY_PERCENT = 40
/** Qualifying compacts since hatch for the first and second evolution. */
export const EVOLVE_COMPACTS = [3, 8] as const
/** Every this many qualifying compacts the box gets a new egg. */
export const MILESTONE_COMPACTS = 25
/** A single-stage species earns one egg at this level. */
export const SINGLE_STAGE_EGG_LEVEL = 40
export const AUTO_SHARE = 0.5
export const DECAY_PER_TURN = 0.02
export const ITEM_EVOLVE_LEVEL = 30
export const TRADE_EVOLVE_LEVEL = 36
/** Legendary goals. */
export const COOL_DAYS_GOAL = 14
export const STRIKE_GOAL = 30
export const FULL_LINES_BIRD = 3
export const FULL_LINES_MEWTWO = 10
export const MEW_CHANCE = 0.01
export const ARTICUNO = 144
export const ZAPDOS = 145
export const MOLTRES = 146
export const MEWTWO = 150
export const MEW = 151
const BIRDS = [ARTICUNO, ZAPDOS, MOLTRES] as const
const HISTORY_DAYS = 14
const GROWTH_SAMPLES = 5
const PROJECT_TURNS = 3
const MAX_LEVEL = 100

// ---------- save and config ----------

export function newEntry(id: string, origin: Entry['origin'], target: number | null = null): Entry {
  return {
    id,
    phase: 'egg',
    target,
    speciesId: null,
    chosen: false,
    xp: 0,
    eggStage: 0,
    compacts: 0,
    branch: null,
    origin,
    eggClaimed: false,
  }
}

export function newSave(): Save {
  return {
    version: 2,
    rev: 0,
    pending: 0,
    milestone: 0,
    activeId: 'a1',
    box: [newEntry('a1', 'starter')],
    lifetime: { tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0, fullLines: 0 },
    dex: [],
    legendsEarned: [],
    streaks: { coolDays: 0, coolDay: null, coolBroken: false, strike: 0 },
    daily: {},
    growth: [],
    lastContext: null,
  }
}

/** The entry that gains XP. The box is never empty. */
export function activeEntry(save: Save): Entry {
  return save.box.find(e => e.id === save.activeId) ?? save.box[0]!
}

function setEntry(save: Save, entry: Entry): Save {
  return { ...save, box: save.box.map(e => (e.id === entry.id ? entry : e)) }
}

function nextId(box: readonly Entry[]): string {
  let n = 0
  for (const e of box) {
    const m = /^a(\d+)$/.exec(e.id)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return `a${n + 1}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function id(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

function readEntry(raw: unknown, dex: Dex, fallbackId: string): Entry | null {
  if (!isRecord(raw)) return null
  const origin =
    raw.origin === 'evolved' || raw.origin === 'milestone' || raw.origin === 'mastery' || raw.origin === 'legendary'
      ? raw.origin
      : 'starter'
  const entry: Entry = {
    id: typeof raw.id === 'string' && /^[\w-]{1,12}$/.test(raw.id) ? raw.id : fallbackId,
    phase: raw.phase === 'mon' ? 'mon' : 'egg',
    target: id(raw.target),
    speciesId: id(raw.speciesId),
    chosen: raw.chosen === true,
    xp: Math.max(0, num(raw.xp, 0)),
    eggStage: raw.eggStage === 1 || raw.eggStage === 2 ? raw.eggStage : 0,
    compacts: Math.max(0, Math.floor(num(raw.compacts, 0))),
    branch: id(raw.branch),
    origin,
    eggClaimed: raw.eggClaimed === true,
  }
  if (entry.target !== null && !find(dex, entry.target)) entry.target = null
  if (entry.target === null || entry.phase === 'mon') entry.chosen = false
  if (entry.phase === 'mon') {
    if (entry.speciesId === null || !find(dex, entry.speciesId)) return null
    entry.target = null
    entry.eggStage = 0
  } else {
    entry.speciesId = null
  }
  return entry
}

/** Reads whatever the store held into a valid v2 save; a v1 save becomes box[0]; junk, a fresh egg. */
export function sanitizeSave(raw: unknown, dex: Dex): Save {
  const base = newSave()
  if (!isRecord(raw)) return base
  const life = isRecord(raw.lifetime) ? raw.lifetime : {}
  const daily: Record<string, number> = {}
  if (isRecord(raw.daily)) {
    for (const [k, v] of Object.entries(raw.daily)) {
      if (/^[\w-]+$/.test(k) && typeof v === 'number' && Number.isFinite(v)) daily[k] = v
    }
  }
  let box: Entry[] = []
  if (Array.isArray(raw.box)) {
    const seen = new Set<string>()
    raw.box.forEach((r, i) => {
      const e = readEntry(r, dex, `a${i + 1}`)
      if (e && !seen.has(e.id)) {
        seen.add(e.id)
        box.push(e)
      }
    })
  } else if (raw.phase === 'mon' || raw.phase === 'egg') {
    // Version 1: one flat companion. It becomes the first, active entry of the box.
    const e = readEntry({ ...raw, id: 'a1', origin: 'starter' }, dex, 'a1')
    if (e) box = [e]
  }
  if (box.length === 0) box = [newEntry('a1', 'starter')]
  // Finished lines: stored, or counted from the box for a save that predates the counter.
  const derivedLines = box.filter(e => {
    const sp = speciesOf(e, dex)
    return (sp !== undefined && sp.stage > 0 && sp.evolutions.length === 0) || e.eggClaimed
  }).length
  const lifetime = {
    tokens: Math.max(0, num(life.tokens, 0)),
    xp: Math.max(0, num(life.xp, 0)),
    compacts: Math.max(0, num(life.compacts, 0)),
    hatches: Math.max(0, num(life.hatches, 0)),
    evolutions: Math.max(0, num(life.evolutions, 0)),
    fullLines: Math.max(0, Math.floor(num(life.fullLines, derivedLines))),
  }
  const known = (v: unknown): number[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && find(dex, n) !== undefined))].sort((a, b) => a - b)
      : []
  let caught = known(raw.dex)
  if (!Array.isArray(raw.dex)) {
    const ids = new Set<number>()
    for (const e of box) {
      let sp = speciesOf(e, dex)
      for (let i = 0; sp && i < 5; i++) {
        ids.add(sp.id)
        sp = sp.evolvesFrom !== null ? find(dex, sp.evolvesFrom) : undefined
      }
    }
    caught = [...ids].sort((a, b) => a - b)
  }
  const earned = Array.isArray(raw.legendsEarned)
    ? known(raw.legendsEarned).filter(n => find(dex, n)?.legendary === true)
    : box.filter(e => e.origin === 'legendary' && e.target !== null).map(e => e.target!)
  const rs = isRecord(raw.streaks) ? raw.streaks : {}
  const streaks: Streaks = {
    coolDays: Math.max(0, Math.floor(num(rs.coolDays, 0))),
    coolDay: typeof rs.coolDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rs.coolDay) ? rs.coolDay : null,
    coolBroken: rs.coolBroken === true,
    strike: Math.max(0, Math.floor(num(rs.strike, 0))),
  }
  const activeId = typeof raw.activeId === 'string' && box.some(e => e.id === raw.activeId) ? raw.activeId : box[0]!.id
  const read: Save = {
    ...base,
    rev: Math.max(0, Math.floor(num(raw.rev, 0))),
    pending: Math.max(0, num(raw.pending, 0)),
    milestone: clamp(Math.floor(num(raw.milestone, 0)), 0, MILESTONE_COMPACTS - 1),
    activeId,
    box,
    lifetime,
    dex: caught,
    legendsEarned: [...new Set(earned)].sort((a, b) => a - b),
    streaks,
    daily: trimDaily(daily),
    growth: Array.isArray(raw.growth)
      ? raw.growth.filter((n): n is number => typeof n === 'number' && n > 0 && Number.isFinite(n)).slice(-GROWTH_SAMPLES)
      : [],
    lastContext: typeof raw.lastContext === 'number' && Number.isFinite(raw.lastContext) ? raw.lastContext : null,
  }
  // A save already at a goal (older, or edited) gets its egg now rather than at the next compact.
  return unlockLegends(read, dex).save
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Reads the plugin's userConfig values; anything unusable falls back to the default. */
export function configFrom(options: Record<string, unknown>): Config {
  const d = DEFAULT_CONFIG
  const rate = options.xpRate
  const pct = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, 1, 100) : fallback
  return {
    xpRate: typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : d.xpRate,
    recommendPercent: pct(options.recommendPercent, d.recommendPercent),
    dangerPercent: pct(options.dangerPercent, d.dangerPercent),
  }
}

// ---------- species, level ----------

function find(dex: Dex, speciesId: number): Species | undefined {
  return dex.species.find(s => s.id === speciesId)
}

export function bst(s: Species): number {
  const t = s.stats
  return t.hp + t.attack + t.defense + t.spAttack + t.spDefense + t.speed
}

/** Heavier species level slower: clamp((320 / BST)^0.35, 0.6, 1.1). */
export function dragFactor(s: Species): number {
  return clamp((320 / Math.max(1, bst(s))) ** 0.35, 0.6, 1.1)
}

export function tokensToXp(tokens: number, xpRate: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return (tokens / 1000) * xpRate
}

/** Highest level whose threshold the XP has reached, 1..100. */
export function levelOf(xp: number, rate: Rate, growth: Dex['growth']): number {
  const table = growth[rate]
  let level = 1
  for (let l = 2; l <= MAX_LEVEL; l++) {
    if ((table[l] ?? Number.POSITIVE_INFINITY) <= xp) level = l
    else break
  }
  return level
}

/** Level an egg of this species hatches at: round(BST / 60), 4..10. */
export function hatchLevel(s: Species): number {
  return clamp(Math.round(bst(s) / 60), 4, 10)
}

/** Egg levels at which it cracks, cracks again, and hatches: strictly rising, first at least 2. */
export function crackLevels(h: number): [number, number, number] {
  const first = Math.max(2, Math.round(0.4 * h))
  let second = Math.max(first + 1, Math.round(0.7 * h))
  if (second >= h) second = Math.max(first + 1, h - 1)
  return [first, second, Math.max(h, second + 1)]
}

/** Applied egg XP at which egg level `level` starts, for hatch level `h`. */
export function eggXpAt(level: number, h: number): number {
  if (level <= 1) return 0
  return EGG_XP_PER_LEVEL * h * ((level - 1) / (h - 1)) ** 1.5
}

/** Egg level (1..h) for applied egg XP. */
export function eggLevel(xp: number, h: number): number {
  let level = 1
  for (let l = 2; l <= h; l++) if (xp >= eggXpAt(l, h)) level = l
  return level
}

function eggHatchLevel(entry: Entry, dex: Dex): number {
  const sp = entry.target !== null ? find(dex, entry.target) : undefined
  return sp ? hatchLevel(sp) : DEFAULT_HATCH_LEVEL
}

function pickStarter(dex: Dex, rng: () => number): Species {
  const pool = dex.species.filter(x => x.stage === 0 && !x.legendary)
  const list = pool.length > 0 ? pool : dex.species
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!
}

/** Every egg with no species yet gets a random first-stage non-legendary one, kept hidden. */
export function ensureTarget(save: Save, dex: Dex, rng: () => number = Math.random): Save {
  if (!save.box.some(e => e.phase === 'egg' && e.target === null)) return save
  return {
    ...save,
    box: save.box.map(e =>
      e.phase === 'egg' && e.target === null ? { ...e, target: pickStarter(dex, rng).id, chosen: false } : e,
    ),
  }
}

function root(dex: Dex, s: Species): Species {
  let cur = s
  for (let i = 0; i < 5 && cur.evolvesFrom !== null; i++) {
    const parent = find(dex, cur.evolvesFrom)
    if (!parent) break
    cur = parent
  }
  return cur
}

function speciesOf(entry: Entry, dex: Dex): Species | undefined {
  return entry.phase === 'mon' && entry.speciesId !== null ? find(dex, entry.speciesId) : undefined
}

export type NextEvolution = { to: Species; level: number; compactsNeeded: number }

function entryNext(entry: Entry, dex: Dex): NextEvolution | null {
  const s = speciesOf(entry, dex)
  if (!s || s.evolutions.length === 0) return null
  const chosen = entry.branch !== null ? s.evolutions.find(e => e.to === entry.branch) : undefined
  const evo = chosen ?? s.evolutions[0]!
  const to = find(dex, evo.to)
  if (!to) return null
  const level =
    evo.trigger === 'level-up'
      ? (evo.level ?? ITEM_EVOLVE_LEVEL)
      : evo.trigger === 'trade'
        ? TRADE_EVOLVE_LEVEL
        : ITEM_EVOLVE_LEVEL
  return { to, level, compactsNeeded: s.stage <= 0 ? EVOLVE_COMPACTS[0] : EVOLVE_COMPACTS[1] }
}

/** The evolution the active Pokémon is working toward, or null at the end of its line. */
export function nextEvolution(save: Save, dex: Dex): NextEvolution | null {
  return entryNext(activeEntry(save), dex)
}

// ---------- bank, decay, context ----------

function trimDaily(daily: Record<string, number>): Record<string, number> {
  const keys = Object.keys(daily).sort()
  const out: Record<string, number> = {}
  for (const k of keys.slice(-HISTORY_DAYS)) out[k] = daily[k]!
  return out
}

/** Banks tokens as pending XP. `day` is a UTC YYYY-MM-DD stamp for the history. */
export function bankTokens(save: Save, tokens: number, day: string, cfg: Config): Save {
  const xp = tokensToXp(tokens, cfg.xpRate)
  if (xp <= 0) return save
  return {
    ...save,
    pending: save.pending + xp,
    lifetime: { ...save.lifetime, tokens: save.lifetime.tokens + tokens },
    daily: trimDaily({ ...save.daily, [day]: (save.daily[day] ?? 0) + xp }),
  }
}

/** One completed turn at `percent` context: pending loses 2% at or above the danger line. */
export function decayPending(save: Save, percent: number | undefined, cfg: Config): Save {
  if (percent === undefined || percent < cfg.dangerPercent || save.pending <= 0) return save
  return { ...save, pending: save.pending * (1 - DECAY_PER_TURN) }
}

/** Records a context-size reading; positive growth since the last one feeds the projection. */
export function observeContext(save: Save, tokens: number | undefined): Save {
  if (tokens === undefined || !Number.isFinite(tokens)) return save
  const growth = [...save.growth]
  if (save.lastContext !== null && tokens > save.lastContext) growth.push(tokens - save.lastContext)
  return { ...save, growth: growth.slice(-GROWTH_SAMPLES), lastContext: tokens }
}

export type Recommendation = { recommend: boolean; reason: 'high' | 'projected' | null }

export function recommendation(
  usage: { percent?: number; tokens?: number; window: number },
  save: Save,
  cfg: Config,
): Recommendation {
  const { percent } = usage
  if (percent === undefined) return { recommend: false, reason: null }
  if (percent >= cfg.recommendPercent) return { recommend: true, reason: 'high' }
  if (save.growth.length >= 2 && usage.window > 0) {
    const avg = save.growth.reduce((a, b) => a + b, 0) / save.growth.length
    const projected = percent + ((avg * PROJECT_TURNS) / usage.window) * 100
    if (projected >= cfg.dangerPercent) return { recommend: true, reason: 'projected' }
  }
  return { recommend: false, reason: null }
}

// ---------- compact ----------

export type CompactResult = { save: Save; events: GameEvent[] }

function addEgg(save: Save, dex: Dex, rng: () => number, origin: 'evolved' | 'milestone' | 'mastery'): Save {
  const egg = newEntry(nextId(save.box), origin, pickStarter(dex, rng).id)
  return { ...save, box: [...save.box, egg] }
}

function addLegendaryEgg(save: Save, id: number): Save {
  const egg = newEntry(nextId(save.box), 'legendary', id)
  return { ...save, box: [...save.box, egg], legendsEarned: [...save.legendsEarned, id].sort((x, y) => x - y) }
}

function caught(save: Save, id: number): Save {
  return save.dex.includes(id) ? save : { ...save, dex: [...save.dex, id].sort((x, y) => x - y) }
}

/** Legendary eggs whose goals are met and that this save has not earned yet. */
export function unlockLegends(save: Save, dex: Dex): CompactResult {
  const events: GameEvent[] = []
  let s = save
  const has = (id: number) => s.legendsEarned.includes(id)
  const grant = (id: number) => {
    s = addLegendaryEgg(s, id)
    events.push({ kind: 'legend', id })
  }
  if (!has(ARTICUNO) && s.streaks.coolDays >= COOL_DAYS_GOAL) grant(ARTICUNO)
  if (!has(ZAPDOS) && s.streaks.strike >= STRIKE_GOAL) grant(ZAPDOS)
  if (!has(MOLTRES) && s.lifetime.fullLines >= FULL_LINES_BIRD) grant(MOLTRES)
  if (!has(MEWTWO) && BIRDS.every(has) && s.lifetime.fullLines >= FULL_LINES_MEWTWO) grant(MEWTWO)
  return { save: s, events }
}

/**
 * One finished main-loop turn at `percent` context on UTC `day`: feeds the Articuno goal.
 * A day that reaches the danger percent resets the streak at once and does not count; a day
 * counts once a later day starts. Days with no turns neither count nor reset.
 */
export function observeTurn(
  save: Save,
  input: { day: string; percent?: number },
  dex: Dex,
  cfg: Config,
  _rng: () => number = Math.random,
): CompactResult {
  const hit = input.percent !== undefined && input.percent >= cfg.dangerPercent
  let st = save.streaks
  if (st.coolDay === null) {
    st = { ...st, coolDay: input.day, coolBroken: hit, coolDays: hit ? 0 : st.coolDays }
  } else if (input.day === st.coolDay) {
    if (hit) st = { ...st, coolBroken: true, coolDays: 0 }
  } else if (input.day > st.coolDay) {
    st = {
      ...st,
      coolDays: st.coolBroken || hit ? 0 : st.coolDays + 1,
      coolDay: input.day,
      coolBroken: hit,
    }
  }
  if (st === save.streaks) return { save, events: [] }
  return unlockLegends({ ...save, streaks: st }, dex)
}

/**
 * Applies the bank for a finished compact to the ACTIVE entry. `percent` is the context
 * percent just before it ran (a compact below QUALIFY_PERCENT still pays XP but counts for
 * no gate). New eggs it earns go to the box; they are never made active.
 */
export function applyCompact(
  save: Save,
  dex: Dex,
  input: { trigger: CompactTrigger; percent?: number },
  _cfg: Config,
  rng: () => number = Math.random,
): CompactResult {
  if (input.trigger === 'precompute') return { save, events: [] }
  const events: GameEvent[] = []
  const share = input.trigger === 'auto' ? AUTO_SHARE : 1
  const raw = save.pending * share
  const qualifies = input.percent !== undefined && input.percent >= QUALIFY_PERCENT
  const bump = qualifies ? 1 : 0

  let entry: Entry = { ...activeEntry(save), compacts: activeEntry(save).compacts + bump }
  let hatched = 0
  let evolved = 0
  let fullLines = 0
  let earnFromEvolve = false
  let earnSingle = false
  const newDex: number[] = []

  if (entry.phase === 'egg') {
    entry.xp += raw
    const h = eggHatchLevel(entry, dex)
    const needed = crackLevels(h)[entry.eggStage]
    if (qualifies && eggLevel(entry.xp, h) >= needed) {
      if (entry.eggStage === 2) {
        const sp = (entry.target !== null ? find(dex, entry.target) : undefined) ?? pickStarter(dex, rng)
        entry = {
          ...entry,
          phase: 'mon',
          eggStage: 0,
          target: null,
          chosen: false,
          speciesId: sp.id,
          xp: dex.growth[sp.growthRate][hatchLevel(sp)] ?? 0,
          compacts: 0,
          branch: null,
        }
        hatched = 1
        newDex.push(sp.id)
        events.push({ kind: 'hatch', speciesId: sp.id })
      } else {
        entry.eggStage = (entry.eggStage + 1) as 1 | 2
        events.push({ kind: 'crack', stage: entry.eggStage })
      }
    }
  } else {
    const sp = speciesOf(entry, dex)
    if (sp) {
      const before = levelOf(entry.xp, sp.growthRate, dex.growth)
      entry.xp += raw * dragFactor(sp)
      const after = levelOf(entry.xp, sp.growthRate, dex.growth)
      if (after > before) events.push({ kind: 'levelup', level: after })

      const next = entryNext(entry, dex)
      if (next && after >= next.level && entry.compacts >= next.compactsNeeded) {
        entry = { ...entry, speciesId: next.to.id, branch: null }
        evolved = 1
        newDex.push(next.to.id)
        events.push({ kind: 'evolve', from: sp.id, to: next.to.id })
        if (next.to.evolutions.length === 0) {
          earnFromEvolve = true
          fullLines += 1
        }
      } else if (sp.stage === 0 && sp.evolutions.length === 0 && !entry.eggClaimed && after >= SINGLE_STAGE_EGG_LEVEL) {
        entry = { ...entry, eggClaimed: true }
        earnSingle = true
        fullLines += 1
      }
    }
  }

  // Zapdos: qualifying non-auto compacts in a row; an auto-compact breaks the run.
  const strike =
    input.trigger === 'auto' ? 0 : qualifies ? save.streaks.strike + 1 : save.streaks.strike

  let s: Save = setEntry(
    {
      ...save,
      pending: 0,
      growth: [],
      lastContext: null,
      streaks: { ...save.streaks, strike },
      lifetime: {
        ...save.lifetime,
        xp: save.lifetime.xp + raw,
        compacts: save.lifetime.compacts + bump,
        hatches: save.lifetime.hatches + hatched,
        evolutions: save.lifetime.evolutions + evolved,
        fullLines: save.lifetime.fullLines + fullLines,
      },
    },
    entry,
  )
  for (const id of newDex) s = caught(s, id)

  if (earnFromEvolve) {
    s = addEgg(s, dex, rng, 'evolved')
    events.push({ kind: 'egg', origin: 'evolved' })
  }
  if (earnSingle) {
    s = addEgg(s, dex, rng, 'mastery')
    events.push({ kind: 'egg', origin: 'mastery' })
  }
  if (qualifies) {
    const count = s.milestone + 1
    if (count >= MILESTONE_COMPACTS) {
      // After Mewtwo, one milestone egg in a hundred is Mew instead (once per save).
      if (s.legendsEarned.includes(MEWTWO) && !s.legendsEarned.includes(MEW) && rng() < MEW_CHANCE) {
        s = { ...addLegendaryEgg(s, MEW), milestone: 0 }
        events.push({ kind: 'legend', id: MEW })
      } else {
        s = { ...addEgg(s, dex, rng, 'milestone'), milestone: 0 }
        events.push({ kind: 'egg', origin: 'milestone' })
      }
    } else {
      s = { ...s, milestone: count }
    }
  }
  const legends = unlockLegends(s, dex)
  return { save: legends.save, events: [...events, ...legends.events] }
}

// ---------- view model ----------

export type Progress =
  | {
      kind: 'egg'
      /** Cracks so far, 0-2 (drawn as art on the egg, never spelled out). */
      stage: number
      level: number
      xp: number
      /** XP gained into the current egg level, and the span to the next. */
      into: number
      need: number
      fraction: number
      pending: number
      /** Only when the player chose it; a random egg stays a surprise. */
      targetName: string | null
      /** A legendary egg: drawn with a star. */
      legendary: boolean
    }
  | {
      kind: 'mon'
      id: number
      name: string
      level: number
      /** XP gained into the current level, and the span to the next. */
      into: number
      need: number
      fraction: number
      pending: number
      compacts: number
      next: { name: string; level: number; compactsNeeded: number } | null
      legendary: boolean
    }

function entryProgress(entry: Entry, pending: number, dex: Dex): Progress {
  const sp = speciesOf(entry, dex)
  if (!sp) {
    const h = eggHatchLevel(entry, dex)
    const level = eggLevel(entry.xp, h)
    const lo = eggXpAt(level, h)
    const hi = level >= h ? lo : eggXpAt(level + 1, h)
    const chosen = entry.chosen && entry.target !== null ? find(dex, entry.target) : undefined
    return {
      kind: 'egg',
      stage: entry.eggStage,
      level,
      xp: entry.xp,
      into: Math.max(0, entry.xp - lo),
      need: hi - lo,
      fraction: hi > lo ? clamp((entry.xp - lo) / (hi - lo), 0, 1) : 1,
      pending,
      targetName: chosen?.name ?? null,
      legendary: entry.origin === 'legendary',
    }
  }
  const table = dex.growth[sp.growthRate]
  const level = levelOf(entry.xp, sp.growthRate, dex.growth)
  const lo = table[level] ?? 0
  const hi = level >= MAX_LEVEL ? lo : (table[level + 1] ?? lo)
  const next = entryNext(entry, dex)
  return {
    kind: 'mon',
    id: sp.id,
    name: sp.name,
    level,
    into: Math.max(0, entry.xp - lo),
    need: hi - lo,
    fraction: hi > lo ? clamp((entry.xp - lo) / (hi - lo), 0, 1) : 1,
    pending,
    compacts: entry.compacts,
    next: next ? { name: next.to.name, level: next.level, compactsNeeded: next.compactsNeeded } : null,
    legendary: sp.legendary,
  }
}

/** The active entry's progress, with the shared pending bank. */
export function progress(save: Save, dex: Dex): Progress {
  return entryProgress(activeEntry(save), save.pending, dex)
}

export type Overview = { boxCount: number; milestone: number; goal: number }

export function overview(save: Save): Overview {
  return { boxCount: save.box.length, milestone: save.milestone, goal: MILESTONE_COMPACTS }
}

// ---------- dex ----------

export type DexRow = {
  id: number
  earned: boolean
  /** The species name once earned, `???` before. */
  name: string
  lore: string
  goal: string
  /** Mewtwo before all three birds. */
  locked: boolean
  progress: { n: number; goal: number } | null
}

export type DexView = {
  caught: number
  total: number
  legendsOwned: number
  legendsTotal: number
  rows: DexRow[]
}

/** The catalog: caught species, and one row per legendary (Mew only once owned). */
export function dexView(save: Save, dex: Dex, cfg: Pick<Config, 'dangerPercent'>): DexView {
  const has = (id: number) => save.legendsEarned.includes(id)
  const name = (id: number) => (has(id) ? (find(dex, id)?.name ?? '???') : '???')
  const birds = BIRDS.every(has)
  const lines = save.lifetime.fullLines
  const row = (id: number, lore: string, goal: string, n: number, g: number, locked = false): DexRow => ({
    id,
    earned: has(id),
    name: name(id),
    lore,
    goal,
    locked: locked && !has(id),
    // A counter at its goal is granted in the same step; the display never shows it full unearned.
    progress: locked && !has(id) ? null : { n: has(id) ? g : Math.min(n, g - 1), goal: g },
  })
  const rows: DexRow[] = [
    row(ARTICUNO, 'Frozen bird of legend', `Stay cool: ${COOL_DAYS_GOAL} days without reaching ${cfg.dangerPercent}% context`, save.streaks.coolDays, COOL_DAYS_GOAL),
    row(ZAPDOS, 'Storm bird of legend', `Strike first: ${STRIKE_GOAL} compacts in a row before an auto-compact`, save.streaks.strike, STRIKE_GOAL),
    row(MOLTRES, 'Phoenix bird of legend', `Rebirth: fully evolve ${FULL_LINES_BIRD} lines`, lines, FULL_LINES_BIRD),
    row(MEWTWO, 'Born in a lab from a legend’s DNA', `Needs all three birds, then ${FULL_LINES_MEWTWO} fully evolved lines`, lines, FULL_LINES_MEWTWO, !birds),
  ]
  if (has(MEW)) {
    rows.push({ id: MEW, earned: true, name: name(MEW), lore: 'The one nobody listed', goal: 'Found', locked: false, progress: null })
  }
  return {
    caught: save.dex.length,
    total: dex.species.length,
    legendsOwned: [...BIRDS, MEWTWO, MEW].filter(has).length,
    legendsTotal: has(MEW) ? 5 : 4,
    rows,
  }
}

export function dexHeader(v: DexView): string {
  return `Dex ${v.caught}/${v.total} · ★ ${v.legendsOwned}/${v.legendsTotal}`
}

/** The dex as plain rows (header first), for chat and the terminal. */
export function dexText(save: Save, dex: Dex, cfg: Pick<Config, 'dangerPercent'>): string {
  const v = dexView(save, dex, cfg)
  const rows = v.rows.map(r => {
    const state = r.earned ? 'earned' : r.locked ? 'locked' : `${r.progress!.n}/${r.progress!.goal}`
    return `${r.earned ? '★ ' : ''}${r.name} · ${r.lore} · ${r.goal} · ${state}`
  })
  return [dexHeader(v), ...rows].join('\n')
}

// ---------- projection ----------

function dayNumber(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)
}

/** Average raw XP banked per day over the last 7 days of history, or null with none. */
function averageDaily(save: Save, today: string): number | null {
  const end = dayNumber(today)
  if (end === null) return null
  let sum = 0
  let earliest = end
  for (const [k, v] of Object.entries(save.daily)) {
    const n = dayNumber(k)
    if (n === null || n > end || n < end - 6) continue
    sum += v
    earliest = Math.min(earliest, n)
  }
  if (sum <= 0) return null
  return sum / Math.min(7, end - earliest + 1)
}

/** Whole days until the active Pokémon's next evolution at the recent pace; null for eggs or if unknowable. */
export function projectDays(save: Save, dex: Dex, today: string): number | null {
  const entry = activeEntry(save)
  const sp = speciesOf(entry, dex)
  if (!sp) return null
  const avg = averageDaily(save, today)
  if (avg === null) return null
  const next = entryNext(entry, dex)
  if (!next) return null
  const left = (dex.growth[sp.growthRate][next.level] ?? 0) - entry.xp
  if (left <= 0) return 0
  return Math.ceil(left / (avg * dragFactor(sp)) - 1e-9)
}

// ---------- commands ----------

export type CommandResult = {
  save: Save
  text: string
  show?: boolean
  hide?: boolean
  /** Open the in-band help. */
  hint?: boolean
  /** Open the in-band dex. */
  dex?: boolean
  /** The whole store should be wiped (reset-all). */
  wipe?: boolean
}

const USAGE =
  'Usage: /clawd-mon [show|hide|hint|dex|status|box|switch <name|#>|release <name|#> confirm|choose <name>|branch <name>|reset-all confirm]'

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/♀/g, 'f')
    .replace(/♂/g, 'm')
    .replace(/[^a-z0-9]/g, '')
}

function byName(dex: Dex, name: string, within?: Species[]): Species | undefined {
  const want = slug(name)
  if (want === '') return undefined
  return (within ?? dex.species).find(s => s.name && slug(s.name) === want)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "Bulbasaur Lv 12", "Egg Lv 3", "Egg Lv 3 (Bulbasaur)" when the player chose it. */
function entryLabel(entry: Entry, dex: Dex): string {
  const p = entryProgress(entry, 0, dex)
  const star = p.legendary ? ' ★' : ''
  if (p.kind === 'egg') return `Egg Lv ${p.level}${p.targetName ? ` (${p.targetName})` : ''}${star}`
  return `${p.name} Lv ${p.level}${star}`
}

/** The box as text: number, active marker, label. */
export function boxText(save: Save, dex: Dex): string {
  const rows = save.box.map(
    (e, i) => `${i + 1}. ${e.id === save.activeId ? '*' : ' '} ${entryLabel(e, dex)}`,
  )
  return [`Box (${save.box.length}), * = active:`, ...rows].join('\n')
}

function statusText(save: Save, dex: Dex, day: string): string {
  const entry = activeEntry(save)
  const p = progress(save, dex)
  const lines: string[] = []
  lines.push(`Active: ${entryLabel(entry, dex)}. XP ${Math.floor(p.into)}/${Math.floor(p.need)} to the next level.`)
  if (p.kind === 'mon') {
    if (p.next) {
      lines.push(
        `Next: ${p.next.name} at Lv ${p.next.level} with ${p.next.compactsNeeded} qualifying compacts (have ${p.compacts}).`,
      )
      const days = projectDays(save, dex, day)
      if (days !== null) lines.push(`About ${plural(days, 'day')} to evolution at the recent pace.`)
    } else {
      lines.push('Fully evolved.')
    }
  }
  lines.push(`Pending ${Math.floor(p.pending)} XP; compact to apply it.`)
  lines.push(`Box: ${save.box.length}. Next egg: ${save.milestone}/${MILESTONE_COMPACTS} counted compacts.`)
  const t = save.lifetime
  lines.push(
    `Lifetime: ${Math.round(t.tokens / 1000)}k tokens, ${Math.floor(t.xp)} XP, ${t.compacts} qualifying compacts, ${t.hatches} hatched, ${t.evolutions} evolutions.`,
  )
  return lines.join('\n')
}

/** Finds a box entry by 1-based number ("2", "#2") or by name ("pikachu", "egg"). */
function findEntry(save: Save, dex: Dex, query: string): Entry | undefined {
  const q = query.trim()
  if (/^#?\d+$/.test(q)) return save.box[Number(q.replace('#', '')) - 1]
  const want = slug(q)
  if (want === '') return undefined
  const hits = save.box.filter(e => {
    if (e.phase === 'egg') return want === 'egg'
    const sp = speciesOf(e, dex)
    return sp !== undefined && slug(sp.name) === want
  })
  return hits.find(e => e.id !== save.activeId) ?? hits[0]
}

export function execute(
  save: Save,
  dex: Dex,
  args: string,
  ctx: { day: string; rng?: () => number; cfg?: Pick<Config, 'dangerPercent'> },
): CommandResult {
  const rng = ctx.rng ?? Math.random
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? 'show').toLowerCase()
  const rest = parts.slice(1)
  const confirmed = rest.length > 0 && rest[rest.length - 1]!.toLowerCase() === 'confirm'
  const nameParts = confirmed ? rest.slice(0, -1) : rest
  const name = nameParts.join(' ')
  const entry = activeEntry(save)

  switch (sub) {
    case 'show':
      return { save, text: 'Clawd-mon shown.', show: true }
    case 'hide':
      return { save, text: 'Clawd-mon hidden. /clawd-mon show brings it back.', hide: true }
    case 'hint':
      return { save, text: 'Help is open in the band.', show: true, hint: true }
    case 'dex':
      return { save, text: dexText(save, dex, ctx.cfg ?? DEFAULT_CONFIG), show: true, dex: true }
    case 'status':
      return { save, text: statusText(save, dex, ctx.day), show: true }
    case 'box':
      return { save, text: boxText(save, dex) }
    case 'switch': {
      if (name === '') return { save, text: 'Usage: /clawd-mon switch <name|#>. See /clawd-mon box.' }
      const target = findEntry(save, dex, name)
      if (!target) return { save, text: `Nothing in the box matches "${name}". See /clawd-mon box.` }
      if (target.id === save.activeId) return { save, text: `${entryLabel(target, dex)} is already active.` }
      return { save: { ...save, activeId: target.id }, text: `Active: ${entryLabel(target, dex)}.` }
    }
    case 'release': {
      if (name === '') return { save, text: 'Usage: /clawd-mon release <name|#> confirm. See /clawd-mon box.' }
      const target = findEntry(save, dex, name)
      if (!target) return { save, text: `Nothing in the box matches "${name}". See /clawd-mon box.` }
      const label = entryLabel(target, dex)
      if (!confirmed) {
        return { save, text: `This removes ${label} for good. Run /clawd-mon release ${name} confirm to proceed.` }
      }
      let box = save.box.filter(e => e.id !== target.id)
      let activeId = save.activeId
      let text = `Released ${label}.`
      if (box.length === 0) {
        const fresh = newEntry(nextId(save.box), 'starter', pickStarter(dex, rng).id)
        box = [fresh]
        activeId = fresh.id
        text += ' The box was empty: a new egg is active.'
      } else if (target.id === save.activeId) {
        activeId = box[0]!.id
        text += ` Active: ${entryLabel(box[0]!, dex)}.`
      }
      return { save: { ...save, box, activeId }, text }
    }
    case 'choose': {
      if (name === '') return { save, text: 'Usage: /clawd-mon choose <name>. Name any Gen 1 species; its first stage is used.' }
      if (entry.origin !== 'starter' || entry.phase !== 'egg' || save.lifetime.hatches > 0) {
        return { save, text: 'Choosing is only for the starter egg, before anything has hatched. Use /clawd-mon reset-all confirm to start over.' }
      }
      const found = byName(dex, name)
      if (!found) return { save, text: `Unknown species "${name}".` }
      const first = root(dex, found)
      if (first.legendary) return { save, text: `${first.name} is legendary and can't be chosen.` }
      return {
        save: setEntry(save, { ...entry, target: first.id, chosen: true }),
        text: `The egg will hatch into ${first.name}.`,
      }
    }
    case 'branch': {
      const sp = speciesOf(entry, dex)
      if (!sp) return { save, text: 'Nothing to branch yet: hatch the egg first.' }
      const options = sp.evolutions.map(e => find(dex, e.to)).filter((x): x is Species => x !== undefined)
      if (options.length < 2) return { save, text: `${sp.name} has only one evolution, no choice to make.` }
      const list = options.map(o => o.name).join(', ')
      const pick = byName(dex, name, options)
      if (!pick) return { save, text: `${name === '' ? 'No name given' : `"${name}" is not an evolution of ${sp.name}`}. Options: ${list}.` }
      return { save: setEntry(save, { ...entry, branch: pick.id }), text: `${sp.name} will evolve into ${pick.name}.` }
    }
    case 'reset':
      return { save, text: 'reset is gone. Use /clawd-mon release <name|#> confirm for one entry, or /clawd-mon reset-all confirm for everything.' }
    case 'reset-all':
      if (!confirmed) {
        return {
          save,
          text: 'This wipes everything: the whole box, lifetime totals, history, settings. Run /clawd-mon reset-all confirm to start fresh.',
        }
      }
      return { save: ensureTarget(newSave(), dex, rng), text: 'Fresh start. Everything wiped; a new egg is waiting.', wipe: true, show: true }
    default:
      return { save, text: USAGE }
  }
}
