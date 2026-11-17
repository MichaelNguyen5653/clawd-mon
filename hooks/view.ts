// Clawd-mon view helpers: the text and SVG the band shows. Pure, with type-only imports,
// so plain Node can load this file (tools/preview.mjs) as well as the plugin.

import type { ClawdMonActivity, ClawdMonAgent, ClawdMonAgents, ClawdMonTools, ClawdMonUsage } from '../types'
import type { Config, Dex, DexRow, DexView, GameEvent, Overview, Progress, Rarity, Recommendation } from './engine'

export const GREEN = '#4CAF50'
export const AMBER = '#E0A030'
export const RED = '#E5534B'
export const TRACK = '#80808040'
/** Where the Evolve button was: a compact is how the companion grows. */
export const COMPACT_HINT = '/compact to level up'
/** Banner fill per tier; white text on each stays readable. */
export const RARITY_COLOR: Record<Rarity, string> = {
  starter: '#C2410C',
  common: '#6B7280',
  uncommon: '#2E7D32',
  rare: '#1D4ED8',
  legendary: '#A16207',
}

export function rarityLabel(r: Rarity): string {
  return r[0]!.toUpperCase() + r.slice(1)
}
/** Sprite PNGs are drawn on a square canvas of this many pixels. */
export const CANVAS_PX = 96

export type Box = readonly [x: number, y: number, w: number, h: number]

// ---------- numbers and text ----------

function trim(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** 23000 -> "23K", 124300 -> "124.3K", 1000000 -> "1M", 1500000 -> "1.5M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) {
    const k = trim((n / 1000).toFixed(1))
    return k === '1000' ? '1M' : `${k}K`
  }
  return String(Math.round(n))
}

export function contextLine(usage: ClawdMonUsage | null): string {
  if (usage === null) return 'Context: no reading yet'
  const window = usage.window > 0 ? formatTokens(usage.window) : '—'
  if (usage.percent === undefined || usage.tokens === undefined) return `Context n/a · — / ${window}`
  return `Context ${usage.percent}% · ${formatTokens(usage.tokens)} / ${window}`
}

export function toolsLabel(t: ClawdMonTools): string {
  const avail = t.available === null ? 'n/a' : String(t.available)
  const mcp = t.available !== null && t.mcp > 0 ? ` (${t.mcp} MCP)` : ''
  return `Tools ${avail} avail${mcp} · ${t.usedNames.length} used · ${t.calls} calls`
}

export function agentsLabel(a: ClawdMonAgents): string {
  if (a.running === null || a.total === null) return 'Agents n/a'
  return `Agents ${a.running} running · ${a.total} spawned`
}

/** The one-line session readout: context, agents, tools. */
export function statsLine(usage: ClawdMonUsage | null, tools: ClawdMonTools, agents: ClawdMonAgents): string {
  return [contextLine(usage), agentsLabel(agents), toolsLabel(tools)].join(' · ')
}

export function contextColor(percent: number | undefined, cfg: Pick<Config, 'recommendPercent' | 'dangerPercent'>): string {
  if (percent === undefined) return GREEN
  if (percent >= cfg.dangerPercent) return RED
  if (percent >= cfg.recommendPercent) return AMBER
  return GREEN
}

export function textBar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function titleOf(p: Progress): string {
  const star = p.legendary ? ' ★' : ''
  if (p.kind === 'egg') return `Egg Lv ${p.level}${p.targetName ? ` (${p.targetName})` : ''}${star}`
  return `${p.name} Lv ${p.level}${star}${p.aura > 0 ? ` ${'✦'.repeat(p.aura)}` : ''}`
}

export function xpLine(p: Progress): string {
  if (p.kind === 'egg') {
    // Full: only a counted compact moves it on now. Which stage comes next stays a surprise.
    return p.need > 0 ? `XP ${Math.floor(p.into)}/${Math.floor(p.need)}` : 'Ready to evolve'
  }
  return `XP ${Math.floor(p.into)}/${Math.floor(p.need)}`
}

export function pendingLine(p: Progress): string {
  const pending = `Pending +${Math.floor(p.pending)} XP`
  if (p.kind === 'egg') return pending
  if (!p.next) return `${pending}, fully evolved`
  return `${pending}, ${p.compacts}/${p.next.compactsNeeded} compacts for ${p.next.name} (Lv ${p.next.level})`
}

/** The advice row under the bars; '' when there is nothing to say. */
export function adviceLine(
  rec: Recommendation,
  usage: ClawdMonUsage | null,
  cfg: Pick<Config, 'dangerPercent'>,
): string {
  if (!rec.recommend) return ''
  const percent = usage?.percent
  if (percent !== undefined && percent >= cfg.dangerPercent) {
    return `/compact recommended: pending XP decays 2% a turn at ${percent}%`
  }
  if (rec.reason === 'projected') return '/compact recommended: context is filling fast'
  return `/compact recommended: context at ${percent}%`
}

