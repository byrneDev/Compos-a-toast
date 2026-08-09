import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { createServer, type Server } from 'node:net'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'
import AdmZip from 'adm-zip'
import type { CourseModel, ExportedArtifact } from '../model'
import type {
  CaptivateAdapterCapabilityDto,
  CaptivateDetectionDto,
  DiagnosticDto
} from '../../shared/contracts'

export const CAPTIVATE_CLASSIC_ADAPTER_ID =
  'captivate-classic-11.8.4-editable-text-draft-v1'
export const CAPTIVATE_CLASSIC_ADAPTER_BUILD = '11.8.4.21'
export const CAPTIVATE_CLASSIC_ADAPTER_VERIFIED_AT = '2026-08-09T20:58:03.314Z'
export const CAPTIVATE_CLASSIC_QUALIFIED_SEED_SHA256 =
  'b7869c12cc6ea006d96a19592db69425bc3c51f18245f008aa1013c7949ce60b'
export const CAPTIVATE_CLASSIC_DRIVER_SHA256 =
  'c769900d1735ffa621950f4b756d92979486982aa2361a269df98e6ae41d9a43'
export const CAPTIVATE_CLASSIC_DRIVER_TIMEOUT_MS = 4 * 60 * 60 * 1000
export const CAPTIVATE_EXPORT_RESERVATION_PIPE =
  '\\\\.\\pipe\\compos-a-toast-captivate-native-export-v1'

const DRIVER_SCHEMA_VERSION = 1
const DRIVER_PROFILE = 'classic-11.8.4.21-primary150-unaware-1280x696-v4'
const REQUIRED_CPTX_ENTRIES = ['info.cpi', 'objects/objects.cpo', 'text.cptd'] as const
const CAPTIVATE_CLASSIC_DRIVER_KILL_SIGNAL: NodeJS.Signals = 'SIGTERM'
const CAPTIVATE_EXPORT_BUSY_MESSAGE =
  'Another native Captivate export is already active. Wait for it to finish before starting another Captivate export.'

let captivateExportReservedInProcess = false

const READY_SCOPE = {
  nativeObjects: ['slide', 'text'] as const,
  unsupportedBehavior: 'migration-bundle-review' as const
}

export interface CaptivateAdapterRuntime {
  driverPath: string
  seedCptxPaths: readonly string[]
  platform?: NodeJS.Platform
  powerShellPath?: string
  activityHooks?: CaptivateAdapterActivityHooks
}

export interface CaptivateAdapterActivityOutcome {
  processExitConfirmed: boolean
  processIds: number[]
  helperProcessIds: number[]
}

export interface CaptivateAdapterActivityHooks {
  onStart(): void
  onProgress?(progress: CaptivateAdapterProgress): void
  onFinish(outcome: CaptivateAdapterActivityOutcome): void
}

export interface CaptivateAdapterProbe {
  capability: CaptivateAdapterCapabilityDto
  driverPath?: string
  driverSha256?: string
  seedCptxPath?: string
  seedSha256?: string
}

export interface CaptivateDraftSlide {
  title: string
  subtitle?: string
}

interface CaptivateDriverJob {
  schemaVersion: 1
  mode: 'export'
  executablePath: string
  seedCptxPath: string
  outputCptxPath: string
  expectedSeedSha256: string
  slides: Array<{ title: string; subtitle?: string }>
}

export interface CaptivateAdapterProgress {
  type: 'progress'
  schemaVersion: number
  mode: string
  stage: string
  code?: string
  timestamp?: string
  message?: string
}

interface CaptivateDriverAttestation {
  driverProfile?: string
  desktop?: {
    processDpiAwareness?: number
    logicalDpi?: number
    primaryScalePercent?: number
  }
  captivate?: { path?: string; version?: string; publisher?: string }
  seed?: { path?: string; sha256?: string; unchanged?: boolean }
  requestedSlideCount?: number
  verifiedSlideCount?: number
  markerTitles?: string[]
  output?: { path?: string; sha256?: string; size?: number }
  verificationXml?: { sha256?: string; size?: number }
  processIds?: number[]
  startedAt?: string
  completedAt?: string
  stages?: string[]
  processExitConfirmed?: boolean
  outputPromoted?: boolean
  accessibilityHelperTerminationUnconfirmed?: boolean
  accessibilityHelperProcessId?: number
}

