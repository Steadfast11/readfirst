import { api, approve, campaign, conversation, expect, headerOf, leadsOf, login, mailTo, newProject, pool, replyFrom, someLeads, test, tick, uid } from './helpers'

// The AI answers are canned (AI_FAKE=1). These tests check what the app does with them.

const waitFor = async (page: Parameters<typeof api>[0], url: string, done: (x: never) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const state = (await api(page, 'GET', url)).json
    if (done(state as never)) return state
    await page.waitForTimeout(100)
  }
  throw new Error(`timed out on ${url}`)
}

async function aiCampaign(page: Parameters<typeof api>[0], count = 1) {
  const leads = someLeads(count)
  const c = await campaign(page, leads)
  await api(page, 'PATCH', `/api/campaigns/${c.campaignId}/first-email`, { mode: 'instructions', instructions: 'Ask how they book.' })
  return { ...c, leads }
}

test.describe('AI drafting', () => {
  test('A1 a new project is analysed and suggests campaigns', async ({ page }) => {
    await login(page)
    const id = uid()
    const { json: project } = await api(page, 'POST', '/api/projects', { domain: `acme${id}.test` })
    expect(project.status).toBe('creating')
    await waitFor(page, `/api/projects/${project.id}`, (p: { status: string }) => p.status === 'ready')
    await page.goto(`/projects/${project.id}`)
    await expect(page.getByRole('heading', { name: 'What we learned' })).toBeVisible()
    await expect(page.getByText('Likely competitors: Example Rival')).toBeVisible()
    await page.getByRole('button', { name: 'Use this' }).first().click()
    await page.waitForURL(/tab=targeting/)
    await expect(page.getByLabel('Job titles to reach')).toHaveValue('Clinic owner')
  })

  test('A2 you can start without a website', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByRole('button', { name: 'I don’t have a website' }).click()
    await page.getByLabel('What do you sell?').fill('Bookkeeping for bakeries')
    await page.getByLabel('Who is your ideal customer?').fill('Bakery owners')
    await page.getByLabel('Which markets?').fill('Tashkent')
    await page.getByRole('button', { name: 'Create project' }).click()
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { name: 'What we learned' })).toBeVisible({ timeout: 15_000 })
  })

  test('A3 a campaign from a name is drafted, and targeting and schedule can be edited', async ({ page }) => {
    await login(page)
    const { projectId } = await newProject(page)
    await page.goto(`/projects/${projectId}`)
    await page.getByRole('button', { name: 'New campaign' }).click()
    await page.getByLabel('Who do you want to reach?').fill('Clinics in Porto')
    await page.getByRole('button', { name: 'Create campaign' }).click()
    await page.waitForURL(/tab=targeting/)
    const cid = page.url().match(/campaigns\/([0-9a-f-]{36})/)![1]
    await waitFor(page, `/api/campaigns/${cid}`, (c: { offer: string | null }) => Boolean(c.offer))
    await page.reload()
    await expect(page.getByLabel('What you offer')).toHaveValue('Online booking for small clinics')
    await page.getByLabel('Leave out').fill('Hospitals\nChains')
    await page.getByRole('button', { name: 'Save targeting' }).click()
    await expect(page.getByText('Saved')).toBeVisible()
    expect((await api(page, 'GET', `/api/campaigns/${cid}`)).json.negativeCriteria).toEqual(['Hospitals', 'Chains'])

    await page.goto(page.url().replace('tab=targeting', 'tab=schedule'))
    await page.getByLabel('Sat').check()
    await page.getByLabel('From').fill('10:00')
    await page.getByLabel('Until').fill('16:30')
    await page.getByLabel('Emails per person').fill('2')
    await page.getByRole('button', { name: 'Save schedule' }).click()
    await expect(page.getByText('Saved')).toBeVisible()
    const saved = (await api(page, 'GET', `/api/campaigns/${cid}`)).json
    expect(saved.sendDays).toEqual([1, 2, 3, 4, 5, 6])
    expect([saved.sendStartMinute, saved.sendEndMinute, saved.maxTouches]).toEqual([600, 990, 2])
  })

  test('A4 AI emails need samples read first, then each lead gets their own', async ({ page }) => {
    await login(page)
    const c = await aiCampaign(page)
    const url = `/projects/${c.projectId}/campaigns/${c.campaignId}?tab=email`
    await page.goto(url)
    await expect(page.getByText('Before you can approve: Write sample emails and read them first.')).toBeVisible()
    expect((await approve(page, c.campaignId)).status).toBe(409)
    await page.getByRole('button', { name: 'Write sample emails' }).click()
    await expect(page.getByText('Bookings at Clinic 0')).toBeVisible()
    expect((await approve(page, c.campaignId)).status).toBe(200)
    await tick()
    const [mail] = await mailTo(c.leads[0].email)
    const flat = mail.replace(/=\r?\n/g, '')
    expect(flat).toContain('Bookings at Clinic 0')
    expect(flat).toContain('Acme Ltd, 1 Test Road')
    expect(flat).toContain('To stop these emails')
  })

  test('A5 changing the instructions asks you to read new samples', async ({ page }) => {
    await login(page)
    const c = await aiCampaign(page)
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/preview`)
    await api(page, 'PATCH', `/api/campaigns/${c.campaignId}/first-email`, { instructions: 'Something else.' })
    expect((await approve(page, c.campaignId)).status).toBe(409)
  })

  test('A6 variations and AI lines in your own copy', async ({ page }) => {
    await login(page)
    const leads = someLeads(1)
    const c = await campaign(page, leads, undefined, '{Hello|Hello} {{company}}', '{Hi|Hi} {{first_name}},\n\n{{ai: mention their company}}')
    expect((await approve(page, c.campaignId)).status).toBe(409)
    const [sample] = (await api(page, 'POST', `/api/campaigns/${c.campaignId}/preview`)).json
    expect(sample.body).toContain('I saw Clinic 0 takes bookings by phone.')
    expect(sample.subject).toBe('Hello Clinic 0')
    expect((await approve(page, c.campaignId)).status).toBe(200)
    await tick()
    const [mail] = await mailTo(leads[0].email)
    expect(mail.replace(/=\r?\n/g, '')).toContain('I saw Clinic 0 takes bookings by phone.')
  })

  test('A7 follow-ups go on the same thread and mailbox, then the lead finishes', async ({ page }) => {
    await login(page)
    const c = await aiCampaign(page)
    await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, { max_touches: 2, followup_delay_days: 1 })
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/preview`)
    await approve(page, c.campaignId)
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    await expect.poll(async () => (await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('idle')
    expect((await tick()).sent).toBe(0)
    await pool.query(`update leads set next_touch_at = now() - interval '1 minute' where id = $1`, [row.lead.id])
    expect((await tick()).sent).toBe(1)
    const mails = await mailTo(c.leads[0].email)
    expect(mails).toHaveLength(2)
    expect(headerOf(mails[1], 'In-Reply-To')).toBe(headerOf(mails[0], 'Message-ID'))
    expect(headerOf(mails[1], 'Subject')).toMatch(/^Re: /)
    expect((await leadsOf(page, c.campaignId))[0].lead.stage).toBe('finished')
    const { rows } = await pool.query(`select distinct mailbox_id from messages where lead_id = $1`, [row.lead.id])
    expect(rows).toHaveLength(1)
  })

  test('A7b it writes only what today can send, so unsent leads cost nothing', async ({ page }) => {
    await login(page)
    const c = await aiCampaign(page, 6)
    await pool.query(`update mailboxes set daily_limit = 2 where project_id = $1`, [c.projectId])
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/preview`)
    await approve(page, c.campaignId)
    await tick()
    await tick()
    await tick()
    const { rows } = await pool.query(
      `select count(*) filter (where not needs_draft)::int as written, count(*) filter (where status = 'sent')::int as sent
       from messages m join leads l on l.id = m.lead_id where l.campaign_id = $1`,
      [c.campaignId],
    )
    expect(rows[0].sent).toBe(2)
    expect(rows[0].written).toBeLessThanOrEqual(4)
  })

  test('A8 a reply stops follow-ups', async ({ page }) => {
    await login(page)
    const c = await aiCampaign(page)
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/preview`)
    await approve(page, c.campaignId)
    await tick()
    const [mail] = await mailTo(c.leads[0].email)
    await replyFrom(c.leads[0].email, c.sender, headerOf(mail, 'Message-ID'), 'Not interested, thanks.')
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    await pool.query(`update leads set next_touch_at = now() - interval '1 minute' where id = $1`, [row.lead.id])
    expect((await tick()).sent).toBe(0)
    expect(await mailTo(c.leads[0].email)).toHaveLength(1)
  })
})