export function eventToast(ev: GameEvent, dex: Dex): string {
  const name = (id: number) => dex.species.find(s => s.id === id)?.name ?? `#${id}`
  switch (ev.kind) {
    case 'levelup':
      return `Level up: Lv ${ev.level}`
    case 'crack':
      return 'The egg is cracking'
    case 'egg':
      return 'A new egg arrived — /clawd-mon switch to hatch it'
    case 'legend':
      return 'A legendary egg arrived ★ — /clawd-mon switch to hatch it'
    case 'hatch':
      return `The egg hatched: ${name(ev.speciesId)} (${rarityLabel(ev.rarity)})!`
    case 'evolve':
      return `${name(ev.from)} evolved into ${name(ev.to)}!`
    case 'aura':
      return `The aura grows ${'✦'.repeat(ev.tier)}`
  }
}

/** Dim row beside the title: progress to the next bonus egg, and the box size once it holds more than one. */
export function milestoneLine(o: Overview): string {
  return `New egg (${o.milestone}/${o.goal})${o.boxCount > 1 ? ` · Box ${o.boxCount}` : ''}`
}

// ---------- actions tab ----------

const CONTEXT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'ToolSearch'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
/** Agent statuses that still get a row. */
const LIVE = new Set<ClawdMonAgent['status']>(['pending', 'running', 'waiting', 'idle'])

/** A tool call in flight, as a few words of what the loop is doing. */
export function activityLabel(tool: string, skill?: string): string {
  if (tool === 'Skill') return `Using ${skill || 'a'} skill`
  if (CONTEXT_TOOLS.has(tool)) return 'Gathering context'
  if (EDIT_TOOLS.has(tool)) return 'Editing files'
  if (SHELL_TOOLS.has(tool)) return 'Running commands'
  if (WEB_TOOLS.has(tool) || tool.startsWith('mcp__')) return 'Researching'
  if (tool === 'Agent' || tool === 'Task') return 'Delegating to agents'
  if (PLAN_TOOLS.has(tool)) return 'Planning'
  return `Using ${tool}`
}

