import { notFound } from 'next/navigation'
import { ApiButton, ApiForm, CopyBlock } from '@/components/client'
import { Field, inputClass, PageHeader } from '@/components/ui'
import { isDesktop } from '@/server/auth'
import { publicSettings, type SECRET_KEYS } from '@/server/settings'

type SecretKey = (typeof SECRET_KEYS)[number]

export default function SettingsPage() {
  if (!isDesktop()) notFound()
  const { plain, secrets } = publicSettings()
  const secret = (name: SecretKey, label: string, help?: string) => (
    <div className="space-y-1">
      <Field label={label} name={name} type="password" autoComplete="off" help={help} placeholder={secrets[name] ? 'Saved. Type to replace it.' : undefined} />
    </div>
  )
  const saved = (Object.keys(secrets) as SecretKey[]).filter((k) => secrets[k])
  return (
    <>
      <PageHeader title="Settings" sub="Everything here stays on this computer. Saving restarts the app's services for a moment." />
      <div className="max-w-lg">
        <ApiForm url="/api/settings" method="PATCH" submit="Save settings">
          <h2 className="text-lg">AI</h2>
          <p className="text-muted">Use your own AI agent, or an API key. Without either you can still import a list, write your own email, send and read replies.</p>
          <div>
            <label htmlFor="AI_AGENT" className="mb-1 block text-xs font-semibold">Who writes the emails</label>
            <select id="AI_AGENT" name="AI_AGENT" defaultValue={plain.AI_AGENT} className={inputClass}>
              <option value="1">My own AI agent, such as Claude Code, Codex or Cursor</option>
              <option value="">An API key below, working on its own</option>
            </select>
          </div>
          {secret('ANTHROPIC_API_KEY', 'Anthropic API key')}
          {secret('OPENAI_API_KEY', 'OpenAI API key', 'Needs a model name below.')}
          <Field label="Local or other server address" name="OPENAI_BASE_URL" defaultValue={plain.OPENAI_BASE_URL} help="For Ollama, use http://localhost:11434/v1. It costs nothing per email." />
          <Field label="Model name" name="AI_MODEL" defaultValue={plain.AI_MODEL} help="Required for OpenAI and local models." />
          <Field label="Input price per million tokens, in dollars" name="AI_INPUT_USD_PER_MTOK" inputMode="decimal" defaultValue={plain.AI_INPUT_USD_PER_MTOK} help="Used for your budget. Enter 0 for a local model." />
          <Field label="Output price per million tokens, in dollars" name="AI_OUTPUT_USD_PER_MTOK" inputMode="decimal" defaultValue={plain.AI_OUTPUT_USD_PER_MTOK} />
          <h2 className="pt-4 text-lg">Finding and checking leads</h2>
          <p className="text-muted">Optional. CSV import works without these.</p>
          {secret('LEAD_API_KEY', 'People Data Labs API key')}
          {secret('EMAIL_VERIFIER_KEY', 'ZeroBounce API key')}
          <h2 className="pt-4 text-lg">Your business</h2>
          <Field label="Legal name" name="LEGAL_NAME" defaultValue={plain.LEGAL_NAME} />
          <Field label="Contact email" name="LEGAL_EMAIL" type="email" defaultValue={plain.LEGAL_EMAIL} />
        </ApiForm>
        {process.env.MCP_TOKEN && <AgentConnect url={`${process.env.APP_URL}/api/mcp`} token={process.env.MCP_TOKEN} />}
        {saved.length > 0 && (
          <div className="mt-6">
            <ApiButton url="/api/settings" method="PATCH" body={{ remove: saved }} size="sm" variant="ghost" confirm="Remove all saved keys from this computer?" confirmLabel="Remove keys">
              Remove saved keys
            </ApiButton>
          </div>
        )}
      </div>
    </>
  )
}

function AgentConnect({ url, token }: { url: string; token: string }) {
  return (
    <section aria-labelledby="agent" className="sheet mt-8 space-y-4 p-5">
      <h2 id="agent" className="text-lg">Connect your AI agent</h2>
      <p className="text-muted">
        Your agent reads your projects, writes the emails and sorts replies. It cannot send anything: Readfirst sends only what you approved. Keep Readfirst open while the agent works. The token is a password; do not share it.
      </p>
      <CopyBlock label="Claude Code" text={`claude mcp add --transport http readfirst ${url} --header "Authorization: Bearer ${token}"`} />
      <CopyBlock label="Codex" text={`export READFIRST_TOKEN=${token}\ncodex mcp add readfirst --url ${url} --bearer-token-env-var READFIRST_TOKEN`} />
      <CopyBlock label="Cursor and other agents (mcp.json)" text={JSON.stringify({ mcpServers: { readfirst: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)} />
      <p className="text-muted">Then ask your agent: “Do my Readfirst work.”</p>
    </section>
  )
}
