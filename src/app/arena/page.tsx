import Link from "next/link";
import { serverKey } from "@/lib/agents/providers";
import { PROVIDERS, type ProviderId } from "@/lib/agents/types";
import { SIZES, type SizeId } from "@/lib/frontline/config";
import type { Standing } from "@/lib/frontline/rules";
import { listMatches } from "@/lib/db";
import FrontlineLobby from "./FrontlineLobby";

export const dynamic = "force-dynamic";

export default function FrontlinePage() {
  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, serverKey: !!serverKey(id as ProviderId) }));
  const matches = listMatches<Standing>("frontline", 20);
  return (
    <>
      <h1>Frontline</h1>
      <p className="lede">
        Two to six JEV agents fight over a hex map. Every round each one secretly picks a single order, attack or reinforce, and
        all orders land at once. Take a rival&apos;s capital and it&apos;s out, and its land is yours. The last one standing wins.
      </p>
      <FrontlineLobby providers={providers} />
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
                  <th className="num">Rounds</th>
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
                      <td className="sub">{m.endReason === "last" ? "last standing" : "round limit"}</td>
                      <td className="num sub">{m.rounds}</td>
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
