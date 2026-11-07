import Link from 'next/link'
import { ApiButton, AutoRefresh, NewCampaign } from '@/components/client'
import { ProjectTabs } from '@/components/project'
import { Banner, Empty, LinkButton, money, PageHeader, plural, SetupStrip, Stat, StatusLine } from '@/components/ui'
import type { Analysis } from '@/server/agent'
import { agentMode, aiConfigured, apiConfigured } from '@/server/ai'
import { projectAnalytics } from '@/server/analytics'
import { currentUser, isDesktop } from '@/server/auth'
import { listCampaigns, sendState } from '@/server/campaigns'
import { getProject, listMailboxes } from '@/server/projects'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { orgId } = (await currentUser())!
  const project = await getProject(orgId, id)
  const [campaigns, mailboxes] = await Promise.all([listCampaigns(orgId, id), listMailboxes(orgId, id)])
  const states = await Promise.all(campaigns.map((c) => sendState(orgId, c.campaign.id)))
  const analysis = project.analysis as Partial<Analysis> | null
  const numbers = await projectAnalytics(orgId, id)
  const base = `/projects/${id}`
  const first = campaigns[0]?.campaign.id
  const steps = [
    { label: 'Your details', done: Boolean(project.legalFooter.trim() && project.senderName.trim()), href: `${base}/settings`, action: 'Add your details', todo: 'Add your name and business address. Every email must show them, and the law in most countries requires it.' },
    { label: 'Your mailbox', done: mailboxes.some((m) => m.status === 'active'), href: `${base}/mailboxes`, action: 'Connect mailbox', todo: 'Connect a mailbox before you can send. Your emails go out from your own address.' },
    { label: 'Your people', done: campaigns.length > 0, href: `${base}/import`, action: 'Import leads', todo: 'Add the people you want to write to. A spreadsheet with an email and a first name is enough.' },
    { label: 'Read and approve', done: numbers.sent > 0, href: first ? `${base}/campaigns/${first}` : base, action: 'Read your emails', todo: 'Read your emails and approve them. Nothing is sent until you do.' },
  ]
  const settingUp = steps.some((s) => !s.done)
  return (
    <>
      <PageHeader
        morph={`project-${id}`}
        title={project.domain ?? 'Project'}
        action={
          <div className="flex flex-wrap gap-2">
            <NewCampaign projectId={id} />
            <LinkButton variant={settingUp ? 'secondary' : 'primary'} href={`/projects/${id}/import`}>Import leads</LinkButton>
          </div>
        }
      />
      <ProjectTabs id={id} active="campaigns" />
      <SetupStrip steps={steps} />
      {project.status === 'creating' && (
        <p role="status" className="mb-4 text-muted">
          <AutoRefresh />
          Reading about your business. This takes a minute or two, and you can carry on meanwhile.
        </p>
      )}
      <div className="mb-4 space-y-2">
        {project.status === 'failed' && (
          <Banner action={<ApiButton url={`/api/projects/${id}/analyse`} size="sm">Try again</ApiButton>}>
            {project.failureReason ?? 'We could not finish the analysis.'}
          </Banner>
        )}
        {agentMode() && !apiConfigured() && (
          <Banner>Your AI agent writes the emails and sorts replies here. Open it and ask: “Do my Readfirst work.”</Banner>
        )}
        {!aiConfigured() && (
          <Banner action={isDesktop() ? <LinkButton href="/settings" size="sm">Open Settings</LinkButton> : undefined}>
            AI is off, so you write the emails yourself. Add an AI key to have them drafted for you.
          </Banner>
        )}
      </div>
      {numbers.sent > 0 && (
        <section aria-label="Last 30 days" className="mb-6">
          <dl className="sheet grid grid-cols-2 gap-px bg-border tablet:grid-cols-5">
            <Stat label="Emails sent" value={numbers.sent} />
            <Stat label="People who replied" value={numbers.replies} />
            <Stat label="Hot leads" value={numbers.hot} />
            <Stat label="Spend" value={money(numbers.spendMicros)} />
            <Stat label="Cost per hot lead" value={money(numbers.costPerHotMicros)} />
          </dl>
          <p className="mt-1 text-xs text-muted">Last 30 days. AI, lead data and email checks. Mailbox fees are not included.</p>
        </section>
      )}
      {analysis?.summary && <AnalysisCard id={id} analysis={analysis} />}
      {campaigns.length === 0 ? (
        <Empty>Your campaigns will appear here.</Empty>
      ) : (
        <ul className="sheet divide-y divide-border">
          {campaigns.map((row, i) => (
            <li key={row.campaign.id} className="p-3">
              <Link href={`/projects/${id}/campaigns/${row.campaign.id}`} className="font-medium wrap-anywhere underline-offset-2 hover:underline">
                {row.campaign.name}
              </Link>
              <StatusLine tone={states[i].tone} message={states[i].message} />
              <p className="text-muted">
                {plural(row.leads, 'lead')} · {row.sent} sent · {row.replied} replied · {row.hot} hot
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function AnalysisCard({ id, analysis }: { id: string; analysis: Partial<Analysis> }) {
  return (
    <section aria-label="What we learned" className="sheet mb-6 p-4">
      <h2 className="mb-1 text-lg">What we learned</h2>
      <p className="wrap-anywhere">{analysis.summary}</p>
      {Boolean(analysis.competitors?.length) && <p className="mt-2 text-muted wrap-anywhere">Likely competitors: {analysis.competitors?.join(', ')}</p>}
      {Boolean(analysis.campaigns?.length) && (
        <ul className="mt-3 space-y-2">
          {analysis.campaigns?.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface p-3">
              <span className="min-w-0">
                <span className="block font-medium wrap-anywhere">{c.name}</span>
                <span className="block text-muted wrap-anywhere">{c.target_role} · {c.target_geography}</span>
              </span>
              <ApiButton url="/api/campaigns" body={{ project_id: id, ...c }} size="sm" redirectTo={`/projects/${id}/campaigns/:id?tab=targeting`}>Use this</ApiButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
