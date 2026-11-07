import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test as base, expect, type Page } from '@playwright/test'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { Pool } from 'pg'

// All mail in these tests goes to the local test server. Nothing leaves this machine.
export const pool = new Pool({ connectionString: 'postgres://postgres@localhost:54329/outreach', max: 2 })
export const smtp = nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false, tls: { rejectUnauthorized: false } })

let n = 0
export const uid = () => `${Date.now()}${n++}`

export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      // Each test starts clean: earlier tests must not send or poll during this one.
      await pool.query(`update messages set status = 'cancelled', status_reason = 'test reset' where status = 'queued'`)
      await pool.query(`update mailboxes set status = 'paused' where status = 'active'`)
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error' && !/status of 4\d\d|favicon/.test(m.text())) errors.push(`console: ${m.text()}`)
      })
      page.on('pageerror', (e) => errors.push(`page: ${e}`))
      page.on('response', (r) => {
        if (r.status() >= 500) errors.push(`${r.status()} on ${r.url()}`)
      })
      await use()
      expect(errors).toEqual([])
    },
    { auto: true },
  ],
})
export { expect }

/** Next.js keeps its own hidden alert region, so match ours by text. */
export const alertWith = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text })

export async function tick() {
  const { stdout } = await promisify(execFile)('npx', ['tsx', '--env-file=.env.local', 'src/worker/tick.ts'])
  return JSON.parse(stdout.trim().split('\n').pop()!) as { sent: number; received: string[]; reaped: number }
}

/** A worker pass as the desktop app runs it when an AI agent does the thinking: no AI calls of its own. */
export async function agentTick() {
  const { stdout } = await promisify(execFile)('npx', ['tsx', '--env-file=.env.local', 'src/worker/tick.ts'], {
    env: { ...process.env, AI_FAKE: '0', AI_AGENT: '1' },
  })
  return JSON.parse(stdout.trim().split('\n').pop()!) as { sent: number; received: string[] }
}

export async function ticks(count: number) {
  let sent = 0
  for (let i = 0; i < count; i++) sent += (await tick()).sent
  return sent
}

export async function mailTo(address: string) {
  const client = new ImapFlow({
    host: 'localhost',
    port: 1143,
    secure: false,
    auth: { user: 'testuser', pass: 'testpass' },
    logger: false,
    tls: { rejectUnauthorized: false },
  })
  client.on('error', () => {})
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  const raw: string[] = []
  if (client.mailbox && client.mailbox.exists > 0) {
    for await (const m of client.fetch('1:*', { source: true, envelope: true })) {
      if (m.envelope?.to?.some((t) => t.address === address)) raw.push(m.source!.toString('utf8'))
    }
  }
  lock.release()
  await client.logout()
  return raw
}

export const headerOf = (raw: string, name: string) => raw.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? ''

export async function login(page: Page, email = `owner${uid()}@example.test`) {
  await page.goto('/login')
  await page.getByLabel('Local test email').fill(email)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/projects')
  return email
}

export async function api(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, data: data as never })
  const body = await res.text()
  return { status: res.status(), json: body ? JSON.parse(body) : null }
}

export type Lead = { email: string; first_name?: string; last_name?: string; company?: string }

export const toCsv = (leads: Lead[]) =>
  ['email,first_name,last_name,company', ...leads.map((l) => `${l.email},${l.first_name ?? 'Ana'},${l.last_name ?? 'Stone'},"${l.company ?? 'Acme'}"`)].join('\n')

export async function upload(page: Page, projectId: string, csv: string | Buffer, name = 'List') {
  const res = await page.request.post('/api/imports', {
    multipart: {
      project_id: projectId,
      name,
      file: { name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
    },
  })
  const body = await res.json()
  if (!res.ok()) return { status: res.status(), ...body }
  for (let i = 0; i < 300; i++) {
    const state = (await api(page, 'GET', `/api/imports/${body.id}`)).json
    if (state.status !== 'pending') return { status: 200, ...state }
    await page.waitForTimeout(100)
  }
  throw new Error('import did not finish')
}

export async function newProject(page: Page) {
  const id = uid()
  const sender = `sender${id}@example.test`
  const project = (await api(page, 'POST', '/api/projects', { domain: `acme${id}.test` })).json
  await api(page, 'PATCH', `/api/projects/${project.id}`, {
    sender_name: 'Sam Rivers',
    legal_footer: 'Acme Ltd, 1 Test Road',
    legal_basis_confirmed: true,
  })
  const mailbox = (
    await api(page, 'POST', '/api/mailboxes', {
      project_id: project.id,
      email: sender,
      smtp_host: 'localhost',
      smtp_port: 1025,
      imap_host: 'localhost',
      imap_port: 1143,
      username: 'testuser',
      password: 'testpass',
      daily_limit: 50,
    })
  ).json
  await api(page, 'POST', `/api/mailboxes/${mailbox.id}/test`)
  return { projectId: project.id as string, mailboxId: mailbox.id as string, sender }
}

export const someLeads = (count: number) => {
  const id = uid()
  return Array.from({ length: count }, (_, i) => ({ email: `lead${i}.${id}@clinic.test`, first_name: `Lead${i}`, company: `Clinic ${i}` }))
}

/** A project with a campaign in review, email written. */
export async function campaign(page: Page, leads: Lead[], projectId?: string, subject = 'Hello {{company}}', body = 'Hi {{first_name}}') {
  const project = projectId ? { projectId, mailboxId: '', sender: '' } : await newProject(page)
  const job = await upload(page, project.projectId, toCsv(leads))
  const campaignId = job.campaignId as string
  await api(page, 'PATCH', `/api/campaigns/${campaignId}/first-email`, { subject, body })
  await api(page, 'PATCH', `/api/campaigns/${campaignId}`, { send_days: [1, 2, 3, 4, 5, 6, 7], send_start_minute: 0, send_end_minute: 1440 })
  return { ...project, campaignId, job }
}

export const approve = (page: Page, campaignId: string) => api(page, 'POST', `/api/campaigns/${campaignId}/approve`)

export async function leadsOf(page: Page, campaignId: string) {
  const rows = (await api(page, 'GET', `/api/campaigns/${campaignId}/leads`)).json as {
    lead: { id: string; stage: string; touchesSent: number; needsReply: boolean }
    contact: { email: string; firstName: string; emailStatus: string; unsubscribedAt: string | null }
  }[]
  return rows
}

export const replyFrom = (from: string, to: string, inReplyTo: string | undefined, text: string, extra: object = {}) =>
  smtp.sendMail({ from, to, subject: 'Re: Hello', text, inReplyTo, references: inReplyTo, ...extra })

/** One sent email and one reply, ready for inbox tests. */
export async function conversation(page: Page) {
  const [lead] = someLeads(1)
  const c = await campaign(page, [lead])
  await approve(page, c.campaignId)
  await tick()
  const [mail] = await mailTo(lead.email)
  const messageId = headerOf(mail, 'Message-ID')
  await replyFrom(lead.email, c.sender, messageId, 'Tell me more.')
  await tick()
  const [row] = await leadsOf(page, c.campaignId)
  return { ...c, lead, leadId: row.lead.id, messageId }
}
