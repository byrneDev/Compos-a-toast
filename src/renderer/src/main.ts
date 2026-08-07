import type {
  CourseSummaryDto,
  DiagnosticDto,
  EnvironmentDto,
  ExportResultDto,
  ExportTarget
} from '../../shared/contracts'
import { presentCaptivateStatus } from './captivate-status'
import './styles.css'

type BusyState = 'idle' | 'selecting-source' | 'selecting-output' | 'analyzing' | 'exporting'

interface RendererState {
  environment: EnvironmentDto | null
  environmentError: boolean
  sourcePath: string
  outputPath: string
  summary: CourseSummaryDto | null
  busy: BusyState
  selectedTargets: Set<ExportTarget>
  error: string | null
  result: ExportResultDto | null
}

const targetDetails: Record<ExportTarget, { title: string }> = {
  'migration-bundle': { title: 'Editable migration bundle' },
  scorm12: { title: 'HTML5 SCORM 1.2' },
  captivate: { title: 'Adobe Captivate (.cptx)' }
}

const supportedTargets: ExportTarget[] = ['migration-bundle', 'scorm12']
const state: RendererState = {
  environment: null,
  environmentError: false,
  sourcePath: '',
  outputPath: '',
  summary: null,
  busy: 'idle',
  selectedTargets: new Set<ExportTarget>(['migration-bundle']),
  error: null,
  result: null
}

let operationSequence = 0

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required renderer element: #${id}`)
  return element as T
}

const elements = {
  titlebarStatus: requiredElement<HTMLSpanElement>('titlebar-status'),
  appVersion: requiredElement<HTMLSpanElement>('app-version'),
  platformLabel: requiredElement<HTMLSpanElement>('platform-label'),
  sourcePath: requiredElement<HTMLInputElement>('source-path'),
  outputPath: requiredElement<HTMLInputElement>('output-path'),
  browseSource: requiredElement<HTMLButtonElement>('browse-source'),
  analyzeCourse: requiredElement<HTMLButtonElement>('analyze-course'),
  browseOutput: requiredElement<HTMLButtonElement>('browse-output'),
  buildOutputs: requiredElement<HTMLButtonElement>('build-outputs'),
  idleBuildLabel: document.querySelector<HTMLSpanElement>('.button-idle-label')!,
  busyBuildLabel: document.querySelector<HTMLSpanElement>('.button-busy-label')!,
  analysisProgress: requiredElement<HTMLDivElement>('analysis-progress'),
  recognizedLabel: requiredElement<HTMLSpanElement>('recognized-label'),
  analysisSummary: requiredElement<HTMLElement>('analysis-summary'),
  coursePath: requiredElement<HTMLParagraphElement>('course-path'),
  courseTitle: requiredElement<HTMLHeadingElement>('course-title'),
  courseDimensions: requiredElement<HTMLSpanElement>('course-dimensions'),
  slideCount: requiredElement<HTMLElement>('slide-count'),
  questionCount: requiredElement<HTMLElement>('question-count'),
  interactionCount: requiredElement<HTMLElement>('interaction-count'),
  assetCount: requiredElement<HTMLElement>('asset-count'),
  flashCount: requiredElement<HTMLElement>('flash-count'),
  analysisDiagnostics: requiredElement<HTMLDetailsElement>('analysis-diagnostics'),
  analysisDiagnosticsSummary: requiredElement<HTMLElement>('analysis-diagnostics-summary'),
  analysisDiagnosticsList: requiredElement<HTMLUListElement>('analysis-diagnostics-list'),
  analysisDiagnosticsOverflow: requiredElement<HTMLParagraphElement>('analysis-diagnostics-overflow'),
  rebuildSection: requiredElement<HTMLElement>('rebuild-section'),
  rebuildHint: requiredElement<HTMLParagraphElement>('rebuild-hint'),
  rebuildNavigation: requiredElement<HTMLAnchorElement>('rebuild-navigation'),
  targetList: requiredElement<HTMLDivElement>('target-list'),
  captivateCard: requiredElement<HTMLButtonElement>('captivate-target'),
  captivateStatus: requiredElement<HTMLSpanElement>('captivate-status'),
  captivateReason: requiredElement<HTMLSpanElement>('captivate-reason'),
  captivateAvailability: requiredElement<HTMLSpanElement>('captivate-availability'),
  errorMessage: requiredElement<HTMLElement>('error-message'),
  errorHeading: requiredElement<HTMLHeadingElement>('error-heading'),
  errorText: requiredElement<HTMLParagraphElement>('error-text'),
  resultSection: requiredElement<HTMLElement>('results-section'),
  resultHeading: requiredElement<HTMLHeadingElement>('results-heading'),
  resultsNavigation: requiredElement<HTMLAnchorElement>('results-navigation'),
  artifactList: requiredElement<HTMLDivElement>('artifact-list'),
  exportDiagnostics: requiredElement<HTMLDetailsElement>('export-diagnostics'),
  exportDiagnosticsSummary: requiredElement<HTMLElement>('export-diagnostics-summary'),
  exportDiagnosticsList: requiredElement<HTMLUListElement>('export-diagnostics-list')
}

const targetButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-export-target]')
)

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}') return serialized
  } catch {
    // Fall through to a stable message for non-serializable IPC errors.
  }
  return 'An unexpected error occurred.'
}

function setText(element: HTMLElement, value: string | number): void {
  element.textContent = String(value)
}

function createDiagnosticItem(diagnostic: DiagnosticDto): HTMLLIElement {
  const item = document.createElement('li')
  item.dataset.severity = diagnostic.severity

  const code = document.createElement('strong')
  code.textContent = diagnostic.code
  item.append(code, document.createTextNode(` ${diagnostic.message}`))

  if (diagnostic.source) {
    const source = document.createElement('code')
    source.textContent = diagnostic.source
    source.title = diagnostic.source
    item.append(document.createElement('br'), source)
  }

  return item
}

function renderDiagnostics(
  diagnostics: DiagnosticDto[],
  details: HTMLDetailsElement,
  summary: HTMLElement,
  list: HTMLUListElement,
  limit?: number
): number {
  details.hidden = diagnostics.length === 0
  const visibleDiagnostics = typeof limit === 'number' ? diagnostics.slice(0, limit) : diagnostics
  list.replaceChildren(...visibleDiagnostics.map(createDiagnosticItem))
  setText(summary, `${diagnostics.length} ${diagnostics.length === 1 ? 'note' : 'notes'}`)
  return visibleDiagnostics.length
}

function getTarget(button: HTMLButtonElement): ExportTarget | null {
  const target = button.dataset.exportTarget
  return target === 'migration-bundle' || target === 'scorm12' || target === 'captivate'
    ? target
    : null
}

function availableTargetCount(): number {
  return supportedTargets.filter((target) => state.selectedTargets.has(target)).length
}

function renderEnvironment(): void {
  if (state.environment) {
    setText(elements.appVersion, `Version ${state.environment.appVersion}`)
    const platformName =
      state.environment.platform === 'win32'
        ? 'Windows desktop'
        : state.environment.platform === 'darwin'
          ? 'macOS desktop'
          : state.environment.platform === 'linux'
            ? 'Linux desktop'
            : 'Desktop app'
    setText(elements.platformLabel, platformName)

  }

  const captivate = presentCaptivateStatus(
    state.environment?.captivate ?? null,
    state.environmentError
  )
  setText(elements.captivateStatus, captivate.installationText)
  setText(elements.captivateReason, captivate.reasonText)
  setText(elements.captivateAvailability, captivate.availabilityText)
  elements.captivateReason.hidden = !captivate.reasonText
  elements.captivateStatus.title = captivate.title
  elements.captivateCard.dataset.captivateState = captivate.installationState
}

function renderSummary(): void {
  const summary = state.summary
  elements.recognizedLabel.hidden = !summary
  elements.analysisSummary.hidden = !summary
  elements.rebuildSection.classList.toggle('is-disabled', !summary)
  elements.rebuildHint.textContent = summary
    ? 'Select one or more formats, then choose where to save them.'
    : 'Analyze a course to continue.'
  elements.rebuildNavigation.setAttribute('aria-disabled', String(!summary))
  elements.rebuildNavigation.tabIndex = summary ? 0 : -1

  if (!summary) {
    elements.analysisDiagnostics.open = false
    return
  }

  setText(elements.coursePath, summary.sourcePath)
  elements.coursePath.title = summary.sourcePath
  setText(elements.courseTitle, summary.title)
  setText(elements.courseDimensions, `${summary.dimensions.width} × ${summary.dimensions.height}`)
  setText(elements.slideCount, summary.slideCount)
  setText(elements.questionCount, summary.questionCount)
  setText(elements.interactionCount, summary.interactionCount)
  setText(elements.assetCount, summary.assetCount)
  setText(elements.flashCount, summary.flashAssetCount)

  const renderedCount = renderDiagnostics(
    summary.diagnostics,
    elements.analysisDiagnostics,
    elements.analysisDiagnosticsSummary,
    elements.analysisDiagnosticsList,
    12
  )
  const remaining = summary.diagnostics.length - renderedCount
  elements.analysisDiagnosticsOverflow.hidden = remaining <= 0
  setText(
    elements.analysisDiagnosticsOverflow,
    remaining > 0 ? `${remaining} additional notes are preserved in the migration bundle.` : ''
  )
}

