import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve('.')

describe('framework-free Electron renderer', () => {
  it('does not ship React or JSX tooling', async () => {
    const [packageSource, viteSource, tsconfigSource, rendererEntries] = await Promise.all([
      readFile(resolve(projectRoot, 'package.json'), 'utf8'),
      readFile(resolve(projectRoot, 'electron.vite.config.ts'), 'utf8'),
      readFile(resolve(projectRoot, 'tsconfig.web.json'), 'utf8'),
      readdir(resolve(projectRoot, 'src/renderer/src'))
    ])
    const packageManifest = JSON.parse(packageSource) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const installedPackages = {
      ...packageManifest.dependencies,
      ...packageManifest.devDependencies
    }

    expect(installedPackages).not.toHaveProperty('react')
    expect(installedPackages).not.toHaveProperty('react-dom')
    expect(installedPackages).not.toHaveProperty('@vitejs/plugin-react')
    expect(viteSource).not.toMatch(/plugin-react|\breact\s*\(/i)
    expect(tsconfigSource).not.toMatch(/"jsx"|\.tsx/i)
    expect(rendererEntries.some((entry) => entry.endsWith('.tsx'))).toBe(false)
  })

  it('uses a vanilla TypeScript entry and avoids unsafe HTML injection', async () => {
    const [html, rendererSource] = await Promise.all([
      readFile(resolve(projectRoot, 'src/renderer/index.html'), 'utf8'),
      readFile(resolve(projectRoot, 'src/renderer/src/main.ts'), 'utf8')
    ])

    expect(html).toContain('src="/src/main.ts"')
    expect(html).not.toContain('main.tsx')
    expect(rendererSource).not.toMatch(/\.innerHTML\b|insertAdjacentHTML\b/)
    expect(rendererSource).toMatch(/textContent/)
  })
})
