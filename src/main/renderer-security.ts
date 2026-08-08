import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type TrustedRendererLocation =
  | {
      kind: 'development'
      url: string
    }
  | {
      kind: 'production'
      filePath: string
      url: string
    }

export interface TrustedRendererLocationOptions {
  isPackaged: boolean
  developmentUrl?: string
  productionFilePath: string
}
interface TrustedWebContentsLike {
  isDestroyed(): boolean
  mainFrame: unknown
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

function trustedDevelopmentUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null

  try {
    const candidate = new URL(value)
    if (
      (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') ||
      !isLoopbackHostname(candidate.hostname) ||
      candidate.username !== '' ||
      candidate.password !== ''
    ) {
      return null
    }

    // Fragment navigation remains local to the already trusted renderer. Keeping it
    // outside the identity prevents harmless in-app anchors from invalidating IPC.
    candidate.hash = ''
    return candidate.href
  } catch {
    return null
  }
}

/**
 * Resolves the one renderer location the privileged preload bridge may serve.
 * Packaged applications always ignore development environment variables.
 */
export function resolveTrustedRendererLocation(
  options: TrustedRendererLocationOptions
): TrustedRendererLocation {
  const developmentUrl = options.isPackaged
    ? null
    : trustedDevelopmentUrl(options.developmentUrl)
  if (developmentUrl) return { kind: 'development', url: developmentUrl }

  const filePath = resolve(options.productionFilePath)
  return {
    kind: 'production',
    filePath,
    url: pathToFileURL(filePath).href
  }
}

/** Exact URL comparison, except for an in-document fragment. */
export function isTrustedRendererUrl(
  candidateValue: string,
  trustedLocation: TrustedRendererLocation
): boolean {
  try {
    const candidate = new URL(candidateValue)
    candidate.hash = ''
    return candidate.href === trustedLocation.url
  } catch {
    return false
  }
}

/**
 * Ensures privileged IPC came from the current BrowserWindow's top-level frame.
 * Object identity deliberately rejects subframes, stale frames, and other windows.
 */
export function isTrustedMainFrame(
  sender: unknown,
  senderFrame: unknown,
  trustedWebContents: TrustedWebContentsLike | null | undefined
): boolean {
  return Boolean(
    trustedWebContents &&
      !trustedWebContents.isDestroyed() &&
      sender === trustedWebContents &&
      senderFrame !== null &&
      senderFrame !== undefined &&
      senderFrame === trustedWebContents.mainFrame
  )
}