interface CaptivateDriverResult {
  type: 'result'
  schemaVersion: number
  ok: boolean
  mode: string
  stage: string
  error?: { code?: string; message?: string }
  retainedStagingPath?: string
  attestation?: CaptivateDriverAttestation
}

interface DriverExecutionResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** False only when the configured PowerShell process never spawned. */
  spawned: boolean
  /** True only when the fixed outer watchdog stopped the directly spawned PowerShell. */
  timedOut: boolean
}

export interface CaptivateAdapterDependencies {
  runDriver(
    powerShellPath: string,
    driverPath: string,
    jobPath: string,
    onProgress?: (progress: CaptivateAdapterProgress) => void
  ): Promise<DriverExecutionResult>
  qualifiedSeedSha256: string
  qualifiedDriverSha256?: string
  /** Test seam; production always uses the fixed machine-wide reservation. */
  acquireSystemReservation?(): Promise<() => Promise<void>>
}

const systemDependencies: CaptivateAdapterDependencies = {
  runDriver: runPowerShellDriver,
  qualifiedSeedSha256: CAPTIVATE_CLASSIC_QUALIFIED_SEED_SHA256,
  qualifiedDriverSha256: CAPTIVATE_CLASSIC_DRIVER_SHA256,
  acquireSystemReservation: acquireCaptivateSystemReservation
}

