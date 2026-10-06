import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, dexView, ensureTarget, newSave, progress, type Entry, type Save } from '../hooks/engine'
import {
  adviceLine,
  dexRowLine,
  dexRows,
  HINT_COMMANDS_ONE_ROW,
  agentsLabel,
  statsLine,
  toolsLabel,
  contextColor,
  contextLine,
  crackOverlay,
  eventToast,
  formatTokens,
  HINT_COMMANDS,
  hintRows,
  hintRules,
  milestoneLine,
  pendingLine,
  spriteSvg,
  spriteViewBox,
  titleOf,
  xpLine,
} from '../hooks/view'
import { DEX } from './fixtures'

describe('context line', () => {
  test('token formatter: uppercase K/M, one decimal, no trailing .0', async () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(23_000)).toBe('23K')
    expect(formatTokens(124_300)).toBe('124.3K')
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(999_990)).toBe('1M')
    expect(formatTokens(Number.NaN)).toBe('—')
  })

  test('shows percent and real counts', async () => {
    expect(contextLine({ tokens: 23_000, window: 1_000_000, percent: 2 })).toBe('Context 2% · 23K / 1M')
    expect(contextLine({ tokens: 124_300, window: 200_000, percent: 62 })).toBe('Context 62% · 124.3K / 200K')
  })

  test('percent unknown but window known; no reading at all', async () => {
    expect(contextLine({ window: 1_000_000 })).toBe('Context n/a · — / 1M')
    expect(contextLine(null)).toBe('Context: no reading yet')
  })

  test('bar colour follows the thresholds', async () => {
    expect(contextColor(10, DEFAULT_CONFIG)).not.toBe(contextColor(65, DEFAULT_CONFIG))
    expect(contextColor(65, DEFAULT_CONFIG)).not.toBe(contextColor(85, DEFAULT_CONFIG))
    expect(contextColor(undefined, DEFAULT_CONFIG)).toBe(contextColor(0, DEFAULT_CONFIG))
  })
})

describe('egg text gives no hints', () => {
  const egg = (xp: number, stage: 0 | 1 | 2, entry: Partial<Entry> = {}, save: Partial<Save> = {}): Save => {
    const base = newSave()
    return ensureTarget({ ...base, ...save, box: [{ ...base.box[0]!, xp, eggStage: stage, ...entry }] }, DEX, () => 0)
  }

  test('title is Egg Lv N, the name only when chosen', async () => {
    expect(titleOf(progress(egg(0, 0), DEX))).toBe('Egg Lv 1')
    expect(titleOf(progress(egg(800, 1, { target: 1, chosen: true }), DEX))).toBe('Egg Lv 2 (Bulbasaur)')
    expect(titleOf(progress(egg(800, 1, { target: 1 }), DEX))).toBe('Egg Lv 2')
  })

  test('no band text says when it will crack or hatch', async () => {
    for (const stage of [0, 1, 2] as const) {
      const p = progress(egg(1000, stage, {}, { pending: 40 }), DEX)
      for (const text of [titleOf(p), xpLine(p), pendingLine(p)]) {
        expect(text).not.toMatch(/\d\/3|crack|hatch|next/i)
      }
    }
  })

  test('xp line is xp into the egg level over the span; pending line is just the bank', async () => {
    const p = progress(egg(0, 0, { target: 1 }, { pending: 40 }), DEX)
    expect(xpLine(p)).toMatch(/^XP 0\/\d+$/)
    expect(pendingLine(p)).toBe('Pending +40 XP')
  })

  test('toasts are neutral for both cracks', async () => {
    expect(eventToast({ kind: 'crack', stage: 1 }, DEX)).toBe('The egg is cracking')
    expect(eventToast({ kind: 'crack', stage: 2 }, DEX)).toBe('The egg is cracking')
    expect(eventToast({ kind: 'hatch', speciesId: 1 }, DEX)).toBe('The egg hatched: Bulbasaur!')
    expect(eventToast({ kind: 'evolve', from: 1, to: 2 }, DEX)).toBe('Bulbasaur evolved into Ivysaur!')
    expect(eventToast({ kind: 'egg', origin: 'evolved' }, DEX)).toBe('A new egg arrived — /clawd-mon switch to hatch it')
    expect(eventToast({ kind: 'egg', origin: 'milestone' }, DEX)).toBe('A new egg arrived — /clawd-mon switch to hatch it')
  })

  test('a mon keeps its evolution line', async () => {
    const base = newSave()
    const s = { ...base, box: [{ ...base.box[0]!, phase: 'mon' as const, speciesId: 2, xp: DEX.growth['medium-slow'][22]!, compacts: 3 }] }
    expect(pendingLine(progress(s, DEX))).toBe('Pending +0 XP, 3/8 compacts for Venusaur (Lv 32)')
  })
})

