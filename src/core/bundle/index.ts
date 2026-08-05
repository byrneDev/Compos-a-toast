import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'

import type { DiagnosticDto } from '../../shared/contracts'
import type {
  AssetKind,
  AssetModel,
  AssetReference,
  CourseModel,
  Interaction,
  SlideModel,
  SlideObject
} from '../model'

const BUNDLE_FORMAT = 'compos-a-toast-migration-bundle'
const BUNDLE_VERSION = '0.1.0'
const MARKER_FILE = '.compos-a-toast-bundle.json'
const CHECKSUM_FILE = 'reports/checksums.json'
const CAPTIVATE_NAME_LIMIT = 64

type Confidence = 'exact' | 'inferred' | 'unresolved'

interface AllowedRoot {
  lexical: string
  real: string
}

interface UnsupportedRow {
  category: string
  slide: string
  id: string
  type: string
  source: string
  reason: string
  severity: DiagnosticDto['severity']
}

interface CopiedAsset {
  key: string
  source: string
  kind: AssetKind
  exists: boolean
  localPath?: string
  sha256?: string
  size?: number
  confidence: Confidence
}

interface EnrichedObject extends SlideObject {
  proposedCaptivateName: string
  confidence: Confidence
  assetRefs: Array<{
    source: string
    kind: AssetKind
    exists: boolean
    localPath?: string
    sha256?: string
    confidence: Confidence
  }>
}

interface EnrichedInteraction extends Interaction {
  proposedCaptivateName: string
  confidence: Confidence
  options: Array<
    Interaction['options'][number] & {
      proposedCaptivateName: string
      confidence: Confidence
    }
  >
}

interface SlideExportRecord {
  model: SlideModel
  number: number
  folder: string
  sourceEvidence: 'original' | 'model-snapshot'
  objects: EnrichedObject[]
  interactions: EnrichedInteraction[]
  assets: CopiedAsset[]
}

interface BundleContext {
  model: CourseModel
  stagingPath: string
  allowedRoots: AllowedRoot[]
  diagnostics: DiagnosticDto[]
  unsupported: UnsupportedRow[]
}

/**
 * Export a neutral, evidence-preserving migration bundle. The result describes
 * native editable objects but deliberately does not manufacture a CPTX file;
 * that final step belongs to a version-specific Captivate adapter.
 */
export async function exportMigrationBundle(
  model: CourseModel,
  destinationRoot: string
): Promise<{ path: string; diagnostics: DiagnosticDto[] }> {
  const outputRoot = path.resolve(destinationRoot)
  await mkdir(outputRoot, { recursive: true })

  const bundleKey = stableHash(
    `${model.settings.publicId ?? ''}\u0000${model.settings.id}\u0000${model.settings.title}`
  ).slice(0, 8)
  const bundleName = `${safeSlug(model.settings.title || model.settings.id, 48)}-${bundleKey}-migration-bundle`
  const bundlePath = path.join(outputRoot, bundleName)
  assertDirectChild(outputRoot, bundlePath)
  await assertReplaceableBundle(bundlePath, bundleKey)

  const stagingPath = path.join(
    outputRoot,
    `.${bundleName}.building-${process.pid}-${randomUUID()}`
  )
  assertDirectChild(outputRoot, stagingPath)
  await mkdir(stagingPath, { recursive: false })

  const diagnostics = model.diagnostics.map((diagnostic) =>
    sanitizeDiagnostic(diagnostic, model)
  )
  const unsupported: UnsupportedRow[] = []
  let backupPath: string | undefined

  try {
    const allowedRoots = await resolveAllowedRoots(model, diagnostics)
    const context: BundleContext = {
      model,
      stagingPath,
      allowedRoots,
      diagnostics,
      unsupported
    }

    await createBundleDirectories(stagingPath)

    const slides: SlideExportRecord[] = []
    for (const [position, slide] of model.slides.entries()) {
      slides.push(await exportSlide(context, slide, position + 1))
    }

    const globalAssets = await exportGlobalAssets(context, model.assets)

    await writeJson(path.join(stagingPath, 'shared-assets/inventory.json'), {
      schemaVersion: BUNDLE_VERSION,
      note: 'This is a global source-asset inventory. Per-slide copies are stored in each slide assets folder.',
      assets: globalAssets
    })

    await writeCourseJson(context, slides)
    await writeCaptivateJob(context, slides)
    await writeManifestAndInventory(context, slides, globalAssets)
    await writeReports(context, slides, globalAssets)

    await writeJson(path.join(stagingPath, MARKER_FILE), {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      bundleKey
    })
    await writeChecksums(stagingPath)

    if (await pathExists(bundlePath)) {
      backupPath = path.join(
        outputRoot,
        `.${bundleName}.replaced-${process.pid}-${randomUUID()}`
      )
      assertDirectChild(outputRoot, backupPath)
      await rename(bundlePath, backupPath)
    }

    try {
      await rename(stagingPath, bundlePath)
    } catch (error) {
      if (backupPath && !(await pathExists(bundlePath))) {
        await rename(backupPath, bundlePath)
        backupPath = undefined
      }
      throw error
    }

    if (backupPath) {
      await rm(backupPath, { recursive: true, force: true })
      backupPath = undefined
    }

    return { path: bundlePath, diagnostics }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    if (backupPath && !(await pathExists(bundlePath))) {
      await rename(backupPath, bundlePath).catch(() => undefined)
    }
    throw error
  }
}

async function createBundleDirectories(stagingPath: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(stagingPath, 'slides'), { recursive: true }),
    mkdir(path.join(stagingPath, 'shared-assets/files'), { recursive: true }),
    mkdir(path.join(stagingPath, 'reports'), { recursive: true })
  ])
}

