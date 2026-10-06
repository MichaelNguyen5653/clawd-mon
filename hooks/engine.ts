// Clawd-mon engine: pure rules, no engine `$`, no I/O. Everything the band and the
// hooks do to the save goes through here so it can be unit-tested.
//
// Model: tokens you spend bank as `pending` XP. A compact applies the bank
// (manual or plugin: all of it, auto: half, the rest is forfeited). Decay eats
// pending while the context is dangerously full. Level comes from the species'
// growth table with a base-stat-total drag; evolution needs a level and a
// number of qualifying compacts.

import type { ClawdMonLifetime, ClawdMonSave } from '../types'

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

/** The save; its shape is the plugin's state contract in types/index.d.ts. */
export type Save = ClawdMonSave

export type GameEvent =
  | { kind: 'levelup'; level: number }
  | { kind: 'crack'; stage: number }
  | { kind: 'hatch'; speciesId: number }
  | { kind: 'evolve'; from: number; to: number }

export type CompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'

export const DEFAULT_CONFIG: Config = { xpRate: 1, recommendPercent: 60, dangerPercent: 80 }

/** Applied egg XP needed for crack 1, crack 2, hatch. */
export const EGG_XP = [800, 1800, 3000] as const
/** A compact counts toward gates only at or above this context percent. */
export const QUALIFY_PERCENT = 40
/** Qualifying compacts since hatch for the first and second evolution. */
export const EVOLVE_COMPACTS = [3, 8] as const
export const HATCH_LEVEL = 5
export const AUTO_SHARE = 0.5
export const DECAY_PER_TURN = 0.02
export const ITEM_EVOLVE_LEVEL = 30
export const TRADE_EVOLVE_LEVEL = 36
const HISTORY_DAYS = 14
const GROWTH_SAMPLES = 5
const PROJECT_TURNS = 3
const MAX_LEVEL = 100

// ---------- save and config ----------

