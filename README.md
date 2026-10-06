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
| Egg | Crack 1 ≥ 800 XP, crack 2 ≥ 1,800, hatch ≥ 3,000. Each stage also needs its own qualifying compact. Hatch: chosen starter or random first-stage non-legendary, Lv 5 |
| Level | Species growth table (fast/medium/medium-slow/slow). Applied XP × clamp((320/BST)^0.35, 0.6, 1.1). Lv 1–100 |
| Evolution | Level ≥ species level AND qualifying compacts since hatch: 3 (first), 8 (second). Item: Lv 30. Trade: Lv 36 |
| Branches | Eevee etc.: first by default, `/clawd-mon branch <name>` picks |
| Pace | Bulbasaur → Venusaur ≈ 30 days at ~1.5M tokens/day, one compact a day alternating manual/auto (23 days all manual) |

Evolve is a no-op with a toast while a turn runs. Evolution is checked at compact time only.

## Commands

`/clawd-mon [show|hide|status|choose <name>|branch <name>|reset|reset-all]`

- `show` / `hide`: band on/off. × on the band = hide.
- `status`: level, XP, gates, days to next evolution (recent daily pace), lifetime totals.
- `choose <name>`: egg → set starter (any name resolves to its first stage). Hatched → `choose <name> confirm` swaps to that first stage at Lv 5.
- `branch <name>`: pick the evolution for a branching species.
- `reset`: companion back to an egg. Clears pending XP and chosen starter. Lifetime totals kept.
- `reset-all confirm`: fresh start. Wipes whole save: companion, lifetime, history, settings. Without `confirm` it only warns.

## Config

Plugin options (`/config`):

| Key | Default | |
|---|---|---|
| `xpRate` | 1 | XP per 1,000 tokens |
| `recommendPercent` | 60 | recommend Evolve at this context % |
| `dangerPercent` | 80 | decay starts at this context % |

## Layout

```
hooks/engine.ts      pure rules (tested)
hooks/register.tsx   hooks + band
data/                pokedex.json, growth.json
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
