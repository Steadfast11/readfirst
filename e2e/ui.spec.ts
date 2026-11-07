import AxeBuilder from '@axe-core/playwright'
import { api, campaign, conversation, expect, login, test, toCsv, uid, upload, type Lead } from './helpers'
import type { Page } from '@playwright/test'

const LONG = 'x'.repeat(60)

async function screens(page: Page) {
  await login(page)
  const c = await conversation(page)
  const leads: Lead[] = [{ email: `${LONG}@clinic.test`, first_name: LONG, last_name: LONG, company: LONG }]
  const job = await upload(page, c.projectId, toCsv(leads), `${LONG}${uid()}`.slice(0, 80))
  await api(page, 'POST', '/api/suppression', { name: `${LONG}${uid()}`, entries: 'a@b.test' })
  await api(page, 'PATCH', `/api/projects/${c.projectId}`, { sender_name: LONG })
  const p = `/projects/${c.projectId}`
  return {
    S18: '/projects',
    S20: p,
    S22: `${p}/campaigns/${job.campaignId}`,
    S23: `${p}/campaigns/${job.campaignId}?tab=email`,
    S25: `${p}/inbox?tab=replied`,
    'S25-thread': `${p}/inbox?tab=replied&lead=${c.leadId}`,
    S27: `${p}/import`,
    'S27-result': `${p}/imports/${job.id}`,
    S28: `${p}/settings`,
    S31: '/suppression',
    S44: `${p}/mailboxes`,
  }
}

test('UI-1 no sideways scroll at phone, tablet or desktop, with 60-character values', async ({ page }) => {
  const urls = await screens(page)
  const failures: string[] = []
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [id, url] of Object.entries(urls)) {
      await page.goto(url)
      const over = await page.evaluate(() => {
        const by = document.documentElement.scrollWidth - window.innerWidth
        const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).pop()
        return { by, wide: wide ? `${wide.tagName} ${wide.className}`.slice(0, 70) : '' }
      })
      if (over.by > 0) failures.push(`${id} at ${width}px overflows by ${over.by}px: ${over.wide}`)
    }
  }
  expect(failures).toEqual([])
})

test('UI-2 every screen passes an accessibility scan', async ({ page }) => {
  const urls = await screens(page)
  const failures: string[] = []
  for (const [id, url] of Object.entries(urls)) {
    await page.goto(url)
    const { violations } = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze()
    for (const v of violations) failures.push(`${id}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target}`)
  }
  await page.goto('/u/not-real')
  expect(failures).toEqual([])
})

test('UI-3 the login page passes an accessibility scan', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:3000' })
  const page = await context.newPage()
  await page.goto('/login')
  const { violations } = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze()
  expect(violations.map((v) => v.id)).toEqual([])
  await context.close()
})

test('UI-9 Enter before the page has loaded cannot submit a form as a plain page load', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:3000', javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Local test email').fill('early@example.test')
  await page.getByLabel('Local test email').press('Enter')
  await page.waitForTimeout(500)
  expect(page.url()).toBe('http://localhost:3000/login')
  await context.close()
})

test('UI-4 sign in and create a project with the keyboard only', async ({ page }) => {
  await page.goto('/login')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Local test email')).toBeFocused()
  await page.keyboard.type(`keys${uid()}@example.test`)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  await page.keyboard.press('Enter')
  await page.waitForURL('**/projects')
  const button = page.getByRole('button', { name: 'New project' })
  await button.focus()
  await page.keyboard.press('Enter')
  const field = page.getByLabel('Your website')
  await expect(field).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.type(`keys${uid()}.test`)
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
})

test('UI-5 approve with the keyboard, and every control shows focus', async ({ page }) => {
  await login(page)
  const c = await campaign(page, [{ email: `key${uid()}@clinic.test` }])
  await page.goto(`/projects/${c.projectId}/campaigns/${c.campaignId}`)
  const seen: string[] = []
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const s = getComputedStyle(el)
      return { tag: el.tagName, text: el.innerText?.slice(0, 20), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 }
    })
    if (info.tag === 'BODY' || info.tag === 'NEXTJS-PORTAL') continue
    if (!info.outline) seen.push(`${info.tag} ${info.text}`)
  }
  expect(seen, 'controls with no visible focus').toEqual([])
  await page.getByRole('button', { name: 'Approve 1 lead' }).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Approve and send' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Sending\. 1 left/)).toBeVisible()
})

test('UI-6 phone inbox moves between list and thread', async ({ page }) => {
  await login(page)
  const c = await conversation(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${c.projectId}/inbox`)
  await page.getByRole('link', { name: /Lead0/ }).click()
  await expect(page.getByRole('article').getByText('Tell me more.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to inbox' }).click()
  await expect(page.getByRole('link', { name: /Lead0/ })).toBeVisible()
})

test('UI-7 tablet inbox shows list and thread together', async ({ page }) => {
  await login(page)
  const c = await conversation(page)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto(`/projects/${c.projectId}/inbox?lead=${c.leadId}`)
  await expect(page.getByRole('article').getByText('Tell me more.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Lead0/ })).toBeVisible()
})

test('UI-8 a dialog is full screen on a phone and closes on Escape', async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const box = await page.getByRole('dialog').boundingBox()
  expect(box?.width).toBe(390)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
