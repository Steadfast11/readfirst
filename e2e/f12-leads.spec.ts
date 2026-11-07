import { api, approve, campaign, conversation, expect, leadsOf, login, newProject, pool, someLeads, test, tick, toCsv, upload, uid } from './helpers'
import type { Page } from '@playwright/test'

const waitStatus = async (page: Page, id: string, done: (c: { status: string; statusReason: string | null }) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const c = (await api(page, 'GET', `/api/campaigns/${id}`)).json
    if (done(c)) return c
    await page.waitForTimeout(100)
  }
  throw new Error('campaign did not change')
}

async function search(page: Page, geography = 'Portugal') {
  const { projectId, sender } = await newProject(page)
  const { json: c } = await api(page, 'POST', '/api/campaigns', { project_id: projectId, name: `Search ${uid()}`, offer: 'Booking', target_geography: geography })
  const start = await api(page, 'POST', `/api/campaigns/${c.id}/start`)
  expect(start.status).toBe(200)
  await waitStatus(page, c.id, (x) => x.status !== 'searching')
  return { projectId, sender, campaignId: c.id as string }
}

test.describe('Lead search', () => {
  test('L1 a search fills the review list, scored and checked, and waits for you', async ({ page }) => {
    await login(page)
    const c = await search(page)
    const rows = await leadsOf(page, c.campaignId)
    expect(rows).toHaveLength(3)
    const by = (name: string) => rows.find((r) => r.contact.firstName === name)!
    expect(by('Found0').lead.stage).toBe('review')
    expect(by('Found0').contact.emailStatus).toBe('valid')
    expect(by('Found1').lead.stage).toBe('excluded')
    expect(by('Found2').lead.stage).toBe('excluded')
    expect(by('Found2').contact.emailStatus).toBe('invalid')
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}`)).json.approvedAt).toBeNull()
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}`)
    await expect(page.getByText('Fit 4/5').first()).toBeVisible()
    await expect(page.getByText('Small and independent.')).toBeVisible()
    expect((await tick()).sent).toBe(0)
  })

  test('L2 no matches says so, and you can try again', async ({ page }) => {
    await login(page)
    const c = await search(page, 'Nowhere')
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('no_matches')
    await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, { target_geography: 'Portugal' })
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/start`)
    await waitStatus(page, c.campaignId, (x) => x.status === 'review')
  })

  test('L3 a provider failure is shown', async ({ page }) => {
    await login(page)
    const c = await search(page, 'Broken')
    const state = (await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json
    expect(state.state).toBe('launch_failed')
    expect(state.message).toContain('500')
  })

  test('L4 a suppressed domain never reaches the list', async ({ page }) => {
    await login(page)
    await api(page, 'POST', '/api/suppression', { name: `Block ${uid()}`, entries: 'prospect.test' })
    const c = await search(page)
    expect(await leadsOf(page, c.campaignId)).toHaveLength(0)
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('no_matches')
  })

  test('L5 search and checks are charged to the budget', async ({ page }) => {
    await login(page)
    const c = await search(page)
    const { rows } = await pool.query(`select kind, sum(amount_micros)::int as n from spend_events where campaign_id = $1 group by kind`, [c.campaignId])
    expect(rows.map((r) => r.kind).sort()).toEqual(['ai', 'email_verification', 'lead_data'])
  })

  test('L6 a spent budget stops the search', async ({ page }) => {
    await login(page)
    const { projectId } = await newProject(page)
    await api(page, 'PATCH', `/api/projects/${projectId}`, { daily_budget: 0 })
    const { json: c } = await api(page, 'POST', '/api/campaigns', { project_id: projectId, name: 'x', offer: 'y', target_geography: 'Portugal' })
    await api(page, 'POST', `/api/campaigns/${c.id}/start`)
    await waitStatus(page, c.id, (x) => x.status !== 'searching')
    expect((await api(page, 'GET', `/api/campaigns/${c.id}/status`)).json.state).toBe('launch_failed')
  })

  test('L7 imports are checked too, and bad addresses cannot be sent', async ({ page }) => {
    await login(page)
    const id = uid()
    const { projectId } = await newProject(page)
    const job = await upload(page, projectId, toCsv([{ email: `bad${id}@clinic.test` }, { email: `risky${id}@clinic.test` }, { email: `good${id}@clinic.test` }]))
    const rows = await leadsOf(page, job.campaignId)
    const bad = rows.find((r) => r.contact.email.startsWith('bad'))!
    expect([bad.contact.emailStatus, bad.lead.stage]).toEqual(['invalid', 'excluded'])
    await page.goto(`/projects/${projectId}/campaigns/${job.campaignId}`)
    await expect(page.getByText('Risky address')).toBeVisible()
  })
})

test.describe('Fixes from reviews', () => {
  test('R1 lead search needs a country', async ({ page }) => {
    await login(page)
    const { projectId } = await newProject(page)
    const { json: c } = await api(page, 'POST', '/api/campaigns', { project_id: projectId, name: 'x', offer: 'y' })
    const res = await api(page, 'POST', `/api/campaigns/${c.id}/start`)
    expect(res.status).toBe(409)
    expect(res.json.message).toContain('countries')
  })

  test('R2 settings show the most you can spend', async ({ page }) => {
    await login(page)
    const { projectId } = await newProject(page)
    await page.goto(`/projects/${projectId}/settings`)
    await expect(page.getByText('the most you can spend in a month is $155.00')).toBeVisible()
    await api(page, 'PATCH', `/api/projects/${projectId}`, { monthly_cap: 40 })
    await page.reload()
    await expect(page.getByText('the most you can spend in a month is $40.00')).toBeVisible()
  })

  test('R3 no replies after 100 people gives a plain warning', async ({ page }) => {
    await login(page)
    const c = await campaign(page, someLeads(100))
    await pool.query(`update leads set touches_sent = 1 where campaign_id = $1`, [c.campaignId])
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}`)
    await expect(page.getByText('No replies after 100 people.')).toBeVisible()
  })

  test('R4 a reply can be translated, and your facts reach the settings', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await page.goto(`/projects/${c.projectId}/inbox?tab=replied&lead=${c.leadId}`)
    await page.getByRole('button', { name: 'Translate' }).click()
    await expect(page.getByText('English: Tell me more.')).toBeVisible()
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { facts: 'We only serve clinics.' })
    await page.goto(`/projects/${c.projectId}/settings`)
    await expect(page.getByLabel('What the AI may say about you')).toHaveValue('We only serve clinics.')
  })

  test('R5 a hot lead who goes quiet is listed', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await api(page, 'POST', `/api/leads/${c.leadId}/reply`, { body: 'Sure, Tuesday?' })
    await tick()
    await pool.query(`update leads set last_message_at = now() - interval '4 days' where id = $1`, [c.leadId])
    await page.goto(`/projects/${c.projectId}/inbox?tab=quiet`)
    await expect(page.getByRole('link', { name: new RegExp(c.lead.first_name!) })).toBeVisible()
  })

  test('R6 a mail provider fills in the servers', async ({ page }) => {
    await login(page)
    const { projectId } = await newProject(page)
    await page.goto(`/projects/${projectId}/mailboxes`)
    await page.getByLabel('Mail provider').selectOption({ label: 'Google Workspace' })
    await expect(page.getByLabel('SMTP host')).toHaveValue('smtp.gmail.com')
    await expect(page.getByLabel('IMAP host')).toHaveValue('imap.gmail.com')
  })

  test('R7 deleting an account removes everything', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await page.goto('/projects')
    await page.getByRole('button', { name: 'Delete account' }).click()
    await page.getByRole('button', { name: 'Delete everything' }).click()
    await page.waitForURL('http://localhost:3000/')
    const { rows } = await pool.query(`select count(*)::int as n from leads where id = $1`, [c.leadId])
    expect(rows[0].n).toBe(0)
  })

  test('R8 the public pages load and name no one else', async ({ page }) => {
    for (const [url, text] of [['/', 'Cold email that waits for your OK.'], ['/privacy', 'Privacy policy'], ['/terms', 'Terms of use'], ['/compliance', 'Compliance']] as const) {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toContainText(text)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    }
    expect(await page.title()).toContain('Readfirst')
  })
})

