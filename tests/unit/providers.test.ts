import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analysisSchema, draftSchema, emailSchema, replySchema } from '@/server/agent'
import { z } from 'zod'
import { AiFailed, AiPaused, callModel, callOpenAi } from '@/server/ai'
import { peopleDataLabs, scoreSchema, zeroBounce } from '@/server/leadsource'

type Reply = { status?: number; body: unknown }

function stub(reply: Reply) {
  const requests: Record<string, unknown>[] = []
  const api = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: (async (_url: unknown, init: { body: string }) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
    }) as never,
  })
  return { api, requests }
}

const message = (text: string, stop = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'm',
  content: [{ type: 'text', text }],
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 },
})

const ask = { system: 's', prompt: 'p' }

describe('the real AI call, against a stub server', () => {
  it('sends the schema and reads the structured answer', async () => {
    const { api, requests } = stub({ body: message('{"subject":"Hi","body":"Hello"}') })
    const res = await callModel(api, 'model-x', { ...ask, schema: emailSchema })
    expect(res.parsed_output).toEqual({ subject: 'Hi', body: 'Hello' })
    const sent = requests[0] as { model: string; thinking: unknown; output_config: { format: { type: string } } }
    expect(sent.model).toBe('model-x')
    expect(sent.thinking).toEqual({ type: 'adaptive' })
    expect(sent.output_config.format.type).toBe('json_schema')
  })

  it('every schema converts for the API', async () => {
    const empty = {
      analysis: { summary: '', offer: '', ideal_customers: [], competitors: [], campaigns: [] },
      draft: { offer: '', customer_problem: '', target_role: '', target_geography: '', target_company_size: '', positive_criteria: [], negative_criteria: [], keywords: '', email_instructions: '' },
      reply: { intent: 'other', confidence: 0.5, reason: '' },
      score: { scores: [] },
    }
    for (const [schema, value] of [[analysisSchema, empty.analysis], [draftSchema, empty.draft], [replySchema, empty.reply], [scoreSchema, empty.score]] as const) {
      const { api } = stub({ body: message(JSON.stringify(value)) })
      expect((await callModel(api, 'm', { ...ask, schema })).parsed_output).toEqual(value)
    }
  })

  it('an outage or rate limit means try later, and a bad request does not', async () => {
    for (const status of [401, 404, 429, 500, 529]) {
      const { api } = stub({ status, body: { type: 'error', error: { type: 'x', message: 'no' } } })
      await expect(callModel(api, 'm', { ...ask, schema: emailSchema })).rejects.toBeInstanceOf(AiPaused)
    }
    const { api } = stub({ status: 400, body: { type: 'error', error: { type: 'x', message: 'no' } } })
    await expect(callModel(api, 'm', { ...ask, schema: emailSchema })).rejects.toBeInstanceOf(AiFailed)
  })
})

describe('provider adapters, against stub responses', () => {
  afterEach(() => vi.unstubAllGlobals())
  const campaign = { targetRole: 'Owner', keywords: 'dental', targetGeography: 'Portugal, Spain' } as never

  it('People Data Labs: builds the query, maps records, and skips those with no email', async () => {
    const seen: URL[] = []
    vi.stubGlobal('fetch', async (url: URL) => {
      seen.push(url)
      return Response.json({ status: 200, data: [
        { work_email: 'a@b.test', first_name: 'Ana', last_name: 'S', job_title: 'Owner', job_company_name: 'B', job_company_website: 'b.test', location_country: 'portugal' },
        { work_email: null, first_name: 'No' },
      ] })
    })
    const { leads, costMicros } = await peopleDataLabs.search(campaign, 500)
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ email: 'a@b.test', firstName: 'Ana', companyName: 'B' })
    expect(costMicros).toBeGreaterThan(0)
    expect(seen[0].searchParams.get('size')).toBe('100')
    expect(seen[0].searchParams.get('query')).toContain('"portugal","spain"')
  })

  it('People Data Labs: nothing found is not an error, a failure is', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    expect((await peopleDataLabs.search(campaign, 5)).leads).toEqual([])
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 402 }))
    await expect(peopleDataLabs.search(campaign, 5)).rejects.toThrow('402')
  })

  it('ZeroBounce: maps results, and unknown is never valid', async () => {
    for (const [status, want] of [['valid', 'valid'], ['invalid', 'invalid'], ['spamtrap', 'invalid'], ['do_not_mail', 'invalid'], ['catch-all', 'risky'], ['unknown', 'risky']]) {
      vi.stubGlobal('fetch', async () => Response.json({ status }))
      expect((await zeroBounce.check('a@b.test')).status).toBe(want)
    }
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Invalid API key' }))
    await expect(zeroBounce.check('a@b.test')).rejects.toThrow()
  })
})

describe('OpenAI-style provider', () => {
  const o = { system: 's', prompt: 'p', schema: z.object({ subject: z.string() }) }
  const reply = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
  const answer = (content: string, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
  afterEach(() => void vi.unstubAllGlobals())

  it('can describe every real schema to the provider', () => {
    for (const schema of [analysisSchema, draftSchema, emailSchema, replySchema, scoreSchema]) expect(z.toJSONSchema(schema, { unrepresentable: 'any' }).type).toBe('object')
  })
  it('returns the checked answer and its usage', async () => {
    reply(200, answer('{"subject":"Hi"}'))
    await expect(callOpenAi('m', o)).resolves.toEqual({ parsed: { subject: 'Hi' }, usage: { prompt_tokens: 3, completion_tokens: 2 } })
  })
  it('waits on limits, outages and bad keys', async () => {
    for (const status of [401, 429, 500]) {
      reply(status, {})
      await expect(callOpenAi('m', o)).rejects.toBeInstanceOf(AiPaused)
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await expect(callOpenAi('m', o)).rejects.toBeInstanceOf(AiPaused)
  })
  it('gives up on answers that will not improve', async () => {
    reply(400, {})
    await expect(callOpenAi('m', o)).rejects.toBeInstanceOf(AiFailed)
    reply(200, answer('{"subject":1}'))
    await expect(callOpenAi('m', o)).rejects.toBeInstanceOf(AiFailed)
    reply(200, answer('{"sub', 'length'))
    await expect(callOpenAi('m', o)).rejects.toBeInstanceOf(AiFailed)
  })
})
