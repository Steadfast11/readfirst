import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, t, type Db } from '@/db'
import { ApiError, notFound } from './http'
import { getProject } from './projects'
import { hasAiLines, hasValues, renderTemplate, VARIABLES, withinSendWindow, type Vars } from './render'
import { budgetStop } from './spend'
import { agentMode, aiConfigured, apiConfigured } from './ai'
import { enqueue } from './queue'
import { pendingVerification, providerConfigured, verifierConfigured } from './leadsource'

/** A form sends one item per line; the API sends a list. */
const lines = (v: unknown) => (typeof v === 'string' ? v.split('\n').map((x) => x.trim()).filter(Boolean) : v)
const listField = z.preprocess(lines, z.array(z.string().trim().min(1).max(300)).max(50))

const clock = z.string().regex(/^\d{2}:\d{2}$/, 'Use a time such as 09:00')
const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3))

const targeting = {
  offer: z.string().trim().max(2000).optional(),
  customer_problem: z.string().trim().max(2000).optional(),
  target_role: z.string().trim().max(300).optional(),
  target_geography: z.string().trim().max(300).optional(),
  target_company_size: z.string().trim().max(120).optional(),
  positive_criteria: listField.optional(),
  negative_criteria: listField.optional(),
  keywords: z.string().trim().max(500).optional(),
}

export const campaignCreate = z.strictObject({
  project_id: z.uuid(),
  name: z.string().trim().min(1).max(160),
  ...targeting,
})

export const campaignUpdate = z.strictObject({
  name: z.string().trim().min(1).max(160).optional(),
  ...targeting,
  example_clients: listField.optional(),
  language: z.string().trim().min(1).max(40).optional(),
  send_days: z.array(z.number().int().min(1).max(7)).min(1, 'Pick at least one day').optional(),
  send_start_minute: z.number().int().min(0).max(1439).optional(),
  send_end_minute: z.number().int().min(1).max(1440).optional(),
  send_start: clock.optional(),
  send_end: clock.optional(),
  max_touches: z.coerce.number().int().min(1).max(6).optional(),
  followup_delay_days: z.coerce.number().int().min(1).max(30).optional(),
  followup_instructions: z.string().trim().max(3000).optional(),
  reply_instructions: z.string().trim().max(3000).optional(),
  use_project_email: z.boolean().optional(),
})

export const firstEmailUpdate = z.strictObject({
  mode: z.enum(['instructions', 'my_copy']).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().max(5000).optional(),
  instructions: z.string().trim().max(3000).optional(),
})

export async function listCampaigns(orgId: string, projectId: string) {
  const rows = await db
    .select({
      campaign: t.campaigns,
      leads: count(t.leads.id),
      hot: sql<number>`count(${t.leads.becameHotAt})::int`,
      replied: sql<number>`count(*) filter (where ${t.leads.stage} = 'replied')::int`,
      sent: sql<number>`coalesce(sum(${t.leads.touchesSent}), 0)::int`,
    })
    .from(t.campaigns)
    .leftJoin(t.leads, eq(t.leads.campaignId, t.campaigns.id))
    .where(and(eq(t.campaigns.orgId, orgId), eq(t.campaigns.projectId, projectId), ne(t.campaigns.status, 'archived')))
    .groupBy(t.campaigns.id)
    .orderBy(desc(t.campaigns.createdAt))
  return rows
}

export async function getCampaign(orgId: string, id: string) {
  const [campaign] = await db
    .select()
    .from(t.campaigns)
    .where(and(eq(t.campaigns.orgId, orgId), eq(t.campaigns.id, id)))
  if (!campaign) throw notFound('Campaign')
  return campaign
}