async function exportSlide(
  context: BundleContext,
  slide: SlideModel,
  number: number
): Promise<SlideExportRecord> {
  const generatedDiagnosticStart = context.diagnostics.length
  const slideSlug = safeSlug(slide.title || slide.id, 52)
  const folder = `slides/${String(number).padStart(4, '0')}-${slideSlug}`
  const slidePath = path.join(context.stagingPath, fromPortablePath(folder))

  await Promise.all(
    ['source', 'content', 'interactions', 'assets'].map((name) =>
      mkdir(path.join(slidePath, name), { recursive: true })
    )
  )

  const sourceEvidence = await preserveSlideSource(context, slide, slidePath)
  const inherited = await preserveInheritedSources(context, slide, slidePath)
  const assetRefs = deduplicateAssetReferences([
    ...slide.assetRefs,
    ...slide.objects.flatMap((object) => object.assetRefs),
    ...inherited.assetRefs
  ])
  const copiedAssets: CopiedAsset[] = []

  for (const assetRef of assetRefs) {
    copiedAssets.push(
      await copyAssetReference(context, assetRef, slide, path.join(slidePath, 'assets'), 'assets')
    )
  }

  const copiedByKey = new Map(copiedAssets.map((asset) => [asset.key, asset]))
  const usedNames = new Set<string>()
  const objects = slide.objects.map((object, index) =>
    enrichObject(object, slide, number, index, copiedByKey, usedNames, context)
  )
  const interactions = slide.interactions.map((interaction, index) =>
    enrichInteraction(interaction, slide, number, index, usedNames, context)
  )

  const previous = context.model.slides[number - 2]
  const next = context.model.slides[number]
  const navigationCandidates = objects
    .filter((object) => object.role === 'button' || object.role === 'interaction')
    .map((object) => ({
      objectId: object.id,
      proposedCaptivateName: object.proposedCaptivateName,
      confidence: object.confidence,
      attributes: Object.fromEntries(
        Object.entries(object.attributes).filter(([name]) =>
          /(?:action|href|link|nav|next|previous|goto|target)/i.test(name)
        )
      )
    }))
    .filter((candidate) => Object.keys(candidate.attributes).length > 0)

  const slideJson = {
    schemaVersion: BUNDLE_VERSION,
    id: slide.id,
    number,
    originalIndex: slide.index,
    title: slide.title,
    kind: slide.kind,
    outlinePath: slide.outlinePath,
    sourceRelativePath: safeSourceLabel(slide.sourceRelativePath, context.model),
    sourceEvidence,
    inheritedSources: inherited.sources,
    masterId: slide.masterId,
    dimensions: {
      width: context.model.settings.width,
      height: context.model.settings.height
    },
    objects,
    interactions,
    assets: copiedAssets.map(stripInternalAssetKey),
    diagnostics: [
      ...slide.diagnostics.map((diagnostic) => sanitizeDiagnostic(diagnostic, context.model)),
      ...context.diagnostics.slice(generatedDiagnosticStart)
    ]
  }

  await Promise.all([
    writeJson(path.join(slidePath, 'slide.json'), slideJson),
    writeJson(
      path.join(slidePath, 'content/text.json'),
      objects
        .filter((object) => object.role === 'text' || object.text.length > 0)
        .map((object) => ({
          id: object.id,
          proposedCaptivateName: object.proposedCaptivateName,
          confidence: object.confidence,
          text: object.text,
          html: object.html,
          geometry: object.geometry,
          style: object.style,
          zIndex: object.zIndex
        }))
    ),
    writeJson(path.join(slidePath, 'content/objects.json'), {
      schemaVersion: BUNDLE_VERSION,
      objects
    }),
    writeJson(path.join(slidePath, 'content/navigation.json'), {
      schemaVersion: BUNDLE_VERSION,
      confidence: 'inferred',
      outlinePath: slide.outlinePath,
      linear: {
        previousSlideId: previous?.id,
        nextSlideId: next?.id
      },
      candidates: navigationCandidates
    }),
    writeJson(path.join(slidePath, 'interactions/interactions.json'), {
      schemaVersion: BUNDLE_VERSION,
      interactions
    }),
    writeFile(
      path.join(slidePath, 'reconstruction.md'),
      buildReconstructionMarkdown(context.model, slide, number, objects, interactions),
      'utf8'
    )
  ])

  return {
    model: slide,
    number,
    folder,
    sourceEvidence,
    objects,
    interactions,
    assets: copiedAssets
  }
}

async function preserveInheritedSources(
  context: BundleContext,
  slide: SlideModel,
  slidePath: string
): Promise<{
  sources: Array<{ type: 'master' | 'theme'; source: string; localPath: string }>
  assetRefs: AssetReference[]
}> {
  const requested: Array<{
    type: 'master' | 'theme'
    value: string | undefined
    outputName: string
  }> = [
    { type: 'master', value: slide.masterId, outputName: 'master.html' },
    {
      type: 'theme',
      value: context.model.settings.theme,
      outputName: `theme${path.extname(context.model.settings.theme ?? '') || '.css'}`
    }
  ]
  const preserved: Array<{ type: 'master' | 'theme'; source: string; localPath: string }> = []
  const assetRefs: AssetReference[] = []

  for (const item of requested) {
    if (!item.value || isExternalReference(item.value)) continue
    const resolution = await resolveSourceFile(
      context,
      item.value,
      context.model.source.projectRoot,
      `${item.type} source for slide ${slide.id}`
    )
    if (!resolution.path) {
      context.diagnostics.push({
        severity: 'warning',
        code: `BUNDLE_${item.type.toUpperCase()}_SOURCE_${resolution.rejected ? 'REJECTED' : 'MISSING'}`,
        message: `The inherited ${item.type} source for slide "${slide.title}" could not be preserved.`,
        source: safeSourceLabel(item.value, context.model)
      })
      continue
    }

    const localPath = `source/${item.outputName}`
    await copyFile(resolution.path, path.join(slidePath, fromPortablePath(localPath)))
    const inheritedText = await readFile(resolution.path, 'utf8').catch(() => '')
    for (const source of extractInheritedAssetSources(inheritedText)) {
      if (isExternalReference(source) || /^data:/i.test(source)) continue
      const cleanSource = fromPortablePath(
        stripQueryAndFragment(safeDecodeUri(source)).replace(/^[\\/]+/, '')
      )
      const baseDirectories = uniquePaths([
        path.dirname(resolution.path),
        context.model.source.projectRoot,
        path.dirname(path.dirname(context.model.source.projectRoot)),
        context.model.source.rootPath
      ])
      let assetResolution: { path?: string; rejected: boolean } = { rejected: false }
      for (const baseDirectory of baseDirectories) {
        assetResolution = await resolveSourceFile(
          context,
          cleanSource,
          baseDirectory,
          `${item.type} asset ${source}`
        )
        if (assetResolution.path) break
      }
      const inventoryAsset = assetResolution.path
        ? context.model.assets.find(
            (asset) => asset.resolvedPath && samePath(path.resolve(asset.resolvedPath), assetResolution.path!)
          )
        : undefined
      assetRefs.push({
        source,
        resolvedPath: assetResolution.path,
        kind: inventoryAsset?.kind ?? assetKindFromSource(source),
        exists: Boolean(assetResolution.path)
      })
    }
    preserved.push({
      type: item.type,
      source: safeSourceLabel(resolution.path, context.model),
      localPath
    })
  }

  return { sources: preserved, assetRefs: deduplicateAssetReferences(assetRefs) }
}

