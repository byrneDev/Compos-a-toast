import path from 'node:path'
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import AdmZip from 'adm-zip'
import type { DiagnosticDto } from '../../shared/contracts'
import type {
  AssetModel,
  AssetReference,
  CourseModel,
  Interaction,
  InteractionOption,
  SlideModel,
  SlideObject
} from '../model'
import { PLAYER_SCRIPT, PLAYER_STYLES } from './runtime'
import ADLCP_SCHEMA from './schemas/adlcp_rootv1p2.xsd?raw'
import IMSCP_SCHEMA from './schemas/imscp_rootv1p1p2.xsd?raw'
import IMSMD_SCHEMA from './schemas/imsmd_rootv1p2p1.xsd?raw'
import IMS_XML_SCHEMA from './schemas/ims_xml.xsd?raw'

export interface Scorm12ExportResult {
  path: string
  folderPath: string
  diagnostics: DiagnosticDto[]
}

interface PackagedAssetReference extends AssetReference {
  packagePath?: string
}

interface AssetCandidate extends AssetReference {
  id?: string
  relativePath?: string
}

const MAX_FILENAME_LENGTH = 80
const OWNERSHIP_MARKER = '.compos-a-toast-export-owner.json'
const OWNERSHIP_MAGIC = 'compos-a-toast/scorm12-export/v1'
const MAX_ARTIFACT_COLLISIONS = 10_000
const CONTROL_DOCUMENTS = new Map<string, string>([
  ['adlcp_rootv1p2.xsd', ADLCP_SCHEMA],
  ['imscp_rootv1p1p2.xsd', IMSCP_SCHEMA],
  ['imsmd_rootv1p2p1.xsd', IMSMD_SCHEMA],
  ['ims_xml.xsd', IMS_XML_SCHEMA]
])

interface ScormExportMetadata {
  masteryScore: number
  gradeableInteractionCount: number
}

type ScormCourseModel = CourseModel & { scorm: ScormExportMetadata }

export async function exportScorm12(
  model: CourseModel,
  destinationRoot: string
): Promise<Scorm12ExportResult> {
  const diagnostics: DiagnosticDto[] = []
  const destination = await prepareDestination(destinationRoot)
  const baseName = `${safeSlug(model.settings.title || model.settings.id || 'course')}-scorm12`
  const ownerToken = randomUUID()
  const stagingRoot = await createOwnedStagingDirectory(destination, ownerToken)
  const stagingPackage = containedPath(stagingRoot, 'package')
  const stagingZip = containedPath(stagingRoot, 'package.zip')

  try {
    await mkdir(stagingPackage, { recursive: false })
    const packagePaths = await copyAssets(model, stagingPackage, diagnostics)
    const exportModel = sanitizeCourseModel(model, packagePaths)

    if (model.slides.length === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'SCORM12_EMPTY_COURSE',
        message: 'The SCORM package was created, but the source model contains no slides.'
      })
    }

    await writePackageFile(stagingPackage, 'runtime/player.js', PLAYER_SCRIPT)
    await writePackageFile(stagingPackage, 'runtime/styles.css', PLAYER_STYLES)
    await writePackageFile(
      stagingPackage,
      'course/course.json',
      `${JSON.stringify(exportModel, null, 2)}\n`
    )
    await writePackageFile(
      stagingPackage,
      'course/course-data.js',
      `window.__COMPOS_A_TOAST_COURSE__ = ${jsonForJavaScript(exportModel)};\n`
    )
    await writePackageFile(stagingPackage, 'index.html', createIndexHtml(exportModel.settings.title))
    for (const [filename, contents] of CONTROL_DOCUMENTS) {
      await writePackageFile(stagingPackage, filename, contents)
    }

    const resourceFiles = await listFiles(stagingPackage)
    const manifest = createManifest(exportModel, resourceFiles)
    await writePackageFile(stagingPackage, 'imsmanifest.xml', manifest)
    await createZip(stagingPackage, stagingZip)

    const published = await publishCollisionSafeArtifacts(
      destination,
      baseName,
      stagingPackage,
      stagingZip
    )
    diagnostics.push({
      severity: 'info',
      code: 'SCORM12_PACKAGE_CREATED',
      message: `Created an HTML5 SCORM 1.2 package with ${model.slides.length} slide${model.slides.length === 1 ? '' : 's'}.`,
      source: published.zipPath
    })

    return { path: published.zipPath, folderPath: published.folderPath, diagnostics }
  } finally {
    await removeOwnedDirectory(stagingRoot, ownerToken, destination)
  }
}