export async function createCampaign(orgId: string, input: z.infer<typeof campaignCreate>) {
  await getProject(orgId, input.project_id)
  const drafting = aiConfigured() && !input.offer
  const [campaign] = await db
    .insert(t.campaigns)
    .values({
      orgId,
      projectId: input.project_id,
      name: input.name,
      offer: input.offer,
      customerProblem: input.customer_problem,
      targetRole: input.target_role,
      targetGeography: input.target_geography,
      targetCompanySize: input.target_company_size,
      positiveCriteria: input.positive_criteria,
      negativeCriteria: input.negative_criteria,
      keywords: input.keywords,
      statusReason: drafting ? 'drafting' : null,
    })
    .returning()
  if (drafting) await enqueue('draft-campaign', campaign.id)
  return campaign
}

export async function updateCampaign(orgId: string, id: string, input: z.infer<typeof campaignUpdate>) {
  const current = await getCampaign(orgId, id)
  if (!hasValues(input)) return current
  const startMinute = input.send_start ? minutes(input.send_start) : input.send_start_minute
  const endMinute = input.send_end ? minutes(input.send_end) : input.send_end_minute
  const start = startMinute ?? current.sendStartMinute
  const end = endMinute ?? current.sendEndMinute
  if (end <= start) throw new ApiError(422, 'invalid', 'The send window must end after it starts.')
  const [campaign] = await db
    .update(t.campaigns)
    .set({
      name: input.name,
      offer: input.offer,
      customerProblem: input.customer_problem,
      targetRole: input.target_role,
      targetGeography: input.target_geography,
      targetCompanySize: input.target_company_size,
      positiveCriteria: input.positive_criteria,
      negativeCriteria: input.negative_criteria,
      exampleClients: input.example_clients,
      keywords: input.keywords,
      language: input.language,
      sendDays: input.send_days,
      sendStartMinute: startMinute,
      sendEndMinute: endMinute,
      maxTouches: input.max_touches,
      followupDelayDays: input.followup_delay_days,
      followupInstructions: input.followup_instructions,
      replyInstructions: input.reply_instructions,
      useProjectEmail: input.use_project_email,
    })
    .where(eq(t.campaigns.id, id))
    .returning()
  return campaign
}

export async function campaignLeads(orgId: string, id: string, stage?: string, page = 0) {
  await getCampaign(orgId, id)
  return db
    .select({ lead: t.leads, contact: t.contacts })
    .from(t.leads)
    .innerJoin(t.contacts, eq(t.contacts.id, t.leads.contactId))
    .where(and(eq(t.leads.campaignId, id), stage ? eq(t.leads.stage, stage) : undefined))
    .orderBy(t.contacts.lastName, t.contacts.email)
    .limit(100)
    .offset(page * 100)
}

export async function setLeadReview(orgId: string, campaignId: string, leadId: string, stage: 'review' | 'excluded') {
  const campaign = await getCampaign(orgId, campaignId)
  if (campaign.status !== 'review') throw new ApiError(409, 'not_in_review', 'This list has already been approved.')
  const [lead] = await db
    .update(t.leads)
    .set({ stage })
    .where(and(eq(t.leads.id, leadId), eq(t.leads.campaignId, campaignId), inArray(t.leads.stage, ['review', 'excluded'])))
    .returning()
  if (!lead) throw notFound('Lead')
  return lead
}

type Campaign = typeof t.campaigns.$inferSelect
type FirstEmail = Pick<typeof t.firstEmails.$inferSelect, 'mode' | 'subject' | 'body' | 'instructions' | 'preview' | 'autoRevertedAt'> & {
  id?: string
  campaignId?: string | null
}

/** The campaign's own email, or the project default when the campaign follows it. */
export async function resolveFirstEmail(c: Campaign): Promise<FirstEmail> {
  const where = c.useProjectEmail ? eq(t.firstEmails.projectId, c.projectId) : eq(t.firstEmails.campaignId, c.id)
  const [row] = await db.select().from(t.firstEmails).where(where)
  return row ?? { mode: c.source === 'discovery' ? 'instructions' : 'my_copy', subject: '', body: '', instructions: '', preview: [], autoRevertedAt: null }
}

export async function getFirstEmail(orgId: string, campaignId: string) {
  return resolveFirstEmail(await getCampaign(orgId, campaignId))
}

