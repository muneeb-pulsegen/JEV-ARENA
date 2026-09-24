import { UNIT_IDS, type Stack, type TechId, type UnitId } from "./config";
import { battle, defendersAt, stackStrength } from "./combat";
import { availableTechs, buyCost, cannotBuild, runEconomy, sameItem, type EconomyEvent } from "./economy";
import { distance, passable, path, type GameMap } from "./map";
import { cityAt, cloneState, foundCity, unitCount, type BuildItem, type State } from "./state";

export type ArmyOrder =
  | { kind: "march"; target: number }
  | { kind: "fortify" }
  | { kind: "muster"; city: number }
  | { kind: "garrison" }
  | { kind: "hold" };

export type Orders = {
  builds?: Record<number, { item: BuildItem; buy?: boolean }>;
  research?: TechId;
  army?: ArmyOrder;
  settle?: { settler: number; target: number | null };
};

export type TurnEvent =
  | EconomyEvent
  | { kind: "founded"; player: number; city: number; hex: number }
  | { kind: "battle"; hex: number; attacker: number; defender: number; attackerWins: boolean; attack: number; defence: number; city?: number; field: boolean }
  | { kind: "captured"; city: number; from: number; to: number }
  | { kind: "settler_lost"; player: number; by: number; hex: number }
  | { kind: "bought"; player: number; city: number; item: BuildItem; gold: number }
  | { kind: "eliminated"; player: number; by: number | null };

export type TurnReport = { turn: number; events: TurnEvent[] };

/** Units that stay behind when an army musters from a city: the best city defender. */
const KEEP_ORDER: UnitId[] = ["archer", "spearman", "swordsman", "warrior", "horseman", "catapult"];

function takeAllButOne(garrison: Stack): { taken: Stack; kept: Stack } {
  const keep = KEEP_ORDER.find((u) => (garrison[u] ?? 0) > 0);
  const taken: Stack = { ...garrison };
  const kept: Stack = {};
  if (keep) {
    taken[keep]! -= 1;
    kept[keep] = 1;
  }
  for (const u of UNIT_IDS) if (!taken[u]) delete taken[u];
  return { taken, kept };
}

/** Splits a defending hex's survivors back into the city's garrison (first) and the army. */
function splitSurvivors(original: Stack, left: Stack): { garrison: Stack; army: Stack } {
  const garrison: Stack = {}, army: Stack = {};
  for (const u of UNIT_IDS) {
    const n = left[u] ?? 0;
    const g = Math.min(n, original[u] ?? 0);
    if (g) garrison[u] = g;
    if (n - g) army[u] = n - g;
  }
  return { garrison, army };
}

/** A site where a settler may found a city: passable, no city within 2, not another player's land. */
export function validSite(m: GameMap, s: State, hex: number, player: number): boolean {
  if (!passable(m, hex)) return false;
  if (s.owner[hex] >= 0 && s.owner[hex] !== player) return false;
  return !s.cities.some((c) => distance(m, c.hex, hex) <= 2);
}

const speed = (units: Stack) => (unitCount(units) > 0 && unitCount(units) === (units.horseman ?? 0) ? 2 : 1);

/**
 * Resolves one turn of simultaneous orders: research and builds are set, armies
 * muster, garrison or fortify, then move step by step (colliding armies fight),
 * settlers walk and found cities, the economy runs, and players with no cities go out.
 */
