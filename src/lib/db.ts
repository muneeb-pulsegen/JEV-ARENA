import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SeatResult } from "./arena/board";
import type { SizeId } from "./arena/config";
import type { MatchEvent } from "./arena/match";
import type { GameId } from "./games";

export type LeaderboardEntry = {
  id: string;
  createdAt: string;
  displayName: string;
  provider: string;
  model: string;
  route: string;
  verified: boolean;
  seed: number;
  overall: number;
  scores: Record<GameId, number>;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
};

let db: Database.Database | null = null;

function open() {
  if (db) return db;
  const file = process.env.ARENA_DB_PATH ?? path.join(process.cwd(), "data", "arena.db");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route TEXT NOT NULL,
    verified INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    overall REAL NOT NULL,
    planning INTEGER NOT NULL,
    routing INTEGER NOT NULL,
    mechanism INTEGER NOT NULL,
    dispatch INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    seed INTEGER NOT NULL,
    size TEXT NOT NULL,
    seats INTEGER NOT NULL,
    winner INTEGER NOT NULL,
    end_reason TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    results TEXT NOT NULL,
    log TEXT NOT NULL
  )`);
  return db;
}

export function saveRun(e: Omit<LeaderboardEntry, "id" | "createdAt">): LeaderboardEntry {
  const entry: LeaderboardEntry = { ...e, id: randomUUID(), createdAt: new Date().toISOString() };
  open()
    .prepare(
      `INSERT INTO runs VALUES (@id, @createdAt, @displayName, @provider, @model, @route, @verified, @seed, @overall,
        @planning, @routing, @mechanism, @dispatch, @tokensIn, @tokensOut, @durationMs)`,
    )
    .run({ ...entry, ...entry.scores, verified: entry.verified ? 1 : 0 });
  return entry;
}

export function listRuns(limit = 100): LeaderboardEntry[] {
  const rows = open().prepare(`SELECT * FROM runs ORDER BY overall DESC, created_at ASC LIMIT ?`).all(limit) as Record<string, any>[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    displayName: r.display_name,
    provider: r.provider,
    model: r.model,
    route: r.route,
    verified: !!r.verified,
    seed: r.seed,
    overall: r.overall,
    scores: { planning: r.planning, routing: r.routing, mechanism: r.mechanism, dispatch: r.dispatch },
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    durationMs: r.duration_ms,
  }));
}

export type MatchSummary = {
  id: string;
  createdAt: string;
  provider: string;
  seed: number;
  size: SizeId;
  seats: number;
  winner: number;
  endReason: "last" | "time";
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  results: SeatResult[];
};

export type MatchRecord = MatchSummary & { log: MatchEvent[] };

export function saveMatch(m: Omit<MatchRecord, "id" | "createdAt">): MatchSummary {
  const entry = { ...m, id: randomUUID(), createdAt: new Date().toISOString() };
  open()
    .prepare(
      `INSERT INTO matches VALUES (@id, @createdAt, @provider, @seed, @size, @seats, @winner, @endReason, @durationMs,
        @tokensIn, @tokensOut, @results, @log)`,
    )
    .run({ ...entry, results: JSON.stringify(entry.results), log: JSON.stringify(entry.log) });
  const { log: _log, ...summary } = entry;
  return summary;
}

const toSummary = (r: Record<string, any>): MatchSummary => ({
  id: r.id,
  createdAt: r.created_at,
  provider: r.provider,
  seed: r.seed,
  size: r.size,
  seats: r.seats,
  winner: r.winner,
  endReason: r.end_reason,
  durationMs: r.duration_ms,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  results: JSON.parse(r.results),
});

export function listMatches(limit = 20): MatchSummary[] {
  const rows = open()
    .prepare(`SELECT id, created_at, provider, seed, size, seats, winner, end_reason, duration_ms, tokens_in, tokens_out, results
      FROM matches ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, any>[];
  return rows.map(toSummary);
}

export function getMatch(id: string): MatchRecord | null {
  const r = open().prepare(`SELECT * FROM matches WHERE id = ?`).get(id) as Record<string, any> | undefined;
  return r ? { ...toSummary(r), log: JSON.parse(r.log) } : null;
}
