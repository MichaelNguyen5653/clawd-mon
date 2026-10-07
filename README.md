# Clawd-mon

Pokémon companion above the Claude Code prompt. Starts as an egg. Grows on tokens you spend. Unofficial fan project.

Tokens bank as **pending XP**. **Evolve** = compact the conversation + apply the bank. Long context? It tells you when to compact.

## Install

```bash
claude plugin marketplace add MichaelNguyen5653/clawd-mon  # or a local path
claude plugin install clawd-mon@clawd-mon --scope user     # global, every project
claude plugin install clawd-mon@clawd-mon --scope project  # this repo only
```

Private repo → collaborators only:

- Accept the GitHub invite. Git must reach the repo (`gh auth login`, SSH key, or Git Credential Manager). Test: `git clone https://github.com/MichaelNguyen5653/clawd-mon.git`.
- Short form fails → full URL: `claude plugin marketplace add https://github.com/MichaelNguyen5653/clawd-mon.git`.
- Background auto-update needs `GITHUB_TOKEN` (or `GH_TOKEN`) with read access. Without it: `claude plugin marketplace update clawd-mon`, then restart.

One save across all sessions (`$.store`). No machine paths; scope = install scope.

Needs a Claude Code build with function hooks (plugin `modules`). Desktop draws the sprite as SVG; terminal uses the Image element (kitty graphics, e.g. kitty/Ghostty), alt text elsewhere.

## Rules

| What | Rule |
|---|---|
| XP source | New tokens per turn (input + output + cache writes; cache reads excluded). `xpRate` XP per 1,000 tokens (default 1). Fallback: positive context growth |
| Pending | Tokens bank as pending. Not applied until a compact |
| Apply | Evolve button / manual `/compact` / plugin: 100%. Auto-compact: 50%, rest forfeited |
| Decay | Context ≥ `dangerPercent` (80): pending −2% per completed turn |
| Recommend | Context ≥ `recommendPercent` (60), or avg growth (last 5 turns) projects ≥ 80% within 3 turns |
| Qualifying compact | Context ≥ 40% when it ran. Counts toward gates. Lower: XP still applies |
| Egg | Species fixed when the egg is made: random first-stage non-legendary, hidden until hatch (only a `choose`n starter shows its name). Roll by rarity tier: Starter 5%, Common 55%, Uncommon 30%, Rare 10%. Hatch level H = clamp(round(BST/60), 4, 10) (Caterpie 4, Bulbasaur 5, Mewtwo 10). Egg XP to hatch = 600 × H, on a 1.5 power curve. Two cracks on the way, then hatch; each stage needs a qualifying compact, max one stage per compact. Cracks show as lines on the egg. The band shows egg level and XP, never when the next stage comes. Hatches at Lv H |
| Rarity | Per evolution line. Starter: ids 1–9 (9). Rare: gift/fossil/special lines, `RARE_ROOTS` (23). Uncommon: other lines whose strongest form has BST ≥ 490 (55). Common: the rest (59). Legendary: goals only (5). Hatched Pokémon show a colored tier banner beside the name; hatch toast names the tier |
| Level | Species growth table (fast/medium/medium-slow/slow). Applied XP × clamp((320/BST)^0.35, 0.6, 1.1). Lv 1–100 |
| Evolution | Level ≥ species level AND qualifying compacts since hatch: 3 (first), 8 (second). Item: Lv 30. Trade: Lv 36 |
| Branches | Eevee etc.: first by default, `/clawd-mon branch <name>` picks |
| Box | Many Pokémon and eggs. Only the active one gains XP; pending goes to whoever is active at compact time. `switch` is free |
| Bonus eggs | +1 egg when the active one evolves into a final form (origin `evolved`); +1 once when a single-stage species hits Lv 40 (`mastery`); +1 every 25 counted compacts. New eggs wait in the box, never auto-active. Band shows `New egg (n/25)` and `Box N` |
| Pace | Bulbasaur → Venusaur ≈ 30 days at ~1.5M tokens/day, one compact a day alternating manual/auto (23 days all manual) |

Evolve is a no-op with a toast while a turn runs. Evolution is checked at compact time only.

## Band tabs

Two tabs at the start of the title row (selected bright, other dim). Actions is the default each session.

| Tab | Shows |
|---|---|
| Actions | Title row with context `62%` (no milestone). Then a summary of now, never a log: `Current action - …`, one `Agent N - [name - ]…` row per live agent. Max 3 rows; extra agents fold into `(+N more)`. Rows clipped to 72 chars. Never taller than Levels |
| Levels | The band as before: XP and pending, context bar, agents/tools stats, `New egg (n/25)` |

Current action: in-progress task (`TodoWrite` / `TaskUpdate`) → `Waiting on Agent N` (foreground agent) → tool label → `Thinking` (turn running) → `Idle`.

