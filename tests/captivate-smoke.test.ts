import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captivateLockPath,
  launchCaptivateOpenSmoke,
  type CaptivateProcessReference,
  type CaptivateSmokeDependencies
} from '../src/core/captivate/smoke'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'compos-a-toast-smoke-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function processReference(
  values: Partial<Pick<CaptivateProcessReference, 'pid' | 'exitCode' | 'signalCode'>> = {}
): CaptivateProcessReference & EventEmitter {
  return Object.assign(new EventEmitter(), {
    pid: values.pid,
    exitCode: values.exitCode ?? null,
    signalCode: values.signalCode ?? null
  }) as CaptivateProcessReference & EventEmitter
}

function successfulSpawn(reference: CaptivateProcessReference & EventEmitter) {
  return (): CaptivateProcessReference => {
    queueMicrotask(() => reference.emit('spawn'))
    return reference
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('captivateLockPath', () => {
  it('uses Captivate Classic\'s sibling ~basename.cpl convention', () => {
    expect(captivateLockPath(join('C:\\work', 'Lesson.One.cptx'))).toBe(
      join('C:\\work', '~Lesson.One.cpl')
    )
  })

  it.runIf(process.platform === 'win32')('uses the literal Windows sibling path', () => {
    expect(captivateLockPath('C:\\work\\Lesson.One.cptx')).toBe(
      'C:\\work\\~Lesson.One.cpl'
    )
  })
})

describe('launchCaptivateOpenSmoke', () => {
  it('copies byte-for-byte and launches the exact executable with only the clone argument', async () => {
    const root = await temporaryDirectory()
    const workspaceRoot = join(root, 'workspace')
    const executablePath = join(root, 'AdobeCaptivateClassic.exe')
    const sourceCptxPath = join(root, 'sample.cptx')
    const sourceBytes = Buffer.from('synthetic CPTX bytes that must remain unchanged')
    await writeFile(executablePath, 'synthetic executable')
    await writeFile(sourceCptxPath, sourceBytes)

    const child = processReference({ pid: 1234 })
    const spawnProcess = vi.fn(successfulSpawn(child))
    const session = await launchCaptivateOpenSmoke({
      verifiedExecutablePath: executablePath,
      sourceCptxPath,
      workspaceRoot,
      dependencies: { platform: 'win32', spawnProcess }
    })

    expect(session.cloneCptxPath).not.toBe(sourceCptxPath)
    expect(basename(session.cloneCptxPath)).toBe('sample.cptx')
    expect(await readFile(session.cloneCptxPath)).toEqual(sourceBytes)
    expect(await readFile(sourceCptxPath)).toEqual(sourceBytes)
    expect(session.hashes.sourceBeforeCopy).toMatch(/^[a-f0-9]{64}$/)
    expect(session.hashes).toEqual({
      sourceBeforeCopy: session.hashes.sourceBeforeCopy,
      sourceAfterCopy: session.hashes.sourceBeforeCopy,
      clone: session.hashes.sourceBeforeCopy
    })
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(spawnProcess).toHaveBeenCalledWith(
      executablePath,
      [session.cloneCptxPath],
      expect.objectContaining({
        cwd: session.disposableDirectory,
        detached: false,
        shell: false,
        windowsHide: false
      })
    )
    expect(session.lockPath).toBe(join(session.disposableDirectory, '~sample.cpl'))
  })

  it('requires close confirmation and explicit verification of a stale lock marker', async () => {
    const root = await temporaryDirectory()
    const executablePath = join(root, 'AdobeCaptivateClassic.exe')
    const sourceCptxPath = join(root, 'sample.cptx')
    await writeFile(executablePath, 'synthetic executable')
    await writeFile(sourceCptxPath, 'synthetic CPTX')

    const child = processReference()
    const session = await launchCaptivateOpenSmoke({
      verifiedExecutablePath: executablePath,
      sourceCptxPath,
      workspaceRoot: root,
      dependencies: {
        platform: 'win32',
        spawnProcess: successfulSpawn(child)
      }
    })

    await expect(session.cleanup()).rejects.toMatchObject({
      code: 'CLOSE_NOT_CONFIRMED'
    })
    await expect(session.cleanup({ projectClosed: true })).rejects.toMatchObject({
      code: 'PROCESS_RUNNING'
    })
    await expect(stat(session.disposableDirectory)).resolves.toBeDefined()

    child.exitCode = 0
    await writeFile(session.lockPath, 'lock')
    await expect(session.cleanup({ projectClosed: true })).rejects.toMatchObject({
      code: 'LOCK_PRESENT'
    })
    await expect(stat(session.disposableDirectory)).resolves.toBeDefined()

    await session.cleanup({ projectClosed: true, staleLockVerified: true })
    await expect(stat(session.disposableDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(session.cleanup({ projectClosed: true })).resolves.toBeUndefined()
  })

  it('rejects non-Windows hosts before touching either input', async () => {
    const isRegularFile = vi.fn(async () => true)

    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: '/applications/Captivate',
        sourceCptxPath: '/courses/course.cptx',
        dependencies: {
          platform: 'darwin',
          isRegularFile,
          spawnProcess: vi.fn()
        }
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' })
    expect(isRegularFile).not.toHaveBeenCalled()
  })

  it('requires a .cptx regular file and a regular executable file', async () => {
    const root = await temporaryDirectory()
    const executablePath = join(root, 'AdobeCaptivateClassic.exe')
    const wrongExtension = join(root, 'course.zip')
    await writeFile(executablePath, 'synthetic executable')
    await writeFile(wrongExtension, 'synthetic project')

    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: executablePath,
        sourceCptxPath: wrongExtension,
        dependencies: { platform: 'win32', spawnProcess: vi.fn() }
      })
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_EXTENSION' })

    const sourceDirectory = join(root, 'directory.cptx')
    await mkdir(sourceDirectory)
    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: executablePath,
        sourceCptxPath: sourceDirectory,
        dependencies: { platform: 'win32', spawnProcess: vi.fn() }
      })
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FILE' })

    const executableDirectory = join(root, 'Captivate.exe')
    await mkdir(executableDirectory)
    const sourceCptxPath = join(root, 'course.cptx')
    await writeFile(sourceCptxPath, 'synthetic project')
    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: executableDirectory,
        sourceCptxPath,
        dependencies: { platform: 'win32', spawnProcess: vi.fn() }
      })
    ).rejects.toMatchObject({ code: 'EXECUTABLE_NOT_FILE' })
  })

  it.each([
    {
      name: 'source changes during preparation',
      hashes: ['before', 'before', 'after'],
      code: 'SOURCE_CHANGED'
    },
    {
      name: 'clone differs from its stable source',
      hashes: ['source', 'clone', 'source'],
      code: 'CLONE_HASH_MISMATCH'
    }
  ] as const)('removes the disposable directory when $name', async ({ hashes, code }) => {
    const root = await temporaryDirectory()
    const disposableDirectory = join(root, 'captivate-open-smoke-fixed')
    const removeDirectory = vi.fn(async () => undefined)
    const hashFile = vi.fn()
    for (const hash of hashes) hashFile.mockResolvedValueOnce(hash)

    const dependencies: Partial<CaptivateSmokeDependencies> = {
      platform: 'win32',
      isRegularFile: async () => true,
      temporaryRoot: () => root,
      ensureDirectory: async () => undefined,
      createTemporaryDirectory: async () => disposableDirectory,
      copyFileExclusive: async () => undefined,
      hashFile,
      removeDirectory,
      spawnProcess: vi.fn()
    }

    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: join(root, 'Captivate.exe'),
        sourceCptxPath: join(root, 'course.cptx'),
        dependencies
      })
    ).rejects.toMatchObject({ code })
    expect(removeDirectory).toHaveBeenCalledOnce()
    expect(removeDirectory).toHaveBeenCalledWith(disposableDirectory)
    expect(dependencies.spawnProcess).not.toHaveBeenCalled()
  })

  it('waits for the child spawn event and cleans up an asynchronous launch error', async () => {
    const root = await temporaryDirectory()
    const executablePath = join(root, 'AdobeCaptivateClassic.exe')
    const sourceCptxPath = join(root, 'sample.cptx')
    await writeFile(executablePath, 'synthetic executable')
    await writeFile(sourceCptxPath, 'synthetic CPTX')

    const child = processReference()
    const launchError = Object.assign(new Error('blocked executable'), { code: 'EACCES' })
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', launchError))
      return child
    })

    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: executablePath,
        sourceCptxPath,
        workspaceRoot: root,
        dependencies: { platform: 'win32', spawnProcess }
      })
    ).rejects.toBe(launchError)

    expect((await readdir(root)).filter((name) => name.startsWith('captivate-open-smoke-')))
      .toEqual([])
  })

  it('cleans up when the process launcher throws synchronously', async () => {
    const root = await temporaryDirectory()
    const executablePath = join(root, 'AdobeCaptivateClassic.exe')
    const sourceCptxPath = join(root, 'sample.cptx')
    await writeFile(executablePath, 'synthetic executable')
    await writeFile(sourceCptxPath, 'synthetic CPTX')
    const launchError = new Error('process launcher failed')

    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: executablePath,
        sourceCptxPath,
        workspaceRoot: root,
        dependencies: {
          platform: 'win32',
          spawnProcess: () => {
            throw launchError
          }
        }
      })
    ).rejects.toBe(launchError)

    expect((await readdir(root)).filter((name) => name.startsWith('captivate-open-smoke-')))
      .toEqual([])
  })

  it('reports the disposable path when failed-operation cleanup also fails', async () => {
    const disposableDirectory = 'C:\\safe-root\\captivate-open-smoke-fixed'
    const launchError = new Error('launch failed')
    const cleanupError = new Error('cleanup failed')
    const child = processReference()

    await expect(
      launchCaptivateOpenSmoke({
        verifiedExecutablePath: 'C:\\Adobe\\Captivate.exe',
        sourceCptxPath: 'C:\\fixtures\\course.cptx',
        workspaceRoot: 'C:\\safe-root',
        dependencies: {
          platform: 'win32',
          isRegularFile: async () => true,
          ensureDirectory: async () => undefined,
          createTemporaryDirectory: async () => disposableDirectory,
          copyFileExclusive: async () => undefined,
          hashFile: async () => 'same-hash',
          removeDirectory: async () => {
            throw cleanupError
          },
          spawnProcess: () => {
            queueMicrotask(() => child.emit('error', launchError))
            return child
          }
        }
      })
    ).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining(disposableDirectory),
      errors: [launchError, cleanupError]
    })
  })

  it('resolves relative inputs once before validation and launch', async () => {
    const root = await temporaryDirectory()
    const executablePath = join(root, 'AdobeCaptivateClassic.exe')
    const sourceCptxPath = join(root, 'sample.cptx')
    await writeFile(executablePath, 'synthetic executable')
    await writeFile(sourceCptxPath, 'synthetic CPTX')
    const relativeExecutable = relative(process.cwd(), executablePath)
    const relativeSource = relative(process.cwd(), sourceCptxPath)
    const child = processReference({ pid: 9876 })
    const spawnProcess = vi.fn(successfulSpawn(child))

    const session = await launchCaptivateOpenSmoke({
      verifiedExecutablePath: relativeExecutable,
      sourceCptxPath: relativeSource,
      workspaceRoot: root,
      dependencies: { platform: 'win32', spawnProcess }
    })

    expect(session.verifiedExecutablePath).toBe(resolve(relativeExecutable))
    expect(session.sourceCptxPath).toBe(resolve(relativeSource))
    expect(spawnProcess).toHaveBeenCalledWith(
      resolve(relativeExecutable),
      [session.cloneCptxPath],
      expect.any(Object)
    )
  })
})