async function prepareDestination(destinationRoot: string): Promise<string> {
  if (!destinationRoot || !destinationRoot.trim()) {
    throw new Error('A destination folder is required for SCORM export.')
  }

  const resolved = path.resolve(destinationRoot)
  await mkdir(resolved, { recursive: true })
  const details = await stat(resolved)
  if (!details.isDirectory()) throw new Error(`SCORM destination is not a folder: ${resolved}`)
  return realpath(resolved)
}

function safeSlug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, MAX_FILENAME_LENGTH)
    .replace(/-+$/g, '')
  return normalized || 'course'
}

function containedPath(parent: string, childName: string): string {
  const resolvedParent = path.resolve(parent)
  const candidate = path.resolve(resolvedParent, childName)
  if (!isPathInside(resolvedParent, candidate) || candidate === resolvedParent) {
    throw new Error(`Refusing to create a SCORM artifact outside its destination: ${childName}`)
  }
  return candidate
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function createOwnedStagingDirectory(destination: string, ownerToken: string): Promise<string> {
  const stagingRoot = await mkdtemp(containedPath(destination, '.compos-a-toast-scorm-'))
  try {
    await writeOwnershipMarker(stagingRoot, ownerToken)
    return stagingRoot
  } catch (error) {
    await rmdir(stagingRoot).catch(() => undefined)
    throw error
  }
}

async function writeOwnershipMarker(directory: string, ownerToken: string): Promise<void> {
  await writeFile(
    containedPath(directory, OWNERSHIP_MARKER),
    `${JSON.stringify({ magic: OWNERSHIP_MAGIC, token: ownerToken })}\n`,
    { encoding: 'utf8', flag: 'wx' }
  )
}

async function removeOwnedDirectory(
  directory: string,
  ownerToken: string,
  expectedParent: string
): Promise<void> {
  if (path.dirname(directory) !== expectedParent || !isPathInside(expectedParent, directory)) return
  try {
    const marker = JSON.parse(
      await readFile(containedPath(directory, OWNERSHIP_MARKER), 'utf8')
    ) as { magic?: unknown; token?: unknown }
    if (marker.magic !== OWNERSHIP_MAGIC || marker.token !== ownerToken) return
    await rm(directory, { recursive: true, force: false })
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

async function publishCollisionSafeArtifacts(
  destination: string,
  baseName: string,
  stagingPackage: string,
  stagingZip: string
): Promise<{ folderPath: string; zipPath: string }> {
  for (let collision = 0; collision < MAX_ARTIFACT_COLLISIONS; collision += 1) {
    const suffix = collision === 0 ? '' : `-${collision + 1}`
    const artifactName = `${baseName}${suffix}`
    const folderPath = containedPath(destination, artifactName)
    const zipPath = containedPath(destination, `${artifactName}.zip`)

    let zipPublished = false
    try {
      // A hard link publishes the already-complete sibling ZIP atomically and
      // fails if anything (including an unrelated file) owns the final name.
      await link(stagingZip, zipPath)
      zipPublished = true
      // The package directory is staged on the same filesystem, so rename is
      // atomic and never exposes a partially copied course folder.
      await rename(stagingPackage, folderPath)
      return { folderPath, zipPath }
    } catch (error) {
      if (zipPublished) await unlink(zipPath).catch(() => undefined)
      if (isExistingPathError(error)) continue
      throw error
    }
  }
  throw new Error('Could not choose an unused name for the SCORM export artifacts.')
}

function isExistingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
  )
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function normalizedLookupKey(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function addLookupKey(map: Map<string, string>, value: string | undefined, packagePath: string): void {
  const key = normalizedLookupKey(value)
  if (key) map.set(key, packagePath)
}

function collectAssetCandidates(model: CourseModel): AssetCandidate[] {
  const result: AssetCandidate[] = []
  result.push(...model.assets)
  for (const slide of model.slides) {
    result.push(...slide.assetRefs)
    for (const object of slide.objects) result.push(...object.assetRefs)
  }
  return result.sort((left, right) => {
    const leftKey = left.resolvedPath || ('relativePath' in left ? left.relativePath : '') || left.source
    const rightKey = right.resolvedPath || ('relativePath' in right ? right.relativePath : '') || right.source
    return leftKey.localeCompare(rightKey)
  })
}

async function existingRealRoots(model: CourseModel): Promise<string[]> {
  const roots = [model.source.rootPath, model.source.projectRoot]
  const result: string[] = []
  for (const root of roots) {
    if (!root) continue
    try {
      const resolved = await realpath(path.resolve(root))
      if (!result.includes(resolved)) result.push(resolved)
    } catch {
      // A missing source root cannot safely authorize asset reads.
    }
  }
  return result
}

function candidatePaths(candidate: AssetCandidate, model: CourseModel): string[] {
  const requested = [
    candidate.resolvedPath,
    'relativePath' in candidate ? candidate.relativePath : undefined,
    candidate.source
  ].filter((value): value is string => Boolean(value && value.trim()))
  const paths = new Set<string>()

  for (const value of requested) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !path.isAbsolute(value)) continue
    if (path.isAbsolute(value)) paths.add(path.resolve(value))
    else {
      paths.add(path.resolve(model.source.rootPath, value))
      paths.add(path.resolve(model.source.projectRoot, value))
    }
  }
  return [...paths]
}

async function resolveSafeAsset(
  candidate: AssetCandidate,
  model: CourseModel,
  allowedRoots: string[]
): Promise<string | null> {
  for (const requestedPath of candidatePaths(candidate, model)) {
    try {
      const resolved = await realpath(requestedPath)
      const details = await stat(resolved)
      if (!details.isFile()) continue
      if (allowedRoots.some((root) => isPathInside(root, resolved))) return resolved
    } catch {
      // Try the next source-relative interpretation.
    }
  }
  return null
}

function safeAssetFilename(sourcePath: string, index: number): string {
  const parsed = path.parse(sourcePath)
  const stem = safeSlug(parsed.name).slice(0, 52) || 'asset'
  const extension = parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12)
  return `${String(index + 1).padStart(4, '0')}-${stem}${extension}`
}

