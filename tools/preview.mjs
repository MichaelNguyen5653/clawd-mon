// Builds preview/review.html: the band in many states, drawn with the real engine and view
// helpers, the real data files and the real sprites, so you can eyeball it without Claude Code.
//   node tools/preview.mjs        (Node 22.18+ strips the TypeScript types by itself)
// Open preview/review.html in a browser. The page is self-contained.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CONFIG,
  crackLevels,
  eggXpAt,
  boxText,
  dexView,
  execute,
  hatchLevel,
  newEntry,
  newSave,
  overview,
  progress,
  recommendation,
} from '../hooks/engine.ts'
import {
  GREEN,
  TRACK,
  adviceLine,
  dexRows,
  eventToast,
  hintRows,
  milestoneLine,
  contextColor,
  statsLine,
  pendingLine,
  spriteSvg,
  textBar,
  titleOf,
  xpLine,
} from '../hooks/view.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = rel => JSON.parse(readFileSync(join(root, rel), 'utf8'))
const dex = { species: readJson('data/pokedex.json'), growth: readJson('data/growth.json') }
let bounds = {}
try {
  bounds = readJson('data/sprite-bounds.json')
} catch {
  console.warn('data/sprite-bounds.json missing: run node tools/sprite-bounds.mjs first (sprites uncropped)')
}
const cfg = DEFAULT_CONFIG
const species = id => dex.species.find(s => s.id === id)

// ---------- save states, built the way the engine builds them ----------

/** A one-entry save (plus `extraEggs` bonus eggs in the box) around `entry`. */
function saveOf(entry, { pending = 0, milestone = 0, extraEggs = 0 } = {}) {
  const base = newSave()
  const box = [{ ...base.box[0], ...entry }]
  for (let i = 0; i < extraEggs; i++) box.push(newEntry(`a${i + 2}`, 'milestone', 1))
  return { ...base, box, pending, milestone }
}

/** An egg of `id` at egg level `level`, `stage` cracks in (default: as many as that level allows). */
function egg(id, level, { chosen = false, pending = 0, stage, milestone = 0, extraEggs = 0 } = {}) {
  const h = hatchLevel(species(id))
  const [c1, c2] = crackLevels(h)
  const auto = level >= c2 ? 2 : level >= c1 ? 1 : 0
  const xp = eggXpAt(level, h) + (level < h ? (eggXpAt(level + 1, h) - eggXpAt(level, h)) * 0.35 : 0)
  return saveOf({ target: id, chosen, eggStage: stage ?? auto, xp }, { pending, milestone, extraEggs })
}

/** A hatched companion of `id` at `level`, a third of the way to the next one. */
function mon(id, level, { compacts = 0, pending = 0, fraction = 0.35, milestone = 0, extraEggs = 0, branch = null } = {}) {
  const table = dex.growth[species(id).growthRate]
  const xp = table[level] + (table[level + 1] - table[level]) * fraction
  return saveOf({ phase: 'mon', speciesId: id, xp, compacts, branch }, { pending, milestone, extraEggs })
}

// Sample session numbers, like the example in the brief.
const TOOLS = { available: 275, mcp: 13, usedNames: Array.from({ length: 13 }, (_, i) => `tool${i}`), calls: 41, seeded: true }
const AGENTS = { running: 0, total: 0 }
const stats = u => statsLine(u, TOOLS, AGENTS)

const usage = (percent, window = 1_000_000) => ({ tokens: Math.round((percent / 100) * window), window, percent })

// ---------- rendering ----------

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pngs = new Map()
function png(key) {
  if (!pngs.has(key)) {
    try {
      pngs.set(key, readFileSync(join(root, 'assets', 'sprites', `${key}.png`)).toString('base64'))
    } catch {
      pngs.set(key, null)
    }
  }
  return pngs.get(key)
}

function view(save, u) {
  const p = progress(save, dex)
  const rec = recommendation({ percent: u?.percent, tokens: u?.tokens, window: u?.window ?? 0 }, save, cfg)
  return { p, rec, u, key: p.kind === 'egg' ? 'egg' : String(p.id) }
}

