import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addResource,
  createField,
  generatePlan,
  getField,
  listFields,
  patchResource,
  patchTopic,
  savePlan,
} from './api'
import { collapseAndRemove } from './motion'
import { Panel, usePanelState } from './Panel'
import type { FieldDetail, FieldSummary, ProposedTopic, Resource, Topic } from './types'
import { Quip } from './Quip'

export function Learning({ route, open }: { route: string; open: boolean }) {
  const { mounted, closing } = usePanelState(open)
  if (!mounted) return null
  const sub = route.replace(/^#\/learning\/?/, '')
  return (
    <Panel closing={closing}>
      {sub === 'new' ? <NewField /> : sub ? <FieldPage id={sub} /> : <FieldList />}
    </Panel>
  )
}

function FieldList() {
  const [fields, setFields] = useState<FieldSummary[]>([])

  useEffect(() => {
    listFields()
      .then(setFields)
      .catch(() => {})
  }, [])

  return (
    <>
      <header>
        <h1 className="brand">
          learning
          <Quip domain="learning" />
        </h1>
        <a className="guide-link" href="#/">
          back
        </a>
      </header>

      <main className="list">
        {fields.map((f) => (
          <a key={f.id} className="row music-row field-row" href={`#/learning/${f.id}`}>
            <span className="row-main">{f.name}</span>
            <span className="field-progress">
              {f.units_total > 0 && `${f.units_done}/${f.units_total} units`}
              {f.topics_total > 0 && ` · ${f.topics_done}/${f.topics_total} topics`}
              {f.problems_theory + f.problems_implementation > 0 &&
                ` · ${f.problems_theory + f.problems_implementation} problems`}
              {f.streak > 0 && ` · ${f.streak}d streak`}
            </span>
          </a>
        ))}
        {fields.length === 0 && <div className="empty">no fields yet</div>}
      </main>

      <a className="action save new-field" href="#/learning/new">
        new field
      </a>
    </>
  )
}

function NewField() {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [timeline, setTimeline] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const field = await createField({
        name: name.trim(),
        goal_text: goal.trim() || undefined,
        timeline_text: timeline.trim() || undefined,
      })
      window.location.hash = `#/learning/${field.id}`
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
      setBusy(false)
    }
  }

  return (
    <>
      <header>
        <h1 className="brand">new field</h1>
        <a className="guide-link" href="#/learning">
          back
        </a>
      </header>

      <div className="editor setup">
        <label>
          <span>name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="RL" autoFocus />
        </label>
        <label>
          <span>goal</span>
          <textarea
            rows={2}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="implement deep RL algorithms from scratch"
          />
        </label>
        <label>
          <span>timeline</span>
          <input value={timeline} onChange={(e) => setTimeline(e.target.value)} placeholder="3 months" />
        </label>
        <div className="editor-footer">
          <span className="editor-meta">{error || 'resources and plan come next'}</span>
          <button className="action save" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? 'creating' : 'create'}
          </button>
        </div>
      </div>
    </>
  )
}

function FieldPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<FieldDetail | null>(null)
  const [notice, setNotice] = useState('')
  const [plan, setPlan] = useState<ProposedTopic[] | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [manualTitle, setManualTitle] = useState('')
  const [manualTotal, setManualTotal] = useState('')
  const dragIndex = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      setDetail(await getField(id))
    } catch {
      // field may have been removed
    }
  }, [id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Same fade-and-collapse the timeline's notice gets, so what sits under it
  // rises to meet it rather than jumping a line. The counter guards against a
  // second message landing mid-fade and being cleared by the first one's exit.
  const noticeRef = useRef<HTMLDivElement>(null)
  const noticeSeq = useRef(0)
  const flash = (message: string) => {
    const seq = ++noticeSeq.current
    const el = noticeRef.current
    if (el) {
      el.getAnimations().forEach((a) => a.cancel())
      el.style.overflow = ''
    }
    setNotice(message)
    setTimeout(() => {
      collapseAndRemove(
        noticeRef.current,
        () => {
          if (noticeSeq.current === seq) setNotice('')
        },
        { ms: 300, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
      )
    }, 5000)
  }

  const upload = async (form: FormData) => {
    setUploadBusy(true)
    try {
      const added = await addResource(id, form)
      if (added.notice) flash(added.notice)
      await refresh()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'failed to add resource')
    } finally {
      setUploadBusy(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type !== 'application/pdf') continue
      const form = new FormData()
      form.append('kind', 'pdf')
      form.append('file', file)
      void upload(form)
    }
  }

  const onPickPdf = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const form = new FormData()
    form.append('kind', 'pdf')
    form.append('file', file)
    void upload(form)
    e.target.value = ''
  }

  const addUrl = () => {
    if (!url.trim()) return
    const form = new FormData()
    form.append('kind', 'url')
    form.append('url', url.trim())
    setUrl('')
    void upload(form)
  }

  const addManual = () => {
    if (!manualTitle.trim()) return
    const form = new FormData()
    form.append('kind', 'manual')
    form.append('title', manualTitle.trim())
    if (manualTotal.trim()) {
      form.append('total_units', manualTotal.trim())
      form.append('unit_label', 'lecture')
    }
    setManualTitle('')
    setManualTotal('')
    void upload(form)
  }

  const generate = async () => {
    setPlanBusy(true)
    try {
      setPlan(await generatePlan(id))
    } catch (e) {
      flash(e instanceof Error ? e.message : 'plan generation failed')
    } finally {
      setPlanBusy(false)
    }
  }

  const persistPlan = async () => {
    if (!plan) return
    setPlanBusy(true)
    try {
      await savePlan(id, plan)
      setPlan(null)
      await refresh()
    } catch (e) {
      flash(e instanceof Error ? e.message : 'plan save failed')
    } finally {
      setPlanBusy(false)
    }
  }

  const cycleStatus = async (topic: Topic) => {
    const next =
      topic.status === 'todo' ? 'in_progress' : topic.status === 'in_progress' ? 'done' : 'todo'
    await patchTopic(topic.id, { status: next }).catch(() => {})
    await refresh()
  }

  const setConfidence = async (topic: Topic, value: number) => {
    await patchTopic(topic.id, { confidence: value }).catch(() => {})
    await refresh()
  }

  const editUnit = async (resource: Resource) => {
    const value = window.prompt(
      `current ${resource.unit_label ?? 'unit'} for ${resource.title}`,
      String(resource.current_unit),
    )
    if (value === null) return
    const parsed = parseInt(value, 10)
    if (Number.isNaN(parsed)) return
    await patchResource(resource.id, { current_unit: parsed }).catch(() => {})
    await refresh()
  }

  if (!detail) return null

  return (
    <>
      <header>
        <h1 className="brand">{detail.name}</h1>
        <a className="guide-link" href="#/learning">
          back
        </a>
      </header>

      {detail.goal_text && <p className="field-goal">{detail.goal_text}</p>}
      {notice && (
        <div className="notice" ref={noticeRef}>
          {notice}
        </div>
      )}

      <section className="music-section">
        <h2 className="section-title">resources</h2>
        {detail.resources.map((r) => (
          <div key={r.id} className="resource-row" onClick={() => void editUnit(r)}>
            <div className="resource-line">
              <span className="row-main">{r.title}</span>
              <span className="resource-units">
                {r.total_units
                  ? `${r.current_unit}/${r.total_units} ${r.unit_label ?? ''}`
                  : r.current_unit > 0
                    ? `${r.current_unit} ${r.unit_label ?? ''}`
                    : r.kind}
              </span>
            </div>
            {r.total_units != null && r.total_units > 0 && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, (r.current_unit / r.total_units) * 100)}%` }}
                />
              </div>
            )}
          </div>
        ))}

        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          <label className="dropzone-label">
            {uploadBusy ? 'adding...' : 'drop a pdf here, or click to pick one'}
            <input type="file" accept="application/pdf" onChange={onPickPdf} hidden />
          </label>
        </div>
        <div className="resource-add">
          <input
            placeholder="paste a link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUrl()}
          />
          <button className="action save" onClick={addUrl} disabled={!url.trim() || uploadBusy}>
            add
          </button>
        </div>
        <div className="resource-add">
          <input
            placeholder="manual resource, e.g. CS 285 lectures"
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
          />
          <input
            className="resource-count"
            placeholder="count"
            inputMode="numeric"
            value={manualTotal}
            onChange={(e) => setManualTotal(e.target.value)}
          />
          <button
            className="action save"
            onClick={addManual}
            disabled={!manualTitle.trim() || uploadBusy}
          >
            add
          </button>
        </div>
      </section>

      <section className="music-section">
        <h2 className="section-title">plan</h2>
        {plan === null ? (
          <>
            {detail.topics.map((t) => (
              <div key={t.id} className="topic-row">
                <button className={`topic-status ${t.status}`} onClick={() => void cycleStatus(t)}>
                  {t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'now' : 'todo'}
                </button>
                <span className="row-main">{t.name}</span>
                <span className="confidence">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      className={`conf-dot ${t.confidence !== null && n <= t.confidence ? 'on' : ''}`}
                      onClick={() => void setConfidence(t, n)}
                      aria-label={`confidence ${n}`}
                    />
                  ))}
                </span>
              </div>
            ))}
            <div className="plan-actions">
              <button className="action" onClick={() => void generate()} disabled={planBusy}>
                {planBusy ? 'generating...' : detail.topics.length ? 'regenerate plan' : 'generate plan'}
              </button>
            </div>
          </>
        ) : (
          <>
            {plan.map((t, i) => (
              <div
                key={i}
                className="topic-row draft"
                draggable
                onDragStart={() => (dragIndex.current = i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  const from = dragIndex.current
                  if (from === null || from === i) return
                  const next = [...plan]
                  const [moved] = next.splice(from, 1)
                  next.splice(i, 0, moved)
                  dragIndex.current = i
                  setPlan(next)
                }}
              >
                <span className="drag-handle">::</span>
                <input
                  className="topic-edit"
                  value={t.name}
                  onChange={(e) =>
                    setPlan(plan.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                />
                <button
                  className="dismiss"
                  onClick={() => setPlan(plan.filter((_, j) => j !== i))}
                  aria-label="remove topic"
                >
                  &times;
                </button>
              </div>
            ))}
            <div className="plan-actions">
              <button
                className="action"
                onClick={() => setPlan([...plan, { name: '', source_resource_id: null }])}
              >
                add topic
              </button>
              <button className="action delete" onClick={() => setPlan(null)}>
                discard
              </button>
              <button className="action save" onClick={() => void persistPlan()} disabled={planBusy}>
                {planBusy ? 'saving' : 'save plan'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="music-section">
        <h2 className="section-title">progress</h2>
        <p className="field-stats">
          {detail.problems_theory + detail.problems_implementation} problems (
          {detail.problems_theory} theory, {detail.problems_implementation} implementation)
          {detail.streak > 0 && ` · ${detail.streak} day streak`}
        </p>
      </section>
    </>
  )
}