async function copyAssets(
  model: CourseModel,
  folderPath: string,
  diagnostics: DiagnosticDto[]
): Promise<Map<string, string>> {
  const allowedRoots = await existingRealRoots(model)
  const packagePaths = new Map<string, string>()
  const copiedRealPaths = new Map<string, string>()
  const candidates = collectAssetCandidates(model)
  let copiedCount = 0

  for (const candidate of candidates) {
    const resolved = await resolveSafeAsset(candidate, model, allowedRoots)
    if (!resolved) {
      if (candidate.exists) {
        diagnostics.push({
          severity: 'warning',
          code: 'SCORM12_ASSET_SKIPPED',
          message: `An asset was missing or outside the source course and was not copied: ${candidate.source}`,
          source: candidate.resolvedPath || candidate.source
        })
      }
      continue
    }

    let packagePath = copiedRealPaths.get(resolved)
    if (!packagePath) {
      packagePath = `assets/${safeAssetFilename(resolved, copiedCount)}`
      const destination = containedPath(folderPath, packagePath)
      await mkdir(path.dirname(destination), { recursive: true })
      try {
        await copyFile(resolved, destination)
      } catch (error) {
        diagnostics.push({
          severity: 'warning',
          code: 'SCORM12_ASSET_COPY_FAILED',
          message: `Could not copy asset ${candidate.source}: ${errorMessage(error)}`,
          source: resolved
        })
        continue
      }
      copiedRealPaths.set(resolved, packagePath)
      copiedCount += 1
    }

    addLookupKey(packagePaths, candidate.source, packagePath)
    addLookupKey(packagePaths, candidate.resolvedPath, packagePath)
    if ('relativePath' in candidate) addLookupKey(packagePaths, candidate.relativePath, packagePath)
    addLookupKey(packagePaths, resolved, packagePath)
  }

  return packagePaths
}

