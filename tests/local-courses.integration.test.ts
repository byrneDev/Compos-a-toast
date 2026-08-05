import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { exportMigrationBundle } from '../src/core/bundle'
import { analyzeComposicaCourse } from '../src/core/composica'
import { exportScorm12 } from '../src/core/scorm'

const localCourseNames = [
  'Activities',
  'AstroHops',
  'DeepSpace',
  'GameShow',
  'Introduction',
  'MasterPlumber',
  'OfficeErgo'
] as const

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('local ignored reference courses', () => {
  for (const courseName of localCourseNames) {
    const coursePath = resolve(courseName)

    it(`${courseName} parses without executing its runtime`, async (context) => {
      if (!(await exists(coursePath))) {
        context.skip()
        return
      }

      const model = await analyzeComposicaCourse(coursePath)

      expect(model.settings.title.length).toBeGreaterThan(0)
      expect(model.settings.width).toBeGreaterThan(0)
      expect(model.settings.height).toBeGreaterThan(0)
      expect(model.outline.length).toBeGreaterThan(0)
      expect(model.slides.length).toBeGreaterThan(0)
      expect(model.slides.every((slide) => slide.sourceHtml.length > 0)).toBe(true)
      expect(model.assets.every((asset) => asset.relativePath.length > 0)).toBe(true)
    })
  }

  it('exports a representative local course through both working adapters', async (context) => {
    const coursePath = resolve('Activities')
    if (!(await exists(coursePath))) {
      context.skip()
      return
    }

    const outputRoot = await mkdtemp(resolve(tmpdir(), 'compos-a-toast-local-export-'))
    try {
      const model = await analyzeComposicaCourse(coursePath)
      const bundle = await exportMigrationBundle(model, outputRoot)
      const scorm = await exportScorm12(model, outputRoot)

      const bundleInventory = JSON.parse(
        await readFile(resolve(bundle.path, 'inventory.json'), 'utf8')
      ) as { counts: { slides: number } }
      expect(bundleInventory.counts.slides).toBe(model.slides.length)

      const zip = new AdmZip(scorm.path)
      const entries = new Set(zip.getEntries().map((entry) => entry.entryName))
      expect(entries).toContain('imsmanifest.xml')
      expect(entries).toContain('index.html')
      expect(entries).toContain('adlcp_rootv1p2.xsd')
      expect(entries).toContain('imscp_rootv1p1p2.xsd')
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })
})
