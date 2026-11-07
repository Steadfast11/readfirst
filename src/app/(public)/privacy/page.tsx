import { contact, LegalPage, operator } from '@/components/legal'

export const metadata = { title: 'Privacy' }
export const dynamic = 'force-dynamic'

export default function Privacy() {
  return (
    <LegalPage title="Privacy policy">
      <p>This policy is run by {operator()}. Questions and requests go to {contact()}.</p>
      <h2>If you received an email from someone using this app</h2>
      <p>We hold your name, work email, job title and company, and the emails exchanged with you. They came from a list the sender uploaded, or from a licensed data provider.</p>
      <p>You can unsubscribe with the link in any email. You can also ask for a copy of your data or for it to be deleted. After deletion we keep only a one-way hash of your address, so you are never contacted again.</p>
      <h2>If you use this app</h2>
      <p>We hold your sign-in email, your projects, your lead lists and your mailbox settings. Mailbox passwords are encrypted. We use a session cookie to keep you signed in, and no advertising or tracking cookies.</p>
      <h2>Who processes this data</h2>
      <ul>
        <li>The AI provider set up for this service, for AI writing and reply classification</li>
        <li>The lead data provider and email checking service, if connected</li>
        <li>Your mail provider, which carries the emails</li>
        <li>The hosting provider that runs this app</li>
      </ul>
      <h2>How long we keep it</h2>
      <p>Until you delete it, or the account is deleted. Deleting an account removes its projects, leads and messages.</p>
      <h2>Your rights</h2>
      <p>Depending on where you live, you may have the right to access, correct or delete your data, to object to its use, and to complain to your data protection authority.</p>
    </LegalPage>
  )
}
