import { CITY_DEFENCE, REINFORCE, SIZES, type SizeId } from "./config";
import { capitalOf, citiesOf, cloneState, NEUTRAL, regionsOf, troopsOf, type GameMap, type State } from "./map";

export type Order = { kind: "attack"; from: number; to: number } | { kind: "reinforce"; at: number };

export type Clash = { from: number; to: number; players: [number, number]; armies: [number, number]; survivor: number | null; left: number };
export type Battle = {
  target: number;
  /** Armies that reached the target after clashes, largest first. */
  attackers: { player: number; army: number }[];
  defender: number;
  defended: number;
  /** The player who took the region, or null if the defender held. */
  captured: number | null;
  left: number;
};
export type Report = {
  round: number;
  income: number[];
  orders: (Order | null)[];
  clashes: Clash[];
  battles: Battle[];
  /** Players knocked out this round; `capital` means their capital fell and `by` took all their regions. */
  eliminated: { player: number; by: number | null; capital: boolean }[];
  /** Empty land that joined a player because only that player borders it. */
  grown: { hex: number; player: number }[];
};

export type Standing = {
  player: number;
  id: string;
  name: string;
  place: number;
  regions: number;
  troops: number;
  out?: string;
  outRound?: number;
};

/** Troops a Reinforce order places. */
export const reinforcement = (inc: number) => Math.floor(inc * REINFORCE);

export const income = (m: GameMap, s: State, p: number) => {
  const regions = regionsOf(s, p);
  return regions === 0 ? 0 : 3 + Math.floor(regions / 2) + 2 * citiesOf(m, s, p);
};

/** How strongly a region defends: cities count 1.5×, rounded down. */
export const defence = (m: GameMap, hex: number, troops: number) => (m.city[hex] ? Math.floor(troops * CITY_DEFENCE) : troops);

/** One army against a region's defenders. Deterministic: no dice. */
export function battle(m: GameMap, hex: number, army: number, troops: number): { captured: boolean; left: number } {
  const def = defence(m, hex, troops);
  if (army > def) return { captured: true, left: army - def };
  const lost = m.city[hex] ? Math.floor(army / CITY_DEFENCE) : army;
  return { captured: false, left: Math.max(1, troops - lost) };
}

export function isValid(m: GameMap, s: State, p: number, o: Order): boolean {
  if (o.kind === "reinforce") return s.owner[o.at] === p;
  return s.owner[o.from] === p && s.troops[o.from] >= 2 && m.adj[o.from].includes(o.to) && s.owner[o.to] !== p;
}

/**
 * Resolves one round of simultaneous orders. Armies leave together, head-on
 * armies meet first, reinforcements land, every target is fought over, then
 * income backfills each attacker's source and players with no regions are out.
 */