function renderTargets(): void {
  const targetsEnabled = Boolean(state.summary) && state.busy === 'idle'
  elements.targetList.setAttribute('aria-disabled', String(!targetsEnabled))

  for (const button of targetButtons) {
    const target = getTarget(button)
    if (!target) continue
    const isSupported = target !== 'captivate'
    const selected = state.selectedTargets.has(target)
    if (isSupported) {
      button.disabled = !targetsEnabled
      button.removeAttribute('aria-disabled')
    } else {
      // Keep unavailable targets keyboard-focusable so their readiness details can be read.
      button.disabled = false
      button.setAttribute('aria-disabled', 'true')
    }
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-pressed', String(selected))
    const check = button.querySelector<HTMLElement>('.target-check')
    if (check) check.textContent = selected ? '✓' : ''
  }
}

function createArtifact(result: ExportResultDto['artifacts'][number]): HTMLDivElement {
  const artifact = document.createElement('div')
  artifact.className = 'artifact'
  artifact.dataset.status = result.status

  const icon = document.createElement('span')
  icon.className = 'artifact-status'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = result.status === 'created' ? '✓' : result.status === 'failed' ? '!' : '→'

  const content = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = targetDetails[result.target].title
  const message = document.createElement('p')
  message.textContent = result.message
  content.append(title, message)

  if (result.path) {
    const path = document.createElement('code')
    path.textContent = result.path
    path.title = result.path
    content.append(path)
  }

  artifact.append(icon, content)
  return artifact
}

function renderResult(): void {
  const result = state.result
  elements.resultSection.hidden = !result
  elements.resultsNavigation.setAttribute('aria-disabled', String(!result))
  elements.resultsNavigation.tabIndex = result ? 0 : -1

  if (!result) {
    elements.artifactList.replaceChildren()
    elements.exportDiagnostics.hidden = true
    elements.exportDiagnostics.open = false
    return
  }

  elements.artifactList.replaceChildren(...result.artifacts.map(createArtifact))
  renderDiagnostics(
    result.diagnostics,
    elements.exportDiagnostics,
    elements.exportDiagnosticsSummary,
    elements.exportDiagnosticsList
  )
}

function render(): void {
  const isIdle = state.busy === 'idle'
  const hasSummary = Boolean(state.summary)
  const canExport =
    hasSummary && isIdle && Boolean(state.outputPath.trim()) && availableTargetCount() > 0

  if (elements.sourcePath.value !== state.sourcePath) elements.sourcePath.value = state.sourcePath
  if (elements.outputPath.value !== state.outputPath) elements.outputPath.value = state.outputPath

  document.body.setAttribute('aria-busy', String(!isIdle))
  elements.sourcePath.disabled = !isIdle
  elements.outputPath.disabled = !hasSummary || !isIdle
  elements.browseSource.disabled = !isIdle
  elements.analyzeCourse.disabled = !isIdle || !state.sourcePath.trim()
  elements.browseOutput.disabled = !hasSummary || !isIdle
  elements.buildOutputs.disabled = !canExport
  elements.analysisProgress.hidden = state.busy !== 'analyzing'
  elements.idleBuildLabel.hidden = state.busy === 'exporting'
  elements.busyBuildLabel.hidden = state.busy !== 'exporting'

  const statusText: Record<BusyState, string> = {
    idle: state.result ? 'Complete' : state.summary ? 'Course recognized' : 'Ready',
    'selecting-source': 'Choosing course…',
    'selecting-output': 'Choosing destination…',
    analyzing: 'Inspecting course…',
    exporting: 'Building outputs…'
  }
  setText(elements.titlebarStatus, statusText[state.busy])

  elements.errorMessage.hidden = !state.error
  setText(elements.errorText, state.error ?? '')

  renderEnvironment()
  renderSummary()
  renderTargets()
  renderResult()
}

function beginOperation(busy: Exclude<BusyState, 'idle'>): number {
  operationSequence += 1
  state.busy = busy
  state.error = null
  render()
  return operationSequence
}

function finishOperation(token: number): boolean {
  if (token !== operationSequence) return false
  state.busy = 'idle'
  render()
  return true
}

