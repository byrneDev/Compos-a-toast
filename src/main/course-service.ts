import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { analyzeComposicaCourse } from '../core/composica'
import { exportMigrationBundle } from '../core/bundle'
import { detectCaptivate } from '../core/captivate/detect'
import { exportScorm12 } from '../core/scorm'
import type { CourseModel, ExportedArtifact } from '../core/model'
import type {
  CourseSummaryDto,
  DiagnosticDto,
  ExportArtifactDto,
  ExportRequestDto,
  ExportResultDto
} from '../shared/contracts'

function countQuestions(model: CourseModel): number {
  const questionTypes = new Set(['multiple-choice', 'fill-blank', 'drag-drop'])
  return model.slides.reduce(
    (count, slide) => count + slide.interactions.filter((item) => questionTypes.has(item.type)).length,
    0
  )
}

async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch {
    try {
      return join(await realpath(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate)
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}

export function summarizeCourse(model: CourseModel): CourseSummaryDto {
  return {
    sourcePath: model.source.rootPath,
    title: model.settings.title,
    version: model.settings.version,
    dimensions: {
      width: model.settings.width,
      height: model.settings.height
    },
    slideCount: model.slides.length,
    questionCount: countQuestions(model),
    interactionCount: model.slides.reduce((count, slide) => count + slide.interactions.length, 0),
    assetCount: model.assets.length,
    flashAssetCount: model.assets.filter((asset) => asset.kind === 'flash').length,
    diagnostics: model.diagnostics
  }
}

export async function analyzeCourse(sourcePath: string): Promise<CourseSummaryDto> {
  const model = await analyzeComposicaCourse(sourcePath)
  return summarizeCourse(model)
}

function failedArtifact(target: ExportArtifactDto['target'], error: unknown): ExportArtifactDto {
  return {
    target,
    status: 'failed',
    message: error instanceof Error ? error.message : String(error)
  }
}

function deduplicateDiagnostics(diagnostics: DiagnosticDto[]): DiagnosticDto[] {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.source ?? ''
    ].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function createdArtifact(
  target: ExportArtifactDto['target'],
  result: ExportedArtifact,
  message: string
): ExportArtifactDto {
  return { target, status: 'created', path: result.path, message }
}

export async function exportCourse(request: ExportRequestDto): Promise<ExportResultDto> {
  if (request.targets.length === 0) {
    throw new Error('Choose at least one export target.')
  }
  if (!request.sourcePath.trim()) throw new Error('Choose a source course folder.')
  if (!request.outputPath.trim()) throw new Error('Choose an export destination folder.')

  const model = await analyzeComposicaCourse(request.sourcePath)
  const outputPath = resolve(request.outputPath)
  const courseRoot = await canonicalTarget(model.source.rootPath)
  const canonicalOutput = await canonicalTarget(outputPath)
  const outputIsInsideSource =
    isSameOrInside(courseRoot, canonicalOutput) ||
    isSameOrInside(resolve(model.source.rootPath), outputPath)

  if (outputIsInsideSource) {
    throw new Error('Choose an export destination outside the source course folder.')
  }

  await mkdir(outputPath, { recursive: true })

  const diagnostics: DiagnosticDto[] = [...model.diagnostics]
  const artifacts: ExportArtifactDto[] = []
  let bundleResult: ExportedArtifact | undefined

  if (request.targets.includes('migration-bundle')) {
    try {
      bundleResult = await exportMigrationBundle(model, outputPath)
      diagnostics.push(...bundleResult.diagnostics)
      artifacts.push(
        createdArtifact(
          'migration-bundle',
          bundleResult,
          'Created an editable reconstruction bundle with one folder per slide.'
        )
      )
    } catch (error) {
      artifacts.push(failedArtifact('migration-bundle', error))
    }
  }

  if (request.targets.includes('scorm12')) {
    try {
      const result = await exportScorm12(model, outputPath)
      diagnostics.push(...result.diagnostics)
      artifacts.push(
        createdArtifact('scorm12', result, 'Created an HTML5 single-SCO SCORM 1.2 ZIP package.')
      )
    } catch (error) {
      artifacts.push(failedArtifact('scorm12', error))
    }
  }

  if (request.targets.includes('captivate')) {
    const captivate = await detectCaptivate()
    if (!bundleResult) {
      try {
        bundleResult = await exportMigrationBundle(model, outputPath)
        diagnostics.push(...bundleResult.diagnostics)
      } catch (error) {
        artifacts.push(failedArtifact('captivate', error))
        return { artifacts, diagnostics: deduplicateDiagnostics(diagnostics) }
      }
    }

    artifacts.push({
      target: 'captivate',
      status: 'skipped',
      path: bundleResult.path,
      message:
        captivate.detected && captivate.adapterEligible
          ? `Adobe Captivate Classic ${captivate.version ?? ''} is installed and verified, but native CPTX generation is not enabled in this build. A Captivate assembly job was written to the migration bundle.`
          : `${captivate.reason ?? 'Captivate is unavailable.'} A Captivate assembly job was written to the migration bundle.`
    })
  }

  return { artifacts, diagnostics: deduplicateDiagnostics(diagnostics) }
}
