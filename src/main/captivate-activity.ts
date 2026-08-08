import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { CaptivateAdapterActivityHooks } from '../core/captivate/adapter'

type IdleListener = () => void
type CaptivateProcessLister = () => Promise<number[]>
type ProcessIdProbe = (processId: number) => Promise<boolean>

export interface CaptivateActivityTrackerOptions {
  listProcessIds?: CaptivateProcessLister
  isProcessIdRunning?: ProcessIdProbe
  pollIntervalMs?: number
}

/**
 * Keeps Electron alive while the version-pinned driver owns Captivate. If a failure
 * cannot prove normal process exit, it polls read-only process state and remains busy
 * until Captivate and any unconfirmed bounded accessibility helper are gone. It never
 * terminates either process.
 */
export class CaptivateActivityTracker {
  private activeRuns = 0
  private exitUnconfirmed = false
  private retainedProcessIds = new Set<number>()
  private retainedHelperProcessIds = new Set<number>()
  private pollTimer: NodeJS.Timeout | undefined
  private readonly idleListeners = new Set<IdleListener>()
  private readonly listProcessIds: CaptivateProcessLister
  private readonly isProcessIdRunning: ProcessIdProbe
  private readonly pollIntervalMs: number

  constructor(options: CaptivateActivityTrackerOptions = {}) {
    this.listProcessIds = options.listProcessIds ?? listCaptivateClassicProcessIds
    this.isProcessIdRunning = options.isProcessIdRunning ?? isProcessRunningReadOnly
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000
  }

  readonly hooks: CaptivateAdapterActivityHooks = {
    onStart: () => {
      this.activeRuns += 1
    },
    onFinish: (outcome) => {
      this.activeRuns = Math.max(0, this.activeRuns - 1)
      if (!outcome.processExitConfirmed || outcome.helperProcessIds.length > 0) {
        this.exitUnconfirmed = true
        for (const processId of outcome.processIds) {
          if (Number.isSafeInteger(processId) && processId > 0) {
            this.retainedProcessIds.add(processId)
          }
        }
        for (const processId of outcome.helperProcessIds) {
          if (Number.isSafeInteger(processId) && processId > 0) {
            this.retainedHelperProcessIds.add(processId)
          }
        }
        this.schedulePoll()
      }
      this.notifyIfIdle()
    }
  }

  isActive(): boolean {
    return this.activeRuns > 0 || this.exitUnconfirmed
  }

  onIdle(listener: IdleListener): () => void {
    this.idleListeners.add(listener)
    return () => this.idleListeners.delete(listener)
  }

  async reconcileNow(): Promise<void> {
    if (!this.exitUnconfirmed) return
    let captivateQuerySucceeded = true
    try {
      const processIds = await this.listProcessIds()
      this.retainedProcessIds = new Set(
        processIds.filter((processId) => Number.isSafeInteger(processId) && processId > 0)
      )
    } catch {
      // A failed read must not relax the quit guard.
      captivateQuerySucceeded = false
    }

    const runningHelpers = new Set<number>()
    for (const processId of this.retainedHelperProcessIds) {
      try {
        if (await this.isProcessIdRunning(processId)) runningHelpers.add(processId)
      } catch {
        // An unreadable helper PID remains retained until a later successful probe.
        runningHelpers.add(processId)
      }
    }
    this.retainedHelperProcessIds = runningHelpers
    if (
      captivateQuerySucceeded &&
      this.retainedProcessIds.size === 0 &&
      this.retainedHelperProcessIds.size === 0
    ) {
      this.exitUnconfirmed = false
    }

    if (this.exitUnconfirmed) this.schedulePoll()
    this.notifyIfIdle()
  }

  private schedulePoll(): void {
    if (this.pollTimer) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.reconcileNow()
    }, this.pollIntervalMs)
    this.pollTimer.unref()
  }

  private notifyIfIdle(): void {
    if (this.isActive()) return
    for (const listener of this.idleListeners) listener()
  }
}

async function isProcessRunningReadOnly(processId: number): Promise<boolean> {
  try {
    // Signal 0 performs an existence/permission probe and does not terminate the process.
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function listCaptivateClassicProcessIds(): Promise<number[]> {
  if (process.platform !== 'win32') return []
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const powerShellPath = join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  try {
    return await listCaptivateWithPowerShell(powerShellPath)
  } catch {
    // tasklist.exe is an independent read-only fallback. In particular, a missing or
    // policy-blocked PowerShell must not leave Electron's quit guard latched forever.
    return listCaptivateWithTasklist(join(windowsRoot, 'System32', 'tasklist.exe'))
  }
}

function listCaptivateWithPowerShell(powerShellPath: string): Promise<number[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      powerShellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[PSCustomObject]@{ ids = @(Get-Process -Name 'AdobeCaptivateClassic' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id }) } | ConvertTo-Json -Compress"
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as {
            ids?: number | Array<number | null> | null
          }
          resolvePromise(
            Array.isArray(parsed.ids)
              ? parsed.ids.filter(
                  (processId): processId is number => typeof processId === 'number'
                )
              : typeof parsed.ids === 'number'
                ? [parsed.ids]
                : []
          )
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

function listCaptivateWithTasklist(tasklistPath: string): Promise<number[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      tasklistPath,
      ['/FI', 'IMAGENAME eq AdobeCaptivateClassic.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 32 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        const processIds = stdout
          .split(/\r?\n/)
          .map((line) =>
            /^"AdobeCaptivateClassic\.exe","(\d+)"/i.exec(line.trim())?.[1]
          )
          .filter((value): value is string => Boolean(value))
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0)
        resolvePromise(processIds)
      }
    )
  })
}
