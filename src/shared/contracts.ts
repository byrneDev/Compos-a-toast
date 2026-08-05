export const IPC_CHANNELS = {
  selectCourse: 'course:select',
  selectOutput: 'output:select',
  analyzeCourse: 'course:analyze',
  exportCourse: 'course:export',
  environment: 'app:environment'
} as const

export type ExportTarget = 'migration-bundle' | 'scorm12' | 'captivate'

export type CaptivateProduct = 'classic' | 'modern' | 'unknown'

export interface CaptivateDetectionDto {
  detected: boolean
  path?: string
  product?: CaptivateProduct
  version?: string
  productName?: string
  signatureVerified: boolean
  versionSupported: boolean
  adapterEligible: boolean
  reason?: string
}

export interface DiagnosticDto {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  source?: string
}
export interface CourseSummaryDto {
  sourcePath: string
  title: string
  version: string
  dimensions: { width: number; height: number }
  slideCount: number
  questionCount: number
  interactionCount: number
  assetCount: number
  flashAssetCount: number
  diagnostics: DiagnosticDto[]
}

export interface EnvironmentDto {
  appVersion: string
  platform: string
  captivate: CaptivateDetectionDto
}

export interface ExportRequestDto {
  sourcePath: string
  outputPath: string
  targets: ExportTarget[]
}

export interface ExportArtifactDto {
  target: ExportTarget
  path?: string
  status: 'created' | 'skipped' | 'failed'
  message: string
}

export interface ExportResultDto {
  artifacts: ExportArtifactDto[]
  diagnostics: DiagnosticDto[]
}

export interface DesktopApi {
  selectCourse(): Promise<string | null>
  selectOutput(): Promise<string | null>
  analyzeCourse(sourcePath: string): Promise<CourseSummaryDto>
  exportCourse(request: ExportRequestDto): Promise<ExportResultDto>
  getEnvironment(): Promise<EnvironmentDto>
}