function packagePathFor(reference: AssetReference, packagePaths: Map<string, string>): string | undefined {
  const keys = [
    reference.resolvedPath,
    reference.source,
    'relativePath' in reference && typeof reference.relativePath === 'string'
      ? reference.relativePath
      : undefined
  ]
  for (const value of keys) {
    const key = normalizedLookupKey(value)
    if (key && packagePaths.has(key)) return packagePaths.get(key)
  }
  return undefined
}

function sanitizeAssetReference(
  reference: AssetReference,
  packagePaths: Map<string, string>
): PackagedAssetReference {
  return {
    source: cleanText(reference.source),
    kind: reference.kind,
    exists: Boolean(packagePathFor(reference, packagePaths)),
    ...(packagePathFor(reference, packagePaths)
      ? { packagePath: packagePathFor(reference, packagePaths) }
      : {})
  }
}

function sanitizeObject(object: SlideObject, packagePaths: Map<string, string>): SlideObject {
  return {
    ...object,
    id: cleanText(object.id),
    sourceTag: cleanText(object.sourceTag),
    text: plainText(object.text, object.html),
    html: '',
    attributes: sanitizeStringMap(object.attributes),
    style: sanitizeStringMap(object.style),
    geometry: sanitizeGeometry(object.geometry),
    assetRefs: object.assetRefs.map((reference) => sanitizeAssetReference(reference, packagePaths))
  }
}

function sanitizeOption(option: InteractionOption): InteractionOption {
  return {
    ...option,
    id: cleanText(option.id),
    text: plainText(option.text, option.html),
    html: '',
    attributes: sanitizeStringMap(option.attributes)
  }
}

function sanitizeInteraction(interaction: Interaction): Interaction {
  return {
    ...interaction,
    id: cleanText(interaction.id),
    objectId: cleanText(interaction.objectId),
    prompt: plainText(interaction.prompt, ''),
    options: interaction.options.map(sanitizeOption),
    answers: interaction.answers.map(cleanText),
    attributes: sanitizeStringMap(interaction.attributes),
    feedback: {
      correct: optionalPlainText(interaction.feedback.correct),
      incorrect: optionalPlainText(interaction.feedback.incorrect),
      partial: optionalPlainText(interaction.feedback.partial),
      retry: optionalPlainText(interaction.feedback.retry),
      custom: interaction.feedback.custom.map((item) => ({
        condition: item.condition ? cleanText(item.condition) : undefined,
        text: plainText(item.text, ''),
        attributes: sanitizeStringMap(item.attributes)
      }))
    }
  }
}

function normalizedComparisonText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function geometryArea(object: SlideObject): number {
  const width = Number(object.geometry.width)
  const height = Number(object.geometry.height)
  return Number.isFinite(width) && Number.isFinite(height) && width >= 0 && height >= 0
    ? width * height
    : Number.POSITIVE_INFINITY
}

function geometryContains(parent: SlideObject, child: SlideObject): boolean {
  const parentLeft = Number(parent.geometry.left)
  const parentTop = Number(parent.geometry.top)
  const parentWidth = Number(parent.geometry.width)
  const parentHeight = Number(parent.geometry.height)
  const childLeft = Number(child.geometry.left)
  const childTop = Number(child.geometry.top)
  const childWidth = Number(child.geometry.width)
  const childHeight = Number(child.geometry.height)
  if (
    ![parentLeft, parentTop, parentWidth, parentHeight, childLeft, childTop, childWidth, childHeight].every(
      Number.isFinite
    )
  ) {
    return false
  }
  return (
    parentLeft <= childLeft &&
    parentTop <= childTop &&
    parentLeft + parentWidth >= childLeft + childWidth &&
    parentTop + parentHeight >= childTop + childHeight
  )
}

