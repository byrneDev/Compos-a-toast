import { describe, expect, it } from 'vitest'
import type {
  CaptivateAdapterCapabilityDto,
  CaptivateDetectionDto
} from '../src/shared/contracts'
import {
  CAPTIVATE_EXPORT_UNAVAILABLE,
  presentCaptivateStatus
} from '../src/renderer/src/captivate-status'

function detection(overrides: Partial<CaptivateDetectionDto> = {}): CaptivateDetectionDto {
  return {
    detected: true,
    path: 'C:\\Program Files\\Adobe\\Adobe Captivate Classic x64\\AdobeCaptivateClassic.exe',
    product: 'classic',
    version: '11.8.4.21',
    productName: 'Adobe Captivate Classic',
    signatureVerified: true,
    versionSupported: true,
    adapterEligible: true,
    ...overrides
  }
}

function readyCapability(
  captivateBuild = '11.8.4.21'
): Extract<CaptivateAdapterCapabilityDto, { state: 'ready' }> {
  return {
    state: 'ready',
    adapterId: 'captivate-classic-11.8-editable-draft',
    captivateBuild,
    verifiedAt: '2026-08-07T12:00:00.000Z',
    scope: {
      nativeObjects: ['slide', 'text'],
      unsupportedBehavior: 'migration-bundle-review'
    }
  }
}

describe('Captivate renderer status', () => {
  it('keeps an eligible installation disabled when no adapter capability is available', () => {
    const result = presentCaptivateStatus(detection(), null)

    expect(result).toMatchObject({
      state: 'unavailable',
      installationState: 'eligible',
      installationText: 'Adobe Captivate Classic 11.8.4.21 installed and verified',
      reasonText: '',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      selectable: false
    })
    expect(result.statusText).toContain(result.installationText)
    expect(result.statusText).toContain(result.availabilityText)
  })

  it('enables an exact-build verified adapter and describes its honest initial scope', () => {
    const result = presentCaptivateStatus(detection(), readyCapability())

    expect(result).toMatchObject({
      state: 'ready',
      installationState: 'eligible',
      installationText: 'Adobe Captivate Classic 11.8.4.21 installed and verified',
      selectable: true
    })
    expect(result.availabilityText).toBe(
      'Editable Captivate draft ready with native slides and editable title text. Images, interactions, detailed layout, and remaining text stay in the migration bundle for review.'
    )
    expect(result.statusText).toBe(`${result.installationText} ${result.availabilityText}`)
  })

  it('blocks a ready adapter verified for a different Captivate build', () => {
    const result = presentCaptivateStatus(detection(), readyCapability('11.8.3.8'))

    expect(result).toMatchObject({
      state: 'blocked',
      installationState: 'eligible',
      selectable: false
    })
    expect(result.availabilityText).toMatch(/11\.8\.3\.8.*11\.8\.4\.21/)
  })

  it.each([
    {
      state: 'unavailable',
      reason: 'The native adapter is not included in this build.'
    },
    {
      state: 'verification-required',
      reason: 'Verify the Captivate authoring workspace before exporting.'
    },
    {
      state: 'blocked',
      reason: 'Adobe Captivate reported a suspended subscription.'
    }
  ] satisfies CaptivateAdapterCapabilityDto[])('surfaces $state without enabling export', (capability) => {
    const result = presentCaptivateStatus(detection(), capability)

    expect(result).toMatchObject({
      state: capability.state,
      installationState: 'eligible',
      availabilityText: capability.reason,
      selectable: false
    })
    expect(result.title).toContain(capability.reason)
  })

  it('does not let a ready capability override an ineligible installation', () => {
    const reason =
      'Captivate Classic 11.8.2.1 is installed, but the automation adapter targets supported builds.'
    const result = presentCaptivateStatus(
      detection({
        version: '11.8.2.1',
        versionSupported: false,
        adapterEligible: false,
        reason
      }),
      readyCapability('11.8.2.1')
    )

    expect(result).toMatchObject({
      state: 'ineligible',
      installationState: 'ineligible',
      reasonText: reason,
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      selectable: false
    })
  })

  it('distinguishes the newer CPT-based Captivate product from Classic', () => {
    const reason = 'Editable CPTX assembly requires Adobe Captivate Classic.'
    const result = presentCaptivateStatus(
      detection({
        product: 'modern',
        productName: 'Adobe Captivate',
        version: '13.1.0.10',
        adapterEligible: false,
        reason
      }),
      null
    )

    expect(result).toMatchObject({
      state: 'ineligible',
      installationState: 'ineligible',
      installationText: 'Adobe Captivate 13.1.0.10 detected',
      reasonText: reason,
      selectable: false
    })
  })

  it('reports a missing installation without obscuring the available outputs', () => {
    const reason =
      'Adobe Captivate Classic was not found. Bundle and SCORM exports remain available.'
    const result = presentCaptivateStatus(
      detection({
        detected: false,
        path: undefined,
        product: undefined,
        version: undefined,
        productName: undefined,
        signatureVerified: false,
        versionSupported: false,
        adapterEligible: false,
        reason
      }),
      null
    )

    expect(result).toMatchObject({
      state: 'missing',
      installationState: 'missing',
      installationText: 'Adobe Captivate Classic not found',
      reasonText: reason,
      selectable: false,
      title: reason
    })
  })

  it('has separate loading and detection-error presentations', () => {
    expect(presentCaptivateStatus(null, null)).toMatchObject({
      state: 'checking',
      installationState: 'checking',
      installationText: 'Checking for Adobe Captivate Classic\u2026',
      selectable: false
    })
    expect(presentCaptivateStatus(null, null, true)).toMatchObject({
      state: 'error',
      installationState: 'error',
      installationText: 'Captivate detection unavailable',
      selectable: false
    })
  })

  it('keeps the legacy two-argument presentation call safely unavailable', () => {
    expect(presentCaptivateStatus(detection(), false)).toMatchObject({
      state: 'unavailable',
      selectable: false
    })
    expect(presentCaptivateStatus(null, true)).toMatchObject({
      state: 'error',
      selectable: false
    })
  })
})