test.describe('Reply handling', () => {
  test('A9 an interested reply becomes a hot lead with its reason', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    await page.goto(`/projects/${c.projectId}/inbox?tab=hot`)
    await page.getByRole('link', { name: new RegExp(c.lead.first_name!) }).click()
    await expect(page.getByLabel('Lead details').getByText('Wants to hear more.')).toBeVisible()
    await expect(page.getByText('Confidence 90%.')).toBeVisible()
    await expect(page.getByLabel('Status')).toHaveValue(/.+/)
  })

  test('A10 a vague reply is not hot, and still needs you', async ({ page }) => {
    await login(page)
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    const [mail] = await mailTo(lead.email)
    await replyFrom(lead.email, c.sender, headerOf(mail, 'Message-ID'), 'Maybe.')
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    expect(row.lead.needsReply).toBe(true)
    const { rows } = await pool.query(`select became_hot_at from leads where id = $1`, [row.lead.id])
    expect(rows[0].became_hot_at).toBeNull()
  })

  test('A11 asking to be removed unsubscribes the person', async ({ page }) => {
    await login(page)
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await tick()
    const [mail] = await mailTo(lead.email)
    await replyFrom(lead.email, c.sender, headerOf(mail, 'Message-ID'), 'Please remove me from your list.')
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    expect(row.contact.unsubscribedAt).not.toBeNull()
    expect(row.lead.needsReply).toBe(false)
  })
})

