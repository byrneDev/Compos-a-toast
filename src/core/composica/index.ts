import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { XMLParser } from 'fast-xml-parser'
import { parseDocument } from 'htmlparser2'

import type { DiagnosticDto } from '../../shared/contracts'
import {
  COURSE_MODEL_VERSION,
  type AssetKind,
  type AssetModel,
  type AssetReference,
  type CourseModel,
  type CourseSettings,
  type Interaction,
  type InteractionFeedback,
  type InteractionOption,
  type InteractionType,
  type OutlineNode,
  type OutlineNodeType,
  type SlideKind,
  type SlideModel,
  type SlideObject
} from '../model'

const PROJECT_RELATIVE_PARTS = ['Content', 'Projects', 'Res', 'project.xml'] as const
const OUTLINE_TYPES = new Set<OutlineNodeType>(['page', 'chapter', 'test', 'section'])
const INTERACTION_TAGS: Record<string, InteractionType> = {
  multichoice: 'multiple-choice',
  multiplechoice: 'multiple-choice',
  fillblank: 'fill-blank',
  dragdrop: 'drag-drop',
  hotspots: 'hotspot',
  game: 'game'
}

interface LegacyNode {
  type: string
  name?: string
  attribs?: Record<string, string>
  children?: LegacyNode[]
  parent?: LegacyNode | null
  data?: string
  startIndex?: number | null
  endIndex?: number | null
}

interface OrderedXmlNode {
  ':@'?: Record<string, unknown>
  '#text'?: string
  [name: string]: unknown
}

interface ParsedOutlineSource {
  name: string
  attributes: Record<string, string>
  children: ParsedOutlineSource[]
}

export interface ComposicaProjectLocation {
  sourcePath: string
  courseRoot: string
  contentRoot: string
  projectRoot: string
  projectFile: string
}

export interface LegacyTextResult {
  text: string
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'
  usedFallback: boolean
}

export interface ParsedPageReference {
  id: string
  title: string
  attributes: Record<string, string>
  outlinePath: string[]
  contexts: Array<{
    type: OutlineNodeType
    id: string
    title: string
    attributes: Record<string, string>
  }>
}

export interface ParsedComposicaProject {
  attributes: Record<string, string>
  outline: OutlineNode[]
  pages: ParsedPageReference[]
  diagnostics: DiagnosticDto[]
}

interface AssetIndex {
  byAbsolutePath: Map<string, AssetModel>
  byRelativePath: Map<string, AssetModel>
  contentRoot: string
  courseRoot: string
}

interface FragmentParseContext {
  slideId: string
  sourcePath: string
  projectRoot: string
  assetIndex: AssetIndex
}

interface ParsedFragment {
  document: LegacyNode
  objects: SlideObject[]
  interactions: Interaction[]
  assetRefs: AssetReference[]
  diagnostics: DiagnosticDto[]
}

interface GameContext {
  id: string
  prompt: string
  attributes: Record<string, string>
  assetRefs: AssetReference[]
}

export class ComposicaProjectNotFoundError extends Error {
  readonly code = 'COMPOSICA_PROJECT_NOT_FOUND'

  constructor(sourcePath: string) {
    super(
      `Could not locate Content/Projects/Res/project.xml from ${sourcePath}. ` +
        'Choose a Composica course folder, Content folder, Projects folder, Res folder, or project.xml file.'
    )
    this.name = 'ComposicaProjectNotFoundError'
  }
}

function pathKey(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').toLocaleLowerCase('en-US')
}

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function stringAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, attribute]) => [
      name,
      attribute == null ? '' : String(attribute)
    ])
  )
}

function attributeValue(attributes: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLocaleLowerCase('en-US')
  const match = Object.entries(attributes).find(
    ([candidate]) => candidate.toLocaleLowerCase('en-US') === wanted
  )
  return match?.[1]
}

function localName(tagName: string): string {
  const separator = tagName.lastIndexOf(':')
  return (separator >= 0 ? tagName.slice(separator + 1) : tagName).toLocaleLowerCase('en-US')
}

function isElement(node: LegacyNode): boolean {
  return typeof node.name === 'string' && !!node.attribs
}

function elementChildren(node: LegacyNode): LegacyNode[] {
  return (node.children ?? []).filter(isElement)
}

function descendants(node: LegacyNode, includeSelf = false): LegacyNode[] {
  const result: LegacyNode[] = []
  const visit = (candidate: LegacyNode): void => {
    if (isElement(candidate)) result.push(candidate)
    for (const child of candidate.children ?? []) visit(child)
  }

  if (includeSelf) visit(node)
  else for (const child of node.children ?? []) visit(child)
  return result
}

function firstDescendant(node: LegacyNode, wantedLocalName: string): LegacyNode | undefined {
  const wanted = wantedLocalName.toLocaleLowerCase('en-US')
  return descendants(node).find((candidate) => localName(candidate.name ?? '') === wanted)
}

