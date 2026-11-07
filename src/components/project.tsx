import { TabLinks } from './ui'

export function ProjectTabs({ id, active }: { id: string; active: string }) {
  const base = `/projects/${id}`
  return (
    <TabLinks
      active={active}
      tabs={[
        { id: 'campaigns', label: 'Campaigns', href: base },
        { id: 'inbox', label: 'Inbox', href: `${base}/inbox` },
        { id: 'mailboxes', label: 'Mailboxes', href: `${base}/mailboxes` },
        { id: 'settings', label: 'Settings', href: `${base}/settings` },
      ]}
    />
  )
}