export function resolveRound(m: GameMap, prev: State, orders: (Order | null)[]): { state: State; report: Report } {
  const s = cloneState(prev);
  s.round = prev.round + 1;
  const inc = s.players.map((pl, p) => (pl.alive ? income(m, prev, p) : 0));
  const clean = orders.map((o, p) => (o && s.players[p]?.alive && isValid(m, prev, p, o) ? o : null));
  const report: Report = { round: s.round, income: inc, orders: clean, clashes: [], battles: [], eliminated: [], grown: [] };

  const armies = clean.flatMap((o, p) => {
    if (o?.kind !== "attack") return [];
    const army = s.troops[o.from] - 1;
    s.troops[o.from] = 1;
    return [{ player: p, from: o.from, to: o.to, army }];
  });

  for (const a of armies) {
    const b = armies.find((x) => x.from === a.to && x.to === a.from);
    if (!b || a.player > b.player) continue;
    const clash: Clash = { from: a.from, to: a.to, players: [a.player, b.player], armies: [a.army, b.army], survivor: null, left: 0 };
    if (a.army > b.army) [clash.survivor, clash.left] = [a.player, a.army - b.army];
    else if (b.army > a.army) [clash.survivor, clash.left] = [b.player, b.army - a.army];
    a.army = clash.survivor === a.player ? clash.left : 0;
    b.army = clash.survivor === b.player ? clash.left : 0;
    report.clashes.push(clash);
  }

  clean.forEach((o, p) => {
    if (o?.kind === "reinforce") s.troops[o.at] += reinforcement(inc[p]);
  });

  const captor = new Map<number, number>();
  const targets = [...new Set(armies.filter((a) => a.army > 0).map((a) => a.to))];
  for (const t of targets) {
    const here = armies.filter((a) => a.to === t && a.army > 0).sort((x, y) => y.army - x.army || x.player - y.player);
    const entry: Battle = {
      target: t,
      attackers: here.map(({ player, army }) => ({ player, army })),
      defender: s.owner[t],
      defended: s.troops[t],
      captured: null,
      left: s.troops[t],
    };
    const top = here[0];
    const army = here.length > 1 ? top.army - here[1].army : top.army;
    if (army > 0) {
      const r = battle(m, t, army, s.troops[t]);
      entry.left = r.left;
      if (r.captured) {
        entry.captured = top.player;
        s.owner[t] = top.player;
        captor.set(entry.defender, top.player);
      }
      s.troops[t] = r.left;
    }
    report.battles.push(entry);
  }

  clean.forEach((o, p) => {
    if (o?.kind === "attack" && s.owner[o.from] === p) s.troops[o.from] += inc[p];
  });

  // Borders grow: empty land touching exactly one player's territory joins it with one troop.
  // Neutral cities, and land two players both touch, still have to be taken by attack.
  const grown: [number, number][] = [];
  s.owner.forEach((o, hex) => {
    if (o !== NEUTRAL || m.lake[hex] || m.city[hex]) return;
    const touching = new Set(m.adj[hex].map((n) => s.owner[n]).filter((x) => x !== NEUTRAL));
    if (touching.size === 1) grown.push([hex, [...touching][0]]);
  });
  for (const [hex, p] of grown) {
    s.owner[hex] = p;
    s.troops[hex] = 1;
  }
  report.grown = grown.map(([hex, player]) => ({ hex, player }));

  // A fallen capital knocks its player out and hands every region it holds to the captor.
  // Repeat until settled: a conquest can hand a captor back its own lost capital.
  for (let changed = true; changed; ) {
    changed = false;
    s.players.forEach((pl, p) => {
      const by = s.owner[m.starts[p]];
      if (!pl.alive || by === p || by === NEUTRAL || m.starts[p] === undefined) return;
      s.owner.forEach((o, i) => o === p && (s.owner[i] = by));
      pl.alive = false;
      pl.out = `lost its capital to ${s.players[by].name}`;
      pl.outRound = s.round;
      report.eliminated.push({ player: p, by, capital: true });
      changed = true;
    });
  }

  s.players.forEach((pl, p) => {
    if (!pl.alive) return;
    const now = regionsOf(s, p);
    if (now === 0) {
      const by = captor.get(p) ?? null;
      pl.alive = false;
      pl.out = by === null ? "lost its last region" : `lost its last region to ${s.players[by].name}`;
      pl.outRound = s.round;
      report.eliminated.push({ player: p, by, capital: false });
    } else if (now !== regionsOf(prev, p)) pl.reachedAt = s.round;
  });
  return { state: s, report };
}

/** Takes a player out without a battle (a disconnect). Its regions keep their troops and turn neutral. */
export function disconnect(s: State, p: number) {
  const pl = s.players[p];
  if (!pl.alive) return;
  pl.alive = false;
  pl.out = "disconnected";
  pl.outRound = s.round;
  s.owner.forEach((o, i) => o === p && (s.owner[i] = NEUTRAL));
}

export const alivePlayers = (s: State) => s.players.flatMap((p, i) => (p.alive ? [i] : []));

/** The winner if the match is over: the last player holding territory, or the leader at the round limit. */
export function winnerOf(s: State, size: SizeId): { winner: number; reason: "last" | "limit" } | null {
  const alive = alivePlayers(s);
  if (alive.length === 1) return { winner: alive[0], reason: "last" };
  if (s.round < SIZES[size].rounds) return null;
  const pool = alive.length ? alive : s.players.map((_, i) => i);
  const key = (p: number) => [regionsOf(s, p), troopsOf(s, p), -s.players[p].reachedAt];
  const winner = pool.reduce((best, p) => {
    const a = key(p), b = key(best);
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k] ? p : best;
    return best;
  });
  return { winner, reason: "limit" };
}