function extractInheritedAssetSources(sourceText: string): string[] {
  const sources: string[] = []
  const attributePattern = /\b(?:src|href|poster|background)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
  for (const match of sourceText.matchAll(attributePattern)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value) sources.push(value.trim())
  }
  for (const match of sourceText.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (match[2]) sources.push(match[2].trim())
  }
  return [...new Set(sources.filter(Boolean))]
}

function assetKindFromSource(source: string): AssetKind {
  const extension = path.extname(stripQueryAndFragment(source)).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp', '.tif', '.tiff'].includes(extension)) {
    return 'image'
  }
  if (['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.wma', '.mid', '.midi'].includes(extension)) {
    return 'audio'
  }
  if (['.mp4', '.m4v', '.webm', '.avi', '.mov', '.wmv', '.flv'].includes(extension)) {
    return 'video'
  }
  if (extension === '.swf') return 'flash'
  if (['.ttf', '.otf', '.woff', '.woff2', '.eot'].includes(extension)) return 'font'
  if (extension === '.css') return 'stylesheet'
  return 'other'
}

async function preserveSlideSource(
  context: BundleContext,
  slide: SlideModel,
  slidePath: string
): Promise<'original' | 'model-snapshot'> {
  const outputPath = path.join(slidePath, 'source/page.html')
  const resolution = await resolveSourceFile(
    context,
    slide.sourcePath,
    undefined,
    `slide ${slide.id} source`
  )

  if (resolution.path) {
    await copyFile(resolution.path, outputPath)
    return 'original'
  }

  await writeFile(outputPath, slide.sourceHtml, 'utf8')
  context.diagnostics.push({
    severity: 'warning',
    code: resolution.rejected
      ? 'BUNDLE_SLIDE_SOURCE_REJECTED'
      : 'BUNDLE_SLIDE_SOURCE_SNAPSHOT',
    message: resolution.rejected
      ? `The original source for slide "${slide.title}" was outside the approved course tree; the parsed model snapshot was preserved instead.`
      : `The original source for slide "${slide.title}" was unavailable; the parsed model snapshot was preserved instead.`,
    source: safeSourceLabel(slide.sourceRelativePath || slide.sourcePath, context.model)
  })
  context.unsupported.push({
    category: 'source',
    slide: slide.id,
    id: slide.id,
    type: 'page-html',
    source: safeSourceLabel(slide.sourceRelativePath || slide.sourcePath, context.model),
    reason: resolution.rejected
      ? 'Original path rejected by course-tree boundary check; model snapshot used'
      : 'Original source missing; model snapshot used',
    severity: 'warning'
  })
  return 'model-snapshot'
}

function enrichObject(
  object: SlideObject,
  slide: SlideModel,
  slideNumber: number,
  objectIndex: number,
  copiedAssets: Map<string, CopiedAsset>,
  usedNames: Set<string>,
  context: BundleContext
): EnrichedObject {
  const confidence = objectConfidence(object)
  const proposedCaptivateName = uniqueCaptivateName(
    `${object.role}_${String(slideNumber).padStart(4, '0')}_${object.id || objectIndex + 1}`,
    `${slide.id}\u0000${object.id}\u0000${objectIndex}`,
    usedNames
  )

  if (confidence === 'unresolved') {
    context.unsupported.push({
      category: 'object',
      slide: slide.id,
      id: object.id,
      type: object.role,
      source: safeSourceLabel(slide.sourceRelativePath, context.model),
      reason: 'Object role could not be mapped to a native editable Captivate object',
      severity: 'warning'
    })
  }

  return {
    ...object,
    proposedCaptivateName,
    confidence,
    assetRefs: object.assetRefs.map((assetRef) => {
      const copied = copiedAssets.get(assetReferenceKey(assetRef))
      return copied
        ? stripInternalAssetKey(copied)
        : {
            source: safeAssetSource(assetRef.source, context.model),
            kind: assetRef.kind,
            exists: false,
            confidence: 'unresolved'
          }
    })
  }
}

