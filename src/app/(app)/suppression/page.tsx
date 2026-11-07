import { ApiButton, ApiForm } from '@/components/client'
import { buttonClass, Empty, Field, PageHeader, plural, TextArea } from '@/components/ui'
import { currentUser } from '@/server/auth'
import { findContact } from '@/server/privacy'
import { listSuppression } from '@/server/suppression'

export default async function SuppressionPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { orgId } = (await currentUser())!
  const lists = await listSuppression(orgId)
  const email = (await searchParams).email?.trim()
  const person = email ? await findContact(orgId, email) : null
  return (
    <>
      <PageHeader title="Do not contact" sub="Checked right before every email, in every project." />
      {lists.length === 0 ? (
        <Empty>Add people or companies you never want to contact.</Empty>
      ) : (
        <ul className="sheet divide-y divide-border">
          {lists.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <span className="font-medium wrap-anywhere">{l.name}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted">{plural(l.total, 'entry', 'entries')}</span>
                {l.name !== 'Unsubscribed' && (
                  <ApiButton
                    url={`/api/suppression/${l.id}`}
                    method="DELETE"
                    size="sm"
                    variant="ghost"
                    confirm={`Delete ${l.name}? These ${plural(l.total, 'entry', 'entries')} could be contacted again.`}
                    confirmLabel="Delete list"
                  >
                    Delete
                  </ApiButton>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-8 mb-3 text-lg">Data requests</h2>
      <p className="mb-3 max-w-lg text-muted">When someone asks what you hold about them, or asks you to delete it, find them by email.</p>
      <form className="mb-3 flex max-w-lg items-end gap-2">
        <div className="min-w-0 flex-1"><Field label="Find a person" name="email" type="email" defaultValue={email} required /></div>
        <button type="submit" className={buttonClass('secondary')}>Find</button>
      </form>
      {email && !person && <p role="status" className="text-muted">We hold nothing for this address.</p>}
      {person && (
        <div className="flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-md bg-surface p-3">
          <span className="min-w-0 wrap-anywhere">{person.firstName} {person.lastName}, {person.companyName}</span>
          <span className="flex gap-2">
            <a href={`/api/contacts/${person.id}/export`} download="person.json" className={buttonClass('secondary', 'sm')}>Download data</a>
            <ApiButton
              url={`/api/contacts/${person.id}/erase`}
              size="sm"
              variant="danger"
              confirm="Erase this person and every email to or from them? This cannot be undone. A hash stays so they are never contacted again."
              confirmLabel="Erase person"
            >
              Erase
            </ApiButton>
          </span>
        </div>
      )}
      <h2 className="mt-8 mb-3 text-lg">Add a list</h2>
      <div className="max-w-lg">
        <ApiForm url="/api/suppression" submit="Add list" reset>
          <Field label="List name" name="name" required maxLength={120} />
          <TextArea label="Emails or domains" name="entries" mono required help="One per line. A domain blocks everyone at that company." />
        </ApiForm>
      </div>
    </>
  )
}
