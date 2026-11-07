import { ImportProgress } from '@/components/client'
import { Banner, LinkButton, PageHeader, plural } from '@/components/ui'
import { currentUser } from '@/server/auth'
import { getImport } from '@/server/imports'
import { orNotFound } from '@/server/pages'

/** Work normally starts within seconds, so this long with no stage means the worker is not picking it up. */
const STALLED_MS = 2 * 60_000

const REASON: Record<string, string> = {
  missing_fields: 'Missing email or first name',
  invalid_email: 'Invalid email address',
  duplicate_in_file: 'Duplicate in this file',
  already_contacted: 'Already contacted',
  suppressed: 'On a do-not-contact list',
}

export default async function ImportResultPage({ params }: { params: Promise<{ id: string; importId: string }> }) {
  const { id, importId } = await params
  const { orgId } = (await currentUser())!
  const job = await orNotFound(getImport(orgId, importId))
  const imported = job.totals.find((r) => r.outcome === 'imported')?.n ?? 0
  const skipped = job.totals.filter((r) => r.outcome === 'skipped')
  const waiting = job.stage === null && Date.now() - new Date(job.createdAt).getTime() > STALLED_MS
  return (
    <>
      <PageHeader title={job.name} sub={`${plural(job.total, 'row')} in the file`} />
      <ImportProgress url={`/api/imports/${importId}`} done={job.status !== 'pending'} />
      {job.status === 'pending' && (
        <p role="status">
          {waiting
            ? 'This is taking longer than usual. Your list is saved and nothing has been sent. It will finish once the background service is running.'
            : 'Checking your list…'}
        </p>
      )}
      {job.status === 'failed' && <Banner tone="danger">{job.error}</Banner>}
      {job.status === 'completed' && (
        <div className="space-y-4">
          <p className="font-medium">{plural(imported, 'lead')} ready for review</p>
          {skipped.length > 0 && (
            <ul className="sheet divide-y divide-border">
              {skipped.map((r) => (
                <li key={r.reason} className="flex justify-between gap-3 p-3">
                  <span>{REASON[r.reason ?? ''] ?? 'Skipped'}</span>
                  <span className="text-muted">{r.n}</span>
                </li>
              ))}
            </ul>
          )}
          {job.campaignId ? (
            <LinkButton variant="primary" href={`/projects/${id}/campaigns/${job.campaignId}`}>Review leads</LinkButton>
          ) : (
            <p>No one in this file could be imported, so no campaign was created.</p>
          )}
        </div>
      )}
    </>
  )
}