export function defaultCaptivateSeedCandidates(
  documentsPath = join(homedir(), 'Documents'),
  appPath?: string
): string[] {
  const candidates = [
    process.env.COMPOS_A_TOAST_CAPTIVATE_SEED_CPTX,
    join(documentsPath, 'My Adobe Captivate Projects', 'untitled1.cptx'),
    appPath
      ? join(
          appPath,
          '.compos-a-toast',
          'captivate-fixtures',
          'captivate-classic-11.8.4.21-baseline.cptx'
        )
      : undefined
  ]

  const seen = new Set<string>()
  return candidates.filter((candidate): candidate is string => {
    if (!candidate?.trim()) return false
    const absolute = resolve(candidate)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function probeCaptivateAdapter(
  detection: CaptivateDetectionDto,
  runtime: CaptivateAdapterRuntime,
  dependencies: CaptivateAdapterDependencies = systemDependencies
): Promise<CaptivateAdapterProbe> {
  if (!detection.detected || !detection.adapterEligible || !detection.path) {
    return {
      capability: {
        state: 'unavailable',
        reason:
          detection.reason ??
          'A signed, supported Adobe Captivate Classic installation is required.'
      }
    }
  }

  if (detection.version !== CAPTIVATE_CLASSIC_ADAPTER_BUILD) {
    return {
      capability: {
        state: 'blocked',
        reason: `The editable-text adapter is qualified only for Captivate Classic ${CAPTIVATE_CLASSIC_ADAPTER_BUILD}; installed build ${detection.version ?? 'unknown'} has not been qualified.`
      }
    }
  }

  if ((runtime.platform ?? process.platform) !== 'win32') {
    return {
      capability: {
        state: 'unavailable',
        reason: 'The Captivate Classic adapter currently requires Windows.'
      }
    }
  }

  if (!(await isRegularFile(runtime.driverPath))) {
    return {
      capability: {
        state: 'unavailable',
        reason: 'The version-pinned Captivate automation driver is missing from this app build.'
      }
    }
  }
  const driverSha256 = await hashFile(runtime.driverPath)
  const qualifiedDriverSha256 = (
    dependencies.qualifiedDriverSha256 ?? CAPTIVATE_CLASSIC_DRIVER_SHA256
  ).toLowerCase()
  if (driverSha256 !== qualifiedDriverSha256) {
    return {
      capability: {
        state: 'unavailable',
        reason:
          'The version-pinned Captivate automation driver failed its integrity check.'
      }
    }
  }

  let foundSeed = false
  for (const candidate of runtime.seedCptxPaths) {
    if (!(await isRegularFile(candidate))) continue
    foundSeed = true
    const seedSha256 = await hashFile(candidate)
    if (seedSha256 !== dependencies.qualifiedSeedSha256.toLowerCase()) continue

    return {
      capability: {
        state: 'ready',
        adapterId: CAPTIVATE_CLASSIC_ADAPTER_ID,
        captivateBuild: CAPTIVATE_CLASSIC_ADAPTER_BUILD,
        verifiedAt: CAPTIVATE_CLASSIC_ADAPTER_VERIFIED_AT,
        scope: {
          nativeObjects: [...READY_SCOPE.nativeObjects],
          unsupportedBehavior: READY_SCOPE.unsupportedBehavior
        }
      },
      driverPath: resolve(runtime.driverPath),
      driverSha256,
      seedCptxPath: resolve(candidate),
      seedSha256
    }
  }

  return {
    capability: {
      state: 'verification-required',
      reason: foundSeed
        ? 'The locally qualified Captivate seed has changed. This beta cannot requalify a seed in the app yet, so native export remains disabled.'
        : 'No locally qualified Captivate seed is available. This developer-local beta does not yet provide a public seed-qualification workflow.'
    }
  }
}

export function createCaptivateDraftSlides(model: CourseModel): CaptivateDraftSlide[] {
  if (model.slides.length === 0) {
    return [
      {
        title: truncateNativeText(
          cleanNativeText(model.settings.title) || 'Recovered course',
          120
        ),
        subtitle: 'Editable Captivate draft - no source slides were recognized'
      }
    ]
  }

  return model.slides.map((slide, index) => {
    const title = truncateNativeText(
      cleanNativeText(slide.title) ||
        firstTextObject(slide.objects.map((object) => object.text)) ||
        `Slide ${index + 1}`,
      120
    )

    if (index !== 0) return { title }

    const sourceText = slide.objects
      .map((object) => cleanNativeText(object.text))
      .filter((value) => value && value !== title)
      .join(' ')
    const subtitle = truncateNativeText(
      sourceText || `Editable Captivate draft - Slide 1 of ${model.slides.length}`,
      180
    )
    return { title, subtitle }
  })
}

export async function acquireCaptivateSystemReservation(
  pipePath = CAPTIVATE_EXPORT_RESERVATION_PIPE
): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') return async () => undefined

  const server = createServer((socket) => socket.destroy())
  server.maxConnections = 0
  let lateServerError: Error | undefined
  const release = await new Promise<() => Promise<void>>((resolvePromise, reject) => {
    const onAcquisitionError = (error: NodeJS.ErrnoException): void => {
      try {
        if (server.listening) server.close()
      } catch {
        // The acquisition error remains authoritative.
      }
      if (error.code === 'EADDRINUSE') {
        reject(captivateReservationError('CAPTIVATE_EXPORT_BUSY', CAPTIVATE_EXPORT_BUSY_MESSAGE))
        return
      }
      const detail = error.code ? ` (${error.code})` : ''
      reject(
        captivateReservationError(
          'CAPTIVATE_EXPORT_RESERVATION_UNAVAILABLE',
          `The system-wide Captivate export reservation could not be established${detail}; no Captivate driver was launched.`
        )
      )
    }

    server.once('error', onAcquisitionError)
    server.listen(
      { path: pipePath, exclusive: true, readableAll: false, writableAll: false },
      () => {
        server.off('error', onAcquisitionError)
        // Client connections are never part of the protocol. Keep a late error listener so
        // an unrelated pipe client cannot turn a reservation into an uncaught exception.
        server.on('error', (error) => {
          lateServerError = error
        })
        let released = false
        resolvePromise(async () => {
          if (released) return
          released = true
          await closeReservationServer(server)
          if (lateServerError) throw lateServerError
        })
      }
    )
  })

  return release
}

export async function exportCaptivateEditableDraft(
  model: CourseModel,
  outputRoot: string,
  migrationBundlePath: string,
  detection: CaptivateDetectionDto,
  probe: CaptivateAdapterProbe,
  runtime: CaptivateAdapterRuntime,
  dependencies: CaptivateAdapterDependencies = systemDependencies
): Promise<ExportedArtifact> {
  const releaseInProcess = acquireCaptivateInProcessReservation()
  const canReachNativePreflight =
    probe.capability.state === 'ready' &&
    Boolean(probe.driverPath && probe.driverSha256 && probe.seedCptxPath)
  if (!canReachNativePreflight) {
    try {
      return await exportReservedCaptivateEditableDraft(
        model,
        outputRoot,
        migrationBundlePath,
        detection,
        probe,
        runtime,
        dependencies
      )
    } finally {
      releaseInProcess()
    }
  }

  let releaseSystem: () => Promise<void>
  try {
    const acquireSystemReservation =
      dependencies.acquireSystemReservation ?? acquireCaptivateSystemReservation
    releaseSystem = await acquireSystemReservation()
  } catch (error) {
    releaseInProcess()
    throw error
  }

  let result: ExportedArtifact | undefined
  let bodyFailed = false
  let bodyError: unknown
  try {
    result = await exportReservedCaptivateEditableDraft(
      model,
      outputRoot,
      migrationBundlePath,
      detection,
      probe,
      runtime,
      dependencies
    )
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }

  let releaseFailed = false
  let releaseError: unknown
  try {
    await releaseSystem()
  } catch (error) {
    releaseFailed = true
    releaseError = error
  } finally {
    releaseInProcess()
  }

  if (bodyFailed && releaseFailed) {
    throw new AggregateError(
      [bodyError, releaseError],
      'The native Captivate export failed and its system-wide reservation also failed to release.'
    )
  }
  if (bodyFailed) throw bodyError
  if (releaseFailed) throw releaseError
  return result!
}

async function exportReservedCaptivateEditableDraft(
  model: CourseModel,
  outputRoot: string,
  migrationBundlePath: string,
  detection: CaptivateDetectionDto,
  probe: CaptivateAdapterProbe,
  runtime: CaptivateAdapterRuntime,
  dependencies: CaptivateAdapterDependencies
): Promise<ExportedArtifact> {
  if (
    probe.capability.state !== 'ready' ||
    !probe.driverPath ||
    !probe.driverSha256 ||
    !probe.seedCptxPath
  ) {
    const reason =
      probe.capability.state === 'ready'
        ? 'The ready adapter is missing its qualified driver or seed path.'
        : probe.capability.reason
    throw new Error(`Native Captivate export is unavailable: ${reason}`)
  }
  if (
    !detection.adapterEligible ||
    detection.version !== probe.capability.captivateBuild ||
    !detection.path
  ) {
    throw new Error('Captivate installation eligibility changed before export; analyze again.')
  }
  const bundleStats = await stat(migrationBundlePath).catch(() => null)
  if (!bundleStats?.isDirectory()) {
    throw new Error('The supporting migration bundle is missing.')
  }
  const currentDriverSha256 = await hashFile(probe.driverPath)
  if (currentDriverSha256 !== probe.driverSha256) {
    throw new Error('The version-pinned Captivate automation driver changed after analysis.')
  }

  const absoluteOutputRoot = resolve(outputRoot)
  const slides = createCaptivateDraftSlides(model)
  if (slides.length > 200) {
    throw new Error(
      `The initial Captivate adapter supports at most 200 native slides; this course contains ${slides.length}.`
    )
  }
  await mkdir(absoluteOutputRoot, { recursive: true })
  const finalPath = await chooseAvailableOutputPath(
    absoluteOutputRoot,
    `${safeFileStem(model.settings.title || model.settings.id)}-captivate-editable-draft.cptx`
  )
  const stagingPath = await mkdtemp(join(absoluteOutputRoot, '.compos-a-toast-captivate-'))
  assertDirectChild(absoluteOutputRoot, stagingPath)

  const stagedCptxPath = join(stagingPath, 'editable-draft.cptx')
  const jobPath = join(stagingPath, 'captivate-driver-job.json')

  const job: CaptivateDriverJob = {
    schemaVersion: DRIVER_SCHEMA_VERSION,
    mode: 'export',
    executablePath: resolve(detection.path),
    seedCptxPath: resolve(probe.seedCptxPath),
    outputCptxPath: stagedCptxPath,
    expectedSeedSha256:
      probe.seedSha256 ?? dependencies.qualifiedSeedSha256.toLowerCase(),
    slides: slides.map((slide) => ({
      title: slide.title,
      ...(slide.subtitle ? { subtitle: slide.subtitle } : {})
    }))
  }

  let cleanupSafe = true
  let retainedPath: string | undefined
  let activityStarted = false
  let processExitConfirmed = false
  let processIds: number[] = []
  let helperProcessIds: number[] = []
  try {
    await writeJson(jobPath, job)
    runtime.activityHooks?.onStart()
    activityStarted = true
    cleanupSafe = false
    const execution = await dependencies.runDriver(
      runtime.powerShellPath ?? windowsPowerShellPath(),
      probe.driverPath,
      jobPath,
      runtime.activityHooks?.onProgress
        ? (progress) => {
            try {
              runtime.activityHooks?.onProgress?.(progress)
            } catch {
              // UI notification failures must never interrupt the authoring driver.
            }
          }
        : undefined
    )
    if (execution.timedOut) {
      throw new Error(
        'The PowerShell automation helper exceeded the four-hour safety limit and was stopped. Adobe Captivate was deliberately not terminated.'
      )
    }
    const { result, progress } = parseDriverOutput(execution.stdout)
    processExitConfirmed =
      result?.attestation?.processExitConfirmed === true || execution.spawned === false
    processIds = (result?.attestation?.processIds ?? []).filter(
      (processId) => Number.isSafeInteger(processId) && processId > 0
    )
    const helperProcessId = result?.attestation?.accessibilityHelperProcessId
    helperProcessIds =
      result?.attestation?.accessibilityHelperTerminationUnconfirmed === true &&
      typeof helperProcessId === 'number' &&
      Number.isSafeInteger(helperProcessId) &&
      helperProcessId > 0
        ? [helperProcessId]
        : []
    retainedPath =
      result?.retainedStagingPath && isSameOrInside(stagingPath, result.retainedStagingPath)
        ? result.retainedStagingPath
        : stagingPath
    if (
      result &&
      !result.ok &&
      result.attestation?.processExitConfirmed === true &&
      !result.retainedStagingPath
    ) {
      cleanupSafe = true
    }
    if (execution.spawned === false) cleanupSafe = true
    assertSuccessfulDriverResult(result, execution, job, slides)
    cleanupSafe = true
    const seedSha256AfterDriver = await hashFile(probe.seedCptxPath)
    if (seedSha256AfterDriver !== job.expectedSeedSha256.toLowerCase()) {
      throw new Error('The qualified Captivate seed changed during the export run.')
    }
    await validateCptx(stagedCptxPath, result.attestation, slides)
    // The staging directory is a direct child of outputRoot, so this hard link is
    // same-volume and atomically fails with EEXIST instead of replacing a file that
    // appeared while Captivate was running. Final cleanup removes the staged name.
    await link(stagedCptxPath, finalPath)

    const diagnostics: DiagnosticDto[] = [
      {
        severity: 'warning',
        code: 'CAPTIVATE_EDITABLE_TEXT_BETA',
        message:
          'Created native editable slides and title text with the verified Captivate Classic 11.8.4 adapter. Images, interactions, detailed layout, and unsupported text remain review work in the migration bundle.',
        source: migrationBundlePath
      },
      {
        severity: 'info',
        code: 'CAPTIVATE_DRIVER_ATTESTED',
        message: `Captivate saved, closed, reopened, and verified ${slides.length} native ${slides.length === 1 ? 'slide' : 'slides'} (${progress.length} recorded automation stages).`
      }
    ]
    return { path: finalPath, diagnostics }
  } catch (error) {
    if (!cleanupSafe) {
      const message = error instanceof Error ? error.message : String(error)
      if (processExitConfirmed) {
        throw new Error(
          `${message} Captivate exited normally, but diagnostic working files were retained at ${retainedPath ?? stagingPath}.`
        )
      }
      throw new Error(
        `${message} Captivate exit was not confirmed, so working files were retained at ${retainedPath ?? stagingPath}. Close Captivate normally before inspecting or removing that folder.`
      )
    }
    throw error
  } finally {
    try {
      if (cleanupSafe) await rm(stagingPath, { recursive: true, force: true })
    } finally {
      if (activityStarted) {
        runtime.activityHooks?.onFinish({ processExitConfirmed, processIds, helperProcessIds })
      }
    }
  }
}

function acquireCaptivateInProcessReservation(): () => void {
  if (captivateExportReservedInProcess) {
    throw captivateReservationError('CAPTIVATE_EXPORT_BUSY', CAPTIVATE_EXPORT_BUSY_MESSAGE)
  }
  captivateExportReservedInProcess = true
  let released = false
  return () => {
    if (released) return
    released = true
    captivateExportReservedInProcess = false
  }
}

function captivateReservationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function closeReservationServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise()
    })
  })
}