function enrichInteraction(
  interaction: Interaction,
  slide: SlideModel,
  slideNumber: number,
  interactionIndex: number,
  usedNames: Set<string>,
  context: BundleContext
): EnrichedInteraction {
  const confidence = interactionConfidence(interaction)
  const proposedCaptivateName = uniqueCaptivateName(
    `interaction_${String(slideNumber).padStart(4, '0')}_${interaction.id || interactionIndex + 1}`,
    `${slide.id}\u0000${interaction.id}\u0000interaction`,
    usedNames
  )

  if (confidence !== 'exact') {
    context.unsupported.push({
      category: 'interaction',
      slide: slide.id,
      id: interaction.id,
      type: interaction.type,
      source: safeSourceLabel(slide.sourceRelativePath, context.model),
      reason:
        confidence === 'unresolved'
          ? 'Interaction type is unknown and requires manual reconstruction'
          : 'Interaction semantics require adapter validation or native reconstruction',
      severity: confidence === 'unresolved' ? 'warning' : 'info'
    })
  }

  return {
    ...interaction,
    proposedCaptivateName,
    confidence,
    options: interaction.options.map((option, optionIndex) => ({
      ...option,
      proposedCaptivateName: uniqueCaptivateName(
        `answer_${String(slideNumber).padStart(4, '0')}_${option.id || optionIndex + 1}`,
        `${slide.id}\u0000${interaction.id}\u0000${option.id}\u0000${optionIndex}`,
        usedNames
      ),
      confidence: option.id ? 'exact' : 'inferred'
    }))
  }
}

async function exportGlobalAssets(
  context: BundleContext,
  assets: AssetModel[]
): Promise<
  Array<
    Omit<CopiedAsset, 'key'> & {
      id: string
      relativePath: string
      usedBySlides: string[]
      modelSize: number
      modelSha256?: string
    }
  >
> {
  const outputDirectory = path.join(context.stagingPath, 'shared-assets/files')
  const records: Array<
    Omit<CopiedAsset, 'key'> & {
      id: string
      relativePath: string
      usedBySlides: string[]
      modelSize: number
      modelSha256?: string
    }
  > = []

  for (const asset of assets) {
    const copied = await copyAssetReference(
      context,
      asset,
      undefined,
      outputDirectory,
      'files'
    )
    records.push({
      ...stripInternalAssetKey(copied),
      id: asset.id,
      relativePath: safeSourceLabel(asset.relativePath, context.model),
      usedBySlides: asset.usedBySlides,
      modelSize: asset.size,
      modelSha256: asset.sha256
    })
  }

  return records.sort((left, right) =>
    `${left.relativePath}\u0000${left.id}`.localeCompare(`${right.relativePath}\u0000${right.id}`)
  )
}

async function copyAssetReference(
  context: BundleContext,
  asset: AssetReference,
  slide: SlideModel | undefined,
  outputDirectory: string,
  localPrefix: string
): Promise<CopiedAsset> {
  const key = assetReferenceKey(asset)
  const source = safeAssetSource(asset.source, context.model)
  const resolution = await resolveAssetFile(context, asset, slide)

  if (!resolution.path) {
    const code = resolution.external
      ? 'BUNDLE_ASSET_EXTERNAL_NOT_COPIED'
      : resolution.rejected
        ? 'BUNDLE_ASSET_PATH_REJECTED'
        : 'BUNDLE_ASSET_MISSING'
    const reason = resolution.external
      ? 'External/data reference was recorded but not downloaded'
      : resolution.rejected
        ? 'Asset path was outside the approved course source tree'
        : 'Referenced asset was not found in the approved course source tree'

    context.diagnostics.push({
      severity: 'warning',
      code,
      message: `${reason}: ${source || '(empty reference)'}`,
      source: slide ? safeSourceLabel(slide.sourceRelativePath, context.model) : source
    })
    context.unsupported.push({
      category: 'asset',
      slide: slide?.id ?? '',
      id: '',
      type: asset.kind,
      source,
      reason,
      severity: 'warning'
    })
    return {
      key,
      source,
      kind: asset.kind,
      exists: false,
      confidence: 'unresolved'
    }
  }

  const relativeIdentity = portableRelativeToAllowedRoot(resolution.path, context.allowedRoots)
  const fileName = collisionSafeAssetName(
    path.basename(resolution.path),
    relativeIdentity || source || resolution.path
  )
  const destination = path.join(outputDirectory, fileName)
  await mkdir(outputDirectory, { recursive: true })
  await copyFile(resolution.path, destination)
  const [sha256, fileStats] = await Promise.all([hashFile(destination), stat(destination)])

  if (asset.kind === 'flash' || path.extname(resolution.path).toLowerCase() === '.swf') {
    context.diagnostics.push({
      severity: 'warning',
      code: 'BUNDLE_FLASH_PRESERVED_AS_EVIDENCE',
      message: `Flash asset was copied without execution and requires replacement or a dedicated adapter: ${source}`,
      source: slide ? safeSourceLabel(slide.sourceRelativePath, context.model) : source
    })
    context.unsupported.push({
      category: 'asset',
      slide: slide?.id ?? '',
      id: '',
      type: 'flash',
      source,
      reason: 'Preserved as inert evidence; native HTML5/Captivate replacement is required',
      severity: 'warning'
    })
  }

  return {
    key,
    source,
    kind: asset.kind,
    exists: true,
    localPath: `${localPrefix}/${fileName}`,
    sha256,
    size: fileStats.size,
    confidence: 'exact'
  }
}

async function resolveAssetFile(
  context: BundleContext,
  asset: AssetReference,
  slide?: SlideModel
): Promise<{
  path?: string
  rejected: boolean
  external: boolean
}> {
  const sourceWithoutQuery = stripQueryAndFragment(asset.source.trim())
  if (isExternalReference(sourceWithoutQuery)) {
    return { rejected: false, external: true }
  }

  const candidates: string[] = []
  if (asset.resolvedPath) {
    if (path.isAbsolute(asset.resolvedPath)) {
      candidates.push(path.resolve(asset.resolvedPath))
    } else {
      candidates.push(path.resolve(context.model.source.projectRoot, asset.resolvedPath))
      candidates.push(path.resolve(context.model.source.rootPath, asset.resolvedPath))
    }
  }

  const decodedSource = safeDecodeUri(sourceWithoutQuery)
  if (decodedSource) {
    if (path.isAbsolute(decodedSource)) {
      candidates.push(path.resolve(decodedSource))
    } else {
      if (slide?.sourcePath) {
        candidates.push(path.resolve(path.dirname(slide.sourcePath), fromPortablePath(decodedSource)))
      }
      candidates.push(
        path.resolve(context.model.source.projectRoot, fromPortablePath(decodedSource)),
        path.resolve(context.model.source.rootPath, fromPortablePath(decodedSource))
      )
    }
  }

  let rejected = candidates.length > 0
  for (const candidate of uniquePaths(candidates)) {
    const result = await resolveSourceFile(context, candidate, undefined, `asset ${asset.source}`)
    if (result.path) {
      return { path: result.path, rejected: false, external: false }
    }
    if (!result.rejected) {
      rejected = false
    }
  }

  return { rejected, external: false }
}