/** One desktop band, laid out like register.tsx draws it. */
function desktopBand({ save, usage: u, label, hint = false }) {
  const { p, rec, key } = view(save, u)
  const b64 = png(key)
  const svg = b64
    ? spriteSvg({ base64: b64, bounds: bounds[key], size: 80, animate: false, crack: p.kind === 'egg' ? p.stage : 0 })
    : ''
  const color = contextColor(u?.percent, cfg)
  const advice = adviceLine(rec, u, cfg)
  const bar = (fraction, fill) =>
    `<div class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%;background:${fill}"></i></div>`
  return `<div class="band">
  <div class="spr">${svg}</div>
  <div class="info">
    ${label ? `<div class="lbl">${esc(label)}</div>` : ''}
    <div class="trow"><span class="title">${esc(titleOf(p))}</span><button class="hintbtn">!hint</button><span class="sub">${esc(milestoneLine(overview(save)))}</span></div>
    ${bar(p.fraction, GREEN)}
    <div class="sub">${esc(`${xpLine(p)} · ${pendingLine(p)}`)}</div>
    ${bar((u?.percent ?? 0) / 100, color)}
    <div class="sub" style="color:${color}">${esc(stats(u))}</div>
    ${advice ? `<div class="advice">${esc(advice)}</div>` : ''}
  </div>
  <div class="btns"><button class="${rec.recommend ? 'primary' : ''}">Evolve</button><button class="x">×</button></div>
</div>${hint ? `<div class="help">${hintRows(cfg, 99).map(r => `<div>${esc(r)}</div>`).join('')}<button>Cancel</button></div>` : ''}`
}

/** The terminal rows for a band: text only, the sprite is a kitty-protocol Image there. */
function terminalBand({ save, usage: u, hint = false, maxRows = 12 }) {
  const { p, rec } = view(save, u)
  const pad = ' '.repeat(10)
  const advice = adviceLine(rec, u, cfg)
  const rows = [
    `┌────────┐  ${titleOf(p)} !hint  ${milestoneLine(overview(save))}   [ Evolve ] ×`,
    `│ sprite │  ${textBar(p.fraction, 20)} ${xpLine(p)}`,
    `│  8x4   │  ${pendingLine(p)}`,
    `└────────┘  ${textBar((u?.percent ?? 0) / 100, 20)} ${stats(u)}`,
  ]
  if (advice) rows.push(`${pad}${advice}`)
  if (hint) {
    const budget = Math.max(1, maxRows - (advice ? 5 : 4) - 1)
    for (const r of hintRows(cfg, budget)) rows.push(r.length > 110 ? `${r.slice(0, 109)}…` : r)
    rows.push('[ Cancel ]')
  }
  return rows.join('\n')
}

