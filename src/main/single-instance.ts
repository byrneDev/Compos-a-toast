export interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface FocusExistingWindowOptions {
  allowFocus?: boolean
}

/** Brings the primary instance forward without touching a missing or closing window. */
export function focusExistingWindow(
  window: FocusableWindow | null | undefined,
  options: FocusExistingWindowOptions = {}
): boolean {
  if (!window || options.allowFocus === false) return false
  try {
    if (window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    return true
  } catch {
    // A window can disappear between the state probe and a focus operation.
    return false
  }
}
