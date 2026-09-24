# Live Arena: Design Spec

Date: 2026-09-24
Status: Draft, pending review

## Problem

Agent Arena scores JEV alone against fixed puzzles. There is no way to
watch several JEV agents compete live against each other in one shared
world, where each agent's situation is shaped by the others, and where a
match ends with exactly one winner.

## Goals

- A live, last-one-standing game on a shared board (light-cycle style)
  where 2–6 JEV agents play at once and exactly one wins.
- Agents move as soon as their own answers arrive, so the match is chaotic
  and live rather than turn-based.
- Every choice an agent sees states its concrete outcome on the current
  board, so the game measures JEV's judgement rather than its ability to
  parse a text map or plan many moves ahead in a single call.
- Watchable in 2.5D while it runs, and replayable afterwards from a saved
  move log.

## Non-goals

- Not a benchmark axis: matches do not feed the four-game leaderboard.
  JEV vs JEV compares JEV only with itself.
- No mixed seats (other models, bots as opponents, other people's keys) in
  v1. The seat model allows it later.
- No sampling: every seat plays JEV's top choice.
- No shared spectating: only the browser that starts a match watches it
  live. Every match is saved to a history that others can replay.
- No fog of war: every seat sees the whole board.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Kind of contest | Last one standing on a shared board |
| Who plays | JEV in every seat, 2–6 seats |
| How a seat picks | Always JEV's top choice |
| Turn timing | Move when ready: each seat moves the moment its answer arrives |
| Who watches live | Only whoever starts the match |
| What a match leaves behind | Match history with a replay; not on the leaderboard |
| Map size | Chosen per match, up to 48×48 |
| Room per option | Included |

## Game rules

**Arena.** A square grid with border walls and clustered interior
obstacles covering about 3–5% of cells, so large maps have chokepoints and
regions. Generated from a seed per match.

| Size | Grid | Default for | Time limit |
| --- | --- | --- | --- |
| Small | 16×16 | 2 seats | 3 min |
| Medium | 24×24 | 3–4 seats | 5 min |
| Large | 32×32 | 5–6 seats | 8 min |
| Huge | 48×48 | (manual only) | 12 min |

**Seats.** 2–6, named and colored Red (R), Blue (B), Green (G), Gold (Y),
Violet (V), Teal (T). Starts are evenly spaced around the arena, each
facing the centre, with open cells in front of it.

**Moving.** Each seat runs its own loop: read the board, ask JEV, apply the
move immediately, repeat. A move is one step up, down, left or right. Every
cell a seat leaves becomes its trail, permanently. Moves are applied one at
a time on the server, so moves never happen simultaneously. The board a
move lands on may have changed since the seat looked at it.

**Pace.** At most one move per seat every 300 ms. Faster answers still help,
up to that limit.

**Crashing.** Moving into a wall, any trail (including one's own) or a head
eliminates the seat that moved. A crashed seat's trail and head stay on
the board as obstacles.

**Bad answers.** A choice outside the options means "keep going straight"
(the direction of the seat's last move, or its starting direction before
it has moved). If straight is fatal, the seat crashes.

**Winning.** When exactly one seat is left alive, it wins and the match
ends. If the time limit is reached first, the seat with the most cells
claimed wins; a tie goes to the seat that reached that count first. A
match always has exactly one winner.

## What each seat sees

Every call is one System One Choice question with four options.

**Instructions** (fixed text): the rules above, the map legend, that rivals
move independently so a move may land on a changed board, and what the
FATAL, CONTESTED and Room markers mean.

**State** (rebuilt per seat, per call):

```
You are RED (R). Alive: Red, Blue, Gold. Out: Green (crashed into Blue's trail).
You have claimed 34 cells. Match time 1:12 of 5:00.
Map (row 1 top). # wall, . empty, R/B/G/Y/V/T heads, r/b/g/y/v/t trails:
########################
#......bbbbbB..........#
#..rrrrR...............#
...
You are at row 3 col 8, heading right. Blue's head: row 2 col 12, heading right.
Gold's head: row 17 col 20, heading up.
```

Crashed seats' heads are drawn as their lowercase trail letter. Trail
coordinates are never listed: the map carries them, and listing them would
grow without bound on large maps.

**Options.** Always U, D, L, R, each described by its outcome:

```
U: Move up to row 2 col 8. FATAL: Blue's trail is there.
D: Move down to row 4 col 8. Open. Room after this move: 212 cells, shared with Blue and Gold.
L: Move left to row 3 col 7. FATAL: your own trail.
R: Move right to row 3 col 9. Open. CONTESTED: Blue can also reach this cell with one move.
   Room after this move: 212 cells, shared with Blue and Gold.
```

- **FATAL**: the destination holds a wall, a trail or a head, with the
  owner named.
- **CONTESTED**: a living rival's head is orthogonally adjacent to the
  destination.
- **Room**: the number of empty cells reachable from the destination by
  flood fill, with the destination counted as occupied. It also names the
  living rivals whose heads border that region, or says "sealed off, only
  you" when none do.

## Architecture

All new code follows existing patterns: the `Agent` interface and
`withRetries` from `src/lib/agents`, a server-sent-event stream as in
`/api/run`, and the SQLite store in `src/lib/db.ts`.

**`src/lib/arena/board.ts`: rules, no I/O.**
- `generateArena(seed, size, seats)` builds the border, obstacle clusters
  and spaced starts, and checks that every start has room.
- `applyMove(board, seat, dir)` returns `{ moved }` or `{ crashed, reason }`.
- `winner(board)`, `room(board, seat, dir)`, `contested(board, seat, dir)`.
- `describeState(board, seat)` and `describeOptions(board, seat)` produce
  the text in "What each seat sees".

**`src/lib/arena/match.ts`: the live match.**
- `runMatch({ seed, size, agents, clock, signal, emit })`.
- Starts one loop per seat and applies each answer to the current board.
  Enforces the minimum pace and the time limit.
- Each seat gets its own abort signal, so pending calls stop when the seat
  crashes, the match ends, or the viewer disconnects.
- Emits `start`, `move`, `crash`, `retry` and `end` events and appends each
  to a timestamped log.
- The clock is injectable, so tests run instantly.

**`POST /api/match`**
- Body: `{ provider: "jev" | "demo", seats, size, apiKey? }`.
- Validates input and creates one agent per seat, all on the same key.
- Streams events as SSE with keep-alives, like `/api/run`.
- At most 2 matches run at once, since each keeps up to 6 calls in flight
  on one key.
- Saves the match when it ends. A match the viewer abandons is discarded.

**Storage.** A new `matches` table in `src/lib/db.ts` with: id, created_at,
provider, seed, size, seats, winner seat, end reason (last standing or time
limit), duration, input and output tokens, per-seat results (cells, moves,
out-reason) as JSON, and the move log as JSON. A 6-seat Huge match's log
is tens of kilobytes.

**`GET /api/matches`** lists recent matches. **`GET /api/matches/[id]`**
returns one match with its log.

**Arena demo bot.** A scripted agent that picks the non-fatal option with
the most Room, breaking ties by option order. It powers free demo matches,
UI development and tests.

## Screens

**Navigation.** Adds an Arena tab: Play · Arena · Leaderboard.

**Lobby (`/arena`)**
- Player stepper (2–6), map size (defaulting by seat count), provider, and
  the optional key.
- An estimate line, e.g. "about 0.5M tokens · up to 8 min", updated live.
- A Start match button.
- Recent matches listed below.

**Live match (same page)**
- A full-width 2.5D board. Trails are low blocks in seat colors, heads are
  colored balls, and a crashed head gets a burst marker. Fit, 1× and 2×
  zoom with pan.
- A seat card per player: color, name, alive or out, cells claimed, moves,
  last choice and confidence, moves per second, and how it went out.
- A match clock, a live event feed ("1:12 Blue crashed into Red's trail"),
  and a Stop button.
- At the end, a winner banner and the final standings in order of
  elimination.

**Replay (`/arena/[id]`)**
- The same board and seat cards, driven by the saved log.
- Play/pause, 1×/2×/4× speed, and a draggable timeline.

**Rendering.**
- Shared isometric projection helpers are extracted from `IsoBoard.tsx`,
  and a new `ArenaBoard` component uses them. The existing game boards are
  unchanged.
- The floor and obstacles render once, only changed trail cells re-render,
  and UI updates are batched per animation frame.
- If Huge 6-seat matches still stutter, that board alone switches to
  canvas.

## Error handling

| Situation | Behaviour |
| --- | --- |
| 429 / 529 rate limit or overload | That seat pauses and backs off per `withRetries`. It does not move and is not eliminated. Other seats continue. A `retry` event shows in its card. |
| Other retryable error (timeout, 5xx, network) | Up to 3 retries, then the seat is out as "disconnected". |
| 401 invalid key | The whole match stops with an error. Nothing is saved. |
| Choice outside the options | Keep going straight; crash if straight is fatal. |
| Viewer closes the tab | All seat loops and pending calls abort. Nothing is saved. |
| Answer arrives after its seat is out or the match ended | Discarded. |
| Time limit reached | Most cells wins; ties go to whoever reached that count first. |
| Too many matches running | 429 "The arena is busy", as `/api/run` does. |

## Testing

**Board (`tests/arena.board.test.ts`)**
- Generation is deterministic per seed.
- Starts are spaced and each has room.
- Obstacles land in the 3–5% band and all non-obstacle cells are
  connected.
- Crash rules: wall, own trail, rival trail, head.
- Room matches a brute-force flood fill.
- CONTESTED marks exactly the cells next to living rival heads.
- Every option's text matches its real outcome, the same check used for
  Crate Runner.

**Match (`tests/arena.match.test.ts`)**, using fake agents and a fake
clock:
- Last one standing ends the match immediately with one winner.
- The time-limit tiebreak by cells, then by earliest to reach them.
- An out-of-options answer goes straight and crashes if straight is
  fatal.
- A 429 pauses one seat without eliminating it.
- A 401 aborts everything.
- Aborting stops all calls, with no calls after abort.
- The minimum pace is honoured.
- Replaying the saved log reproduces the final board exactly.

**HTTP.** A full demo match through `POST /api/match`, and a JEV-format
match against the existing local fake System One server
(`tests/fakeProvider.ts`).

**UI.** A demo-bot match checked in the browser at every map size,
including light and dark mode and phone width. A frame-rate check on Huge
with 6 seats.

**Live.** One real JEV match per size, to calibrate the token and duration
estimates in the lobby.

## Open questions

- **Token cost on Huge.** The estimates above are unmeasured. If Huge is
  too expensive, the fallback is to show each seat a window around its
  head instead of the whole map. That changes the game (no full-map
  vision), so it is deferred until real numbers exist.
- **Rate limits.** Up to 12 concurrent calls on one key (2 matches × 6
  seats) has not been tested against TypeSafe's limits. The concurrency cap
  may need lowering after the first live runs.
- **Later.** Shareable live matches (the event log already supports late
  joiners), mixed seats, and a Survival leaderboard axis once non-JEV seats
  exist.