describe('new egg progress line', () => {
  test('milestone progress, plus the box size once it holds more than one', async () => {
    expect(milestoneLine({ boxCount: 1, milestone: 0, goal: 25 })).toBe('New egg (0/25)')
    expect(milestoneLine({ boxCount: 3, milestone: 24, goal: 25 })).toBe('New egg (24/25) · Box 3')
  })
})

describe('in-band help', () => {
  const all = (rows: string[]) => rows.join('\n')

  test('rules show the configured decay line and no level spoilers', async () => {
    expect(all(hintRules({ dangerPercent: 70 }))).toMatch(/decays 2%\/turn at 70%\+/)
    expect(all(hintRules({ dangerPercent: 80 }))).toMatch(/40%\+ context/)
    expect(all(hintRules({ dangerPercent: 80 }))).toMatch(/every 25 counted compacts/)
    expect(all(hintRules({ dangerPercent: 80 }))).not.toMatch(/Lv \d|level \d/i)
    expect(all([...HINT_COMMANDS])).not.toMatch(/Lv \d/)
  })

  test('roomy: rules plus one command per row', async () => {
    const rows = hintRows({ dangerPercent: 80 }, 40)
    expect(rows).toHaveLength(hintRules({ dangerPercent: 80 }).length + HINT_COMMANDS.length)
    for (const c of ['show', 'hide', 'hint', 'status', 'box', 'switch', 'release', 'choose', 'branch', 'reset-all']) {
      expect(all(rows)).toContain('/clawd-mon ' + c)
    }
  })

  test('tight: commands collapse to one row; tighter: that row comes first; none: nothing', async () => {
    const rules = hintRules({ dangerPercent: 80 }).length
    const compact = hintRows({ dangerPercent: 80 }, rules + 1)
    expect(compact).toHaveLength(rules + 1)
    expect(compact[rules]).toMatch(/^Commands: show · hide · hint · dex · status · box/)
    const tight = hintRows({ dangerPercent: 80 }, 1)
    expect(tight).toHaveLength(1)
    expect(tight[0]).toMatch(/^Commands: show/)
    expect(hintRows({ dangerPercent: 80 }, 3)[0]).toMatch(/^Commands:/)
    expect(hintRows({ dangerPercent: 80 }, 0)).toEqual([])
    for (let n = 0; n < 20; n++) expect(hintRows({ dangerPercent: 80 }, n).length).toBeLessThanOrEqual(n)
  })
})

describe('advice', () => {
  const usage = (percent: number) => ({ tokens: percent * 2000, window: 200_000, percent })
  test('quiet, high, projected and danger', async () => {
    expect(adviceLine({ recommend: false, reason: null }, usage(20), DEFAULT_CONFIG)).toBe('')
    expect(adviceLine({ recommend: true, reason: 'high' }, usage(65), DEFAULT_CONFIG)).toMatch(/Evolve recommended.*65%/)
    expect(adviceLine({ recommend: true, reason: 'projected' }, usage(50), DEFAULT_CONFIG)).toMatch(/filling fast/)
    expect(adviceLine({ recommend: true, reason: 'high' }, usage(85), DEFAULT_CONFIG)).toMatch(/decays 2%/)
  })
})

describe('sprite svg', () => {
  test('viewBox is the content box padded to a square plus 2px a side', async () => {
    expect(spriteViewBox(null)).toEqual([0, 0, 96, 96])
    expect(spriteViewBox([34, 34, 28, 30])).toEqual([34 + 14 - 17, 34 + 15 - 17, 34, 34])
    const [, , w, h] = spriteViewBox([10, 20, 60, 40])
    expect(w).toBe(64)
    expect(h).toBe(64)
  })

  test('crack overlay: none, one line, two lines', async () => {
    const box = [34, 34, 28, 30] as const
    const count = (stage: number) => (crackOverlay(box, stage).match(/<polyline/g) ?? []).length
    expect(count(0)).toBe(0)
    expect(count(1)).toBe(1)
    expect(count(2)).toBe(2)
    expect(count(5)).toBe(2)
    expect(crackOverlay(box, 1)).toMatch(/crispEdges/)
  })

  test('svg embeds the png, crops by viewBox, stays crisp, and carries the cracks', async () => {
    const svg = spriteSvg({ base64: 'AAAA', bounds: [34, 34, 28, 30], size: 80, animate: true, crack: 2 })
    expect(svg).toMatch(/^<svg /)
    expect(svg).toMatch(/width="80" height="80"/)
    expect(svg).toMatch(/viewBox="31 32 34 34"/)
    expect(svg).toMatch(/data:image\/png;base64,AAAA/)
    expect(svg).toMatch(/image-rendering:pixelated/)
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2)
    expect(spriteSvg({ base64: 'AAAA', size: 80, animate: false })).not.toMatch(/animation/)
  })
})