function clip(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1)).trimEnd()}…`
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s
}

/**
 * The Actions tab: "Current action - ..." then one row per live agent, at most `budget` rows,
 * each clipped to `width`. Agents past the budget fold into "(+N more)" on the last row.
 */
export function actionsRows(act: ClawdMonActivity, agents: ClawdMonAgent[], budget: number, width: number): string[] {
  const live = agents.filter(a => LIVE.has(a.status))
  const waitingOn = (id: string) => {
    const n = live.findIndex(a => a.id === id) + 1
    return n > 0 ? `Waiting on Agent ${n}` : 'Waiting on an agent'
  }
  const own = act.doing['']
  const main =
    act.task ?? (own?.waitingOn ? waitingOn(own.waitingOn) : own ? activityLabel(own.tool, own.skill) : act.busy ? 'Thinking' : 'Idle')
  const agentRow = (a: ClawdMonAgent, i: number) => {
    const d = act.doing[a.id]
    const what = d?.waitingOn
      ? waitingOn(d.waitingOn)
      : d?.tool === 'Skill'
        ? `${activityLabel('Skill', d.skill)}${a.description ? ` to ${lowerFirst(a.description)}` : ''}`
        : d
          ? `${activityLabel(d.tool)}${a.description ? ` · ${a.description}` : ''}`
          : a.status === 'idle' || a.status === 'waiting'
            ? 'Waiting'
            : a.status === 'pending'
              ? 'Starting'
              : a.description || 'Working'
    return `Agent ${i + 1} - ${a.name ? `${a.name} - ` : ''}${what}`
  }
  const rows = [`Current action - ${main}`, ...live.map(agentRow)]
  const keep = Math.max(1, budget)
  if (rows.length <= keep) return rows.map(r => clip(r, width))
  const more = ` (+${rows.length - keep} more)`
  return rows.slice(0, keep).map((r, i) => (i === keep - 1 ? `${clip(r, width - more.length)}${more}` : clip(r, width)))
}

// ---------- in-band help ----------

/** What the help says, without level spoilers. */
export function hintRules(cfg: Pick<Config, 'dangerPercent'>): string[] {
  return [
    '/compact to level up: it applies pending XP. Only compacts at 40%+ context count.',
    `Pending XP decays 2%/turn at ${cfg.dangerPercent}%+ context.`,
    'Only the active Pokémon or egg gains XP.',
    'New egg: fully evolve the active one, or every 15 counted compacts.',
  ]
}

export const HINT_COMMANDS: readonly string[] = [
  '/clawd-mon show: draw the band',
  '/clawd-mon hide: hide it (× too)',
  '/clawd-mon hint: open this help',
  '/clawd-mon dex: your catalog, legendaries included',
  '/clawd-mon status: active, box, totals',
  '/clawd-mon box: list your Pokémon and eggs',
  '/clawd-mon switch <name|#>: make one active',
  '/clawd-mon release <name|#> confirm: remove one',
  '/clawd-mon choose <name>: pick the starter egg (starter only)',
  '/clawd-mon branch <name>: pick an evolution',
  '/clawd-mon reset-all confirm: wipe everything',
]

/** All commands on one row, for tight spaces. */
export const HINT_COMMANDS_ONE_ROW =
  'show · hide · hint · dex · status · box · switch <name|#> · release <name|#> confirm · choose <name> (starter only) · branch <name> · reset-all confirm'

/**
 * The help rows that fit in `budget` rows (Cancel is drawn apart and always stays).
 * Roomy: rules, then one command per row. Tight: commands collapse to one row. Tighter: that
 * row comes first and rules are dropped from the end.
 */
export function hintRows(cfg: Pick<Config, 'dangerPercent'>, budget: number): string[] {
  const rules = hintRules(cfg)
  const full = [...rules, ...HINT_COMMANDS]
  if (budget >= full.length) return full
  const compact = [...rules, `Commands: ${HINT_COMMANDS_ONE_ROW}`]
  if (budget >= compact.length) return compact
  if (budget <= 0) return []
  return [`Commands: ${HINT_COMMANDS_ONE_ROW}`, ...rules].slice(0, budget)
}

// ---------- dex ----------

/** One legendary as a single text row, for chat and the terminal. */
export function dexRowLine(r: DexRow): string {
  const state = r.earned ? 'earned' : r.locked ? 'locked' : `${r.progress?.n ?? 0}/${r.progress?.goal ?? 0}`
  return `${r.earned ? '★ ' : ''}${r.name} · ${r.lore} · ${r.goal} · ${state}`
}

/** Header and counts line, then as many legendary rows as fit in `budget` rows (the first two always stay). */
export function dexRows(v: DexView, budget: number): string[] {
  const header = `Dex ${v.caught}/${v.total} · ★ ${v.legendsOwned}/${v.legendsTotal}`
  const counts =
    `Starters ${v.starters.n}/${v.starters.total} · Common ${v.common.n}/${v.common.total} · ` +
    `Uncommon ${v.uncommon.n}/${v.uncommon.total} · Rare ${v.rare.n}/${v.rare.total}`
  return [header, counts, ...v.rows.map(dexRowLine)].slice(0, Math.max(2, budget))
}

// ---------- sprite ----------

/** viewBox [x, y, side, side]: the content box padded to a square, plus 2 px a side. */
export function spriteViewBox(bounds: Box | null | undefined): [number, number, number, number] {
  if (!bounds) return [0, 0, CANVAS_PX, CANVAS_PX]
  const [x, y, w, h] = bounds
  const side = Math.max(w, h) + 4
  return [Math.round(x + w / 2 - side / 2), Math.round(y + h / 2 - side / 2), side, side]
}

/** The aura is laid out round a box this many times smaller than the sprite's viewBox, so it fits inside it. */
export const AURA_FIT = 1.4

/** The box the aura is laid out round: the viewBox square shrunk by AURA_FIT about its centre. */
function auraBox(bounds: Box | null | undefined): Box {
  const [vx, vy, side] = spriteViewBox(bounds)
  const inner = side / AURA_FIT
  return [vx + (side - inner) / 2, vy + (side - inner) / 2, inner, inner]
}

// ---------- aura ----------

export type AuraShape = 'dot' | 'bubble' | 'leaf' | 'spark' | 'flake' | 'ring' | 'streak' | 'diamond' | 'star' | 'wisp'
export type AuraMotion = 'rise' | 'fall' | 'drift' | 'flicker' | 'orbit' | 'pulse' | 'feet' | 'sway' | 'fade' | 'twinkle'
export type AuraTheme = { color: string; shape: AuraShape; motion: AuraMotion }

/** Aura look per type: the first type themes the glow and particles, the second tints half of the charged ones. */
export const AURA_THEMES: Record<string, AuraTheme> = {
  normal: { color: '#E8DFC0', shape: 'star', motion: 'twinkle' },
  fire: { color: '#FF7A1A', shape: 'dot', motion: 'rise' },
  water: { color: '#3B9BFF', shape: 'bubble', motion: 'rise' },
  grass: { color: '#4CC94C', shape: 'leaf', motion: 'drift' },
  electric: { color: '#FFD60A', shape: 'spark', motion: 'flicker' },
  ice: { color: '#9FE7FF', shape: 'flake', motion: 'fall' },
  fighting: { color: '#E0533D', shape: 'ring', motion: 'pulse' },
  poison: { color: '#B45CE6', shape: 'bubble', motion: 'rise' },
  ground: { color: '#D9A55B', shape: 'dot', motion: 'feet' },
  flying: { color: '#B9D7F2', shape: 'streak', motion: 'sway' },
  psychic: { color: '#FF6FB5', shape: 'ring', motion: 'orbit' },
  bug: { color: '#A6E22E', shape: 'dot', motion: 'orbit' },
  rock: { color: '#A8A29E', shape: 'diamond', motion: 'orbit' },
  ghost: { color: '#8B6FE8', shape: 'wisp', motion: 'fade' },
  dragon: { color: '#6D5BFF', shape: 'diamond', motion: 'orbit' },
  steel: { color: '#B8C4D0', shape: 'diamond', motion: 'twinkle' },
  fairy: { color: '#FFA6D9', shape: 'star', motion: 'twinkle' },
}
const GOLD = '#F5C542'

/** Seconds per loop of each motion. */
const MOTION_SECONDS: Record<AuraMotion, number> = {
  rise: 2.6, fall: 3.2, drift: 3.6, flicker: 1.2, orbit: 6, pulse: 2, feet: 1.6, sway: 2.4, fade: 3, twinkle: 1.8,
}

// Particle moves read their distance (--d) and orbit centre from inline style, so one keyframe set fits any sprite.
const AURA_CSS =
  '.au-halo{animation:au-breathe 3s ease-in-out infinite}' +
  '@keyframes au-breathe{0%,100%{opacity:.7}50%{opacity:1}}' +
  '.au-rise{animation:au-rise 2.6s linear infinite}' +
  '@keyframes au-rise{0%{transform:translate(0,0);opacity:0}25%{opacity:1}100%{transform:translate(0,var(--d));opacity:0}}' +
  '.au-fall{animation:au-fall 3.2s linear infinite}' +
  '@keyframes au-fall{0%{transform:translate(0,0);opacity:0}25%{opacity:1}100%{transform:translate(0,var(--d));opacity:0}}' +
  '.au-drift{animation:au-drift 3.6s ease-in-out infinite}' +
  '@keyframes au-drift{0%{transform:translate(0,0) rotate(0);opacity:0}25%{opacity:1}100%{transform:translate(var(--dx),var(--d)) rotate(90deg);opacity:0}}' +
  '.au-flicker{animation:au-flicker 1.2s steps(2) infinite}' +
  '@keyframes au-flicker{0%,100%{opacity:1}50%{opacity:.15}}' +
  '.au-orbit{animation:au-orbit 6s linear infinite}' +
  '@keyframes au-orbit{to{transform:rotate(360deg)}}' +
  '.au-pulse{transform-box:fill-box;transform-origin:center;animation:au-pulse 2s ease-out infinite}' +
  '@keyframes au-pulse{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.6);opacity:0}}' +
  '.au-feet{animation:au-feet 1.6s ease-in-out infinite}' +
  '@keyframes au-feet{0%,100%{transform:translate(0,0);opacity:.4}50%{transform:translate(0,var(--d));opacity:1}}' +
  '.au-sway{animation:au-sway 2.4s ease-in-out infinite}' +
  '@keyframes au-sway{0%{transform:translate(0,0);opacity:0}50%{opacity:1}100%{transform:translate(var(--d),0);opacity:0}}' +
  '.au-fade{animation:au-fade 3s ease-in-out infinite}' +
  '@keyframes au-fade{0%,100%{transform:translate(0,0);opacity:0}50%{transform:translate(0,var(--d));opacity:.9}}' +
  '.au-twinkle{transform-box:fill-box;transform-origin:center;animation:au-twinkle 1.8s ease-in-out infinite}' +
  '@keyframes au-twinkle{0%,100%{transform:scale(.4);opacity:.3}50%{transform:scale(1);opacity:1}}' +
  '.au-shoot{animation:au-shoot 6s linear infinite}' +
  '@keyframes au-shoot{0%{transform:translate(0,0);opacity:0}3%{opacity:1}22%,100%{transform:translate(var(--dx),var(--d));opacity:0}}' +
  '.au-sweep{animation:au-sweep 4s ease-in-out infinite}' +
  '@keyframes au-sweep{0%{transform:translate(0,0)}35%,100%{transform:translate(var(--dx),0)}}' +
  '@media (prefers-reduced-motion: reduce){.au-halo,.au-p{animation:none}.au-sweep{display:none}}'

const r1 = (n: number) => Math.round(n * 10) / 10

/** One particle of `shape` centred on (x, y), about 2s across. */
function particleShape(shape: AuraShape, x: number, y: number, s: number, c: string): string {
  const w = r1(Math.max(0.6, s * 0.3))
  switch (shape) {
    case 'dot':
      return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(s * 0.5)}" fill="${c}"/>`
    case 'bubble':
      return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(s * 0.6)}" fill="none" stroke="${c}" stroke-width="${w}"/>`
    case 'leaf':
      return `<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="${r1(s * 0.75)}" ry="${r1(s * 0.35)}" fill="${c}" transform="rotate(-30 ${r1(x)} ${r1(y)})"/>`
    case 'spark':
      return (
        `<polyline points="${r1(x - s * 0.6)},${r1(y - s)} ${r1(x + s * 0.2)},${r1(y - s * 0.1)} ` +
        `${r1(x - s * 0.2)},${r1(y + s * 0.1)} ${r1(x + s * 0.6)},${r1(y + s)}" fill="none" stroke="${c}" stroke-width="${w}"/>`
      )
    case 'flake': {
      const d = r1(s * 0.7)
      return (
        `<path d="M${r1(x - s)} ${r1(y)}h${r1(2 * s)}M${r1(x)} ${r1(y - s)}v${r1(2 * s)}` +
        `M${r1(x - d)} ${r1(y - d)}l${r1(2 * d)} ${r1(2 * d)}M${r1(x + d)} ${r1(y - d)}l${r1(-2 * d)} ${r1(2 * d)}" ` +
        `stroke="${c}" stroke-width="${r1(w * 0.7)}"/>`
      )
    }
    case 'ring':
      return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(s * 0.9)}" fill="none" stroke="${c}" stroke-width="${w}"/>`
    case 'streak':
      return `<line x1="${r1(x - s * 1.5)}" y1="${r1(y)}" x2="${r1(x + s * 1.5)}" y2="${r1(y)}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`
    case 'diamond':
      return `<polygon points="${r1(x)},${r1(y - s)} ${r1(x + s * 0.6)},${r1(y)} ${r1(x)},${r1(y + s)} ${r1(x - s * 0.6)},${r1(y)}" fill="${c}"/>`
    case 'star': {
      const k = s * 0.25
      const pts = [[0, -s], [k, -k], [s, 0], [k, k], [0, s], [-k, k], [-s, 0], [-k, -k]]
      return `<polygon points="${pts.map(([dx, dy]) => `${r1(x + dx!)},${r1(y + dy!)}`).join(' ')}" fill="${c}"/>`
    }
    case 'wisp':
      return `<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="${r1(s * 0.4)}" ry="${r1(s * 0.85)}" fill="${c}" opacity=".8"/>`
  }
}

