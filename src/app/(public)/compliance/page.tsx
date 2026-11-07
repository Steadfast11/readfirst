import { LegalPage } from '@/components/legal'

export const metadata = { title: 'Compliance' }

export default function Compliance() {
  return (
    <LegalPage title="Compliance">
      <p>Cold email is regulated differently from country to country. This page explains what the app does. It is not legal advice.</p>
      <h2>What the app does</h2>
      <ul>
        <li>It will not send until you add a business address and confirm a lawful reason to contact people.</li>
        <li>Every campaign email carries your address and an unsubscribe link, and supports one-click unsubscribe.</li>
        <li>Your do-not-contact lists are checked right before every email.</li>
        <li>A person can get a copy of their data or have it erased. Erased people stay blocked through a one-way hash.</li>
        <li>Nothing goes out without a person approving the list.</li>
      </ul>
      <h2>What stays with you</h2>
      <ul>
        <li>Whether cold email is allowed for your audience. Some countries require consent, even between businesses.</li>
        <li>Your legal basis under GDPR, if you contact people in the EU or UK.</li>
        <li>Telling people where you got their data, where the law requires it.</li>
      </ul>
    </LegalPage>
  )
}