function normalizedText(node: LegacyNode | undefined): string {
  if (!node) return ''

  const parts: string[] = []
  const visit = (candidate: LegacyNode): void => {
    if (candidate.type === 'text' && candidate.data) parts.push(candidate.data)
    if (isElement(candidate) && localName(candidate.name ?? '') === 'br') parts.push('\n')
    for (const child of candidate.children ?? []) visit(child)
  }
  visit(node)

  return parts
    .join('')
    .replaceAll('\u00a0', ' ')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function serializeFallback(node: LegacyNode): string {
  if (node.type === 'text') return node.data ?? ''
  if (!isElement(node)) return (node.children ?? []).map(serializeFallback).join('')

  const attributes = Object.entries(node.attribs ?? {})
    .map(([name, value]) => ` ${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`)
    .join('')
  const children = (node.children ?? []).map(serializeFallback).join('')
  return `<${node.name}${attributes}>${children}</${node.name}>`
}

function sourceHtmlForNode(node: LegacyNode, sourceHtml: string): string {
  if (
    typeof node.startIndex === 'number' &&
    typeof node.endIndex === 'number' &&
    node.startIndex >= 0 &&
    node.endIndex >= node.startIndex
  ) {
    return sourceHtml.slice(node.startIndex, node.endIndex + 1)
  }
  return serializeFallback(node)
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined
  const normalized = value.trim().toLocaleLowerCase('en-US')
  if (['true', 'yes', '1', 'on'].includes(normalized)) return true
  if (['false', 'no', '0', 'off'].includes(normalized)) return false
  return undefined
}

function parsePixelValue(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(?:px|pt)?$/i)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

function safeId(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'item'
}

function stableHash(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

async function childPathCaseInsensitive(parent: string, childName: string): Promise<string | undefined> {
  let entries
  try {
    entries = await fs.readdir(parent, { withFileTypes: true })
  } catch {
    return undefined
  }

  const exact = entries.find((entry) => entry.name === childName)
  const matched =
    exact ??
    entries.find(
      (entry) => entry.name.toLocaleLowerCase('en-US') === childName.toLocaleLowerCase('en-US')
    )
  return matched ? path.join(parent, matched.name) : undefined
}

async function resolvePartsCaseInsensitive(
  initialPath: string,
  parts: readonly string[]
): Promise<string | undefined> {
  let current = initialPath
  for (const part of parts) {
    const next = await childPathCaseInsensitive(current, part)
    if (!next) return undefined
    current = next
  }
  return current
}

function deriveContentRoot(projectRoot: string): string {
  let current = projectRoot
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.basename(current).toLocaleLowerCase('en-US') === 'content') return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  const projectsParent = path.dirname(projectRoot)
  if (path.basename(projectsParent).toLocaleLowerCase('en-US') === 'projects') {
    return path.dirname(projectsParent)
  }
  return projectRoot
}

/** Locate a published Composica project without executing any of its runtime files. */
export async function locateComposicaProject(sourceRoot: string): Promise<ComposicaProjectLocation> {
  const sourcePath = path.resolve(sourceRoot)
  let sourceStats
  try {
    sourceStats = await fs.stat(sourcePath)
  } catch {
    throw new ComposicaProjectNotFoundError(sourcePath)
  }

  let projectFile: string | undefined
  if (sourceStats.isFile()) {
    if (path.basename(sourcePath).toLocaleLowerCase('en-US') === 'project.xml') {
      projectFile = sourcePath
    }
  } else if (sourceStats.isDirectory()) {
    const candidateParts: readonly (readonly string[])[] = [
      ['project.xml'],
      ['Res', 'project.xml'],
      ['Projects', 'Res', 'project.xml'],
      PROJECT_RELATIVE_PARTS
    ]
    for (const parts of candidateParts) {
      const candidate = await resolvePartsCaseInsensitive(sourcePath, parts)
      if (!candidate) continue
      const candidateStats = await fs.stat(candidate).catch(() => undefined)
      if (candidateStats?.isFile()) {
        projectFile = candidate
        break
      }
    }
  }

  if (!projectFile) throw new ComposicaProjectNotFoundError(sourcePath)

  const projectRoot = path.dirname(projectFile)
  const contentRoot = deriveContentRoot(projectRoot)
  const courseRoot =
    path.basename(contentRoot).toLocaleLowerCase('en-US') === 'content'
      ? path.dirname(contentRoot)
      : sourceStats.isDirectory()
        ? sourcePath
        : projectRoot

  return { sourcePath, courseRoot, contentRoot, projectRoot, projectFile }
}

function decodeUtf16Be(buffer: Buffer): string {
  const copy = Buffer.from(buffer)
  for (let index = 0; index + 1 < copy.length; index += 2) {
    const first = copy[index]
    copy[index] = copy[index + 1]
    copy[index + 1] = first
  }
  return copy.toString('utf16le')
}

/** Decode legacy source using its BOM/declaration, with a safe Windows-1252 fallback. */
export function decodeLegacyBuffer(buffer: Buffer): LegacyTextResult {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8', usedFallback: false }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le', usedFallback: false }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeUtf16Be(buffer.subarray(2)), encoding: 'utf-16be', usedFallback: false }
  }

  const declaration = buffer
    .subarray(0, Math.min(buffer.length, 512))
    .toString('latin1')
    .match(/encoding\s*=\s*["']?\s*([^\s"'?>]+)/i)?.[1]
    ?.toLocaleLowerCase('en-US')
  const declaredLegacy = !!declaration && /(?:windows-?1252|cp-?1252|iso-8859-1|latin-?1)/i.test(declaration)
  const declaredUtf8 = !!declaration && /utf-?8/i.test(declaration)

  if (!declaredLegacy) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      return { text, encoding: 'utf-8', usedFallback: false }
    } catch {
      // Continue to the legacy decoder below.
    }
  }

  const text = new TextDecoder('windows-1252').decode(buffer)
  return {
    text,
    encoding: 'windows-1252',
    usedFallback: declaredLegacy || declaredUtf8 || !declaration
  }
}

