import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup, default: { lookup, resolveTxt: vi.fn() } }))

import { imapClient, smtpTransport, type MailboxRow } from '@/server/projects'
import { encryptSecret } from '@/server/render'

describe('mail connections', () => {
  const box = () =>
    ({ smtpHost: 'smtp.example.test', smtpPort: 587, imapHost: 'imap.example.test', imapPort: 993, username: 'u', secretEnc: encryptSecret('p') }) as MailboxRow

  beforeEach(() => {
    vi.stubEnv('MAIL_DEV_INSECURE', '')
    vi.stubEnv('MAILBOX_KEY', Buffer.alloc(32, 1).toString('base64'))
  })
  afterEach(() => void vi.unstubAllEnvs())

  it('connects to the address it checked, and still verifies the name on the certificate', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const smtp = await smtpTransport(box())
    expect((smtp as unknown as { options: { host: string; tls: { servername: string } } }).options).toMatchObject({ host: '93.184.216.34', tls: { servername: 'smtp.example.test' } })
    const imap = await imapClient(box())
    expect(imap.host).toBe('93.184.216.34')
    expect(imap.servername).toBe('imap.example.test')
  })

  it('will not connect once a saved host points inside the network', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    await expect(smtpTransport(box())).rejects.toMatchObject({ code: 'EDNS' })
    await expect(imapClient(box())).rejects.toMatchObject({ code: 'EDNS' })
  })
})
