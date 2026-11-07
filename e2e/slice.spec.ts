import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

// Everything here stays on this machine: SMTP and IMAP are the local test server.
const run = Date.now()
const SENDER = `sender${run}@example.test`
const LONG_NAME = `Dental clinics in Portugal and Spain, spring outreach ${run}`.slice(0, 60)
const SHOTS = path.resolve('../replica/clone-screens')

const CSV = [
  'email,first_name,last_name,company,title',
  `ana${run}@clinic-one.test,Ana,Moreira,Clinic One,Owner`,
  `tom${run}@clinic-two.test,Tom,Vidal,Clinic Two,Manager`,
  `eva${run}@clinic-three.test,Eva,Stone,Clinic Three,Owner`,
  `kim${run}@clinic-four.test,Kim,Late,Clinic Four,Owner`,
  'not-an-email,Bad,Row,X,Y',
  `ana${run}@clinic-one.test,Ana,Again,Clinic One,Owner`,
  ',No,Email,X,Y',
  `bo${run}@blocked${run}.test,Bo,Blocked,Blocked Co,Owner`,
].join('\n')

const tick = () =>
  JSON.parse(execFileSync('npx', ['tsx', '--env-file=.env.local', 'src/worker/tick.ts'], { encoding: 'utf8' }).trim().split('\n').pop()!) as {
    sent: number
    received: string[]
  }

async function inbox() {
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
  const mail: { to: string; raw: string }[] = []
  for await (const m of client.fetch('1:*', { source: true, envelope: true })) {
    mail.push({ to: m.envelope?.to?.[0]?.address ?? '', raw: m.source!.toString('utf8') })
  }
  lock.release()
  await client.logout()
  return mail
}

const smtp = nodemailer.createTransport({ host: 'localhost', port: 1025, secure: false, tls: { rejectUnauthorized: false } })
const headerOf = (raw: string, name: string) => raw.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? ''

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Local test email').fill(email)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/projects')
}

