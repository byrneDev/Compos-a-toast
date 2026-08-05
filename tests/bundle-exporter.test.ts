import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { exportMigrationBundle } from '../src/core/bundle'
import { COURSE_MODEL_VERSION, type CourseModel } from '../src/core/model'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('exportMigrationBundle', () => {
  it('writes an editable, path-safe, evidence-preserving per-slide bundle', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'compos-a-toast-bundle-'))
    temporaryDirectories.push(temporaryRoot)

    const sourceRoot = path.join(temporaryRoot, 'legacy course')
    const projectRoot = path.join(sourceRoot, 'Content', 'Projects', 'Res')
    const pagePath = path.join(projectRoot, 'Pages', 'page-one.html')
    const masterPath = path.join(projectRoot, 'master', 'main.html')
    const masterBadge = path.join(projectRoot, 'library', 'master-badge.svg')
    const themePath = path.join(sourceRoot, 'Content', 'Themes', 'course.css')
    const firstImage = path.join(sourceRoot, 'assets', 'first', 'picture.png')
    const secondImage = path.join(sourceRoot, 'assets', 'second', 'picture.png')
    const flashEvidence = path.join(sourceRoot, 'assets', 'legacy.swf')
    const missingImage = path.join(sourceRoot, 'assets', 'missing.png')
    const outsideFile = path.join(temporaryRoot, 'outside-secret.txt')
    const outputRoot = path.join(temporaryRoot, 'exports')

    await Promise.all([
      mkdir(path.dirname(pagePath), { recursive: true }),
      mkdir(path.dirname(masterPath), { recursive: true }),
      mkdir(path.dirname(masterBadge), { recursive: true }),
      mkdir(path.dirname(themePath), { recursive: true }),
      mkdir(path.dirname(firstImage), { recursive: true }),
      mkdir(path.dirname(secondImage), { recursive: true }),
      mkdir(path.dirname(flashEvidence), { recursive: true })
    ])

    const originalPage = '<!doctype html><html><body><h1>Original evidence</h1></body></html>'
    await Promise.all([
      writeFile(pagePath, originalPage, 'utf8'),
      writeFile(masterPath, '<gm:box><img src="../library/master-badge.svg">Master evidence</gm:box>', 'utf8'),
      writeFile(masterBadge, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
      writeFile(themePath, 'body { color: #123456; }', 'utf8'),
      writeFile(firstImage, Buffer.from([0x01, 0x02, 0x03])),
      writeFile(secondImage, Buffer.from([0x04, 0x05, 0x06])),
      writeFile(flashEvidence, Buffer.from('FWS inert test evidence', 'ascii')),
      writeFile(outsideFile, 'must not be copied', 'utf8')
    ])

    const model = buildCourseModel({
      sourceRoot,
      projectRoot,
      pagePath,
      masterPath,
      themePath,
      firstImage,
      secondImage,
      flashEvidence,
      missingImage,
      outsideFile
    })

    const firstExport = await exportMigrationBundle(model, outputRoot)
    const secondExport = await exportMigrationBundle(model, outputRoot)

    expect(secondExport.path).toBe(firstExport.path)
    expect(path.basename(firstExport.path)).toMatch(
      /^con-course-cafe-[a-f0-9]{8}-migration-bundle$/
    )

    const slideRoot = path.join(firstExport.path, 'slides', '0001-welcome-overview')
    const requiredPaths = [
      'manifest.json',
      'inventory.json',
      'course.json',
      'captivate-job.json',
      'shared-assets/inventory.json',
      'reports/inventory.html',
      'reports/unsupported.csv',
      'reports/checksums.json',
      'slides/0001-welcome-overview/slide.json',
      'slides/0001-welcome-overview/reconstruction.md',
      'slides/0001-welcome-overview/source/page.html',
      'slides/0001-welcome-overview/source/master.html',
      'slides/0001-welcome-overview/source/theme.css',
      'slides/0001-welcome-overview/content/text.json',
      'slides/0001-welcome-overview/content/objects.json',
      'slides/0001-welcome-overview/content/navigation.json',
      'slides/0001-welcome-overview/interactions/interactions.json'
    ]
    for (const relativePath of requiredPaths) {
      await expect(readFile(path.join(firstExport.path, relativePath))).resolves.toBeInstanceOf(
        Buffer
      )
    }

    expect(await readFile(path.join(slideRoot, 'source', 'page.html'), 'utf8')).toBe(
      originalPage
    )

    const slideJson = JSON.parse(
      await readFile(path.join(slideRoot, 'slide.json'), 'utf8')
    ) as {
      sourceEvidence: string
      objects: Array<{
        proposedCaptivateName: string
        confidence: string
      }>
      interactions: Array<{
        proposedCaptivateName: string
        confidence: string
      }>
    }
    expect(slideJson.sourceEvidence).toBe('original')
    expect(slideJson.objects).toHaveLength(4)
    for (const object of slideJson.objects) {
      expect(object.proposedCaptivateName).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
      expect(object.proposedCaptivateName.length).toBeLessThanOrEqual(64)
      expect(['exact', 'inferred', 'unresolved']).toContain(object.confidence)
    }
    expect(slideJson.objects.map((object) => object.confidence)).toEqual([
      'exact',
      'exact',
      'inferred',
      'unresolved'
    ])
    expect(slideJson.interactions.map((interaction) => interaction.confidence)).toEqual([
      'exact',
      'unresolved'
    ])

    const slideAssetNames = await readdir(path.join(slideRoot, 'assets'))
    const copiedPictures = slideAssetNames.filter((name) => name.endsWith('.png'))
    expect(copiedPictures).toHaveLength(2)
    expect(new Set(copiedPictures).size).toBe(2)
    const copiedContents = await Promise.all(
      copiedPictures.map((name) => readFile(path.join(slideRoot, 'assets', name), 'hex'))
    )
    expect(new Set(copiedContents)).toEqual(new Set(['010203', '040506']))
    expect(await readdir(path.join(slideRoot, 'assets'))).not.toContain('outside-secret.txt')
    expect((await readdir(path.join(slideRoot, 'assets'))).some((name) => name.endsWith('.svg'))).toBe(true)

    const courseText = await readFile(path.join(firstExport.path, 'course.json'), 'utf8')
    expect(courseText).not.toContain(sourceRoot)
    expect(courseText).not.toContain(projectRoot)
    expect(courseText).not.toContain(outsideFile)
    const course = JSON.parse(courseText) as {
      source: { rootPath?: string; projectRoot?: string; projectFile: string }
    }
    expect(course.source.rootPath).toBeUndefined()
    expect(course.source.projectRoot).toBeUndefined()
    expect(course.source.projectFile).toBe('project.xml')

    const captivateJob = JSON.parse(
      await readFile(path.join(firstExport.path, 'captivate-job.json'), 'utf8')
    ) as {
      target: { format: string; editable: boolean; adapterRequired: boolean }
      notice: string
      slides: Array<{ nativeObjects: unknown[] }>
    }
    expect(captivateJob.target).toEqual({
      format: 'cptx',
      editable: true,
      adapterRequired: true
    })
    expect(captivateJob.notice).toMatch(/not a CPTX/i)
    expect(captivateJob.slides[0]?.nativeObjects).toHaveLength(4)

    expect(secondExport.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'BUNDLE_ASSET_MISSING',
        'BUNDLE_ASSET_PATH_REJECTED',
        'BUNDLE_FLASH_PRESERVED_AS_EVIDENCE'
      ])
    )

    const unsupported = await readFile(
      path.join(firstExport.path, 'reports', 'unsupported.csv'),
      'utf8'
    )
    expect(unsupported).toContain('outside-secret.txt')
    expect(unsupported).toContain('Preserved as inert evidence')
    expect(unsupported).toContain('unknown')
    expect(unsupported).toContain("'=@SUM(1+1)")

    const reconstruction = await readFile(
      path.join(slideRoot, 'reconstruction.md'),
      'utf8'
    )
    expect(reconstruction).not.toContain('<img')
    expect(reconstruction).not.toContain('](https://example.invalid')

    const checksums = JSON.parse(
      await readFile(path.join(firstExport.path, 'reports', 'checksums.json'), 'utf8')
    ) as { files: Array<{ path: string; sha256: string }> }
    expect(checksums.files.map((file) => file.path)).toContain(
      'slides/0001-welcome-overview/source/page.html'
    )
    expect(checksums.files.map((file) => file.path)).not.toContain('reports/checksums.json')
    expect(checksums.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)

    const manifest = JSON.parse(
      await readFile(path.join(firstExport.path, 'manifest.json'), 'utf8')
    ) as { evidencePolicy: { sourceExecutionPerformed: boolean } }
    expect(manifest.evidencePolicy.sourceExecutionPerformed).toBe(false)
  })
})