function runPowerShellDriver(
  powerShellPath: string,
  driverPath: string,
  jobPath: string,
  onProgress?: (progress: CaptivateAdapterProgress) => void
): Promise<DriverExecutionResult> {
  return new Promise((resolvePromise) => {
    let spawned = false
    const progressParser = createCaptivateProgressStreamParser(onProgress)

    const child = execFile(
      powerShellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        driverPath,
        '-JobPath',
        jobPath
      ],
      {
        encoding: 'utf8',
        env: createWindowsPowerShellEnvironment(powerShellPath),
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        // Electron directs this broad watchdog only at the spawned PowerShell process.
        // Its helper-only kill-on-close job also contains any active accessibility
        // helper, while independently launched Captivate remains outside that job.
        // Staging stays retained and the quit guard polls Captivate afterward.
        timeout: CAPTIVATE_CLASSIC_DRIVER_TIMEOUT_MS,
        killSignal: CAPTIVATE_CLASSIC_DRIVER_KILL_SIGNAL
      },
      (error, stdout, stderr) => {
        progressParser.end()
        const processError = error as NodeJS.ErrnoException & {
          code?: string | number | null
          signal?: NodeJS.Signals
          killed?: boolean
        }
        const timedOut =
          processError?.killed === true &&
          processError.code == null &&
          processError.signal === CAPTIVATE_CLASSIC_DRIVER_KILL_SIGNAL
        resolvePromise({
          exitCode:
            typeof processError?.code === 'number' ? processError.code : error ? null : 0,
          signal: processError?.signal ?? null,
          stdout,
          stderr,
          spawned,
          timedOut
        })
      }
    )

    child.once('spawn', () => {
      spawned = true
    })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => {
      progressParser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
  })
}

