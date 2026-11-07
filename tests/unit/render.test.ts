import { DateTime } from 'luxon'
import { beforeAll, describe, expect, it } from 'vitest'
import { composeBody, decryptSecret, isStopRequest, encryptSecret, renderTemplate, withinSendWindow } from '../../src/server/render'

beforeAll(() => {
  process.env.MAILBOX_KEY = Buffer.alloc(32, 7).toString('base64')
})

describe('renderTemplate', () => {
  it('fills variables and fallbacks', () => {
    expect(renderTemplate('Hi {{first_name}} at {{ company }}', { first_name: 'Ana', company: 'Lume' }).text).toBe('Hi Ana at Lume')
    expect(renderTemplate('Hi {{first_name|there}}', {}).text).toBe('Hi there')
  })
  it('reports missing and unknown variables', () => {
    const out = renderTemplate('{{first_name}} {{shoe_size}}', {})
    expect(out.missing).toEqual(['first_name'])
    expect(out.unknown).toEqual(['shoe_size'])
  })
  it('treats a blank value as missing', () => {
    expect(renderTemplate('{{company}}', { company: '  ' }).missing).toEqual(['company'])
  })
})

describe('composeBody', () => {
  it('always ends with the address and the opt-out link', () => {
    const body = composeBody('Hello', { senderName: 'Sam', footer: 'Co, 1 Road', stopLine: 'To stop these emails: https://x/u/t' })
    expect(body).toContain('Co, 1 Road')
    expect(body.endsWith('https://x/u/t')).toBe(true)
  })
})

describe('withinSendWindow', () => {
  const c = { sendDays: [1, 2, 3, 4, 5], sendStartMinute: 540, sendEndMinute: 1020 }
  it('uses the project time zone', () => {
    const monday = DateTime.fromISO('2026-11-02T05:00:00Z')
    expect(withinSendWindow(c, 'Asia/Tashkent', monday)).toBe(true)
    expect(withinSendWindow(c, 'UTC', monday)).toBe(false)
  })
  it('skips days off', () => {
    expect(withinSendWindow(c, 'UTC', DateTime.fromISO('2026-11-07T12:00:00Z'))).toBe(false)
  })
  it('holds the local hour across a daylight saving change', () => {
    const before = DateTime.fromISO('2026-10-30T13:30:00Z')
    const after = DateTime.fromISO('2026-11-02T14:30:00Z')
    expect(withinSendWindow({ ...c, sendStartMinute: 570, sendEndMinute: 600 }, 'America/New_York', before)).toBe(true)
    expect(withinSendWindow({ ...c, sendStartMinute: 570, sendEndMinute: 600 }, 'America/New_York', after)).toBe(true)
  })
})

describe('secrets', () => {
  it('round-trips and never stores plain text', () => {
    const stored = encryptSecret('app-password')
    expect(stored).not.toContain('app-password')
    expect(decryptSecret(stored)).toBe('app-password')
  })
  it('rejects tampering', () => {
    const raw = Buffer.from(encryptSecret('x'), 'base64')
    raw[raw.length - 1] ^= 1
    expect(() => decryptSecret(raw.toString('base64'))).toThrow()
  })
})

describe('isStopRequest', () => {
  it('reads a plain stop in the subject or first line', () => {
    expect(isStopRequest('Re: Hello', 'STOP')).toBe(true)
    expect(isStopRequest('unsubscribe', '')).toBe(true)
    expect(isStopRequest('Re: Hello', '\n Remove me.\n> quoted')).toBe(true)
  })
  it('leaves ordinary replies alone', () => {
    expect(isStopRequest('Re: Hello', "Please don't stop, tell me more")).toBe(false)
  })
})
