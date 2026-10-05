import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'

const IDS = ['mxklb', 'pancreas', 'nightscout']
const SHORT = { mxklb: 'boluscalculator', pancreas: 'bolus-calculator', nightscout: 'Bolus Wizard' }
const CAT = {
  nominal: 'Formula match', missing_value: 'Blank input', input_validation: 'Impossible value',
  divide_by_zero: 'Zero divisor', locale_decimal: 'Decimal format', upper_bound: 'Dose ceiling',
  iob_subtraction: 'Insulin on board',
}
const VERDICT = { true_defect: 'True defect', spec_ambiguity: 'Ambiguous', test_error: 'Test error' }
const SEV_KIND = { critical: 'fail', high: 'fail', medium: 'warn' }

const FIELDS = {
  mxklb: [['bg', 'Glucose (mg/dL)'], ['carbs', 'Carbs (g)'], ['target', 'Target (mg/dL)'], ['isf', 'Correction (mg/dL per U)'], ['icr', 'Carb ratio (g per U)']],
  pancreas: [['glycaemia', 'Glucose (mg/dL)'], ['carbohydrates', 'Carbs (g)'], ['ratio', 'Carb ratio (g per U)'], ['correction', 'Correction (mg/dL per U)'], ['objective', 'Target (mg/dL)'], ['iob_U', 'Insulin on board (U)']],
  nightscout: [['bg', 'Glucose (mg/dL)'], ['iob', 'Insulin on board (U)'], ['sens', 'Sensitivity (mg/dL per U)'], ['target_high', 'Target high'], ['target_low', 'Target low']],
}
const DEFAULTS = {
  mxklb: { bg: '150', carbs: '60', target: '100', isf: '50', icr: '12' },
  pancreas: { glycaemia: '150', carbohydrates: '60', ratio: '10', correction: '50', objective: '100', iob_U: '0' },
  nightscout: { bg: '250', iob: '0', sens: '50', target_high: '120', target_low: '80' },
}
const PRESETS = {
  mxklb: [['Comma decimal', { carbs: '0,6' }], ['Blank meal', { carbs: '' }], ['Negative glucose', { bg: '-50' }], ['1000 g carbs', { carbs: '1000' }]],
  pancreas: [['Comma decimal', { carbohydrates: '0,5' }], ['Blank ratio', { ratio: '' }], ['3 U on board', { glycaemia: '200', carbohydrates: '80', iob_U: '3' }], ['Blank glucose', { glycaemia: '' }]],
  nightscout: [['3 U on board', { iob: '3' }], ['Negative on board', { iob: '-1', bg: '100' }], ['Zero sensitivity', { sens: '0' }]],
}

// "Start from scratch" probes: one behaviour, run against every calculator that has the input.
const PROBES = [
  { key: 'blank', label: 'Blank input', sub: 'Missing field', icon: 'i-checkbox', bg: 'var(--brand-w)', fg: 'var(--brand)', words: /blank|empty|missing/,
    set: { mxklb: { carbs: '' }, pancreas: { carbohydrates: '' }, nightscout: { bg: '' } } },
  { key: 'negative', label: 'Impossible value', sub: 'Negative input', icon: 'i-layers', bg: 'var(--pass-w)', fg: 'var(--pass)', words: /negative|impossible|below zero/,
    set: { mxklb: { bg: '-50' }, pancreas: { carbohydrates: '-5' }, nightscout: { iob: '-1', bg: '100' } } },
  { key: 'zero', label: 'Zero divisor', sub: 'Infinity, NaN', icon: 'i-bolt', bg: 'var(--violet-w)', fg: 'var(--violet)', words: /zero|divi|infinity|nan/,
    set: { mxklb: { isf: '0' }, pancreas: { ratio: '0' }, nightscout: { sens: '0' } } },
  { key: 'iob', label: 'Insulin on board', sub: 'Subtract IOB', icon: 'i-cal', bg: 'var(--warn-w)', fg: 'var(--warn)', words: /on board|iob|stack/,
    set: { pancreas: { glycaemia: '200', carbohydrates: '80', iob_U: '3' }, nightscout: { iob: '3' } } },
  { key: 'huge', label: 'Huge dose', sub: 'Dose ceiling', icon: 'i-import', bg: '#F1EFEA', fg: 'var(--muted)', words: /huge|large|ceiling|1000|overdose/,
    set: { mxklb: { carbs: '1000' }, pancreas: { carbohydrates: '1000' }, nightscout: { bg: '600' } } },
  { key: 'comma', hidden: true, label: 'Decimal format', words: /comma|decimal|locale/,
    set: { mxklb: { carbs: '0,6' }, pancreas: { carbohydrates: '0,5' } } },
]

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const fmt = (v) => (v === '' || v === null || v === undefined ? 'blank' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v))
const U = (v) => (typeof v === 'number' || /^-?\d/.test(String(v)) ? `${fmt(v)} U` : fmt(v))
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')
const KEYS = ['bg', 'carbs', 'glycaemia', 'carbohydrates', 'ratio', 'correction', 'objective', 'iob', 'sens', 'iob_U']
const inputsText = (r) => Object.entries(r.inputs).filter(([k]) => KEYS.includes(k)).map(([k, v]) => `${k}: ${v === '' ? '""' : v}`).join('   ')
const refText = (r) => (r.category === 'upper_bound' ? 'no ceiling' : r.reference_U != null ? `reference ${fmt(r.reference_U)} U` : 'no valid dose')