export interface CaptivateProgressStreamParser {
  push(chunk: string): void
  end(): void
}

export function createCaptivateProgressStreamParser(
  onProgress?: (progress: CaptivateAdapterProgress) => void
): CaptivateProgressStreamParser {
  let pendingLine = ''
  const emitProgressLine = (rawLine: string): void => {
    const progress = parseDriverProgressLine(rawLine)
    if (!progress || !onProgress) return
    try {
      onProgress(progress)
    } catch {
      // Progress is advisory; a consumer failure cannot stop Captivate automation.
    }
  }
  const flushProgressLines = (chunk: string, flushTail = false): void => {
    pendingLine += chunk
    const lines = pendingLine.split(/\r?\n/)
    pendingLine = lines.pop() ?? ''
    for (const line of lines) emitProgressLine(line)
    if (flushTail && pendingLine.trim()) emitProgressLine(pendingLine)
    if (flushTail) pendingLine = ''
  }
  return {
    push: (chunk) => flushProgressLines(chunk),
    end: () => flushProgressLines('', true)
  }
}

export function parseDriverProgressLine(
  rawLine: string
): CaptivateAdapterProgress | undefined {
  const line = rawLine.trim()
  if (!line) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (
    record.type !== 'progress' ||
    record.schemaVersion !== DRIVER_SCHEMA_VERSION ||
    record.mode !== 'export' ||
    typeof record.stage !== 'string'
  ) {
    return undefined
  }
  const stage = record.stage.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(stage)) return undefined
  if (
    record.message !== undefined &&
    (typeof record.message !== 'string' || record.message.length > 2_000)
  ) {
    return undefined
  }
  if (
    record.code !== undefined &&
    (typeof record.code !== 'string' || record.code.length > 128)
  ) {
    return undefined
  }
  if (
    record.timestamp !== undefined &&
    (typeof record.timestamp !== 'string' || record.timestamp.length > 128)
  ) {
    return undefined
  }
  return { ...(value as CaptivateAdapterProgress), stage }
}

