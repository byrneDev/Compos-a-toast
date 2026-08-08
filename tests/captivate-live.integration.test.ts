import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import {
  defaultCaptivateSeedCandidates,
  probeCaptivateAdapter,
  type CaptivateAdapterRuntime
} from '../src/core/captivate/adapter'
import { detectCaptivate } from '../src/core/captivate/detect'
import { exportCourse } from '../src/main/course-service'

const runLive = process.env.COMPOS_A_TOAST_RUN_CAPTIVATE_LIVE === '1'
const liveDescribe = runLive ? describe : describe.skip
const execFileAsync = promisify(execFile)

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function runningCaptivateProcessIds(): Promise<number[]> {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const powerShell = join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const { stdout } = await execFileAsync(
    powerShell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[PSCustomObject]@{ ids = @(Get-Process -Name 'AdobeCaptivateClassic' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id }) } | ConvertTo-Json -Compress"
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  const parsed = JSON.parse(stdout.trim()) as { ids: Array<number | null> | number | null }
  if (Array.isArray(parsed.ids)) {
    return parsed.ids.filter((processId): processId is number => typeof processId === 'number')
  }
  return typeof parsed.ids === 'number' ? [parsed.ids] : []
}

liveDescribe('live Captivate Classic adapter', () => {
  it('creates, closes, reopens, and verifies the synthetic four-slide CPTX', async () => {
    const projectRoot = resolve('.')
    const driverPath = join(
      projectRoot,
      'src',
      'core',
      'captivate',
      'classic-11.8.4-driver.ps1'
    )
    const seedCptxPaths = defaultCaptivateSeedCandidates(
      join(process.env.USERPROFILE ?? '', 'Documents'),
      projectRoot
    )
    const runtime: CaptivateAdapterRuntime = {
      driverPath,
      seedCptxPaths,
      platform: 'win32',
      activityHooks: {
        onStart: () => process.stdout.write('CAPTIVATE_LIVE started\n'),
        onProgress: (progress) =>
          process.stdout.write(
            `CAPTIVATE_LIVE ${progress.stage}${progress.code ? ` ${progress.code}` : ''}\n`
          ),
        onFinish: (outcome) =>
          process.stdout.write(
            `CAPTIVATE_LIVE finished processExitConfirmed=${outcome.processExitConfirmed}\n`
          )
      }
    }
    const detection = await detectCaptivate()
    const probe = await probeCaptivateAdapter(detection, runtime)
    expect(probe.capability.state).toBe('ready')
    expect(probe.seedCptxPath).toBeTruthy()
    expect(await runningCaptivateProcessIds()).toEqual([])

    const seedPath = probe.seedCptxPath!
    const seedHashBefore = await sha256(seedPath)
    const outputRoot = await mkdtemp(join(tmpdir(), 'compos-a-toast-captivate-live-'))
    let safeToClean = false

    try {
      const result = await exportCourse(
        {
          sourcePath: resolve('tests/fixtures/synthetic-course'),
          outputPath: outputRoot,
          targets: ['captivate']
        },
        { captivate: runtime }
      )
      const captivateArtifact = result.artifacts.find((artifact) => artifact.target === 'captivate')
      if (captivateArtifact?.status !== 'created' || !captivateArtifact.path) {
        throw new Error(
          `Live Captivate export failed; retained output: ${outputRoot}. ${captivateArtifact?.message ?? 'No Captivate artifact was returned.'}`
        )
      }

      expect(result.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: 'migration-bundle', status: 'created' }),
          expect.objectContaining({ target: 'captivate', status: 'created' })
        ])
      )
      const zip = new AdmZip(captivateArtifact.path)
      const entries = new Set(zip.getEntries().map((entry) => entry.entryName))
      expect(entries.has('info.cpi')).toBe(true)
      expect(entries.has('objects/objects.cpo')).toBe(true)
      expect(entries.has('text.cptd')).toBe(true)
      expect(await sha256(seedPath)).toBe(seedHashBefore)
      expect(await runningCaptivateProcessIds()).toEqual([])
      safeToClean = true
    } finally {
      if (safeToClean) await rm(outputRoot, { recursive: true, force: true })
    }
  })
})