const UNIT = { bg: ' mg/dL', glycaemia: ' mg/dL', carbs: ' g', carbohydrates: ' g', iob: ' U IOB', iob_U: ' U IOB', sens: ' sens', ratio: ' ratio', isf: ' ISF', icr: ' ICR', correction: ' corr' }
// the one input that differs from the default case, and what the calculator showed for it
function proof(r) {
  const d = DEFAULTS[r.tid] || {}
  const ch = Object.entries(r.inputs).filter(([k, v]) => k in d && String(v) !== String(d[k]) && Number(v) !== Number(d[k]))
  const [k, v] = ch[0] || []
  const inp = k ? `${v === '' ? 'blank' : String(v).replace('-', '\u2212')}${v === '' ? ' ' + k : UNIT[k] || ''}` : 'default'
  const out = U(r.observed) + (r.category === 'upper_bound' ? ', no warning' : '')
  return `${inp} \u2192 ${out}`
}

const NAV = [
  ['home', 'Home', 'i-home'], ['runs', 'Runs', 'i-run'], ['findings', 'Findings', 'i-alert'], ['behaviours', 'Behaviours', 'i-grid'],
]
const NAV2 = [['agents', 'Agents', 'i-agents'], ['policy', 'Policy & gates', 'i-shield'], ['ledger', 'Audit ledger', 'i-ledger']]