function filterPresentationObjects(
  objects: SlideObject[],
  interactions: Interaction[]
): SlideObject[] {
  const interactionText = new Set<string>()
  for (const interaction of interactions) {
    for (const value of [
      interaction.prompt,
      ...interaction.options.map((option) => option.text),
      interaction.feedback.correct,
      interaction.feedback.incorrect,
      interaction.feedback.partial,
      interaction.feedback.retry
    ]) {
      if (value) interactionText.add(normalizedComparisonText(value))
    }
  }

  const candidates = objects.filter((object) => {
    if (object.role === 'interaction') return false
    if (interactions.length === 0) return true
    const tag = object.sourceTag.toLocaleLowerCase()
    if (['form', 'input', 'select', 'option', 'textarea', 'fieldset', 'legend'].includes(tag)) return false
    const identity = `${object.id} ${object.attributes.id || ''} ${object.attributes.class || ''}`
    const text = normalizedComparisonText(object.text)
    return !(
      text &&
      interactionText.has(text) &&
      /(?:interaction|question|answer|choice|option|response|feedback|hotspot|drag.?drop)/i.test(identity)
    )
  })

  const removed = new Set<SlideObject>()
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]
    if (left.assetRefs.length > 0 || !left.text.trim()) continue
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]
      if (
        right.assetRefs.length > 0 ||
        normalizedComparisonText(left.text) !== normalizedComparisonText(right.text)
      ) {
        continue
      }
      if (!geometryContains(left, right) && !geometryContains(right, left)) continue
      const leftPriority = left.role === 'container' ? 0 : 1
      const rightPriority = right.role === 'container' ? 0 : 1
      if (leftPriority !== rightPriority) removed.add(leftPriority < rightPriority ? left : right)
      else removed.add(geometryArea(left) >= geometryArea(right) ? left : right)
    }
  }
  return candidates.filter((object) => !removed.has(object))
}

function sanitizeSlide(slide: SlideModel, packagePaths: Map<string, string>): SlideModel {
  const interactions = slide.interactions.map(sanitizeInteraction)
  const objects = slide.objects.map((object) => sanitizeObject(object, packagePaths))
  return {
    ...slide,
    id: cleanText(slide.id),
    title: plainText(slide.title, ''),
    outlinePath: slide.outlinePath.map(cleanText),
    sourceRelativePath: cleanText(slide.sourceRelativePath),
    sourcePath: cleanText(slide.sourceRelativePath),
    sourceHtml: '',
    objects: filterPresentationObjects(objects, interactions),
    interactions,
    assetRefs: slide.assetRefs.map((reference) => sanitizeAssetReference(reference, packagePaths)),
    diagnostics: slide.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: cleanText(diagnostic.message),
      source: diagnostic.source ? cleanText(diagnostic.source) : undefined
    }))
  }
}

function sanitizeAssetModel(asset: AssetModel, packagePaths: Map<string, string>): AssetModel & PackagedAssetReference {
  return {
    ...asset,
    id: cleanText(asset.id),
    source: cleanText(asset.source),
    relativePath: cleanText(asset.relativePath),
    resolvedPath: undefined,
    usedBySlides: asset.usedBySlides.map(cleanText),
    exists: Boolean(packagePathFor(asset, packagePaths)),
    ...(packagePathFor(asset, packagePaths) ? { packagePath: packagePathFor(asset, packagePaths) } : {})
  }
}

function sanitizeOutlineNode(node: CourseModel['outline'][number]): CourseModel['outline'][number] {
  return {
    ...node,
    id: cleanText(node.id),
    title: plainText(node.title, ''),
    attributes: sanitizeStringMap(node.attributes),
    children: node.children.map(sanitizeOutlineNode)
  }
}

function validMasteryScore(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null
  const score = Number(value)
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null
}

