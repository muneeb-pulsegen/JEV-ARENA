/** Every game is a 5-step ladder; this is how far the agent has climbed. */
export type LadderStep = "locked" | "active" | "passed" | "failed";

/** Lives remaining; losing them all ends the game. */
export type Lives = { left: number; max: number };

/** Each life lost on a level scales that level's credit by this factor. */
export const LIFE_PENALTY = 0.75;

export type CrateView = {
  kind: "planning";
  ladder: LadderStep[];
  lives: Lives;
  size: number;
  level: number;
  levels: number;
  walls: boolean[];
  targets: number[];
  player: number;
  boxes: number[];
  moves: number;
  par: number;
  turn: number;
  turns: number;
  note: string;
};

export type SignalView = {
  kind: "routing";
  ladder: LadderStep[];
  lives: Lives;
  size: number;
  level: number;
  levels: number;
  walls: boolean[];
  holes: boolean[];
  goal: number;
  player: number;
  moves: number;
  par: number;
  turn: number;
  turns: number;
  note: string;
};

export type Lever = { id: string; deltas: number[] };

export type TumblerView = {
  kind: "mechanism";
  ladder: LadderStep[];
  lives: Lives;
  level: number;
  levels: number;
  modulus: number;
  levers: Lever[];
  dials: number[];
  presses: number;
  budget: number;
  par: number;
  failedAttempts: number;
  note: string;
};

export type Gate = "X" | "Y" | "Z";
export type SorterItem = { color: string; size: string | null };
export type SorterRule = { color: string; size: string | null; gate: Gate; exception?: boolean };

export type SorterView = {
  kind: "dispatch";
  ladder: LadderStep[];
  tier: number;
  round: number;
  maxRounds: number;
  rules: SorterRule[];
  rotation: number;
  item: SorterItem | null;
  last: { item: SorterItem; answer: Gate | null; expected: Gate; correct: boolean; tier: number } | null;
  history: { correct: boolean; tier: number }[];
  correct: number;
  wrong: number;
  points: number;
  timeLeftMs: number;
  budgetMs: number;
};

export type GameView = CrateView | SignalView | TumblerView | SorterView;
