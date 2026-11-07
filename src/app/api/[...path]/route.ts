import { z } from 'zod'
import { generatePreview, translateMessage } from '@/server/agent'
import { AiFailed, AiPaused } from '@/server/ai'
import * as an from '@/server/analytics'
import * as c from '@/server/campaigns'
import { ApiError, api } from '@/server/http'
import * as im from '@/server/imports'
import * as ib from '@/server/inbox'
import * as pv from '@/server/privacy'
import * as p from '@/server/projects'
import { enqueueImport } from '@/server/queue'
import * as st from '@/server/settings'
import * as s from '@/server/suppression'
import type { SessionUser } from '@/server/auth'

type Ctx = SessionUser & { req: Request; args: Record<string, string>; query: URLSearchParams }
type Route = [method: string, path: string, fn: (x: Ctx) => Promise<unknown>, owner?: true]

const json = async <T,>(x: Ctx, schema: z.ZodType<T>): Promise<T> => schema.parse(await x.req.json().catch(() => ({})))
const page = (x: Ctx) => Number(x.query.get('page') ?? 0) || 0
const projectId = (x: Ctx) => z.uuid().parse(x.query.get('project_id'))

const period = (x: Ctx) => {
  const raw = x.query.get('period') ?? '30'
  return raw === 'all' ? null : Number(raw) || 30
}

