import Link from "next/link";
import { listRuns } from "@/lib/db";
import { GAMES } from "@/lib/games";

export const dynamic = "force-dynamic";

export default function LeaderboardPage() {
  const runs = listRuns();
  return (
    <>
      <h1>Leaderboard</h1>
      <p className="lede">
        Every completed run, ranked by the average of its four game scores (0–100 each). Runs through a third-party gateway are
        marked unverified, because we can&apos;t confirm which model actually answered.
      </p>
      <div className="panel">
        {runs.length === 0 ? (
          <div className="empty">No ranked runs yet. <Link href="/">Be the first →</Link></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  <th>Route</th>
                  {GAMES.map((g) => <th key={g.id} className="num" style={{ color: `var(--${g.id})` }}>{g.axis}</th>)}
                  <th className="num">Overall</th>
                  <th className="num">Tokens</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={r.id}>
                    <td className="rank">{i + 1}</td>
                    <td>
                      <div>{r.displayName}</div>
                      {r.displayName !== r.model && <div className="sub">{r.model}</div>}
                    </td>
                    <td>
                      {r.route} {!r.verified && <span className="pill warn">unverified</span>}
                    </td>
                    {GAMES.map((g) => <td key={g.id} className="num">{r.scores[g.id]}</td>)}
                    <td className="num overall">{r.overall.toFixed(1)}</td>
                    <td className="num sub">{Math.round((r.tokensIn + r.tokensOut) / 1000)}k</td>
                    <td className="sub">{new Date(r.createdAt).toISOString().slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