function parseDriverOutput(stdout: string): {
  result: CaptivateDriverResult | undefined
  progress: CaptivateAdapterProgress[]
} {
  const progress: CaptivateAdapterProgress[] = []
  let result: CaptivateDriverResult | undefined

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const progressRecord = parseDriverProgressLine(line)
    if (progressRecord) progress.push(progressRecord)
    if (record.type === 'result') {
      if (result) throw new Error('Captivate driver emitted more than one terminal result.')
      result = value as CaptivateDriverResult
    }
  }
  return { result, progress }
}

function assertSuccessfulDriverResult(
  result: CaptivateDriverResult | undefined,
  execution: DriverExecutionResult,
  job: CaptivateDriverJob,
  slides: CaptivateDraftSlide[]
): asserts result is CaptivateDriverResult & {
  ok: true
  attestation: CaptivateDriverAttestation
} {
  if (!result) {
    throw new Error(
      `Captivate driver did not return an attestation.${execution.stderr.trim() ? ` ${execution.stderr.trim()}` : ''}`
    )
  }
  if (!result.ok) {
    const code = result.error?.code ? ` (${result.error.code})` : ''
    throw new Error(
      `Captivate export failed at ${result.stage}${code}: ${result.error?.message ?? 'The driver reported an unknown failure.'}`
    )
  }
  if (execution.exitCode !== 0 || execution.signal) {
    throw new Error('Captivate driver returned success data but did not exit normally.')
  }
  if (
    result.schemaVersion !== DRIVER_SCHEMA_VERSION ||
    result.mode !== job.mode ||
    result.stage !== 'complete' ||
    !result.attestation
  ) {
    throw new Error('Captivate driver returned an incompatible or incomplete attestation.')
  }

  const attestation = result.attestation
  if (
    attestation.driverProfile !== DRIVER_PROFILE ||
    attestation.desktop?.processDpiAwareness !== 0 ||
    attestation.desktop.logicalDpi !== 96 ||
    attestation.desktop.primaryScalePercent !== 150 ||
    attestation.captivate?.version !== CAPTIVATE_CLASSIC_ADAPTER_BUILD ||
    !samePath(attestation.captivate?.path, job.executablePath) ||
    !/Adobe Inc\.?/i.test(attestation.captivate.publisher ?? '') ||
    attestation.seed?.unchanged !== true ||
    attestation.seed.sha256?.toLowerCase() !== job.expectedSeedSha256.toLowerCase() ||
    !samePath(attestation.seed.path, job.seedCptxPath) ||
    attestation.processExitConfirmed !== true ||
    attestation.outputPromoted !== true ||
    attestation.requestedSlideCount !== slides.length ||
    attestation.verifiedSlideCount !== slides.length ||
    !samePath(attestation.output?.path, job.outputCptxPath)
  ) {
    throw new Error('Captivate driver attestation does not match the requested export.')
  }

  if (
    !/^[a-f\d]{64}$/i.test(attestation.verificationXml?.sha256 ?? '') ||
    !attestation.verificationXml?.size ||
    attestation.verificationXml.size <= 0
  ) {
    throw new Error('Captivate driver did not attest a non-empty XML verification export.')
  }

  const markerTitles = attestation.markerTitles ?? []
  if (
    markerTitles.length !== slides.length ||
    markerTitles.some((title, index) => title !== slides[index]?.title)
  ) {
    throw new Error('Captivate reopened the output, but its native slide titles did not verify.')
  }
}

