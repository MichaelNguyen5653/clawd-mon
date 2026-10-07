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

import {
  applyCompact,
  bankTokens,
  configFrom,
  DEFAULT_CONFIG,
  decayPending,
  dexView,
  execute,
  observeContext,
  observeTurn,
  overview,
  progress,
  recommendation,
  sanitizeSave,
  ensureTarget,
  type CompactTrigger,
  type Config,
  type Dex,
  type Save,
} from './engine'
import {
  AMBER,
  GREEN,
  RARITY_COLOR,
  TRACK,
  actionsRows,
  adviceLine,
  rarityLabel,
  dexRows,
  hintRows,
  milestoneLine,
  contextColor,
  statsLine,
  eventToast,
  pendingLine,
  spriteSvg,
  textBar,
  titleOf,
  xpLine,
  type Box as SpriteBox,
} from './view'

const saveAtom = atom({ plugin: 'clawd-mon', key: 'save' } as const, null)
const usageAtom = atom({ plugin: 'clawd-mon', key: 'usage' } as const, null)
const hiddenAtom = atom({ plugin: 'clawd-mon', key: 'isHidden' } as const, false)
const hintAtom = atom({ plugin: 'clawd-mon', key: 'hintOpen' } as const, false)
const dexAtom = atom({ plugin: 'clawd-mon', key: 'dexOpen' } as const, false)
const toolsAtom = atom({ plugin: 'clawd-mon', key: 'tools' } as const, {
  available: null,
  mcp: 0,
  usedNames: [],
  calls: 0,
  seeded: false,
})
const agentsAtom = atom({ plugin: 'clawd-mon', key: 'agents' } as const, { running: null, total: null, list: [] })
const tabAtom = atom({ plugin: 'clawd-mon', key: 'tab' } as const, 'actions')
const activityAtom = atom({ plugin: 'clawd-mon', key: 'activity' } as const, { doing: {}, busy: false, task: null, tasks: {} })
/** The Actions tab clips each row to this many characters so it never wraps. */
const ACTIONS_WIDTH = 72
const AGENT_TICK_MS = 4000

const COMMAND = 'clawd-mon'
const SAVE_KEY = 'save'
const HIDDEN_KEY = 'isHidden'
const SPRITE_PX = 80

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

let boundsPromise: Promise<Record<string, SpriteBox>> | null = null

