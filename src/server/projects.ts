import { promises as dns } from 'node:dns'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { db, t } from '@/db'
import { aiConfigured } from './ai'
import { ApiError, isUniqueViolation, notFound } from './http'
import { enqueue } from './queue'
import { assertPublicHost, resolvePublicHost } from './site'
import { decryptSecret, emailDomain, encryptSecret, hasValues, isEmail } from './render'

const FREE_MAIL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me'])
const STATUSES = ['Hot', 'Demo', 'Won', 'Lost', 'Unqualified']

export const projectCreate = z.strictObject({
  domain: z.string().trim().min(3).max(253).optional(),
  no_website: z
    .strictObject({
      business: z.string().trim().min(3).max(1000),
      customer: z.string().trim().max(1000).default(''),
      geo: z.string().trim().max(300).default(''),
    })
    .optional(),
})

export const projectUpdate = z.strictObject({
  sender_name: z.string().trim().max(120).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  legal_footer: z.string().trim().max(600).optional(),
  legal_basis_confirmed: z.boolean().optional(),
  facts: z.string().trim().max(4000).optional(),
  daily_budget: z.coerce.number().min(0).max(300).optional(),
  monthly_cap: z.coerce.number().min(0).max(100000).nullable().optional(),
  auto_reply_enabled: z.boolean().optional(),
  auto_reply_delay_minutes: z.coerce.number().int().min(5).max(1440).optional(),
  booking_url: z.union([z.url({ protocol: /^https$/, error: 'Use a full https:// link' }), z.literal('')]).optional(),
})

function cleanDomain(input: string) {
  const bare = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
  try {
    return new URL(`http://${bare}`).hostname
  } catch {
    throw new ApiError(422, 'invalid', 'Enter a website such as yourcompany.com.')
  }
}

export const listProjects = (orgId: string) =>
  db
    .select()
    .from(t.projects)
    .where(and(eq(t.projects.orgId, orgId), isNull(t.projects.archivedAt)))
    .orderBy(desc(t.projects.createdAt))

export async function getProject(orgId: string, id: string) {
  const [project] = await db
    .select()
    .from(t.projects)
    .where(and(eq(t.projects.orgId, orgId), eq(t.projects.id, id)))
  if (!project) throw notFound('Project')
  return project
}

export async function createProject(orgId: string, input: z.infer<typeof projectCreate>) {
  if (!input.domain === !input.no_website) {
    throw new ApiError(422, 'invalid', 'Give a website, or describe the business instead.')
  }
  const domain = input.domain ? cleanDomain(input.domain) : null
  if (domain && (!domain.includes('.') || FREE_MAIL.has(domain))) {
    throw new ApiError(409, 'domain_unavailable', 'Use your company website, not a personal email domain.')
  }
  try {
    const analyse = aiConfigured()
    const created = await db.transaction(async (tx) => {
      const [project] = await tx
        .insert(t.projects)
        .values({ orgId, domain, noWebsiteAnswers: input.no_website ?? null, status: analyse ? 'creating' : 'ready' })
        .returning()
      await tx
        .insert(t.leadStatuses)
        .values(STATUSES.map((name, position) => ({ orgId, projectId: project.id, name, position })))
      return project
    })
    if (analyse) await enqueue('analyse-project', created.id)
    return created
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'project_exists', 'You already have a project for this website.')
    throw err
  }
}

/** Runs the analysis again, after a failure or when you add your key. */
export async function reanalyse(orgId: string, id: string) {
  await getProject(orgId, id)
  if (!aiConfigured()) throw new ApiError(409, 'no_ai', 'Add your Anthropic API key to analyse this business.')
  const [row] = await db.update(t.projects).set({ status: 'creating', failureReason: null }).where(eq(t.projects.id, id)).returning()
  await enqueue('analyse-project', id)
  return row
}

export async function updateProject(orgId: string, id: string, input: z.infer<typeof projectUpdate>) {
  const current = await getProject(orgId, id)
  if (!hasValues(input)) return current
  if (input.timezone && !Intl.supportedValuesOf('timeZone').includes(input.timezone) && input.timezone !== 'UTC') {
    throw new ApiError(422, 'invalid', 'Use a time zone such as Asia/Tashkent.')
  }
  const [project] = await db
    .update(t.projects)
    .set({
      senderName: input.sender_name,
      timezone: input.timezone,
      legalFooter: input.legal_footer,
      facts: input.facts,
      dailyBudgetMicros: input.daily_budget === undefined ? undefined : Math.round(input.daily_budget * 1_000_000),
      monthlyCapMicros: input.monthly_cap === undefined ? undefined : input.monthly_cap === null ? null : Math.round(input.monthly_cap * 1_000_000),
      autoReplyEnabled: input.auto_reply_enabled,
      autoReplyDelayMinutes: input.auto_reply_delay_minutes,
      bookingUrl: input.booking_url === undefined ? undefined : input.booking_url || null,
      ...(input.legal_basis_confirmed === undefined
        ? {}
        : { legalBasisConfirmedAt: input.legal_basis_confirmed ? new Date().toISOString() : null }),
    })
    .where(and(eq(t.projects.orgId, orgId), eq(t.projects.id, id)))
    .returning()
  return project
}