/** Who wears the aura, beyond its tier: the rarity picks a signature, the level earns extras. */
export type AuraOwner = { rarity?: Rarity; extras?: { shooting: number; twinkle: number } }

/**
 * The aura round a sprite of content box `bounds`, for tier 0-4, drawn inside the sprite's own viewBox:
 * `under` goes behind the sprite (the glow), `over` in front (particles), `css` animates them (empty when still).
 * 1 glow · 2 + 3 particles · 3 brighter, 6 particles (half in the second type) · 4 the crown: a gold ring of sparkles.
 * On top, at every tier: the rarity's signature (see rarityLayer) and the level's shooting stars and twinkles.
 */
export function auraOverlay(
  bounds: Box | null | undefined,
  tier: number,
  types: readonly string[],
  animate: boolean,
  owner: AuraOwner = {},
): { under: string; over: string; css: string } {
  const { rarity, extras = { shooting: 0, twinkle: 0 } } = owner
  if (tier <= 0 && rarity === undefined && extras.shooting + extras.twinkle === 0) return { under: '', over: '', css: '' }
  const [bx, by, bw, bh] = auraBox(bounds)
  const cx = bx + bw / 2
  const cy = by + bh / 2
  const theme = AURA_THEMES[types[0] ?? ''] ?? AURA_THEMES.normal!
  const second = types[1] !== undefined ? AURA_THEMES[types[1]] : undefined
  const glow = tier >= 3 ? 0.8 : 0.6

  // The id names its colour and strength: several sprites on one page then never borrow another's glow.
  const id = `au-${theme.color.slice(1)}-${glow * 10}`
  const under =
    tier <= 0
      ? ''
      : `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${theme.color}" stop-opacity="${glow}"/>` +
        `<stop offset="1" stop-color="${theme.color}" stop-opacity="0"/></radialGradient></defs>` +
        `<ellipse class="au-halo" cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(bw * 0.68)}" ry="${r1(bh * 0.68)}" fill="url(#${id})"/>`

  const s = Math.max(2, Math.max(bw, bh) / 10)
  const count = tier >= 3 ? 6 : tier === 2 ? 3 : 0
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    const t = i % 2 === 1 && second ? second : theme
    parts.push(particle(t, i, count, s, [bx, by, bw, bh], cx, cy, animate))
  }
  if (tier >= 4) {
    // Crown: a thin gold ring and four sparkles on the diagonals.
    parts.push(
      `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(bw * 0.62)}" ry="${r1(bh * 0.62)}" fill="none" ` +
        `stroke="${GOLD}" stroke-width="${r1(Math.max(0.6, s * 0.25))}" opacity=".7"/>`,
    )
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2
      const x = cx + Math.cos(a) * bw * 0.62
      const y = cy + Math.sin(a) * bh * 0.62
      const delay = animate ? ` style="animation-delay:-${r1(i * 0.45)}s"` : ''
      parts.push(`<g class="au-p${animate ? ' au-twinkle' : ''}"${delay}>${particleShape('star', x, y, s * 1.2, GOLD)}</g>`)
    }
  }
  const feet = (bounds ?? [0, 0, CANVAS_PX, CANVAS_PX])[1] + (bounds ?? [0, 0, CANVAS_PX, CANVAS_PX])[3]
  if (rarity !== undefined) parts.push(rarityLayer(rarity, [bx, by, bw, bh], feet, s, animate))
  parts.push(extrasLayer(extras, [bx, by, bw, bh], s, animate))
  return { under, over: parts.join(''), css: animate ? AURA_CSS : '' }
}

