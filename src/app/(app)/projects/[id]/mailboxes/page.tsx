import { ApiButton, ApiForm, MailServerFields } from '@/components/client'
import { ProjectTabs } from '@/components/project'
import { Badge, Empty, Field, PageHeader } from '@/components/ui'
import { currentUser } from '@/server/auth'
import { getProject, listMailboxes } from '@/server/projects'

const TONE = { active: 'success', paused: 'warning', failing: 'danger', unverified: 'neutral' } as const
const LABEL = { active: 'Active', paused: 'Paused', failing: 'Failing', unverified: 'Not tested' } as const

const check = (name: string, ok: boolean | null) => `${name} ${ok === null ? 'not checked' : ok ? 'passed' : 'missing'}`

export default async function MailboxesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { orgId } = (await currentUser())!
  const project = await getProject(orgId, id)
  const boxes = await listMailboxes(orgId, id)
  return (
    <>
      <PageHeader morph={`project-${id}`} title={project.domain ?? 'Project'} />
      <ProjectTabs id={id} active="mailboxes" />
      {boxes.length === 0 ? (
        <Empty>Connect a mailbox before you can send.</Empty>
      ) : (
        <ul className="sheet divide-y divide-border">
          {boxes.map((box) => (
            <li key={box.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium wrap-anywhere">{box.email}</span>
                <Badge tone={TONE[box.status as keyof typeof TONE]}>{LABEL[box.status as keyof typeof LABEL]}</Badge>
                <span className="text-muted">Up to {box.dailyLimit} a day</span>
              </div>
              {box.statusReason && <p className="text-danger">{box.statusReason}</p>}
              <p className="text-muted">
                {check('SPF', box.spfOk)} · {check('DKIM', box.dkimOk)} · {check('DMARC', box.dmarcOk)}
              </p>
              <div className="flex flex-wrap gap-2">
                <ApiButton url={`/api/mailboxes/${box.id}/test`} size="sm">Test connection</ApiButton>
                <ApiButton url={`/api/mailboxes/${box.id}/check-dns`} size="sm">Check DNS</ApiButton>
                {box.status === 'active' && <ApiButton url={`/api/mailboxes/${box.id}`} method="PATCH" body={{ paused: true }} size="sm">Pause</ApiButton>}
                <ApiButton
                  url={`/api/mailboxes/${box.id}`}
                  method="DELETE"
                  size="sm"
                  variant="ghost"
                  confirm={`Remove ${box.email}? Past conversations stay in your inbox.`}
                  confirmLabel="Remove mailbox"
                >
                  Remove
                </ApiButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-8 mb-3 text-lg">Connect a mailbox</h2>
      <p className="mb-4 max-w-lg text-muted">Use a separate sending domain, and an app password rather than your main password. Start low, at 5 to 10 emails a day.</p>
      <div className="max-w-lg">
        <ApiForm url="/api/mailboxes" submit="Connect mailbox" extra={{ project_id: id }} reset>
          <Field label="Email address" name="email" type="email" required />
          <Field label="Display name" name="display_name" />
          <MailServerFields />
          <Field label="Username" name="username" required autoComplete="off" />
          <Field label="App password" name="password" type="password" required autoComplete="new-password" />
          <Field label="Daily limit" name="daily_limit" inputMode="numeric" defaultValue={10} required />
        </ApiForm>
      </div>
    </>
  )
}