describe('session stats', () => {
  const tools = (over = {}) => ({ available: 275, mcp: 13, usedNames: Array.from({ length: 13 }, (_, i) => `t${i}`), calls: 41, seeded: true, ...over })

  test('tools label: available, MCP count, distinct used, calls', async () => {
    expect(toolsLabel(tools())).toBe('Tools 275 avail (13 MCP) · 13 used · 41 calls')
    expect(toolsLabel(tools({ mcp: 0 }))).toBe('Tools 275 avail · 13 used · 41 calls')
    expect(toolsLabel(tools({ available: null }))).toBe('Tools n/a avail · 13 used · 41 calls')
  })

  test('agents label: running and spawned, n/a until read', async () => {
    expect(agentsLabel({ running: 0, total: 0 })).toBe('Agents 0 running · 0 spawned')
    expect(agentsLabel({ running: 2, total: 5 })).toBe('Agents 2 running · 5 spawned')
    expect(agentsLabel({ running: null, total: null })).toBe('Agents n/a')
    expect(agentsLabel({ running: 1, total: null })).toBe('Agents n/a')
  })

  test('one line, in the order context, agents, tools', async () => {
    const line = statsLine({ tokens: 23_000, window: 1_000_000, percent: 2 }, tools(), { running: 0, total: 0 })
    expect(line).toBe(
      'Context 2% · 23K / 1M · Agents 0 running · 0 spawned · Tools 275 avail (13 MCP) · 13 used · 41 calls',
    )
    expect(line).not.toMatch(/\n/)
  })

  test('unknowns read n/a, never a guess', async () => {
    const line = statsLine({ window: 200_000 }, tools({ available: null }), { running: null, total: null })
    expect(line).toBe('Context n/a · — / 200K · Agents n/a · Tools n/a avail · 13 used · 41 calls')
  })
})

describe('legendary star and dex text', () => {
  test('a star by legendary eggs and legendary Pokémon, none otherwise', async () => {
    const base = newSave()
    const egg = { ...base, box: [{ ...base.box[0]!, origin: 'legendary' as const, target: 144 }] }
    expect(titleOf(progress(egg, DEX))).toBe('Egg Lv 1 ★')
    expect(titleOf(progress(newSave(), DEX))).toBe('Egg Lv 1')
    const mewtwo = { ...base, box: [{ ...base.box[0]!, phase: 'mon' as const, speciesId: 150, xp: DEX.growth.slow[10]! }] }
    expect(titleOf(progress(mewtwo, DEX))).toBe('Mewtwo Lv 10 ★')
  })

  test('!hint lists the dex command', async () => {
    expect(HINT_COMMANDS.join('\n')).toMatch(/\/clawd-mon dex: your catalog, legendaries included/)
    expect(HINT_COMMANDS_ONE_ROW).toMatch(/hint · dex · status/)
  })

  const save = (extra: Record<string, unknown> = {}): Save => ({ ...newSave(), ...extra }) as Save
  const view = (extra: Record<string, unknown> = {}) => dexView(save(extra), DEX, DEFAULT_CONFIG)

  test('rows read: name, lore, goal, progress or locked or earned', async () => {
    const rows = view({ streaks: { coolDays: 3, coolDay: null, coolBroken: false, strike: 0 }, legendsEarned: [145] }).rows
    expect(dexRowLine(rows[0]!)).toBe('??? · Frozen bird of legend · Stay cool: 14 days without reaching 80% context · 3/14')
    expect(dexRowLine(rows[1]!)).toBe('★ Zapdos · Storm bird of legend · Strike first: 30 compacts in a row before an auto-compact · earned')
    expect(dexRowLine(rows[3]!)).toMatch(/^\?\?\? · Born in a lab from a legend’s DNA · .* · locked$/)
  })

  test('dex rows respect the row budget: header first, the rest truncated, never empty', async () => {
    const v = view()
    expect(dexRows(v, 10)).toHaveLength(6)
    expect(dexRows(v, 10)[0]).toMatch(/^Dex 0\/\d+ · ★ 0\/4$/)
    expect(dexRows(v, 10)[1]).toMatch(/^Starters 0\/\d+ · Common 0\/\d+$/)
    expect(dexRows(v, 4)).toHaveLength(4)
    // header and the counts line always stay
    expect(dexRows(v, 1)).toHaveLength(2)
    expect(dexRows(v, 0)).toHaveLength(2)
    expect(dexRows(v, 2)[1]).toMatch(/^Starters/)
  })

  test('the silhouette is a black fill of the same cropped sprite and stays small', async () => {
    const png = 'A'.repeat(8000)
    const sil = spriteSvg({ base64: png, bounds: [28, 30, 35, 33], size: 48, animate: false, silhouette: true })
    expect(sil).toMatch(/<filter id="sil"/)
    expect(sil).toMatch(/feColorMatrix/)
    expect(sil).toMatch(/filter="url\(#sil\)"/)
    expect(sil).toMatch(/viewBox="/)
    expect(sil.length).toBeLessThan(131_072)
    expect(spriteSvg({ base64: png, size: 48, animate: false })).not.toMatch(/filter/)
  })
})
