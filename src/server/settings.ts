import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { ApiError } from './http'
import { decryptSecret, encryptSecret } from './render'

/** Kept out of pages and API replies once saved. */
export const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LEAD_API_KEY', 'EMAIL_VERIFIER_KEY'] as const
export const PLAIN_KEYS = ['AI_AGENT', 'OPENAI_BASE_URL', 'AI_MODEL', 'AI_INPUT_USD_PER_MTOK', 'AI_OUTPUT_USD_PER_MTOK', 'LEGAL_NAME', 'LEGAL_EMAIL'] as const
type Key = (typeof SECRET_KEYS)[number] | (typeof PLAIN_KEYS)[number]

const value = z.string().trim().max(500).optional()
export const settingsUpdate = z.object({
  ...Object.fromEntries([...SECRET_KEYS, ...PLAIN_KEYS].map((k) => [k, value])),
  remove: z.array(z.enum(SECRET_KEYS)).optional(),
}) as z.ZodType<Partial<Record<Key, string>> & { remove?: (typeof SECRET_KEYS)[number][] }>

const file = () => process.env.SETTINGS_FILE

function read(): Partial<Record<Key, string>> {
  const path = file()
  if (!path || !existsSync(path)) return {}
  return JSON.parse(decryptSecret(readFileSync(path, 'utf8')))
}

/** What a page may show: plain values, and only whether each secret is set. */
export function publicSettings() {
  const saved = read()
  return {
    plain: Object.fromEntries(PLAIN_KEYS.map((k) => [k, saved[k] ?? ''])) as Record<(typeof PLAIN_KEYS)[number], string>,
    secrets: Object.fromEntries(SECRET_KEYS.map((k) => [k, Boolean(saved[k])])) as Record<(typeof SECRET_KEYS)[number], boolean>,
  }
}

/** A blank secret means "keep what is saved". The desktop app restarts its services when this file changes. */
export function saveSettings(input: z.infer<typeof settingsUpdate>) {
  const path = file()
  if (!path) throw new ApiError(404, 'not_found', 'Settings are only available in the desktop app.')
  const next = read()
  for (const k of PLAIN_KEYS) if (input[k] !== undefined) next[k] = input[k]
  for (const k of SECRET_KEYS) if (input[k]) next[k] = input[k]
  for (const k of input.remove ?? []) delete next[k]
  writeFileSync(`${path}.tmp`, encryptSecret(JSON.stringify(next)), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  return publicSettings()
}
