import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeComposicaCourse } from '../src/core/composica'
import {
  CAPTIVATE_CLASSIC_ADAPTER_BUILD,
  CAPTIVATE_CLASSIC_DRIVER_TIMEOUT_MS,
  CAPTIVATE_EXPORT_RESERVATION_PIPE,
  acquireCaptivateSystemReservation,
  createWindowsPowerShellEnvironment,
  createCaptivateProgressStreamParser,
  createCaptivateDraftSlides,
  exportCaptivateEditableDraft,
  probeCaptivateAdapter,
  type CaptivateAdapterDependencies,
  type CaptivateAdapterRuntime
} from '../src/core/captivate/adapter'
import { exportCourse } from '../src/main/course-service'
import type { CaptivateDetectionDto } from '../src/shared/contracts'

const syntheticCourse = resolve('tests/fixtures/synthetic-course')
const disposableRoots: string[] = []

afterEach(async () => {
  for (const root of disposableRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<{
  root: string
  outputRoot: string
  bundlePath: string
  runtime: CaptivateAdapterRuntime
  seedHash: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'compos-a-toast-adapter-test-'))
  disposableRoots.push(root)
  const executablePath = join(root, 'AdobeCaptivateClassic.exe')
  const driverPath = join(root, 'classic-11.8.4-driver.ps1')
  const seedCptxPath = join(root, 'seed.cptx')
  const outputRoot = join(root, 'output')
  const bundlePath = join(outputRoot, 'course-migration-bundle')
  await Promise.all([
    writeFile(executablePath, 'signed Captivate fixture'),
    writeFile(driverPath, '# test driver fixture'),
    writeFile(seedCptxPath, 'qualified seed fixture'),
    mkdir(bundlePath, { recursive: true })
  ])
  const seedHash = createHash('sha256').update('qualified seed fixture').digest('hex')
  return {
    root,
    outputRoot,
    bundlePath,
    runtime: {
      driverPath,
      seedCptxPaths: [seedCptxPath],
      platform: 'win32',
      powerShellPath: join(root, 'powershell.exe')
    },
    seedHash
  }
}

function detection(executablePath: string): CaptivateDetectionDto {
  return {
    detected: true,
    path: executablePath,
    product: 'classic',
    version: CAPTIVATE_CLASSIC_ADAPTER_BUILD,
    productName: 'Adobe Captivate Classic',
    signatureVerified: true,
    versionSupported: true,
    adapterEligible: true
  }
}

function probeReservationPipeInChild(pipePath: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const script = `
const net = require('node:net')
const server = net.createServer((socket) => socket.destroy())
server.once('error', (error) => {
  process.stdout.write(error.code || 'ERROR')
  process.exit(0)
})
server.listen({ path: ${JSON.stringify(pipePath)}, exclusive: true }, () => {
  process.stdout.write('ACQUIRED')
  server.close(() => process.exit(0))
})
`
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ['--input-type=commonjs', '-e', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      (error, stdout, stderr) => {
        const processError = error as (Error & { code?: string | number }) | null
        const exitCode =
          typeof processError?.code === 'number'
            ? processError.code
            : error
              ? 1
              : 0
        resolvePromise({ exitCode, stdout, stderr })
      }
    )
  })
}

