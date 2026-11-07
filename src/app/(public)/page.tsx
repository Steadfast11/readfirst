import Image from 'next/image'
import { LinkButton } from '@/components/ui'
import product from '../../../public/product.png'

const STEPS = [
  ['Tell it what you sell', 'Give it your website, or describe your business in three lines. It suggests who to reach.'],
  ['Read what it wrote', 'It builds a lead list and writes sample emails. You change anything you like.'],
  ['Approve, then talk to people', 'Nothing goes out before you approve. Replies land in one inbox, sorted by who is interested.'],
]

const FEATURES = [
  ['Nothing sends on a timer', 'There is no countdown. A list waits for your click, however long you take.'],
  ['Spending you can predict', 'Set a daily limit and a monthly cap. The app shows the most you can spend, and stops there.'],
  ['The AI sticks to your facts', 'You list what it may say about you. Emails with placeholders or links are held back.'],
  ['Your mailboxes, your name', 'Mail goes from mailboxes you own, with your sender name. Use a separate domain to protect your main one.'],
  ['Replies sorted, with the reason', 'Each reply shows why it was marked interested and how sure the AI is, so a wrong call is easy to spot.'],
  ['A straight answer when it is not working', 'After 100 emails with no reply, it tells you that more volume will not help.'],
]

const FAQ = [
  ['Who pays for the AI and the lead data?', 'You do, directly, with your own Anthropic and data provider keys. The app tracks that spending and stops at your limits.'],
  ['Will it use my main domain?', 'Only if you connect it. We suggest a separate sending domain, so one bad campaign cannot hurt your main address.'],
  ['Can it reply for me?', 'Only if you turn that on. It waits first, so you can cancel, it will not state prices, and the only link it may send is your booking link.'],
  ['Can I use my own lead list?', 'Yes. Import a CSV. It removes duplicates, people you have already emailed, and anyone on your do-not-contact list.'],
  ['Is cold email legal?', 'It depends on where you and your leads are, and some countries require consent. The app adds your address and an unsubscribe link, but the legal duty stays with you.'],
]

export default function Home() {
  return (
    <>
      <section className="py-12 text-center tablet:py-20">
        <h1 className="mx-auto max-w-3xl text-xl tablet:text-display">Cold email that waits for your OK.</h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted">
          An AI writes your outreach and sorts your replies. Nothing sends until you have read it, and it never spends past your limit.
        </p>
        <div className="mt-6"><LinkButton href="/login" variant="primary">Get started</LinkButton></div>
      </section>
      <Image src={product} alt="A campaign screen with four leads waiting for approval" className="w-full rounded-lg border border-border" priority />
      <section className="mt-16 max-w-2xl">
        <h2 className="text-xl">Most tools move faster than you do</h2>
        <p className="mt-3 text-base text-muted">
          An outreach tool writes in your name and spends your money. Too often it starts on a timer, and the first sign of a problem is a reply from an annoyed stranger or a charge you did not expect. Readfirst puts you back in the loop.
        </p>
      </section>
      <section className="mt-16">
        <h2 className="text-xl">How it works</h2>
        <ol className="mt-6 grid gap-6 tablet:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <p className="text-muted">Step {i + 1}</p>
              <h3 className="mt-1 text-lg font-semibold">{title}</h3>
              <p className="mt-1 text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="mt-16">
        <h2 className="text-xl">Built around control</h2>
        <ul className="mt-6 grid gap-6 tablet:grid-cols-2 desktop:grid-cols-3">
          {FEATURES.map(([title, text]) => (
            <li key={title}>
              <h3 className="text-base font-semibold">{title}</h3>
              <p className="mt-1 text-muted">{text}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-16 rounded-lg bg-surface p-6">
        <h2 className="text-xl">Pricing</h2>
        <p className="mt-2 text-base">Free to run yourself. You pay only your own AI, lead data and mailbox costs.</p>
      </section>
      <section className="mt-16 max-w-2xl">
        <h2 className="text-xl">Questions</h2>
        <dl className="mt-6 space-y-5">
          {FAQ.map(([q, a]) => (
            <div key={q}>
              <dt className="text-base font-semibold">{q}</dt>
              <dd className="mt-1 text-muted">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="mt-16 text-center">
        <h2 className="text-xl">Read it first. Then send it.</h2>
        <div className="mt-4"><LinkButton href="/login" variant="primary">Get started</LinkButton></div>
      </section>
    </>
  )
}
