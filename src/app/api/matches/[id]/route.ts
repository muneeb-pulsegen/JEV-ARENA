import { getMatch } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const match = getMatch(id);
  return match ? Response.json(match) : Response.json({ error: "No such match." }, { status: 404 });
}