async function validateCptx(
  cptxPath: string,
  attestation: CaptivateDriverAttestation,
  slides: CaptivateDraftSlide[]
): Promise<void> {
  const fileStats = await lstat(cptxPath)
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.size <= 0) {
    throw new Error('Captivate did not create a regular, non-empty CPTX file.')
  }
  if (attestation.output?.size !== fileStats.size) {
    throw new Error('Generated CPTX size does not match the driver attestation.')
  }
  const outputSha256 = await hashFile(cptxPath)
  if (attestation.output.sha256?.toLowerCase() !== outputSha256) {
    throw new Error('Generated CPTX checksum does not match the driver attestation.')
  }

  const header = Buffer.alloc(4)
  const file = await open(cptxPath, 'r')
  let bytesRead = 0
  try {
    const readResult = await file.read(header, 0, header.length, 0)
    bytesRead = readResult.bytesRead
  } finally {
    await file.close()
  }
  if (bytesRead < 4 || header[0] !== 0x50 || header[1] !== 0x4b) {
    throw new Error('Generated output is not a CPTX ZIP container.')
  }

  const zip = new AdmZip(cptxPath)
  const entryNames = new Set(zip.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/')))
  const missingEntries = REQUIRED_CPTX_ENTRIES.filter((entry) => !entryNames.has(entry))
  if (missingEntries.length > 0) {
    throw new Error(`Generated CPTX is missing required entries: ${missingEntries.join(', ')}`)
  }
  if (slides.length === 0) throw new Error('Captivate export must contain at least one slide.')
}

