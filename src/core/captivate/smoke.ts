import { spawn, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'

export type CaptivateSmokeErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PROJECT_EXTENSION'
  | 'EXECUTABLE_NOT_FILE'
  | 'SOURCE_NOT_FILE'
  | 'SOURCE_CHANGED'
  | 'CLONE_HASH_MISMATCH'
  | 'CLOSE_NOT_CONFIRMED'
  | 'PROCESS_RUNNING'
  | 'LOCK_PRESENT'

export class CaptivateSmokeError extends Error {
  readonly code: CaptivateSmokeErrorCode

  constructor(code: CaptivateSmokeErrorCode, message: string) {
    super(message)
    this.name = 'CaptivateSmokeError'
    this.code = code
  }
}

export interface CaptivateProcessReference {
  readonly pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  once(event: 'spawn' | 'error', listener: (...args: any[]) => void): this
  off(event: 'spawn' | 'error', listener: (...args: any[]) => void): this
}

export interface CaptivateSmokeDependencies {
  platform: NodeJS.Platform
  temporaryRoot(): string
  isRegularFile(path: string): Promise<boolean>
  ensureDirectory(path: string): Promise<void>
  createTemporaryDirectory(prefix: string): Promise<string>
  copyFileExclusive(source: string, destination: string): Promise<void>
  hashFile(path: string): Promise<string>
  pathExists(path: string): Promise<boolean>
  removeDirectory(path: string): Promise<void>
  spawnProcess(
    executablePath: string,
    args: readonly [string],
    options: SpawnOptions
  ): CaptivateProcessReference
}

export interface CaptivateSmokeOptions {
  /** A Captivate executable already approved by the version/signature detector. */
  verifiedExecutablePath: string
  sourceCptxPath: string
  /** Parent for the disposable directory. Defaults to the operating-system temp directory. */
  workspaceRoot?: string
  dependencies?: Partial<CaptivateSmokeDependencies>
}

export interface PreparedCaptivateSmokeClone {
  verifiedExecutablePath: string
  sourceCptxPath: string
  disposableDirectory: string
  cloneCptxPath: string
  lockPath: string
  hashes: {
    sourceBeforeCopy: string
    sourceAfterCopy: string
    clone: string
  }
}

export interface CaptivateOpenSmokeSession extends PreparedCaptivateSmokeClone {
  process: CaptivateProcessReference
  /**
   * Removes only the unique disposable directory. It deliberately refuses to
   * run until the caller confirms that Captivate has released the project.
   */
  cleanup(confirmation?: CaptivateCleanupConfirmation): Promise<void>
}

export interface CaptivateCleanupConfirmation {
  /** Caller verified that no Captivate window/process owns the disposable project. */
  projectClosed: true
  /** Caller verified that a remaining .cpl marker is stale and not held open. */
  staleLockVerified?: boolean
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const systemDependencies: CaptivateSmokeDependencies = {
  platform: process.platform,
  temporaryRoot: tmpdir,
  isRegularFile,
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true })
  },
  createTemporaryDirectory: (prefix) => mkdtemp(prefix),
  copyFileExclusive: async (source, destination) => {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  },
  hashFile,
  pathExists,
  removeDirectory: async (path) => {
    await rm(path, { recursive: true })
  },
  spawnProcess: (executablePath, args, options) =>
    spawn(executablePath, [...args], options)
}

function resolveDependencies(
  overrides: Partial<CaptivateSmokeDependencies> | undefined
): CaptivateSmokeDependencies {
  return { ...systemDependencies, ...overrides }
}

function waitForProcessStart(processReference: CaptivateProcessReference): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      processReference.off('error', onError)
      resolve()
    }
    const onError = (error: Error): void => {
      processReference.off('spawn', onSpawn)
      reject(error)
    }

    processReference.once('spawn', onSpawn)
    processReference.once('error', onError)
  })
}

async function rethrowAfterCloneCleanup(
  error: unknown,
  disposableDirectory: string,
  dependencies: CaptivateSmokeDependencies
): Promise<never> {
  try {
    await dependencies.removeDirectory(disposableDirectory)
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `The Captivate smoke operation failed and its disposable clone could not be removed: ${disposableDirectory}`
    )
  }

  throw error
}

function requireWindows(dependencies: CaptivateSmokeDependencies): void {
  if (dependencies.platform !== 'win32') {
    throw new CaptivateSmokeError(
      'UNSUPPORTED_PLATFORM',
      'Captivate open-smoke sessions require Adobe Captivate Classic on Windows.'
    )
  }
}

