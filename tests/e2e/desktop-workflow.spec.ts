import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const projectRoot = resolve('.')
const syntheticCourse = resolve('tests/fixtures/synthetic-course')

test('analyzes a course and exports both supported formats', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'compos-a-toast-e2e-'))
  let electronApp: ElectronApplication | undefined

  try {
    electronApp = await electron.launch({
      args: [projectRoot],
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: '' }
    })

    const page = await electronApp.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await expect(page).toHaveTitle('Compos-a-toast')
    await expect(page.getByRole('heading', { name: 'Compos-a-toast' })).toBeVisible()
    const brandLogo = page.locator('img.brand-icon')
    await expect(brandLogo).toBeVisible()
    expect(
      await brandLogo.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      )
    ).toBe(true)
    await expect(page.getByText('Windows desktop', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Electron')

    const browserWindow = await electronApp.browserWindow(page)
    expect(await browserWindow.evaluate((window) => window.getMinimumSize())).toEqual([940, 680])
    expect(await browserWindow.evaluate((window) => window.isMenuBarVisible())).toBe(false)

    const rendererBoundary = await page.evaluate(() => {
      const isolatedWindow = window as unknown as Window & {
        composAToast: Record<string, unknown>
        process?: unknown
        require?: unknown
      }
      return {
        bridgeKeys: Object.keys(isolatedWindow.composAToast).sort(),
        processType: typeof isolatedWindow.process,
        requireType: typeof isolatedWindow.require
      }
    })
    expect(rendererBoundary).toEqual({
      bridgeKeys: [
        'analyzeCourse',
        'exportCourse',
        'getEnvironment',
        'selectCourse',
        'selectOutput'
      ],
      processType: 'undefined',
      requireType: 'undefined'
    })

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:environment')
      ipcMain.handle('app:environment', () => ({
        appVersion: '0.1.0',
        platform: 'win32',
        captivate: {
          detected: true,
          path: 'C:\\Program Files\\Adobe\\Adobe Captivate Classic x64\\AdobeCaptivateClassic.exe',
          product: 'classic',
          version: '11.8.4.21',
          productName: 'Adobe Captivate Classic',
          signatureVerified: true,
          versionSupported: true,
          adapterEligible: true
        }
      }))
    })
    await page.reload()

    const captivateTarget = page.getByRole('button', { name: /Adobe Captivate \(\.cptx\)/ })
    const captivateStatus = page.locator('#captivate-status')
    await expect(captivateTarget).toBeDisabled()
    await expect(captivateTarget).toHaveAttribute('aria-pressed', 'false')
    await expect(captivateTarget).toHaveAttribute('aria-disabled', 'true')
    await expect(captivateStatus).not.toContainText('Adapter in development')
    await expect(captivateStatus).toHaveText(
      'Adobe Captivate Classic 11.8.4.21 installed and verified'
    )
    await expect(page.locator('#captivate-availability')).toHaveText(
      'Native CPTX generation is not enabled in this build.'
    )
    await expect(captivateTarget).toHaveAttribute('data-captivate-state', 'eligible')

    await page.getByRole('textbox', { name: 'Published course folder' }).fill(syntheticCourse)
    await page.getByRole('button', { name: 'Analyze' }).click()

    await expect(page.getByText('Recognized', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Synthetic Migration Course' })).toBeVisible()
    await expect(page.locator('.stat').filter({ hasText: 'Slides' })).toContainText('4')
    await expect(captivateTarget).toBeDisabled()
    await expect(captivateTarget).not.toHaveClass(/is-selected/)

    const scormTarget = page.getByRole('button', { name: /HTML5 SCORM 1\.2/ })
    await scormTarget.click()
    await expect(scormTarget).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('textbox', { name: 'Export destination' }).fill(outputRoot)
    await page.getByRole('button', { name: 'Build selected outputs' }).click()

    await expect(page.getByRole('heading', { name: 'Conversion finished.' })).toBeVisible()
    await expect(page.locator('.artifact[data-status="created"]')).toHaveCount(2)
    await expect(page.getByText('Created an editable reconstruction bundle')).toBeVisible()
    await expect(page.getByText('Created an HTML5 single-SCO SCORM 1.2 ZIP package.')).toBeVisible()

    const exportedEntries = await readdir(outputRoot)
    expect(exportedEntries.some((entry) => entry.endsWith('-migration-bundle'))).toBe(true)
    expect(exportedEntries.some((entry) => entry.endsWith('-scorm12.zip'))).toBe(true)
    expect(exportedEntries.some((entry) => entry.endsWith('.cptx'))).toBe(false)
    expect(pageErrors).toEqual([])
  } finally {
    await electronApp?.close()
    await rm(outputRoot, { recursive: true, force: true })
  }
})