function deriveMasteryScore(model: CourseModel): number {
  const visit = (nodes: CourseModel['outline']): number | null => {
    for (const node of nodes) {
      if (node.type === 'test') {
        const passScore = Object.entries(node.attributes).find(
          ([key]) => key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase() === 'passscore'
        )?.[1]
        const valid = validMasteryScore(passScore)
        if (valid !== null) return valid
      }
      const childScore = visit(node.children)
      if (childScore !== null) return childScore
    }
    return null
  }
  return visit(model.outline) ?? 80
}

function isGradeableInteraction(interaction: Interaction): boolean {
  if (!['multiple-choice', 'fill-blank', 'hotspot'].includes(interaction.type)) return false
  return (
    interaction.answers.some((answer) => answer.trim().length > 0) ||
    interaction.options.some((option) => option.correct === true)
  )
}

function collectSensitivePaths(model: CourseModel): string[] {
  const values = new Set<string>([
    model.source.rootPath,
    model.source.projectRoot,
    model.source.projectFile,
    ...model.slides.flatMap((slide) => [
      slide.sourcePath,
      ...slide.assetRefs.map((asset) => asset.resolvedPath || ''),
      ...slide.objects.flatMap((object) => object.assetRefs.map((asset) => asset.resolvedPath || ''))
    ]),
    ...model.assets.flatMap((asset) => [asset.resolvedPath || ''])
  ])
  return [...values]
    .filter((value) => value && path.isAbsolute(value))
    .sort((left, right) => right.length - left.length)
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scrubAbsolutePathText(value: string, sensitivePaths: string[]): string {
  let result = cleanText(value)
  for (const sensitivePath of sensitivePaths) {
    const variants = new Set([
      sensitivePath,
      sensitivePath.replace(/\\/g, '/'),
      sensitivePath.replace(/\//g, '\\')
    ])
    for (const variant of variants) {
      result = result.replace(new RegExp(escapeRegularExpression(variant), 'gi'), '[source path]')
    }
  }
  result = result
    .replace(/file:\/\/\/[^\s"'<>|\r\n]*/gi, '[source path]')
    .replace(/\b[A-Za-z]:[\\/][^"'<>|\r\n]*/g, '[source path]')
    .replace(/\\\\[^\\/\s]+[\\/][^"'<>|\r\n]*/g, '[source path]')
    .replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^"'<>|\r\n]*/g, '[source path]')
  return result
}

function recursivelyScrubPaths(value: unknown, sensitivePaths: string[]): unknown {
  if (typeof value === 'string') return scrubAbsolutePathText(value, sensitivePaths)
  if (Array.isArray(value)) return value.map((item) => recursivelyScrubPaths(item, sensitivePaths))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, recursivelyScrubPaths(item, sensitivePaths)])
    )
  }
  return value
}

function sanitizeCourseModel(model: CourseModel, packagePaths: Map<string, string>): ScormCourseModel {
  const gradeableInteractionCount = model.slides.reduce(
    (total, slide) => total + slide.interactions.filter(isGradeableInteraction).length,
    0
  )
  const sanitized: ScormCourseModel = {
    ...model,
    source: {
      ...model.source,
      rootPath: '.',
      projectRoot: '.',
      projectFile: path.basename(model.source.projectFile)
    },
    settings: {
      ...model.settings,
      id: cleanText(model.settings.id),
      publicId: model.settings.publicId ? cleanText(model.settings.publicId) : undefined,
      title: plainText(model.settings.title, ''),
      description: plainText(model.settings.description, ''),
      version: cleanText(model.settings.version),
      attributes: sanitizeStringMap(model.settings.attributes)
    },
    outline: model.outline.map(sanitizeOutlineNode),
    slides: model.slides.map((slide) => sanitizeSlide(slide, packagePaths)),
    assets: model.assets.map((asset) => sanitizeAssetModel(asset, packagePaths)),
    diagnostics: model.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: cleanText(diagnostic.message),
      source: diagnostic.source ? cleanText(diagnostic.source) : undefined
    })),
    scorm: {
      masteryScore: deriveMasteryScore(model),
      gradeableInteractionCount
    }
  }
  return recursivelyScrubPaths(sanitized, collectSensitivePaths(model)) as ScormCourseModel
}

function sanitizeGeometry(geometry: SlideObject['geometry']): SlideObject['geometry'] {
  const result: SlideObject['geometry'] = {}
  for (const key of ['left', 'top', 'right', 'bottom', 'width', 'height'] as const) {
    const value = geometry[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  return result
}

function sanitizeStringMap(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !/^on/i.test(key))
      .map(([key, value]) => [cleanText(key), cleanText(value)])
  )
}

function cleanText(value: string): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function optionalPlainText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : plainText(value, '')
}

