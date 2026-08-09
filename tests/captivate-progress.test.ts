import { describe, expect, it } from 'vitest'
import {
  CAPTIVATE_TRIAL_ACTION_CODE,
  toCaptivateProgressDto
} from '../src/main/captivate-progress'

describe('Captivate progress presentation', () => {
  it('turns the trial reminder stage into an explicit user action', () => {
    expect(
      toCaptivateProgressDto({
        type: 'progress',
        schemaVersion: 1,
        mode: 'export',
        stage: 'await-continue-trial',
        message:
          'Action required: click Continue Trial in the verified Adobe Captivate trial reminder.'
      })
    ).toEqual({
      stage: 'await-continue-trial',
      code: CAPTIVATE_TRIAL_ACTION_CODE,
      message:
        'In the verified Adobe Captivate trial window, single-click Continue Trial once (or Continue Offline if that is the label Adobe shows). Then do not use the mouse or keyboard—Compos-a-toast will continue automatically. Do not choose Try Again or close either app.',
      requiresUserAction: true
    })
  })

  it('supplies direct instructions when an action event has no message', () => {
    expect(
      toCaptivateProgressDto({
        type: 'progress',
        schemaVersion: 1,
        mode: 'export',
        stage: CAPTIVATE_TRIAL_ACTION_CODE
      })
    ).toMatchObject({
      code: CAPTIVATE_TRIAL_ACTION_CODE,
      message:
        'In the verified Adobe Captivate trial window, single-click Continue Trial once (or Continue Offline if that is the label Adobe shows). Then do not use the mouse or keyboard—Compos-a-toast will continue automatically. Do not choose Try Again or close either app.',
      requiresUserAction: true
    })
  })

  it('also recognizes a normalized progress code and uses the safe action instructions', () => {
    expect(
      toCaptivateProgressDto({
        type: 'progress',
        schemaVersion: 1,
        mode: 'export',
        stage: 'licensing-handoff',
        code: 'trial-reminder-requires-user-action',
        message: '  Click Continue Trial in Adobe Captivate.  ',
        timestamp: '2026-08-07T12:00:00.000Z'
      })
    ).toEqual({
      stage: 'licensing-handoff',
      code: 'trial-reminder-requires-user-action',
      message:
        'In the verified Adobe Captivate trial window, single-click Continue Trial once (or Continue Offline if that is the label Adobe shows). Then do not use the mouse or keyboard—Compos-a-toast will continue automatically. Do not choose Try Again or close either app.',
      requiresUserAction: true,
      timestamp: '2026-08-07T12:00:00.000Z'
    })
  })

  it('preserves an ordinary driver progress message', () => {
    expect(
      toCaptivateProgressDto({
        type: 'progress',
        schemaVersion: 1,
        mode: 'export',
        stage: 'save-output',
        message: 'Saving the editable draft.'
      })
    ).toEqual({
      stage: 'save-output',
      message: 'Saving the editable draft.',
      requiresUserAction: false
    })
  })
})
