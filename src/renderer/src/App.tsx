import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  CourseSummaryDto,
  EnvironmentDto,
  ExportResultDto,
  ExportTarget
} from '../../shared/contracts'

type BusyState = 'idle' | 'analyzing' | 'exporting'

const targetDetails: Record<
  ExportTarget,
  { title: string; kicker: string; description: string }
> = {
  'migration-bundle': {
    title: 'Editable migration bundle',
    kicker: 'Reconstruction source',
    description: 'One folder per slide with objects, text, interactions, source evidence, and assets.'
  },
  scorm12: {
    title: 'HTML5 SCORM 1.2',
    kicker: 'LMS-ready ZIP',
    description: 'A standalone HTML5 player, manifest, learner state, scoring, and resume support.'
  },
  captivate: {
    title: 'Adobe Captivate (.cptx)',
    kicker: 'Native editable project',
    description: 'Version-pinned Captivate automation will assemble native editable objects.'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortPath(path: string): string {
  if (path.length <= 74) return path
  return `${path.slice(0, 28)}…${path.slice(-43)}`
}

function Stat({ label, value }: { label: string; value: string | number }): ReactElement {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

export function App(): ReactElement {
  const [environment, setEnvironment] = useState<EnvironmentDto | null>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [summary, setSummary] = useState<CourseSummaryDto | null>(null)
  const [busy, setBusy] = useState<BusyState>('idle')
  const [targets, setTargets] = useState<Set<ExportTarget>>(
    () => new Set<ExportTarget>(['migration-bundle'])
  )
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportResultDto | null>(null)

  useEffect(() => {
    window.composAToast.getEnvironment().then(setEnvironment).catch((reason) => {
      setError(`Could not inspect this computer: ${errorMessage(reason)}`)
    })
  }, [])

  const availableTargetCount = useMemo(
    () => [...targets].filter((target) => target !== 'captivate').length,
    [targets]
  )

  async function analyze(path: string): Promise<void> {
    if (!path.trim()) return
    setBusy('analyzing')
    setError(null)
    setResult(null)
    setSummary(null)
    try {
      const analysis = await window.composAToast.analyzeCourse(path.trim())
      setSummary(analysis)
    } catch (reason) {
      setError(`Analysis failed: ${errorMessage(reason)}`)
    } finally {
      setBusy('idle')
    }
  }

  async function chooseSource(): Promise<void> {
    const selected = await window.composAToast.selectCourse()
    if (!selected) return
    setSourcePath(selected)
    await analyze(selected)
  }

  async function chooseOutput(): Promise<void> {
    const selected = await window.composAToast.selectOutput()
    if (selected) setOutputPath(selected)
  }

  function toggleTarget(target: ExportTarget): void {
    if (target === 'captivate') return
    setTargets((current) => {
      const next = new Set(current)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
    setResult(null)
  }

  async function runExport(): Promise<void> {
    if (!summary || !outputPath || availableTargetCount === 0) return
    setBusy('exporting')
    setError(null)
    setResult(null)
    try {
      const exportResult = await window.composAToast.exportCourse({
        sourcePath,
        outputPath,
        targets: [...targets]
      })
      setResult(exportResult)
    } catch (reason) {
      setError(`Export failed: ${errorMessage(reason)}`)
    } finally {
      setBusy('idle')
    }
  }

  const canExport = Boolean(
    summary && outputPath && availableTargetCount > 0 && busy === 'idle'
  )

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <p className="eyebrow">Legacy learning, made portable</p>
          <h1>Compos-a-toast</h1>
        </div>
        <div className="version-pill">MVP {environment?.appVersion ?? '0.1.0'}</div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="step-label">01 · Inspect</p>
            <h2>Turn a published Composica course into something you can own again.</h2>
            <p>
              Select a course folder. The analyzer reads its structure and assets without launching
              the legacy HTA, ActiveX, scripts, or Flash content.
            </p>
          </div>
          <div className="safety-note">
            <span className="safety-dot" />
            Static extraction only
          </div>
        </section>

        <section className="panel source-panel">
          <div className="field-label">
            <span>Published course folder</span>
            {summary && <span className="success-label">Recognized</span>}
          </div>
          <div className="path-row">
            <input
              aria-label="Published course folder"
              value={sourcePath}
              onChange={(event) => {
                setSourcePath(event.target.value)
                setSummary(null)
                setResult(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void analyze(sourcePath)
              }}
              placeholder="Choose the folder containing run.hta or Content/Projects/Res…"
              spellCheck={false}
            />
            <button className="button secondary" onClick={() => void chooseSource()} disabled={busy !== 'idle'}>
              Browse
            </button>
            <button
              className="button quiet"
              onClick={() => void analyze(sourcePath)}
              disabled={!sourcePath || busy !== 'idle'}
            >
              Analyze
            </button>
          </div>

          {busy === 'analyzing' && (
            <div className="working-line">
              <span className="spinner" /> Reading course structure and inventorying assets…
            </div>
          )}

          {summary && (
            <div className="analysis-card">
              <div className="course-heading">
                <div>
                  <p>{shortPath(summary.sourcePath)}</p>
                  <h3>{summary.title}</h3>
                </div>
                <span>
                  {summary.dimensions.width} × {summary.dimensions.height}
                </span>
              </div>
              <div className="stats-grid">
                <Stat label="Slides" value={summary.slideCount} />
                <Stat label="Questions" value={summary.questionCount} />
                <Stat label="Interactions" value={summary.interactionCount} />
                <Stat label="Assets" value={summary.assetCount} />
                <Stat label="Flash files" value={summary.flashAssetCount} />
              </div>
              {summary.diagnostics.length > 0 && (
                <details className="diagnostics">
                  <summary>{summary.diagnostics.length} analysis notes</summary>
                  <ul>
                    {summary.diagnostics.slice(0, 12).map((item, index) => (
                      <li key={`${item.code}-${index}`} data-severity={item.severity}>
                        <strong>{item.code}</strong> {item.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </section>

        <section className={`export-section ${summary ? '' : 'muted-section'}`}>
          <div className="section-heading">
            <div>
              <p className="step-label">02 · Rebuild</p>
              <h2>Choose the useful destination.</h2>
            </div>
            {!summary && <span>Analyze a course to continue</span>}
          </div>

          <div className="target-grid" aria-disabled={!summary}>
            {(['migration-bundle', 'scorm12', 'captivate'] as ExportTarget[]).map((target) => {
              const detail = targetDetails[target]
              const captivatePending = target === 'captivate'
              const selected = targets.has(target)
              return (
                <button
                  key={target}
                  className={`target-card ${selected ? 'selected' : ''} ${captivatePending ? 'pending' : ''}`}
                  onClick={() => toggleTarget(target)}
                  disabled={!summary || captivatePending}
                  aria-pressed={selected}
                >
                  <span className="target-check" aria-hidden="true">
                    {selected ? '✓' : ''}
                  </span>
                  <span className="target-kicker">{detail.kicker}</span>
                  <strong>{detail.title}</strong>
                  <span className="target-description">{detail.description}</span>
                  {captivatePending && (
                    <span className="pending-label">
                      Adapter in development · {environment?.captivate.detected ? 'Captivate detected' : 'Captivate not detected'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="panel destination-panel">
            <div className="field-label">Export destination</div>
            <div className="path-row">
              <input
                aria-label="Export destination"
                value={outputPath}
                onChange={(event) => setOutputPath(event.target.value)}
                placeholder="Choose a folder for generated bundles and packages…"
                spellCheck={false}
                disabled={!summary}
              />
              <button
                className="button secondary"
                onClick={() => void chooseOutput()}
                disabled={!summary || busy !== 'idle'}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="run-row">
            <div>
              <strong>No source files are modified.</strong>
              <span>Exports are written to new folders and ZIP files.</span>
            </div>
            <button className="button primary" onClick={() => void runExport()} disabled={!canExport}>
              {busy === 'exporting' ? (
                <>
                  <span className="spinner" /> Converting…
                </>
              ) : (
                'Build selected outputs'
              )}
            </button>
          </div>
        </section>

        {error && (
          <section className="message error-message" role="alert">
            <strong>Something needs attention</strong>
            <p>{error}</p>
          </section>
        )}

        {result && (
          <section className="message result-message" aria-live="polite">
            <p className="step-label">03 · Done</p>
            <h2>Conversion finished.</h2>
            <div className="artifact-list">
              {result.artifacts.map((artifact, index) => (
                <div className="artifact" key={`${artifact.target}-${index}`} data-status={artifact.status}>
                  <span>{artifact.status === 'created' ? '✓' : artifact.status === 'failed' ? '!' : '→'}</span>
                  <div>
                    <strong>{targetDetails[artifact.target].title}</strong>
                    <p>{artifact.message}</p>
                    {artifact.path && <code title={artifact.path}>{artifact.path}</code>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer>
        <span>Compos-a-toast never executes legacy course code.</span>
        <span>Local-first · Open source · Built for reconstruction</span>
      </footer>
    </div>
  )
}
