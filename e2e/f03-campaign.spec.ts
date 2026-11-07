import { alertWith, api, approve, campaign, expect, leadsOf, login, mailTo, pool, someLeads, test, tick, ticks } from './helpers'

test.describe('F03 campaign', () => {
  test.beforeEach(async ({ page }) => void (await login(page)))

  test('F03-H1 stop halts sending and start finishes the rest, each person once', async ({ page }) => {
    const leads = someLeads(3)
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    expect((await tick()).sent).toBe(1)
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/stop`)
    expect((await tick()).sent).toBe(0)
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/start`)
    expect(await ticks(3)).toBe(2)
    for (const lead of leads) expect(await mailTo(lead.email)).toHaveLength(1)
  })

  test('F03-E1 double click on approve queues each lead once', async ({ page }) => {
    const c = await campaign(page, someLeads(2))
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}`)
    await page.getByRole('button', { name: 'Approve 2 leads' }).click()
    const confirm = page.getByRole('button', { name: 'Approve and send' })
    await confirm.dblclick()
    await expect(page.getByText(/Sending\. 2 left/)).toBeVisible()
    const { rows } = await pool.query(
      `select count(*)::int as n from messages m join leads l on l.id = m.lead_id where l.campaign_id = $1 and m.status = 'queued'`,
      [c.campaignId],
    )
    expect(rows[0].n).toBe(2)
  })

  test('F03-E2 a stale tab cannot change the list after approval', async ({ page }) => {
    const c = await campaign(page, someLeads(2))
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}`)
    await approve(page, c.campaignId)
    await page.getByRole('button', { name: 'Exclude' }).first().click()
    await expect(alertWith(page, 'already been approved')).toBeVisible()
  })

  test('F03-E3 removing the footer pauses sending and loses nothing', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { legal_footer: '' })
    expect((await tick()).sent).toBe(0)
    expect((await leadsOf(page, c.campaignId))[0].lead.stage).toBe('active')
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { legal_footer: 'Acme Ltd, 1 Test Road' })
    expect((await tick()).sent).toBe(1)
  })

  test('F03-E4 without a legal basis the status does not claim to be sending', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await approve(page, c.campaignId)
    await api(page, 'PATCH', `/api/projects/${c.projectId}`, { legal_basis_confirmed: false })
    const state = (await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json
    expect(state.state).not.toBe('sending')
    expect((await tick()).sent).toBe(0)
    expect((await leadsOf(page, c.campaignId))[0].lead.stage).toBe('active')
  })

  test('F03-E5 one person in two campaigns gets one email', async ({ page }) => {
    const leads = someLeads(1)
    const first = await campaign(page, leads)
    const second = await campaign(page, leads, first.projectId)
    expect(second.campaignId).toBeTruthy()
    await approve(page, first.campaignId)
    await approve(page, second.campaignId)
    await Promise.all([tick(), tick(), tick()])
    await ticks(2)
    expect(await mailTo(leads[0].email)).toHaveLength(1)
    const stages = [...(await leadsOf(page, first.campaignId)), ...(await leadsOf(page, second.campaignId))].map((r) => r.lead.stage).sort()
    expect(stages).toEqual(['finished', 'stopped'])
  })

  test('F03-E6 nothing sends outside the window, and the status says so', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    const today = new Date().getUTCDay() || 7
    const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today)
    await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, { send_days: days })
    await approve(page, c.campaignId)
    expect((await tick()).sent).toBe(0)
    expect((await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json.state).toBe('scheduled')
  })

  test('F03-E7 the mailbox daily limit holds', async ({ page }) => {
    const c = await campaign(page, someLeads(3))
    await api(page, 'PATCH', `/api/mailboxes/${c.mailboxId}`, { daily_limit: 2 })
    await approve(page, c.campaignId)
    expect(await ticks(4)).toBe(2)
  })

  test('F03-E8 a crash mid-send is never resent', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    await pool.query(
      `update messages m set status = 'sending', claimed_at = now() - interval '11 minutes'
       from leads l where l.id = m.lead_id and l.campaign_id = $1`,
      [c.campaignId],
    )
    expect((await tick()).reaped).toBe(1)
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/stop`)
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/start`)
    expect(await ticks(2)).toBe(0)
    expect(await mailTo(leads[0].email)).toHaveLength(0)
  })

  test('F03-N1 an archived campaign cannot be approved or sent', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await api(page, 'POST', `/api/campaigns/${c.campaignId}/archive`)
    expect((await approve(page, c.campaignId)).status).toBe(409)
    expect((await tick()).sent).toBe(0)
  })

  test('F03-N2 approval is refused with no working mailbox', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await api(page, 'DELETE', `/api/mailboxes/${c.mailboxId}`)
    const res = await approve(page, c.campaignId)
    expect(res.status).toBe(409)
    expect(res.json.message).toContain('mailbox')
  })

  test('F03-N3 a window that ends before it starts is refused', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    const res = await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, { send_start_minute: 600, send_end_minute: 500 })
    expect(res.status).toBe(422)
  })

  test('F03-E9 an empty campaign update is not a server error', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    expect((await api(page, 'PATCH', `/api/campaigns/${c.campaignId}`, {})).status).toBe(200)
  })
})