async function snap(page: Page, id: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow, `${id} scrolls sideways at 390px`).toBe(false)
  await page.screenshot({ path: `${SHOTS}/${id}-390.png`, fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${SHOTS}/${id}.png` })
}

async function addMailbox(page: Page, password: string) {
  await page.getByLabel('Email address').fill(SENDER)
  await page.getByLabel('SMTP host').fill('localhost')
  await page.getByLabel('Port').first().fill('1025')
  await page.getByLabel('IMAP host').fill('localhost')
  await page.getByLabel('Port').nth(1).fill('1143')
  await page.getByLabel('Username').fill('testuser')
  await page.getByLabel('App password').fill(password)
  await page.getByRole('button', { name: 'Connect mailbox' }).click()
}

test('the core loop works from sign-in to a threaded reply', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))

  await login(page, `owner${run}@example.test`)
  await expect(page.getByText('Add your business to get started.')).toBeVisible()
  await snap(page, 'S18')

  await page.getByRole('button', { name: 'New project' }).click()
  await snap(page, 'S19')
  await page.getByLabel('Your website').fill('gmail.com')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('alert')).toContainText('company website')
  await page.getByLabel('Your website').fill(`https://www.acme${run}.test/about`)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/)
  const projectUrl = page.url()
  const projectId = projectUrl.split('/').pop()!
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`acme${run}.test`)
  await expect(page.getByRole('region', { name: 'Your next step' })).toContainText('Add your name and business address')
  await snap(page, 'S20-empty')

  await page.goto(`${projectUrl}/settings`)
  await page.getByLabel('Sender name').fill('Sam Rivers')
  await page.getByLabel('Business name and postal address').fill('Acme Ltd, 1 Test Road, Tashkent')
  await page.getByLabel(/lawful reason/).check()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await snap(page, 'S28')

  await page.goto(`${projectUrl}/mailboxes`)
  await expect(page.getByText('Connect a mailbox before you can send.')).toBeVisible()
  await addMailbox(page, 'wrong-password')
  await expect(page.getByText('Not tested')).toBeVisible()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Failing')).toBeVisible()
  await expect(page.getByText('We could not sign in to the inbox server')).toBeVisible()
  await snap(page, 'S44-failing')

  const boxes = await (await page.request.get(`/api/mailboxes?project_id=${projectId}`)).json()
  expect(JSON.stringify(boxes)).not.toMatch(/secret|wrong-password/i)
  await page.request.delete(`/api/mailboxes/${boxes[0].id}`)
  await page.reload()
  await addMailbox(page, 'testpass')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Active')).toBeVisible()
  await snap(page, 'S44')

  await page.goto('/suppression')
  await page.getByLabel('List name').fill('Competitors')
  await page.getByLabel('Emails or domains').fill(`blocked${run}.test`)
  await page.getByRole('button', { name: 'Add list' }).click()
  await expect(page.getByText('Competitors')).toBeVisible()
  await snap(page, 'S31')

  await page.goto(`${projectUrl}/import`)
  await page.getByLabel('Campaign name').fill(LONG_NAME)
  await page.getByLabel('CSV file').setInputFiles({ name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) })
  await snap(page, 'S27')
  await page.getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByText('4 leads ready for review')).toBeVisible({ timeout: 30_000 })
  for (const reason of ['Invalid email address', 'Duplicate in this file', 'Missing email or first name', 'On a do-not-contact list']) {
    await expect(page.getByText(reason)).toBeVisible()
  }
  await snap(page, 'S27-result')
  await page.getByRole('link', { name: 'Review leads' }).click()
  await page.waitForURL(/campaigns/)
  const campaignUrl = page.url()
  const campaignId = campaignUrl.split('/').pop()!
  await expect(page.getByText('Before you can approve: Write the first email.')).toBeVisible()

  const approveEarly = await page.request.post(`/api/campaigns/${campaignId}/approve`)
  expect(approveEarly.status()).toBe(409)

  await page.getByRole('row', { name: /Kim Late/ }).getByRole('button', { name: 'Exclude' }).click()
  await expect(page.getByRole('row', { name: /Kim Late/ }).getByText('Excluded')).toBeVisible()
  await snap(page, 'S22')

  await page.goto(`${campaignUrl}?tab=email`)
  await page.getByLabel('Subject').fill('A question for {{company}}')
  await page.getByLabel('Email', { exact: true }).fill('Hi {{first_name}},\n\nDo you book patients by phone?\n\n{{shoe_size}}')
  await page.getByRole('button', { name: 'Save email' }).click()
  await expect(page.getByText('{{shoe_size}} is not a variable we can fill.')).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill('Hi {{first_name}},\n\nDo you book patients by phone?')
  await page.getByRole('button', { name: 'Save email' }).click()
  await expect(page.getByLabel(/Preview for ana/).getByText('A question for Clinic One')).toBeVisible()
  await snap(page, 'S23')

  await page.request.patch(`/api/campaigns/${campaignId}`, {
    data: { send_days: [1, 2, 3, 4, 5, 6, 7], send_start_minute: 0, send_end_minute: 1440 },
  })
  await page.getByRole('button', { name: 'Approve 3 leads' }).click()
  await expect(page.getByText('Email 3 people from 1 mailbox?', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Approve and send' }).click()
  await expect(page.getByText(/Sending\. 3 left/)).toBeVisible()
  await snap(page, 'S21')

  // Added after approval: the last check before sending must still catch it.
  await page.request.post('/api/suppression', { data: { name: `Late ${run}`, entries: `eva${run}@clinic-three.test` } })
  // Several workers at once must never send the same email twice.
  const parallel = () => promisify(execFile)('npx', ['tsx', '--env-file=.env.local', 'src/worker/tick.ts'])
  await Promise.all([parallel(), parallel(), parallel(), parallel()])
  for (let i = 0; i < 3; i++) tick()
  const leads = await (await page.request.get(`/api/campaigns/${campaignId}/leads`)).json()
  const lead = (first: string) => leads.find((r: { contact: { firstName: string } }) => r.contact.firstName === first)
  expect(lead('Ana').lead.touchesSent).toBe(1)
  expect(lead('Tom').lead.touchesSent).toBe(1)
  expect(lead('Eva').lead.touchesSent).toBe(0)
  expect(lead('Eva').lead.stage).toBe('stopped')
  expect(lead('Kim').lead.touchesSent).toBe(0)
  expect(tick().sent).toBe(0)

  const mail = await inbox()
  const toAna = mail.find((m) => m.to === `ana${run}@clinic-one.test`)!
  const toTom = mail.find((m) => m.to === `tom${run}@clinic-two.test`)!
  expect(mail.filter((m) => m.to === `ana${run}@clinic-one.test`)).toHaveLength(1)
  expect(mail.some((m) => m.to.startsWith('eva') && m.to.includes(String(run)))).toBe(false)
  const flat = toAna.raw.replace(/=\r?\n/g, '').replace(/\r?\n[ \t]+/g, ' ')
  expect(flat).toContain('A question for Clinic One')
  expect(flat).toContain('Hi Ana,')
  expect(flat).toContain('Sam Rivers')
  expect(flat).toContain('Acme Ltd, 1 Test Road, Tashkent')
  expect(flat).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  const anaId = headerOf(toAna.raw, 'Message-ID')
  expect(anaId).toMatch(/^<.+@example\.test>$/)
  const unsubscribeUrl = flat.match(/http:\/\/localhost:3000\/u\/[0-9a-f]{64}/)![0]

  await smtp.sendMail({
    from: `ana${run}@clinic-one.test`,
    to: SENDER,
    subject: 'Re: A question for Clinic One',
    text: 'Yes, by phone. Tell me more.',
    inReplyTo: anaId,
    references: anaId,
  })
  await smtp.sendMail({
    from: `ana${run}@clinic-one.test`,
    to: SENDER,
    subject: 'Out of office',
    text: 'Back on Monday.',
    inReplyTo: anaId,
    headers: { 'Auto-Submitted': 'auto-replied' },
  })
  const tomId = headerOf(toTom.raw, 'Message-ID')
  await smtp.sendMail({
    envelope: { from: '', to: SENDER },
    raw: [
      'From: Mail Delivery System <mailer-daemon@example.test>',
      `To: ${SENDER}`,
      'Subject: Undelivered Mail Returned to Sender',
      `Message-ID: <bounce-${run}@example.test>`,
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'The address does not exist.',
      '--b',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${tomId}`,
      '--b--',
    ].join('\r\n'),
  })
  const pass = tick()
  expect(pass.received).toEqual(expect.arrayContaining(['reply', 'auto_response', 'bounce']))
  expect(tick().received.filter((r) => r !== 'own')).toEqual([])

  await page.goto(`${projectUrl}/inbox`)
  await expect(page.getByRole('link', { name: /Ana Moreira/ })).toBeVisible()
  await snap(page, 'S25-list')
  await page.getByRole('link', { name: /Ana Moreira/ }).click()
  await expect(page.getByText('Yes, by phone. Tell me more.')).toBeVisible()
  await expect(page.getByText('Auto-response')).toBeVisible()
  await page.getByLabel('Status').selectOption({ label: 'Hot' })
  await page.getByLabel('Note').fill('Books by phone.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.getByLabel('Reply', { exact: true }).fill('Great. Can we talk on Tuesday?')
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('Queued')).toBeVisible()
  expect(tick().sent).toBe(1)
  await page.reload()
  await expect(page.getByText('Queued')).toHaveCount(0)
  await snap(page, 'S25')

  const replyMail = (await inbox()).filter((m) => m.to === `ana${run}@clinic-one.test`).pop()!
  expect(headerOf(replyMail.raw, 'In-Reply-To')).toMatch(/^<.+>$/)
  expect(headerOf(replyMail.raw, 'Subject')).toBe('Re: A question for Clinic One')

  const after = await (await page.request.get(`/api/campaigns/${campaignId}/leads`)).json()
  const tom = after.find((r: { contact: { firstName: string } }) => r.contact.firstName === 'Tom')
  expect(tom.lead.stage).toBe('bounced')
  expect(tom.contact.emailStatus).toBe('invalid')

  await page.goto(unsubscribeUrl)
  await page.getByRole('button', { name: 'Unsubscribe' }).click()
  await expect(page.getByText('You are unsubscribed')).toBeVisible()
  const token = unsubscribeUrl.split('/').pop()
  expect((await page.request.post(`/u/${token}/confirm`, { form: { 'List-Unsubscribe': 'One-Click' } })).status()).toBe(200)
  await page.goto('/suppression')
  await expect(page.getByRole('listitem').filter({ hasText: 'Unsubscribed' })).toContainText('1 entry')
  await page.goto(`${projectUrl}/inbox?tab=replied`)
  await page.getByRole('link', { name: /Ana Moreira/ }).click()
  await expect(page.getByText('This person unsubscribed.')).toBeVisible()
  expect((await page.request.post(`/api/leads/${lead('Ana').lead.id}/reply`, { data: { body: 'hello' } })).status()).toBe(409)

  await page.goto(projectUrl)
  await snap(page, 'S20')

  const outsider = await browser.newContext({ baseURL: 'http://localhost:3000' })
  const other = await outsider.newPage()
  await login(other, `other${run}@example.test`)
  expect((await other.request.get(`/api/projects/${projectId}`)).status()).toBe(404)
  expect((await other.request.post(`/api/campaigns/${campaignId}/stop`)).status()).toBe(404)
  expect((await other.request.get(`/api/leads/${lead('Ana').lead.id}/thread`)).status()).toBe(404)
  await outsider.close()

  const anon = await browser.newContext({ baseURL: 'http://localhost:3000' })
  expect((await anon.request.get('/api/projects')).status()).toBe(401)
  await anon.close()

  // Expected failures above (409s and the rejected form) log as resource errors, nothing else should.
  expect(errors.filter((e) => !e.includes('status of 4'))).toEqual([])
})
