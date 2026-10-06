// Small slice of data/pokedex.json and data/growth.json for the tests.
// Hooks modules run without fs or JSON imports, so tests carry their own copy.
import type { Dex, Species } from '../hooks/engine'

type Stats = [number, number, number, number, number, number]

function mon(
  id: number,
  name: string,
  stats: Stats,
  stage: 0 | 1 | 2,
  evolvesFrom: number | null,
  evolutions: Species['evolutions'],
  growthRate: Species['growthRate'] = 'medium-slow',
  legendary = false,
): Species {
  const [hp, attack, defense, spAttack, spDefense, speed] = stats
  return {
    id,
    name,
    types: ['normal'],
    stats: { hp, attack, defense, spAttack, spDefense, speed },
    growthRate,
    stage,
    evolvesFrom,
    evolutions,
    legendary,
  }
}

const lvl = (to: number, level: number) => ({ to, trigger: 'level-up', level, item: null })
const item = (to: number, name: string) => ({ to, trigger: 'use-item', level: null, item: name })
const trade = (to: number) => ({ to, trigger: 'trade', level: null, item: null })

export const SPECIES: Species[] = [
  mon(1, 'Bulbasaur', [45, 49, 49, 65, 65, 45], 0, null, [lvl(2, 16)]),
  mon(2, 'Ivysaur', [60, 62, 63, 80, 80, 60], 1, 1, [lvl(3, 32)]),
  mon(3, 'Venusaur', [80, 82, 83, 100, 100, 80], 2, 2, []),
  mon(4, 'Charmander', [39, 52, 43, 60, 50, 65], 0, null, [lvl(5, 16)]),
  mon(25, 'Pikachu', [35, 55, 40, 50, 50, 90], 0, null, [item(26, 'thunder-stone')], 'medium'),
  mon(26, 'Raichu', [60, 90, 55, 90, 80, 110], 1, 25, [], 'medium'),
  mon(63, 'Abra', [25, 20, 15, 105, 55, 90], 0, null, [lvl(64, 16)]),
  mon(64, 'Kadabra', [40, 35, 30, 120, 70, 105], 1, 63, [trade(65)]),
  mon(65, 'Alakazam', [55, 50, 45, 135, 95, 120], 2, 64, []),
  mon(133, 'Eevee', [55, 55, 50, 45, 65, 55], 0, null, [
    item(134, 'water-stone'),
    item(135, 'thunder-stone'),
    item(136, 'fire-stone'),
  ], 'medium'),
  mon(134, 'Vaporeon', [130, 65, 60, 110, 95, 65], 1, 133, [], 'medium'),
  mon(135, 'Jolteon', [65, 65, 60, 110, 95, 130], 1, 133, [], 'medium'),
  mon(136, 'Flareon', [65, 130, 60, 95, 110, 65], 1, 133, [], 'medium'),
  mon(144, 'Articuno', [90, 85, 100, 95, 125, 85], 0, null, [], 'slow', true),
  mon(145, 'Zapdos', [90, 90, 85, 125, 90, 100], 0, null, [], 'slow', true),
  mon(146, 'Moltres', [90, 100, 90, 125, 85, 90], 0, null, [], 'slow', true),
  mon(151, 'Mew', [100, 100, 100, 100, 100, 100], 0, null, [], 'medium-slow', true),
  mon(150, 'Mewtwo', [106, 110, 90, 154, 90, 130], 0, null, [], 'slow', true),
  mon(122, 'Mr-mime', [40, 45, 65, 100, 120, 90], 0, null, [], 'medium'),
]

function table(f: (n: number) => number): number[] {
  return Array.from({ length: 101 }, (_, n) => (n < 2 ? 0 : Math.max(0, Math.floor(f(n)))))
}

// The classic formulas; data/growth.json holds the same numbers.
export const GROWTH: Dex['growth'] = {
  fast: table(n => (4 * n ** 3) / 5),
  medium: table(n => n ** 3),
  'medium-slow': table(n => 1.2 * n ** 3 - 15 * n ** 2 + 100 * n - 140),
  slow: table(n => (5 * n ** 3) / 4),
}

export const DEX: Dex = { species: SPECIES, growth: GROWTH }