const STARLIGHT = '#FFF4C2'
/** Seconds per round of shooting stars: more stars fire more often, never all at once. */
const SHOOT_SECONDS = 6

/** Shooting stars (one per 10 levels) crossing down-left, and twinkles (one per 5 between) round the edge. */
function extrasLayer(extras: { shooting: number; twinkle: number }, [bx, by, bw, bh]: Box, s: number, animate: boolean): string {
  const out: string[] = []
  for (let i = 0; i < extras.shooting; i++) {
    const x = bx + bw * (0.25 + ((i * 0.37) % 1) * 0.85)
    const y = by - bh * 0.05
    const t = s * 2.2
    const star =
      `<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x + t)}" y2="${r1(y - t)}" stroke="${STARLIGHT}" ` +
      `stroke-width="${r1(Math.max(0.5, s * 0.22))}" stroke-linecap="round" opacity=".8"/>` +
      `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(s * 0.35)}" fill="${STARLIGHT}"/>`
    const motion = animate
      ? ` au-shoot" style="--dx:${r1(-bw * 0.5)}px;--d:${r1(bh * 0.5)}px;animation-delay:-${r1((i / extras.shooting) * SHOOT_SECONDS)}s`
      : ''
    out.push(`<g class="au-p${motion}">${star}</g>`)
  }
  for (let i = 0; i < extras.twinkle; i++) {
    const a = i * 2.4 - Math.PI / 3
    const x = bx + bw / 2 + Math.cos(a) * bw * 0.72
    const y = by + bh / 2 + Math.sin(a) * bh * 0.72
    const delay = animate ? ` style="animation-delay:-${r1(i * 0.5)}s"` : ''
    out.push(`<g class="au-p${animate ? ' au-twinkle' : ''}"${delay}>${particleShape('star', x, y, s * 0.55, STARLIGHT)}</g>`)
  }
  return out.join('')
}

