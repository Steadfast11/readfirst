import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

export const VARIABLES = ['first_name', 'last_name', 'company', 'job_title'] as const
export type Vars = Partial<Record<(typeof VARIABLES)[number], string | null>>

const TOKEN = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g

const SPIN = /\{([^{}|\n]*(?:\|[^{}|\n]*)+)\}/g
const AI_LINE = /\{\{\s*ai:\s*([^}]+)\}\}/g

export const hasAiLines = (text: string) => /\{\{\s*ai:/.test(text)
export const aiLines = (text: string) => [...text.matchAll(AI_LINE)].map((m) => m[1].trim())
export const fillAiLines = (text: string, lines: string[]) => {
  let i = 0
  return text.replace(AI_LINE, () => lines[i++] ?? '')
}

function pick(options: string[], seed: string) {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return options[hash % options.length].trim()
}

/** Fills {{first_name}} and {{first_name|there}}, and picks one of {a|b}. The same seed picks the same words. */
export function renderTemplate(text: string, vars: Vars, seed = '') {
  const missing = new Set<string>()
  const unknown = new Set<string>()
  const out = text.replace(TOKEN, (_, name: string, fallback?: string) => {
    if (!(VARIABLES as readonly string[]).includes(name)) {
      unknown.add(name)
      return ''
    }
    const value = vars[name as keyof Vars]?.trim()
    if (value) return value
    if (fallback !== undefined) return fallback.trim()
    missing.add(name)
    return ''
  })
  return { text: out.replace(SPIN, (_, options: string) => pick(options.split('|'), seed + options)), missing: [...missing], unknown: [...unknown] }
}

/** A plain "stop" must work even with no AI and no public web address. */
export function isStopRequest(subject: string, text: string) {
  const clean = (v: string) => v.toLowerCase().replace(/^(re|aw|fw|fwd):\s*/, '').replace(/[^\p{L}\p{N} ]/gu, '').trim()
  const words = ['stop', 'unsubscribe', 'remove me']
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? ''
  return words.includes(clean(subject)) || words.includes(clean(firstLine))
}

export function composeBody(body: string, o: { senderName: string; footer: string; stopLine: string }) {
  const parts = [body.trim()]
  if (o.senderName) parts.push(o.senderName)
  parts.push(`--\n${o.footer.trim()}\n${o.stopLine}`)
  return parts.join('\n\n')
}

export function withinSendWindow(
  c: { sendDays: number[]; sendStartMinute: number; sendEndMinute: number },
  timezone: string,
  now: DateTime = DateTime.utc(),
) {
  const local = now.setZone(timezone)
  if (!local.isValid) return false
  const minute = local.hour * 60 + local.minute
  return c.sendDays.includes(local.weekday) && minute >= c.sendStartMinute && minute < c.sendEndMinute
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase()
export const emailHash = (email: string) => createHash('sha256').update(normalizeEmail(email)).digest('hex')
export const emailDomain = (email: string) => normalizeEmail(email).split('@')[1] ?? ''
export const isEmail = (v: string) => /^[^\s@,;:<>()"\\]+@[^\s@,;:<>()"\\]+\.[^\s@,;:<>()"\\]{2,}$/.test(v.trim())

/** Drizzle refuses an update with nothing in it. */
export const hasValues = (o: object) => Object.values(o).some((v) => v !== undefined)

function key() {
  const k = Buffer.from(process.env.MAILBOX_KEY ?? '', 'base64')
  if (k.length !== 32) throw new Error('MAILBOX_KEY must be 32 bytes, base64 encoded')
  return k
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decryptSecret(stored: string) {
  const raw = Buffer.from(stored, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}