/** Content boxes of the sprites (data/sprite-bounds.json); empty when the file is missing. */
function loadBounds($: EngineInterface): Promise<Record<string, SpriteBox>> {
  if (boundsPromise === null) {
    boundsPromise = $.fs
      .read(`${$.plugin.root}/data/sprite-bounds.json`)
      .then(text => JSON.parse(text) as Record<string, SpriteBox>)
      .catch(() => ({}) as Record<string, SpriteBox>)
  }
  return boundsPromise
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
  return ensureTarget(sanitizeSave(await $.store.get(SAVE_KEY), dex), dex)
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

async function refreshTools($: EngineInterface): Promise<void> {
  const list = await $.tool.list()
  const mcp = list.filter(t => t.mcp).length
  const prev = await read($, toolsAtom)
  if (prev.available === list.length && prev.mcp === mcp) return
  await update($, toolsAtom, t => ({ ...t, available: list.length, mcp }))
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const all = await $.agent.list()
  const running = all.filter(a => a.status === 'running').length
  const list = all.map(a => ({ id: a.id, name: a.name, type: a.type, description: a.description, status: a.status }))
  const prev = await read($, agentsAtom)
  if (prev.running === running && prev.total === all.length && JSON.stringify(prev.list) === JSON.stringify(list)) return
  await update($, agentsAtom, () => ({ running, total: all.length, list }))
}

/** The in-progress item of a TodoWrite list: its present-tense text, or null when none is. */
function todoTask(todos: unknown): string | null {
  if (!Array.isArray(todos)) return null
  const t = todos.find(x => x && typeof x === 'object' && (x as { status?: unknown }).status === 'in_progress') as
    | { content?: unknown; activeForm?: unknown }
    | undefined
  const text = t ? (t.activeForm ?? t.content) : null
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

type CallFacts = { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>

/** A loop started a tool call: that is what it is doing now. */
function startCall($: EngineInterface, e: CallFacts): Promise<void> {
  const skill = e.tool === 'Skill' && typeof e.skill === 'string' ? e.skill : undefined
  return update($, activityAtom, a => ({ ...a, doing: { ...a.doing, [e.agentId ?? '']: { callId: e.tool_use_id, tool: e.tool, skill } } }))
}

/** That call ended: the loop goes back to thinking, unless a later call already took its place. */
function endCall($: EngineInterface, e: CallFacts): Promise<void> {
  const loop = e.agentId ?? ''
  return update($, activityAtom, a => {
    if (a.doing[loop]?.callId !== e.tool_use_id) return a
    const { [loop]: _gone, ...doing } = a.doing
    return { ...a, doing }
  })
}

/** The main loop's task list (TodoWrite, or TaskCreate / TaskUpdate) names the task in progress. */
async function trackTask($: EngineInterface, e: CallFacts, result: unknown): Promise<void> {
  if (e.agentId !== undefined) return
  const tool = e.tool
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  if (tool === 'TodoWrite') {
    await update($, activityAtom, a => ({ ...a, task: todoTask(e.todos) }))
  } else if (tool === 'TaskCreate') {
    const id = str((result as { result?: { task?: { id?: unknown } } })?.result?.task?.id)
    const text = str(e.activeForm) ?? str(e.subject)
    if (id && text) await update($, activityAtom, a => ({ ...a, tasks: { ...a.tasks, [id]: { text, status: 'pending' } } }))
  } else if (tool === 'TaskUpdate') {
    const id = str(e.taskId)
    if (!id) return
    await update($, activityAtom, a => {
      const was = a.tasks[id]
      const text = str(e.activeForm) ?? str(e.subject) ?? was?.text ?? `Task ${id}`
      const status = str(e.status) ?? was?.status ?? 'pending'
      const tasks = { ...a.tasks, [id]: { text, status } }
      const current = Object.values(tasks).find(t => t.status === 'in_progress')
      return { ...a, tasks, task: current?.text ?? null }
    })
  }
}

/** Counts tool calls made before the mod loaded, from the main transcript, once. */
async function seedTools($: EngineInterface): Promise<void> {
  const tools = await read($, toolsAtom)
  if (tools.seeded) return
  const messages = await $.session.messages()
  const names = new Set<string>(tools.usedNames)
  let calls = 0
  for (const m of messages) {
    for (const use of m.toolUses) {
      names.add(String(use.tool))
      calls += 1
    }
  }
  await update($, toolsAtom, t => ({
    ...t,
    usedNames: [...new Set([...t.usedNames, ...names])],
    calls: t.calls + calls,
    seeded: true,
  }))
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
        // Eggs without a species get a hidden one now, and every session then shares it.
        const stored = sanitizeSave(await $.store.get(SAVE_KEY), dex)
        const rawSave = await $.store.get(SAVE_KEY)
        const rawEarned =
          typeof rawSave === 'object' && rawSave !== null && Array.isArray((rawSave as { legendsEarned?: unknown }).legendsEarned)
            ? (rawSave as { legendsEarned: unknown[] }).legendsEarned.length
            : -1
        if (ensureTarget(stored, dex) !== stored || stored.legendsEarned.length !== rawEarned) {
          await mutate($, dex, fresh => ({ save: fresh, value: null }))
        }
        const save = await loadSave($, dex)
        await update($, saveAtom, () => save)
        await update($, hiddenAtom, () => false)
        if ((await $.store.get(HIDDEN_KEY)) === true) await update($, hiddenAtom, () => true)
      })(),
    )
    await quietly(refreshUsage($))
    await quietly(seedTools($))
    await quietly(refreshTools($))
    await quietly(refreshAgents($))
    $.clock.every(AGENT_TICK_MS, () => {
      void refreshAgents($).catch(() => undefined)
    })

    return started
  })

  on('session.measure', async ($, e, next) => {
    const c = e.context
    await quietly(update($, usageAtom, () => ({ tokens: c.tokens, window: c.window, percent: c.percent })))
    await quietly(refreshSave($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    await quietly(
      update($, toolsAtom, t => ({
        ...t,
        calls: t.calls + 1,
        usedNames: t.usedNames.includes(name) ? t.usedNames : [...t.usedNames, name],
      })),
    )
    const facts = { ...(e as Record<string, unknown>), tool: name, tool_use_id: e.tool_use_id, agentId: e.agentId }
    await quietly(startCall($, facts))
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      await quietly(endCall($, facts))
    }
    await quietly(trackTask($, facts, ran))
    if (name === 'Agent' || name === 'Task') await quietly(refreshAgents($))
    return ran
  })

  // A foreground agent blocks the loop that spawned it until it returns.
  on('agent.spawn', async ($, e, next) => {
    const done = await next(e)
    const child = 'agentId' in done ? done.agentId : undefined
    if (child && !e.background) {
      const loop = e.parentAgentId ?? ''
      await quietly(
        update($, activityAtom, a => {
          const was = a.doing[loop]
          return was ? { ...a, doing: { ...a.doing, [loop]: { ...was, waitingOn: child } } } : a
        }),
      )
    }
    await quietly(refreshAgents($))
    return done
  })

  on('turn.start', async ($, e, next) => {
    await quietly(update($, activityAtom, a => ({ ...a, busy: true })))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A loop that finished its turn is doing nothing; only the main loop's end clears `busy`.
    const loop = e.agentId ?? ''
    await quietly(
      update($, activityAtom, a => {
        const { [loop]: _done, ...doing } = a.doing
        return { ...a, busy: loop === '' ? false : a.busy, doing }
      }),
    )
    await quietly(refreshTools($))
    await quietly(refreshAgents($))
    await quietly(
      loadDex($).then(async dex => {
        const events = await mutate($, dex, async loaded => {
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
        const found = isMain ? observeTurn(save, { day: await today($), percent }, dex, cfg) : { save, events: [] }
        return { save: found.save, value: found.events }
      })
        for (const ev of events) $.ui.toast(eventToast(ev, dex))
      }),
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
      const r = execute(save, dex, e.args, { day, cfg })
      return { save: r.save, value: r }
    })
    if (result.wipe) {
      for (const key of await $.store.keys()) await $.store.delete(key)
      await update($, saveAtom, () => result.save)
      await update($, hiddenAtom, () => false)
      return { text: result.text }
    }
    if (result.hint) {
      await update($, hintAtom, () => true)
      await update($, dexAtom, () => false)
    }
    if (result.dex) {
      await update($, dexAtom, () => true)
      await update($, hintAtom, () => false)
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
    const save =
      stored ?? ensureTarget(sanitizeSave(await $.store.get(SAVE_KEY).catch(() => undefined), dex), dex)
    const usage = await read($, usageAtom)
    const p = progress(save, dex)
    const rec = recommendation(
      { percent: usage?.percent, tokens: usage?.tokens, window: usage?.window ?? 0 },
      save,
      cfg,
    )
    const spriteKey = p.kind === 'egg' ? 'egg' : p.id
    const sprite = await loadSprite($, spriteKey)
    const bounds = (await loadBounds($))[String(spriteKey)]

    const title = titleOf(p)
    const xp = xpLine(p)
    const pending = pendingLine(p)
    const tools = await read($, toolsAtom)
    const agents = await read($, agentsAtom)
    const ctx = statsLine(usage, tools, agents)
    const advice = adviceLine(rec, usage, cfg)
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
      } catch (err) {
        // Headless (-p / SDK, the desktop Code tab) refuses a plugin's own compact; a queued /compact
        // still runs there. The session.compact hook applies the bank when it does, so not here.
        try {
          await $.command.run({ command: 'compact' })
          return
        } catch {
          // Say why: the engine's reason is the only clue to a refusal (a turn running, a bad state)
          const why = (err instanceof Error ? err.message : String(err)).trim().slice(0, 200)
          $.ui.toast(`Clawd-mon: could not compact right now${why ? ` (${why})` : ''}.`)
          return
        }
      }
      if (appliedByHook === seenBefore) await applyFinishedCompact($, 'plugin', percent)
    }
    const barColor = contextColor(usage?.percent, cfg)
    const hintOpen = await read($, hintAtom)
    const dexOpen = await read($, dexAtom)
    const openHint = async () => {
      await update($, hintAtom, () => true)
      await update($, dexAtom, () => false)
    }
    const closeHint = () => update($, hintAtom, () => false)
    const openDex = async () => {
      await update($, dexAtom, () => true)
      await update($, hintAtom, () => false)
    }
    const closeDex = () => update($, dexAtom, () => false)
    const dexData = dexOpen ? dexView(save, dex, cfg) : null
    const milestone = milestoneLine(overview(save))
    // Actions (default): what is happening now, in at most three rows, so it never outgrows Levels.
    const tab = await read($, tabAtom)
    const isActions = tab === 'actions'
    const showActions = () => update($, tabAtom, () => 'actions' as const)
    const showLevels = () => update($, tabAtom, () => 'levels' as const)
    // `?? []`: a hot reload keeps the state an older module wrote, which had no list.
    const actions = isActions ? actionsRows(await read($, activityAtom), agents.list ?? [], 3, ACTIONS_WIDTH) : []
    const ctxPercent = usage?.percent !== undefined ? `${usage.percent}%` : '—'

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Image } = $.ui.resolve(e)
      const bar = (f: number) => textBar(f, 20)
      const band = (
        <Box flexDirection="row" gap={2}>
          {sprite ? (
            <Image key="sprite" source={{ png: sprite }} columns={8} rows={4} alt={title} />
          ) : null}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" gap={2}>
              <Box flexGrow={1} flexDirection="row" gap={1}>
                <Button key="tab-actions" label="Actions" plain dimColor={!isActions} onPress={showActions} />
                <Button key="tab-levels" label="Levels" plain dimColor={isActions} onPress={showLevels} />
                <Text bold wrap="truncate-end">{title}</Text>
                {p.kind === 'mon' ? (
                  <Text key="rarity" color={RARITY_COLOR[p.rarity]} bold>{`[${rarityLabel(p.rarity)}]`}</Text>
                ) : null}
                {isActions ? <Text key="ctx" color={barColor}>{ctxPercent}</Text> : null}
                <Button key="hint" label="!hint" plain dimColor onPress={openHint} />
                <Button key="dex" label="dex" plain dimColor onPress={openDex} />
                {isActions ? null : <Text dimColor wrap="truncate-end">{milestone}</Text>}
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
            {isActions ? (
              actions.map((line, i) => (
                <Text key={`act-${i}`} dimColor={i > 0} wrap="truncate-end">{line}</Text>
              ))
            ) : (
              [
                <Text key="xp" color={GREEN}>{`${bar(p.fraction)} ${xp}`}</Text>,
                <Text key="pending" dimColor wrap="truncate-end">{pending}</Text>,
                <Text key="ctx-bar" color={barColor}>{`${bar((usage?.percent ?? 0) / 100)} ${ctx}`}</Text>,
              ]
            )}
            {advice ? <Text color={AMBER} bold>{advice}</Text> : null}
          </Box>
        </Box>
      )
      if (dexData) {
        const budget = Math.max(1, e.props.maxRows - (advice ? 5 : 4) - 1)
        return (
          <Box flexDirection="column">
            {band}
            {dexRows(dexData, budget).map((row, i) => (
              <Text key={`dex-${i}`} dimColor={i > 0} bold={i === 0} wrap="truncate-end">{row}</Text>
            ))}
            <Button key="dex-cancel" label="Cancel" onPress={closeDex} />
          </Box>
        )
      }
      if (!hintOpen) return band
      // The band takes 4 rows (5 with advice); the rest of maxRows is for help, Cancel always shown.
      const budget = Math.max(1, e.props.maxRows - (advice ? 5 : 4) - 1)
      return (
        <Box flexDirection="column">
          {band}
          {hintRows(cfg, budget).map((row, i) => (
            <Text key={`hint-${i}`} dimColor wrap="truncate-end">{row}</Text>
          ))}
          <Button key="hint-cancel" label="Cancel" onPress={closeHint} />
        </Box>
      )
    }

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%` as const
    const barRow = (fraction: number, color: string, key?: string) => (
      <Box key={key} flexDirection="row" width="100%" height={1}>
        {fraction > 0 ? <Box width={pct(fraction)} height={1} backgroundColor={color} /> : null}
        <Box flexGrow={1} height={1} backgroundColor={TRACK} />
      </Box>
    )
    const row = (
      <Box flexDirection="row" alignItems="center" gap={2} width="100%">
        {sprite && 'Svg' in table ? (
          <table.Svg
            source={spriteSvg({ base64: sprite, bounds, size: SPRITE_PX, animate: !reducedMotion, crack: p.kind === 'egg' ? p.stage : 0 })}
            alt={title}
            width={SPRITE_PX}
            height={SPRITE_PX}
          />
        ) : null}
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Button key="tab-actions" label="Actions" plain dimColor={!isActions} onPress={showActions} />
            <Button key="tab-levels" label="Levels" plain dimColor={isActions} onPress={showLevels} />
            <Text bold>{title}</Text>
            {p.kind === 'mon' ? (
              <Box key="rarity" backgroundColor={RARITY_COLOR[p.rarity]}>
                <Text color="#FFFFFF" bold>{` ${rarityLabel(p.rarity)} `}</Text>
              </Box>
            ) : null}
            {isActions ? <Text key="ctx" color={barColor}>{ctxPercent}</Text> : null}
            <Button key="hint" label="!hint" plain dimColor onPress={openHint} />
            <Button key="dex" label="dex" plain dimColor onPress={openDex} />
            {isActions ? null : <Text dimColor>{milestone}</Text>}
          </Box>
          {isActions ? (
            actions.map((line, i) => (
              <Text key={`act-${i}`} dimColor={i > 0}>{line}</Text>
            ))
          ) : (
            [
              barRow(p.fraction, GREEN, 'xp-bar'),
              <Text key="xp" dimColor>{`${xp} · ${pending}`}</Text>,
              barRow((usage?.percent ?? 0) / 100, barColor, 'ctx-bar'),
              <Text key="ctx" color={barColor}>{ctx}</Text>,
            ]
          )}
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
    if (dexData) {
      const sprites = await Promise.all(dexData.rows.map(r => loadSprite($, r.id)))
      const boundsAll = await loadBounds($)
      return (
        <Box flexDirection="column" width="100%" gap={1}>
          {row}
          <Text bold>{dexRows(dexData, 2)[0]}</Text>
          <Text dimColor>{dexRows(dexData, 2)[1]}</Text>
          {dexData.rows.map((r, i) => {
            const b64 = sprites[i]
            const state = r.earned ? 'earned' : r.locked ? 'locked' : `${r.progress?.n ?? 0}/${r.progress?.goal ?? 0}`
            return (
              <Box flexDirection="row" alignItems="center" gap={2} width="100%">
                {b64 && 'Svg' in table ? (
                  <table.Svg
                    source={spriteSvg({ base64: b64, bounds: boundsAll[String(r.id)], size: 48, animate: false, silhouette: !r.earned })}
                    alt={r.earned ? r.name : 'Unknown legendary'}
                    width={48}
                    height={48}
                  />
                ) : null}
                <Box flexDirection="column" flexGrow={1}>
                  <Text bold>{`${r.earned ? '★ ' : ''}${r.name}`}</Text>
                  <Text dimColor>{r.lore}</Text>
                  <Text>{r.goal}</Text>
                  {r.progress ? barRow(r.progress.n / r.progress.goal, r.earned ? GREEN : AMBER) : null}
                  <Text dimColor>{state}</Text>
                </Box>
              </Box>
            )
          })}
          <Box flexDirection="row">
            <Button key="dex-cancel" label="Cancel" onPress={closeDex} />
          </Box>
        </Box>
      )
    }
    if (!hintOpen) return row
    return (
      <Box flexDirection="column" width="100%" gap={1}>
        {row}
        <Box flexDirection="column" width="100%">
          {hintRows(cfg, 99).map((line, i) => (
            <Text key={`hint-${i}`} dimColor>{line}</Text>
          ))}
        </Box>
        <Box flexDirection="row">
          <Button key="hint-cancel" label="Cancel" onPress={closeHint} />
        </Box>
      </Box>
    )
  })
}