async function resolveSourceFile(
  context: BundleContext,
  value: string,
  baseDirectory: string | undefined,
  _description: string
): Promise<{ path?: string; rejected: boolean }> {
  if (!value) {
    return { rejected: false }
  }

  const candidate = path.resolve(baseDirectory ?? context.model.source.projectRoot, value)
  const lexicalRoot = context.allowedRoots.find((root) => isWithin(root.lexical, candidate))
  if (!lexicalRoot) {
    return { rejected: true }
  }

  try {
    const candidateStats = await stat(candidate)
    if (!candidateStats.isFile()) {
      return { rejected: false }
    }
    const realCandidate = await realpath(candidate)
    const realRoot = context.allowedRoots.find((root) => isWithin(root.real, realCandidate))
    return realRoot ? { path: realCandidate, rejected: false } : { rejected: true }
  } catch {
    return { rejected: false }
  }
}

async function resolveAllowedRoots(
  model: CourseModel,
  diagnostics: DiagnosticDto[]
): Promise<AllowedRoot[]> {
  const roots: AllowedRoot[] = []
  for (const value of [model.source.rootPath, model.source.projectRoot]) {
    if (!value) continue
    const lexical = path.resolve(value)
    try {
      const rootStats = await stat(lexical)
      if (!rootStats.isDirectory()) throw new Error('not a directory')
      const real = await realpath(lexical)
      if (!roots.some((root) => samePath(root.real, real))) {
        roots.push({ lexical, real })
      }
    } catch {
      diagnostics.push({
        severity: 'warning',
        code: 'BUNDLE_SOURCE_ROOT_UNAVAILABLE',
        message: `A declared course source root is unavailable; no evidence will be copied from it.`,
        source: path.basename(lexical)
      })
    }
  }

  if (roots.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'BUNDLE_NO_SOURCE_ROOT',
      message: 'No approved course source tree was available. Slide HTML model snapshots will be written, but source assets cannot be copied.'
    })
  }
  return roots
}

async function writeCourseJson(
  context: BundleContext,
  slides: SlideExportRecord[]
): Promise<void> {
  const model = context.model
  await writeJson(path.join(context.stagingPath, 'course.json'), {
    schemaVersion: model.schemaVersion,
    bundleVersion: BUNDLE_VERSION,
    generatedAt: model.generatedAt,
    source: {
      format: model.source.format,
      projectFile: safeSourceLabel(model.source.projectFile, model),
      note: 'Absolute machine paths are intentionally omitted. Original page evidence is stored inside each slide folder.'
    },
    settings: sanitizeCourseJsonValue(model.settings, model),
    outline: sanitizeCourseJsonValue(model.outline, model),
    slides: slides.map((slide) => ({
      number: slide.number,
      id: slide.model.id,
      title: slide.model.title,
      kind: slide.model.kind,
      folder: slide.folder,
      sourceRelativePath: safeSourceLabel(slide.model.sourceRelativePath, model),
      sourceEvidence: slide.sourceEvidence,
      objectCount: slide.objects.length,
      interactionCount: slide.interactions.length,
      assetCount: slide.assets.length
    })),
    diagnostics: context.diagnostics
  })
}

async function writeCaptivateJob(
  context: BundleContext,
  slides: SlideExportRecord[]
): Promise<void> {
  await writeJson(path.join(context.stagingPath, 'captivate-job.json'), {
    schemaVersion: BUNDLE_VERSION,
    target: {
      format: 'cptx',
      editable: true,
      adapterRequired: true
    },
    notice:
      'This bundle is not a CPTX file. A version-pinned Captivate adapter must create and save the CPTX inside Adobe Captivate. Do not rename or zip this JSON as CPTX.',
    requirements: [
      'Create native editable Captivate objects; do not flatten a slide into a screenshot.',
      'Use proposedCaptivateName for stable object names.',
      'Treat exact, inferred, and unresolved confidence values as review gates.',
      'Preserve z-order, geometry, styling, feedback, scoring, and navigation where represented.',
      'Save, reopen, publish, and visually compare the generated CPTX before acceptance.'
    ],
    course: {
      id: context.model.settings.id,
      title: context.model.settings.title,
      width: context.model.settings.width,
      height: context.model.settings.height,
      version: context.model.settings.version
    },
    slides: slides.map((slide) => ({
      number: slide.number,
      sourceId: slide.model.id,
      title: slide.model.title,
      kind: slide.model.kind,
      bundleFolder: slide.folder,
      operation: 'createNativeSlide',
      nativeObjects: slide.objects.map((object) => ({
        operation: 'createNativeObject',
        sourceId: object.id,
        proposedCaptivateName: object.proposedCaptivateName,
        confidence: object.confidence,
        nativeType: captivateNativeType(object),
        geometry: object.geometry,
        zIndex: object.zIndex,
        text: object.text,
        html: object.html,
        style: object.style,
        assetRefs: object.assetRefs
      })),
      nativeInteractions: slide.interactions.map((interaction) => ({
        operation: 'createNativeInteraction',
        sourceId: interaction.id,
        objectId: interaction.objectId,
        proposedCaptivateName: interaction.proposedCaptivateName,
        confidence: interaction.confidence,
        nativeType: interaction.type,
        prompt: interaction.prompt,
        options: interaction.options,
        answers: interaction.answers,
        feedback: interaction.feedback,
        attributes: interaction.attributes
      }))
    }))
  })
}