const caterpie = 10
const SCENARIOS = [
  { caption: 'Fresh egg, Lv 1. Random species stays hidden.', bands: [{ save: egg(1, 1, { stage: 0 }), usage: usage(2, 1_000_000) }] },
  { caption: 'Egg, first crack: one crack line on the shell.', bands: [{ save: egg(25, crackLevels(hatchLevel(species(25)))[0], { pending: 240 }), usage: usage(31, 200_000) }] },
  { caption: 'Egg, second crack (about to hatch), context 65%: Evolve recommended.', bands: [{ save: egg(4, crackLevels(hatchLevel(species(4)))[1], { pending: 1450 }), usage: usage(65, 200_000) }] },
  { caption: 'Egg chosen with /clawd-mon choose bulbasaur: the name shows. Mid-level.', bands: [{ save: egg(1, 3, { chosen: true, pending: 180 }), usage: usage(18, 1_000_000) }] },
  { caption: 'Just hatched: Bulbasaur Lv 5.', bands: [{ save: mon(1, 5, { fraction: 0.02 }), usage: usage(4, 1_000_000) }] },
  { caption: 'Ivysaur Lv 22, 3 of 8 compacts for Venusaur.', bands: [{ save: mon(2, 22, { compacts: 3, pending: 620 }), usage: usage(38, 200_000) }] },
  { caption: 'Venusaur Lv 40, fully evolved.', bands: [{ save: mon(3, 40, { compacts: 14, pending: 90 }), usage: usage(12, 1_000_000) }] },
  { caption: 'Danger: context 85%. Red bar, pending decays 2% a turn.', bands: [{ save: mon(2, 22, { compacts: 3, pending: 1800 }), usage: usage(85, 200_000) }] },
  {
    caption: 'Egg levels differ by species: Caterpie hatches at Lv 4, Mewtwo at Lv 10 (both shown here at egg Lv 3).',
    bands: [
      { label: 'Caterpie egg (H 4), chosen', save: egg(caterpie, 3, { chosen: true }), usage: usage(30, 200_000) },
      { label: 'Mewtwo egg (H 10), chosen', save: egg(150, 3, { chosen: true }), usage: usage(30, 200_000) },
    ],
  },
  {
    caption: 'Lines: Charmander / Charmeleon / Charizard, Pikachu / Raichu, Eevee and its three branches.',
    bands: [
      { save: mon(4, 8), usage: usage(20) },
      { save: mon(5, 24, { compacts: 4 }), usage: usage(20) },
      { save: mon(6, 45, { compacts: 12 }), usage: usage(20) },
      { save: mon(25, 18, { compacts: 2 }), usage: usage(20) },
      { save: mon(26, 34, { compacts: 9 }), usage: usage(20) },
      { label: 'Eevee, Lv 28 (picks a branch with /clawd-mon branch)', save: { ...mon(133, 28, { compacts: 3 }), branch: 135 }, usage: usage(20) },
      { save: mon(134, 30, { compacts: 3 }), usage: usage(20) },
      { save: mon(135, 30, { compacts: 3 }), usage: usage(20) },
      { save: mon(136, 30, { compacts: 3 }), usage: usage(20) },
    ],
  },
]

// l..o come after a..k: l is drawn from SCENARIOS, m too; n and o are text cards.
SCENARIOS.push(
  {
    n: 'l',
    caption: 'Help open (!hint pressed): rules and commands. Cancel closes it.',
    bands: [{ save: mon(1, 12, { milestone: 3 }), usage: usage(30, 200_000), hint: true }],
    terminal: [
      { save: mon(1, 12, { milestone: 3 }), usage: usage(30, 200_000), hint: true, maxRows: 14, note: 'terminal, maxRows 14' },
      { save: mon(1, 12, { milestone: 3 }), usage: usage(30, 200_000), hint: true, maxRows: 6, note: 'terminal, maxRows 6: commands in one row' },
    ],
  },
  {
    n: 'm',
    caption: 'Bonus egg progress 24/25 and a box of 3.',
    bands: [{ save: mon(2, 22, { compacts: 3, milestone: 24, extraEggs: 2 }), usage: usage(38, 200_000) }],
  },
)

const boxDemo = {
  ...mon(2, 22, { compacts: 3 }),
  box: [
    { ...newSave().box[0], phase: 'mon', speciesId: 2, xp: dex.growth['medium-slow'][22] + 100, compacts: 3 },
    { ...newEntry('a2', 'evolved', 133), xp: 0 },
    { ...newEntry('a3', 'milestone', 4), xp: 700, chosen: true },
    { ...newSave().box[0], id: 'a4', phase: 'mon', speciesId: 25, xp: dex.growth.medium[31], origin: 'milestone' },
  ],
  activeId: 'a1',
}
const boxText$ = execute(boxDemo, dex, 'box', { day: '2026-10-06' }).text
const switchText = execute(boxDemo, dex, 'switch pikachu', { day: '2026-10-06' }).text
const textCards = [
  { n: 'n', caption: '/clawd-mon box, then /clawd-mon switch pikachu.', text: `> /clawd-mon box\n${boxText$}\n\n> /clawd-mon switch pikachu\n${switchText}` },
  {
    n: 'o',
    caption: 'Toasts: a new egg, a crack (neutral), a hatch.',
    text: [eventToast({ kind: 'egg', origin: 'evolved' }, dex), eventToast({ kind: 'crack', stage: 1 }, dex), eventToast({ kind: 'crack', stage: 2 }, dex), eventToast({ kind: 'hatch', speciesId: 1 }, dex)].join('\n'),
  },
]