export default function App() {
  const [runs, setRuns] = useState({})
  const [view, setView] = useState({ page: 'home' })
  const [live, setLive] = useState(0)
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    IDS.forEach((id) => fetch(`/api/runs/${id}`).then((r) => r.json()).then((j) => setRuns((m) => ({ ...m, [id]: j }))))
  }, [])

  const go = (page, extra = {}) => { setView({ page, ...extra }); setNavOpen(false); window.scrollTo(0, 0) }
  const loaded = IDS.every((i) => runs[i])
  const findings = useMemo(() => {
    const order = { critical: 0, high: 1, medium: 2 }
    return IDS.flatMap((id) => (runs[id] ? runs[id].results.filter((r) => r.status === 'fail').map((r) => ({ ...r, tid: id })) : []))
      .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  }, [runs])
  const behaviours = useMemo(() => {
    const m = {}
    IDS.forEach((id) => runs[id]?.results.forEach((r) => {
      const c = (m[r.category] ||= { cat: r.category, held: 0, failed: 0, by: {} })
      r.status === 'fail' ? c.failed++ : c.held++
      c.by[id] = (c.by[id] || 0) + (r.status === 'fail' ? 1 : 0)
    }))
    return Object.values(m).sort((a, b) => b.failed - a.failed)
  }, [runs])

  async function liveRun(id) {
    const r = await fetch(`/api/run/${id}`, { method: 'POST' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.detail || 'Run failed')
    setRuns((m) => ({ ...m, [id]: j }))
    setLive((n) => n + 1)
  }

  const counts = { runs: IDS.length, findings: findings.length, behaviours: behaviours.length, agents: 2 }
  const link = (key, label, icon) => (
    <a key={key} href="#" className={view.page === key || (key === 'runs' && view.page === 'run') ? 'on' : undefined}
      onClick={(e) => { e.preventDefault(); go(key) }}>
      <Icon name={icon} /><span className="nav-label">{label}</span>
      {counts[key] > 0 && <span className="count n">{counts[key]}</span>}
    </a>
  )

  return (
    <div className="app">
      <div className="side-backdrop" hidden={!navOpen} onClick={() => setNavOpen(false)} />
      <aside className={navOpen ? 'side side--open' : 'side'}>
        <div className="side-drawer-head">
          <div className="logo">
            <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
              <line x1="10" y1="1" x2="10" y2="13" stroke="#1F4FD8" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M10 13 L15.5 18 L10 23 L4.5 18 Z" fill="#1F4FD8" />
            </svg>
            <b>Dose Check</b>
          </div>
          <button type="button" className="iconbtn side-close" onClick={() => setNavOpen(false)} aria-label="Close navigation"><Icon name="i-x" /></button>
        </div>
        <button className="create" type="button" onClick={() => go('home', { focus: Date.now() })}>
          <Icon name="i-plus" size="s" /><span className="nav-label">New probe</span>
        </button>
        <nav className="nav" aria-label="Primary">
          {NAV.map(([k, l, i]) => link(k, l, i))}
          <div className="nav-rule" />
          {NAV2.map(([k, l, i]) => link(k, l, i))}
        </nav>
        <div className="side-foot">
          <div className="plan-row">Live runs this hour<span className="v n">{live} / 6</span></div>
          <div className="meter"><i style={{ width: `${(live / 6) * 100}%` }} /></div>
          <small>&nbsp;</small>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button type="button" className="iconbtn nav-toggle" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Icon name="i-menu" /></button>
          <span className="ws"><span className="sq">D</span><span className="ws-label">dose-check / bolus calculators</span></span>
          <span className="sp" />
          <span className="mono" style={{ color: 'var(--muted)' }}>CHO/ICR + (G − target)/ISF − IOB</span>
        </div>
        <div className="demo-banner">
          <Icon name="i-spark" size="s" />
          <span>Cached runs</span>
        </div>
        <main className="content">
          {!loaded ? <div className="body"><div className="empty">Loading</div></div> : <>
            {view.page === 'home' && <Home runs={runs} findings={findings} go={go} focus={view.focus} />}
            {view.page === 'runs' && <Runs runs={runs} go={go} />}
            {view.page === 'run' && <Run key={view.id} id={view.id} run={runs[view.id]} liveRun={liveRun} open={view.open} tab={view.tab} go={go} />}
            {view.page === 'findings' && <Findings findings={findings} go={go} />}
            {view.page === 'behaviours' && <Behaviours rows={behaviours} />}
            {view.page === 'agents' && <Agents runs={runs} />}
            {view.page === 'policy' && <Policy runs={runs} />}
            {view.page === 'ledger' && <Ledger runs={runs} />}
          </>}
        </main>
      </div>
    </div>
  )
}

function Sev({ s }) { return <span className={'pill ' + (SEV_KIND[s] || 'grey')}><span className="d" />{cap(s)}</span> }
function Result({ run }) {
  const f = run.summary.failed
  return f ? <span className="pill fail"><span className="d" />{f} failing</span> : <span className="pill pass"><span className="d" />All held</span>
}