const ROUTES: Route[] = [
  ['PATCH', 'settings', async (x) => st.saveSettings(await json(x, st.settingsUpdate)), true],
  ['DELETE', 'account', (x) => p.deleteAccount(x.orgId, x.userId), true],
  ['GET', 'projects', (x) => p.listProjects(x.orgId)],
  ['POST', 'projects', async (x) => p.createProject(x.orgId, await json(x, p.projectCreate))],
  ['GET', 'projects/:id', (x) => p.getProject(x.orgId, x.args.id)],
  ['PATCH', 'projects/:id', async (x) => p.updateProject(x.orgId, x.args.id, await json(x, p.projectUpdate)), true],
  ['GET', 'projects/:id/analytics', (x) => an.projectAnalytics(x.orgId, x.args.id, period(x))],
  ['GET', 'projects/:id/spend', (x) => an.spendByDay(x.orgId, x.args.id)],
  ['GET', 'projects/:id/statuses', (x) => p.listStatuses(x.orgId, x.args.id)],
  ['POST', 'projects/:id/statuses', async (x) => p.createStatus(x.orgId, x.args.id, (await json(x, p.statusCreate)).name), true],
  ['DELETE', 'statuses/:id', (x) => p.deleteStatus(x.orgId, x.args.id), true],
  ['GET', 'projects/:id/first-email', (x) => c.getProjectEmail(x.orgId, x.args.id)],
  ['PATCH', 'projects/:id/first-email', async (x) => c.saveProjectEmail(x.orgId, x.args.id, await json(x, c.firstEmailUpdate))],
  ['POST', 'projects/:id/analyse', (x) => p.reanalyse(x.orgId, x.args.id)],
  ['GET', 'projects/:id/inbox', (x) => ib.listConversations(x.orgId, x.args.id, (x.query.get('tab') ?? 'need_reply') as ib.InboxTab, page(x))],

  ['GET', 'mailboxes', (x) => p.listMailboxes(x.orgId, projectId(x))],
  ['POST', 'mailboxes', async (x) => p.createMailbox(x.orgId, await json(x, p.mailboxCreate)), true],
  ['PATCH', 'mailboxes/:id', async (x) => p.updateMailbox(x.orgId, x.args.id, await json(x, p.mailboxUpdate)), true],
  ['DELETE', 'mailboxes/:id', (x) => p.deleteMailbox(x.orgId, x.args.id), true],
  ['POST', 'mailboxes/:id/test', (x) => p.testMailbox(x.orgId, x.args.id), true],
  ['POST', 'mailboxes/:id/check-dns', (x) => p.checkMailboxDns(x.orgId, x.args.id), true],

  ['GET', 'campaigns', (x) => c.listCampaigns(x.orgId, projectId(x))],
  ['POST', 'campaigns', async (x) => c.createCampaign(x.orgId, await json(x, c.campaignCreate))],
  ['GET', 'campaigns/:id', (x) => c.getCampaign(x.orgId, x.args.id)],
  ['PATCH', 'campaigns/:id', async (x) => c.updateCampaign(x.orgId, x.args.id, await json(x, c.campaignUpdate))],
  ['POST', 'campaigns/:id/start', (x) => c.startCampaign(x.orgId, x.userId, x.args.id)],
  ['POST', 'campaigns/:id/approve', (x) => c.approveCampaign(x.orgId, x.userId, x.args.id)],
  ['POST', 'campaigns/:id/stop', (x) => c.stopCampaign(x.orgId, x.userId, x.args.id)],
  ['POST', 'campaigns/:id/archive', (x) => c.archiveCampaign(x.orgId, x.userId, x.args.id)],
  ['GET', 'campaigns/:id/analytics', (x) => an.campaignAnalytics(x.orgId, x.args.id, x.query.has('period') ? period(x) : null)],
  [
    'GET',
    'campaigns/:id/export',
    async (x) =>
      new Response(await an.contactedCsv(x.orgId, x.args.id), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="contacted-leads.csv"' },
      }),
  ],
  ['GET', 'campaigns/:id/status', (x) => c.sendState(x.orgId, x.args.id)],
  ['GET', 'campaigns/:id/leads', (x) => c.campaignLeads(x.orgId, x.args.id, x.query.get('stage') ?? undefined, page(x))],
  [
    'PATCH',
    'campaigns/:id/leads/:leadId',
    async (x) => {
      const { stage } = await json(x, z.strictObject({ stage: z.enum(['review', 'excluded']) }))
      return c.setLeadReview(x.orgId, x.args.id, x.args.leadId, stage)
    },
  ],
  ['GET', 'campaigns/:id/first-email', (x) => c.getFirstEmail(x.orgId, x.args.id)],
  ['PATCH', 'campaigns/:id/first-email', async (x) => c.saveFirstEmail(x.orgId, x.args.id, await json(x, c.firstEmailUpdate))],
  ['GET', 'campaigns/:id/preview', (x) => c.previewEmails(x.orgId, x.args.id)],
  [
    'POST',
    'campaigns/:id/preview',
    async (x) => {
      const campaign = await c.getCampaign(x.orgId, x.args.id)
      try {
        return await generatePreview(x.orgId, campaign)
      } catch (err) {
        if (err instanceof AiPaused) throw new ApiError(409, 'ai_paused', err.message === 'no_key' ? 'Add an AI key in Settings first.' : err.message === 'agent' ? 'Your AI agent writes these. Ask it to write your Readfirst previews.' : 'The budget is used up, so the AI is paused.')
        if (err instanceof AiFailed) throw new ApiError(422, 'ai_failed', err.message)
        throw err
      }
    },
  ],

  [
    'POST',
    'imports',
    async (x) => {
      const form = await x.req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw new ApiError(422, 'no_file', 'Choose a CSV file.')
      if (file.size > im.MAX_BYTES) throw new ApiError(422, 'too_large', 'This file is over 10 MB.')
      const name = z.string().trim().min(1).max(160).parse(form.get('name'))
      const result = await im.createImport(x.orgId, z.uuid().parse(form.get('project_id')), name, im.decodeCsv(new Uint8Array(await file.arrayBuffer())))
      await enqueueImport(result.id)
      return result
    },
  ],
  ['GET', 'imports/:id', (x) => im.getImport(x.orgId, x.args.id)],
  ['GET', 'imports/:id/rows', (x) => im.importRows(x.orgId, x.args.id, page(x))],

  ['GET', 'leads/:id/thread', (x) => ib.getThread(x.orgId, x.args.id)],
  ['POST', 'leads/:id/reply', async (x) => ib.replyToLead(x.orgId, x.args.id, (await json(x, ib.replyBody)).body)],
  ['PATCH', 'leads/:id', async (x) => ib.updateLead(x.orgId, x.userId, x.args.id, await json(x, ib.leadUpdate))],
  ['POST', 'leads/:id/mark-replied', (x) => ib.markReplied(x.orgId, x.args.id)],
  [
    'POST',
    'messages/:id/translate',
    async (x) => {
      try {
        const done = await translateMessage(x.orgId, x.args.id)
        if (!done) throw new ApiError(404, 'not_found', 'Message not found.')
        return done
      } catch (err) {
        if (err instanceof AiPaused) throw new ApiError(409, 'ai_paused', 'The AI is paused. Check your key and budget.')
        if (err instanceof AiFailed) throw new ApiError(422, 'ai_failed', err.message)
        throw err
      }
    },
  ],
  ['POST', 'messages/:id/send-now', (x) => ib.sendAutoReplyNow(x.orgId, x.args.id)],
  ['POST', 'messages/:id/cancel', (x) => ib.cancelAutoReply(x.orgId, x.args.id)],

  [
    'GET',
    'contacts',
    async (x) => {
      const contact = await pv.findContact(x.orgId, z.string().trim().min(3).parse(x.query.get('email')))
      if (!contact) throw new ApiError(404, 'not_found', 'We hold nothing for this address.')
      return contact
    },
  ],
  ['GET', 'contacts/:id/export', (x) => pv.exportContact(x.orgId, x.args.id)],
  ['POST', 'contacts/:id/erase', (x) => pv.eraseContact(x.orgId, x.userId, x.args.id), true],

  ['GET', 'suppression', (x) => s.listSuppression(x.orgId)],
  ['POST', 'suppression', async (x) => s.createSuppression(x.orgId, await json(x, s.suppressionCreate))],
  ['GET', 'suppression/:id', (x) => s.getSuppression(x.orgId, x.args.id, page(x))],
  ['DELETE', 'suppression/:id', (x) => s.deleteSuppression(x.orgId, x.args.id), true],
]

function match(method: string, segments: string[]) {
  for (const route of ROUTES) {
    const parts = route[1].split('/')
    if (route[0] !== method || parts.length !== segments.length) continue
    const args: Record<string, string> = {}
    if (parts.every((part, i) => (part.startsWith(':') ? ((args[part.slice(1)] = segments[i]), true) : part === segments[i]))) {
      return { route, args }
    }
  }
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const handle = api<{ path: string[] }>(async (ctx) => {
  const found = match(ctx.req.method, ctx.params.path)
  if (!found) throw new ApiError(404, 'not_found', 'No such route.')
  if (Object.values(found.args).some((v) => !UUID.test(v))) throw new ApiError(404, 'not_found', 'Not found.')
  const { route, args } = found
  if (route[3] && ctx.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only an owner can do this.')
  return route[2]({ ...ctx, args, query: new URL(ctx.req.url).searchParams })
})

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE }
