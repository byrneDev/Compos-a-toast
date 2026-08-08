import { describe, expect, it } from 'vitest'
import { isCaptivateAdapterSelectable } from '../src/core/captivate/capability'
import type {
  CaptivateAdapterCapabilityDto,
  CaptivateDetectionDto
} from '../src/shared/contracts'

function eligibleDetection(
  overrides: Partial<CaptivateDetectionDto> = {}
): CaptivateDetectionDto {
  return {
    detected: true,
    product: 'classic',
    version: '11.8.4.21',
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

describe('Captivate adapter capability gate', () => {
  it('selects only an eligible installation with a ready exact-build adapter', () => {
    expect(isCaptivateAdapterSelectable(eligibleDetection(), readyCapability())).toBe(true)
  })

  it.each([
    undefined,
    null,
    {
      state: 'unavailable',
      reason: 'No adapter implementation is registered.'
    },
    {
      state: 'verification-required',
      reason: 'Authoring verification has not run.'
    },
    {
      state: 'blocked',
      reason: 'Captivate cannot enter the authoring workspace.'
    }
  ] satisfies Array<CaptivateAdapterCapabilityDto | null | undefined>)(
    'does not confuse installation eligibility with adapter readiness',
    (capability) => {
      expect(isCaptivateAdapterSelectable(eligibleDetection(), capability)).toBe(false)
    }
  )

  it('rejects a ready adapter for a different exact build', () => {
    expect(
      isCaptivateAdapterSelectable(eligibleDetection(), readyCapability('11.8.3.8'))
    ).toBe(false)
  })

  it('rejects a ready adapter when installation eligibility is false', () => {
    expect(
      isCaptivateAdapterSelectable(
        eligibleDetection({ adapterEligible: false }),
        readyCapability()
      )
    ).toBe(false)
  })

  it('rejects missing detection and a detection without an exact version', () => {
    expect(isCaptivateAdapterSelectable(null, readyCapability())).toBe(false)
    expect(
      isCaptivateAdapterSelectable(eligibleDetection({ version: undefined }), readyCapability())
    ).toBe(false)
  })
})