| Tool | Label |
|---|---|
| Read, Grep, Glob, LSP, ToolSearch | Gathering context |
| Edit, MultiEdit, Write, NotebookEdit | Editing files |
| Bash, PowerShell, Monitor | Running commands |
| WebSearch, WebFetch, `mcp__*` | Researching |
| Agent | Delegating to agents |
| TodoWrite, Task* | Planning |
| Skill | Using `<skill>` skill (agent rows: `… to <its task>`) |
| other | Using `<tool>` |

Agent rows with no tool in flight: `Waiting` (idle teammate), `Starting`, else the agent's task description.

## Commands

`/clawd-mon [show|hide|hint|dex|status|box|switch <name|#>|release <name|#> confirm|choose <name>|branch <name>|reset-all confirm]`

- `show` / `hide`: band on/off. × on the band = hide.
- `hint`: open the in-band help (same as the `!hint` button; Cancel closes it).
- `dex`: the catalog in the band (same Cancel as `!hint`; opening one closes the other). Header `Dex n/151 · ★ n/4`, then a counts line `Starters n/9 · Common n/59 · Uncommon n/55 · Rare n/23` (all non-legendary species by tier), then one row per legendary: silhouette and `???` until earned, lore line, goal, progress or `locked`.
- `status`: active entry, evolution gates, days to next evolution (Pokémon only, recent daily pace), box size, egg progress N/25, lifetime totals.
- `box`: list entries: number, active marker, name or Egg, level.
- `switch <name|#>`: make an entry active. Free, no confirm.
- `release <name|#> confirm`: remove an entry. Active one released: first remaining becomes active. Box empty: a fresh random egg is added and made active.
- `choose <name>`: starter egg only, before anything has hatched, non-legendary. Any name resolves to its first stage.
- `branch <name>`: pick the evolution for a branching species (active entry).
- `reset-all confirm`: fresh start. Wipes whole save: box, lifetime, history, settings. New starter egg; `choose` works again. Without `confirm` it only warns.
- `reset` is gone: use `release` or `reset-all`.

Save version 2. A version 1 save migrates into box slot 1, active.

## Legendaries

Earned by compact discipline. Each arrives once per save as a ★ egg in the box (not auto-active, hatches at the normal hatch level). Not obtainable with `choose` or from random eggs. `reset-all` clears them.

| Legendary | Lore | Goal |
|---|---|---|
| Articuno | Frozen bird of legend | Stay cool: 14 days without reaching `dangerPercent` (80) context. A day with a main turn and max context under the line counts; a day that reaches it resets to 0; days with no turns neither count nor reset |
| Zapdos | Storm bird of legend | Strike first: 30 qualifying compacts in a row without an auto-compact. Any auto-compact resets to 0 |
| Moltres | Phoenix bird of legend | Rebirth: fully evolve 3 lines (final-form evolutions and single-stage Lv 40 claims) |
| Mewtwo | Born in a lab from a legend's DNA | Locked until all three birds are owned. Then 10 fully evolved lines |

## Config

Plugin options (`/config`):

| Key | Default | |
|---|---|---|
| `xpRate` | 1 | XP per 1,000 tokens |
| `recommendPercent` | 60 | recommend Evolve at this context % |
| `dangerPercent` | 80 | decay starts at this context % |

## Dev

```bash
node tools/sprite-bounds.mjs   # writes data/sprite-bounds.json (content box per sprite; committed)
node tools/preview.mjs         # writes preview/review.html (gitignored): band in many states, light + dark
```

Preview uses the real engine, view helpers, data and sprites. Plain Node 22.18+ (type stripping), no install. `hooks/engine.ts` and `hooks/view.ts` stay import-free at runtime for this.

## Layout

```
hooks/engine.ts      pure rules (tested)
hooks/view.ts        pure text + SVG helpers (tested)
tools/               sprite-bounds.mjs, preview.mjs
hooks/register.tsx   hooks + band
data/                pokedex.json, growth.json, sprite-bounds.json
assets/sprites/      <id>.png, egg.png
tests/               claude plugin test .
```

Fresh clone: load the plugin in Claude Code once (it lays `.claude-plugin/types`) before `tsc -p .` works.

```bash
claude plugin validate .
claude plugin test .
```

## Credits

- Data: claudemon by Sergio Zamarro, MIT (`data/CLAUDEMON-LICENSE`).
- Sprites: PokeAPI/sprites.
- Pokémon © Nintendo / Game Freak / Creatures. Unofficial fan project, not affiliated.
- Code: MIT, see `LICENSE`.

Tip: add `assets/sprites/` to `.gitignore` to keep the art out of your repo. Missing sprite = band still works, no picture.