/** Removes the organization, and so everything in it, then the user. */
export async function deleteAccount(orgId: string, userId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(t.organizations).where(eq(t.organizations.id, orgId))
    await tx.delete(t.users).where(eq(t.users.id, userId))
  })
}

const statusName = z.strictObject({ name: z.string().trim().min(1).max(40) })
export { statusName as statusCreate }

export const listStatuses = (orgId: string, projectId: string) =>
  db
    .select({ id: t.leadStatuses.id, name: t.leadStatuses.name })
    .from(t.leadStatuses)
    .where(and(eq(t.leadStatuses.orgId, orgId), eq(t.leadStatuses.projectId, projectId)))
    .orderBy(t.leadStatuses.position)

export async function createStatus(orgId: string, projectId: string, name: string) {
  await getProject(orgId, projectId)
  const position = (await listStatuses(orgId, projectId)).length
  try {
    const [row] = await db.insert(t.leadStatuses).values({ orgId, projectId, name, position }).returning()
    return row
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'status_exists', 'You already have this status.')
    throw err
  }
}

export async function deleteStatus(orgId: string, id: string) {
  const [row] = await db.delete(t.leadStatuses).where(and(eq(t.leadStatuses.orgId, orgId), eq(t.leadStatuses.id, id))).returning()
  if (!row) throw notFound('Status')
}

export const mailboxCreate = z.strictObject({
  project_id: z.uuid(),
  email: z.string().trim().refine(isEmail, 'Enter a valid email address'),
  display_name: z.string().trim().max(120).default(''),
  smtp_host: z.string().trim().min(1).max(253),
  smtp_port: z.coerce.number().int().min(1).max(65535).default(587),
  imap_host: z.string().trim().min(1).max(253),
  imap_port: z.coerce.number().int().min(1).max(65535).default(993),
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(500),
  daily_limit: z.coerce.number().int().min(1).max(200).default(10),
})

export const mailboxUpdate = z.strictObject({
  daily_limit: z.coerce.number().int().min(1).max(200).optional(),
  paused: z.boolean().optional(),
})

const publicColumns = {
  id: t.mailboxes.id,
  projectId: t.mailboxes.projectId,
  email: t.mailboxes.email,
  displayName: t.mailboxes.displayName,
  status: t.mailboxes.status,
  statusReason: t.mailboxes.statusReason,
  dailyLimit: t.mailboxes.dailyLimit,
  spfOk: t.mailboxes.spfOk,
  dkimOk: t.mailboxes.dkimOk,
  dmarcOk: t.mailboxes.dmarcOk,
  lastPolledAt: t.mailboxes.lastPolledAt,
}

export const listMailboxes = (orgId: string, projectId: string) =>
  db
    .select(publicColumns)
    .from(t.mailboxes)
    .where(and(eq(t.mailboxes.orgId, orgId), eq(t.mailboxes.projectId, projectId)))
    .orderBy(t.mailboxes.email)

/** The server connects to these hosts, so it must not be pointed inside its own network. */
async function assertMailHost(host: string) {
  if (process.env.MAIL_DEV_INSECURE === '1') return
  try {
    await assertPublicHost(host)
  } catch {
    throw new ApiError(422, 'invalid', `We could not use ${host} as a mail server.`)
  }
}

export async function createMailbox(orgId: string, input: z.infer<typeof mailboxCreate>) {
  await getProject(orgId, input.project_id)
  await assertMailHost(input.smtp_host)
  await assertMailHost(input.imap_host)
  try {
    const [row] = await db
      .insert(t.mailboxes)
      .values({
        orgId,
        projectId: input.project_id,
        email: input.email.toLowerCase(),
        displayName: input.display_name,
        smtpHost: input.smtp_host,
        smtpPort: input.smtp_port,
        imapHost: input.imap_host,
        imapPort: input.imap_port,
        username: input.username,
        secretEnc: encryptSecret(input.password),
        dailyLimit: input.daily_limit,
      })
      .returning(publicColumns)
    return row
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'mailbox_exists', 'This mailbox is already connected.')
    throw err
  }
}

