import { describe, expect, it, vi } from 'vitest'
import { CaptivateActivityTracker } from '../src/main/captivate-activity'

describe('Captivate export lifecycle guard', () => {
  it('blocks while a driver run is active and releases after confirmed normal exit', () => {
    const tracker = new CaptivateActivityTracker({ pollIntervalMs: 60_000 })
    const onIdle = vi.fn()
    tracker.onIdle(onIdle)

    tracker.hooks.onStart()
    expect(tracker.isActive()).toBe(true)

    tracker.hooks.onFinish({
      processExitConfirmed: true,
      processIds: [1234],
      helperProcessIds: []
    })
    expect(tracker.isActive()).toBe(false)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('keeps quit deferred after an unconfirmed failure until Captivate is gone', async () => {
    let runningProcessIds = [4321]
    const tracker = new CaptivateActivityTracker({
      pollIntervalMs: 60_000,
      listProcessIds: async () => runningProcessIds
    })
    const onIdle = vi.fn()
    tracker.onIdle(onIdle)

    tracker.hooks.onStart()
    tracker.hooks.onFinish({
      processExitConfirmed: false,
      processIds: [4321],
      helperProcessIds: []
    })
    expect(tracker.isActive()).toBe(true)

    await tracker.reconcileNow()
    expect(tracker.isActive()).toBe(true)
    expect(onIdle).not.toHaveBeenCalled()

    runningProcessIds = []
    await tracker.reconcileNow()
    expect(tracker.isActive()).toBe(false)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('discovers Captivate by read-only polling when a PowerShell timeout has no attested PID', async () => {
    let runningProcessIds = [9876]
    const tracker = new CaptivateActivityTracker({
      pollIntervalMs: 60_000,
      listProcessIds: async () => runningProcessIds
    })

    tracker.hooks.onStart()
    tracker.hooks.onFinish({
      processExitConfirmed: false,
      processIds: [],
      helperProcessIds: []
    })
    expect(tracker.isActive()).toBe(true)

    await tracker.reconcileNow()
    expect(tracker.isActive()).toBe(true)

    runningProcessIds = []
    await tracker.reconcileNow()
    expect(tracker.isActive()).toBe(false)
  })

  it('keeps quit deferred for an unconfirmed accessibility helper after Captivate exits', async () => {
    let helperRunning = true
    const tracker = new CaptivateActivityTracker({
      pollIntervalMs: 60_000,
      listProcessIds: async () => [],
      isProcessIdRunning: async (processId) => processId === 2468 && helperRunning
    })

    tracker.hooks.onStart()
    tracker.hooks.onFinish({
      processExitConfirmed: true,
      processIds: [],
      helperProcessIds: [2468]
    })
    await tracker.reconcileNow()
    expect(tracker.isActive()).toBe(true)

    helperRunning = false
    await tracker.reconcileNow()
    expect(tracker.isActive()).toBe(false)
  })

  it('fails closed when read-only process reconciliation fails', async () => {
    const tracker = new CaptivateActivityTracker({
      pollIntervalMs: 60_000,
      listProcessIds: async () => {
        throw new Error('Process query unavailable')
      }
    })

    tracker.hooks.onStart()
    tracker.hooks.onFinish({
      processExitConfirmed: false,
      processIds: [],
      helperProcessIds: []
    })
    await tracker.reconcileNow()

    expect(tracker.isActive()).toBe(true)
  })
})
