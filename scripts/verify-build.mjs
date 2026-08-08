import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const mainPath = path.join(projectRoot, 'out', 'main', 'index.js')
const preloadPath = path.join(projectRoot, 'out', 'preload', 'index.cjs')
const rendererPath = path.join(projectRoot, 'out', 'renderer', 'index.html')
const obsoletePreloadPath = path.join(projectRoot, 'out', 'preload', 'index.mjs')
const captivateDriverSourcePath = path.join(
  projectRoot,
  'src',
  'core',
  'captivate',
  'classic-11.8.4-driver.ps1'
)
const packagePath = path.join(projectRoot, 'package.json')

await Promise.all(
  [mainPath, preloadPath, rendererPath, captivateDriverSourcePath].map((filePath) =>
    access(filePath)
  )
)

const [mainSource, preloadSource, packageSource, captivateDriverSource] = await Promise.all([
  readFile(mainPath, 'utf8'),
  readFile(preloadPath, 'utf8'),
  readFile(packagePath, 'utf8'),
  readFile(captivateDriverSourcePath)
])

const captivateDriverSha256 = createHash('sha256')
  .update(captivateDriverSource)
  .digest('hex')
if (!mainSource.includes(captivateDriverSha256)) {
  throw new Error('The main bundle does not contain the current Captivate driver hash.')
}

const packageMetadata = JSON.parse(packageSource)
const captivateDriverResource = packageMetadata.build?.extraResources?.find(
  (resource) =>
    resource.from === 'src/core/captivate/classic-11.8.4-driver.ps1' &&
    resource.to === 'captivate/classic-11.8.4-driver.ps1'
)

if (!captivateDriverResource) {
  throw new Error('The Captivate Classic driver is not mapped into packaged resources.')
}

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

console.log(
  'Verified production entries and the Captivate Classic driver packaging configuration.'
)
