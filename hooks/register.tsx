// Clawd-mon: a Pokemon companion in the band above the prompt.
//
// It starts as an egg and grows from the tokens you spend. Tokens bank as pending
// XP; the Evolve button compacts the conversation and applies the bank. The rules
// live in engine.ts (pure, unit-tested); this file wires them to the session:
//
//   session.start     load the save from $.store, register /clawd-mon
//   session.measure   keep the context reading fresh for the band
//   turn.complete     bank the turn's tokens, decay pending in a crowded context
//   session.compact   apply pending for compacts someone else started (manual, auto)
//   command.run       /clawd-mon [show|hide|status|choose|branch|reset|reset-all]
//   ui.render         the AbovePrompt band (Svg sprite on desktop, Image in the terminal)
//
// One save lives in $.store under "save" and is re-read before every change, so every
// session shares one companion. Live values the band draws are in $.state atoms.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClawdMonUsage } from '../types'
import {
  applyCompact,
  bankTokens,
  configFrom,
  DEFAULT_CONFIG,
  decayPending,
  execute,
  newSave,
  observeContext,
  progress,
  recommendation,
  sanitizeSave,
  type CompactTrigger,
  type Config,
  type Dex,
  type GameEvent,
  type Progress,
  type Save,
} from './engine'

const saveAtom = atom({ plugin: 'clawd-mon', key: 'save' } as const, null)
const usageAtom = atom({ plugin: 'clawd-mon', key: 'usage' } as const, null)
const hiddenAtom = atom({ plugin: 'clawd-mon', key: 'isHidden' } as const, false)

const COMMAND = 'clawd-mon'
const SAVE_KEY = 'save'
const HIDDEN_KEY = 'isHidden'
const GREEN = '#4CAF50'
const AMBER = '#E0A030'
const RED = '#E5534B'
const TRACK = '#80808040'
const SPRITE_PX = 64

// ---------- pure helpers (exported for tests) ----------

export function contextColor(percent: number | undefined, cfg: Config): string {
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
  if (p.kind === 'egg') {
    const starter = p.targetName ? ` (${p.targetName})` : ''
    return `Egg, crack ${p.stage}/${p.cracks}${starter}`
  }
  return `${p.name} Lv ${p.level}`
}

export function xpLine(p: Progress): string {
  return p.kind === 'egg'
    ? `XP ${Math.floor(p.xp)}/${p.nextXp}`
    : `XP ${Math.floor(p.into)}/${Math.floor(p.need)}`
}

export function pendingLine(p: Progress): string {
  const pending = `Pending +${Math.floor(p.pending)} XP`
  if (p.kind === 'egg') return `${pending}, applied on compact`
  if (!p.next) return `${pending}, fully evolved`
  return `${pending}, ${p.compacts}/${p.next.compactsNeeded} compacts for ${p.next.name} (Lv ${p.next.level})`
}

export function contextLine(usage: ClawdMonUsage | null): string {
  if (usage === null || usage.percent === undefined) return 'Context: no reading yet'
  return `Context ${usage.percent}%`
}

export function eventToast(ev: GameEvent, dex: Dex): string {
  const name = (id: number) => dex.species.find(s => s.id === id)?.name ?? `#${id}`
  switch (ev.kind) {
    case 'levelup':
      return `Level up: Lv ${ev.level}`
    case 'crack':
      return `The egg cracked (${ev.stage}/3)`
    case 'hatch':
      return `The egg hatched: ${name(ev.speciesId)}!`
    case 'evolve':
      return `${name(ev.from)} evolved into ${name(ev.to)}!`
  }
}

function spriteSvg(base64: string, animate: boolean): string {
  const css = animate
    ? `.bob{animation:bob 2.4s ease-in-out infinite}` +
      `@keyframes bob{0%,100%{transform:translateY(3px)}50%{transform:translateY(0)}}` +
      `@media (prefers-reduced-motion: reduce){.bob{animation:none}}`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SPRITE_PX}" height="${SPRITE_PX + 4}" viewBox="0 0 ${SPRITE_PX} ${SPRITE_PX + 4}">` +
    `<style>${css}</style>` +
    `<g class="bob"><image href="data:image/png;base64,${base64}" x="0" y="0" width="${SPRITE_PX}" height="${SPRITE_PX}" style="image-rendering:pixelated"/></g>` +
    `</svg>`
  )
}

