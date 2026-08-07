import type { CaptivateDetectionDto } from '../../shared/contracts'

export type CaptivateInstallationState =
  | 'checking'
  | 'eligible'
  | 'ineligible'
  | 'missing'
  | 'error'

export interface CaptivateStatusPresentation {
  installationState: CaptivateInstallationState
  installationText: string
  reasonText: string
  availabilityText: string
  title: string
}

export const CAPTIVATE_EXPORT_UNAVAILABLE =
  'Native CPTX generation is not enabled in this build.'

function detectedProductName(detection: CaptivateDetectionDto): string {
  const productName = detection.productName?.trim()
  if (productName) return productName
  if (detection.product === 'classic') return 'Adobe Captivate Classic'
  return 'Adobe Captivate'
}

function detectedProductLabel(detection: CaptivateDetectionDto): string {
  return [detectedProductName(detection), detection.version?.trim()].filter(Boolean).join(' ')
}

function titleFor(detection: CaptivateDetectionDto): string {
  return [detection.path, detection.reason].filter(Boolean).join('\n')
}

/**
 * Keeps installation compatibility separate from native-export readiness. A verified
 * Captivate installation is eligible for adapter work, but does not make the unfinished
 * CPTX exporter available.
 */
export function presentCaptivateStatus(
  detection: CaptivateDetectionDto | null,
  detectionFailed = false
): CaptivateStatusPresentation {
  if (!detection) {
    return detectionFailed
      ? {
          installationState: 'error',
          installationText: 'Captivate detection unavailable',
          reasonText: 'Restart the app to check again. Bundle and SCORM exports remain available.',
          availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
          title: ''
        }
      : {
          installationState: 'checking',
          installationText: 'Checking for Adobe Captivate Classic…',
          reasonText: '',
          availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
          title: ''
        }
  }

  if (!detection.detected) {
    return {
      installationState: 'missing',
      installationText: 'Adobe Captivate Classic not found',
      reasonText:
        detection.reason ?? 'Bundle and SCORM exports remain available without Captivate.',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      title: detection.reason ?? ''
    }
  }

  const productLabel = detectedProductLabel(detection)
  if (detection.adapterEligible) {
    return {
      installationState: 'eligible',
      installationText: `${productLabel} installed and verified`,
      reasonText: '',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      title: titleFor(detection)
    }
  }

  return {
    installationState: 'ineligible',
    installationText: `${productLabel} detected`,
    reasonText:
      detection.reason ?? 'This Captivate installation is not eligible for native export.',
    availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
    title: titleFor(detection)
  }
}