async function writeManifestAndInventory(
  context: BundleContext,
  slides: SlideExportRecord[],
  globalAssets: Array<{ exists: boolean; kind: AssetKind; size?: number }>
): Promise<void> {
  const objectCount = slides.reduce((total, slide) => total + slide.objects.length, 0)
  const interactionCount = slides.reduce(
    (total, slide) => total + slide.interactions.length,
    0
  )

  await writeJson(path.join(context.stagingPath, 'manifest.json'), {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    courseId: context.model.settings.id,
    courseTitle: context.model.settings.title,
    entryPoints: {
      course: 'course.json',
      captivateAdapterJob: 'captivate-job.json',
      inventory: 'inventory.json',
      report: 'reports/inventory.html',
      unsupported: 'reports/unsupported.csv',
      checksums: CHECKSUM_FILE
    },
    evidencePolicy: {
      originalsPreserved: true,
      sourceExecutionPerformed: false,
      absoluteMachinePathsIncluded: false
    },
    integrity: {
      algorithm: 'sha256',
      file: CHECKSUM_FILE,
      note: 'The checksum report excludes itself.'
    }
  })

  await writeJson(path.join(context.stagingPath, 'inventory.json'), {
    schemaVersion: BUNDLE_VERSION,
    counts: {
      slides: slides.length,
      objects: objectCount,
      interactions: interactionCount,
      sourceAssets: globalAssets.length,
      copiedSourceAssets: globalAssets.filter((asset) => asset.exists).length,
      unresolvedSourceAssets: globalAssets.filter((asset) => !asset.exists).length,
      diagnostics: context.diagnostics.length,
      unsupported: context.unsupported.length
    },
    assetKinds: countBy(globalAssets, (asset) => asset.kind),
    slides: slides.map((slide) => ({
      number: slide.number,
      id: slide.model.id,
      title: slide.model.title,
      folder: slide.folder,
      sourceEvidence: slide.sourceEvidence,
      objects: slide.objects.length,
      interactions: slide.interactions.length,
      assets: slide.assets.length,
      unresolvedObjects: slide.objects.filter((object) => object.confidence === 'unresolved')
        .length,
      unresolvedInteractions: slide.interactions.filter(
        (interaction) => interaction.confidence === 'unresolved'
      ).length
    }))
  })
}