// ---------- engine reads ----------

async function quietly(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    // A read the engine refused leaves the last value standing.
  }
}

let dexPromise: Promise<Dex> | null = null

/** The species and growth tables, read once from the plugin's data/ folder. */
function loadDex($: EngineInterface): Promise<Dex> {
  if (dexPromise === null) {
    const root = $.plugin.root
    dexPromise = Promise.all([
      $.fs.read(`${root}/data/pokedex.json`),
      $.fs.read(`${root}/data/growth.json`),
    ])
      .then(([species, growth]) => ({ species: JSON.parse(species), growth: JSON.parse(growth) }) as Dex)
      .catch(error => {
        dexPromise = null
        throw error
      })
  }
  return dexPromise
}

const sprites = new Map<string, string | null>()

/** Base64 PNG of a sprite from the plugin's assets, or null when the file is not there. */
async function loadSprite($: EngineInterface, key: number | 'egg'): Promise<string | null> {
  const name = String(key)
  const cached = sprites.get(name)
  if (cached !== undefined) return cached
  let base64: string | null = null
  try {
    const bytes = await $.fs.read(`${$.plugin.root}/assets/sprites/${name}.png`, { as: 'bytes' })
    base64 = bytes.base64
  } catch {
    base64 = null
  }
  sprites.set(name, base64)
  return base64
}

async function prefersReducedMotion($: EngineInterface): Promise<boolean> {
  try {
    const rows = await $.config.list()
    return rows.some(
      row => /reduc\w*\s*motion|reducedmotion/i.test(`${row.key} ${row.label}`) && row.value === true,
    )
  } catch {
    return false
  }
}

async function today($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 10)
}

// ---------- hooks ----------

let cfg: Config = DEFAULT_CONFIG
let reducedMotion = false
let chain: Promise<unknown> = Promise.resolve()
/** Bumped each time the session.compact hook applies a bank; lets Evolve see whether it ran. */
let appliedByHook = 0

/** Saves change one at a time: each re-reads the store, so sessions share one companion. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

async function loadSave($: EngineInterface, dex: Dex): Promise<Save> {
  return sanitizeSave(await $.store.get(SAVE_KEY), dex)
}

async function commit($: EngineInterface, save: Save): Promise<void> {
  await $.store.set(SAVE_KEY, save)
  await update($, saveAtom, () => save)
}

/**
 * Load, change, store, one at a time. Another session may write between our read and our
 * write, so the store is re-read before the write: if its rev moved, start over (3 tries).
 */
function mutate<T>(
  $: EngineInterface,
  dex: Dex,
  fn: (save: Save) => Promise<{ save: Save; value: T }> | { save: Save; value: T },
): Promise<T> {
  return exclusive(async () => {
    for (let attempt = 0; ; attempt++) {
      const loaded = await loadSave($, dex)
      const out = await fn(loaded)
      const current = await loadSave($, dex)
      if (current.rev !== loaded.rev && attempt < 2) continue
      await commit($, { ...out.save, rev: current.rev + 1 })
      return out.value
    }
  })
}

async function currentPercent($: EngineInterface): Promise<number | undefined> {
  try {
    const { context } = await $.session.usage()
    return context.percent
  } catch {
    return (await read($, usageAtom))?.percent
  }
}

/** Pulls the shared save into this session's atom when another session changed it. */
async function refreshSave($: EngineInterface): Promise<void> {
  const dex = await loadDex($)
  const fresh = await loadSave($, dex)
  const mine = await read($, saveAtom)
  if (mine === null || mine.rev !== fresh.rev) await update($, saveAtom, () => fresh)
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage()
  await update($, usageAtom, () => ({
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
  }))
}

