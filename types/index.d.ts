// State contract for the Clawd-mon mod. Every value here lives in the host's
// $.state, so it survives hot reloads of the hooks module. The durable copy of
// the save is in $.store, shared by every session.

/** Lifetime totals; survive `reset`, wiped by `reset-all`. */
export type ClawdMonLifetime = {
  tokens: number
  xp: number
  compacts: number
  hatches: number
  evolutions: number
}

/** The whole companion save. */
export type ClawdMonSave = {
  v: 1
  /** Bumped on every write; a writer that finds it moved re-reads and retries. */
  rev: number
  phase: 'egg' | 'mon'
  /** Egg: cracks so far (0-2). */
  eggStage: 0 | 1 | 2
  /** Starter picked for the egg; null = random at hatch. */
  target: number | null
  /** Pokedex id of the hatched companion; null while an egg. */
  speciesId: number | null
  /** Egg: raw applied XP. Mon: effective XP (already dragged by base stats). */
  xp: number
  /** Banked tokens as XP, not yet applied by a compact. */
  pending: number
  /** Qualifying compacts since hatch (egg phase: since the egg started). */
  compacts: number
  /** Evolution picked for a branching species. */
  branch: number | null
  lifetime: ClawdMonLifetime
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

declare module 'claude-code' {
  interface PluginState {
    'clawd-mon': {
      /** The save this session works from; null until loaded. */
      save: ClawdMonSave | null
      usage: ClawdMonUsage | null
      isHidden: boolean
    }
  }
}