function fakeSuccessfulDependencies(seedHash: string): CaptivateAdapterDependencies {
  return {
    qualifiedSeedSha256: seedHash,
    acquireSystemReservation: async () => async () => undefined,
    qualifiedDriverSha256: createHash('sha256')
      .update('# test driver fixture')
      .digest('hex'),
    runDriver: async (_powerShellPath, _driverPath, jobPath) => {
      const job = JSON.parse(await readFile(jobPath, 'utf8')) as {
        mode: string
        executablePath: string
        seedCptxPath: string
        outputCptxPath: string
        expectedSeedSha256: string
        slides: Array<{ title: string; subtitle?: string }>
      }
      const zip = new AdmZip()
      zip.addFile('info.cpi', Buffer.from('fixture info'))
      zip.addFile('objects/objects.cpo', Buffer.from('fixture objects'))
      zip.addFile('text.cptd', Buffer.from(job.slides.map((slide) => slide.title).join('\n')))
      zip.writeZip(job.outputCptxPath)
      const output = await readFile(job.outputCptxPath)
      const outputStats = await stat(job.outputCptxPath)
      const result = {
        type: 'result',
        schemaVersion: 1,
        ok: true,
        mode: job.mode,
        stage: 'complete',
        attestation: {
          driverProfile: 'classic-11.8.4.21-primary150-unaware-1280x696-v4',
          desktop: {
            processDpiAwareness: 0,
            logicalDpi: 96,
            primaryScalePercent: 150
          },
          captivate: {
            path: job.executablePath,
            version: CAPTIVATE_CLASSIC_ADAPTER_BUILD,
            publisher: 'Adobe Inc.'
          },
          seed: {
            path: job.seedCptxPath,
            sha256: job.expectedSeedSha256,
            unchanged: true
          },
          requestedSlideCount: job.slides.length,
          verifiedSlideCount: job.slides.length,
          markerTitles: job.slides.map((slide) => slide.title),
          output: {
            path: job.outputCptxPath,
            sha256: createHash('sha256').update(output).digest('hex'),
            size: outputStats.size
          },
          verificationXml: {
            sha256: createHash('sha256').update('xml').digest('hex'),
            size: 3
          },
          processExitConfirmed: true,
          outputPromoted: true
        }
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: [
          JSON.stringify({
            type: 'progress',
            schemaVersion: 1,
            mode: 'export',
            stage: 'save',
            message: 'Saved fixture.'
          }),
          JSON.stringify(result)
        ].join('\n'),
        stderr: '',
        spawned: true,
        timedOut: false
      }
    }
  }
}

