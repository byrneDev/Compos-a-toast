import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isTrustedMainFrame,
  isTrustedRendererUrl,
  resolveTrustedRendererLocation
} from '../src/main/renderer-security'

const productionFilePath = join('C:\\app', 'out', 'renderer', 'index.html')

describe('trusted Electron renderer location', () => {
  it('ignores the development URL in a packaged application', () => {
    const location = resolveTrustedRendererLocation({
      isPackaged: true,
      developmentUrl: 'http://localhost:5173',
      productionFilePath
    })

    expect(location).toMatchObject({ kind: 'production' })
    expect(location.url).toMatch(/^file:/)
  })

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173/',
    'https://[::1]:5173/app'
  ])('accepts an exact loopback development URL: %s', (developmentUrl) => {
    expect(
      resolveTrustedRendererLocation({
        isPackaged: false,
        developmentUrl,
        productionFilePath
      })
    ).toMatchObject({ kind: 'development' })
  })

  it.each([
    'https://example.com/app',
    'http://localhost.example.com:5173/',
    'http://user:password@localhost:5173/',
    'not a URL'
  ])('rejects an untrusted development URL: %s', (developmentUrl) => {
    expect(
      resolveTrustedRendererLocation({
        isPackaged: false,
        developmentUrl,
        productionFilePath
      })
    ).toMatchObject({ kind: 'production' })
  })

  it('permits only the configured URL, apart from an in-document fragment', () => {
    const location = resolveTrustedRendererLocation({
      isPackaged: false,
      developmentUrl: 'http://localhost:5173/app?mode=dev',
      productionFilePath
    })

    expect(isTrustedRendererUrl('http://localhost:5173/app?mode=dev', location)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/app?mode=dev#inspect', location)).toBe(
      true
    )
    expect(isTrustedRendererUrl('http://localhost:5173/app/child?mode=dev', location)).toBe(
      false
    )
    expect(isTrustedRendererUrl('http://localhost:5173/app?mode=other', location)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173.evil.test/app?mode=dev', location)).toBe(
      false
    )
  })
})
describe('trusted Electron IPC frame', () => {
  it('accepts only the current top-level frame of the trusted web contents', () => {
    const mainFrame = {}
    const webContents = {
      mainFrame,
      isDestroyed: () => false
    }

    expect(isTrustedMainFrame(webContents, mainFrame, webContents)).toBe(true)
    expect(isTrustedMainFrame(webContents, {}, webContents)).toBe(false)
    expect(isTrustedMainFrame({}, mainFrame, webContents)).toBe(false)
    expect(isTrustedMainFrame(webContents, null, webContents)).toBe(false)
  })

  it('rejects a destroyed trusted web contents', () => {
    const mainFrame = {}
    const webContents = {
      mainFrame,
      isDestroyed: () => true
    }

    expect(isTrustedMainFrame(webContents, mainFrame, webContents)).toBe(false)
  })
})
