import type { DiagnosticDto } from '../shared/contracts'

export const COURSE_MODEL_VERSION = '0.1.0' as const

export type OutlineNodeType = 'page' | 'chapter' | 'test' | 'section'
export type SlideKind = 'content' | 'question' | 'game' | 'unknown'

export interface CourseSettings {
  id: string
  publicId?: string
  title: string
  description: string
  version: string
  width: number
  height: number
  backgroundColor?: string
  theme?: string
  masterId?: string
  courseMode?: string
  persist: boolean
  attributes: Record<string, string>
}

export interface OutlineNode {
  type: OutlineNodeType
  id: string
  title: string
  attributes: Record<string, string>
  children: OutlineNode[]
}

export interface Geometry {
  left?: number
  top?: number
  right?: number
  bottom?: number
  width?: number
  height?: number
}

export type AssetKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'flash'
  | 'font'
  | 'stylesheet'
  | 'other'

export interface AssetReference {
  source: string
  resolvedPath?: string
  kind: AssetKind
  exists: boolean
}

export type ObjectRole =
  | 'text'
  | 'image'
  | 'shape'
  | 'button'
  | 'media'
  | 'interaction'
  | 'container'
  | 'unknown'

export interface SlideObject {
  id: string
  sourceTag: string
  role: ObjectRole
  text: string
  html: string
  attributes: Record<string, string>
  style: Record<string, string>
  geometry: Geometry
  zIndex?: number
  assetRefs: AssetReference[]
}

export type InteractionType =
  | 'multiple-choice'
  | 'fill-blank'
  | 'drag-drop'
  | 'hotspot'
  | 'game'
  | 'unknown'

export interface InteractionOption {
  id: string
  text: string
  html: string
  correct?: boolean
  attributes: Record<string, string>
}

export interface InteractionFeedback {
  correct?: string
  incorrect?: string
  partial?: string
  retry?: string
  custom: Array<{
    condition?: string
    text: string
    attributes: Record<string, string>
  }>
}

export interface Interaction {
  id: string
  objectId: string
  type: InteractionType
  prompt: string
  options: InteractionOption[]
  answers: string[]
  feedback: InteractionFeedback
  attributes: Record<string, string>
}

export interface SlideModel {
  index: number
  id: string
  title: string
  kind: SlideKind
  outlinePath: string[]
  sourceRelativePath: string
  sourcePath: string
  sourceHtml: string
  masterId?: string
  objects: SlideObject[]
  interactions: Interaction[]
  assetRefs: AssetReference[]
  diagnostics: DiagnosticDto[]
}
export interface AssetModel extends AssetReference {
  id: string
  relativePath: string
  size: number
  sha256?: string
  usedBySlides: string[]
}

export interface CourseModel {
  schemaVersion: typeof COURSE_MODEL_VERSION
  generatedAt: string
  source: {
    rootPath: string
    projectRoot: string
    projectFile: string
    format: 'composica-published'
  }
  settings: CourseSettings
  outline: OutlineNode[]
  slides: SlideModel[]
  assets: AssetModel[]
  diagnostics: DiagnosticDto[]
}

export interface ExportedArtifact {
  path: string
  diagnostics: DiagnosticDto[]
}
