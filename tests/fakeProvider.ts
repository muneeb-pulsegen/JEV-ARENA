import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDemoAgent } from "@/lib/agents/demo";
import { createRng } from "@/lib/games/rng";

export type Recorded = { path: string; headers: http.IncomingHttpHeaders; body: any };

/** A local server speaking TypeSafe's System One wire format, answering with the demo solver. */
export async function startFakeProvider(opts: { failFirst?: number; failStatus?: number; retryAfter?: string } = {}) {
  const demo = createDemoAgent({ delayMs: 0, random: createRng(1).next });
  const requests: Recorded[] = [];
  let failures = opts.failFirst ?? 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (failures > 0) {
        failures--;
        const auth = String(req.headers.authorization ?? "");
        if (opts.retryAfter) res.setHeader("retry-after", opts.retryAfter);
        return send(opts.failStatus ?? 429, { detail: { error_type: "rate_limited", message: `slow down (key ${auth.replace("Bearer ", "")})` } });
      }

      if (req.url === "/v1/systemone") {
        // Every named question is answered independently, as the real API does.
        const answers: Record<string, unknown> = {};
        for (const [key, q] of Object.entries(body.questions as Record<string, any>)) {
          const r = await demo.decide(q.instructions, body.state, q.criteria, {});
          answers[key] = { type: "choice", choice: r.choice, confidence: r.confidence, probabilities: {} };
        }
        return send(200, { model: "jev-1.0.0", answers, usage: { input_tokens: 11, output_tokens: 3 } });
      }
      send(404, { detail: { error_type: "not_found", message: "not found" } });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