async function chooseAvailableOutputPath(outputRoot: string, requestedName: string): Promise<string> {
  const extension = extname(requestedName)
  const stem = basename(requestedName, extension)
  for (let index = 1; index <= 10_000; index += 1) {
    const name = index === 1 ? requestedName : `${stem}-${index}${extension}`
    const candidate = join(outputRoot, name)
    assertDirectChild(outputRoot, candidate)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('Could not choose an unused CPTX output filename.')
}

export function createWindowsPowerShellEnvironment(
  powerShellPath: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...sourceEnvironment }
  // PowerShell 7 rewrites PSModulePath with entries that Windows PowerShell 5.1
  // cannot load. Pin the qualified driver to 5.1's signed system modules instead.
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'psmodulepath') delete environment[key]
  }
  environment.PSModulePath = win32.join(win32.dirname(powerShellPath), 'Modules')
  return environment
}

function windowsPowerShellPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function cleanNativeText(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function truncateNativeText(value: string, maxLength: number): string {
  const clean = cleanNativeText(value)
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 3).trimEnd()}...`
}

function firstTextObject(values: string[]): string {
  return values.map(cleanNativeText).find(Boolean) ?? ''
}

function safeFileStem(value: string): string {
  const normalized = cleanNativeText(value)
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const candidate = normalized || 'recovered-course'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate)
    ? `course-${candidate}`
    : candidate
}

function assertDirectChild(parentPath: string, childPath: string): void {
  const relativePath = relative(parentPath, childPath)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    relativePath.includes(sep)
  ) {
    throw new Error(`Unsafe Captivate output path: ${childPath}`)
  }
}

function isSameOrInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath))
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const fileStats = await lstat(filePath)
    return fileStats.isFile() && !fileStats.isSymbolicLink()
  } catch {
    return false
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

// Adapter JSON stays inside the unique staging folder and is removed after the run.
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
}
