# Dominion: Design Spec

Date: 2026-09-24
Status: Approved to build ("go ahead"), using the recommended defaults
Sits next to: Frontline (kept as the quick game)

## Problem

Frontline is a good quick test, but a match has one kind of decision:
where to send troops. The owner wants something closer to Civilization.
Agents should build an economy, choose technologies, found cities, pick
an army that counters their rivals, and aim at more than one way to win.

## Goals

- 2–6 JEV agents each grow a civilization on a shared hex map: cities,
  population, production, gold, science, technology, units, buildings,
  wonders.
- Four victory conditions, so there are genuinely different strategies:
  domination, science, wonders, and score at the turn limit.
- Turns stay simultaneous and hidden until resolved, as in Frontline.
- **One API call per player per turn**, and only when that player has a
  decision to make. All of that turn's decisions ride in the same call as
  separate named questions. TypeSafe evaluates each question independently
  against the shared state; this is documented behaviour.
- Every option states its concrete consequence ("Walls in Rome, 5 turns:
  Rome defends at 1.5×").
- A live 2.5D map, a replay, and a demo bot, as in Frontline.

## Non-goals (v1)

- No diplomacy, trade, religion, culture borders, great people or
  barbarians.
- Units move as one field army per player plus city garrisons, not as
  individually moved units. This keeps one army decision per turn.
- Not on the four-game leaderboard.

## Decisions

| Question | Decision |
| --- | --- |
| Relationship to Frontline | Separate tab; Frontline stays |
| Scope | All four stages: economy, war, technology, wonders |
| Calls | One per player per turn, carrying up to 7 questions; no call when there is nothing to decide |
| Cost target | About 1M tokens for a 4-player match |
| Visibility | Terrain is public; cities, armies and settlers are seen only near your own cities and army. Rivals' totals (cities, population, techs, wonders) are public |

## The map

A hexagon of hexes. Terrain comes in clustered patches, generated from a
seed.

| Size | Radius | Hexes | Default for | Turn limit |
| --- | --- | --- | --- | --- |
| Small | 5 | 91 | 2–3 players | 60 |
| Medium | 6 | 127 | 4 players | 75 |
| Large | 7 | 169 | 5–6 players | 90 |

| Terrain | Food | Production | Gold | Defence | Notes |
| --- | --- | --- | --- | --- | --- |
| Grassland | 2 | 0 | 0 | 1× | |
| Plains | 1 | 1 | 0 | 1× | |
| Forest | 1 | 2 | 0 | 1.25× | |
| Hills | 0 | 2 | 0 | 1.5× | +1 production with Mining |
| Desert | 0 | 1 | 0 | 1× | |
| Lake | 2 | 0 | 1 | – | Workable by cities, impassable |
| Mountain | – | – | – | – | Impassable, unworkable |

Resources add to their tile:
- **Wheat:** +2 food.
- **Gold:** +3 gold.
- **Horses:** +1 production. Needed for horsemen.
- **Iron:** +1 production. Needed for swordsmen.
- **Marble:** +1 production, and wonders cost 25% less in the city that
  holds it.

A player "has" a resource if it lies in one of its cities' territory.
Every start gets wheat within 2 hexes, and horses and iron within 4.

## Cities

- Founded by a settler. Each player starts with one city, its capital,
  plus 2 warriors.
- **Territory** is the hexes within 1 of the city; it grows to 2 once the
  city reaches population 3. Hexes already claimed stay with whoever
  claimed them first.
- **Worked tiles.** A city works one territory tile per population point,
  picked automatically for the most total yield. Its centre tile yields at
  least 2 food, 1 production and 1 gold, and the capital adds +2 gold and
  +2 science.
- **Food.** Each population point eats 2 food. The surplus is stored, and
  the city grows when the store reaches `8 + 4 × population`. It shrinks
  if the store runs out.
- **Production** goes into the item being built, and overflow carries
  over.
- **Science** per city is `1 + population / 2`, rounded down.
- **Gold** comes from tiles. Each player gets 2 units per city free; every
  unit beyond that costs 1 gold per turn. If the treasury would go below
  0, the weakest unit is disbanded.
- **Buy.** Any item can be bought outright for 2 gold per missing point of
  production.

### What cities build

| Item | Cost | Needs | Effect |
| --- | --- | --- | --- |
| Warrior | 10 | – | Strength 1 |
| Settler | 30 | population 2 (uses 1) | Founds a city |
| Spearman | 18 | Bronze Working | Strength 2, ×2 against horsemen |
| Archer | 18 | Archery | Strength 2, ×1.5 against spearmen and swordsmen, +50% defending a city |
| Horseman | 25 | Horseback Riding and horses | Strength 3, ×2 against archers and catapults; an army of only horsemen moves 2 |
| Swordsman | 30 | Iron Working and iron | Strength 4 |
| Catapult | 30 | Mathematics | Strength 1 in the field, 4 against cities |
| Granary | 30 | Pottery | +2 food; keeps half the store on growth |
| Walls | 30 | Bronze Working | City defends at 1.5× |
| Workshop | 40 | Mining | +2 production |
| Library | 40 | Writing | +2 science, +50% science |
| Market | 40 | Currency | +2 gold, +50% gold |
| Castle | 50 | Engineering and Walls | City defends at 2× |
| Observatory | 150 | Astronomy | Completing it wins (science victory) |

### Wonders

Each wonder can be built only once in the world. If a rival finishes it
first, the production already spent turns into gold.

| Wonder | Cost | Needs | Effect |
| --- | --- | --- | --- |
| Hanging Gardens | 100 | Pottery | +2 food in every city |
| Pyramids | 110 | Mining | +25% production in every city |
| Great Library | 110 | Writing | +25% science in every city |
| Colossus | 110 | Currency | +6 gold per turn |
| Great Wall | 130 | Engineering | Every city defends as if it had walls; armies defend at +25% in their own territory |

## Technology

A player researches one tech at a time, paid for with science.

| Era | Cost | Techs (prerequisites) |
| --- | --- | --- |
| Ancient | 25 | Pottery, Bronze Working, Archery, Mining |
| Classical | 60 | Horseback Riding (Archery), Iron Working (Bronze Working), Writing (Pottery), Currency (Mining), Mathematics (Archery, Mining) |
| Medieval | 110 | Engineering (Mathematics, Iron Working), Philosophy (Writing, Currency), Astronomy (Philosophy, Mathematics) |

## Armies and combat

- Each player has **one field army**, a stack of units that moves as one,
  and every city has a **garrison**. New units join their city's
  garrison.
- **Army orders** (one per turn):
  - **March** toward a target: a visible enemy city or army, one of your
    cities, or a key tile. The army moves 1 hex per turn, 2 if it is all
    horsemen. Stepping into an enemy army or city is an attack.
  - **Attack** an adjacent enemy army or city.
  - **Fortify:** the army defends at 1.5× this turn.
  - **Muster in a city:** the army takes all but one unit of that city's
    garrison. Allowed when the army is in that city, or has no units, in
    which case it forms there.
  - **Garrison:** the army joins the garrison of the city it stands in.
- **Moves are simultaneous and happen step by step.** Two enemy armies
  that step onto the same hex, or swap hexes, fight a field battle there.
- **Strength.** A side's strength is the sum of its units' strengths,
  each multiplied by that unit's counter bonuses. The bonuses are weighted
  by how much of the enemy stack each bonus applies to.
- **Defence modifiers:**
  - The hex's terrain.
  - Fortify: ×1.5.
  - Cities add a base of `2 + population`, times walls (1.5×) or castle
    (2×).
  - Catapults use their strength of 4 against cities.
- **Outcome.** The stronger side wins; a tie goes to the defender. The
  loser's stack is destroyed. The winner loses a share `(weaker / stronger)^1.5`
  of each unit type, rounded. An attacker that beats a city captures it:
  population −1, walls and castle destroyed, garrison destroyed.
- **Settlers** walk 1 hex per turn to their chosen site and found a city
  on arrival if the site is still valid. A settler that meets an enemy
  army is lost.
- A player with no cities left is **eliminated**.

## Victory

Checked in this order at the end of each turn:
1. **Domination:** hold every original capital, or be the only player left
   with cities.
2. **Science:** complete the Observatory.
3. **Wonders:** own 3 wonders.
4. **Score, at the turn limit:**
   `3 × population + 4 × techs + 10 × wonders + 5 × cities + territory hexes / 4`.
   Ties go to more techs, then seat order.

Simultaneous wins in one turn are settled in that same order, then by
score.

## What each player sees (one call)

**State** (shared by every question that turn, written from the player's
point of view):
- Rules, in short.
- Turn, gold and its change per turn, science per turn, research
  progress, techs and wonders known.
- Rivals' public totals.
- Each of the player's cities: population, food and turns to grow,
  production, what it's building and how long it will take, buildings,
  garrison, and resources.
- The player's army and settlers.
- Visible enemy armies, cities and settlers.
- Two compact hex grids, one character per hex: a terrain map, and an
  owner map with `?` for tiles never seen.
- Last turn's events.

**Questions:**

| Question | Asked when | Options |
| --- | --- | --- |
| `build_<city>` | The city finished its item or has none; up to 4 cities per turn | Each buildable item with turns to finish and its effect; up to 2 "buy now" options |
| `research` | No tech in progress | Each available tech: turns to finish and what it unlocks |
| `army` | Every turn the player has an army or could muster one | Up to 8 of: march targets, attacks (with the result if nothing changes), fortify, muster, garrison |
| `settle` | A settler is waiting for a site | The 4 best sites, each with its food, production and resources, and distance; or hold |

**Fallbacks.** A missing or invalid answer gets the demo bot's choice for
that question. A turn with no answer at all counts toward disconnection:
after 3 turns in a row, the player is out.

## Architecture

The code follows Frontline's layout, in `src/lib/dominion/`:
- **`config.ts`:** sizes, terrain, resources, units, buildings, wonders,
  techs.
- **`map.ts`:** generation (clustered terrain, lakes, mountains,
  connectivity, fair resources), coordinates and names.
- **`state.ts`:** state types and the new-game state.
- **`economy.ts`:** territory, worked tiles, yields, growth, production,
  gold, science.
- **`combat.ts`:** strengths, counters and battle outcomes.
- **`turn.ts`:** `resolveTurn(map, state, orders)`, which returns the new
  state and a report.
- **`questions.ts`:** builds each player's questions and option text, and
  applies answers as orders.
- **`view.ts`:** a player's state text, including fog of war.
- **`victory.ts`:** win checks and score.
- **`match.ts`:** the runner; one multi-question call per player per turn,
  in parallel.
- **`serve.ts`:** the request handler.

`Agent` gains an optional `decideMany`. The JEV agent sends every question
in one request; agents without it are asked one question at a time.
`withRetries` covers both. The demo bot plays a simple expand, build and
defend strategy.

The routes are `POST /api/dominion`, and `/api/matches` shared with
Frontline. Matches are saved with `game: "dominion"`, and each turn's log
entry carries a public snapshot, so the replay doesn't recompute anything.

## Screens

- **Nav:** Play · Frontline · Dominion · Leaderboard.
- **Lobby (`/dominion`):** players, map size, provider, key, estimate,
  recent matches.
- **Live match:**
  - A 2.5D terrain map. Tiles are coloured by terrain and outlined by
    owner. Cities show their population, armies show their unit count,
    and there are resource icons. The spectator sees everything.
  - A civilization card per player: cities, population, gold, science,
    current research, techs, wonders, army.
  - An event feed: city founded, built, tech discovered, battle, city
    captured, wonder completed, victory.
  - A turn counter and a winner banner that shows the victory type.
- **Replay (`/dominion/[id]`):** turn by turn, with play/pause, speed and
  a turn slider.

## Testing

- **Map:** deterministic per seed; passable land connected; terrain mix in
  its bands; fair resources near every start.
- **Economy:** yields, worked-tile choice, growth and starvation,
  production overflow, buying, upkeep and disbanding, science and tech
  completion, building effects.
- **Combat:** counters, terrain, walls and castle, catapults against
  cities, losses, captures.
- **Turn:** simultaneous moves, collisions and swaps, settlers founding
  and being caught, elimination.
- **Victory:** each of the four, and the tie order.
- **Questions:** each option's stated turns and battle result match
  `resolveTurn` when nothing else changes.
- **Match:** multi-question calls, fallbacks, disconnects, abort, and a
  replay that matches.
- **HTTP:** a full demo match, and a JEV-format match against the fake
  provider, now answering several questions per request.
- **Balance:** demo-bot matches at each size should end in every victory
  type at least sometimes.

## Open questions

- **Token use with JEV** is estimated, not measured.
- **Balance** is tuned against the demo bot, as with Frontline.
- **Later:** diplomacy and trade, barbarians, several armies per player.
