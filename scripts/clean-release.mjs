import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
export const projectRoot = path.resolve(path.dirname(scriptPath), '..')

function samePath(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isNotFound(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function resolveReleaseOutput(root = projectRoot) {
  const resolvedRoot = path.resolve(root)
  const releasePath = path.resolve(resolvedRoot, 'release')
  if (
    !samePath(path.dirname(releasePath), resolvedRoot) ||
    path.basename(releasePath) !== 'release' ||
    samePath(releasePath, resolvedRoot)
  ) {
    throw new Error('Refusing to resolve a release output outside the project root.')
  }
  return releasePath
}

async function assertOrdinaryReleaseTree(releasePath, canonicalReleasePath, candidate) {
  const item = await lstat(candidate)
  if (item.isSymbolicLink()) {
    throw new Error(`Refusing to clean release output containing a symbolic link: ${candidate}`)
  }

  const relativePath = path.relative(releasePath, candidate)
  const expectedCanonicalPath = path.resolve(canonicalReleasePath, relativePath)
  const actualCanonicalPath = await realpath(candidate)
  if (!samePath(actualCanonicalPath, expectedCanonicalPath)) {
    throw new Error(`Refusing to clean release output containing a reparse-like path: ${candidate}`)
  }

  if (!item.isDirectory()) return
  const entries = await readdir(candidate, { withFileTypes: true })
  for (const entry of entries) {
    await assertOrdinaryReleaseTree(
      releasePath,
      canonicalReleasePath,
      path.join(candidate, entry.name)
    )
  }
}

export async function cleanReleaseOutput(root = projectRoot) {
  const resolvedRoot = path.resolve(root)
  const releasePath = resolveReleaseOutput(resolvedRoot)

  let releaseStats
  try {
    releaseStats = await lstat(releasePath)
  } catch (error) {
    if (isNotFound(error)) return { removed: false, releasePath }
    throw error
  }

  if (!releaseStats.isDirectory() || releaseStats.isSymbolicLink()) {
    throw new Error('Refusing to clean release output because it is not an ordinary directory.')
  }

  const canonicalRoot = await realpath(resolvedRoot)
  const expectedCanonicalRelease = path.join(canonicalRoot, 'release')
  const canonicalRelease = await realpath(releasePath)
  if (!samePath(canonicalRelease, expectedCanonicalRelease)) {
    throw new Error('Refusing to clean release output because it resolves outside the project root.')
  }

  await assertOrdinaryReleaseTree(releasePath, canonicalRelease, releasePath)

  // Re-attest the deletion root after walking it. This does not remove every possible
  // filesystem race, but it fails closed if the root was swapped for a link or junction.
  const finalStats = await lstat(releasePath)
  const finalCanonicalRelease = await realpath(releasePath)
  if (
    !finalStats.isDirectory() ||
    finalStats.isSymbolicLink() ||
    !samePath(finalCanonicalRelease, canonicalRelease)
  ) {
    throw new Error('Refusing to clean release output because it changed during validation.')
  }

  await rm(releasePath, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 })
  return { removed: true, releasePath }
}

const invokedDirectly = process.argv[1] && samePath(process.argv[1], scriptPath)
if (invokedDirectly) {
  try {
    const result = await cleanReleaseOutput()
    console.log(
      result.removed
        ? `Removed generated release output: ${result.releasePath}`
        : `No generated release output to remove: ${result.releasePath}`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
