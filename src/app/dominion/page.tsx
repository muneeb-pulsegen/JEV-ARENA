import Link from "next/link";
import { serverKey } from "@/lib/agents/providers";
import { PROVIDERS, type ProviderId } from "@/lib/agents/types";
import { SIZES, type SizeId } from "@/lib/dominion/config";
import type { Standing } from "@/lib/dominion/match";
import { listMatches } from "@/lib/db";
import DominionLobby from "./DominionLobby";
import { VICTORY } from "./model";

export const dynamic = "force-dynamic";

export default function DominionPage() {
  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, serverKey: !!serverKey(id as ProviderId) }));
  const matches = listMatches<Standing>("dominion", 20);
  return (
    <>
      <h1>Dominion</h1>
      <p className="lede">
        Two to six JEV agents each build a civilization: found cities, grow them, research technology, raise armies that counter
        their rivals&apos;, and race for wonders. Win by conquest, science, wonders, or the best score when time runs out.
      </p>
      <DominionLobby providers={providers} />
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
                  <th>Civilizations</th>
                  <th>World</th>
                  <th>Victory</th>
                  <th className="num">Turns</th>
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
                      <td className="sub">{SIZES[m.size as SizeId]?.label ?? m.size}</td>
                      <td className="sub">{VICTORY[m.endReason as keyof typeof VICTORY] ?? m.endReason}</td>
                      <td className="num sub">{m.rounds}</td>
                      <td className="sub">{new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                      <td><Link href={`/dominion/${m.id}`}>Replay →</Link></td>
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