test.describe('Sending safety', () => {
  test('S1 two mailboxes share the work, each within its own limit', async ({ page }) => {
    await login(page)
    const leads = someLeads(4)
    const c = await campaign(page, leads)
    const second = `second${uid()}@example.test`
    const { json: box } = await api(page, 'POST', '/api/mailboxes', { project_id: c.projectId, email: second, smtp_host: 'localhost', smtp_port: 1025, imap_host: 'localhost', imap_port: 1143, username: 'testuser', password: 'testpass', daily_limit: 1 })
    await api(page, 'POST', `/api/mailboxes/${box.id}/test`)
    await approve(page, c.campaignId)
    await tick()
    const { rows } = await pool.query(
      `select from_email, count(*)::int as n from messages m join leads l on l.id = m.lead_id where l.campaign_id = $1 and m.status = 'sent' group by 1`,
      [c.campaignId],
    )
    expect(rows).toHaveLength(2)
    await tick()
    const again = await pool.query(`select count(*)::int as n from messages where mailbox_id = $1 and status = 'sent'`, [box.id])
    expect(again.rows[0].n).toBe(1)
  })

  test('S2 too many bounces pause the mailbox', async ({ page }) => {
    await login(page)
    const c = await campaign(page, someLeads(1))
    await approve(page, c.campaignId)
    await tick()
    const [{ lead }] = await leadsOf(page, c.campaignId)
    await pool.query(
      `insert into messages (org_id, lead_id, mailbox_id, direction, kind, status, received_at, sent_at)
       select org_id, lead_id, mailbox_id, 'outbound', 'manual_reply', 'sent', null, now() from messages, generate_series(1, 25) where lead_id = $1 and kind = 'first'`,
      [lead.id],
    )
    await pool.query(
      `insert into messages (org_id, lead_id, mailbox_id, direction, kind, status, received_at)
       select org_id, lead_id, mailbox_id, 'inbound', 'bounce', 'received', now() from messages, generate_series(1, 3) where lead_id = $1 and kind = 'first'`,
      [lead.id],
    )
    await tick()
    const { json } = await api(page, 'GET', `/api/mailboxes?project_id=${c.projectId}`)
    expect(json[0].status).toBe('paused')
    expect(json[0].statusReason).toContain('bounced')
  })

  test('S3 your copy switches to AI at 10% bounces', async ({ page }) => {
    await login(page)
    const leads = someLeads(2)
    const c = await campaign(page, leads)
    await pool.query(`update mailboxes set daily_limit = 1 where project_id = $1`, [c.projectId])
    await approve(page, c.campaignId)
    await tick()
    const rows = await leadsOf(page, c.campaignId)
    const sentLead = rows.find((r) => r.lead.touchesSent === 1)!
    await pool.query(
      `insert into messages (org_id, lead_id, direction, kind, touch, status, sent_at)
       select org_id, lead_id, 'outbound', 'followup', 100 + g, 'sent', now() from messages, generate_series(1, 20) g where lead_id = $1 and kind = 'first'`,
      [sentLead.lead.id],
    )
    await pool.query(
      `insert into messages (org_id, lead_id, direction, kind, status, received_at)
       select org_id, lead_id, 'inbound', 'bounce', 'received', now() from messages, generate_series(1, 3) where lead_id = $1 and kind = 'first'`,
      [sentLead.lead.id],
    )
    await tick()
    const email = (await api(page, 'GET', `/api/campaigns/${c.campaignId}/first-email`)).json
    expect(email.mode).toBe('instructions')
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}?tab=email`)
    await expect(page.getByText('Your copy bounced too often')).toBeVisible()
  })
})

test.describe('Analytics and erasure', () => {
  test('N1 the dashboard shows real numbers', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await page.goto(`/projects/${c.projectId}`)
    const stats = page.getByRole('region', { name: 'Last 30 days' })
    await expect(stats.getByText('Emails sent')).toBeVisible()
    const numbers = (await api(page, 'GET', `/api/projects/${c.projectId}/analytics`)).json
    expect(numbers).toMatchObject({ contacted: 1, sent: 1, replies: 1, hot: 1 })
    expect(numbers.spendMicros).toBeGreaterThan(0)
    expect(numbers.costPerHotMicros).toBe(numbers.spendMicros)
    expect((await api(page, 'GET', `/api/projects/${c.projectId}/spend`)).json.length).toBeGreaterThan(0)
  })

  test('N2 the Sent tab exports a safe CSV', async ({ page }) => {
    await login(page)
    const id = uid()
    const c = await campaign(page, [{ email: `csv${id}@clinic.test`, first_name: '=HYPERLINK(1)', company: 'A, B' }], undefined, 'Hello', 'Hi there')
    await approve(page, c.campaignId)
    await tick()
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}?tab=sent`)
    await expect(page.getByRole('link', { name: 'Export CSV' })).toBeVisible()
    const res = await page.request.get(`/api/campaigns/${c.campaignId}/export`)
    expect(res.headers()['content-type']).toContain('text/csv')
    const csv = await res.text()
    expect(csv).toContain(`csv${id}@clinic.test`)
    expect(csv).toContain(`'=HYPERLINK(1)`)
    expect(csv).toContain('"A, B"')
  })

  test('N3 erasing a person blanks them and keeps them blocked', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await page.goto(`/suppression?email=${encodeURIComponent(c.lead.email)}`)
    await page.getByRole('button', { name: 'Erase' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Erase person' }).click()
    await expect(page.getByText('We hold nothing for this address.')).toBeVisible()
    const { rows } = await pool.query(
      `select m.subject, m.body_text, m.to_email, m.from_email, k.email, k.first_name from messages m join leads l on l.id = m.lead_id join contacts k on k.id = l.contact_id where l.id = $1`,
      [c.leadId],
    )
    expect(rows.length).toBeGreaterThan(1)
    for (const r of rows) expect(Object.values(r).every((v) => v === null)).toBe(true)
    const job = await upload(page, c.projectId, toCsv([c.lead]), 'Again')
    expect(job.totals).toContainEqual(expect.objectContaining({ reason: 'suppressed' }))
    await page.goto(`/projects/${c.projectId}/inbox?tab=replied`)
    await expect(page.getByText('Erased contact').first()).toBeVisible()
  })

  test('N4 a person can get a copy of their data', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    const { json: found } = await api(page, 'GET', `/api/contacts?email=${encodeURIComponent(c.lead.email)}`)
    const { json } = await api(page, 'GET', `/api/contacts/${found.id}/export`)
    expect(json.contact.email).toBe(c.lead.email)
    expect(json.messages.length).toBeGreaterThan(1)
  })

  test('N5 another user cannot reach any of this', async ({ page, browser }) => {
    await login(page)
    const c = await conversation(page)
    const { json: found } = await api(page, 'GET', `/api/contacts?email=${encodeURIComponent(c.lead.email)}`)
    const other = await (await browser.newContext({ baseURL: 'http://localhost:3000' })).newPage()
    await login(other)
    for (const [method, url] of [
      ['GET', `/api/projects/${c.projectId}/analytics`],
      ['GET', `/api/projects/${c.projectId}/spend`],
      ['GET', `/api/projects/${c.projectId}/first-email`],
      ['GET', `/api/campaigns/${c.campaignId}/analytics`],
      ['GET', `/api/campaigns/${c.campaignId}/export`],
      ['GET', `/api/contacts/${found.id}/export`],
      ['POST', `/api/contacts/${found.id}/erase`],
      ['POST', `/api/projects/${c.projectId}/analyse`],
      ['POST', `/api/campaigns/${c.campaignId}/preview`],
    ] as const) {
      expect((await api(other, method, url)).status, url).toBe(404)
    }
    const { status } = await api(other, 'GET', `/api/contacts?email=${encodeURIComponent(c.lead.email)}`)
    expect(status).toBe(404)
  })

  test('N6 custom statuses and the project email work', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await page.goto(`/projects/${c.projectId}/settings`)
    await page.getByLabel('New status').fill('Call booked')
    await page.getByRole('button', { name: 'Add status' }).click()
    await expect(page.getByText('Call booked')).toBeVisible()
    await page.goto(`/projects/${c.projectId}/inbox?tab=replied&lead=${c.leadId}`)
    await expect(page.getByLabel('Status').getByRole('option', { name: 'Call booked' })).toBeAttached()

    const next = await campaign(page, someLeads(1), c.projectId, 'Own', 'Own text')
    await api(page, 'PATCH', `/api/projects/${c.projectId}/first-email`, { mode: 'my_copy', subject: 'Project subject', body: 'Project body' })
    await api(page, 'PATCH', `/api/campaigns/${next.campaignId}`, { use_project_email: true })
    expect((await api(page, 'GET', `/api/campaigns/${next.campaignId}/first-email`)).json.subject).toBe('Project subject')
    expect((await api(page, 'PATCH', `/api/campaigns/${next.campaignId}/first-email`, { subject: 'x' })).status).toBe(409)
  })
})
