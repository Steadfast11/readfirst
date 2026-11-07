import { ApiForm } from '@/components/client'
import { Field, inputClass, PageHeader } from '@/components/ui'

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <>
      <PageHeader title="Import leads" sub="Up to 30,000 rows. Needs email and first name columns. Company and job title are used if present." />
      <div className="max-w-lg">
        <ApiForm url="/api/imports" submit="Upload" multipart extra={{ project_id: id }} redirectTo={`/projects/${id}/imports/:id`}>
          <Field label="Campaign name" name="name" required maxLength={160} />
          <div>
            <label htmlFor="file" className="mb-1 block text-xs font-semibold">CSV file</label>
            <input id="file" name="file" type="file" accept=".csv,text/csv" required className={inputClass} />
          </div>
        </ApiForm>
      </div>
    </>
  )
}