async function validateInputs(
  options: CaptivateSmokeOptions,
  dependencies: CaptivateSmokeDependencies
): Promise<void> {
  requireWindows(dependencies)

  if (extname(options.sourceCptxPath).toLowerCase() !== '.cptx') {
    throw new CaptivateSmokeError(
      'INVALID_PROJECT_EXTENSION',
      'The source project must have a .cptx extension.'
    )
  }

  if (!(await dependencies.isRegularFile(options.verifiedExecutablePath))) {
    throw new CaptivateSmokeError(
      'EXECUTABLE_NOT_FILE',
      'The verified Captivate executable path is not a regular file.'
    )
  }

  if (!(await dependencies.isRegularFile(options.sourceCptxPath))) {
    throw new CaptivateSmokeError(
      'SOURCE_NOT_FILE',
      'The source CPTX path is not a regular file.'
    )
  }
}

/** Returns the sibling lock name Captivate Classic uses for an open CPTX. */
export function captivateLockPath(cptxPath: string): string {
  const project = parse(cptxPath)
  return join(dirname(cptxPath), `~${project.name}.cpl`)
}

async function prepareClone(
  options: CaptivateSmokeOptions,
  dependencies: CaptivateSmokeDependencies
): Promise<PreparedCaptivateSmokeClone> {
  const resolvedOptions: CaptivateSmokeOptions = {
    ...options,
    verifiedExecutablePath: resolve(options.verifiedExecutablePath),
    sourceCptxPath: resolve(options.sourceCptxPath),
    workspaceRoot: options.workspaceRoot ? resolve(options.workspaceRoot) : undefined
  }
  await validateInputs(resolvedOptions, dependencies)

  const sourceBeforeCopy = await dependencies.hashFile(resolvedOptions.sourceCptxPath)
  const parentDirectory = resolve(
    resolvedOptions.workspaceRoot ?? dependencies.temporaryRoot()
  )
  await dependencies.ensureDirectory(parentDirectory)

  const disposableDirectory = await dependencies.createTemporaryDirectory(
    join(parentDirectory, 'captivate-open-smoke-')
  )
  const cloneCptxPath = join(
    disposableDirectory,
    basename(resolvedOptions.sourceCptxPath)
  )

  try {
    await dependencies.copyFileExclusive(resolvedOptions.sourceCptxPath, cloneCptxPath)

    const clone = await dependencies.hashFile(cloneCptxPath)
    const sourceAfterCopy = await dependencies.hashFile(resolvedOptions.sourceCptxPath)

    if (sourceAfterCopy !== sourceBeforeCopy) {
      throw new CaptivateSmokeError(
        'SOURCE_CHANGED',
        'The source CPTX changed while its disposable smoke-test copy was being prepared.'
      )
    }

    if (clone !== sourceBeforeCopy) {
      throw new CaptivateSmokeError(
        'CLONE_HASH_MISMATCH',
        'The disposable CPTX copy does not match the source SHA-256 hash.'
      )
    }

    return {
      verifiedExecutablePath: resolvedOptions.verifiedExecutablePath,
      sourceCptxPath: resolvedOptions.sourceCptxPath,
      disposableDirectory,
      cloneCptxPath,
      lockPath: captivateLockPath(cloneCptxPath),
      hashes: { sourceBeforeCopy, sourceAfterCopy, clone }
    }
  } catch (error) {
    return rethrowAfterCloneCleanup(error, disposableDirectory, dependencies)
  }
}

/**
 * Copies a CPTX byte-for-byte and launches that disposable copy in Captivate.
 * This function intentionally does not automate, save, or close Captivate.
 */
export async function launchCaptivateOpenSmoke(
  options: CaptivateSmokeOptions
): Promise<CaptivateOpenSmokeSession> {
  const dependencies = resolveDependencies(options.dependencies)
  const prepared = await prepareClone(options, dependencies)

  let processReference: CaptivateProcessReference
  try {
    processReference = dependencies.spawnProcess(
      prepared.verifiedExecutablePath,
      [prepared.cloneCptxPath],
      {
        cwd: prepared.disposableDirectory,
        detached: false,
        shell: false,
        windowsHide: false
      }
    )
    await waitForProcessStart(processReference)
  } catch (error) {
    return rethrowAfterCloneCleanup(error, prepared.disposableDirectory, dependencies)
  }

  let cleaned = false
  return {
    ...prepared,
    process: processReference,
    cleanup: async (confirmation) => {
      if (cleaned) return

      if (!confirmation?.projectClosed) {
        throw new CaptivateSmokeError(
          'CLOSE_NOT_CONFIRMED',
          'Confirm that Captivate released the disposable project before cleanup.'
        )
      }

      if (processReference.exitCode === null && processReference.signalCode === null) {
        throw new CaptivateSmokeError(
          'PROCESS_RUNNING',
          'The Captivate process is still running; close it before cleaning up the disposable copy.'
        )
      }

      if (
        (await dependencies.pathExists(prepared.lockPath)) &&
        !confirmation.staleLockVerified
      ) {
        throw new CaptivateSmokeError(
          'LOCK_PRESENT',
          'A Captivate .cpl marker remains. Verify that it is stale and unlocked before cleanup.'
        )
      }

      await dependencies.removeDirectory(prepared.disposableDirectory)
      cleaned = true
    }
  }
}
