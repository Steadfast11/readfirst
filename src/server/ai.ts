import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, t } from '@/db'
import { budgetStop, recordSpend } from './spend'

/** Tests run on canned answers. A production build refuses them. */
export const aiFake = () => process.env.AI_FAKE === '1' && process.env.NODE_ENV !== 'production'
const useOpenAi = () => !process.env.ANTHROPIC_API_KEY && Boolean(process.env.AI_MODEL && (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL))
/** The person's own AI agent does the writing and sorting through MCP, so the app makes no AI calls itself. */
export const agentMode = () => process.env.AI_AGENT === '1'
export const apiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY) || useOpenAi()
export const aiConfigured = () => aiFake() || apiConfigured() || agentMode()

/** Try again later: no key yet, or the budget is used up. */
export class AiPaused extends Error {}
/** The model would not or could not answer. Trying again will not help. */
export class AiFailed extends Error {}

const globals = globalThis as unknown as { anthropic?: Anthropic }
const client = () => (globals.anthropic ??= new Anthropic())

const usdPerMillion = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

function costMicros(u: Anthropic.Usage) {
  const input = usdPerMillion('AI_INPUT_USD_PER_MTOK', 5)
  const output = usdPerMillion('AI_OUTPUT_USD_PER_MTOK', 25)
  return (
    u.input_tokens * input +
    (u.cache_creation_input_tokens ?? 0) * input * 1.25 +
    (u.cache_read_input_tokens ?? 0) * input * 0.1 +
    u.output_tokens * output
  )
}

export type Ask<S extends z.ZodType> = {
  task: string
  system: string
  prompt: string
  schema: S
  fake: () => z.infer<S>
  orgId: string
  projectId: string
  campaignId?: string | null
  maxTokens?: number
}

/** The API call alone. A limit or an outage means try later, so it must not count against a lead. */
export async function callModel(api: Anthropic, model: string, o: Pick<Ask<z.ZodType>, 'system' | 'prompt' | 'schema' | 'maxTokens'>) {
  try {
    return await api.messages.parse({
      model,
      max_tokens: o.maxTokens ?? 8000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: o.prompt }],
      output_config: { format: zodOutputFormat(o.schema as never) },
    })
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 400) throw new AiFailed('The AI rejected this request.')
    if (err instanceof Anthropic.APIError) {
      console.error('AI call failed', err.status, err.message)
      throw new AiPaused('api_error')
    }
    throw err
  }
}

type Usage = { prompt_tokens?: number; completion_tokens?: number }

/** OpenAI, or anything that speaks the same API, such as a local Ollama. Same failure rules as above. */
export async function callOpenAi(model: string, o: Pick<Ask<z.ZodType>, 'system' | 'prompt' | 'schema' | 'maxTokens'>) {
  const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY ?? 'local'}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: o.maxTokens ?? 8000,
        messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: z.toJSONSchema(o.schema, { unrepresentable: 'any' }) } },
      }),
    })
  } catch (err) {
    console.error('AI call failed', (err as Error).message)
    throw new AiPaused('api_error')
  }
  if (res.status === 400) throw new AiFailed('The AI rejected this request.')
  if (!res.ok) {
    console.error('AI call failed', res.status)
    throw new AiPaused('api_error')
  }
  const data = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string; refusal?: string } }[]; usage?: Usage }
  const choice = data.choices?.[0]
  if (choice?.message?.refusal) throw new AiFailed('The AI declined this request.')
  if (choice?.finish_reason === 'length') throw new AiFailed('The AI answer was cut off.')
  try {
    return { parsed: o.schema.parse(JSON.parse(choice?.message?.content ?? '')), usage: data.usage ?? {} }
  } catch {
    throw new AiFailed('The AI answer could not be read.')
  }
}

/** One structured model call. Checks the budget first and records what it cost. */
export async function ask<S extends z.ZodType>(o: Ask<S>): Promise<z.infer<S>> {
  const [project] = await db.select().from(t.projects).where(eq(t.projects.id, o.projectId))
  if (!aiConfigured()) throw new AiPaused('no_key')
  const stop = await budgetStop(project)
  if (stop) throw new AiPaused(stop)
  const spend = { orgId: o.orgId, projectId: o.projectId, campaignId: o.campaignId, kind: 'ai' as const }
  if (aiFake()) {
    await recordSpend({ ...spend, micros: 1000, detail: { task: o.task, fake: true } })
    return o.schema.parse(o.fake())
  }
  // Left for the agent: the work waits until it calls in.
  if (!apiConfigured()) throw new AiPaused('agent')
  if (useOpenAi()) {
    const model = process.env.AI_MODEL!
    const { parsed, usage } = await callOpenAi(model, o)
    const [input, output] = [usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0]
    const micros = input * usdPerMillion('AI_INPUT_USD_PER_MTOK', 5) + output * usdPerMillion('AI_OUTPUT_USD_PER_MTOK', 25)
    await recordSpend({ ...spend, micros, detail: { task: o.task, model, input, output } })
    return parsed as z.infer<S>
  }
  const model = process.env.AI_MODEL ?? 'claude-opus-5-5'
  const response = await callModel(client(), model, o)
  await recordSpend({
    ...spend,
    micros: costMicros(response.usage),
    detail: { task: o.task, model, input: response.usage.input_tokens, output: response.usage.output_tokens },
  })
  if (response.stop_reason === 'refusal') throw new AiFailed('The AI declined this request.')
  if (response.stop_reason === 'max_tokens') throw new AiFailed('The AI answer was cut off.')
  if (!response.parsed_output) throw new AiFailed('The AI answer could not be read.')
  return response.parsed_output as z.infer<S>
}
