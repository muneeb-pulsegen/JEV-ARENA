import { listMatches } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const game = new URL(req.url).searchParams.get("game") ?? "frontline";
  return Response.json({ matches: listMatches(game, 50) });
}