/* ---------------- Home ---------------- */
function Home({ runs, findings, go, focus }) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const [probe, setProbe] = useState(null)
  const [busy, setBusy] = useState(false)
  const top = findings[0]

  useEffect(() => { if (focus) document.getElementById('prompt-input')?.focus() }, [focus])

  async function runProbe(p) {
    setBusy(true); setMsg(''); setProbe({ p, rows: [] })
    const rows = await Promise.all(IDS.filter((id) => p.set[id]).map(async (id) => {
      try {
        const r = await fetch(`/api/probe/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: { ...DEFAULTS[id], ...p.set[id] } }) })
        const j = await r.json(); if (!r.ok) throw new Error(j.detail)
        return { id, res: j }
      } catch (e) { return { id, err: e.message } }
    }))
    setProbe({ p, rows }); setBusy(false)
  }
  function submit(e) {
    e.preventDefault()
    const t = text.toLowerCase()
    const p = PROBES.find((x) => x.words.test(t))
    if (!p) return setMsg('No matching probe. Try: blank, negative, zero, on board, huge, comma.')
    setText(''); runProbe(p)
  }

  return (
    <section>
      <div className="hero">
        <h1>What should we put under test?</h1>
        <form className="promptwrap" onSubmit={submit}>
          <div className="prompt">
            <div className="ph"><Icon name="i-spark" size="s" /> Describe an input</div>
            <label htmlFor="prompt-input" style={{ position: 'absolute', left: -9999 }}>Describe an input</label>
            <textarea id="prompt-input" placeholder="A blank meal field should never produce an insulin dose" value={text}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(e) }} />
            <div className="pf">
              <span className="sp" />
              <button type="submit" className="ib send" title="Probe all calculators" disabled={!text.trim() || busy}><Icon name="i-up" size="s" /></button>
            </div>
          </div>
        </form>
        {msg && <p role="status" style={{ marginTop: 10, fontSize: 13.5, color: 'var(--fail)' }}>{msg}</p>}
      </div>

      <div className="body">
        <h2 style={{ marginTop: 6 }}>Start from scratch</h2>
        <div className="grid5">
          {PROBES.filter((p) => !p.hidden).map((p) => (
            <button key={p.key} type="button" className="card" onClick={() => runProbe(p)}>
              <span className="tile" style={{ background: p.bg }}><span style={{ color: p.fg, display: 'flex' }}><Icon name={p.icon} /></span></span>
              <span><b>{p.label}</b><span>{p.sub}</span></span>
            </button>
          ))}
        </div>

        {probe && <>
          <h2>Probe: {probe.p.label}</h2>
          <div className="panel">
            <table>
              <thead><tr><th>Calculator</th><th>Input</th><th>Shows</th><th>Reference</th><th>Result</th></tr></thead>
              <tbody>
                {probe.rows.length === 0 && <tr><td colSpan="5" className="sub">Running the calculators</td></tr>}
                {probe.rows.map(({ id, res, err }) => err
                  ? <tr key={id}><td>{SHORT[id]}</td><td colSpan="4" style={{ color: 'var(--fail)' }}>{err}</td></tr>
                  : <tr key={id} onClick={() => go('run', { id })}>
                    <td><b>{SHORT[id]}</b></td>
                    <td className="mono">{inputsText(res)}</td>
                    <td className="n"><b>{U(res.observed)}</b></td>
                    <td className="n" style={{ color: 'var(--muted)' }}>{res.reference_U != null ? `${fmt(res.reference_U)} U` : 'none valid'}</td>
                    <td>{res.status === 'pass' ? <span className="pill pass"><span className="d" />Safe</span> : <Sev s={res.severity} />} <span className="sub">{cap(res.rule)}</span></td>
                  </tr>)}
              </tbody>
            </table>
          </div>
        </>}

        <h2>Needs your attention</h2>
        {top && (
          <div className="attn" style={{ marginBottom: 13 }}>
            <div className="attn-in">
              <span style={{ color: 'var(--violet)', marginTop: 2 }}><Icon name="i-star" /></span>
              <div style={{ flex: 1 }}>
                <div className="eyebrow">Found by Lightning at {when(runs[top.tid].generated_at)}</div>
                <h3 style={{ marginTop: 8, fontSize: 17, fontWeight: 600, letterSpacing: '-.012em' }}>{cap(top.rule)}</h3>
                <div className="meta">
                  <Sev s={top.severity} />
                  <span className="mono">{SHORT[top.tid]}</span><span>·</span>
                  <span>Shows <b className="n">{U(top.observed)}</b></span><span>·</span>
                  <span>{refText(top)}</span>
                </div>
                <div className="acts"><button className="btn pri" onClick={() => go('run', { id: top.tid, open: top.case_id })}>Review finding</button></div>
              </div>
            </div>
          </div>
        )}
        <div className="grid3">
          {cards(findings, top).map((f) => (
            <button key={f.tid + f.case_id} className="card" style={{ display: 'block' }} onClick={() => go('run', { id: f.tid, open: f.case_id })}>
              <h4 style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.35 }}>{cap(f.rule)}</h4>
              <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 8 }}><Sev s={f.severity} /><span className="mono" style={{ color: 'var(--muted)' }}>{SHORT[f.tid]}</span></div>
              <div className="mono" style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--line2)', fontSize: 13, color: 'var(--fail)' }}>{proof(f)}</div>
              <DoseBar value={f.observed} />
            </button>
          ))}
        </div>

        <h2>Recent runs</h2>
        <Panel title="Calculators" extra={<a href="#" className="lnk" onClick={(e) => { e.preventDefault(); go('runs') }}>View all</a>}>
          <RunTable runs={runs} go={go} />
        </Panel>
      </div>
    </section>
  )
}

const SAFE_MAX = 15 // U, a sane single-bolus ceiling used only to draw the bar

// green band = 0..SAFE_MAX; red tick = what the calculator showed, outside it
function DoseBar({ value }) {
  const v = Number(value)
  const finite = Number.isFinite(v)
  const lo = finite ? Math.min(0, v) : 0
  const hi = finite ? Math.max(SAFE_MAX, v) : SAFE_MAX * 1.6
  const span = hi - lo
  const pad = 6
  const pos = (x) => pad + ((x - lo) / span) * (100 - 2 * pad)
  const tick = finite ? pos(v) : 100 - pad
  const label = finite ? `${Math.round(v * 100) / 100} U` : String(value)
  return (
    <div className="dbar" aria-label={`Safe 0 to ${SAFE_MAX} U, shown ${label}`}>
      <i className="band" style={{ left: pos(0) + '%', width: pos(SAFE_MAX) - pos(0) + '%' }} />
      <i className="tick" style={{ left: tick + '%' }} />
      <span className="ax" style={{ left: pos(0) + '%' }}>0</span>
      <span className="ax" style={{ left: pos(SAFE_MAX) + '%' }}>{SAFE_MAX} U</span>
    </div>
  )
}

// three distinct bad outputs: one per calculator/check, worst first, skipping the headline finding
function cards(findings, top) {
  const seen = new Set(top ? [top.tid + top.category] : [])
  return findings.filter((f) => f !== top && !seen.has(f.tid + f.category) && seen.add(f.tid + f.category)).slice(0, 3)
}

function Panel({ title, extra, children }) {
  return <div className="panel"><header><h2>{title}</h2><span className="sp" />{extra}</header>{children}</div>
}

function RunTable({ runs, go }) {
  return (
    <table>
      <thead><tr><th>Calculator</th><th>Result</th><th>Tests</th><th>Commit</th><th>Cost</th><th>Time</th></tr></thead>
      <tbody>
        {IDS.map((id) => {
          const r = runs[id]
          return (
            <tr key={id} tabIndex={0} onClick={() => go('run', { id })} onKeyDown={(e) => e.key === 'Enter' && go('run', { id })}>
              <td><b>{r.target.name}</b></td>
              <td><Result run={r} /></td>
              <td className="n" style={{ color: 'var(--muted)' }}>{r.summary.passed} held · {r.summary.failed} failed</td>
              <td className="mono">{r.target.commit}</td>
              <td className="n" style={{ color: 'var(--muted)' }}>${r.cost_usd.toFixed(3)}</td>
              <td className="n" style={{ color: 'var(--muted)' }}>{Math.round(r.seconds)}s</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Runs({ runs, go }) {
  return (
    <div className="body">
      <div className="pagehead"><h1>Runs</h1></div>
      <div className="panel mt"><RunTable runs={runs} go={go} /></div>
    </div>
  )
}

/* ---------------- Run detail ---------------- */
function Run({ id, run, liveRun, open: openId, tab: tab0, go }) {
  const [tab, setTab] = useState(tab0 || 'findings')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fails = run.results.filter((r) => r.status === 'fail')
    .sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - { critical: 0, high: 1, medium: 2 }[b.severity]))
  const passes = run.results.filter((r) => r.status === 'pass')

  async function again() {
    setBusy(true); setErr('')
    try { await liveRun(id); setTab('findings') } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="body">
      <div className="pagehead">
        <a href="#" className="crumb" onClick={(e) => { e.preventDefault(); go('runs') }}><Icon name="i-back" size="xs" /> Runs</a>
        <div className="head-row">
          <div>
            <h1>{run.target.name}</h1>
            <p><a href={run.target.repo} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)' }}>GitHub</a> · {run.target.licence} · {run.target.language} · <span className="mono">{run.target.commit}</span></p>
          </div>
          <span className="sp" />
          <button className="btn pri" onClick={again} disabled={busy}>
            <Icon name="i-bolt" size="s" className={busy ? 'spin' : ''} />{busy ? 'Running' : 'Run it'}
          </button>
        </div>
      </div>
      {err && <div className="err" role="alert" style={{ padding: '10px 0' }}>{err}</div>}
      <div className="stats">
        <div className="stat"><b>{run.summary.tests}</b><span>Tests</span></div>
        <div className="stat f"><b>{run.summary.failed}</b><span>Failed</span></div>
        <div className="stat p"><b>{run.summary.passed}</b><span>Held</span></div>
        <div className="stat"><b>${run.cost_usd.toFixed(3)}</b><span>Agent cost</span></div>
      </div>
      <div className="tabs">
        {[['findings', 'Findings', fails.length], ['passed', 'Held', passes.length], ['try', 'Probe'], ['log', 'Agent log']].map(([k, l, n]) => (
          <button key={k} className={tab === k ? 'on' : undefined} onClick={() => setTab(k)}>{l}{n !== undefined && <span className="n" style={{ marginLeft: 6, color: 'var(--faint)' }}>{n}</span>}</button>
        ))}
      </div>
      <div className="mt">
        {tab === 'findings' && <FindingList run={run} fails={fails} openId={openId} />}
        {tab === 'passed' && <PassedTable rows={passes} />}
        {tab === 'try' && <Try id={id} />}
        {tab === 'log' && <Log run={run} />}
      </div>
    </div>
  )
}

function FindingList({ run, fails, openId }) {
  const [open, setOpen] = useState(openId || null)
  const [sup, setSup] = useState({})
  if (!fails.length) return <div className="panel"><div className="empty">No failures. Every probe matched the reference or was refused safely.</div></div>
  return <>
    <div className="panel">
      {fails.map((r) => {
        const a = r.adjudication
        const isOpen = open === r.case_id
        return (
          <div key={r.case_id}>
            <button className={'frow' + (isOpen ? ' open' : '')} onClick={() => setOpen(isOpen ? null : r.case_id)}>
              <Sev s={r.severity} />
              <span className="grow"><span className="ttl">{cap(r.rule)}</span><span className="sub">{CAT[r.category]} · <span className="mono">{inputsText(r)}</span></span></span>
              <span className="dose"><b>{U(r.observed)}</b><span className="sub">{refText(r)}</span></span>
              <span className="chev"><Icon name="i-chev-r" size="s" /></span>
            </button>
            {isOpen && (
              <div className="fdetail">
                <p className="mono">shows {U(r.observed)} · {refText(r)}</p>
                {a && <div className="acts">
                  <button className="btn sm" onClick={() => setSup({ ...sup, [r.case_id]: !sup[r.case_id] })} aria-expanded={!!sup[r.case_id]}>
                    <Icon name="i-spark" size="xs" />{sup[r.case_id] ? 'Hide Super explanation' : 'Super explanation'}
                  </button>
                </div>}
                {a && sup[r.case_id] && (
                  <div className="sup">
                    <div className="eyebrow">Super · {VERDICT[a.verdict] || a.verdict}</div>
                    <p>{a.explanation}</p>
                    <dl><dt>Cause</dt><dd>{a.cause}</dd><dt>Fix</dt><dd>{a.fix}</dd></dl>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
    {run.proof && !run.proof.error && <Patch proof={run.proof} />}
  </>
}

function Patch({ proof }) {
  return (
    <div className="mt">
      <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.018em', margin: '0 0 13px' }}>Patch</h2>
      <div className="panel">
        <header><span className="pill pass"><span className="d" />Verified</span><h2>Re-run on patched code</h2></header>
        <div style={{ padding: 16 }}>
          <div className="diff">
            <div className="del">− {proof.find}</div>
            <div className="add">+ {proof.replace}</div>
          </div>
        </div>
        <table>
          <thead><tr><th>Test</th><th>Before</th><th>After</th><th>Result</th></tr></thead>
          <tbody>
            {proof.rerun.map((x) => (
              <tr key={x.case_id} style={{ cursor: 'default' }}><td className="mono">{x.case_id}</td><td className="n">{U(x.before)}</td><td className="n">{U(x.after)}</td>
                <td><span className={'pill ' + (x.status_after === 'pass' ? 'pass' : 'fail')}><span className="d" />{x.status_after === 'pass' ? 'Held' : 'Failing'}</span></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PassedTable({ rows }) {
  if (!rows.length) return <div className="panel"><div className="empty">Nothing held.</div></div>
  return (
    <div className="panel"><table>
      <thead><tr><th>Test</th><th>Check</th><th>Input</th><th>Shows</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.case_id} style={{ cursor: 'default' }}><td className="mono">{r.case_id}</td><td>{CAT[r.category]}</td><td className="mono">{inputsText(r)}</td><td className="n">{U(r.observed)}</td></tr>)}</tbody>
    </table></div>
  )
}

function Try({ id }) {
  const [vals, setVals] = useState(DEFAULTS[id])
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function go() {
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/probe/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: vals }) })
      const j = await r.json(); if (!r.ok) throw new Error(j.detail)
      setRes(j)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="panel">
      <div className="pform">
        {FIELDS[id].map(([k, l]) => (
          <div className="field" key={k}><label htmlFor={'f-' + k}>{l}</label>
            <input id={'f-' + k} value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && go()} /></div>
        ))}
      </div>
      <div className="chips">
        {PRESETS[id].map(([l, p]) => <button key={l} className="btn sm" onClick={() => setVals({ ...DEFAULTS[id], ...p })}>{l}</button>)}
        <span className="sp" />
        <button className="btn pri" onClick={go} disabled={busy}>Run calculator</button>
      </div>
      {err && <div className="err">{err}</div>}
      {res && (
        <div className="kvs" style={{ padding: '16px', margin: 0, borderTop: '1px solid var(--line2)' }}>
          <div><span className="sub">Calculator shows</span><b>{U(res.observed)}</b></div>
          <div><span className="sub">Reference</span><b>{res.reference_U != null ? `${fmt(res.reference_U)} U` : '—'}</b></div>
          <div>{res.status === 'pass' ? <span className="pill pass"><span className="d" />Safe</span> : <Sev s={res.severity} />}<div className="sub" style={{ marginTop: 6 }}>{cap(res.rule)}</div></div>
        </div>
      )}
    </div>
  )
}

function Log({ run }) {
  const inp = (t) => Object.entries(t.inputs).filter(([k]) => KEYS.includes(k)).map(([k, v]) => `${k}: ${v === '' ? '""' : v}`).join('  ')
  return (
    <div className="panel">
      <div className="step"><span className="pill info tag">Super</span><span>Read <span className="mono">{run.target.unit_file}</span>: {run.contract.implemented_formula}</span></div>
      {(run.contract.suspected_deviations || []).map((d, i) => <div className="step" key={i}><span className="pill warn tag">Claim</span><span>{d.claim}</span></div>)}
      {run.tool_trace.map((t, i) => (
        <div className="step" key={'t' + i}><span className="pill grey tag">Lightning</span>
          {t.error ? <span className="sub">tool error: {t.error}</span>
            : <span><span className="mono">run_test</span> {CAT[t.category]} · <span className="mono">{inp(t)}</span> → <b>{fmt(t.returned)}</b></span>}
        </div>
      ))}
    </div>
  )
}

/* ---------------- Other pages ---------------- */
function Findings({ findings, go }) {
  return (
    <div className="body">
      <div className="pagehead"><h1>Findings</h1></div>
      <div className="panel mt">
        <table>
          <thead><tr><th>Finding</th><th>Severity</th><th>Calculator</th><th>Check</th><th>Shows</th><th>Reference</th></tr></thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f.tid + f.case_id} tabIndex={0} onClick={() => go('run', { id: f.tid, open: f.case_id })} onKeyDown={(e) => e.key === 'Enter' && go('run', { id: f.tid, open: f.case_id })}>
                <td><b>{cap(f.rule)}</b></td><td><Sev s={f.severity} /></td><td className="mono">{SHORT[f.tid]}</td><td>{CAT[f.category]}</td>
                <td className="n"><b>{U(f.observed)}</b></td><td className="n" style={{ color: 'var(--muted)' }}>{f.reference_U != null ? `${fmt(f.reference_U)} U` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Behaviours({ rows }) {
  return (
    <div className="body">
      <div className="pagehead"><h1>Behaviours</h1></div>
      <div className="panel mt">
        <table>
          <thead><tr><th>Behaviour</th>{IDS.map((i) => <th key={i}>{SHORT[i]}</th>)}<th>Held</th><th>Failed</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.cat} style={{ cursor: 'default' }}>
                <td><b>{CAT[c.cat]}</b></td>
                {IDS.map((i) => <td key={i}>{c.by[i] === undefined ? <span className="sub">—</span> : c.by[i] ? <span className="pill fail"><span className="d" />{c.by[i]}</span> : <span className="pill pass"><span className="d" />Held</span>}</td>)}
                <td className="n">{c.held}</td><td className="n">{c.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Agents({ runs }) {
  const agg = {}
  IDS.forEach((id) => Object.entries(runs[id].usage || {}).forEach(([m, u]) => { const a = (agg[m] ||= { in: 0, out: 0, calls: 0 }); a.in += u.in; a.out += u.out; a.calls += u.calls }))
  const role = (m) => (/super/i.test(m) ? ['Super', 'Reads source, adjudicates, writes the patch'] : ['Lightning', 'Runs the test tools'])
  return (
    <div className="body">
      <div className="pagehead"><h1>Agents</h1></div>
      <div className="panel mt">
        <table>
          <thead><tr><th>Agent</th><th>Model</th><th>Role</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th></tr></thead>
          <tbody>
            {Object.entries(agg).map(([m, u]) => (
              <tr key={m} style={{ cursor: 'default' }}><td><b>{role(m)[0]}</b></td><td className="mono">{m.split('/')[1]}</td><td>{role(m)[1]}</td><td className="n">{u.calls}</td><td className="n">{u.in.toLocaleString()}</td><td className="n">{u.out.toLocaleString()}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Policy({ runs }) {
  const sev = { critical: 0, high: 0, medium: 0 }
  IDS.forEach((id) => Object.entries(runs[id].summary.by_severity).forEach(([k, v]) => { sev[k] += v }))
  const ref = runs.mxklb.reference
  return (
    <div className="body">
      <div className="pagehead"><h1>Policy & gates</h1></div>
      <div className="panel mt">
        <header><h2>Reference</h2></header>
        <div style={{ padding: 16 }}><div className="mono" style={{ fontSize: 14 }}>{ref.formula}</div><div className="sub" style={{ marginTop: 6 }}>{ref.cite}</div></div>
      </div>
      <div className="panel mt">
        <header><h2>Gates</h2></header>
        <table>
          <thead><tr><th>Severity</th><th>Gate</th><th>Open</th></tr></thead>
          <tbody>
            {[['critical', 'Block release'], ['high', 'Block release'], ['medium', 'Warn']].map(([s, g]) => (
              <tr key={s} style={{ cursor: 'default' }}><td><Sev s={s} /></td><td>{g}</td><td className="n">{sev[s]}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Ledger({ runs }) {
  const rows = IDS.flatMap((id) => runs[id].tool_trace.map((t, i) => ({ id, i, t })))
  return (
    <div className="body">
      <div className="pagehead"><h1>Audit ledger</h1></div>
      <div className="panel mt">
        <table>
          <thead><tr><th>#</th><th>Calculator</th><th>Tool</th><th>Check</th><th>Returned</th></tr></thead>
          <tbody>
            {rows.map(({ id, i, t }) => (
              <tr key={id + i} style={{ cursor: 'default' }}><td className="mono">{i + 1}</td><td className="mono">{SHORT[id]}</td><td className="mono">run_test</td><td>{CAT[t.category] || t.category}</td>
                <td className="n">{t.error ? <span style={{ color: 'var(--fail)' }}>error</span> : fmt(t.returned)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