function plainText(primary: string, htmlFallback: string): string {
  if (primary && primary.trim()) return cleanText(primary)
  if (!htmlFallback) return ''
  return cleanText(htmlFallback)
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function createIndexHtml(title: string): string {
  const safeTitle = escapeHtml(title || 'Untitled course')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="runtime/styles.css">
  <script defer src="course/course-data.js"></script>
  <script defer src="runtime/player.js"></script>
</head>
<body>
  <main class="app-shell">
    <header class="course-header">
      <h1 id="course-title">${safeTitle}</h1>
      <div class="progress-wrap">
        <label id="progress-label" for="course-progress">0% complete</label>
        <progress id="course-progress" value="0" max="1">0%</progress>
      </div>
    </header>
    <p id="player-warning" class="player-warning" role="alert" hidden></p>
    <article class="player-card" aria-labelledby="slide-title">
      <h2 id="slide-title" class="slide-heading">Loading…</h2>
      <section id="slide-stage" class="slide-stage" aria-label="Course slide"></section>
      <section id="interactions" class="interaction-panel" aria-label="Slide interactions" hidden></section>
      <nav class="navigation" aria-label="Slide navigation">
        <button id="previous-slide" type="button">Previous</button>
        <span id="slide-counter" class="slide-counter" aria-live="polite"></span>
        <button id="next-slide" type="button">Next</button>
      </nav>
    </article>
  </main>
  <noscript><p class="noscript-warning">JavaScript is required to run this course.</p></noscript>
</body>
</html>
`
}

function createManifest(model: ScormCourseModel, resourceFiles: string[]): string {
  const title = escapeXml(model.settings.title || 'Untitled course')
  const identifierPart = xmlIdentifier(model.settings.publicId || model.settings.id || 'course')
  const fileEntries = resourceFiles
    .filter((file) => file !== 'imsmanifest.xml' && !CONTROL_DOCUMENTS.has(file))
    .sort()
    .map((file) => `      <file href="${escapeXml(file)}" />`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${identifierPart}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:imsmd="http://www.imsglobal.org/xsd/imsmd_rootv1p2p1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-${identifierPart}">
    <organization identifier="ORG-${identifierPart}">
      <title>${title}</title>
      <item identifier="ITEM-${identifierPart}" identifierref="RES-${identifierPart}" isvisible="true">
        <title>${title}</title>
        <adlcp:masteryscore>${escapeXml(String(model.scorm.masteryScore))}</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-${identifierPart}" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileEntries}
    </resource>
  </resources>
</manifest>
`
}

function xmlIdentifier(value: string): string {
  const safe = safeSlug(value).replace(/-/g, '_').toUpperCase()
  return safe ? `COURSE_${safe}` : 'COURSE'
}

function escapeXml(value: string): string {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeHtml(value: string): string {
  return escapeXml(value)
}

function jsonForJavaScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

async function writePackageFile(folderPath: string, relativePath: string, contents: string): Promise<void> {
  const destination = containedPath(folderPath, relativePath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, contents, 'utf8')
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = []
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) result.push(...(await listFiles(root, fullPath)))
    else if (entry.isFile()) result.push(path.relative(root, fullPath).replace(/\\/g, '/'))
  }
  return result
}

async function createZip(folderPath: string, zipPath: string): Promise<void> {
  const zip = new AdmZip()
  const files = await listFiles(folderPath)
  for (const file of files.sort()) {
    const source = containedPath(folderPath, file)
    zip.addFile(file, await readFile(source))
  }
  await zip.writeZipPromise(zipPath, { overwrite: false })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