export function resolveTurn(m: GameMap, prev: State, orders: (Orders | null)[]): { state: State; report: TurnReport } {
  const s = cloneState(prev);
  s.turn = prev.turn + 1;
  const events: TurnEvent[] = [];
  const alive = (p: number) => s.players[p]?.alive;

  // 1. Research and builds.
  orders.forEach((o, p) => {
    if (!o || !alive(p)) return;
    const pl = s.players[p];
    if (o.research && !pl.research && availableTechs(s, p).includes(o.research)) pl.research = o.research;
    for (const [id, b] of Object.entries(o.builds ?? {})) {
      const c = s.cities.find((x) => x.id === Number(id) && x.owner === p);
      if (!c || cannotBuild(m, s, c, b.item)) continue;
      if (!sameItem(c.build, b.item)) c.build = b.item;
      c.idle = false;
      if (b.buy) {
        const gold = buyCost(m, s, c, b.item);
        if (gold > 0 && gold <= pl.gold) {
          pl.gold -= gold;
          c.prod += gold / 2;
          events.push({ kind: "bought", player: p, city: c.id, item: b.item, gold });
        }
      }
    }
  });

  // 2. Army orders that don't move.
  const marching = new Map<number, number>();
  orders.forEach((o, p) => {
    const a = s.armies[p];
    if (!o?.army || !alive(p)) return;
    if (a) a.fortified = false;
    const ord = o.army;
    if (ord.kind === "fortify" && a) a.fortified = true;
    if (ord.kind === "muster") {
      const c = s.cities.find((x) => x.id === ord.city && x.owner === p);
      if (!c || (a && unitCount(a.units) > 0 && a.hex !== c.hex)) return;
      const { taken, kept } = takeAllButOne(c.garrison);
      if (!unitCount(taken)) return;
      c.garrison = kept;
      const units = a && a.hex === c.hex ? a.units : {};
      for (const u of UNIT_IDS) if (taken[u]) units[u] = (units[u] ?? 0) + taken[u]!;
      s.armies[p] = { hex: c.hex, units, fortified: false };
    }
    if (ord.kind === "garrison" && a) {
      const c = cityAt(s, a.hex);
      if (c && c.owner === p) {
        for (const u of UNIT_IDS) if (a.units[u]) c.garrison[u] = (c.garrison[u] ?? 0) + a.units[u]!;
        a.units = {};
      }
    }
    if (ord.kind === "march" && a && unitCount(a.units) > 0 && ord.target !== a.hex) marching.set(p, ord.target);
  });

  // 3. Movement, step by step. Every army still moving picks its next hex; collisions fight.
  const moves = new Map([...marching.keys()].map((p) => [p, speed(s.armies[p]!.units)]));
  // An army that fights stops for the rest of the turn.
  const halted = new Set<number>();
  for (let step = 0; step < 2; step++) {
    const next = new Map<number, number>();
    for (const [p, target] of marching) {
      const a = s.armies[p];
      if (!a || !unitCount(a.units) || halted.has(p) || (moves.get(p) ?? 0) <= step) continue;
      const route = path(m, a.hex, target);
      if (route && route.length > 1) next.set(p, route[1]);
    }
    const kill = (p: number) => {
      s.armies[p]!.units = {};
      halted.add(p);
    };

    // Field battles: two enemy armies heading into the same hex, or swapping hexes.
    const movers = [...next.keys()].sort((a, b) => a - b);
    for (const p of movers) {
      for (const q of movers) {
        if (q <= p || halted.has(p) || halted.has(q)) continue;
        const ap = s.armies[p]!, aq = s.armies[q]!;
        const same = next.get(p) === next.get(q);
        const swap = next.get(p) === aq.hex && next.get(q) === ap.hex;
        if (!same && !swap) continue;
        const hex = same ? next.get(p)! : ap.hex;
        // Neither side has ground to defend: both fight on open terrain, the stronger as "attacker".
        const pStrong = stackStrength(ap.units, aq.units) >= stackStrength(aq.units, ap.units);
        const [att, def] = pStrong ? [p, q] : [q, p];
        const r = battle(m, s.armies[att]!.units, { units: s.armies[def]!.units, hex });
        events.push({ kind: "battle", hex, attacker: att, defender: def, attackerWins: r.attackerWins, attack: r.attack, defence: r.defence, field: true });
        const [win, lose] = r.attackerWins ? [att, def] : [def, att];
        s.armies[win]!.units = r.attackerWins ? r.attackerLeft : r.defenderLeft;
        kill(lose);
        halted.add(win);
        if (same && unitCount(s.armies[win]!.units) && !defendersAt(m, s, hex)) s.armies[win]!.hex = hex;
      }
    }

    // Everyone else steps; stepping into an enemy army or city is an attack. Stronger attackers go first.
    const rest = movers
      .filter((p) => !halted.has(p))
      .sort((a, b) => stackStrength(s.armies[b]!.units, {}) - stackStrength(s.armies[a]!.units, {}) || a - b);
    for (const p of rest) {
      const a = s.armies[p]!;
      const to = next.get(p)!;
      if (!unitCount(a.units)) continue;
      const held = defendersAt(m, s, to);
      if (held && held.player !== p) {
        const r = battle(m, a.units, held.defence);
        const city = held.defence.city;
        events.push({ kind: "battle", hex: to, attacker: p, defender: held.player, attackerWins: r.attackerWins, attack: r.attack, defence: r.defence, city: city?.id, field: !city });
        const enemyArmy = s.armies[held.player]?.hex === to ? s.armies[held.player]! : null;
        if (r.attackerWins) {
          a.units = r.attackerLeft;
          if (city) city.garrison = {};
          if (enemyArmy) enemyArmy.units = {};
          if (unitCount(a.units)) {
            a.hex = to;
            if (city) {
              const from = city.owner;
              city.owner = p;
              city.pop = Math.max(1, city.pop - 1);
              city.buildings = city.buildings.filter((b) => b !== "walls" && b !== "castle");
              city.build = null;
              city.prod = 0;
              s.owner.forEach((o, i) => o === from && distance(m, i, city.hex) <= (city.pop >= 3 ? 2 : 1) && (s.owner[i] = p));
              s.owner[city.hex] = p;
              events.push({ kind: "captured", city: city.id, from, to: p });
            }
          }
        } else {
          a.units = {};
          const { garrison, army } = splitSurvivors(city?.garrison ?? {}, r.defenderLeft);
          if (city) city.garrison = garrison;
          if (enemyArmy) enemyArmy.units = city ? army : r.defenderLeft;
        }
        halted.add(p);
        continue;
      }
      a.hex = to;
    }

    // Settlers caught by an enemy army standing on them.
    s.settlers = s.settlers.filter((st) => {
      const hunter = s.armies.findIndex((x, q) => q !== st.owner && x && x.hex === st.hex && unitCount(x.units) > 0);
      if (hunter < 0) return true;
      events.push({ kind: "settler_lost", player: st.owner, by: hunter, hex: st.hex });
      return false;
    });
  }
  for (const a of s.armies) if (a && !unitCount(a.units)) a.fortified = false;

  // 4. Settlers: take new targets, walk one hex, found on arrival.
  orders.forEach((o, p) => {
    if (!o?.settle || !alive(p)) return;
    const st = s.settlers.find((x) => x.id === o.settle!.settler && x.owner === p);
    if (st) st.target = o.settle.target;
  });
  const founded: number[] = [];
  for (const st of [...s.settlers]) {
    if (st.target === null) continue;
    if (st.hex !== st.target) {
      const route = path(m, st.hex, st.target);
      if (!route) {
        st.target = null;
        continue;
      }
      const to = route[1];
      const blocker = s.armies.findIndex((x, q) => q !== st.owner && x && x.hex === to && unitCount(x.units) > 0);
      if (blocker >= 0) {
        events.push({ kind: "settler_lost", player: st.owner, by: blocker, hex: to });
        s.settlers = s.settlers.filter((x) => x !== st);
        continue;
      }
      st.hex = to;
    }
    if (st.hex === st.target) {
      if (validSite(m, s, st.hex, st.owner)) {
        const c = foundCity(m, s, st.owner, st.hex);
        events.push({ kind: "founded", player: st.owner, city: c.id, hex: c.hex });
        founded.push(st.id);
      } else st.target = null;
    }
  }
  s.settlers = s.settlers.filter((st) => !founded.includes(st.id));

  // 5. Economy.
  events.push(...runEconomy(m, s));

  // 6. Players with no cities are out; their army and settlers go with them.
  s.players.forEach((pl, p) => {
    if (!pl.alive || s.cities.some((c) => c.owner === p)) return;
    const last = [...events].reverse().find((e) => e.kind === "captured" && e.from === p) as Extract<TurnEvent, { kind: "captured" }> | undefined;
    pl.alive = false;
    pl.out = last ? `lost its last city to ${s.players[last.to].name}` : "lost its last city";
    pl.outTurn = s.turn;
    s.armies[p] = null;
    s.settlers = s.settlers.filter((st) => st.owner !== p);
    s.owner.forEach((o, i) => o === p && (s.owner[i] = -1));
    events.push({ kind: "eliminated", player: p, by: last?.to ?? null });
  });

  // 7. Vision.
  updateVision(m, s);
  return { state: s, report: { turn: s.turn, events } };
}

/** Hexes a player sees right now: within 2 of its cities and army, within 1 of its settlers. */
export function visible(m: GameMap, s: State, p: number): Set<number> {
  const out = new Set<number>();
  const add = (centre: number, r: number) => {
    for (let i = 0; i < m.q.length; i++) if (distance(m, centre, i) <= r) out.add(i);
  };
  for (const c of s.cities) if (c.owner === p) add(c.hex, 2);
  const a = s.armies[p];
  if (a && unitCount(a.units)) add(a.hex, 2);
  for (const st of s.settlers) if (st.owner === p) add(st.hex, 1);
  s.owner.forEach((o, i) => o === p && out.add(i));
  return out;
}

export function updateVision(m: GameMap, s: State) {
  s.players.forEach((pl, p) => {
    if (!pl.alive) return;
    for (const i of visible(m, s, p)) pl.seen[i] = true;
  });
}
