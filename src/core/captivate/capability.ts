import type {
  CaptivateAdapterCapabilityDto,
  CaptivateDetectionDto
} from '../../shared/contracts'

/**
 * Installation eligibility and adapter readiness are deliberately independent.
 * A signed, supported Captivate executable is not enough to promise CPTX output.
 */
export function isCaptivateAdapterSelectable(
  detection: CaptivateDetectionDto | null | undefined,
  capability: CaptivateAdapterCapabilityDto | null | undefined
): boolean {
  return Boolean(
    detection?.adapterEligible &&
      detection.version &&
      capability?.state === 'ready' &&
      capability.captivateBuild === detection.version
  )
}