/** AI writes this one, either all of it or the {{ai: ...}} lines. */
const samplesFirst = () =>
  agentMode() && !apiConfigured() ? 'Ask your AI agent to write sample emails, then read them.' : 'Write sample emails and read them first.'

export const needsAi = (e: Pick<FirstEmail, 'mode' | 'subject' | 'body'>) => e.mode === 'instructions' || hasAiLines(`${e.subject}\n${e.body}`)

export function emailWarnings(subject: string, body: string) {
  const known = renderTemplate(`${subject}\n${body}`, Object.fromEntries(VARIABLES.map((v) => [v, 'x'])) as Vars)
  const warnings = known.unknown.map((v) => `{{${v}}} is not a variable we can fill.`)
  if (!subject) warnings.push('Add a subject line.')
  if (!body) warnings.push('Write the email before approving.')
  return warnings
}

export async function saveFirstEmail(orgId: string, campaignId: string, input: z.infer<typeof firstEmailUpdate>) {
  const campaign = await getCampaign(orgId, campaignId)
  if (campaign.useProjectEmail) throw new ApiError(409, 'follows_project', 'This campaign uses the project email. Switch it to Custom to edit here.')
  const current = await resolveFirstEmail(campaign)
  const mode = input.mode ?? (input.subject !== undefined || input.body !== undefined ? 'my_copy' : current.mode)
  if (mode === 'instructions' && !aiConfigured()) {
    throw new ApiError(409, 'no_ai', 'Add your Anthropic API key to use AI emails, or write your own copy.')
  }
  // Samples no longer match once the text changes, so they must be read again.
  const values = { mode, subject: input.subject, body: input.body, instructions: input.instructions, preview: [] }
  const [row] = await db
    .insert(t.firstEmails)
    .values({ orgId, campaignId, ...values })
    .onConflictDoUpdate({ target: t.firstEmails.campaignId, targetWhere: sql`campaign_id is not null`, set: values })
    .returning()
  return { ...row, warnings: emailWarnings(row.subject, row.body) }
}

/** The default email for campaigns that follow the project. */
export async function getProjectEmail(orgId: string, projectId: string) {
  await getProject(orgId, projectId)
  const [row] = await db.select().from(t.firstEmails).where(eq(t.firstEmails.projectId, projectId))
  return row ?? { mode: 'instructions', subject: '', body: '', instructions: '', preview: [], autoRevertedAt: null }
}

export async function saveProjectEmail(orgId: string, projectId: string, input: z.infer<typeof firstEmailUpdate>) {
  const current = await getProjectEmail(orgId, projectId)
  const values = { mode: input.mode ?? current.mode, subject: input.subject, body: input.body, instructions: input.instructions, preview: [] }
  const [row] = await db
    .insert(t.firstEmails)
    .values({ orgId, projectId, ...values })
    .onConflictDoUpdate({ target: t.firstEmails.projectId, targetWhere: sql`project_id is not null`, set: values })
    .returning()
  return row
}

export const contactVars = (c: typeof t.contacts.$inferSelect): Vars => ({
  first_name: c.firstName,
  last_name: c.lastName,
  company: c.companyName,
  job_title: c.jobTitle,
})

export async function previewEmails(orgId: string, campaignId: string) {
  const email = await getFirstEmail(orgId, campaignId)
  if (needsAi(email)) return email.preview as { to: string; subject: string; body: string; missing: string[] }[]
  const rows = await db
    .select({ contact: t.contacts })
    .from(t.leads)
    .innerJoin(t.contacts, eq(t.contacts.id, t.leads.contactId))
    .where(and(eq(t.leads.campaignId, campaignId), inArray(t.leads.stage, ['review', 'active'])))
    .limit(3)
  return rows.map(({ contact }) => {
    const subject = renderTemplate(email.subject, contactVars(contact), contact.id)
    const body = renderTemplate(email.body, contactVars(contact), contact.id)
    return {
      to: contact.email ?? '',
      subject: subject.text,
      body: body.text,
      missing: [...new Set([...subject.missing, ...body.missing])],
    }
  })
}