function showError(message: string): void {
  state.error = message
  render()
  requestAnimationFrame(() => elements.errorHeading.focus())
}

function clearResult(): void {
  state.result = null
}

async function analyze(sourcePath: string): Promise<void> {
  if (state.busy !== 'idle') return
  const normalizedPath = sourcePath.trim()
  if (!normalizedPath) {
    showError('Choose or enter a published course folder first.')
    return
  }

  state.sourcePath = normalizedPath
  state.summary = null
  clearResult()
  const token = beginOperation('analyzing')

  try {
    const summary = await window.composAToast.analyzeCourse(normalizedPath)
    if (token !== operationSequence) return
    state.summary = summary
  } catch (error) {
    if (token !== operationSequence) return
    state.error = `Analysis failed: ${errorMessage(error)}`
  } finally {
    if (finishOperation(token) && state.error) {
      requestAnimationFrame(() => elements.errorHeading.focus())
    }
  }
}

async function chooseSource(): Promise<void> {
  if (state.busy !== 'idle') return
  const token = beginOperation('selecting-source')
  let selected: string | null = null

  try {
    selected = await window.composAToast.selectCourse()
    if (token !== operationSequence || !selected) return
    state.sourcePath = selected
    state.summary = null
    clearResult()
  } catch (error) {
    if (token !== operationSequence) return
    state.error = `Could not open the course picker: ${errorMessage(error)}`
  } finally {
    finishOperation(token)
  }

  if (selected && !state.error) await analyze(selected)
}

async function chooseOutput(): Promise<void> {
  if (state.busy !== 'idle' || !state.summary) return
  const token = beginOperation('selecting-output')

  try {
    const selected = await window.composAToast.selectOutput()
    if (token !== operationSequence || !selected) return
    state.outputPath = selected
    clearResult()
  } catch (error) {
    if (token !== operationSequence) return
    state.error = `Could not open the destination picker: ${errorMessage(error)}`
  } finally {
    finishOperation(token)
  }
}

function toggleTarget(target: ExportTarget): void {
  if (state.busy !== 'idle' || !state.summary || target === 'captivate') return
  if (state.selectedTargets.has(target)) state.selectedTargets.delete(target)
  else state.selectedTargets.add(target)
  clearResult()
  render()
}

async function runExport(): Promise<void> {
  const outputPath = state.outputPath.trim()
  if (
    state.busy !== 'idle' ||
    !state.summary ||
    !outputPath ||
    availableTargetCount() === 0
  ) {
    return
  }

  state.outputPath = outputPath
  clearResult()
  const token = beginOperation('exporting')

  try {
    const result = await window.composAToast.exportCourse({
      sourcePath: state.summary.sourcePath,
      outputPath,
      targets: supportedTargets.filter((target) => state.selectedTargets.has(target))
    })
    if (token !== operationSequence) return
    state.result = result
  } catch (error) {
    if (token !== operationSequence) return
    state.error = `Export failed: ${errorMessage(error)}`
  } finally {
    if (finishOperation(token)) {
      requestAnimationFrame(() => {
        if (state.error) elements.errorHeading.focus()
        else if (state.result) {
          elements.resultHeading.focus()
          elements.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    }
  }
}

elements.sourcePath.addEventListener('input', () => {
  state.sourcePath = elements.sourcePath.value
  state.summary = null
  state.error = null
  clearResult()
  render()
})

elements.sourcePath.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  void analyze(state.sourcePath)
})

elements.outputPath.addEventListener('input', () => {
  state.outputPath = elements.outputPath.value
  state.error = null
  clearResult()
  render()
})

elements.browseSource.addEventListener('click', () => void chooseSource())
elements.analyzeCourse.addEventListener('click', () => void analyze(state.sourcePath))
elements.browseOutput.addEventListener('click', () => void chooseOutput())
elements.buildOutputs.addEventListener('click', () => void runExport())

for (const button of targetButtons) {
  button.addEventListener('click', () => {
    const target = getTarget(button)
    if (target) toggleTarget(target)
  })
}

for (const navigation of [elements.rebuildNavigation, elements.resultsNavigation]) {
  navigation.addEventListener('click', (event) => {
    if (navigation.getAttribute('aria-disabled') === 'true') event.preventDefault()
  })
}

render()

window.composAToast
  .getEnvironment()
  .then((environment) => {
    state.environment = environment
    render()
  })
  .catch((error) => {
    state.environmentError = true
    showError(`Could not inspect this computer: ${errorMessage(error)}`)
  })