/**
 * Every rarity has a signature, so every Pokémon gets some love from the start:
 * common two silver twinkles · starter an orange spark circling it · uncommon a green ring pulsing at its feet ·
 * rare a blue sparkle (plus the shine across the sprite, see spriteSvg) · legendary a turning rainbow ring.
 */
function rarityLayer(rarity: Rarity, [bx, by, bw, bh]: Box, feet: number, s: number, animate: boolean): string {
  const cx = bx + bw / 2
  const cy = by + bh / 2
  const twinkle = (x: number, y: number, size: number, c: string, delay: number) =>
    `<g class="au-p${animate ? ' au-twinkle' : ''}"${animate ? ` style="animation-delay:-${delay}s"` : ''}>${particleShape('star', x, y, size, c)}</g>`
  switch (rarity) {
    case 'common':
      return twinkle(bx + bw * 0.05, by + bh * 0.1, s * 0.7, '#D9DEE5', 0) + twinkle(bx + bw * 0.95, by + bh * 0.85, s * 0.7, '#D9DEE5', 0.9)
    case 'starter':
      return (
        `<g class="au-p${animate ? ' au-orbit' : ''}"${animate ? ` style="transform-origin:${r1(cx)}px ${r1(cy)}px;animation-duration:4s"` : ''}>` +
        `<circle cx="${r1(cx)}" cy="${r1(by - bh * 0.02)}" r="${r1(s * 0.45)}" fill="#FF8A3D"/></g>`
      )
    case 'uncommon':
      return (
        `<g class="au-p${animate ? ' au-pulse' : ''}"${animate ? ' style="animation-duration:2.4s"' : ''}>` +
        `<ellipse cx="${r1(cx)}" cy="${r1(feet - s * 0.2)}" rx="${r1(bw * 0.4)}" ry="${r1(bw * 0.09)}" fill="none" ` +
        `stroke="#5BD16A" stroke-width="${r1(Math.max(0.6, s * 0.25))}"/></g>`
      )
    case 'rare':
      return twinkle(bx + bw * 0.92, by + bh * 0.08, s * 0.9, '#8EC5FF', 0)
    case 'legendary':
      return legendLayer(cx, cy, bw, s, animate)
  }
}