// ---------- dex cards (p, q, r) ----------

/** The dex block as the desktop band draws it: header, a row per legendary, Cancel. */
function dexHtml(save, label) {
  const v = dexView(save, dex, cfg)
  const rows = v.rows
    .map(r => {
      const b64 = png(String(r.id))
      const svg = b64
        ? spriteSvg({ base64: b64, bounds: bounds[String(r.id)], size: 48, animate: false, silhouette: !r.earned })
        : ''
      const state = r.earned ? 'earned' : r.locked ? 'locked' : `${r.progress.n}/${r.progress.goal}`
      const frac = r.progress ? r.progress.n / r.progress.goal : 0
      return `<div class="band dexrow"><div class="spr sm">${svg}</div><div class="info"><div class="title">${esc((r.earned ? '★ ' : '') + r.name)}</div><div class="sub">${esc(r.lore)}</div><div class="sub" style="opacity:1">${esc(r.goal)}</div><div class="bar"><i style="width:${Math.round(Math.min(1, frac) * 100)}%;background:${r.earned ? GREEN : '#E0A030'}"></i></div><div class="sub">${esc(state)}</div></div></div>`
    })
    .join('')
  return `<div class="help dexhelp">${label ? `<div class="lbl">${esc(label)}</div>` : ''}<div class="title">${esc(dexRows(v, 1)[0])}</div>${rows}<button>Cancel</button></div>`
}

const mixed = {
  ...mon(2, 22, { compacts: 3 }),
  dex: [1, 2, 4, 5, 25, 133, 143],
  streaks: { coolDays: 9, coolDay: '2026-10-05', coolBroken: false, strike: 17 },
  lifetime: { ...newSave().lifetime, fullLines: 1 },
  legendsEarned: [],
}
// Zapdos earned at 30; the others are still below their goals, as the engine would have it.
const oneEarned = { ...mixed, legendsEarned: [145], streaks: { coolDays: 9, coolDay: '2026-10-05', coolBroken: false, strike: 30 }, lifetime: { ...mixed.lifetime, fullLines: 2 } }
const dexCards = [
  { n: 'p', caption: 'Dex view, mixed progress: silhouettes and ??? until earned; Mewtwo locked behind the birds; nothing else is listed.', save: mixed },
  { n: 'q', caption: 'Dex view, Zapdos earned: real sprite, name and star; the rest still silhouettes.', save: oneEarned },
]
const dexTerminal = s => dexRows(dexView(s, dex, cfg), 7).join('\n') + '\n[ Cancel ]'

const letters = 'abcdefghijklmnopqrstuvwxyz'
const cards = SCENARIOS.map((s, i) => {
  const panel = theme => `<div class="panel ${theme}">${s.bands.map(desktopBand).join('')}</div>`
  const term = (s.terminal ?? [])
    .map(
      b =>
        `<div class="pair"><pre class="panel light">${esc(`(${b.note})\n${terminalBand(b)}`)}</pre><pre class="panel dark">${esc(`(${b.note})\n${terminalBand(b)}`)}</pre></div>`,
    )
    .join('')
  return `<section><h2><span>${s.n ?? letters[i]}</span> ${esc(s.caption)}</h2><div class="pair">${panel('light')}${panel('dark')}</div>${term}</section>`
}).join('\n')
const dexSections = dexCards
  .map(
    c =>
      `<section><h2><span>${c.n}</span> ${esc(c.caption)}</h2><div class="pair"><div class="panel light">${desktopBand({ save: c.save, usage: usage(30, 200_000) })}${dexHtml(c.save)}</div><div class="panel dark">${desktopBand({ save: c.save, usage: usage(30, 200_000) })}${dexHtml(c.save)}</div></div><div class="pair"><pre class="panel light">${esc(dexTerminal(c.save))}</pre><pre class="panel dark">${esc(dexTerminal(c.save))}</pre></div></section>`,
  )
  .join('\n')