export async function readLegacyText(filePath: string): Promise<LegacyTextResult> {
  return decodeLegacyBuffer(await fs.readFile(filePath))
}

/** Parse a style attribute while respecting quoted strings and url(...) parentheses. */
export function parseInlineStyle(styleText: string | undefined): Record<string, string> {
  if (!styleText) return {}

  const declarations: string[] = []
  let start = 0
  let quote = ''
  let parenthesisDepth = 0
  for (let index = 0; index < styleText.length; index += 1) {
    const character = styleText[index]
    if (quote) {
      if (character === quote && styleText[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') parenthesisDepth += 1
    else if (character === ')' && parenthesisDepth > 0) parenthesisDepth -= 1
    else if (character === ';' && parenthesisDepth === 0) {
      declarations.push(styleText.slice(start, index))
      start = index + 1
    }
  }
  declarations.push(styleText.slice(start))

  const result: Record<string, string> = {}
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLocaleLowerCase('en-US')
    const value = declaration.slice(colon + 1).trim()
    if (property) result[property] = value
  }
  return result
}

function orderedElement(node: OrderedXmlNode): { name: string; children: OrderedXmlNode[] } | undefined {
  for (const [name, value] of Object.entries(node)) {
    if (name === ':@' || name === '#text') continue
    if (Array.isArray(value)) return { name, children: value as OrderedXmlNode[] }
  }
  return undefined
}

function outlineSourcesFromOrdered(nodes: OrderedXmlNode[]): ParsedOutlineSource[] {
  const result: ParsedOutlineSource[] = []
  for (const node of nodes) {
    const element = orderedElement(node)
    if (!element) continue
    const normalizedName = element.name.toLocaleLowerCase('en-US')
    if (OUTLINE_TYPES.has(normalizedName as OutlineNodeType)) {
      result.push({
        name: normalizedName,
        attributes: stringAttributes(node[':@']),
        children: outlineSourcesFromOrdered(element.children)
      })
    } else {
      result.push(...outlineSourcesFromOrdered(element.children))
    }
  }
  return result
}

function fallbackProjectParse(xml: string): {
  attributes: Record<string, string>
  sources: ParsedOutlineSource[]
} | null {
  const document = parseDocument(xml, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: false,
    recognizeSelfClosing: true
  }) as unknown as LegacyNode
  const project = descendants(document).find((node) => localName(node.name ?? '') === 'project')
  if (!project) return null
  const structure = elementChildren(project).find((node) => localName(node.name ?? '') === 'structure')
  if (!structure) return { attributes: { ...(project.attribs ?? {}) }, sources: [] }

  const convert = (nodes: LegacyNode[]): ParsedOutlineSource[] =>
    nodes.flatMap((node) => {
      const name = localName(node.name ?? '')
      if (OUTLINE_TYPES.has(name as OutlineNodeType)) {
        return [
          {
            name,
            attributes: { ...(node.attribs ?? {}) },
            children: convert(elementChildren(node))
          }
        ]
      }
      return convert(elementChildren(node))
    })

  return { attributes: { ...(project.attribs ?? {}) }, sources: convert(elementChildren(structure)) }
}

function buildOutline(sources: ParsedOutlineSource[]): {
  outline: OutlineNode[]
  pages: ParsedPageReference[]
} {
  const pages: ParsedPageReference[] = []
  const generatedCounts: Record<OutlineNodeType, number> = {
    page: 0,
    chapter: 0,
    test: 0,
    section: 0
  }

  const visit = (
    items: ParsedOutlineSource[],
    outlinePath: string[],
    contexts: ParsedPageReference['contexts']
  ): OutlineNode[] =>
    items.map((item) => {
      const type = item.name as OutlineNodeType
      generatedCounts[type] += 1
      const sourceId = attributeValue(item.attributes, 'id') ?? ''
      const title =
        attributeValue(item.attributes, 'title') ??
        (sourceId ||
          `${type[0].toLocaleUpperCase('en-US')}${type.slice(1)} ${generatedCounts[type]}`)
      const id = sourceId || `${type}-${generatedCounts[type]}`
      const nextPath = [...outlinePath, title]
      const context = { type, id, title, attributes: { ...item.attributes } }
      const nextContexts = [...contexts, context]
      const node: OutlineNode = {
        type,
        id,
        title,
        attributes: { ...item.attributes },
        children: visit(item.children, nextPath, nextContexts)
      }
      if (type === 'page') {
        pages.push({
          id: sourceId,
          title,
          attributes: { ...item.attributes },
          outlinePath: nextPath,
          contexts: nextContexts
        })
      }
      return node
    })

  return { outline: visit(sources, [], []), pages }
}

/** Parse project.xml into its settings attributes, ordered outline, and ordered page occurrences. */
export function parseProjectXml(sourceXml: string): ParsedComposicaProject {
  const diagnostics: DiagnosticDto[] = []
  const sanitizedXml = sourceXml.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  if (sanitizedXml !== sourceXml) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROJECT_XML_CONTROL_CHARACTERS_REMOVED',
      message: 'Removed invalid control characters before parsing project.xml.'
    })
  }

  let attributes: Record<string, string> = {}
  let sources: ParsedOutlineSource[] = []
  let primarySucceeded = false
  try {
    const ordered = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseAttributeValue: false,
      trimValues: false,
      processEntities: true
    }).parse(sanitizedXml) as OrderedXmlNode[]
    const projectNode = ordered.find(
      (node) => orderedElement(node)?.name.toLocaleLowerCase('en-US') === 'project'
    )
    const projectElement = projectNode ? orderedElement(projectNode) : undefined
    if (projectNode && projectElement) {
      attributes = stringAttributes(projectNode[':@'])
      const structureNode = projectElement.children.find(
        (node) => orderedElement(node)?.name.toLocaleLowerCase('en-US') === 'structure'
      )
      const structureElement = structureNode ? orderedElement(structureNode) : undefined
      if (structureElement) sources = outlineSourcesFromOrdered(structureElement.children)
      primarySucceeded = true
    }
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROJECT_XML_STRICT_PARSE_FAILED',
      message: `Strict XML parsing failed; attempting tolerant legacy parsing: ${error instanceof Error ? error.message : String(error)}`
    })
  }

  if (!primarySucceeded) {
    const fallback = fallbackProjectParse(sanitizedXml)
    if (fallback) {
      attributes = fallback.attributes
      sources = fallback.sources
      diagnostics.push({
        severity: 'warning',
        code: 'PROJECT_XML_TOLERANT_PARSE_USED',
        message: 'Parsed project.xml with the tolerant legacy parser.'
      })
    } else {
      diagnostics.push({
        severity: 'error',
        code: 'PROJECT_XML_INVALID',
        message: 'project.xml does not contain a readable project element.'
      })
    }
  }

  if (sources.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'PROJECT_STRUCTURE_EMPTY',
      message: 'project.xml did not contain any recognized page, chapter, test, or section nodes.'
    })
  }
  const { outline, pages } = buildOutline(sources)
  return { attributes, outline, pages, diagnostics }
}

