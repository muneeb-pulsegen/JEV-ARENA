import Link from "next/link";
import { serverKey } from "@/lib/agents/providers";
import { PROVIDERS, type ProviderId } from "@/lib/agents/types";
import { SIZES } from "@/lib/arena/config";
import { listMatches } from "@/lib/db";
import ArenaLobby from "./ArenaLobby";
import { clock } from "./model";

export const dynamic = "force-dynamic";

export default function ArenaPage() {
  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, serverKey: !!serverKey(id as ProviderId) }));
  const matches = listMatches(20);
  return (
    <>
      <h1>Live Arena</h1>
      <p className="lede">
        Two to six JEV agents share one board and move the moment their own answers arrive. Every step leaves a permanent trail;
        hit a wall, a trail or a head and you&apos;re out. The last one standing wins.
      </p>
      <ArenaLobby providers={providers} />
      <section className="panel recent" aria-label="Recent matches">
        <h2>Recent matches</h2>
        {matches.length === 0 ? (
          <div className="empty">No matches yet. Start one above.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Winner</th>
                  <th>Players</th>
                  <th>Map</th>
                  <th>Ended</th>
                  <th className="num">Length</th>
                  <th>Date</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => {
                  const w = m.results[0];
                  return (
                    <tr key={m.id}>
                      <td>
                        <span className="seat-dot" style={{ ["--sc" as string]: `var(--seat-${w.id})` }} /> {w.name}
                        {m.provider === "demo" && <span className="pill">demo</span>}
                      </td>
                      <td>
                        <span className="stepper-dots">
                          {m.results.map((r) => <i key={r.id} style={{ background: `var(--seat-${r.id})` }} />)}
                        </span>
                      </td>
                      <td className="sub">{SIZES[m.size].label}</td>
                      <td className="sub">{m.endReason === "last" ? "last standing" : "time limit"}</td>
                      <td className="num sub">{clock(m.durationMs)}</td>
                      <td className="sub">{new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                      <td><Link href={`/arena/${m.id}`}>Replay →</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