/** Winner first, then the living by regions and troops, then the eliminated from last out to first. */
export function standings(s: State, winner: number): Standing[] {
  const rest = s.players
    .map((_, i) => i)
    .filter((i) => i !== winner)
    .sort((a, b) => {
      const pa = s.players[a], pb = s.players[b];
      if (pa.alive !== pb.alive) return pa.alive ? -1 : 1;
      if (pa.alive) return regionsOf(s, b) - regionsOf(s, a) || troopsOf(s, b) - troopsOf(s, a) || a - b;
      return (pb.outRound ?? 0) - (pa.outRound ?? 0) || a - b;
    });
  return [winner, ...rest].map((p, k) => {
    const pl = s.players[p];
    return {
      player: p,
      id: pl.id,
      name: pl.name,
      place: k + 1,
      regions: regionsOf(s, p),
      troops: troopsOf(s, p),
      ...(pl.out ? { out: pl.out, outRound: pl.outRound } : {}),
    };
  });
}

// ---------- What a player sees ----------

const ownerName = (s: State, o: number) => (o === NEUTRAL ? "neutral" : `${s.players[o].name}'s`);

/** The biggest army a rival could send into `hex` this round: its strongest neighbouring rival region, minus the one troop left behind. */
function biggestThreat(m: GameMap, s: State, p: number, hex: number, except?: number) {
  let best: { from: number; army: number } | null = null;
  for (const n of m.adj[hex]) {
    const o = s.owner[n];
    if (o === NEUTRAL || o === p || n === except) continue;
    const army = s.troops[n] - 1;
    if (army > 0 && (!best || army > best.army)) best = { from: n, army };
  }
  return best;
}

const threatText = (m: GameMap, s: State, t: { from: number; army: number } | null) =>
  t ? `${s.players[s.owner[t.from]].name}'s ${m.name[t.from]} could attack it with ${t.army}.` : "No rival borders it.";

/**
 * Up to six attacks (rival capitals first, then the best margins, each from its strongest
 * source), two defensive reinforcements, and a staging reinforcement next to a rival capital.
 * Each option is described by its outcome.
 */
