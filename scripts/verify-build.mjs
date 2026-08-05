import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const mainPath = path.join(projectRoot, 'out', 'main', 'index.js')
const preloadPath = path.join(projectRoot, 'out', 'preload', 'index.cjs')
const rendererPath = path.join(projectRoot, 'out', 'renderer', 'index.html')
const obsoletePreloadPath = path.join(projectRoot, 'out', 'preload', 'index.mjs')

await Promise.all([mainPath, preloadPath, rendererPath].map((filePath) => access(filePath)))

const [mainSource, preloadSource] = await Promise.all([
  readFile(mainPath, 'utf8'),
  readFile(preloadPath, 'utf8')
])

if (!mainSource.includes('../preload/index.cjs')) {
  throw new Error('The Electron main bundle does not point to the CommonJS preload bridge.')
}

if (!/\brequire\(["']electron["']\)/.test(preloadSource)) {
  throw new Error('The preload bridge is not a bundled CommonJS script.')
}

try {
  await access(obsoletePreloadPath)
  throw new Error('An obsolete ESM preload remains in the production output.')
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
}

console.log('Verified production main, sandboxed CommonJS preload, and renderer entry points.')
