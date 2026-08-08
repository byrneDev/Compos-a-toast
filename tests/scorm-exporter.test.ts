import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { COURSE_MODEL_VERSION, type CourseModel } from '../src/core/model'
import { exportScorm12 } from '../src/core/scorm'

const temporaryRoots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compos-a-toast-scorm-'))
  temporaryRoots.push(root)
  return root
}

function createModel(sourceRoot: string, assetPath?: string): CourseModel {
  return {
    schemaVersion: COURSE_MODEL_VERSION,
    generatedAt: '2026-08-05T12:00:00.000Z',
    source: {
      rootPath: sourceRoot,
      projectRoot: sourceRoot,
      projectFile: path.join(sourceRoot, 'project.xml'),
      format: 'composica-published'
    },
    settings: {
      id: '../../unsafe<&id',
      publicId: 'public<&id',
      title: '../../Safety <Course>',
      description: 'A test course',
      version: '1',
      width: 800,
      height: 600,
      backgroundColor: '#ffffff',
      persist: true,
      attributes: {}
    },
    outline: [],
    slides: [
      {
        index: 0,
        id: 'slide-1',
        title: 'Welcome',
        kind: 'question',
        outlinePath: ['Welcome'],
        sourceRelativePath: 'pages/slide-1.html',
        sourcePath: path.join(sourceRoot, 'pages', 'slide-1.html'),
        sourceHtml: '<script>window.stolen = true</script><p>Untrusted source</p>',
        masterId: undefined,
        objects: [
          {
            id: 'title',
            sourceTag: 'div',
            role: 'text',
            text: 'Hello learner',
            html: '<img src=x onerror=alert(1)>',
            attributes: { onclick: 'alert(1)' },
            style: {},
            geometry: { left: 25, top: 30, width: 300, height: 60 },
            zIndex: 1,
            assetRefs: []
          },
          {
            id: 'hero',
            sourceTag: 'img',
            role: 'image',
            text: 'A sample image',
            html: '',
            attributes: { alt: 'A sample image' },
            style: {},
            geometry: { left: 400, top: 50, width: 200, height: 150 },
            zIndex: 2,
            assetRefs: assetPath
              ? [{ source: 'media/hero.png', resolvedPath: assetPath, kind: 'image', exists: true }]
              : []
          }
        ],
        interactions: [
          {
            id: 'choice-1',
            objectId: 'choice-object',
            type: 'multiple-choice',
            prompt: 'Choose the correct answer',
            options: [
              { id: 'a', text: 'Alpha', html: '', correct: true, attributes: {} },
              { id: 'b', text: 'Beta', html: '', correct: false, attributes: {} }
            ],
            answers: ['a'],
            feedback: { correct: 'Correct', incorrect: 'Try again', custom: [] },
            attributes: {}
          },
          {
            id: 'blank-1',
            objectId: 'blank-object',
            type: 'fill-blank',
            prompt: 'Type Alpha',
            options: [],
            answers: ['Alpha'],
            feedback: { correct: 'Correct', incorrect: 'Try again', custom: [] },
            attributes: {}
          },
          {
            id: 'hotspot-1',
            objectId: 'hotspot-object',
            type: 'hotspot',
            prompt: 'Choose the target',
            options: [{ id: 'spot-a', text: 'Target A', html: '', correct: true, attributes: {} }],
            answers: ['spot-a'],
            feedback: { correct: 'Correct', incorrect: 'Try again', custom: [] },
            attributes: {}
          }
        ],
        assetRefs: [],
        diagnostics: []
      }
    ],
    assets: assetPath
      ? [
          {
            id: 'hero-asset',
            source: 'media/hero.png',
            resolvedPath: assetPath,
            relativePath: 'media/hero.png',
            kind: 'image',
            exists: true,
            size: 4,
            usedBySlides: ['slide-1']
          }
        ]
      : [],
    diagnostics: []
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

describe('exportScorm12', () => {
  it('creates a single-SCO HTML5 package with SCORM lifecycle support', async () => {
    const root = await fixtureRoot()
    const source = path.join(root, 'source')
    const output = path.join(root, 'output')
    const media = path.join(source, 'media')
    const asset = path.join(media, 'hero.png')
    await mkdir(media, { recursive: true })
    await writeFile(asset, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await exportScorm12(createModel(source, asset), output)
    const realOutput = await realpath(output)
    expect(path.dirname(result.path)).toBe(realOutput)
    expect(path.dirname(result.folderPath)).toBe(realOutput)
    expect(path.basename(result.path)).toBe('safety-course-scorm12.zip')

    const zip = new AdmZip(result.path)
    const entries = zip.getEntries().map((entry) => entry.entryName)
    expect(entries).toContain('imsmanifest.xml')
    expect(entries).toContain('index.html')
    expect(entries).toContain('course/course.json')
    expect(entries).toContain('course/course-data.js')
    expect(entries).toContain('runtime/player.js')
    expect(entries).toContain('runtime/styles.css')
    expect(entries).toContain('adlcp_rootv1p2.xsd')
    expect(entries).toContain('imscp_rootv1p1p2.xsd')
    expect(entries).toContain('imsmd_rootv1p2p1.xsd')
    expect(entries).toContain('ims_xml.xsd')
    expect(entries.some((entry) => /^assets\/\d{4}-hero\.png$/.test(entry))).toBe(true)
    expect(entries.every((entry) => !entry.startsWith('/') && !entry.includes('..'))).toBe(true)

    const manifest = zip.readAsText('imsmanifest.xml')
    expect(manifest.match(/<resource\s/g)).toHaveLength(1)
    expect(manifest).toContain('adlcp:scormtype="sco"')
    expect(manifest).toContain('href="index.html"')
    expect(manifest).toContain('<schemaversion>1.2</schemaversion>')
    expect(manifest).toContain('<title>../../Safety &lt;Course&gt;</title>')
    expect(manifest).not.toContain('public<&id')
    expect(manifest).not.toMatch(/<file href="(?:adlcp_rootv1p2|imscp_rootv1p1p2|imsmd_rootv1p2p1|ims_xml)\.xsd"/)

    const index = zip.readAsText('index.html')
    expect(index).toContain('runtime/styles.css')
    expect(index).toContain('runtime/player.js')
    expect(index).toContain('course/course-data.js')
    expect(index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)

    const player = zip.readAsText('runtime/player.js')
    expect(() => new Function(player)).not.toThrow()
    for (const method of [
      'LMSInitialize',
      'LMSGetValue',
      'LMSSetValue',
      'LMSCommit',
      'LMSFinish'
    ]) {
      expect(player).toContain(method)
    }
    expect(player).toContain('cmi.core.lesson_status')
    expect(player).toContain('cmi.core.lesson_location')
    expect(player).toContain('cmi.core.score.raw')
    expect(player).toContain('cmi.suspend_data')
    expect(player).toContain('4096')
    expect(player).toContain('localStorage')
    expect(player).toContain("interaction.type === 'fill-blank'")
    expect(player).toContain("interaction.type === 'hotspot'")
    expect(player).toContain("padStart(4, '0')")
    expect(player).toContain('9999 * 60 * 60')
    expect(player).toContain('This course remains incomplete until all scored interactions are answered.')

    const exportedModel = JSON.parse(zip.readAsText('course/course.json')) as CourseModel
    expect(exportedModel.source.rootPath).toBe('.')
    expect(exportedModel.slides[0].sourceHtml).toBe('')
    expect(exportedModel.slides[0].objects[0].html).toBe('')
    expect(exportedModel.slides[0].objects[0].attributes).not.toHaveProperty('onclick')
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'SCORM12_PACKAGE_CREATED')).toBe(true)
  })

  it('contains hostile names and refuses to copy assets outside the source roots', async () => {
    const root = await fixtureRoot()
    const source = path.join(root, 'source')
    const output = path.join(root, 'output')
    const outsideAsset = path.join(root, 'private.txt')
    await mkdir(source, { recursive: true })
    await writeFile(outsideAsset, 'do not package me', 'utf8')
    const model = createModel(source)
    model.settings.title = '../../../../escape'
    model.assets = [
      {
        id: 'outside',
        source: '../private.txt',
        resolvedPath: outsideAsset,
        relativePath: '../private.txt',
        kind: 'other',
        exists: true,
        size: 17,
        usedBySlides: ['slide-1']
      }
    ]

    const result = await exportScorm12(model, output)
    const realOutput = await realpath(output)
    expect(path.dirname(result.path)).toBe(realOutput)
    expect(path.basename(result.path)).toBe('escape-scorm12.zip')
    expect(path.dirname(result.folderPath)).toBe(realOutput)

    const zip = new AdmZip(result.path)
    expect(zip.getEntries().some((entry) => entry.entryName.startsWith('assets/'))).toBe(false)
    expect(zip.getEntries().every((entry) => !entry.entryName.includes('private.txt'))).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'SCORM12_ASSET_SKIPPED' })
      ])
    )
    expect(await readFile(outsideAsset, 'utf8')).toBe('do not package me')
  })

  it('never replaces colliding artifacts and preserves the last good export after failure', async () => {
    const root = await fixtureRoot()
    const source = path.join(root, 'source')
    const output = path.join(root, 'output')
    const occupiedFolder = path.join(output, 'collision-course-scorm12')
    const occupiedZip = path.join(output, 'collision-course-scorm12.zip')
    await mkdir(occupiedFolder, { recursive: true })
    await writeFile(path.join(occupiedFolder, 'sentinel.txt'), 'unrelated folder', 'utf8')
    await writeFile(occupiedZip, 'unrelated zip', 'utf8')

    const model = createModel(source)
    model.settings.title = 'Collision Course'
    const first = await exportScorm12(model, output)
    expect(path.basename(first.folderPath)).toBe('collision-course-scorm12-2')
    expect(path.basename(first.path)).toBe('collision-course-scorm12-2.zip')
    expect(await readFile(path.join(occupiedFolder, 'sentinel.txt'), 'utf8')).toBe('unrelated folder')
    expect(await readFile(occupiedZip, 'utf8')).toBe('unrelated zip')

    const firstZip = await readFile(first.path)
    const second = await exportScorm12(model, output)
    expect(path.basename(second.folderPath)).toBe('collision-course-scorm12-3')
    expect(path.basename(second.path)).toBe('collision-course-scorm12-3.zip')
    expect(await readFile(first.path)).toEqual(firstZip)
    expect(await readdir(first.folderPath)).not.toContain('.compos-a-toast-export-owner.json')

    const beforeFailure = (await readdir(output)).sort()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    ;(model.diagnostics as unknown as Array<Record<string, unknown>>).push({
      severity: 'warning',
      code: 'CIRCULAR_TEST',
      message: 'Force staging failure',
      context: circular
    })
    await expect(exportScorm12(model, output)).rejects.toThrow()
    expect((await readdir(output)).sort()).toEqual(beforeFailure)
    expect(await readFile(first.path)).toEqual(firstZip)
  })

  it('vendors the controlling XSDs at the package root with their standard namespaces', async () => {
    const root = await fixtureRoot()
    const result = await exportScorm12(createModel(root), path.join(root, 'output'))
    const zip = new AdmZip(result.path)
    const expectedNamespaces: Record<string, string> = {
      'adlcp_rootv1p2.xsd': 'http://www.adlnet.org/xsd/adlcp_rootv1p2',
      'imscp_rootv1p1p2.xsd': 'http://www.imsproject.org/xsd/imscp_rootv1p1p2',
      'imsmd_rootv1p2p1.xsd': 'http://www.imsglobal.org/xsd/imsmd_rootv1p2p1',
      'ims_xml.xsd': 'http://www.w3.org/XML/1998/namespace'
    }
    for (const [filename, namespace] of Object.entries(expectedNamespaces)) {
      const schema = zip.readAsText(filename)
      expect(schema).toContain('<xsd:schema')
      expect(schema).toContain(`targetNamespace="${namespace}"`)
      expect(Buffer.byteLength(schema, 'utf8')).toBeGreaterThan(1_000)
    }
    const manifest = zip.readAsText('imsmanifest.xml')
    expect(manifest).toContain('imsmd_rootv1p2p1.xsd')
    expect(manifest).not.toMatch(/<file href="[^\"]+\.xsd"/)
  })

  it.skipIf(process.platform !== 'win32')(
    'validates the generated manifest against its packaged SCORM 1.2 schemas',
    async () => {
      const root = await fixtureRoot()
      const result = await exportScorm12(createModel(root), path.join(root, 'output'))
      const validationScript = String.raw`
$ErrorActionPreference = 'Stop'
$packageRoot = $env:COMPOS_A_TOAST_SCORM_PACKAGE
$manifest = Join-Path $packageRoot 'imsmanifest.xml'
$settings = [System.Xml.XmlReaderSettings]::new()
$settings.ValidationType = [System.Xml.ValidationType]::Schema
$settings.XmlResolver = [System.Xml.XmlUrlResolver]::new()
$settings.ValidationFlags = [System.Xml.Schema.XmlSchemaValidationFlags]::ProcessSchemaLocation -bor [System.Xml.Schema.XmlSchemaValidationFlags]::ReportValidationWarnings
$settings.Schemas.XmlResolver = [System.Xml.XmlUrlResolver]::new()
$null = $settings.Schemas.Add('http://www.w3.org/XML/1998/namespace', (Join-Path $packageRoot 'ims_xml.xsd'))
$null = $settings.Schemas.Add('http://www.imsproject.org/xsd/imscp_rootv1p1p2', (Join-Path $packageRoot 'imscp_rootv1p1p2.xsd'))
$null = $settings.Schemas.Add('http://www.imsglobal.org/xsd/imsmd_rootv1p2p1', (Join-Path $packageRoot 'imsmd_rootv1p2p1.xsd'))
$null = $settings.Schemas.Add('http://www.adlnet.org/xsd/adlcp_rootv1p2', (Join-Path $packageRoot 'adlcp_rootv1p2.xsd'))
$settings.Schemas.Compile()
$failures = [System.Collections.Generic.List[string]]::new()
$handler = [System.Xml.Schema.ValidationEventHandler]{ param($sender, $eventArgs) $failures.Add($eventArgs.Message) }
$settings.add_ValidationEventHandler($handler)
$reader = [System.Xml.XmlReader]::Create($manifest, $settings)
try { while ($reader.Read()) { } } finally { $reader.Dispose() }
if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
`
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', validationScript],
        {
          env: {
            ...process.env,
            COMPOS_A_TOAST_SCORM_PACKAGE: result.folderPath
          }
        }
      )
    },
    20_000
  )

  it('uses the first valid test passScore and all intended questions as the score denominator', async () => {
    const root = await fixtureRoot()
    const model = createModel(root)
    model.outline = [
      {
        type: 'test',
        id: 'invalid-test',
        title: 'Invalid test settings',
        attributes: { passScore: 'not-a-score' },
        children: []
      },
      {
        type: 'test',
        id: 'graded-test',
        title: 'Graded test',
        attributes: { PASS_SCORE: '72' },
        children: []
      }
    ]
    const result = await exportScorm12(model, path.join(root, 'output'))
    const zip = new AdmZip(result.path)
    const manifest = zip.readAsText('imsmanifest.xml')
    expect(manifest).toContain('<adlcp:masteryscore>72</adlcp:masteryscore>')

    const exported = JSON.parse(zip.readAsText('course/course.json')) as CourseModel & {
      scorm: { masteryScore: number; gradeableInteractionCount: number }
    }
    expect(exported.scorm).toEqual({ masteryScore: 72, gradeableInteractionCount: 3 })

    const player = zip.readAsText('runtime/player.js')
    expect(player).toContain('summary.percent >= MASTERY_SCORE')
    expect(player).toContain("!summary.allAnswered")
    expect(player).toContain("? 'incomplete'")
    expect(player).toContain('all scored interactions are answered')

    const source = player.match(/function formatSessionTime\(milliseconds\) \{[\s\S]*?\n  \}/)?.[0]
    expect(source).toBeTruthy()
    const formatSessionTime = new Function(`${source}; return formatSessionTime;`)() as (
      milliseconds: number
    ) => string
    expect(formatSessionTime(0)).toBe('0000:00:00')
    expect(formatSessionTime(3_661_000)).toBe('0001:01:01')
    expect(formatSessionTime(Number.MAX_SAFE_INTEGER)).toBe('9999:59:59')
  })

  it('recursively removes source paths and nested presentation fragments from exported data', async () => {
    const root = await fixtureRoot()
    const source = path.join(root, 'private source')
    const model = createModel(source)
    const absoluteSlidePath = path.join(source, 'pages', 'slide-1.html')
    model.settings.attributes.debugPath = absoluteSlidePath
    model.outline = [
      {
        type: 'test',
        id: 'test',
        title: 'Test',
        attributes: { passScore: '80', sourcePath: absoluteSlidePath },
        children: []
      }
    ]
    model.diagnostics.push({
      severity: 'warning',
      code: 'SOURCE_PATH',
      message: `Could not parse ${absoluteSlidePath}`,
      source: 'C:\\private-diagnostics\\trace.log'
    })
    model.slides[0].diagnostics.push({
      severity: 'warning',
      code: 'SLIDE_PATH',
      message: `Source root was ${source}`,
      source: absoluteSlidePath
    })
    model.slides[0].objects.push(
      {
        id: 'question-interaction-fragment',
        sourceTag: 'label',
        role: 'interaction',
        text: 'Choose the correct answer',
        html: '',
        attributes: { class: 'question-answer', 'data-source': absoluteSlidePath },
        style: {},
        geometry: { left: 0, top: 0, width: 700, height: 200 },
        zIndex: 3,
        assetRefs: []
      },
      {
        id: 'duplicate-container',
        sourceTag: 'div',
        role: 'container',
        text: 'Duplicate presentation text',
        html: '',
        attributes: {},
        style: {},
        geometry: { left: 10, top: 10, width: 500, height: 100 },
        zIndex: 4,
        assetRefs: []
      },
      {
        id: 'duplicate-child',
        sourceTag: 'span',
        role: 'text',
        text: 'Duplicate presentation text',
        html: '',
        attributes: {},
        style: {},
        geometry: { left: 20, top: 20, width: 300, height: 40 },
        zIndex: 5,
        assetRefs: []
      }
    )

    const result = await exportScorm12(model, path.join(root, 'output'))
    const zip = new AdmZip(result.path)
    const courseJson = zip.readAsText('course/course.json')
    const exported = JSON.parse(courseJson) as CourseModel
    const strings = collectStrings(exported)
    expect(strings.some((value) => value.includes(source) || value.includes(absoluteSlidePath))).toBe(false)
    expect(strings.some((value) => /\b[A-Za-z]:[\\/]/.test(value))).toBe(false)
    expect(strings).toContain('[source path]')
    expect(exported.slides[0].objects.some((object) => object.role === 'interaction')).toBe(false)
    expect(
      exported.slides[0].objects.filter((object) => object.text === 'Duplicate presentation text')
    ).toHaveLength(1)

    const courseScript = zip.readAsText('course/course-data.js')
    expect(courseScript).not.toContain(source.replace(/\\/g, '\\\\'))
    expect(courseScript).not.toContain('private-diagnostics')
    const player = zip.readAsText('runtime/player.js')
    expect(player).toContain("assetPath(object, ['image'])")
    expect(player).toContain("assetPath(object, ['video'])")
    expect(player).toContain("assetPath(object, ['audio'])")
  })

  it('rejects an empty destination path', async () => {
    const root = await fixtureRoot()
    await expect(exportScorm12(createModel(root), '   ')).rejects.toThrow(/destination folder is required/i)
  })
})