export function classifyAsset(source: string): AssetKind {
  const cleanSource = source.split(/[?#]/, 1)[0].toLocaleLowerCase('en-US')
  const extension = path.extname(cleanSource)
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

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base', numeric: true })
    )
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile()) files.push(entryPath)
      // Symbolic links are intentionally not followed.
    }
  }
  await walk(root)
  return files
}

async function inventoryAssets(
  contentRoot: string,
  courseRoot: string,
  diagnostics: DiagnosticDto[]
): Promise<{ assets: AssetModel[]; index: AssetIndex }> {
  const files = await collectFiles(contentRoot)
  const assets: AssetModel[] = []
  for (const filePath of files) {
    const relativePath = toPosixPath(path.relative(contentRoot, filePath))
    try {
      const bytes = await fs.readFile(filePath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      assets.push({
        id: `asset-${sha256.slice(0, 12)}-${stableHash(relativePath.toLocaleLowerCase('en-US'), 8)}`,
        source: relativePath,
        resolvedPath: filePath,
        relativePath,
        kind: classifyAsset(relativePath),
        exists: true,
        size: bytes.byteLength,
        sha256,
        usedBySlides: []
      })
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'ASSET_READ_FAILED',
        message: `Could not inventory ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        source: filePath
      })
    }
  }

  assets.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en-US', { sensitivity: 'base', numeric: true })
  )
  const byAbsolutePath = new Map<string, AssetModel>()
  const byRelativePath = new Map<string, AssetModel>()
  for (const asset of assets) {
    if (asset.resolvedPath) byAbsolutePath.set(pathKey(asset.resolvedPath), asset)
    byRelativePath.set(asset.relativePath.toLocaleLowerCase('en-US'), asset)
  }
  return {
    assets,
    index: { byAbsolutePath, byRelativePath, contentRoot, courseRoot }
  }
}

function isExternalReference(source: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source.trim())
}

function referencePath(source: string): string {
  const withoutSuffix = source.split(/[?#]/, 1)[0].trim().replace(/^['"]|['"]$/g, '')
  try {
    return decodeURIComponent(withoutSuffix).replaceAll('\\', '/')
  } catch {
    return withoutSuffix.replaceAll('\\', '/')
  }
}

function containedBy(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveAssetReference(
  rawSource: string,
  sourcePath: string,
  projectRoot: string,
  assetIndex: AssetIndex
): AssetReference {
  const source = rawSource.trim()
  const kind = classifyAsset(source)
  if (!source || isExternalReference(source) || /^data:/i.test(source)) {
    return { source, kind, exists: false }
  }

  const clean = referencePath(source).replace(/^\/+/, '')
  if (/^[a-z]:/i.test(clean)) return { source, kind, exists: false }

  const candidates = [
    path.resolve(path.dirname(sourcePath), clean),
    path.resolve(projectRoot, clean),
    path.resolve(assetIndex.contentRoot, clean),
    path.resolve(assetIndex.courseRoot, clean)
  ]
  const projectsIndex = clean.toLocaleLowerCase('en-US').indexOf('projects/')
  if (projectsIndex >= 0) {
    candidates.unshift(path.resolve(assetIndex.contentRoot, clean.slice(projectsIndex)))
  }
  const contentIndex = clean.toLocaleLowerCase('en-US').indexOf('content/')
  if (contentIndex >= 0) {
    candidates.unshift(path.resolve(assetIndex.courseRoot, clean.slice(contentIndex)))
  }

  for (const candidate of candidates) {
    if (!containedBy(candidate, assetIndex.courseRoot)) continue
    const asset = assetIndex.byAbsolutePath.get(pathKey(candidate))
    if (asset?.resolvedPath) {
      return { source, resolvedPath: asset.resolvedPath, kind: asset.kind, exists: true }
    }
  }

  const normalizedRelative = clean.toLocaleLowerCase('en-US')
  const relativeAsset = assetIndex.byRelativePath.get(normalizedRelative)
  if (relativeAsset?.resolvedPath) {
    return {
      source,
      resolvedPath: relativeAsset.resolvedPath,
      kind: relativeAsset.kind,
      exists: true
    }
  }
  return { source, kind, exists: false }
}

function assetSourcesForElement(node: LegacyNode): string[] {
  const attributes = node.attribs ?? {}
  const sources: string[] = []
  const name = localName(node.name ?? '')
  for (const [attributeName, value] of Object.entries(attributes)) {
    const normalizedName = attributeName.toLocaleLowerCase('en-US')
    if (['src', 'data', 'poster', 'background'].includes(normalizedName)) sources.push(value)
    else if (normalizedName === 'href' && path.extname(referencePath(value))) sources.push(value)
    else if (
      normalizedName === 'value' &&
      name === 'param' &&
      ['movie', 'src', 'url', 'sound'].includes((attributeValue(attributes, 'name') ?? '').toLocaleLowerCase('en-US'))
    ) {
      sources.push(value)
    }
  }

  const style = attributeValue(attributes, 'style') ?? ''
  for (const match of style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (match[2]) sources.push(match[2])
  }
  return [...new Set(sources.map((source) => source.trim()).filter(Boolean))]
}

function objectRole(node: LegacyNode): SlideObject['role'] {
  const name = localName(node.name ?? '')
  if (name === 'img' || name === 'image') return 'image'
  if (['audio', 'video', 'embed', 'object'].includes(name)) return 'media'
  if (['button', 'input', 'navbutton'].includes(name)) return 'button'
  if (name === 'flashape') return 'shape'
  if (
    ['multichoice', 'fillblank', 'dragdrop', 'hotspots', 'hotspot', 'dragitem', 'droparea'].includes(name) ||
    (node.name ?? '').toLocaleLowerCase('en-US').startsWith('gmgame:')
  ) {
    return 'interaction'
  }
  if (['div', 'section', 'table', 'tbody', 'tr', 'td', 'contentarea'].includes(name)) return 'container'
  if (
    ['p', 'span', 'strong', 'em', 'a', 'label', 'box', 'mcquestion', 'mcanswer', 'blankquestion'].includes(name) ||
    /^h[1-6]$/.test(name)
  ) {
    return normalizedText(node) ? 'text' : 'shape'
  }
  return normalizedText(node) ? 'text' : 'unknown'
}

function feedbackFor(node: LegacyNode): InteractionFeedback {
  const feedback: InteractionFeedback = { custom: [] }
  for (const candidate of descendants(node)) {
    const name = localName(candidate.name ?? '')
    const text = normalizedText(candidate)
    if (!text) continue
    if (name === 'fbright' && feedback.correct == null) feedback.correct = text
    else if (name === 'fbwrong' && feedback.incorrect == null) feedback.incorrect = text
    else if (name === 'fbpartial' && feedback.partial == null) feedback.partial = text
    else if (name === 'fbretry' && feedback.retry == null) feedback.retry = text
    else if (['fbcustom', 'fbrange', 'fbfinal'].includes(name)) {
      const attributes = { ...(candidate.attribs ?? {}) }
      feedback.custom.push({
        condition:
          attributeValue(attributes, 'when') ??
          ([attributeValue(attributes, 'low'), attributeValue(attributes, 'high')]
            .filter((value) => value != null)
            .join('..') || undefined),
        text,
        attributes
      })
    }
  }
  return feedback
}

function interactionOptions(
  node: LegacyNode,
  type: InteractionType,
  sourceHtml: string
): { options: InteractionOption[]; answers: string[] } {
  let optionTag = ''
  if (type === 'multiple-choice') optionTag = 'mcanswer'
  else if (type === 'fill-blank') optionTag = 'blankoption'
  else if (type === 'drag-drop') optionTag = 'dragitem'
  else if (type === 'hotspot') optionTag = 'hotspot'
  if (!optionTag) return { options: [], answers: [] }

  const candidates = descendants(node).filter(
    (candidate) => localName(candidate.name ?? '') === optionTag
  )
  const options: InteractionOption[] = candidates.map((candidate, index) => {
    const attributes = { ...(candidate.attribs ?? {}) }
    const sourceIndex =
      attributeValue(attributes, 'mcindex') ??
      attributeValue(attributes, 'ddindex') ??
      attributeValue(attributes, 'hotindex') ??
      String(index + 1)
    return {
      id: `${optionTag}-${sourceIndex}-${index + 1}`,
      text: normalizedText(candidate),
      html: sourceHtmlForNode(candidate, sourceHtml),
      correct: parseBoolean(attributeValue(attributes, 'correct')),
      attributes
    }
  })

  let answers: string[]
  if (type === 'fill-blank') {
    answers = options.filter((option) => option.correct).map((option) => option.text).filter(Boolean)
  } else if (type === 'drag-drop') {
    answers = options.map((option) => {
      const dropIndex = attributeValue(option.attributes, 'ddindex') ?? 'unknown'
      return `${option.id}->drop-${dropIndex}`
    })
  } else {
    answers = options.filter((option) => option.correct).map((option) => option.id)
  }
  return { options, answers }
}

function interactionPrompt(node: LegacyNode, type: InteractionType): string {
  if (type === 'multiple-choice') return normalizedText(firstDescendant(node, 'mcquestion'))
  if (type === 'fill-blank') return normalizedText(firstDescendant(node, 'blankquestion'))
  if (type === 'drag-drop') {
    const explicitPrompt = descendants(node).find((candidate) => {
      const name = localName(candidate.name ?? '')
      return ['question', 'prompt', 'instruction'].includes(name)
    })
    return normalizedText(explicitPrompt) || normalizedText(node).slice(0, 500)
  }
  return normalizedText(node).slice(0, 500)
}

function dedupeAssetReferences(references: AssetReference[]): AssetReference[] {
  const seen = new Set<string>()
  return references.filter((reference) => {
    const key = reference.resolvedPath
      ? `path:${pathKey(reference.resolvedPath)}`
      : `source:${reference.source.toLocaleLowerCase('en-US')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseFragment(sourceHtml: string, context: FragmentParseContext): ParsedFragment {
  const document = parseDocument(sourceHtml, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
    withStartIndices: true,
    withEndIndices: true
  }) as unknown as LegacyNode
  const nodes = descendants(document)
  const diagnostics: DiagnosticDto[] = []
  const nodeObjectIds = new Map<LegacyNode, string>()
  const usedObjectIds = new Set<string>()
  const objects: SlideObject[] = []

  for (const [index, node] of nodes.entries()) {
    const attributes = { ...(node.attribs ?? {}) }
    const style = parseInlineStyle(attributeValue(attributes, 'style'))
    const requestedId = attributeValue(attributes, 'id')
      ? `${context.slideId}-${safeId(attributeValue(attributes, 'id') ?? '')}`
      : `${context.slideId}-object-${String(index + 1).padStart(4, '0')}`
    let objectId = requestedId
    let collision = 2
    while (usedObjectIds.has(objectId)) {
      objectId = `${requestedId}-${collision}`
      collision += 1
    }
    usedObjectIds.add(objectId)
    nodeObjectIds.set(node, objectId)

    const assetRefs = assetSourcesForElement(node).map((source) =>
      resolveAssetReference(
        source,
        context.sourcePath,
        context.projectRoot,
        context.assetIndex
      )
    )
    objects.push({
      id: objectId,
      sourceTag: node.name ?? 'unknown',
      role: objectRole(node),
      text: normalizedText(node),
      html: sourceHtmlForNode(node, sourceHtml),
      attributes,
      style,
      geometry: {
        left: parsePixelValue(style.left),
        top: parsePixelValue(style.top),
        right: parsePixelValue(style.right),
        bottom: parsePixelValue(style.bottom),
        width: parsePixelValue(style.width) ?? parsePixelValue(attributeValue(attributes, 'width')),
        height: parsePixelValue(style.height) ?? parsePixelValue(attributeValue(attributes, 'height'))
      },
      zIndex: parsePixelValue(style['z-index']),
      assetRefs
    })
  }

  const firstGameRoot = nodes.find((node) =>
    (node.name ?? '').toLocaleLowerCase('en-US').startsWith('gmgame:')
  )
  const interactionNodes = nodes.filter((node) => {
    const fullName = (node.name ?? '').toLocaleLowerCase('en-US')
    const name = localName(fullName)
    if (INTERACTION_TAGS[name]) return true
    // htmlparser2 may recover unknown legacy namespace elements as siblings, so
    // parentage alone cannot identify the wrapper. Published game fragments use
    // the first gmgame:* element as their single game root.
    if (fullName.startsWith('gmgame:')) return node === firstGameRoot
    return false
  })
  const interactions: Interaction[] = interactionNodes.map((node, index) => {
    const fullName = (node.name ?? '').toLocaleLowerCase('en-US')
    const type = fullName.startsWith('gmgame:')
      ? 'game'
      : (INTERACTION_TAGS[localName(fullName)] ?? 'unknown')
    const attributes = { ...(node.attribs ?? {}) }
    const { options, answers } = interactionOptions(node, type, sourceHtml)
    return {
      id: `${context.slideId}-interaction-${String(index + 1).padStart(3, '0')}`,
      objectId: nodeObjectIds.get(node) ?? context.slideId,
      type,
      prompt: interactionPrompt(node, type),
      options,
      answers,
      feedback: feedbackFor(node),
      attributes
    }
  })

  const assetRefs = dedupeAssetReferences(objects.flatMap((object) => object.assetRefs))
  for (const reference of assetRefs) {
    if (!reference.exists && !isExternalReference(reference.source) && !/^data:/i.test(reference.source)) {
      diagnostics.push({
        severity: 'warning',
        code: 'ASSET_REFERENCE_MISSING',
        message: `Referenced asset was not found: ${reference.source}`,
        source: context.sourcePath
      })
    }
  }
  return { document, objects, interactions, assetRefs, diagnostics }
}

function projectFragmentPath(
  projectRoot: string,
  fragmentId: string,
  assetIndex: AssetIndex
): string | undefined {
  if (!fragmentId || /^[a-z]:/i.test(fragmentId) || fragmentId.startsWith('/') || fragmentId.startsWith('\\')) {
    return undefined
  }
  const clean = referencePath(fragmentId)
  const candidate = path.resolve(projectRoot, clean)
  if (!containedBy(candidate, projectRoot)) return undefined
  return assetIndex.byAbsolutePath.get(pathKey(candidate))?.resolvedPath ?? candidate
}

async function loadGameContexts(
  page: ParsedPageReference,
  projectRoot: string,
  assetIndex: AssetIndex,
  cache: Map<string, GameContext[]>,
  diagnostics: DiagnosticDto[]
): Promise<GameContext[]> {
  const results: GameContext[] = []
  for (const context of page.contexts.filter((item) => item.type === 'test')) {
    const fragmentPath = projectFragmentPath(projectRoot, context.id, assetIndex)
    if (!fragmentPath) continue
    const cacheKey = pathKey(fragmentPath)
    let cached = cache.get(cacheKey)
    if (!cached) {
      const stats = await fs.stat(fragmentPath).catch(() => undefined)
      if (!stats?.isFile()) {
        diagnostics.push({
          severity: 'warning',
          code: 'CONTEXT_FRAGMENT_MISSING',
          message: `Test context fragment was not found: ${context.id}`,
          source: fragmentPath
        })
        cached = []
      } else {
        try {
          const { text } = await readLegacyText(fragmentPath)
          const document = parseDocument(text, {
            decodeEntities: true,
            lowerCaseTags: true,
            lowerCaseAttributeNames: true,
            recognizeSelfClosing: true,
            withStartIndices: true,
            withEndIndices: true
          }) as unknown as LegacyNode
          const firstGameRoot = descendants(document).find((node) =>
            (node.name ?? '').toLocaleLowerCase('en-US').startsWith('gmgame:')
          )
          const gameRoots = firstGameRoot ? [firstGameRoot] : []
          cached = gameRoots.map((root, index) => ({
            id: `${safeId(context.id)}-game-${index + 1}`,
            prompt: context.title || normalizedText(root).slice(0, 500),
            attributes: {
              ...(root.attribs ?? {}),
              sourceFragment: context.id,
              sourceTag: root.name ?? 'gmgame:unknown'
            },
            assetRefs: dedupeAssetReferences(
              descendants(root, true).flatMap((node) =>
                assetSourcesForElement(node).map((source) =>
                  resolveAssetReference(source, fragmentPath, projectRoot, assetIndex)
                )
              )
            )
          }))
        } catch (error) {
          diagnostics.push({
            severity: 'warning',
            code: 'CONTEXT_FRAGMENT_READ_FAILED',
            message: `Could not inspect test context ${context.id}: ${error instanceof Error ? error.message : String(error)}`,
            source: fragmentPath
          })
          cached = []
        }
      }
      cache.set(cacheKey, cached)
    }
    results.push(...cached)
  }
  return results
}

function inheritedMaster(page: ParsedPageReference, settings: CourseSettings): string | undefined {
  for (let index = page.contexts.length - 1; index >= 0; index -= 1) {
    const master = attributeValue(page.contexts[index].attributes, 'master')
    if (master) return master
  }
  return settings.masterId
}

function courseSettings(
  attributes: Record<string, string>,
  projectRoot: string,
  diagnostics: DiagnosticDto[]
): CourseSettings {
  const width = Number(attributeValue(attributes, 'windowWidth'))
  const height = Number(attributeValue(attributes, 'windowHeight'))
  if (!(width > 0) || !(height > 0)) {
    diagnostics.push({
      severity: 'warning',
      code: 'COURSE_DIMENSIONS_DEFAULTED',
      message: 'Course dimensions were missing or invalid; using 800 by 600 pixels.'
    })
  }
  return {
    id: attributeValue(attributes, 'id') || path.basename(projectRoot),
    publicId: attributeValue(attributes, 'publicId'),
    title: attributeValue(attributes, 'title') || path.basename(projectRoot),
    description: attributeValue(attributes, 'description') || '',
    version: attributeValue(attributes, 'version') || 'unknown',
    width: width > 0 ? width : 800,
    height: height > 0 ? height : 600,
    backgroundColor: attributeValue(attributes, 'windowBackColor'),
    theme: attributeValue(attributes, 'theme'),
    masterId: attributeValue(attributes, 'master'),
    courseMode: attributeValue(attributes, 'courseMode'),
    persist: parseBoolean(attributeValue(attributes, 'persist')) ?? false,
    attributes: { ...attributes }
  }
}

function slideKind(interactions: Interaction[], hasSource: boolean): SlideKind {
  if (!hasSource) return 'unknown'
  if (interactions.some((interaction) => interaction.type === 'game')) return 'game'
  if (
    interactions.some((interaction) =>
      ['multiple-choice', 'fill-blank', 'drag-drop'].includes(interaction.type)
    )
  ) {
    return 'question'
  }
  return 'content'
}

function markAssetsUsed(
  references: AssetReference[],
  slideId: string,
  assetIndex: AssetIndex
): void {
  for (const reference of references) {
    if (!reference.resolvedPath) continue
    const asset = assetIndex.byAbsolutePath.get(pathKey(reference.resolvedPath))
    if (asset && !asset.usedBySlides.includes(slideId)) asset.usedBySlides.push(slideId)
  }
}

/** Analyze a published Composica course as data. No legacy runtime content is executed. */
export async function analyzeComposicaCourse(sourceRoot: string): Promise<CourseModel> {
  const location = await locateComposicaProject(sourceRoot)
  const diagnostics: DiagnosticDto[] = []
  const projectText = await readLegacyText(location.projectFile)
  if (projectText.encoding === 'windows-1252') {
    diagnostics.push({
      severity: 'info',
      code: 'LEGACY_TEXT_ENCODING',
      message: 'Decoded project.xml as Windows-1252.',
      source: location.projectFile
    })
  }

  const parsedProject = parseProjectXml(projectText.text)
  for (const diagnostic of parsedProject.diagnostics) {
    diagnostics.push({ ...diagnostic, source: diagnostic.source ?? location.projectFile })
  }
  const settings = courseSettings(parsedProject.attributes, location.projectRoot, diagnostics)
  const { assets, index: assetIndex } = await inventoryAssets(
    location.contentRoot,
    location.courseRoot,
    diagnostics
  )
  const flashAssets = assets.filter((asset) => asset.kind === 'flash')
  if (flashAssets.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'FLASH_ASSETS_DETECTED',
      message: `Detected ${flashAssets.length} SWF asset${flashAssets.length === 1 ? '' : 's'}. They were inventoried but never executed.`
    })
  }

  const slides: SlideModel[] = []
  const sourceOccurrences = new Map<string, number>()
  const gameCache = new Map<string, GameContext[]>()
  for (const [index, page] of parsedProject.pages.entries()) {
    const sourceRelativePath = toPosixPath(page.id)
    const sourceKey = sourceRelativePath.toLocaleLowerCase('en-US') || `missing-${index + 1}`
    const occurrence = (sourceOccurrences.get(sourceKey) ?? 0) + 1
    sourceOccurrences.set(sourceKey, occurrence)
    const slideId = `slide-${stableHash(sourceKey)}-${occurrence}`
    const slideDiagnostics: DiagnosticDto[] = []
    let sourcePath = projectFragmentPath(location.projectRoot, page.id, assetIndex)
    if (!sourcePath) {
      sourcePath = path.join(location.projectRoot, '__invalid_page_reference__', `${index + 1}.html`)
      slideDiagnostics.push({
        severity: 'error',
        code: 'PAGE_REFERENCE_INVALID',
        message: page.id
          ? `Page reference is outside the project or otherwise unsafe: ${page.id}`
          : 'Page reference is missing its id attribute.',
        source: location.projectFile
      })
    }

    let sourceHtml = ''
    let parsedFragment: ParsedFragment | undefined
    const sourceStats = await fs.stat(sourcePath).catch(() => undefined)
    if (!sourceStats?.isFile()) {
      slideDiagnostics.push({
        severity: 'error',
        code: 'PAGE_FILE_MISSING',
        message: `Page fragment was not found: ${page.id || '(missing id)'}`,
        source: sourcePath
      })
    } else {
      try {
        const legacyText = await readLegacyText(sourcePath)
        sourceHtml = legacyText.text
        if (legacyText.encoding === 'windows-1252') {
          slideDiagnostics.push({
            severity: 'info',
            code: 'LEGACY_TEXT_ENCODING',
            message: 'Decoded page fragment as Windows-1252.',
            source: sourcePath
          })
        }
        parsedFragment = parseFragment(sourceHtml, {
          slideId,
          sourcePath,
          projectRoot: location.projectRoot,
          assetIndex
        })
        slideDiagnostics.push(...parsedFragment.diagnostics)
      } catch (error) {
        slideDiagnostics.push({
          severity: 'error',
          code: 'PAGE_READ_FAILED',
          message: `Could not read page fragment: ${error instanceof Error ? error.message : String(error)}`,
          source: sourcePath
        })
      }
    }

    const gameContexts = await loadGameContexts(
      page,
      location.projectRoot,
      assetIndex,
      gameCache,
      slideDiagnostics
    )
    const gameInteractions: Interaction[] = gameContexts.map((game, gameIndex) => ({
      id: `${slideId}-game-context-${gameIndex + 1}`,
      objectId: slideId,
      type: 'game',
      prompt: game.prompt,
      options: [],
      answers: [],
      feedback: { custom: [] },
      attributes: { ...game.attributes }
    }))
    const assetRefs = dedupeAssetReferences([
      ...(parsedFragment?.assetRefs ?? []),
      ...gameContexts.flatMap((game) => game.assetRefs)
    ])
    const interactions = [...(parsedFragment?.interactions ?? []), ...gameInteractions]
    const slide: SlideModel = {
      index,
      id: slideId,
      title: page.title,
      kind: slideKind(interactions, !!sourceStats?.isFile()),
      outlinePath: [...page.outlinePath],
      sourceRelativePath,
      sourcePath,
      sourceHtml,
      masterId: inheritedMaster(page, settings),
      objects: parsedFragment?.objects ?? [],
      interactions,
      assetRefs,
      diagnostics: slideDiagnostics
    }
    markAssetsUsed(assetRefs, slideId, assetIndex)
    slides.push(slide)
    diagnostics.push(...slideDiagnostics)
  }

  return {
    schemaVersion: COURSE_MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      rootPath: location.courseRoot,
      projectRoot: location.projectRoot,
      projectFile: location.projectFile,
      format: 'composica-published'
    },
    settings,
    outline: parsedProject.outline,
    slides,
    assets,
    diagnostics
  }
}