export function options(m: GameMap, s: State, p: number): { choices: Record<string, string>; orders: Record<string, Order> } {
  const inc = income(m, s, p);
  const best = new Map<number, number>();
  s.owner.forEach((o, from) => {
    if (o !== p || s.troops[from] < 2) return;
    for (const to of m.adj[from]) {
      if (s.owner[to] === p) continue;
      const cur = best.get(to);
      if (cur === undefined || s.troops[from] > s.troops[cur]) best.set(to, from);
    }
  });
  // A capital within reach always makes the list, ahead of other attacks that would also succeed.
  const isCapital = (hex: number) => {
    const c = capitalOf(m, hex);
    return c >= 0 && c !== p && s.players[c].alive && s.owner[hex] === c;
  };
  const attacks = [...best.entries()]
    .map(([to, from]) => ({ from, to, army: s.troops[from] - 1, margin: s.troops[from] - 1 - defence(m, to, s.troops[to]) }))
    .sort((a, b) => Number(isCapital(b.to)) - Number(isCapital(a.to)) || b.margin - a.margin || a.to - b.to)
    .slice(0, 6);

  const choices: Record<string, string> = {};
  const orders: Record<string, Order> = {};
  attacks.forEach((a, k) => {
    const id = `A${k + 1}`;
    const t = a.to;
    const d = s.troops[t];
    const city = m.city[t];
    const r = battle(m, t, a.army, d);
    const kind = isCapital(t) ? "capital " : city ? "city " : "";
    const lines = [
      `Attack ${ownerName(s, s.owner[t])} ${kind}${m.name[t]} (${d} troops${city ? `, defends as ${defence(m, t, d)}` : ""}) from ${m.name[a.from]} with ${a.army}.`,
      r.captured ? `Takes it with ${r.left} left if nobody else moves.` : `Falls short: ${m.name[t]} holds with ${r.left} if nobody else moves.`,
    ];
    if (isCapital(t)) {
      const o = s.owner[t];
      lines.push(`Taking it knocks ${s.players[o].name} out and hands you all ${regionsOf(s, o)} of its regions.`);
    }
    const o = s.owner[t];
    if (o !== NEUTRAL) {
      lines.push(`${s.players[o].name} can reinforce ${m.name[t]} by up to ${reinforcement(income(m, s, o))}.`);
      if (d >= 2) lines.push(`${s.players[o].name}'s ${m.name[t]} could strike ${m.name[a.from]} head-on with ${d - 1}.`);
    }
    const rival = biggestThreat(m, s, p, t, undefined);
    if (rival && s.owner[rival.from] !== o) lines.push(`${s.players[s.owner[rival.from]].name}'s ${m.name[rival.from]} (${rival.army + 1}) could also attack it.`);
    lines.push(`${m.name[a.from]} keeps 1 + ${inc} income. ${threatText(m, s, biggestThreat(m, s, p, a.from, t))}`);
    choices[id] = lines.join(" ");
    orders[id] = { kind: "attack", from: a.from, to: t };
  });

  const reinforceText = (hex: number) =>
    `Reinforce ${m.starts[p] === hex ? "your capital " : m.city[hex] ? "city " : ""}${m.name[hex]} (${s.troops[hex]}) with ${reinforcement(inc)} → ${s.troops[hex] + reinforcement(inc)}. No attack this round.`;
  const defend = threatened(m, s, p).slice(0, 2);
  defend.forEach((hex, k) => {
    choices[`R${k + 1}`] = `${reinforceText(hex)} ${threatText(m, s, biggestThreat(m, s, p, hex))}`;
    orders[`R${k + 1}`] = { kind: "reinforce", at: hex };
  });

  // Staging: build up next to a rival capital that is in reach but too strong to take this round.
  const strike = [...best.entries()]
    .filter(([to]) => isCapital(to))
    .map(([to, from]) => ({ to, from }))
    .find(({ to, from }) => !battle(m, to, s.troops[from] - 1, s.troops[to]).captured);
  if (strike && !defend.includes(strike.from)) {
    const { to, from } = strike;
    const next = s.troops[from] + reinforcement(inc) - 1;
    const rival = s.players[s.owner[to]].name;
    choices.R3 = `${reinforceText(from)} Stages a strike on ${rival}'s capital ${m.name[to]} (${s.troops[to]} troops, defends as ${defence(m, to, s.troops[to])}): next round ${m.name[from]} could attack it with ${next}, before ${rival}'s own moves. ${threatText(m, s, biggestThreat(m, s, p, from))}`;
    orders.R3 = { kind: "reinforce", at: from };
  }
  return { choices, orders };
}

/** A player's regions, most threatened first: biggest rival army next door minus the region's defence. */
export function threatened(m: GameMap, s: State, p: number): number[] {
  return s.owner
    .flatMap((o, i) => (o === p ? [i] : []))
    .map((hex) => {
      const enemy = biggestThreat(m, s, p, hex)?.army;
      // Losing the capital loses everything, so it counts as more threatened than its numbers alone say.
      const danger = enemy === undefined ? -99 : enemy - defence(m, hex, s.troops[hex]) + (m.starts[p] === hex ? 4 : 0);
      return { hex, danger, border: m.adj[hex].some((n) => s.owner[n] !== p) };
    })
    .sort((a, b) => b.danger - a.danger || Number(b.border) - Number(a.border) || s.troops[a.hex] - s.troops[b.hex] || a.hex - b.hex)
    .map((x) => x.hex);
}

/** What a player plays when its answer is missing or not one of the options. */
export const fallbackOrder = (m: GameMap, s: State, p: number): Order => ({ kind: "reinforce", at: threatened(m, s, p)[0] });

