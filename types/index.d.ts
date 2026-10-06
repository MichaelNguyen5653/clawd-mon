// State contract for the Clawd-mon mod. Every value here lives in the host's
// $.state, so it survives hot reloads of the hooks module. The durable copy of
// the save is in $.store, shared by every session.

/** Lifetime totals; wiped only by `reset-all`. */
export type ClawdMonLifetime = {
  tokens: number
  xp: number
  compacts: number
  hatches: number
  evolutions: number
  /** Finished lines: final-form evolutions plus single-stage Lv 40 claims. */
  fullLines: number
}

/** One Pokémon or egg in the box. */
export type ClawdMonEntry = {
  /** Short uid, unique in the box. */
  id: string
  phase: 'egg' | 'mon'
  /** Egg: the species inside, rolled when the egg was made. */
  target: number | null
  /** Pokedex id of the hatched Pokémon; null while an egg. */
  speciesId: number | null
  /** True when the player picked the egg's species (its name may then show). */
  chosen: boolean
  /** Egg: raw applied XP. Mon: effective XP (already dragged by base stats). */
  xp: number
  /** Egg: cracks so far (0-2). */
  eggStage: 0 | 1 | 2
  /** Qualifying compacts since hatch. */
  compacts: number
  /** Evolution picked for a branching species. */
  branch: number | null
  origin: 'starter' | 'evolved' | 'milestone' | 'mastery' | 'legendary'
  /** A single-stage species already paid out its Lv 40 egg. */
  eggClaimed: boolean
}

/** Counters behind the legendary goals. */
export type ClawdMonStreaks = {
  /** Finished days in a row with a main turn and context under the danger percent. */
  coolDays: number
  /** The day (UTC YYYY-MM-DD) of the latest main turn; its fate is settled when a later day starts. */
  coolDay: string | null
  /** That day reached the danger percent. */
  coolBroken: boolean
  /** Qualifying non-auto compacts in a row; an auto-compact resets it. */
  strike: number
}

/** The whole save: the box, the shared pending bank and the lifetime totals. */
export type ClawdMonSave = {
  version: 2
  /** Bumped on every write; a writer that finds it moved re-reads and retries. */
  rev: number
  /** Banked tokens as XP, not yet applied. Goes to whoever is active at compact time. */
  pending: number
  /** Counted compacts toward the next bonus egg, 0-24. */
  milestone: number
  activeId: string
  box: ClawdMonEntry[]
  lifetime: ClawdMonLifetime
  /** Species caught (hatched, or evolved into), by Pokedex id, ascending. */
  dex: number[]
  /** Legendary eggs earned this save (never twice), by Pokedex id. */
  legendsEarned: number[]
  streaks: ClawdMonStreaks
  /** Raw XP banked per UTC day (YYYY-MM-DD), last 14 days. */
  daily: Record<string, number>
  /** Recent positive context growth per turn, in tokens, last 5. */
  growth: number[]
  /** Context tokens at the last observation. */
  lastContext: number | null
}

/** Context window fill, as the status line reads it. */
export type ClawdMonUsage = {
  /** Input tokens of the last response; absent before the first response. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
  /** tokens / window, 0-100; absent before the first response. */
  percent?: number
}

/** Tools: what the model can call now, and what this session called. */
export type ClawdMonTools = {
  /** Tools the model can call now ($.tool.list()); null until first read. */
  available: number | null
  /** Of `available`, how many are MCP tools. */
  mcp: number
  /** Distinct tool names called this session (main loop and subagents). */
  usedNames: string[]
  /** Tool calls this session (main loop and subagents). */
  calls: number
  /** True once the count was seeded from the transcript (calls before load). */
  seeded: boolean
}

/** Agents: subagents and teammates of this session ($.agent.list()). */
export type ClawdMonAgents = {
  /** null until first read. */
  running: number | null
  total: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-mon': {
      /** The save this session works from; null until loaded. */
      save: ClawdMonSave | null
      usage: ClawdMonUsage | null
      isHidden: boolean
      /** This session: the dex view is open (closes the help, and the reverse). */
      dexOpen: boolean
      /** This session: the in-band help is open. */
      hintOpen: boolean
      /** Per session, not shared: tools and agents of this session. */
      tools: ClawdMonTools
      agents: ClawdMonAgents
    }
  }
}