/** A rare Pokémon's shine: a white band sweeping across the sprite, masked to its pixels. Moving only. */
function shineSweep(base64: string, [vx, vy, vw, vh]: [number, number, number, number]): string {
  const id = `au-m-${vx}-${vy}-${vw}-${base64.length}`
  const x0 = vx - vw * 0.8
  const w = vw * 0.22
  return (
    `<mask id="${id}" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="${vx}" y="${vy}" width="${vw}" height="${vh}">` +
    `<image href="data:image/png;base64,${base64}" x="0" y="0" width="${CANVAS_PX}" height="${CANVAS_PX}"/></mask>` +
    `<g mask="url(#${id})"><polygon class="au-p au-sweep" style="--dx:${r1(vw * 1.9)}px" fill="#FFFFFF" opacity=".6" points="` +
    `${r1(x0)},${r1(vy + vh)} ${r1(x0 + w)},${r1(vy + vh)} ${r1(x0 + w + vh * 0.5)},${r1(vy)} ${r1(x0 + vh * 0.5)},${r1(vy)}"/></g>`
  )
}

/** A legendary's mark: a dashed rainbow ring turning slowly round it, and three white glints. */
function legendLayer(cx: number, cy: number, w: number, s: number, animate: boolean): string {
  const r = w * 0.66
  const ring =
    '<defs><linearGradient id="au-prism" x1="0" y1="0" x2="1" y2="1">' +
    ['#FF5A5A', '#FFC93C', '#5BE37D', '#4FC3F7', '#B388FF']
      .map((c, i) => `<stop offset="${i / 4}" stop-color="${c}"/>`)
      .join('') +
    '</linearGradient></defs>' +
    `<g class="au-p${animate ? ' au-orbit' : ''}"${animate ? ` style="transform-origin:${r1(cx)}px ${r1(cy)}px;animation-duration:12s"` : ''}>` +
    `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="none" stroke="url(#au-prism)" ` +
    `stroke-width="${r1(Math.max(0.8, s * 0.35))}" stroke-dasharray="${r1(s * 1.6)} ${r1(s * 0.8)}" stroke-linecap="round" opacity=".9"/></g>`
  const glints = [0, 1, 2]
    .map(i => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3
      const x = cx + Math.cos(a) * r
      const y = cy + Math.sin(a) * r
      const delay = animate ? ` style="animation-delay:-${r1(i * 0.6)}s"` : ''
      return `<g class="au-p${animate ? ' au-twinkle' : ''}"${delay}>${particleShape('star', x, y, s * 1.1, '#FFFFFF')}</g>`
    })
    .join('')
  return ring + glints
}

