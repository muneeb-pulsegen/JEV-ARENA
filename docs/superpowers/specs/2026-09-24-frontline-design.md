# Frontline: Design Spec

Date: 2026-09-24
Status: Draft, pending review
Replaces: Live Arena (`2026-09-24-live-arena-design.md`)

## Problem

Live Arena didn't make JEV think. Every option said how much room it left,
so the best move was nearly always obvious. Agents barely affected each
other until one crashed, and watching meant watching trails fill a board.

Frontline is a game where the right choice depends on what rivals will do
this round. Nobody can see anyone else's order until all of them are
revealed together.

## Goals

- 2–6 JEV agents fight for a hex map. The last agent holding territory
  wins, and a match always has exactly one winner.
- Every round, all agents choose their order at the same time without
  seeing each other's. Orders are revealed and resolved together.
- Every option states its concrete outcome, assuming rivals do nothing.
  It also states what rivals could do to change that outcome. That
  uncertainty is where the judgement lies.
- Rounds are watchable: orders locking in, arrows revealed, battles
  resolved.
- Cheap enough to run often: a 6-player match makes about 200 calls.

## Non-goals

- Not on the four-game leaderboard. JEV against JEV compares JEV only with
  itself.
- No dice. Combat is deterministic, so every option's text can be exact.
- No diplomacy, messages or alliances in v1.
- No fog of war: every agent sees the whole map.

## Decisions

| Question | Decision |
| --- | --- |
| Players | JEV in every seat, 2–6 |
| Timing | Simultaneous rounds: all orders are hidden, then revealed together |
| Orders per round | One per player: attack, or reinforce |
| Combat | Deterministic troop subtraction; no dice |
| Win | Last player holding a region; at the round limit, most regions |
| Live Arena | Replaced. Its code is removed from the branch and kept in git history |
| Reused from Live Arena | Seats and colours, SSE route, matches table, lobby, replay page |

## Game rules

**Map.** A hexagon of hexes. About 10% of hexes are lakes, which can't be
entered. Every land hex is a region, and they are all connected. Some
regions are cities. Regions are named by column letter and row number
(`D5`), shown on the map and used in every option. The map is generated
from a seed.

| Size | Radius | Land regions | Cities | Default for | Round limit |
| --- | --- | --- | --- | --- | --- |
| Small | 3 | ~33 | 3 | 2–3 players | 25 |
| Medium | 4 | ~55 | 5 | 4–5 players | 30 |
| Large | 5 | ~82 | 7 | 6 players | 40 |

**Start.** Each player starts with one region holding 6 troops. Starts are
spaced evenly around the edge. Every other region starts neutral with 2
troops, and each city starts with 4.

**Income.** At the start of each round, every living player earns
`3 + floor(regions / 3) + 2 per city held` new troops.

**Orders.** Each round a player picks exactly one order.
- **Attack** a neighbouring enemy or neutral region from one of its own
  regions. Every troop except one leaves the source. The round's income is
  added to the source after the battle.
- **Reinforce** one of its own regions. Double the round's income is
  placed there, and the player makes no attack this round.

**Resolution.** Everything happens at once, in this order:
1. All attacking armies leave their sources together.
2. **Head-on clashes.** When two armies travel in opposite directions
   along the same border, the smaller army is destroyed. The larger one
   carries on with the difference, and an exact tie destroys both.
3. **Reinforcements** land.
4. **Battles.** Each target region is fought over by every army arriving
   there. Multiple attackers on one region fight each other first; the
   largest survives with the difference over the second largest. Then
   `attackers - defenders`:
   - If the result is above 0, the region is captured with that many
     troops.
   - If it is 0 or less, the defenders hold with what's left, minimum 1.
   - Cities defend at 1.5×, rounded down.
5. **Income** is added to each attacking player's source region.
6. A player with no regions left is **eliminated**.

**Winning.** When only one player holds any regions, that player wins.
At the round limit, the winner is the player with the most regions, then
the most troops, then whoever reached that region count first. A match
always has exactly one winner.

**Bad or missing answers.** A choice outside the options, or no answer
within 60 seconds, becomes **Reinforce** on the player's most threatened
region. That is the region facing the largest enemy army relative to its
own troops.

## What each player sees

One System One Choice question per player per round.

**Instructions** (fixed): the rules above, the map legend, and that
orders are simultaneous, so what an option describes can change because of
what rivals do this round.

**State** (per player, per round):

```
Round 7 of 30. You are BLUE (B). Income this round: 7 troops.
Alive: Red 9 regions, Blue 8, Green 6. Out: Gold (round 5, taken by Red).
Map, one line per region (owner troops, * = city, neighbours):
  C4  Blue 12   borders C3 Red 5, D4 Blue 3, B4 neutral 2, C5 Blue 1
  C3  Red 5 *   borders C2 Red 11, B3 neutral 2, C4 Blue 12, D3 Green 4
  ...
Last round: Red took D6 from Green (9 vs 4). Green reinforced E2 (+10).
```

