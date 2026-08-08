import { isCaptivateAdapterSelectable } from '../../core/captivate/capability'
import type {
  CaptivateAdapterCapabilityDto,
  CaptivateAdapterScopeDto,
  CaptivateDetectionDto,
  CaptivateNativeObjectCapability
} from '../../shared/contracts'

export type CaptivateInstallationState =
  | 'checking'
  | 'eligible'
  | 'ineligible'
  | 'missing'
  | 'error'

export type CaptivatePresentationState =
  | CaptivateInstallationState
  | 'unavailable'
  | 'verification-required'
  | 'blocked'
  | 'ready'

export interface CaptivateStatusPresentation {
  state: CaptivatePresentationState
  installationState: CaptivateInstallationState
  installationText: string
  reasonText: string
  availabilityText: string
  statusText: string
  selectable: boolean
  title: string
}

export const CAPTIVATE_EXPORT_UNAVAILABLE =
  'Native CPTX adapter capability is unavailable in this build.'

function detectedProductName(detection: CaptivateDetectionDto): string {
  const productName = detection.productName?.trim()
  if (productName) return productName
  if (detection.product === 'classic') return 'Adobe Captivate Classic'
  return 'Adobe Captivate'
}

function detectedProductLabel(detection: CaptivateDetectionDto): string {
  return [detectedProductName(detection), detection.version?.trim()].filter(Boolean).join(' ')
}

function titleFor(
  detection: CaptivateDetectionDto,
  capability: CaptivateAdapterCapabilityDto | null
): string {
  const capabilityReason = capability?.state === 'ready' ? undefined : capability?.reason
  return [detection.path, detection.reason, capabilityReason].filter(Boolean).join('\n')
}

function combinedPresentation(
  presentation: Omit<CaptivateStatusPresentation, 'statusText'>
): CaptivateStatusPresentation {
  return {
    ...presentation,
    statusText: [
      presentation.installationText,
      presentation.reasonText,
      presentation.availabilityText
    ]
      .filter((value) => value.trim().length > 0)
      .join(' ')
  }
}

const nativeObjectLabels: Record<CaptivateNativeObjectCapability, string> = {
  slide: 'slides',
  text: 'text',
  image: 'images',
  interaction: 'interactions'
}

function formatList(values: string[]): string {
  if (values.length === 0) return 'no native object types'
  if (values.length === 1) return values[0]!
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function readyAvailabilityText(scope: CaptivateAdapterScopeDto): string {
  if (
    scope.nativeObjects.includes('slide') &&
    scope.nativeObjects.includes('text') &&
    !scope.nativeObjects.includes('image') &&
    !scope.nativeObjects.includes('interaction')
  ) {
    return 'Editable Captivate draft ready with native slides and editable title text. Images, interactions, detailed layout, and remaining text stay in the migration bundle for review.'
  }

  const nativeObjects = formatList(scope.nativeObjects.map((item) => nativeObjectLabels[item]))
  const reviewObjects = (['image', 'interaction'] as const)
    .filter((item) => !scope.nativeObjects.includes(item))
    .map((item) => nativeObjectLabels[item])
  const reviewText =
    reviewObjects.length > 0
      ? `${formatList(reviewObjects).replace(/^./, (value) => value.toUpperCase())} remain migration-bundle review work.`
      : 'Any unsupported content remains migration-bundle review work.'

  return `Editable Captivate draft ready with native ${nativeObjects}. ${reviewText}`
}

/**
 * Keeps installation compatibility separate from verified native-export readiness.
 * The legacy two-argument overload remains until the renderer supplies capability data.
 */
export function presentCaptivateStatus(
  detection: CaptivateDetectionDto | null,
  capability: CaptivateAdapterCapabilityDto | null,
  detectionFailed?: boolean
): CaptivateStatusPresentation
export function presentCaptivateStatus(
  detection: CaptivateDetectionDto | null,
  detectionFailed?: boolean
): CaptivateStatusPresentation
export function presentCaptivateStatus(
  detection: CaptivateDetectionDto | null,
  capabilityOrDetectionFailed: CaptivateAdapterCapabilityDto | null | boolean = null,
  detectionFailed = false
): CaptivateStatusPresentation {
  const capability =
    typeof capabilityOrDetectionFailed === 'boolean' ? null : capabilityOrDetectionFailed
  const failed =
    typeof capabilityOrDetectionFailed === 'boolean'
      ? capabilityOrDetectionFailed
      : detectionFailed

  if (!detection) {
    return failed
      ? combinedPresentation({
          state: 'error',
          installationState: 'error',
          installationText: 'Captivate detection unavailable',
          reasonText: 'Restart the app to check again. Bundle and SCORM exports remain available.',
          availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
          selectable: false,
          title: ''
        })
      : combinedPresentation({
          state: 'checking',
          installationState: 'checking',
          installationText: 'Checking for Adobe Captivate Classic\u2026',
          reasonText: '',
          availabilityText: 'Native CPTX capability has not been verified.',
          selectable: false,
          title: ''
        })
  }

  if (!detection.detected) {
    const reason =
      detection.reason ?? 'Bundle and SCORM exports remain available without Captivate.'
    return combinedPresentation({
      state: 'missing',
      installationState: 'missing',
      installationText: 'Adobe Captivate Classic not found',
      reasonText: reason,
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      selectable: false,
      title: reason
    })
  }

  const productLabel = detectedProductLabel(detection)
  if (!detection.adapterEligible) {
    return combinedPresentation({
      state: 'ineligible',
      installationState: 'ineligible',
      installationText: `${productLabel} detected`,
      reasonText:
        detection.reason ?? 'This Captivate installation is not eligible for native export.',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      selectable: false,
      title: titleFor(detection, capability)
    })
  }

  const installationText = `${productLabel} installed and verified`
  if (!capability) {
    return combinedPresentation({
      state: 'unavailable',
      installationState: 'eligible',
      installationText,
      reasonText: '',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      selectable: false,
      title: titleFor(detection, null)
    })
  }

  if (capability.state !== 'ready') {
    return combinedPresentation({
      state: capability.state,
      installationState: 'eligible',
      installationText,
      reasonText: '',
      availabilityText: capability.reason,
      selectable: false,
      title: titleFor(detection, capability)
    })
  }

  if (!isCaptivateAdapterSelectable(detection, capability)) {
    const mismatch = `The verified adapter targets Captivate Classic ${capability.captivateBuild}, not installed build ${detection.version ?? 'unknown'}.`
    return combinedPresentation({
      state: 'blocked',
      installationState: 'eligible',
      installationText,
      reasonText: '',
      availabilityText: mismatch,
      selectable: false,
      title: [titleFor(detection, capability), mismatch].filter(Boolean).join('\n')
    })
  }

  return combinedPresentation({
    state: 'ready',
    installationState: 'eligible',
    installationText,
    reasonText: '',
    availabilityText: readyAvailabilityText(capability.scope),
    selectable: true,
    title: titleFor(detection, capability)
  })
}