describe('Captivate Classic adapter qualification', () => {
  it('pins Windows PowerShell to its trusted module directory', () => {
    const powerShellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const environment = createWindowsPowerShellEnvironment(powerShellPath, {
      Path: 'C:\\Windows\\System32',
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      psmodulepath: 'C:\\untrusted-modules'
    })

    expect(environment.Path).toBe('C:\\Windows\\System32')
    expect(
      Object.keys(environment).filter((key) => key.toLowerCase() === 'psmodulepath')
    ).toEqual(['PSModulePath'])
    expect(environment.PSModulePath).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
    )
  })

  it('uses a broad direct-PowerShell watchdog without a Captivate tree kill', async () => {
    const source = await readFile(resolve('src/core/captivate/adapter.ts'), 'utf8')

    expect(CAPTIVATE_CLASSIC_DRIVER_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000)
    expect(source).toMatch(/timeout: CAPTIVATE_CLASSIC_DRIVER_TIMEOUT_MS/)
    expect(source).toMatch(/killSignal: CAPTIVATE_CLASSIC_DRIVER_KILL_SIGNAL/)
    expect(source).toMatch(/processError\?\.killed === true/)
    expect(source).toMatch(/if \(execution\.timedOut\)/)
    expect(source).not.toMatch(/taskkill|\/T['"`]|process-tree|AdobeCaptivateClassic.*kill/i)
  })

  it('reports ready only when the exact driver, build, and qualified seed are present', async () => {
    const testFixture = await fixture()
    const result = await probeCaptivateAdapter(
      detection(join(testFixture.root, 'AdobeCaptivateClassic.exe')),
      testFixture.runtime,
      fakeSuccessfulDependencies(testFixture.seedHash)
    )

    expect(result.capability).toMatchObject({
      state: 'ready',
      captivateBuild: CAPTIVATE_CLASSIC_ADAPTER_BUILD,
      scope: { nativeObjects: ['slide', 'text'] }
    })
    expect(result.seedSha256).toBe(testFixture.seedHash)
  })

  it('requires verification when a seed exists but its fingerprint changed', async () => {
    const testFixture = await fixture()
    const result = await probeCaptivateAdapter(
      detection(join(testFixture.root, 'AdobeCaptivateClassic.exe')),
      testFixture.runtime,
      {
        ...fakeSuccessfulDependencies(testFixture.seedHash),
        qualifiedSeedSha256: '0'.repeat(64)
      }
    )

    expect(result.capability).toMatchObject({ state: 'verification-required' })
    if (result.capability.state !== 'ready') {
      expect(result.capability.reason).toMatch(/qualified.*seed has changed/i)
    }
  })

  it('rejects a Captivate driver whose content does not match the pinned hash', async () => {
    const testFixture = await fixture()
    const result = await probeCaptivateAdapter(
      detection(join(testFixture.root, 'AdobeCaptivateClassic.exe')),
      testFixture.runtime,
      {
        ...fakeSuccessfulDependencies(testFixture.seedHash),
        qualifiedDriverSha256: '0'.repeat(64)
      }
    )

    expect(result.capability).toMatchObject({ state: 'unavailable' })
    if (result.capability.state !== 'ready') {
      expect(result.capability.reason).toMatch(/driver failed its integrity check/i)
    }
  })

  it('blocks a build that was not live-qualified for this driver', async () => {
    const testFixture = await fixture()
    const result = await probeCaptivateAdapter(
      { ...detection(join(testFixture.root, 'AdobeCaptivateClassic.exe')), version: '11.8.3.8' },
      testFixture.runtime,
      fakeSuccessfulDependencies(testFixture.seedHash)
    )

    expect(result.capability).toMatchObject({ state: 'blocked' })
  })
})

describe('Captivate editable-text draft export', () => {
  it.runIf(process.platform === 'win32')(
    'holds one system-wide Windows reservation and releases it for another process',
    async () => {
      const pipePath = `${CAPTIVATE_EXPORT_RESERVATION_PIPE}-${process.pid}-${Date.now()}`
      const release = await acquireCaptivateSystemReservation(pipePath)
      try {
        await expect(acquireCaptivateSystemReservation(pipePath)).rejects.toMatchObject({
          code: 'CAPTIVATE_EXPORT_BUSY'
        })
        const blockedChild = await probeReservationPipeInChild(pipePath)
        expect(blockedChild).toEqual({ exitCode: 0, stdout: 'EADDRINUSE', stderr: '' })
      } finally {
        await release()
      }

      const availableChild = await probeReservationPipeInChild(pipePath)
      expect(availableChild).toEqual({ exitCode: 0, stdout: 'ACQUIRED', stderr: '' })
    },
    30_000
  )

  it.runIf(process.platform === 'win32')(
    'clears the local reservation when another process already owns the system lease',
    async () => {
      const testFixture = await fixture()
      const dependencies = fakeSuccessfulDependencies(testFixture.seedHash)
      const pipePath = `${CAPTIVATE_EXPORT_RESERVATION_PIPE}-${process.pid}-${Date.now()}`
      let driverRuns = 0
      const systemLockingDependencies: CaptivateAdapterDependencies = {
        ...dependencies,
        acquireSystemReservation: () => acquireCaptivateSystemReservation(pipePath),
        runDriver: async (...arguments_) => {
          driverRuns += 1
          return dependencies.runDriver(...arguments_)
        }
      }
      const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
      const probe = await probeCaptivateAdapter(detected, testFixture.runtime, dependencies)
      const model = await analyzeComposicaCourse(syntheticCourse)
      const releaseExternalLease = await acquireCaptivateSystemReservation(pipePath)
      try {
        await expect(
          exportCaptivateEditableDraft(
            model,
            testFixture.outputRoot,
            testFixture.bundlePath,
            detected,
            probe,
            testFixture.runtime,
            systemLockingDependencies
          )
        ).rejects.toMatchObject({ code: 'CAPTIVATE_EXPORT_BUSY' })
        expect(driverRuns).toBe(0)
      } finally {
        await releaseExternalLease()
      }

      await expect(
        exportCaptivateEditableDraft(
          model,
          testFixture.outputRoot,
          testFixture.bundlePath,
          detected,
          probe,
          testFixture.runtime,
          systemLockingDependencies
        )
      ).resolves.toMatchObject({ path: expect.stringMatching(/\.cptx$/) })
      expect(driverRuns).toBe(1)
    },
    30_000
  )

  it('atomically rejects a concurrent native export while bundle and SCORM work continue', async () => {
    const testFixture = await fixture()
    const successfulDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    let allowDriverToFinish!: () => void
    const driverGate = new Promise<void>((resolvePromise) => {
      allowDriverToFinish = resolvePromise
    })
    let driverEntered!: () => void
    const driverStarted = new Promise<void>((resolvePromise) => {
      driverEntered = resolvePromise
    })
    let driverRuns = 0
    const blockingDependencies: CaptivateAdapterDependencies = {
      ...successfulDependencies,
      runDriver: async (powerShellPath, driverPath, jobPath, onProgress) => {
        driverRuns += 1
        driverEntered()
        await driverGate
        return successfulDependencies.runDriver(
          powerShellPath,
          driverPath,
          jobPath,
          onProgress
        )
      }
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(
      detected,
      testFixture.runtime,
      successfulDependencies
    )
    const model = await analyzeComposicaCourse(syntheticCourse)
    let firstSettled = false
    const firstExport = exportCaptivateEditableDraft(
      model,
      testFixture.outputRoot,
      testFixture.bundlePath,
      detected,
      probe,
      testFixture.runtime,
      blockingDependencies
    )
    void firstExport.then(
      () => {
        firstSettled = true
      },
      () => {
        firstSettled = true
      }
    )
    await driverStarted

    try {
      await expect(
        exportCaptivateEditableDraft(
          model,
          testFixture.outputRoot,
          testFixture.bundlePath,
          detected,
          probe,
          testFixture.runtime,
          blockingDependencies
        )
      ).rejects.toMatchObject({ code: 'CAPTIVATE_EXPORT_BUSY' })
      expect(driverRuns).toBe(1)

      const [bundleOnly, scormOnly] = await Promise.all([
        exportCourse({
          sourcePath: syntheticCourse,
          outputPath: join(testFixture.root, 'concurrent-bundle-output'),
          targets: ['migration-bundle']
        }),
        exportCourse({
          sourcePath: syntheticCourse,
          outputPath: join(testFixture.root, 'concurrent-scorm-output'),
          targets: ['scorm12']
        })
      ])
      expect(bundleOnly.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: 'migration-bundle', status: 'created' })
        ])
      )
      expect(scormOnly.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: 'scorm12', status: 'created' })
        ])
      )
      expect(firstSettled).toBe(false)
    } finally {
      allowDriverToFinish()
    }

    await expect(firstExport).resolves.toMatchObject({
      path: expect.stringMatching(/\.cptx$/)
    })
  })

  it('releases both reservations after a failed Captivate preflight', async () => {
    const testFixture = await fixture()
    const dependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, testFixture.runtime, dependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        { ...detected, adapterEligible: false },
        probe,
        testFixture.runtime,
        dependencies
      )
    ).rejects.toThrow(/eligibility changed/i)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        testFixture.runtime,
        dependencies
      )
    ).resolves.toMatchObject({ path: expect.stringMatching(/\.cptx$/) })
  })

  it('maps every recovered slide to a native title and gives the first slide a subtitle', async () => {
    const model = await analyzeComposicaCourse(syntheticCourse)
    const slides = createCaptivateDraftSlides(model)

    expect(slides).toHaveLength(model.slides.length)
    expect(slides.every((slide) => slide.title.length > 0)).toBe(true)
    expect(slides[0]?.subtitle).toBeTruthy()
    expect(slides.slice(1).every((slide) => slide.subtitle === undefined)).toBe(true)
  })

  it('bounds a long fallback title before it reaches the UI automation protocol', async () => {
    const model = structuredClone(await analyzeComposicaCourse(syntheticCourse))
    model.slides[0]!.title = ''
    model.slides[0]!.objects[0]!.text = 'A'.repeat(900)

    const [firstSlide] = createCaptivateDraftSlides(model)

    expect(firstSlide?.title).toHaveLength(120)
    expect(firstSlide?.title.endsWith('...')).toBe(true)
  })

  it('accepts only an attested CPTX, moves it to a direct output child, and removes staging', async () => {
    const testFixture = await fixture()
    const dependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, testFixture.runtime, dependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    const result = await exportCaptivateEditableDraft(
      model,
      testFixture.outputRoot,
      testFixture.bundlePath,
      detected,
      probe,
      testFixture.runtime,
      dependencies
    )

    expect(result.path).toMatch(/-captivate-editable-draft\.cptx$/)
    expect((await stat(result.path)).isFile()).toBe(true)
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'CAPTIVATE_DRIVER_ATTESTED'
    )
    expect((await readdir(testFixture.outputRoot)).some((name) => name.startsWith('.compos-a-toast-captivate-'))).toBe(false)
  })

  it('never overwrites a final path that appears while Captivate is running', async () => {
    const testFixture = await fixture()
    const successfulDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const competingPath = join(
      testFixture.outputRoot,
      'Synthetic-Migration-Course-captivate-editable-draft.cptx'
    )
    const collisionDependencies: CaptivateAdapterDependencies = {
      ...successfulDependencies,
      runDriver: async (powerShellPath, driverPath, jobPath) => {
        const execution = await successfulDependencies.runDriver(
          powerShellPath,
          driverPath,
          jobPath
        )
        await writeFile(competingPath, 'created by another process')
        return execution
      }
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(
      detected,
      testFixture.runtime,
      successfulDependencies
    )
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        testFixture.runtime,
        collisionDependencies
      )
    ).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(competingPath, 'utf8')).toBe('created by another process')
    expect(
      (await readdir(testFixture.outputRoot)).some((name) =>
        name.startsWith('.compos-a-toast-captivate-')
      )
    ).toBe(false)
  })

  it('forwards driver progress while the driver is still running', async () => {
    const testFixture = await fixture()
    const successfulDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    let driverResolved = false
    let progressArrivedBeforeResolution = false
    const stages: string[] = []
    const runtime: CaptivateAdapterRuntime = {
      ...testFixture.runtime,
      activityHooks: {
        onStart: () => undefined,
        onProgress: (progress) => {
          stages.push(progress.stage)
          progressArrivedBeforeResolution ||= !driverResolved
        },
        onFinish: () => undefined
      }
    }
    const dependencies: CaptivateAdapterDependencies = {
      ...successfulDependencies,
      runDriver: async (powerShellPath, driverPath, jobPath, onProgress) => {
        onProgress?.({
          type: 'progress',
          schemaVersion: 1,
          mode: 'export',
          stage: 'await-continue-trial',
          message:
            'In the verified Adobe Captivate trial window, choose Continue Trial (or Continue Offline if that is the label Adobe shows). Do not choose Try Again or close Captivate.'
        })
        const execution = await successfulDependencies.runDriver(
          powerShellPath,
          driverPath,
          jobPath
        )
        driverResolved = true
        return execution
      }
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, runtime, dependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    await exportCaptivateEditableDraft(
      model,
      testFixture.outputRoot,
      testFixture.bundlePath,
      detected,
      probe,
      runtime,
      dependencies
    )

    expect(stages).toContain('await-continue-trial')
    expect(progressArrivedBeforeResolution).toBe(true)
  })

  it('does not leave a fake CPTX when the driver reports failure', async () => {
    const testFixture = await fixture()
    const successDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const failureDependencies: CaptivateAdapterDependencies = {
      ...successDependencies,
      runDriver: async () => ({
        exitCode: 1,
        signal: null,
        stdout: JSON.stringify({
          type: 'result',
          schemaVersion: 1,
          ok: false,
          mode: 'export',
          stage: 'save-output',
          error: { code: 'TEST_FAILURE', message: 'Captivate did not save.' },
          attestation: { processExitConfirmed: true }
        }),
        stderr: '',
        spawned: true,
        timedOut: false
      })
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, testFixture.runtime, successDependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        testFixture.runtime,
        failureDependencies
      )
    ).rejects.toThrow(/TEST_FAILURE.*Captivate did not save/i)

    expect((await readdir(testFixture.outputRoot)).some((name) => name.endsWith('.cptx'))).toBe(false)
    expect((await readdir(testFixture.outputRoot)).some((name) => name.startsWith('.compos-a-toast-captivate-'))).toBe(false)
  })

  it('treats a PowerShell spawn failure as confirmed safe without latching the quit guard', async () => {
    const testFixture = await fixture()
    const successfulDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const finished: Array<{
      processExitConfirmed: boolean
      processIds: number[]
      helperProcessIds: number[]
    }> = []
    const runtime: CaptivateAdapterRuntime = {
      ...testFixture.runtime,
      activityHooks: {
        onStart: () => undefined,
        onFinish: (outcome) => finished.push(outcome)
      }
    }
    const spawnFailureDependencies: CaptivateAdapterDependencies = {
      ...successfulDependencies,
      runDriver: async () => ({
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'PowerShell executable not found',
        spawned: false,
        timedOut: false
      })
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, runtime, successfulDependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        runtime,
        spawnFailureDependencies
      )
    ).rejects.toThrow(/did not return an attestation/i)

    expect(finished).toEqual([
      { processExitConfirmed: true, processIds: [], helperProcessIds: [] }
    ])
    expect(
      (await readdir(testFixture.outputRoot)).some((name) =>
        name.startsWith('.compos-a-toast-captivate-')
      )
    ).toBe(false)
  })

  it('retains staging and reports unconfirmed Captivate exit when the outer PowerShell watchdog fires', async () => {
    const testFixture = await fixture()
    const successfulDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const finished: Array<{
      processExitConfirmed: boolean
      processIds: number[]
      helperProcessIds: number[]
    }> = []
    const runtime: CaptivateAdapterRuntime = {
      ...testFixture.runtime,
      activityHooks: {
        onStart: () => undefined,
        onFinish: (outcome) => finished.push(outcome)
      }
    }
    const timeoutDependencies: CaptivateAdapterDependencies = {
      ...successfulDependencies,
      runDriver: async () => ({
        exitCode: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        spawned: true,
        timedOut: true
      })
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, runtime, successfulDependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        runtime,
        timeoutDependencies
      )
    ).rejects.toThrow(/four-hour safety limit.*Captivate.*not terminated.*exit was not confirmed/is)

    expect(finished).toEqual([
      { processExitConfirmed: false, processIds: [], helperProcessIds: [] }
    ])
    expect((await readdir(testFixture.outputRoot)).some((name) => name.endsWith('.cptx'))).toBe(
      false
    )
    expect(
      (await readdir(testFixture.outputRoot)).some((name) =>
        name.startsWith('.compos-a-toast-captivate-')
      )
    ).toBe(true)
  })

  it('independently rejects a driver success claim if the qualified seed changed', async () => {
    const testFixture = await fixture()
    const successDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const dishonestDependencies: CaptivateAdapterDependencies = {
      ...successDependencies,
      runDriver: async (powerShellPath, driverPath, jobPath) => {
        const execution = await successDependencies.runDriver(
          powerShellPath,
          driverPath,
          jobPath
        )
        const job = JSON.parse(await readFile(jobPath, 'utf8')) as { seedCptxPath: string }
        await writeFile(job.seedCptxPath, 'changed seed fixture')
        return execution
      }
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(
      detected,
      testFixture.runtime,
      successDependencies
    )
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        testFixture.runtime,
        dishonestDependencies
      )
    ).rejects.toThrow(/seed changed during the export run/i)
    expect((await readdir(testFixture.outputRoot)).some((name) => name.endsWith('.cptx'))).toBe(false)
  })

  it('retains the exact working folder when Captivate exit is not confirmed', async () => {
    const testFixture = await fixture()
    const successDependencies = fakeSuccessfulDependencies(testFixture.seedHash)
    const finished: Array<{
      processExitConfirmed: boolean
      processIds: number[]
      helperProcessIds: number[]
    }> = []
    const runtime: CaptivateAdapterRuntime = {
      ...testFixture.runtime,
      activityHooks: {
        onStart: () => undefined,
        onFinish: (outcome) => finished.push(outcome)
      }
    }
    const unsafeFailureDependencies: CaptivateAdapterDependencies = {
      ...successDependencies,
      runDriver: async (_powerShellPath, _driverPath, jobPath) => {
        const retainedStagingPath = join(dirname(jobPath), '.captivate-driver-retained')
        await mkdir(retainedStagingPath)
        return {
          exitCode: 1,
          signal: null,
          stdout: JSON.stringify({
            type: 'result',
            schemaVersion: 1,
            ok: false,
            mode: 'export',
            stage: 'close-project',
            error: { code: 'PROCESS_EXIT_TIMEOUT', message: 'Captivate is still responsive.' },
            retainedStagingPath,
            attestation: {
              processExitConfirmed: false,
              accessibilityHelperTerminationUnconfirmed: true,
              accessibilityHelperProcessId: 2468
            }
          }),
          stderr: '',
          spawned: true,
          timedOut: false
        }
      }
    }
    const detected = detection(join(testFixture.root, 'AdobeCaptivateClassic.exe'))
    const probe = await probeCaptivateAdapter(detected, testFixture.runtime, successDependencies)
    const model = await analyzeComposicaCourse(syntheticCourse)

    await expect(
      exportCaptivateEditableDraft(
        model,
        testFixture.outputRoot,
        testFixture.bundlePath,
        detected,
        probe,
        runtime,
        unsafeFailureDependencies
      )
    ).rejects.toThrow(/exit was not confirmed.*working files were retained/i)

    expect((await readdir(testFixture.outputRoot)).some((name) => name.startsWith('.compos-a-toast-captivate-'))).toBe(true)
    expect(finished).toEqual([
      { processExitConfirmed: false, processIds: [], helperProcessIds: [2468] }
    ])
  })
})