const extra0 = textCards
  .map(c => `<section><h2><span>${c.n}</span> ${esc(c.caption)}</h2><div class="pair"><pre class="panel light">${esc(c.text)}</pre><pre class="panel dark">${esc(c.text)}</pre></div></section>`)
  .join('\n')

const terminalScenes = [
  { save: egg(1, 1, { stage: 0 }), usage: usage(2, 1_000_000) },
  { save: mon(2, 22, { compacts: 3, pending: 620 }), usage: usage(38, 200_000) },
]
const terminal = `<section><h2><span>k</span> Terminal text rendering of a) and f). The sprite is an Image (kitty graphics); other terminals show its alt text.</h2>
<div class="pair"><pre class="panel light">${esc(terminalScenes.map(terminalBand).join('\n\n'))}</pre><pre class="panel dark">${esc(terminalScenes.map(terminalBand).join('\n\n'))}</pre></div></section>`

textCards.push({
  n: 'r',
  caption: 'Toast when a legendary egg is earned.',
  text: eventToast({ kind: 'legend', id: 145 }, dex),
})
const extra = dexSections + '\n' +
  textCards
    .map(c => `<section><h2><span>${c.n}</span> ${esc(c.caption)}</h2><div class="pair"><pre class="panel light">${esc(c.text)}</pre><pre class="panel dark">${esc(c.text)}</pre></div></section>`)
    .join('\n')
void extra0

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Clawd-mon review</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; background: #888; }
  h1 { font-size: 20px; } h2 { font-size: 14px; margin: 28px 0 8px; } h2 span { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 11px; background: #222; color: #fff; margin-right: 6px; }
  .pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  .panel { min-width: 0; overflow-x: auto; padding: 14px; border-radius: 8px; display: flex; flex-direction: column; gap: 10px; }
  .panel.light { background: #fff; color: #1d1d1d; } .panel.dark { background: #1e1e1e; color: #e8e8e8; }
  .band { display: flex; align-items: center; gap: 14px; }
  .spr { width: 80px; height: 80px; flex: none; } .spr svg { display: block; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .lbl { font-size: 11px; opacity: .6; } .title { font-weight: 700; } .trow { display: flex; align-items: center; gap: 8px; }
  .hintbtn { border: 0; padding: 0; opacity: .55; font-size: 12px; } .help { font-size: 12px; opacity: .85; padding: 6px 0 0 94px; display: flex; flex-direction: column; gap: 2px; } .help button { align-self: flex-start; margin-top: 4px; } .dexhelp { padding: 8px 0 0 0; gap: 8px; } .dexrow { gap: 10px; } .spr.sm { width: 48px; height: 48px; }
  .bar { height: 6px; background: ${TRACK}; } .bar i { display: block; height: 100%; }
  .sub { opacity: .75; font-size: 12px; } .advice { color: #E0A030; font-weight: 700; font-size: 12px; }
  .btns { display: flex; gap: 6px; } button { font: inherit; padding: 4px 10px; border-radius: 4px; border: 1px solid #8886; background: transparent; color: inherit; }
  button.primary { background: #D97757; border-color: #D97757; color: #fff; } button.x { border: 0; opacity: .6; }
  pre.panel { font: 12px/1.35 ui-monospace, Consolas, monospace; margin: 0; white-space: pre; display: block; }
</style>
<h1>Clawd-mon review (light and dark panels)</h1>
${cards}
${terminal}
${extra}
</html>
`
mkdirSync(join(root, 'preview'), { recursive: true })
const out = join(root, 'preview', 'review.html')
writeFileSync(out, html)
console.log(`wrote ${out}`)
