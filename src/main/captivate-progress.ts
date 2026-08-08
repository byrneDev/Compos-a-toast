import type { CaptivateAdapterProgress } from '../core/captivate/adapter'
import type { CaptivateProgressDto } from '../shared/contracts'

export const CAPTIVATE_TRIAL_ACTION_CODE = 'TRIAL_REMINDER_REQUIRES_USER_ACTION'
const CAPTIVATE_TRIAL_ACTION_EVENTS = new Set([
  CAPTIVATE_TRIAL_ACTION_CODE,
  'AWAIT_CONTINUE_TRIAL'
])

const DEFAULT_TRIAL_ACTION_MESSAGE =
  'In the verified Adobe Captivate trial window, choose Continue Trial (or Continue Offline if that is the label Adobe shows). Do not choose Try Again or close Captivate.'

function normalizedEventName(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

export function toCaptivateProgressDto(
  progress: CaptivateAdapterProgress
): CaptivateProgressDto {
  const requiresUserAction = [progress.code, progress.stage]
    .map(normalizedEventName)
    .some((eventName) => CAPTIVATE_TRIAL_ACTION_EVENTS.has(eventName))
  const message = progress.message?.trim()

  return {
    stage: progress.stage,
    ...(progress.code
      ? { code: progress.code }
      : requiresUserAction
        ? { code: CAPTIVATE_TRIAL_ACTION_CODE }
        : {}),
    message: requiresUserAction
      ? DEFAULT_TRIAL_ACTION_MESSAGE
      : message || 'Adobe Captivate is working.',
    requiresUserAction,
    ...(progress.timestamp ? { timestamp: progress.timestamp } : {})
  }
}