export function newSave(): Save {
  return {
    v: 1,
    rev: 0,
    phase: 'egg',
    eggStage: 0,
    target: null,
    speciesId: null,
    xp: 0,
    pending: 0,
    compacts: 0,
    branch: null,
    lifetime: { tokens: 0, xp: 0, compacts: 0, hatches: 0, evolutions: 0 },
    daily: {},
    growth: [],
    lastContext: null,
  }
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

/** Reads whatever the store held into a valid save; junk becomes a fresh egg. */
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
  const save: Save = {
    ...base,
    rev: Math.max(0, Math.floor(num(raw.rev, 0))),
    phase: raw.phase === 'mon' ? 'mon' : 'egg',
    eggStage: raw.eggStage === 1 || raw.eggStage === 2 ? raw.eggStage : 0,
    target: id(raw.target),
    speciesId: id(raw.speciesId),
    xp: Math.max(0, num(raw.xp, 0)),
    pending: Math.max(0, num(raw.pending, 0)),
    compacts: Math.max(0, Math.floor(num(raw.compacts, 0))),
    branch: id(raw.branch),
    lifetime: {
      tokens: Math.max(0, num(life.tokens, 0)),
      xp: Math.max(0, num(life.xp, 0)),
      compacts: Math.max(0, num(life.compacts, 0)),
      hatches: Math.max(0, num(life.hatches, 0)),
      evolutions: Math.max(0, num(life.evolutions, 0)),
    },
    daily: trimDaily(daily),
    growth: Array.isArray(raw.growth)
      ? raw.growth.filter((n): n is number => typeof n === 'number' && n > 0 && Number.isFinite(n)).slice(-GROWTH_SAMPLES)
      : [],
    lastContext: typeof raw.lastContext === 'number' && Number.isFinite(raw.lastContext) ? raw.lastContext : null,
  }
  if (save.target !== null && !find(dex, save.target)) save.target = null
  if (save.phase === 'mon' && (save.speciesId === null || !find(dex, save.speciesId))) {
    return { ...base, lifetime: save.lifetime, daily: save.daily }
  }
  if (save.phase === 'egg') save.speciesId = null
  return save
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

function root(dex: Dex, s: Species): Species {
  let cur = s
  for (let i = 0; i < 5 && cur.evolvesFrom !== null; i++) {
    const parent = find(dex, cur.evolvesFrom)
    if (!parent) break
    cur = parent
  }
  return cur
}

function current(save: Save, dex: Dex): Species | undefined {
  return save.phase === 'mon' && save.speciesId !== null ? find(dex, save.speciesId) : undefined
}

export type NextEvolution = { to: Species; level: number; compactsNeeded: number }

/** The evolution the mon is working toward, or null at the end of its line. */
export function nextEvolution(save: Save, dex: Dex): NextEvolution | null {
  const s = current(save, dex)
  if (!s || s.evolutions.length === 0) return null
  const chosen = save.branch !== null ? s.evolutions.find(e => e.to === save.branch) : undefined
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

/**
 * Applies the bank for a finished compact. `percent` is the context percent just
 * before it ran (a compact below QUALIFY_PERCENT still pays XP but counts for no gate).
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

  let s: Save = {
    ...save,
    pending: 0,
    lifetime: {
      ...save.lifetime,
      xp: save.lifetime.xp + raw,
      compacts: save.lifetime.compacts + (qualifies ? 1 : 0),
    },
    growth: [],
    lastContext: null,
    compacts: save.compacts + (qualifies ? 1 : 0),
  }

  if (s.phase === 'egg') {
    s.xp = save.xp + raw
    if (qualifies && s.xp >= EGG_XP[s.eggStage]) {
      if (s.eggStage === 2) {
        s = hatch(s, dex, rng)
        events.push({ kind: 'hatch', speciesId: s.speciesId! })
      } else {
        s.eggStage = (s.eggStage + 1) as 1 | 2
        events.push({ kind: 'crack', stage: s.eggStage })
      }
    }
    return { save: s, events }
  }

  const sp = current(s, dex)
  if (!sp) return { save: s, events }
  const before = levelOf(save.xp, sp.growthRate, dex.growth)
  s.xp = save.xp + raw * dragFactor(sp)
  const after = levelOf(s.xp, sp.growthRate, dex.growth)
  if (after > before) events.push({ kind: 'levelup', level: after })

  const next = nextEvolution(s, dex)
  if (next && after >= next.level && s.compacts >= next.compactsNeeded) {
    s = {
      ...s,
      speciesId: next.to.id,
      branch: null,
      lifetime: { ...s.lifetime, evolutions: s.lifetime.evolutions + 1 },
    }
    events.push({ kind: 'evolve', from: sp.id, to: next.to.id })
  }
  return { save: s, events }
}

function hatch(save: Save, dex: Dex, rng: () => number): Save {
  let sp = save.target !== null ? find(dex, save.target) : undefined
  if (!sp) {
    const pool = dex.species.filter(x => x.stage === 0 && !x.legendary)
    const list = pool.length > 0 ? pool : dex.species
    sp = list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!
  }
  return startMon(save, dex, sp)
}

function startMon(save: Save, dex: Dex, sp: Species): Save {
  return {
    ...save,
    phase: 'mon',
    eggStage: 0,
    target: null,
    speciesId: sp.id,
    xp: dex.growth[sp.growthRate][HATCH_LEVEL] ?? 0,
    compacts: 0,
    branch: null,
    lifetime: { ...save.lifetime, hatches: save.lifetime.hatches + 1 },
  }
}

// ---------- view model ----------

export type Progress =
  | {
      kind: 'egg'
      stage: number
      cracks: number
      xp: number
      nextXp: number
      fraction: number
      pending: number
      targetName: string | null
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
    }

export function progress(save: Save, dex: Dex): Progress {
  const sp = current(save, dex)
  if (!sp) {
    const nextXp = EGG_XP[save.eggStage]
    const floor = save.eggStage === 0 ? 0 : EGG_XP[save.eggStage - 1]!
    return {
      kind: 'egg',
      stage: save.eggStage,
      cracks: EGG_XP.length,
      xp: save.xp,
      nextXp,
      fraction: clamp((save.xp - floor) / (nextXp - floor), 0, 1),
      pending: save.pending,
      targetName: save.target !== null ? (find(dex, save.target)?.name ?? null) : null,
    }
  }
  const table = dex.growth[sp.growthRate]
  const level = levelOf(save.xp, sp.growthRate, dex.growth)
  const lo = table[level] ?? 0
  const hi = level >= MAX_LEVEL ? lo : (table[level + 1] ?? lo)
  const next = nextEvolution(save, dex)
  return {
    kind: 'mon',
    id: sp.id,
    name: sp.name,
    level,
    into: Math.max(0, save.xp - lo),
    need: hi - lo,
    fraction: hi > lo ? clamp((save.xp - lo) / (hi - lo), 0, 1) : 1,
    pending: save.pending,
    compacts: save.compacts,
    next: next ? { name: next.to.name, level: next.level, compactsNeeded: next.compactsNeeded } : null,
  }
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

/** Whole days until the next evolution (or hatch, for an egg) at the recent pace; null if unknowable. */
export function projectDays(save: Save, dex: Dex, today: string): number | null {
  const avg = averageDaily(save, today)
  if (avg === null) return null
  const sp = current(save, dex)
  if (!sp) {
    const left = EGG_XP[2] - save.xp
    return left <= 0 ? 0 : Math.ceil(left / avg - 1e-9)
  }
  const next = nextEvolution(save, dex)
  if (!next) return null
  const left = (dex.growth[sp.growthRate][next.level] ?? 0) - save.xp
  if (left <= 0) return 0
  return Math.ceil(left / (avg * dragFactor(sp)) - 1e-9)
}

// ---------- commands ----------

export type CommandResult = {
  save: Save
  text: string
  show?: boolean
  hide?: boolean
  /** The whole store should be wiped (reset-all). */
  wipe?: boolean
}

const USAGE =
  'Usage: /clawd-mon [show|hide|status|choose <name> [confirm]|branch <name>|reset|reset-all confirm]'

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
  return (within ?? dex.species).find(s => slug(s.name) === want)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function statusText(save: Save, dex: Dex, day: string): string {
  const p = progress(save, dex)
  const days = projectDays(save, dex, day)
  const lines: string[] = []
  if (p.kind === 'egg') {
    lines.push(`Egg, crack ${p.stage}/${p.cracks}. XP ${Math.floor(p.xp)}/${p.nextXp} for the next stage; each stage also needs a qualifying compact.`)
    if (p.targetName) lines.push(`Starter: ${p.targetName}.`)
    if (days !== null) lines.push(`About ${plural(days, 'day')} to hatch at the recent pace.`)
  } else {
    lines.push(`${p.name} Lv ${p.level}. XP ${Math.floor(p.into)}/${Math.floor(p.need)} to the next level.`)
    if (p.next) {
      lines.push(
        `Next: ${p.next.name} at Lv ${p.next.level} with ${p.next.compactsNeeded} qualifying compacts (have ${p.compacts}).`,
      )
      if (days !== null) lines.push(`About ${plural(days, 'day')} to evolution at the recent pace.`)
    } else {
      lines.push('Fully evolved.')
    }
  }
  lines.push(`Pending ${Math.floor(p.pending)} XP; compact to apply it.`)
  const t = save.lifetime
  lines.push(
    `Lifetime: ${Math.round(t.tokens / 1000)}k tokens, ${Math.floor(t.xp)} XP, ${t.compacts} qualifying compacts, ${t.hatches} hatched, ${t.evolutions} evolutions.`,
  )
  return lines.join('\n')
}

export function execute(
  save: Save,
  dex: Dex,
  args: string,
  ctx: { day: string; rng?: () => number },
): CommandResult {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? 'show').toLowerCase()
  const rest = parts.slice(1)
  const confirmed = rest.length > 0 && rest[rest.length - 1]!.toLowerCase() === 'confirm'
  const nameParts = confirmed ? rest.slice(0, -1) : rest
  const name = nameParts.join(' ')

  switch (sub) {
    case 'show':
      return { save, text: 'Clawd-mon shown.', show: true }
    case 'hide':
      return { save, text: 'Clawd-mon hidden. /clawd-mon show brings it back.', hide: true }
    case 'status':
      return { save, text: statusText(save, dex, ctx.day), show: true }
    case 'choose': {
      if (name === '') return { save, text: 'Usage: /clawd-mon choose <name>. Name any Gen 1 species; its first stage is used.' }
      const found = byName(dex, name)
      if (!found) return { save, text: `Unknown species "${name}".` }
      const first = root(dex, found)
      if (save.phase === 'egg') {
        return { save: { ...save, target: first.id }, text: `The egg will hatch into ${first.name}.` }
      }
      if (!confirmed) {
        return {
          save,
          text: `This replaces your companion with ${first.name} at Lv ${HATCH_LEVEL}. Run /clawd-mon choose ${name} confirm to proceed.`,
        }
      }
      return { save: startMon(save, dex, first), text: `${first.name} is your companion now (Lv ${HATCH_LEVEL}).` }
    }
    case 'branch': {
      const sp = current(save, dex)
      if (!sp) return { save, text: 'Nothing to branch yet: hatch the egg first.' }
      const options = sp.evolutions.map(e => find(dex, e.to)).filter((x): x is Species => x !== undefined)
      if (options.length < 2) return { save, text: `${sp.name} has only one evolution, no choice to make.` }
      const list = options.map(o => o.name).join(', ')
      const pick = byName(dex, name, options)
      if (!pick) return { save, text: `${name === '' ? 'No name given' : `"${name}" is not an evolution of ${sp.name}`}. Options: ${list}.` }
      return { save: { ...save, branch: pick.id }, text: `${sp.name} will evolve into ${pick.name}.` }
    }
    case 'reset':
      return {
        save: {
          ...newSave(),
          lifetime: save.lifetime,
          daily: save.daily,
          growth: save.growth,
          lastContext: save.lastContext,
        },
        text: 'Companion reset to an egg. Pending XP and the chosen starter are cleared; lifetime totals kept.',
      }
    case 'reset-all':
      if (!confirmed) {
        return {
          save,
          text: 'This wipes everything: companion, lifetime totals, history, settings. Run /clawd-mon reset-all confirm to start fresh.',
        }
      }
      return { save: newSave(), text: 'Fresh start. Everything wiped; a new egg is waiting.', wipe: true, show: true }
    default:
      return { save, text: USAGE }
  }
}
