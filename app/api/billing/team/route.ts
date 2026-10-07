import { checkNewMember, normalizeEmail, ownPlan, SEAT_ERRORS } from "@/lib/billing";
import { addTeamMember, listTeamMembers, removeTeamMember } from "@/lib/billing-store";
import { billingContext, json } from "@/lib/billing-route";
import { TEAM_SEATS } from "@/lib/plans";

export const dynamic = "force-dynamic";

/** Team seats: the owner plus up to four member emails. */
async function state(ownerId: string) {
  const members = await listTeamMembers(ownerId);
  return { members, used: members.length + 1, seats: TEAM_SEATS };
}

export async function GET() {
  const ctx = await billingContext({ paystack: false });
  if (ctx instanceof Response) return ctx;
  return json(await state(ctx.account.user.id));
}

export async function POST(request: Request) {
  const ctx = await billingContext({ paystack: false });
  if (ctx instanceof Response) return ctx;
  const { user, row } = ctx.account;

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const members = (await listTeamMembers(user.id)).map((m) => m.email);
  const check = checkNewMember({
    ownerPlan: ownPlan(row, new Date()),
    ownerEmail: user.email ?? null,
    members,
    email: body?.email,
  });
  if (!check.ok) return json({ error: SEAT_ERRORS[check.error] }, check.error === "not-team" ? 403 : 400);

  try {
    await addTeamMember(user.id, check.email);
  } catch (err) {
    // The database also caps seats, in case two adds race.
    console.error("add team member failed", err);
    return json({ error: SEAT_ERRORS.full }, 409);
  }
  return json(await state(user.id));
}

export async function DELETE(request: Request) {
  const ctx = await billingContext({ paystack: false });
  if (ctx instanceof Response) return ctx;
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: SEAT_ERRORS.invalid }, 400);
  await removeTeamMember(ctx.account.user.id, email);
  return json(await state(ctx.account.user.id));
}
