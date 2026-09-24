import { crateRunner } from "./crateRunner";
import { relaySorter } from "./relaySorter";
import { deriveSeed } from "./rng";
import { signalRun } from "./signalRun";
import { tumblerVault } from "./tumblerVault";
import type { GameDef, GameId } from "./types";

export const GAMES: GameDef<any>[] = [crateRunner, signalRun, tumblerVault, relaySorter];

export const GAME_IDS: GameId[] = GAMES.map((g) => g.id);

export const gameSeed = (runSeed: number, id: GameId) => deriveSeed(runSeed, GAME_IDS.indexOf(id) + 1);

export const estimateRunTokens = () => GAMES.reduce((a, g) => a + g.estTokens, 0);

export type { GameDef, GameId } from "./types";
export type * from "./views";
