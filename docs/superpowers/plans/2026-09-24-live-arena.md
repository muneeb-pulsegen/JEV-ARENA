# Live Arena: Implementation Plan

Date: 2026-09-24
Spec: `docs/superpowers/specs/2026-09-24-live-arena-design.md`

Twelve tasks, in order. Logic tasks are test-first (`npm test`); UI tasks
are checked in the browser. Every task ends with `npm test` and
`npm run typecheck` green before the next one starts.

## Shared shapes

These are fixed up front so later tasks can rely on them.

```ts
// src/lib/arena/config.ts  (no Node imports, safe for the client)
type SizeId = "small" | "medium" | "large" | "huge";
SIZES: Record<SizeId, { grid: 16 | 24 | 32 | 48; timeLimitMs: number; label: string }>;
SEATS: { id: "R"|"B"|"G"|"Y"|"V"|"T"; name: string; trail: string }[];   // Red, Blue, Green, Gold, Violet, Teal
defaultSize(seats): SizeId;               // 2 → small, 3–4 → medium, 5–6 → large
estimateMatch(seats, size): { tokens: number; minutes: number };
PACE_MS = 300; MIN_SEATS = 2; MAX_SEATS = 6;

// src/lib/arena/board.ts  (pure)
type Dir = "U" | "D" | "L" | "R";
type Seat = { id; name; pos: number; dir: Dir; alive: boolean; out?: string; outAt?: number;
              cells: number; moves: number; reachedAt: number };
type Board = { grid: number; occ: Int16Array /* -2 wall, -1 empty, ≥0 seat */; seats: Seat[] };
type MoveResult = { moved: true; to: number } | { moved: false; reason: string };

// src/lib/arena/match.ts
type MatchEvent =
  | { type: "start"; t: 0; seed; size: SizeId; grid; timeLimitMs; seats: { id; name; pos; dir }[] }
  | { type: "move"; t; seat; dir: Dir; choice: string; confidence: number; note?: string }
  | { type: "crash"; t; seat; reason: string }
  | { type: "retry"; t; seat; attempt; message; waitMs }
  | { type: "end"; t; winner: number; reason: "last" | "time"; standings: SeatResult[];
      tokens: { input; output }; durationMs; saved?: boolean; id?: string }
  | { type: "error"; message: string };
```

A `move` event carries the direction actually played (straight, if the
answer was outside the options), so replaying `applyMove` over the log
rebuilds the board exactly. A `crash` always follows the `move` that
caused it; a `crash` with no preceding move is a disconnect.

## Tasks

### 1. Shared isometric helpers
- Move `project`, `diamond`, `Block` and the tile constants out of
  `src/app/IsoBoard.tsx` into `src/app/iso.tsx`; `IsoBoard` imports them.
- Check: typecheck, and the Play page's Crate Runner and Signal Run
  boards look unchanged.

### 2. Config: sizes, seats, estimates
- `src/lib/arena/config.ts` as above.
- Test: default size per seat count; the estimate grows with seats and
  size.

### 3. Arena generation
- `generateArena(seed, size, seats)`: border walls; obstacle clusters
  (random walks of 3–8 cells) until 3–5% of interior cells are blocked,
  rejecting any cluster that disconnects the open cells or touches a
  start's keep-out zone; starts evenly spaced on an ellipse around the
  centre, facing it, with the cells ahead kept open.
- Tests (`tests/arena.board.test.ts`): same seed → same board; obstacles
  in the 3–5% band; open cells all connected; starts spaced apart, each
  facing open cells with plenty of room.

### 4. Moves, crashes, winner
- `applyMove(board, seat, dir, t)`: wall, any trail or any head crashes
  the mover (with a named reason); otherwise the head advances and the
  cell it left stays as trail. `eliminate(board, seat, reason, t)`.
- `winnerOf(board)`: the last seat alive, else `null`.
  `timeWinner(board)`: most cells, then earliest to reach them, then seat
  order. `standings(board, winner)`.
- Tests: each crash kind with its reason; trails persist; crashed heads
  stay as obstacles; time tiebreak.

### 5. Room, CONTESTED, and what a seat sees
- `room(board, seat, dir)`: flood fill of empty cells from the
  destination (counted as occupied) and the living rivals bordering it.
  `contested(board, seat, dir)`.
- `describeState(board, seat, elapsedMs, limitMs)` and
  `describeOptions(board, seat)` produce the text in the spec, with 1-based
  rows and columns that match the printed map. `INSTRUCTIONS` constant.
- Tests: room equals a brute-force count; CONTESTED marks exactly the
  cells next to living rival heads; every option's text matches the real
  outcome of `applyMove` on a copy of the board; the map text round-trips.

### 6. Arena demo bot
- In `src/lib/agents/demo.ts`, a "Live Arena" branch: the non-FATAL option
  with the most Room, ties by option order (`sloppy` adds jitter and the
  odd second-best pick so demo matches differ).
- Test: picks the roomiest safe option; picks straight into a wall only
  when every option is fatal.

### 7. The match loop
- `runMatch({ seed, size, agents, emit, signal, clock, paceMs })`.
  `withRetries` gains an optional `sleep` so the injected clock also drives
  backoff.
- One loop per seat: read the board, ask, wait out the pace, apply to the
  current board. The time limit races the loops. Each seat has its own
  abort controller; the match aborts all of them when it ends.
- Tests (`tests/arena.match.test.ts`, fake agents on a fake clock): last
  one standing ends at once with one winner; time-limit tiebreak; an
  out-of-options answer goes straight and crashes if that is fatal; pace
  is honoured; no calls after abort; late answers discarded.

### 8. Match errors
- 429/529 backs off and pauses only that seat (`retry` event). Other
  retryable errors: out as "disconnected" after 3 retries. A
  non-retryable provider error (401) stops the match with an error.
- Tests: each of the three.

### 9. Storage and replay
- `matches` table in `src/lib/db.ts`: `saveMatch`, `listMatches`,
  `getMatch`. `src/lib/arena/replay.ts`: `replayTo(events, t)` builds the
  board at any moment of a log.
- Tests: save/list/get round-trip on an in-memory DB; replaying a finished
  match's log reproduces its final board and standings exactly.

### 10. API
- `POST /api/match` (SSE with keep-alives, max 2 at once, save on end,
  discard on abandon or error), `GET /api/matches`,
  `GET /api/matches/[id]`.
- Tests: a JEV-format match through `runMatch` against
  `tests/fakeProvider.ts`; the route's validation (bad seats, size,
  provider).

### 11. Lobby and live match screen
- Arena tab in the nav. `/arena`: seat stepper, size (defaulting by
  seats), provider, key, live estimate line, Start, recent matches.
- `ArenaBoard`: static floor and walls memoized; trails and heads as a
  depth-sorted list of memoized cells; burst marker on crashed heads;
  Fit/1×/2× zoom with drag to pan. Events are applied once per animation
  frame.
- Seat cards (status, cells, moves, last choice and confidence, moves/s,
  how it went out), clock, event feed, Stop, winner banner and standings.
- Check in the browser: a demo match at each size, light and dark mode,
  phone width.

### 12. Replay page and final checks
- `/arena/[id]`: the same view driven by the saved log; play/pause,
  1×/2×/4×, draggable timeline.
- Check in the browser: replay of a finished demo match; frame rate on
  Huge with 6 seats.
- Live JEV calibration (one match per size) needs a real key and is left
  for the owner to run; the estimate formula is the one to adjust.