async function ownedMailbox(orgId: string, id: string) {
  const [box] = await db
    .select()
    .from(t.mailboxes)
    .where(and(eq(t.mailboxes.orgId, orgId), eq(t.mailboxes.id, id)))
  if (!box) throw notFound('Mailbox')
  return box
}

export async function updateMailbox(orgId: string, id: string, input: z.infer<typeof mailboxUpdate>) {
  const box = await ownedMailbox(orgId, id)
  if (!hasValues(input)) return (await listMailboxes(orgId, box.projectId)).find((b) => b.id === id)
  const status = input.paused === undefined ? undefined : input.paused ? 'paused' : 'unverified'
  const [row] = await db
    .update(t.mailboxes)
    .set({ dailyLimit: input.daily_limit, status, statusReason: status ? null : box.statusReason })
    .where(eq(t.mailboxes.id, id))
    .returning(publicColumns)
  return row
}

export async function deleteMailbox(orgId: string, id: string) {
  await ownedMailbox(orgId, id)
  await db.delete(t.mailboxes).where(eq(t.mailboxes.id, id))
}

export type MailboxRow = typeof t.mailboxes.$inferSelect

/**
 * The address to connect to, checked at every connection: a host that was public when it
 * was saved may not be now. The name stays in use for the certificate check.
 */
async function mailAddress(host: string) {
  if (process.env.MAIL_DEV_INSECURE === '1') return host
  try {
    return await resolvePublicHost(host)
  } catch (err) {
    throw Object.assign(new Error(`Could not use ${host}: ${(err as Error).message}`), { code: 'EDNS' })
  }
}

export async function smtpTransport(box: MailboxRow) {
  return nodemailer.createTransport({
    host: await mailAddress(box.smtpHost),
    port: box.smtpPort,
    secure: box.smtpPort === 465,
    auth: process.env.MAIL_DEV_NO_SMTP_AUTH === '1' ? undefined : { user: box.username, pass: decryptSecret(box.secretEnc) },
    connectionTimeout: 15000,
    tls: { servername: box.smtpHost, rejectUnauthorized: process.env.MAIL_DEV_INSECURE !== '1' },
  })
}

export async function imapClient(box: MailboxRow) {
  return new ImapFlow({
    host: await mailAddress(box.imapHost),
    servername: box.imapHost,
    port: box.imapPort,
    secure: box.imapPort === 993,
    auth: { user: box.username, pass: decryptSecret(box.secretEnc) },
    logger: false,
    tls: { rejectUnauthorized: process.env.MAIL_DEV_INSECURE !== '1' },
  })
}

/** Signs in to both servers. Only a mailbox that passes can send. */
export async function testMailbox(orgId: string, id: string) {
  const box = await ownedMailbox(orgId, id)
  let failed: string | null = null
  try {
    await (await smtpTransport(box)).verify()
  } catch {
    failed = 'We could not sign in to the sending server. Check the host, port and app password.'
  }
  if (!failed) {
    try {
      const client = await imapClient(box)
      client.on('error', () => {})
      await client.connect()
      await client.logout()
    } catch {
      failed = 'We could not sign in to the inbox server. Check the host, port and app password.'
    }
  }
  const [row] = await db
    .update(t.mailboxes)
    .set({ status: failed ? 'failing' : 'active', statusReason: failed })
    .where(eq(t.mailboxes.id, id))
    .returning(publicColumns)
  return row
}

const txt = (host: string) => dns.resolveTxt(host).then((r) => r.map((p) => p.join('')), () => [] as string[])

export async function checkMailboxDns(orgId: string, id: string) {
  const box = await ownedMailbox(orgId, id)
  const domain = emailDomain(box.email)
  const [spf, dmarc, ...dkim] = await Promise.all([
    txt(domain),
    txt(`_dmarc.${domain}`),
    ...['google', 'default', 'selector1', 'selector2', 'zoho'].map((s) => txt(`${s}._domainkey.${domain}`)),
  ])
  const [row] = await db
    .update(t.mailboxes)
    .set({
      spfOk: spf.some((r) => r.startsWith('v=spf1')),
      dmarcOk: dmarc.some((r) => r.startsWith('v=DMARC1')),
      dkimOk: dkim.some((r) => r.length > 0),
      dnsCheckedAt: new Date().toISOString(),
    })
    .where(eq(t.mailboxes.id, id))
    .returning(publicColumns)
  return row
}