function buildCourseModel(paths: {
  sourceRoot: string
  projectRoot: string
  pagePath: string
  masterPath: string
  themePath: string
  firstImage: string
  secondImage: string
  flashEvidence: string
  missingImage: string
  outsideFile: string
}): CourseModel {
  const firstImageRef = {
    source: '../../../assets/first/picture.png',
    resolvedPath: paths.firstImage,
    kind: 'image' as const,
    exists: true
  }
  const secondImageRef = {
    source: '../../../assets/second/picture.png',
    resolvedPath: paths.secondImage,
    kind: 'image' as const,
    exists: true
  }
  const missingImageRef = {
    source: '../../../assets/missing.png',
    resolvedPath: paths.missingImage,
    kind: 'image' as const,
    exists: false
  }
  const outsideRef = {
    source: paths.outsideFile,
    resolvedPath: paths.outsideFile,
    kind: 'other' as const,
    exists: true
  }

  return {
    schemaVersion: COURSE_MODEL_VERSION,
    generatedAt: '2026-08-05T12:00:00.000Z',
    source: {
      rootPath: paths.sourceRoot,
      projectRoot: paths.projectRoot,
      projectFile: path.join(paths.projectRoot, 'project.xml'),
      format: 'composica-published'
    },
    settings: {
      id: 'course:unsafe/id',
      publicId: 'public-course-1',
      title: 'CON: Course / Café',
      description: 'Synthetic exporter test',
      version: '1.0',
      width: 1024,
      height: 576,
      backgroundColor: '#ffffff',
      theme: '../../Themes/course.css',
      masterId: 'master/main.html',
      persist: true,
      attributes: {}
    },
    outline: [
      {
        type: 'page',
        id: 'slide-1',
        title: 'Welcome / Overview',
        attributes: {},
        children: []
      }
    ],
    slides: [
      {
        index: 7,
        id: 'slide-1',
        title: 'Welcome / Overview',
        kind: 'question',
        outlinePath: ['Welcome / Overview'],
        sourceRelativePath: 'Pages/page-one.html',
        sourcePath: paths.pagePath,
        sourceHtml: '<p>Parsed fallback that should not replace the original.</p>',
        masterId: 'master/main.html',
        objects: [
          {
            id: 'heading',
            sourceTag: 'div',
            role: 'text',
            text: 'Welcome',
            html: '<strong>Welcome</strong>',
            attributes: { class: 'title' },
            style: { color: '#123456' },
            geometry: { left: 10, top: 20, width: 300, height: 60 },
            zIndex: 1,
            assetRefs: []
          },
          {
            id: 'hero/image',
            sourceTag: 'img',
            role: 'image',
            text: '',
            html: '',
            attributes: { alt: 'Two colliding source names' },
            style: {},
            geometry: { left: 20, top: 100, width: 400, height: 220 },
            zIndex: 2,
            assetRefs: [firstImageRef, secondImageRef]
          },
          {
            id: 'panel',
            sourceTag: 'div',
            role: 'shape',
            text: '',
            html: '',
            attributes: {},
            style: { background: '#eeeeee' },
            geometry: { left: 5, top: 5, width: 500, height: 500 },
            zIndex: 0,
            assetRefs: []
          },
          {
            id: 'mystery',
            sourceTag: 'custom-widget',
            role: 'unknown',
            text: '',
            html: '<custom-widget></custom-widget>',
            attributes: {},
            style: {},
            geometry: {},
            zIndex: 3,
            assetRefs: [outsideRef]
          }
        ],
        interactions: [
          {
            id: 'question-1',
            objectId: 'heading',
            type: 'multiple-choice',
            prompt: '<img src="https://example.invalid/pixel"> [remote](https://example.invalid)',
            options: [
              {
                id: 'a',
                text: 'A',
                html: 'A',
                correct: true,
                attributes: {}
              }
            ],
            answers: ['a'],
            feedback: { correct: 'Correct', incorrect: 'Try again', custom: [] },
            attributes: {}
          },
          {
            id: '=@SUM(1+1)',
            objectId: 'mystery',
            type: 'unknown',
            prompt: '',
            options: [],
            answers: [],
            feedback: { custom: [] },
            attributes: {}
          }
        ],
        assetRefs: [firstImageRef, secondImageRef, missingImageRef, outsideRef],
        diagnostics: []
      }
    ],
    assets: [
      {
        id: 'asset-first',
        ...firstImageRef,
        relativePath: 'assets/first/picture.png',
        size: 3,
        usedBySlides: ['slide-1']
      },
      {
        id: 'asset-second',
        ...secondImageRef,
        relativePath: 'assets/second/picture.png',
        size: 3,
        usedBySlides: ['slide-1']
      },
      {
        id: 'asset-flash-evidence',
        source: 'assets/legacy.swf',
        resolvedPath: paths.flashEvidence,
        kind: 'flash',
        exists: true,
        relativePath: 'assets/legacy.swf',
        size: 23,
        usedBySlides: []
      }
    ],
    diagnostics: [
      {
        severity: 'info',
        code: 'SYNTHETIC_SOURCE_NOTE',
        message: `Parsed from ${paths.sourceRoot}`,
        source: paths.pagePath
      }
    ]
  }
}