async function writeReports(
  context: BundleContext,
  slides: SlideExportRecord[],
  globalAssets: Array<{ exists: boolean; kind: AssetKind; source: string }>
): Promise<void> {
  const rows = slides
    .map(
      (slide) => `<tr>
        <td>${slide.number}</td>
        <td>${escapeHtml(slide.model.title)}</td>
        <td>${escapeHtml(slide.model.kind)}</td>
        <td>${slide.objects.length}</td>
        <td>${slide.interactions.length}</td>
        <td>${slide.assets.filter((asset) => asset.exists).length}/${slide.assets.length}</td>
        <td>${escapeHtml(slide.sourceEvidence)}</td>
      </tr>`
    )
    .join('\n')
  const diagnosticRows = context.diagnostics
    .map(
      (diagnostic) => `<tr>
        <td>${escapeHtml(diagnostic.severity)}</td>
        <td>${escapeHtml(diagnostic.code)}</td>
        <td>${escapeHtml(diagnostic.message)}</td>
        <td>${escapeHtml(diagnostic.source ?? '')}</td>
      </tr>`
    )
    .join('\n')

  const report = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(context.model.settings.title)} migration inventory</title>
  <style>
    body { color: #18212b; font: 14px/1.5 system-ui, sans-serif; margin: 2rem; }
    h1, h2 { line-height: 1.2; }
    .summary { display: flex; flex-wrap: wrap; gap: 1rem; padding: 0; }
    .summary li { background: #eef3f8; border-radius: .4rem; list-style: none; padding: .7rem 1rem; }
    table { border-collapse: collapse; margin-block: 1rem 2rem; width: 100%; }
    th, td { border: 1px solid #c8d1dc; padding: .45rem .6rem; text-align: left; vertical-align: top; }
    th { background: #e6edf5; }
    code { background: #eef3f8; padding: .1rem .25rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(context.model.settings.title)}</h1>
  <p>Editable migration-bundle inventory. Source files were copied as inert evidence and were not executed.</p>
  <ul class="summary">
    <li><strong>${slides.length}</strong> slides</li>
    <li><strong>${slides.reduce((sum, slide) => sum + slide.objects.length, 0)}</strong> objects</li>
    <li><strong>${slides.reduce((sum, slide) => sum + slide.interactions.length, 0)}</strong> interactions</li>
    <li><strong>${globalAssets.filter((asset) => asset.exists).length}/${globalAssets.length}</strong> global assets copied</li>
    <li><strong>${context.unsupported.length}</strong> review items</li>
  </ul>
  <h2>Slides</h2>
  <table>
    <thead><tr><th>#</th><th>Title</th><th>Kind</th><th>Objects</th><th>Interactions</th><th>Assets copied</th><th>Source evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Diagnostics</h2>
  <table>
    <thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>Source</th></tr></thead>
    <tbody>${diagnosticRows}</tbody>
  </table>
  <p>See <code>unsupported.csv</code> for adapter/manual-review items and <code>checksums.json</code> for file integrity.</p>
</body>
</html>
`

  await writeFile(path.join(context.stagingPath, 'reports/inventory.html'), report, 'utf8')

  const csvHeader = ['category', 'slide', 'id', 'type', 'source', 'reason', 'severity']
  const csvRows = [...context.unsupported]
    .sort((left, right) =>
      `${left.slide}\u0000${left.category}\u0000${left.id}\u0000${left.source}`.localeCompare(
        `${right.slide}\u0000${right.category}\u0000${right.id}\u0000${right.source}`
      )
    )
    .map((row) =>
      [row.category, row.slide, row.id, row.type, row.source, row.reason, row.severity]
        .map(csvCell)
        .join(',')
    )
  await writeFile(
    path.join(context.stagingPath, 'reports/unsupported.csv'),
    `${csvHeader.join(',')}\n${csvRows.join('\n')}${csvRows.length ? '\n' : ''}`,
    'utf8'
  )
}

async function writeChecksums(stagingPath: string): Promise<void> {
  const files = (await listFiles(stagingPath))
    .map((absolutePath) => ({
      absolutePath,
      relativePath: toPortablePath(path.relative(stagingPath, absolutePath))
    }))
    .filter((file) => file.relativePath !== CHECKSUM_FILE)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const entries = []
  for (const file of files) {
    const fileStats = await stat(file.absolutePath)
    entries.push({
      path: file.relativePath,
      size: fileStats.size,
      sha256: await hashFile(file.absolutePath)
    })
  }

  await writeJson(path.join(stagingPath, fromPortablePath(CHECKSUM_FILE)), {
    algorithm: 'sha256',
    excludes: [CHECKSUM_FILE],
    files: entries
  })
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)))
    } else if (entry.isFile()) {
      files.push(absolutePath)
    }
  }
  return files
}

function buildReconstructionMarkdown(
  model: CourseModel,
  slide: SlideModel,
  number: number,
  objects: EnrichedObject[],
  interactions: EnrichedInteraction[]
): string {
  const objectRows = objects
    .map(
      (object) =>
        `| ${markdownCell(object.proposedCaptivateName)} | ${markdownCell(object.role)} | ${markdownCell(object.confidence)} | ${markdownCell(formatGeometry(object.geometry))} | ${markdownCell(shortText(object.text))} |`
    )
    .join('\n')
  const interactionRows = interactions
    .map(
      (interaction) =>
        `| ${markdownCell(interaction.proposedCaptivateName)} | ${markdownCell(interaction.type)} | ${markdownCell(interaction.confidence)} | ${markdownCell(shortText(interaction.prompt))} |`
    )
    .join('\n')

  return `# ${markdownHeading(slide.title || `Slide ${number}`)}

- Source ID: \`${inlineCode(slide.id)}\`
- Canvas: ${model.settings.width} x ${model.settings.height}
- Kind: ${slide.kind}
- Source evidence: \`source/page.html\` (preserved for inspection only; do not run it as an application)
- Captivate output: native editable objects are required; screenshots may be used only for visual comparison.

## Reconstruction order

1. Create a ${model.settings.width} x ${model.settings.height} native Captivate slide.
2. Recreate objects in z-order using the stable proposed names below.
3. Rebuild interactions and feedback from \`interactions/interactions.json\`.
4. Apply navigation from \`content/navigation.json\` and validate every inferred or unresolved item.
5. Compare against the source evidence, save, reopen, and publish the CPTX.

## Objects

| Proposed Captivate name | Role | Confidence | Geometry | Text preview |
| --- | --- | --- | --- | --- |
${objectRows || '| _(none)_ | | | | |'}

## Interactions

| Proposed Captivate name | Type | Confidence | Prompt preview |
| --- | --- | --- | --- |
${interactionRows || '| _(none)_ | | | |'}
`
}

function objectConfidence(object: SlideObject): Confidence {
  if (object.role === 'unknown') return 'unresolved'
  if (!object.id || !object.sourceTag) return 'inferred'
  if (object.role === 'text' || object.role === 'image') return 'exact'
  return 'inferred'
}

function interactionConfidence(interaction: Interaction): Confidence {
  if (interaction.type === 'unknown') return 'unresolved'
  if (
    (interaction.type === 'multiple-choice' || interaction.type === 'fill-blank') &&
    interaction.id &&
    interaction.answers.length > 0
  ) {
    return 'exact'
  }
  return 'inferred'
}

function captivateNativeType(object: EnrichedObject): string {
  switch (object.role) {
    case 'text':
      return 'text-caption-or-smart-shape'
    case 'image':
      return 'image'
    case 'shape':
      return 'smart-shape'
    case 'button':
      return 'button-or-smart-shape-button'
    case 'media':
      return 'media'
    case 'interaction':
      return 'native-interaction'
    case 'container':
      return 'group-or-native-objects'
    default:
      return 'manual-review'
  }
}

function uniqueCaptivateName(seed: string, identity: string, used: Set<string>): string {
  const cleaned = seed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = /^[A-Za-z]/.test(cleaned) ? cleaned : `cp_${cleaned || 'object'}`
  const suffix = stableHash(identity).slice(0, 7)
  let candidate = `${base.slice(0, CAPTIVATE_NAME_LIMIT - suffix.length - 1)}_${suffix}`
  let collision = 1
  while (used.has(candidate.toLowerCase())) {
    const counter = `_${collision}`
    candidate = `${base.slice(0, CAPTIVATE_NAME_LIMIT - suffix.length - counter.length - 1)}_${suffix}${counter}`
    collision += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function safeSlug(value: string, maximumLength: number): string {
  let slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maximumLength)
    .replace(/-+$/g, '')
  if (!slug) slug = 'course'
  if (isWindowsReservedName(slug)) slug = `course-${slug}`
  return slug
}

function collisionSafeAssetName(originalName: string, identity: string): string {
  const extensionCandidate = path.extname(originalName).toLowerCase()
  const extension = /^\.[a-z0-9]{1,12}$/.test(extensionCandidate)
    ? extensionCandidate
    : '.bin'
  const originalStem = extensionCandidate
    ? originalName.slice(0, -extensionCandidate.length)
    : originalName
  const stem = safeSlug(originalStem || 'asset', 64)
  return `${stem}-${stableHash(toPortablePath(identity).toLowerCase()).slice(0, 10)}${extension}`
}

function deduplicateAssetReferences(references: AssetReference[]): AssetReference[] {
  const unique = new Map<string, AssetReference>()
  for (const reference of references) {
    const key = assetReferenceKey(reference)
    if (!unique.has(key)) unique.set(key, reference)
  }
  return [...unique.values()].sort((left, right) =>
    assetReferenceKey(left).localeCompare(assetReferenceKey(right))
  )
}

function assetReferenceKey(asset: AssetReference): string {
  return `${asset.kind}\u0000${asset.resolvedPath ?? ''}\u0000${asset.source}`
}

function stripInternalAssetKey(asset: CopiedAsset): Omit<CopiedAsset, 'key'> {
  const { key: _key, ...publicAsset } = asset
  return publicAsset
}

function safeAssetSource(source: string, model: CourseModel): string {
  if (isExternalReference(source)) return source
  return safeSourceLabel(source, model)
}

function safeSourceLabel(value: string, model: CourseModel): string {
  if (!value) return ''
  if (isExternalReference(value)) return value

  const absolute = path.isAbsolute(value) ? path.resolve(value) : undefined
  if (absolute) {
    for (const rootValue of [model.source.projectRoot, model.source.rootPath]) {
      if (!rootValue) continue
      const root = path.resolve(rootValue)
      if (isWithin(root, absolute)) {
        return toPortablePath(path.relative(root, absolute)) || path.basename(absolute)
      }
    }
    return path.basename(absolute)
  }

  const portable = toPortablePath(value).replace(/^\.\//, '')
  if (portable === '..' || portable.startsWith('../')) return path.basename(value)
  return portable
}

function sanitizeDiagnostic(diagnostic: DiagnosticDto, model: CourseModel): DiagnosticDto {
  return {
    ...diagnostic,
    message: sanitizeKnownMachinePaths(diagnostic.message, model),
    source: diagnostic.source ? safeSourceLabel(diagnostic.source, model) : undefined
  }
}

function sanitizeCourseJsonValue(value: unknown, model: CourseModel): unknown {
  if (typeof value === 'string') {
    return looksLikeAbsolutePath(value)
      ? safeSourceLabel(value, model)
      : sanitizeKnownMachinePaths(value, model)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCourseJsonValue(item, model))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeCourseJsonValue(item, model)])
    )
  }
  return value
}

function sanitizeKnownMachinePaths(value: string, model: CourseModel): string {
  const replacements = [
    { value: model.source.projectFile, replacement: safeSourceLabel(model.source.projectFile, model) },
    { value: model.source.projectRoot, replacement: '[project-root]' },
    { value: model.source.rootPath, replacement: '[course-root]' }
  ].sort((left, right) => right.value.length - left.value.length)

  let sanitized = value
  for (const replacement of replacements) {
    if (!replacement.value) continue
    const variants = new Set([
      replacement.value,
      replacement.value.replace(/\\/g, '/'),
      replacement.value.replace(/\//g, '\\')
    ])
    for (const variant of variants) {
      sanitized = sanitized.replace(
        new RegExp(escapeRegExp(variant), process.platform === 'win32' ? 'gi' : 'g'),
        replacement.replacement
      )
    }
  }
  return sanitized
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function looksLikeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
}

function portableRelativeToAllowedRoot(value: string, roots: AllowedRoot[]): string {
  const root = roots.find((candidate) => isWithin(candidate.real, value))
  return root ? toPortablePath(path.relative(root.real, value)) : path.basename(value)
}

async function assertReplaceableBundle(bundlePath: string, bundleKey: string): Promise<void> {
  if (!(await pathExists(bundlePath))) return
  const bundleStats = await stat(bundlePath)
  if (!bundleStats.isDirectory()) {
    throw new Error(`Refusing to replace non-directory output path: ${bundlePath}`)
  }

  const entries = await readdir(bundlePath)
  if (entries.length === 0) return

  try {
    const marker = JSON.parse(await readFile(path.join(bundlePath, MARKER_FILE), 'utf8')) as {
      format?: string
      bundleKey?: string
    }
    if (marker.format === BUNDLE_FORMAT && marker.bundleKey === bundleKey) return
  } catch {
    // Fall through to the guarded refusal below.
  }

  throw new Error(
    `Refusing to replace an existing folder that is not this course's generated migration bundle: ${bundlePath}`
  )
}

function assertDirectChild(parentPath: string, childPath: string): void {
  const relative = path.relative(parentPath, childPath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe bundle output path: ${childPath}`)
  }
  if (relative.includes(path.sep)) {
    throw new Error(`Bundle output must be a direct child of its destination root: ${childPath}`)
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((candidate) => {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isExternalReference(value: string): boolean {
  if (!value) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return false
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
}

function stripQueryAndFragment(value: string): string {
  const query = value.indexOf('?')
  const fragment = value.indexOf('#')
  const end = [query, fragment].filter((position) => position >= 0).sort((a, b) => a - b)[0]
  return end === undefined ? value : value.slice(0, end)
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fromPortablePath(value: string): string {
  return value.replace(/[\\/]+/g, path.sep)
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function isWindowsReservedName(value: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
}

function countBy<T>(items: T[], selector: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = selector(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function csvCell(value: string): string {
  const neutralized = /^\s*[=+\-@]/.test(value) ? `'${value}` : value
  return `"${neutralized.replace(/"/g, '""')}"`
}

function markdownHeading(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim())
}

function markdownCell(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]+/g, ' ').trim()).replace(/\|/g, '\\|')
}

function inlineCode(value: string): string {
  return value.replace(/`/g, '\u02cb').replace(/[\r\n]+/g, ' ')
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#!])/g, '\\$1')
}

function shortText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact
}

function formatGeometry(geometry: SlideObject['geometry']): string {
  return [
    geometry.left === undefined ? undefined : `x=${geometry.left}`,
    geometry.top === undefined ? undefined : `y=${geometry.top}`,
    geometry.width === undefined ? undefined : `w=${geometry.width}`,
    geometry.height === undefined ? undefined : `h=${geometry.height}`
  ]
    .filter((value): value is string => Boolean(value))
    .join(', ')
}