/** Applies the bank for a compact that finished, and announces what it did. */
function applyFinishedCompact(
  $: EngineInterface,
  trigger: CompactTrigger,
  percent: number | undefined,
): Promise<void> {
  return loadDex($).then(async dex => {
    const result = await mutate($, dex, save => {
      const r = applyCompact(save, dex, { trigger, percent }, cfg)
      return { save: r.save, value: r }
    })
    for (const ev of result.events) $.ui.toast(eventToast(ev, dex))
  })
}

export const register: Register = (on, options) => {
  cfg = configFrom(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await quietly(
      $.command.register({
        name: COMMAND,
        description: 'Clawd-mon companion: show, hide, status, choose, branch, reset, reset-all',
        argumentHint: '[show|hide|status|choose <name>|branch <name>|reset|reset-all]',
        immediate: true,
      }),
    )
    reducedMotion = await prefersReducedMotion($)

    await quietly(
      (async () => {
        const dex = await loadDex($)
        const save = await loadSave($, dex)
        await update($, saveAtom, () => save)
        await update($, hiddenAtom, () => false)
        if ((await $.store.get(HIDDEN_KEY)) === true) await update($, hiddenAtom, () => true)
      })(),
    )
    await quietly(refreshUsage($))

    return started
  })

  on('session.measure', async ($, e, next) => {
    const c = e.context
    await quietly(update($, usageAtom, () => ({ tokens: c.tokens, window: c.window, percent: c.percent })))
    await quietly(refreshSave($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await quietly(
      loadDex($).then(dex => mutate($, dex, async loaded => {
        let save = loaded
        const isMain = e.agentId === undefined
        let ctxTokens: number | undefined
        let percent: number | undefined
        if (isMain) {
          try {
            const { context } = await $.session.usage()
            ctxTokens = context.tokens
            percent = context.percent
            await update($, usageAtom, () => ({ tokens: context.tokens, window: context.window, percent }))
          } catch {
            // No reading this turn: bank what we know, skip decay and projection.
          }
        }
        // New tokens only: cache reads re-count the same context every step.
        let tokens = 0
        if (e.usage) {
          tokens = e.usage.input_tokens + e.usage.output_tokens + e.usage.cache_creation_input_tokens
        } else if (ctxTokens !== undefined && save.lastContext !== null && ctxTokens > save.lastContext) {
          tokens = ctxTokens - save.lastContext
        }
        save = bankTokens(save, tokens, await today($), cfg)
        if (isMain) {
          save = decayPending(save, percent, cfg)
          save = observeContext(save, ctxTokens)
        }
        return { save, value: undefined }
      })),
    )
    return done
  })

  // The place the bank is applied for any compact that reaches this hook (manual, auto, plugin).
  // Evolve's own compact normally comes through here too; the button only applies the bank itself
  // when the hook did not see it, so it is never applied twice.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const percent = await currentPercent($)
    const result = await next(e)
    if ('skip' in result) return result
    await quietly(applyFinishedCompact($, e.trigger, percent))
    appliedByHook += 1
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const dex = await loadDex($)
    const day = await today($)
    const result = await mutate($, dex, save => {
      const r = execute(save, dex, e.args, { day })
      return { save: r.save, value: r }
    })
    if (result.wipe) {
      for (const key of await $.store.keys()) await $.store.delete(key)
      await update($, saveAtom, () => result.save)
      await update($, hiddenAtom, () => false)
      return { text: result.text }
    }
    if (result.hide) {
      await $.store.set(HIDDEN_KEY, true)
      await update($, hiddenAtom, () => true)
    } else if (result.show) {
      await $.store.delete(HIDDEN_KEY)
      await update($, hiddenAtom, () => false)
    }
    await quietly(refreshUsage($))
    return { text: result.text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)

    let dex: Dex
    try {
      dex = await loadDex($)
    } catch {
      return next(e)
    }
    const stored = await read($, saveAtom)
    const save = stored ?? sanitizeSave(await $.store.get(SAVE_KEY).catch(() => undefined), dex)
    const usage = await read($, usageAtom)
    const p = progress(save, dex)
    const rec = recommendation(
      { percent: usage?.percent, tokens: usage?.tokens, window: usage?.window ?? 0 },
      save,
      cfg,
    )
    const sprite = await loadSprite($, p.kind === 'egg' ? 'egg' : p.id)

    const title = titleOf(p)
    const xp = xpLine(p)
    const pending = pendingLine(p)
    const ctx = contextLine(usage)
    const advice = rec.recommend
      ? rec.reason === 'projected'
        ? 'Evolve recommended: context is filling fast'
        : `Evolve recommended: context at ${usage?.percent}%`
      : ''
    const isWorking = e.props.isWorking
    const hide = async () => {
      await update($, hiddenAtom, () => true)
      await $.store.set(HIDDEN_KEY, true)
    }
    const evolve = async () => {
      if (isWorking) {
        $.ui.toast('Clawd-mon: wait for the turn to finish, then Evolve.')
        return
      }
      const percent = await currentPercent($)
      const seenBefore = appliedByHook
      try {
        const result = await $.session.compact()
        if ('skip' in result) {
          $.ui.toast(`Clawd-mon: compact skipped (${result.skip})`)
          return
        }
      } catch {
        $.ui.toast('Clawd-mon: could not compact right now.')
        return
      }
      if (appliedByHook === seenBefore) await applyFinishedCompact($, 'plugin', percent)
    }
    const barColor = contextColor(usage?.percent, cfg)

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Image } = $.ui.resolve(e)
      const bar = (f: number) => textBar(f, 20)
      return (
        <Box flexDirection="row" gap={2}>
          {sprite ? (
            <Image key="sprite" source={{ png: sprite }} columns={8} rows={4} alt={title} />
          ) : null}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" gap={2}>
              <Box flexGrow={1}>
                <Text bold wrap="truncate-end">{title}</Text>
              </Box>
              <Button
                key="evolve"
                label="Evolve"
                hotkey="e"
                variant={rec.recommend ? 'primary' : 'secondary'}
                dimColor={isWorking}
                onPress={evolve}
              />
              <Button key="hide" label="×" plain dimColor role="dismiss" onPress={hide} />
            </Box>
            <Text color={GREEN}>{`${bar(p.kind === 'egg' ? p.fraction : p.fraction)} ${xp}`}</Text>
            <Text dimColor wrap="truncate-end">{pending}</Text>
            <Text color={barColor}>{`${bar((usage?.percent ?? 0) / 100)} ${ctx}`}</Text>
            {advice ? <Text color={AMBER} bold>{advice}</Text> : null}
          </Box>
        </Box>
      )
    }

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%` as const
    const barRow = (fraction: number, color: string) => (
      <Box flexDirection="row" width="100%" height={1}>
        {fraction > 0 ? <Box width={pct(fraction)} height={1} backgroundColor={color} /> : null}
        <Box flexGrow={1} height={1} backgroundColor={TRACK} />
      </Box>
    )
    return (
      <Box flexDirection="row" alignItems="center" gap={2} width="100%">
        {sprite && 'Svg' in table ? (
          <table.Svg source={spriteSvg(sprite, !reducedMotion)} alt={title} width={SPRITE_PX} height={SPRITE_PX + 4} />
        ) : null}
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>{title}</Text>
          {barRow(p.fraction, GREEN)}
          <Text dimColor>{`${xp} · ${pending}`}</Text>
          {barRow((usage?.percent ?? 0) / 100, barColor)}
          <Text color={barColor}>{ctx}</Text>
          {advice ? <Text color={AMBER} bold>{advice}</Text> : null}
        </Box>
        <Button
          key="evolve"
          label="Evolve"
          hotkey="e"
          variant={rec.recommend ? 'primary' : 'secondary'}
          onPress={evolve}
        />
        <Button key="hide" label="×" plain dimColor role="dismiss" onPress={hide} />
      </Box>
    )
  })
}
