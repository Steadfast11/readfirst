import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { getCampaign } from './campaigns'
import { getProject } from './projects'

export type Totals = {
  contacted: number
  sent: number
  replies: number
  hot: number
  bounced: number
  unsubscribed: number
  spendMicros: number
  costPerContactedMicros: number | null
  costPerHotMicros: number | null
  replyRate: number | null
}

const since = (days: number | null) => (days ? sql`now() - make_interval(days => ${days})` : sql`'-infinity'::timestamptz`)

async function totals(leadScope: SQL, spendScope: SQL, days: number | null): Promise<Totals> {
  const from = since(days)
  const { rows } = await db.execute<Record<string, string | number>>(sql`
    with scoped as (select l.* from leads l join campaigns c on c.id = l.campaign_id where ${leadScope})
    select
      (select count(*) from scoped s where s.touches_sent > 0 and s.created_at >= ${from})::int as contacted,
      (select count(*) from messages m join scoped s on s.id = m.lead_id
        where m.direction = 'outbound' and m.status = 'sent' and m.sent_at >= ${from})::int as sent,
      (select count(distinct m.lead_id) from messages m join scoped s on s.id = m.lead_id
        where m.kind = 'reply' and m.received_at >= ${from})::int as replies,
      (select count(*) from scoped s where s.became_hot_at >= ${from})::int as hot,
      (select count(*) from messages m join scoped s on s.id = m.lead_id
        where m.kind = 'bounce' and m.received_at >= ${from})::int as bounced,
      (select count(*) from scoped s join contacts k on k.id = s.contact_id where k.unsubscribed_at >= ${from})::int as unsubscribed,
      (select coalesce(sum(e.amount_micros), 0) from spend_events e where ${spendScope} and e.occurred_at >= ${from})::bigint as spend`)
  const r = rows[0]
  const contacted = Number(r.contacted)
  const hot = Number(r.hot)
  const spendMicros = Number(r.spend)
  return {
    contacted,
    sent: Number(r.sent),
    replies: Number(r.replies),
    hot,
    bounced: Number(r.bounced),
    unsubscribed: Number(r.unsubscribed),
    spendMicros,
    costPerContactedMicros: contacted ? Math.round(spendMicros / contacted) : null,
    costPerHotMicros: hot ? Math.round(spendMicros / hot) : null,
    replyRate: contacted ? Number(r.replies) / contacted : null,
  }
}

export async function projectAnalytics(orgId: string, id: string, days: number | null = 30) {
  await getProject(orgId, id)
  return totals(sql`c.project_id = ${id}`, sql`e.project_id = ${id}`, days)
}

export async function campaignAnalytics(orgId: string, id: string, days: number | null = null) {
  await getCampaign(orgId, id)
  const result = await totals(sql`c.id = ${id}`, sql`e.campaign_id = ${id}`, days)
  const { rows } = await db.execute<{ stage: string; n: number }>(sql`
    select stage, count(*)::int as n from leads where campaign_id = ${id} group by stage`)
  const { rows: statuses } = await db.execute<{ name: string; n: number }>(sql`
    select s.name, count(*)::int as n from leads l join lead_statuses s on s.id = l.status_id
    where l.campaign_id = ${id} group by s.name, s.position order by s.position`)
  return { ...result, stages: Object.fromEntries(rows.map((r) => [r.stage, r.n])), statuses }
}

export async function spendByDay(orgId: string, id: string, days = 14) {
  const project = await getProject(orgId, id)
  const { rows } = await db.execute<{ day: string; kind: string; micros: string }>(sql`
    select to_char(occurred_at at time zone ${project.timezone}, 'YYYY-MM-DD') as day, kind, sum(amount_micros) as micros
    from spend_events where project_id = ${id} and occurred_at >= now() - make_interval(days => ${days})
    group by 1, 2 order by 1 desc, 2`)
  return rows.map((r) => ({ day: r.day, kind: r.kind, micros: Number(r.micros) }))
}

/** A leading = or + would run as a formula when opened in a spreadsheet. */
export const csvCell = (value: unknown) => {
  const text = String(value ?? '')
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export async function contactedCsv(orgId: string, id: string) {
  await getCampaign(orgId, id)
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    select k.email, k.first_name, k.last_name, k.company_name, k.job_title, l.stage, s.name as status, l.touches_sent, l.last_message_at
    from leads l join contacts k on k.id = l.contact_id left join lead_statuses s on s.id = l.status_id
    where l.campaign_id = ${id} and l.touches_sent > 0 and k.erased_at is null
    order by l.last_message_at desc nulls last`)
  const columns = ['email', 'first_name', 'last_name', 'company_name', 'job_title', 'stage', 'status', 'touches_sent', 'last_message_at']
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n')
}
