import type { GameView } from "./views";
import type { Choices } from "../agents/types";

export type GameId = "planning" | "routing" | "mechanism" | "dispatch";

export interface GameSession<A extends string = string> {
  /** The current turn's context: board/position/rules recap, fed to the model as `state`. */
  state(): string;
  /** This turn's fixed set of choices: option id -> description. */
  options(): Choices;
  /** `choice` is null when the provider returned something outside `options()`. */
  step(choice: A | null, elapsedMs: number): void;
  done(): boolean;
  /** 0–100 */
  score(): number;
  progress(): string;
  view(): GameView;
}

export interface GameDef<A extends string = string> {
  id: GameId;
  name: string;
  axis: string;
  blurb: string;
  /** Fixed rules text, sent as the Choice question's `instructions` every turn. */
  instructions: string;
  estTokens: number;
  create(seed: number): GameSession<A>;
}
