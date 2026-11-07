import { and, eq, gte, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { db, t } from '@/db'

type Project = typeof t.projects.$inferSelect

export type SpendKind = 'ai' | 'lead_data' | 'email_verification' | 'mailbox'

export async function recordSpend(o: {
  orgId: string
  projectId: string
  campaignId?: string | null
  kind: SpendKind
  micros: number
  detail?: object
}) {
  await db.insert(t.spendEvents).values({
    orgId: o.orgId,
    projectId: o.projectId,
    campaignId: o.campaignId ?? null,
    kind: o.kind,
    amountMicros: Math.max(0, Math.round(o.micros)),
    detail: o.detail ?? {},
  })
}

async function spentSince(projectId: string, since: string) {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${t.spendEvents.amountMicros}), 0)` })
    .from(t.spendEvents)
    .where(and(eq(t.spendEvents.projectId, projectId), gte(t.spendEvents.occurredAt, since)))
  return Number(row.total)
}

export const spentToday = (p: Project) =>
  spentSince(p.id, DateTime.utc().setZone(p.timezone).startOf('day').toUTC().toISO()!)

/** Monthly caps run on the calendar month in UTC. */
export const spentThisMonth = (p: Project) => spentSince(p.id, DateTime.utc().startOf('month').toISO()!)

export type BudgetStop = 'zero_budget' | 'daily_budget_reached' | 'monthly_cap_reached'

/** Why this project may not spend or send right now. Null means it can. */
export async function budgetStop(p: Project): Promise<BudgetStop | null> {
  if (Number(p.dailyBudgetMicros) === 0) return 'zero_budget'
  if (p.monthlyCapMicros !== null && (await spentThisMonth(p)) >= Number(p.monthlyCapMicros)) return 'monthly_cap_reached'
  if ((await spentToday(p)) >= Number(p.dailyBudgetMicros)) return 'daily_budget_reached'
  return null
}
