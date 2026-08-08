import { describe, expect, it, vi } from 'vitest'
import { focusExistingWindow, type FocusableWindow } from '../src/main/single-instance'

function windowFixture(overrides: Partial<FocusableWindow> = {}): FocusableWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides
  }
}

describe('second Electron instance handoff', () => {
  it('restores, shows, and focuses the existing primary window', () => {
    const window = windowFixture({
      isMinimized: () => true,
      isVisible: () => false
    })

    expect(focusExistingWindow(window)).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('does not touch a missing or destroyed window', () => {
    const destroyed = windowFixture({ isDestroyed: () => true })

    expect(focusExistingWindow(null)).toBe(false)
    expect(focusExistingWindow(destroyed)).toBe(false)
    expect(destroyed.restore).not.toHaveBeenCalled()
    expect(destroyed.show).not.toHaveBeenCalled()
    expect(destroyed.focus).not.toHaveBeenCalled()
  })

  it('does not steal focus while Captivate automation owns the desktop', () => {
    const window = windowFixture()

    expect(focusExistingWindow(window, { allowFocus: false })).toBe(false)
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('tolerates a window that disappears during the focus handoff', () => {
    const closing = windowFixture({
      isVisible: () => {
        throw new Error('Object has been destroyed')
      }
    })

    expect(focusExistingWindow(closing)).toBe(false)
    expect(closing.focus).not.toHaveBeenCalled()
  })
})