describe('Captivate progress stream protocol', () => {
  it('reassembles chunked NDJSON and forwards only the exact export schema', () => {
    const stages: string[] = []
    const parser = createCaptivateProgressStreamParser((progress) => {
      stages.push(progress.stage)
    })
    const valid = JSON.stringify({
      type: 'progress',
      schemaVersion: 1,
      mode: 'export',
      stage: 'await-continue-trial',
      message: 'Choose Continue Trial.'
    })
    const wrongSchema = JSON.stringify({
      type: 'progress',
      schemaVersion: 2,
      mode: 'export',
      stage: 'await-continue-trial'
    })
    const wrongMode = JSON.stringify({
      type: 'progress',
      schemaVersion: 1,
      mode: 'verify',
      stage: 'await-continue-trial'
    })

    parser.push(valid.slice(0, 23))
    parser.push(`${valid.slice(23)}\r`)
    parser.push(`\n${wrongSchema}\n${wrongMode}\n`)
    parser.push(
      JSON.stringify({
        type: 'progress',
        schemaVersion: 1,
        mode: 'export',
        stage: 'save-output'
      })
    )
    parser.end()

    expect(stages).toEqual(['await-continue-trial', 'save-output'])
  })

  it('rejects empty, malformed, or oversized safety-sensitive progress fields', () => {
    const stages: string[] = []
    const parser = createCaptivateProgressStreamParser((progress) => {
      stages.push(progress.stage)
    })

    for (const record of [
      { type: 'progress', schemaVersion: 1, mode: 'export', stage: '' },
      { type: 'progress', schemaVersion: 1, mode: 'export', stage: '../trial' },
      {
        type: 'progress',
        schemaVersion: 1,
        mode: 'export',
        stage: 'await-continue-trial',
        message: 'x'.repeat(2_001)
      }
    ]) {
      parser.push(`${JSON.stringify(record)}\n`)
    }
    parser.end()

    expect(stages).toEqual([])
  })
})