/** Particle `i` of `n`: placed for its motion, its loop offset so they never move in step. */
function particle(
  t: AuraTheme,
  i: number,
  n: number,
  s: number,
  [bx, by, bw, bh]: Box,
  cx: number,
  cy: number,
  animate: boolean,
): string {
  const across = bx + (bw * (i + 0.5)) / n
  const a = (2 * Math.PI * i) / n - Math.PI / 2
  const ringX = cx + Math.cos(a) * bw * 0.6
  const ringY = cy + Math.sin(a) * bh * 0.6
  let x = ringX
  let y = ringY
  const vars: string[] = []
  switch (t.motion) {
    case 'rise':
      ;[x, y] = [across, by + bh * 0.85]
      vars.push(`--d:${r1(-bh * 0.8)}px`)
      break
    case 'fall':
      ;[x, y] = [across, by + bh * 0.05]
      vars.push(`--d:${r1(bh * 0.8)}px`)
      break
    case 'drift':
      ;[x, y] = [across, by]
      vars.push(`--d:${r1(bh * 0.85)}px`, `--dx:${r1((i % 2 ? -1 : 1) * bw * 0.15)}px`)
      break
    case 'feet':
      ;[x, y] = [across, by + bh * 0.98]
      vars.push(`--d:${r1(-s * 1.5)}px`)
      break
    case 'sway':
      vars.push(`--d:${r1(bw * 0.25)}px`)
      break
    case 'fade':
      vars.push(`--d:${r1(-bh * 0.15)}px`)
      break
    case 'orbit':
      vars.push(`transform-origin:${r1(cx)}px ${r1(cy)}px`)
      break
  }
  if (!animate) return `<g class="au-p">${particleShape(t.shape, x, y, s, t.color)}</g>`
  vars.push(`animation-delay:-${r1((i / n) * MOTION_SECONDS[t.motion])}s`)
  return `<g class="au-p au-${t.motion}" style="${vars.join(';')}">${particleShape(t.shape, x, y, s, t.color)}</g>`
}

// Crack lines as fractions of the egg's content box, one polyline each.
const CRACKS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0.55, 0.12], [0.45, 0.26], [0.58, 0.38], [0.46, 0.52], [0.56, 0.64]],
  [[0.9, 0.48], [0.75, 0.55], [0.8, 0.68], [0.66, 0.74], [0.7, 0.86]],
]

/** Dark jagged crack line(s) over the egg: one for stage 1, two for stage 2. */
export function crackOverlay(bounds: Box | null | undefined, stage: number): string {
  if (stage <= 0) return ''
  const [bx, by, bw, bh] = bounds ?? [0, 0, CANVAS_PX, CANVAS_PX]
  const width = Math.max(1, Math.round(bw / 18))
  return CRACKS.slice(0, Math.min(2, stage))
    .map(line => {
      const pts = line.map(([fx, fy]) => `${Math.round(bx + fx * bw)},${Math.round(by + fy * bh)}`).join(' ')
      return (
        `<polyline points="${pts}" fill="none" stroke="#1d1d1d" stroke-width="${width}" ` +
        `stroke-linejoin="miter" stroke-linecap="square" shape-rendering="crispEdges"/>`
      )
    })
    .join('')
}

export type SpriteArgs = {
  base64: string
  bounds?: Box | null
  /** Drawn size in CSS px (square). */
  size: number
  animate: boolean
  /** Egg cracks to draw, 0-2. */
  crack?: number
  /** Paint the sprite solid black (an unearned legendary). */
  silhouette?: boolean
  /** Aura tier 0-4 drawn round the sprite. */
  aura?: number
  /** The species' types, which theme the aura. */
  types?: readonly string[]
  /** A hatched Pokémon's rarity and level extras, drawn with the aura (see auraOverlay). */
  owner?: AuraOwner
}

/** The sprite as an SVG: the PNG cropped by viewBox to its content, crisp, with egg cracks and any aura. */
export function spriteSvg({
  base64,
  bounds,
  size,
  animate,
  crack = 0,
  silhouette = false,
  aura = 0,
  types = [],
  owner,
}: SpriteArgs): string {
  const [vx, vy, vw, vh] = spriteViewBox(bounds)
  const glow = auraOverlay(bounds, aura, types, animate, owner)
  const shine = owner?.rarity === 'rare' && animate ? shineSweep(base64, [vx, vy, vw, vh]) : ''
  const css = animate
    ? '.bob{animation:bob 2.4s ease-in-out infinite}' +
      '@keyframes bob{0%,100%{transform:translateY(2px)}50%{transform:translateY(0)}}' +
      '@media (prefers-reduced-motion: reduce){.bob{animation:none}}'
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vx} ${vy} ${vw} ${vh}">` +
    `<style>${css}${glow.css}</style>` +
    (silhouette
      ? '<filter id="sil"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>'
      : '') +
    glow.under +
    `<g class="bob"><image href="data:image/png;base64,${base64}" x="0" y="0" width="${CANVAS_PX}" height="${CANVAS_PX}" style="image-rendering:pixelated"${silhouette ? ' filter="url(#sil)"' : ''}/>` +
    `${crackOverlay(bounds, crack)}${shine}</g>${glow.over}</svg>`
  )
}