test.describe('Auto-replies', () => {
  async function withAutoReply(page: Parameters<typeof api>[0], text: string, booking = 'https://cal.example.test/sam') {
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { auto_reply_enabled: true, auto_reply_delay_minutes: 30, booking_url: booking })
    await approve(page, c.campaignId)
    await tick()
    const [mail] = await mailTo(lead.email)
    await replyFrom(lead.email, c.sender, headerOf(mail, 'Message-ID'), text)
    await tick()
    const [row] = await leadsOf(page, c.campaignId)
    const { rows } = await pool.query(`select * from messages where lead_id = $1 and kind = 'auto_reply'`, [row.lead.id])
    return { ...c, lead, leadId: row.lead.id, auto: rows, messageId: headerOf(mail, 'Message-ID') }
  }

  test('A13 off by default', async ({ page }) => {
    await login(page)
    const c = await conversation(page)
    const { rows } = await pool.query(`select 1 from messages where lead_id = $1 and kind = 'auto_reply'`, [c.leadId])
    expect(rows).toHaveLength(0)
  })

  test('A14 it waits, can be sent early, and carries the booking link', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'Can we have a call?')
    expect(c.auto).toHaveLength(1)
    expect((await tick()).sent).toBe(0)
    await page.goto(`/projects/${c.projectId}/inbox?tab=need_reply&lead=${c.leadId}`)
    await expect(page.getByText('AI reply')).toBeVisible()
    await page.getByRole('button', { name: 'Send now' }).click()
    await expect.poll(async () => (await pool.query(`select send_after <= now() as due from messages where id = $1`, [c.auto[0].id])).rows[0].due).toBe(true)
    expect((await tick()).sent).toBe(1)
    const mails = await mailTo(c.lead.email)
    expect(mails).toHaveLength(2)
    const flat = mails[1].replace(/=\r?\n/g, '')
    expect(flat).toContain('https://cal.example.test/sam')
    expect(flat).toContain('Acme Ltd, 1 Test Road')
    expect(headerOf(mails[1], 'Subject')).toMatch(/^Re: /)
    expect((await leadsOf(page, c.campaignId))[0].lead.needsReply).toBe(false)
  })

  test('A15 you can cancel it', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'Can we have a call?')
    expect((await api(page, 'POST', `/api/messages/${c.auto[0].id}/cancel`)).status).toBe(200)
    await pool.query(`update messages set send_after = now() where id = $1`, [c.auto[0].id])
    expect((await tick()).sent).toBe(0)
    expect((await api(page, 'POST', `/api/messages/${c.auto[0].id}/send-now`)).status).toBe(409)
  })

  test('A16 a reply that mentions a price waits for you', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'What is the price? I am interested.')
    expect(c.auto).toHaveLength(0)
    expect((await leadsOf(page, c.campaignId))[0].lead.needsReply).toBe(true)
  })

  test('A17 when the AI asks for a person, nothing is queued', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'Interested, human please.')
    expect(c.auto).toHaveLength(0)
  })

  test('A18 a new message from the lead cancels the waiting reply', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'Can we have a call?')
    await replyFrom(c.lead.email, c.sender, c.messageId, 'Actually, not interested.')
    await tick()
    const { rows } = await pool.query(`select status from messages where id = $1`, [c.auto[0].id])
    expect(rows[0].status).toBe('cancelled')
  })

  test('A18b stopping the campaign cancels a waiting reply and blocks new ones', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'Can we have a call?')
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/stop`)
    const { rows } = await pool.query(`select status from messages where id = $1`, [c.auto[0].id])
    expect(rows[0].status).toBe('cancelled')
    await replyFrom(c.lead.email, c.sender, c.messageId, 'Can we have a call today?')
    await tick()
    const again = await pool.query(`select count(*)::int as n from messages where lead_id = $1 and kind = 'auto_reply' and status = 'queued'`, [c.leadId])
    expect(again.rows[0].n).toBe(0)
  })

  test('A19 replying yourself cancels the waiting reply', async ({ page }) => {
    await login(page)
    const c = await withAutoReply(page, 'Can we have a call?')
    await api(page, 'POST', `/api/leads/${c.leadId}/reply`, { body: 'Sure, Tuesday?' })
    const { rows } = await pool.query(`select status from messages where id = $1`, [c.auto[0].id])
    expect(rows[0].status).toBe('cancelled')
  })
})

test.describe('Budget', () => {
  test('A20 a zero budget pauses AI and sending, and nothing is cancelled', async ({ page }) => {
    await login(page)
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { daily_budget: 0 })
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('zero_budget')
    expect((await tick()).sent).toBe(0)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { daily_budget: 5 })
    expect((await tick()).sent).toBe(1)
  })

  test('A21 spending the daily budget holds sending until it is raised', async ({ page }) => {
    await login(page)
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    const { rows } = await pool.query(`select org_id from projects where id = $1`, [c.projectId])
    await pool.query(`insert into spend_events (org_id, project_id, kind, amount_micros) values ($1, $2, 'ai', 6000000)`, [rows[0].org_id, c.projectId])
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('daily_budget_reached')
    expect((await tick()).sent).toBe(0)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { daily_budget: 10 })
    expect((await tick()).sent).toBe(1)
  })

  test('A22 a monthly cap stops spending', async ({ page }) => {
    await login(page)
    const [lead] = someLeads(1)
    const c = await campaign(page, [lead])
    await approve(page, c.campaignId)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { monthly_cap: 0 })
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('monthly_cap_reached')
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { monthly_cap: null })
    expect((await tick()).sent).toBe(1)
  })
})
