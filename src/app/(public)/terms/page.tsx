import { contact, LegalPage, operator } from '@/components/legal'

export const metadata = { title: 'Terms' }
export const dynamic = 'force-dynamic'

export default function Terms() {
  return (
    <LegalPage title="Terms of use">
      <p>These terms cover your use of this app, run by {operator()}. Contact: {contact()}.</p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>You send email in your own name and are responsible for it, including anything the AI wrote that you approved.</li>
        <li>You must have a lawful reason to contact each person, and follow the laws of your country and theirs.</li>
        <li>You must honour opt-outs. You must not send spam, or use the app to deceive or harass anyone.</li>
        <li>You must follow the terms of your mail provider and any data provider you connect.</li>
      </ul>
      <h2>Costs</h2>
      <p>You pay your AI, data and mail providers directly. Budget limits are a tool and depend on those providers reporting usage. A request already in progress may finish after a limit is reached.</p>
      <h2>No promises about results</h2>
      <p>We do not promise replies, leads or sales. AI output can be wrong, so read it before you approve it.</p>
      <h2>The service</h2>
      <p>The app is provided as it is. To the extent the law allows, we are not liable for indirect losses or for damage to your sender reputation.</p>
      <h2>Ending your use</h2>
      <p>You can delete your account at any time from the Projects page. We may suspend an account that breaks these terms.</p>
    </LegalPage>
  )
}
