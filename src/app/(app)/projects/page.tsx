import Link from 'next/link'
import { ViewTransition } from 'react'
import { DeleteAccount, NewProject, SignOut } from '@/components/client'
import { PageHeader } from '@/components/ui'
import { currentUser } from '@/server/auth'
import { listProjects } from '@/server/projects'

export default async function ProjectsPage() {
  const user = (await currentUser())!
  const projects = await listProjects(user.orgId)
  return (
    <>
      <PageHeader title="Projects" sub="One project per business you reach out for." action={<NewProject />} />
      {projects.length === 0 ? (
        <section aria-label="How it works" className="sheet">
          <div className="p-5">
            <h2 className="wide text-xl">Add your business to get started.</h2>
            <p className="mt-2 max-w-[60ch] text-base">Readfirst writes to the people you choose, from your own mailbox. Nothing goes out until you have read it.</p>
          </div>
          <ol className="grid border-t border-text/8 tablet:grid-cols-3">
            {['Tell it what you sell', 'Add the people to write to', 'Read each email, then approve'].map((step, i) => (
              <li key={step} className="stub flex items-center gap-2 p-3 font-semibold">
                <span aria-hidden className="wide tabular-nums">{i + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <ul className="sheet divide-y divide-border">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="block p-4 text-base font-medium wrap-anywhere transition-colors duration-300 hover:bg-text/5">
                <ViewTransition name={`project-${p.id}`}><span className="inline-block">{p.domain ?? 'Project without a website'}</span></ViewTransition>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <span className="desktop:hidden"><SignOut /></span>
        {user.role === 'owner' && <DeleteAccount />}
      </div>
    </>
  )
}
