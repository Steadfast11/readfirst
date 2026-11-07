import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { api, approve, campaign, conversation, expect, headerOf, leadsOf, login, mailTo, pool, replyFrom, smtp, someLeads, test, tick, uid } from './helpers'

test.describe('F06 inbox', () => {
  test.beforeEach(async ({ page }) => void (await login(page)))

  const openThread = async (page: Parameters<typeof conversation>[0], c: { projectId: string; leadId: string }) =>
    page.goto(`/projects/${c.projectId}/inbox?tab=replied&lead=${c.leadId}`)

  test('F06-E1 a status can be cleared again', async ({ page }) => {
    const c = await conversation(page)
    await openThread(page, c)
    await page.getByLabel('Status').selectOption({ label: 'Hot' })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved')).toBeVisible()
    await page.getByLabel('Status').selectOption({ label: 'No status' })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Status')).toHaveValue('')
  })

  test('F06-E2 a bounced lead cannot silently swallow a reply', async ({ page }) => {
    const c = await conversation(page)
    await pool.query(`update contacts set email_status = 'invalid' where email = $1`, [c.lead.email])
    const res = await api(page, 'POST', `/api/leads/${c.leadId}/reply`, { body: 'Hello?' })
    expect(res.status).toBe(409)
  })

  test('F06-E3 stopping a campaign keeps a reply you already wrote', async ({ page }) => {
    const c = await conversation(page)
    await api(page, 'POST', `/api/leads/${c.leadId}/reply`, { body: 'Tuesday works.' })
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/stop`)
    expect((await tick()).sent).toBe(1)
    const mails = await mailTo(c.lead.email)
    expect(mails).toHaveLength(2)
  })

  test('F06-E4 a suppressed contact cannot silently swallow a reply', async ({ page }) => {
    const c = await conversation(page)
    await api(page, 'POST', '/api/suppression', { name: `Block ${uid()}`, entries: c.lead.email })
    expect((await api(page, 'POST', `/api/leads/${c.leadId}/reply`, { body: 'Hi' })).status).toBe(409)
  })

  test('F06-E5 an HTML reply shows as text and runs nothing', async ({ page }) => {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    const id = headerOf((await mailTo(lead.email))[0], 'Message-ID')
    await smtp.sendMail({ from: lead.email, to: c.sender, subject: 'Re', inReplyTo: id, html: '<p>Plain words</p><script>alert(1)</script><img src=x onerror=alert(2)>' })
    await tick()
    page.on('dialog', () => {
      throw new Error('script ran')
    })
    const [row] = await leadsOf(page, c.campaignId)
    await page.goto(`/projects/${c.projectId}/inbox?lead=${row.lead.id}`)
    await expect(page.getByRole('article').getByText('Plain words')).toBeVisible()
    await expect(page.locator('img')).toHaveCount(0)
  })

  test('F06-E6 accents and emoji in a reply survive', async ({ page }) => {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    await replyFrom(lead.email, c.sender, headerOf((await mailTo(lead.email))[0], 'Message-ID'), 'Sí, señor 🦎 日本語')
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    await page.goto(`/projects/${c.projectId}/inbox?lead=${row.lead.id}`)
    await expect(page.getByRole('article').getByText('Sí, señor 🦎 日本語')).toBeVisible()
  })

  test('F06-E7 a reply with no thread headers still finds its lead', async ({ page }) => {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    await replyFrom(lead.email, c.sender, undefined, 'Sent from a new email.')
    await tick()
    expect((await leadsOf(page, c.campaignId))[0].lead.needsReply).toBe(true)
  })

  test('F06-E8 mail from a stranger is ignored', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await approve(page, c.campaignId)
    await tick()
    await replyFrom(`stranger${uid()}@else.test`, c.sender, undefined, 'Buy my thing')
    await tick()
    expect((await api(page, 'GET', `/api/projects/${c.projectId}/inbox?tab=need_reply`)).json).toEqual([])
  })

  test('F06-E9 double click on send queues one reply', async ({ page }) => {
    const c = await conversation(page)
    await openThread(page, c)
    await page.getByLabel('Reply', { exact: true }).fill('Once only')
    await page.getByRole('button', { name: 'Send reply' }).dblclick()
    await expect(page.getByText('Queued')).toBeVisible()
    const { rows } = await pool.query(`select count(*)::int as n from messages where lead_id = $1 and kind = 'manual_reply'`, [c.leadId])
    expect(rows[0].n).toBe(1)
  })

  test('F06-E10 a bad lead link does not crash the inbox', async ({ page }) => {
    const c = await conversation(page)
    const missing = await page.goto(`/projects/${c.projectId}/inbox?lead=${randomUUID()}`)
    expect(missing?.status()).toBeLessThan(500)
    const bad = await page.goto(`/projects/${c.projectId}/inbox?lead=nonsense`)
    expect(bad?.status()).toBeLessThan(500)
  })

  const noIdReply = async (page: Page) => {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    const id = headerOf((await mailTo(lead.email))[0], 'Message-ID')
    const raw = `From: ${lead.email}\r\nTo: ${c.sender}\r\nSubject: Re: Hello\r\nIn-Reply-To: ${id}\r\n\r\nNo id on this one.\r\n`
    await smtp.sendMail({ envelope: { from: lead.email, to: c.sender }, raw })
    const [row] = await leadsOf(page, c.campaignId)
    const inbound = async () =>
      Number((await pool.query(`select count(*) from messages where lead_id = $1 and direction = 'inbound'`, [row.lead.id])).rows[0].count)
    return { inbound, sender: c.sender }
  }

  test('F06-E13 two polls at once store a reply with no Message-ID once', async ({ page }) => {
    const { inbound } = await noIdReply(page)
    await Promise.all([tick(), tick(), tick()])
    expect(await inbound()).toBe(1)
  })

  test('F06-E14 a poll that starts over does not store a reply with no Message-ID twice', async ({ page }) => {
    const { inbound, sender } = await noIdReply(page)
    await tick()
    expect(await inbound()).toBe(1)
    await pool.query(`update mailboxes set imap_last_uid = 0 where email = $1`, [sender])
    await tick()
    expect(await inbound()).toBe(1)
  })

  test('F06-E15 a reply saying stop opts the person out with no AI involved', async ({ page }) => {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    await replyFrom(lead.email, c.sender, headerOf((await mailTo(lead.email))[0], 'Message-ID'), 'STOP')
    await tick()
    const { rows } = await pool.query(`select unsubscribed_at from contacts where lower(email) = lower($1)`, [lead.email])
    expect(rows[0].unsubscribed_at).not.toBeNull()
  })

  test('F06-E11 an out-of-office keeps the lead in the sequence', async ({ page }) => {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, { followup_instructions: 'A short nudge.' })
    await approve(page, c.campaignId)
    await tick()
    const id = headerOf((await mailTo(lead.email))[0], 'Message-ID')
    await replyFrom(lead.email, c.sender, id, 'Away', { headers: { 'Auto-Submitted': 'auto-replied' } })
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    expect(row.lead.stage).toBe('active')
    expect(row.lead.needsReply).toBe(false)
  })

  test('F06-E12 a note and a mark-replied work and clear the badge', async ({ page }) => {
    const c = await conversation(page)
    await openThread(page, c)
    await page.getByRole('button', { name: 'I answered outside this app' }).click()
    await expect(page.getByRole('button', { name: 'I answered outside this app' })).toHaveCount(0)
    expect((await api(page, 'GET', `/api/projects/${c.projectId}/inbox?tab=need_reply`)).json).toEqual([])
  })

  test('F06-N1 an empty reply is refused', async ({ page }) => {
    const c = await conversation(page)
    expect((await api(page, 'POST', `/api/leads/${c.leadId}/reply`, { body: '   ' })).status).toBe(422)
  })

  test('F06-N2 a status from another project is refused', async ({ page }) => {
    const a = await conversation(page)
    const b = await conversation(page)
    const thread = (await api(page, 'GET', `/api/leads/${b.leadId}/thread`)).json
    expect((await api(page, 'PATCH', `/api/leads/${a.leadId}`, { status_id: thread.statuses[0].id })).status).toBe(400)
  })

  test('F06-N3 an empty lead update is not a server error', async ({ page }) => {
    const c = await conversation(page)
    expect((await api(page, 'PATCH', `/api/leads/${c.leadId}`, {})).status).toBe(200)
  })
})