async function audit(tx: Db, orgId: string, userId: string | null, action: string, id: string, detail = {}) {
  await tx.insert(t.auditEvents).values({
    orgId,
    actorUserId: userId,
    actor: userId ? 'user' : 'system',
    action,
    subjectType: 'campaign',
    subjectId: id,
    detail,
  })
}

const COLUMN: Record<string, string> = {
  first_name: 'first_name',
  last_name: 'last_name',
  company: 'company_name',
  job_title: 'job_title',
}

/** Leads that have no value for a variable the email needs, so they cannot be sent. */
async function leadsMissingValues(campaignId: string, email: { subject: string; body: string }) {
  const needed = renderTemplate(`${email.subject}\n${email.body}`, {}).missing.map((v) => COLUMN[v])
  if (!needed.length) return 0
  const empty = sql.join(needed.map((c) => sql`coalesce(btrim(${sql.identifier(c)}), '') = ''`), sql` or `)
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from leads l join contacts c on c.id = l.contact_id
    where l.campaign_id = ${campaignId} and l.stage = 'review' and (${empty})`)
  return rows[0].n
}

/** Why this campaign may not send. Empty means it can. */
export async function approvalBlockers(orgId: string, campaignId: string) {
  const campaign = await getCampaign(orgId, campaignId)
  const project = await getProject(orgId, campaign.projectId)
  const email = await getFirstEmail(orgId, campaignId)
  const [mailboxes] = await db
    .select({ n: count() })
    .from(t.mailboxes)
    .where(and(eq(t.mailboxes.projectId, project.id), eq(t.mailboxes.status, 'active')))
  const [leads] = await db
    .select({ n: count() })
    .from(t.leads)
    .where(and(eq(t.leads.campaignId, campaignId), eq(t.leads.stage, 'review')))
  const blockers: string[] = []
  if (!project.legalFooter.trim()) blockers.push('Add your business address in project settings.')
  if (!project.legalBasisConfirmedAt) blockers.push('Confirm your legal basis in project settings.')
  if (!mailboxes.n) blockers.push('Connect a working mailbox.')
  if (email.mode === 'instructions') {
    if (!email.instructions.trim()) blockers.push('Tell the AI what the email should say.')
    else if (!aiConfigured()) blockers.push('Add an AI key or connect your AI agent in Settings, or write your own copy.')
    else if (!(email.preview as unknown[]).length) blockers.push(samplesFirst())
  } else if (!email.subject.trim() || !email.body.trim()) blockers.push('Write the first email.')
  else if (needsAi(email) && !(email.preview as unknown[]).length) blockers.push(samplesFirst())
  if (!leads.n) blockers.push('There are no leads left to approve.')
  const checking = await pendingVerification(campaignId)
  if (checking) blockers.push(`Still checking ${checking} email ${checking === 1 ? 'address' : 'addresses'}.`)
  return {
    blockers,
    leads: leads.n,
    mailboxes: mailboxes.n,
    unsendable: email.mode === 'my_copy' ? await leadsMissingValues(campaignId, email) : 0,
    unverified: verifierConfigured() ? 0 : leads.n,
  }
}

async function queueFirstTouch(tx: Db, orgId: string, campaign: Campaign) {
  const campaignId = campaign.id
  const ai = needsAi(await resolveFirstEmail(campaign))
  await tx.execute(sql`
    insert into messages (org_id, lead_id, direction, kind, touch, status, needs_draft)
    select ${orgId}, l.id, 'outbound', 'first', 1, 'queued', ${ai}
    from leads l
    where l.campaign_id = ${campaignId} and l.stage = 'active' and l.touches_sent = 0
    on conflict do nothing`)
}

/** The only path to sending. Nothing approves a list on its own. */
export async function approveCampaign(orgId: string, userId: string, id: string) {
  const campaign = await getCampaign(orgId, id)
  if (campaign.status !== 'review') throw new ApiError(409, 'not_in_review', 'Only a list in review can be approved.')
  const { blockers } = await approvalBlockers(orgId, id)
  if (blockers.length) throw new ApiError(409, 'blocked', blockers[0])
  return db.transaction(async (tx) => {
    await tx.update(t.leads).set({ stage: 'active' }).where(and(eq(t.leads.campaignId, id), eq(t.leads.stage, 'review')))
    const [row] = await tx
      .update(t.campaigns)
      .set({ status: 'sending', approvedAt: sql`now()`, approvedBy: userId, statusReason: null })
      .where(eq(t.campaigns.id, id))
      .returning()
    await queueFirstTouch(tx, orgId, row)
    await audit(tx, orgId, userId, 'campaign.approved', id)
    return row
  })
}

const cancelQueued = (tx: Db, id: string, reason: string) =>
  tx.execute(sql`
    update messages m set status = 'cancelled', status_reason = ${reason}
    from leads l
    where l.id = m.lead_id and l.campaign_id = ${id} and m.status = 'queued' and m.kind in ('first', 'followup', 'auto_reply')`)

export async function stopCampaign(orgId: string, userId: string, id: string) {
  const campaign = await getCampaign(orgId, id)
  if (campaign.status === 'stopped' || campaign.status === 'archived') return campaign
  return db.transaction(async (tx) => {
    await cancelQueued(tx, id, 'campaign stopped')
    const [row] = await tx
      .update(t.campaigns)
      .set({ status: 'stopped', statusBeforeStop: ['searching', 'review', 'sending'].includes(campaign.status) ? campaign.status : null })
      .where(eq(t.campaigns.id, id))
      .returning()
    await audit(tx, orgId, userId, 'campaign.stopped', id)
    return row
  })
}

export async function startCampaign(orgId: string, userId: string, id: string) {
  const campaign = await getCampaign(orgId, id)
  if (campaign.status === 'draft') {
    if (!providerConfigured()) throw new ApiError(409, 'no_provider', 'Add a lead provider key to search, or import a CSV.')
    if (!campaign.targetGeography?.trim()) throw new ApiError(409, 'no_geography', 'Choose the countries to search in Targeting first.')
    const [row] = await db
      .update(t.campaigns)
      .set({ status: 'searching', statusReason: null })
      .where(eq(t.campaigns.id, id))
      .returning()
    await enqueue('find-leads', id)
    await audit(db, orgId, userId, 'campaign.searching', id)
    return row
  }
  if (campaign.status !== 'stopped') return campaign
  const next = campaign.statusBeforeStop ?? 'review'
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(t.campaigns)
      .set({ status: next === 'searching' ? 'review' : next, statusBeforeStop: null })
      .where(eq(t.campaigns.id, id))
      .returning()
    if (next === 'sending') await queueFirstTouch(tx, orgId, row)
    await audit(tx, orgId, userId, 'campaign.started', id)
    return row
  })
}

export async function archiveCampaign(orgId: string, userId: string, id: string) {
  await getCampaign(orgId, id)
  return db.transaction(async (tx) => {
    await cancelQueued(tx, id, 'campaign archived')
    const [row] = await tx.update(t.campaigns).set({ status: 'archived' }).where(eq(t.campaigns.id, id)).returning()
    await audit(tx, orgId, userId, 'campaign.archived', id)
    return row
  })
}

export type SendState = { state: string; tone: 'good' | 'wait' | 'needs' | 'broken'; message: string; action?: string }

export async function sendState(orgId: string, id: string): Promise<SendState> {
  const c = await getCampaign(orgId, id)
  const project = await getProject(orgId, c.projectId)
  const boxes = await db.select({ status: t.mailboxes.status }).from(t.mailboxes).where(eq(t.mailboxes.projectId, c.projectId))
  const [queue] = await db
    .select({ n: count() })
    .from(t.messages)
    .innerJoin(t.leads, eq(t.leads.id, t.messages.leadId))
    .where(and(eq(t.leads.campaignId, id), eq(t.messages.status, 'queued')))
  if (c.status === 'archived') return { state: 'archived', tone: 'wait', message: 'Archived.' }
  if (c.status === 'draft') {
    if (c.statusReason === 'drafting') return { state: 'preparing', tone: 'wait', message: 'Drafting your campaign…' }
    if (c.statusReason === 'no_matches') return { state: 'no_matches', tone: 'needs', message: 'No leads matched. Widen your targeting and start again.', action: 'Edit targeting' }
    if (c.statusReason?.startsWith('failed:')) return { state: 'launch_failed', tone: 'broken', message: c.statusReason.slice(7), action: 'Start again' }
    return { state: 'not_started', tone: 'wait', message: 'Not started yet.' }
  }
  if (c.status === 'searching') return { state: 'searching', tone: 'wait', message: 'Searching for leads…' }
  if (c.status === 'stopped') return { state: 'paused', tone: 'wait', message: 'Stopped. Nothing will send.', action: 'Start again' }
  if (!boxes.length) return { state: 'no_mailbox', tone: 'needs', message: 'Connect a mailbox before you can send.', action: 'Connect mailbox' }
  if (!boxes.some((b) => b.status === 'active')) {
    return { state: 'mailbox_failing', tone: 'broken', message: 'No working mailbox.', action: 'Fix mailbox' }
  }
  if (!project.legalFooter.trim()) {
    return { state: 'missing_legal_footer', tone: 'needs', message: 'Add your business address before sending.', action: 'Add address' }
  }
  if (!project.legalBasisConfirmedAt) {
    return { state: 'missing_legal_basis', tone: 'needs', message: 'Confirm your legal basis in settings before sending.', action: 'Open settings' }
  }
  if (c.status === 'review') return { state: 'awaiting_review', tone: 'needs', message: 'Waiting for your review.', action: 'Review leads' }
  const stop = await budgetStop(project)
  if (stop === 'zero_budget') return { state: stop, tone: 'needs', message: 'The daily budget is zero, so everything is paused.', action: 'Set budget' }
  if (stop === 'monthly_cap_reached') return { state: stop, tone: 'needs', message: 'The monthly cap is reached. Sending resumes next month.', action: 'Raise cap' }
  if (stop === 'daily_budget_reached') return { state: stop, tone: 'wait', message: 'Today’s budget is used. Sending resumes tomorrow.', action: 'Raise budget' }
  if (!queue.n) {
    const [waiting] = await db
      .select({ n: count() })
      .from(t.leads)
      .where(and(eq(t.leads.campaignId, id), eq(t.leads.stage, 'active'), sql`${t.leads.nextTouchAt} is not null`))
    if (waiting.n) return { state: 'idle', tone: 'wait', message: `${waiting.n} waiting for their next follow-up.` }
    const [failed] = await db
      .select({ n: count() })
      .from(t.messages)
      .innerJoin(t.leads, eq(t.leads.id, t.messages.leadId))
      .where(and(eq(t.leads.campaignId, id), eq(t.messages.status, 'failed')))
    if (failed.n) {
      return { state: 'leads_exhausted', tone: 'needs', message: `Finished, but ${failed.n} could not be sent. Their stage shows Stopped.` }
    }
    return { state: 'leads_exhausted', tone: 'wait', message: 'Everyone in this list has been emailed.' }
  }
  const [drafting] = await db
    .select({ n: count() })
    .from(t.messages)
    .innerJoin(t.leads, eq(t.leads.id, t.messages.leadId))
    .where(and(eq(t.leads.campaignId, id), eq(t.messages.status, 'queued'), eq(t.messages.needsDraft, true)))
  if (drafting.n === queue.n) return { state: 'preparing', tone: 'wait', message: `Writing ${drafting.n} emails.` }
  if (!withinSendWindow(c, project.timezone)) {
    return { state: 'scheduled', tone: 'wait', message: `${queue.n} waiting for the next send window.` }
  }
  return { state: 'sending', tone: 'good', message: `Sending. ${queue.n} left in the queue.` }
}
