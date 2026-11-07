import { simpleParser } from 'mailparser'
import { alertWith, api, approve, campaign, expect, leadsOf, login, mailTo, someLeads, test, ticks, uid } from './helpers'

test.describe('F04 first email', () => {
  test.beforeEach(async ({ page }) => void (await login(page)))

  test('F04-E1 a lead missing a variable is reported, not lost', async ({ page }) => {
    const leads = [{ email: `full${uid()}@clinic.test`, company: 'Clinic' }, { email: `gap${uid()}@clinic.test`, company: '' }]
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    await ticks(3)
    const rows = await leadsOf(page, c.campaignId)
    const gap = rows.find((r) => r.contact.email === leads[1].email)!
    expect(gap.lead.stage).not.toBe('active')
    const state = (await api(page, 'GET', `/api/campaigns/${c.campaignId}/status`)).json
    expect(state.message).not.toContain('Everyone')
    expect(state.message).toContain('1')
  })

  test('F04-E2 accents and emoji survive in subject and body', async ({ page }) => {
    const leads = someLeads(1)
    const c = await campaign(page, leads, undefined, 'Olá 🦎 {{company}}', 'Señor {{first_name}}, ¿cómo está? 日本語')
    await approve(page, c.campaignId)
    await ticks(1)
    const [raw] = await mailTo(leads[0].email)
    const parsed = await simpleParser(raw)
    expect(parsed.subject).toBe('Olá 🦎 Clinic 0')
    expect(parsed.text).toContain('¿cómo está? 日本語')
  })

  test('F04-E3 a CSV value cannot inject mail headers', async ({ page }) => {
    const id = uid()
    const leads = [{ email: `inject${id}@clinic.test`, company: `Acme\nBcc: evil${id}@attacker.test` }]
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    await ticks(1)
    expect(await mailTo(`evil${id}@attacker.test`)).toHaveLength(0)
    const [raw] = await mailTo(leads[0].email)
    expect(raw).not.toMatch(/^Bcc:/im)
  })

  test('F04-E4 a very long email gets a readable error', async ({ page }) => {
    const c = await campaign(page, someLeads(1))
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}?tab=email`)
    await page.getByLabel('Email', { exact: true }).fill('x'.repeat(6000))
    await page.getByRole('button', { name: 'Save email' }).click()
    await expect(alertWith(page, 'Body is too long. The limit is 5000 characters.')).toBeVisible()
  })

  test('F04-E5 markup in lead data shows as text', async ({ page }) => {
    const leads = [{ email: `xss${uid()}@clinic.test`, first_name: '<img src=x onerror=alert(1)>', company: '<b>Co</b>' }]
    const c = await campaign(page, leads)
    page.on('dialog', () => {
      throw new Error('script ran')
    })
    await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}?tab=email`)
    await expect(page.getByLabel(/Preview for xss/).getByText('Hi <img src=x onerror=alert(1)>')).toBeVisible()
    await expect(page.locator('img')).toHaveCount(0)
  })

  test('F04-E6 a value containing braces is not treated as a template', async ({ page }) => {
    const leads = [{ email: `brace${uid()}@clinic.test`, company: '{{first_name}}' }]
    const c = await campaign(page, leads)
    await approve(page, c.campaignId)
    await ticks(1)
    const parsed = await simpleParser((await mailTo(leads[0].email))[0])
    expect(parsed.subject).toBe('Hello {{first_name}}')
  })


  test('F04-N2 approval is refused with no email written', async ({ page }) => {
    const c = await campaign(page, someLeads(1), undefined, '', '')
    const res = await approve(page, c.campaignId)
    expect(res.status).toBe(409)
    expect(res.json.message).toContain('first email')
  })
})