**Options.** Up to 8, with ids chosen by the server:
- `A1`–`A6`: the six best attacks, ranked by margin. Each is described by
  its outcome:
  ```
  A1: Attack Red's city C3 (5 troops, defends as 7) from C4 with 11.
      Takes it with 4 left if Red doesn't move. Red's C2 (11) borders C3
      and could reinforce it to 19 or strike C4 head-on.
      C4 keeps 1 + 7 income; Green's D3 (4) borders it.
  ```
- `R1`, `R2`: reinforce the two most threatened regions:
  ```
  R1: Reinforce C4 (12) with 14 → 26. No attack this round.
      Biggest threat: Red's C2 (11).
  ```

## Architecture

The code follows the existing patterns and replaces Live Arena's files:

- **`src/lib/frontline/map.ts`** (pure). Hex coordinates, map generation
  (lakes, cities, spaced starts, all regions connected) and region names.
- **`src/lib/frontline/rules.ts`** (pure).
  - `options(state, player)` builds the up-to-eight orders with their
    text.
  - `resolveRound(state, orders)` applies the resolution steps above and
    returns the new state plus a battle report.
  - Also `winner` and `standings`.
- **`src/lib/frontline/match.ts`**. Runs a match round by round:
  - Asks every living player in parallel and waits for all answers. A
    player that hasn't answered after 60 seconds gets the fallback order.
  - Resolves the round and emits `start`, `locked` (one player's order
    is in, but not what it is), `reveal` (all orders), `round` (the
    battle report and new state), `retry`, `out` and `end`.
  - The log replays exactly, and the clock is injectable for tests.
- **HTTP.** `POST /api/match` is reused (validation of the body changes)
  and still streams server-sent events with at most 2 matches at once.
  `GET /api/matches` and `/api/matches/[id]` are unchanged, and the
  `matches` table gains a `game` column.
- **Demo bot.** Picks the attack with the best margin that still leaves
  its source safe; if none, it reinforces its most threatened region.

## Screens

- **Lobby (`/arena`, renamed Frontline in the nav).** Player stepper,
  map size (defaulting by player count), provider, key, token estimate
  and recent matches.
- **Live match.**
  - A 2.5D hex map. Each region is a hex prism coloured by owner, with
    height growing with troop count and the troop number on top. Cities
    carry a tower marker.
  - Each round plays out in beats:
    1. Players' cards tick "order locked" as their answers arrive.
    2. All attack arrows appear together.
    3. Head-on clashes flash.
    4. Captures recolour their hexes.
    5. Troop counts roll up to their new values.
  - A card per player: regions, troops, income, this round's order and
    confidence, and how it went out.
  - A round counter, a battle feed ("R7 Red took D6 from Green, 9 vs
    4"), Stop, a winner banner and standings.
- **Replay (`/arena/[id]`).** The same view stepping round by round, with
  play/pause, 1×/2×/4× speed and a round slider.

## Error handling

| Situation | Behaviour |
| --- | --- |
| 429 / 529 rate limit or overload | That player backs off via `withRetries` and the round waits, for up to 3 minutes. After that, the fallback order is used. |
| Other retryable errors | Up to 3 retries, then the fallback order for this round. After 3 rounds in a row on fallback, the player is out as "disconnected". |
| 401 invalid key | The match stops with an error, and nothing is saved. |
| Answer outside the options, or none within 60 s | Fallback: reinforce the most threatened region. |
| Viewer closes the tab | Every call aborts, and nothing is saved. |
| Too many matches | 429 "The arena is busy". |

## Testing

- **Map:** generation is deterministic per seed; every land region is
  connected; lake and city counts fall in their bands; starts are spaced
  apart.
- **Rules:** capturing and holding, with and without the city bonus;
  multiple attackers on one region; head-on clashes, including exact
  ties; a source attacked while its army is away; reinforce and income
  arithmetic; elimination; the round-limit tiebreak.
- **Options:** every option's "if nobody moves" outcome matches
  `resolveRound` with all other players holding, the same kind of check
  used for Crate Runner and Live Arena.
- **Match (fake agents, fake clock):** simultaneous orders are resolved
  together; a slow player gets the fallback at 60 s; a rate-limited
  player delays the round without losing its order; 401 aborts; abort
  stops all calls; replaying the log rebuilds the final state.
- **HTTP:** a full demo match through `POST /api/match`, and a JEV-format
  match against `tests/fakeProvider.ts`.
- **UI:** a demo match at every size, in light and dark mode and at phone
  width, plus the frame rate on Large with 6 players.

## Estimates

Up to 40 rounds × 6 players = 240 calls. Each call is roughly 1,500
characters of instructions, one line per region (~60 characters × 82) and
8 options, so about 2,000 tokens. A Large 6-player match is therefore
around 0.5M tokens at most; a Small 2-player match is about 40k. At
roughly 2–5 seconds per round, a match takes 1–3 minutes.

## Open questions

- **Balance.** The income formula, the 1.5× city defence and the round
  limits are first guesses. Tuning them needs demo-bot matches and a few
  real JEV matches.
- **Option count.** Eight options may leave out a clever attack. A
  version with every attack listed (up to about 20) could be tried later.
- **Later:** alliances or messages, and mixed seats (other models or
  bots).
