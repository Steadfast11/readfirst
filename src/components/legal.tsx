import type { ReactNode } from 'react'

export const operator = () => process.env.LEGAL_NAME || 'the person or company running this copy of Readfirst'
export const contact = () => process.env.LEGAL_EMAIL || 'the address shown in any email you received from us'

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="max-w-2xl space-y-4 py-8 text-base [&_h2]:pt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
      <h1 className="text-xl">{title}</h1>
      {children}
    </article>
  )
}
