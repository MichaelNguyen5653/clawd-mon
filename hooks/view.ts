// Clawd-mon view helpers: the text and SVG the band shows. Pure, with type-only imports,
// so plain Node can load this file (tools/preview.mjs) as well as the plugin.

import type { ClawdMonAgents, ClawdMonTools, ClawdMonUsage } from '../types'
import type { Config, Dex, DexRow, DexView, GameEvent, Overview, Progress, Rarity, Recommendation } from './engine'

export const GREEN = '#4CAF50'
export const AMBER = '#E0A030'
export const RED = '#E5534B'
export const TRACK = '#80808040'
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
  return `${p.name} Lv ${p.level}${star}`
}

export function xpLine(p: Progress): string {
  if (p.kind === 'egg') {
    return p.need > 0 ? `XP ${Math.floor(p.into)}/${Math.floor(p.need)}` : 'XP full'
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
    return `Evolve recommended: pending XP decays 2% a turn at ${percent}%`
  }
  if (rec.reason === 'projected') return 'Evolve recommended: context is filling fast'
  return `Evolve recommended: context at ${percent}%`
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
  }
}

/** Dim row beside the title: progress to the next bonus egg, and the box size once it holds more than one. */
export function milestoneLine(o: Overview): string {
  return `New egg (${o.milestone}/${o.goal})${o.boxCount > 1 ? ` · Box ${o.boxCount}` : ''}`
}

// ---------- in-band help ----------

/** What the help says, without level spoilers. */
export function hintRules(cfg: Pick<Config, 'dangerPercent'>): string[] {
  return [
    'Evolve = compact + apply pending XP. Only compacts at 40%+ context count.',
    `Pending XP decays 2%/turn at ${cfg.dangerPercent}%+ context.`,
    'Only the active Pokémon or egg gains XP.',
    'New egg: fully evolve the active one, or every 25 counted compacts.',
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
}

/** The sprite as an SVG: the PNG cropped by viewBox to its content, crisp, with egg cracks on top. */
export function spriteSvg({ base64, bounds, size, animate, crack = 0, silhouette = false }: SpriteArgs): string {
  const [vx, vy, vw, vh] = spriteViewBox(bounds)
  const css = animate
    ? '.bob{animation:bob 2.4s ease-in-out infinite}' +
      '@keyframes bob{0%,100%{transform:translateY(2px)}50%{transform:translateY(0)}}' +
      '@media (prefers-reduced-motion: reduce){.bob{animation:none}}'
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vx} ${vy} ${vw} ${vh}">` +
    `<style>${css}</style>` +
    (silhouette
      ? '<filter id="sil"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>'
      : '') +
    `<g class="bob"><image href="data:image/png;base64,${base64}" x="0" y="0" width="${CANVAS_PX}" height="${CANVAS_PX}" style="image-rendering:pixelated"${silhouette ? ' filter="url(#sil)"' : ''}/>` +
    `${crackOverlay(bounds, crack)}</g></svg>`
  )
}