export const INSTRUCTIONS = [
  "You are playing Frontline, a territory war on a hex map against other players. The last player holding any region wins.",
  "Every round, each player earns troops (3 + 1 per 3 regions held + 2 per city held) and picks ONE order in secret.",
  "Attack: every troop but one leaves a region you hold and attacks a neighbouring region. Your round's income then lands on the region you attacked from.",
  "Reinforce: double your round's income lands on one of your regions, and you make no attack.",
  "All orders are revealed and resolved together. Two armies attacking each other across the same border meet head-on: the smaller is destroyed and the larger carries on with the difference.",
  "Several armies attacking the same region fight each other first; the largest carries on with the difference over the next largest.",
  "An army takes a region if it is larger than the defenders. Cities (*) and capitals (^) defend at 1.5× and pay +2 income. There are no dice.",
  "At the end of every round, empty land that touches only one player's territory joins that player with 1 troop. Neutral cities, and empty land two players both touch, must be attacked.",
  "Your starting region is your capital. If a rival takes it, you are out and that rival gets every region you hold. The same goes for rivals' capitals.",
  "Map lines read: region (* city, ^ capital), owner and troops (R/B/G/Y/V/T are players, n is neutral), then its neighbours. Lakes are not listed and cannot be crossed.",
  "Each option states its outcome if nobody else moves, and what rivals could do to change it this round. Pick the order most likely to leave you as the last player standing.",
].join("\n");

/** ^ for a living player's capital, * for any other city. */
const mark = (m: GameMap, s: State, hex: number) => {
  const c = capitalOf(m, hex);
  return c >= 0 && s.players[c].alive && s.owner[hex] === c ? "^" : m.city[hex] ? "*" : "";
};

const tag = (s: State, hex: number) => `${s.owner[hex] === NEUTRAL ? "n" : s.players[s.owner[hex]].id}${s.troops[hex]}`;

function summary(m: GameMap, s: State, r: Report | undefined): string {
  if (!r) return "Last round: this is the first round.";
  const name = (p: number) => s.players[p].name;
  const parts: string[] = [];
  for (const c of r.clashes) {
    parts.push(`${name(c.players[0])} and ${name(c.players[1])} met head-on between ${m.name[c.from]} and ${m.name[c.to]} (${c.armies[0]} vs ${c.armies[1]}).`);
  }
  for (const b of r.battles) {
    const who = name(b.attackers[0].player);
    const vs = b.defender === NEUTRAL ? "neutral" : name(b.defender);
    parts.push(b.captured !== null ? `${who} took ${m.name[b.target]} from ${vs}, ${b.left} left.` : `${who} failed to take ${m.name[b.target]} from ${vs}.`);
  }
  r.orders.forEach((o, p) => o?.kind === "reinforce" && parts.push(`${name(p)} reinforced ${m.name[o.at]} (+${reinforcement(r.income[p])}).`));
  const grew = s.players.flatMap((pl, p) => {
    const n = r.grown.filter((g) => g.player === p).length;
    return n ? [`${pl.name} +${n}`] : [];
  });
  if (grew.length) parts.push(`Borders grew: ${grew.join(", ")}.`);
  for (const e of r.eliminated) parts.push(`${name(e.player)} was eliminated (${s.players[e.player].out}).`);
  return `Last round: ${parts.join(" ") || "nothing happened."}`;
}

/** The per-round state text for one player. */
export function describeState(m: GameMap, s: State, p: number, size: SizeId, last?: Report): string {
  const me = s.players[p];
  const alive = s.players.flatMap((pl, i) => (pl.alive ? [`${pl.name} ${regionsOf(s, i)} regions`] : []));
  const out = s.players.flatMap((pl) => (pl.alive ? [] : [`${pl.name} (round ${pl.outRound}, ${pl.out})`]));
  const lines = m.lake
    .map((lake, hex) => (lake ? "" : `  ${m.name[hex]}${mark(m, s, hex)} ${tag(s, hex)}: ${m.adj[hex].map((n) => `${m.name[n]} ${tag(s, n)}`).join(", ")}`))
    .filter(Boolean);
  return [
    `Round ${s.round + 1} of ${SIZES[size].rounds}. You are ${me.name.toUpperCase()} (${me.id}). Income this round: ${income(m, s, p)} troops.`,
    `Alive: ${alive.join(", ")}.${out.length ? ` Out: ${out.join(", ")}.` : ""}`,
    `Your capital: ${m.name[m.starts[p]]}. Map, one line per region (region, * city, ^ capital, owner+troops: neighbours):`,
    ...lines,
    summary(m, s, last),
  ].join("\n");
}
