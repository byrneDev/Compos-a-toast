import { describe, expect, it } from 'vitest'
import type { CaptivateDetectionDto } from '../src/shared/contracts'
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

describe('Captivate renderer status', () => {
  it.each(['11.8.3.8', '11.8.4.21'])(
    'reports supported Classic %s accurately without enabling native export',
    (version) => {
      const result = presentCaptivateStatus(detection({ version }))

      expect(result).toMatchObject({
        installationState: 'eligible',
        installationText: `Adobe Captivate Classic ${version} installed and verified`,
        reasonText: '',
        availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE
      })
      expect(result.title).toContain('AdobeCaptivateClassic.exe')
      expect(result.installationText).not.toMatch(/not detected|under development/i)
    }
  )

  it('surfaces an unsupported Classic build and its reason', () => {
    const reason =
      'Captivate Classic 11.8.2.1 is installed, but the automation adapter targets supported builds.'
    const result = presentCaptivateStatus(
      detection({ version: '11.8.2.1', versionSupported: false, adapterEligible: false, reason })
    )

    expect(result).toMatchObject({
      installationState: 'ineligible',
      installationText: 'Adobe Captivate Classic 11.8.2.1 detected',
      reasonText: reason,
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE
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
      })
    )

    expect(result).toMatchObject({
      installationState: 'ineligible',
      installationText: 'Adobe Captivate 13.1.0.10 detected',
      reasonText: reason,
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE
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
      })
    )

    expect(result).toEqual({
      installationState: 'missing',
      installationText: 'Adobe Captivate Classic not found',
      reasonText: reason,
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      title: reason
    })
  })

  it('has separate loading and detection-error presentations', () => {
    expect(presentCaptivateStatus(null)).toEqual({
      installationState: 'checking',
      installationText: 'Checking for Adobe Captivate Classic…',
      reasonText: '',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE,
      title: ''
    })
    expect(presentCaptivateStatus(null, true)).toMatchObject({
      installationState: 'error',
      installationText: 'Captivate detection unavailable',
      availabilityText: CAPTIVATE_EXPORT_UNAVAILABLE
    })
  })

  it('keeps native export unavailable for every installation state', () => {
    const states = [
      presentCaptivateStatus(null),
      presentCaptivateStatus(null, true),
      presentCaptivateStatus(detection()),
      presentCaptivateStatus(detection({ adapterEligible: false })),
      presentCaptivateStatus(detection({ detected: false, adapterEligible: false }))
    ]

    expect(states.every((state) => state.availabilityText === CAPTIVATE_EXPORT_UNAVAILABLE)).toBe(
      true
    )
  })
})
