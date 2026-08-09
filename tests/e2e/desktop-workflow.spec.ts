import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const projectRoot = resolve('.')
const syntheticCourse = resolve('tests/fixtures/synthetic-course')

test('analyzes a course and exports bundle and SCORM while unverified Captivate remains disabled', async () => {
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
        'onCaptivateProgress',
        'onQuitDeferred',
        'selectCourse',
        'selectOutput'
      ],
      processType: 'undefined',
      requireType: 'undefined'
    })

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:environment')
      ipcMain.handle('app:environment', () => ({
        appVersion: '0.5.0',
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
        },
        captivateAdapter: {
          state: 'unavailable',
          reason: 'No verified Captivate adapter is configured.'
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
      'No verified Captivate adapter is configured.'
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

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('course:export')
      ipcMain.handle('course:export', (_event, request: { targets: string[] }) => ({
        artifacts: request.targets.map((target) => ({
          target,
          status: 'failed',
          message: `Could not create ${target}.`
        })),
        diagnostics: []
      }))
    })
    await page.getByRole('button', { name: 'Build selected outputs' }).click()
    await expect(page.getByRole('heading', { name: 'Conversion failed.' })).toBeVisible()
    await expect(page.getByText('No requested files were created.')).toBeVisible()
    await expect(page.getByText('Your new files are ready')).toHaveCount(0)

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

test('enables and submits Captivate only when its adapter is ready for the installed build', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'compos-a-toast-captivate-e2e-'))
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

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:environment')
      ipcMain.handle('app:environment', () => ({
        appVersion: '0.5.0',
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
        },
        captivateAdapter: {
          state: 'ready',
          adapterId: 'captivate-classic-11.8-editable-draft',
          captivateBuild: '11.8.4.21',
          verifiedAt: '2026-08-08T12:47:24.536Z',
          scope: {
            nativeObjects: ['slide', 'text'],
            unsupportedBehavior: 'migration-bundle-review'
          }
        }
      }))

      ipcMain.removeHandler('course:export')
      ipcMain.handle('course:export', async (event, request: { targets: string[] }) => {
        const testState = globalThis as typeof globalThis & {
          composAToastSubmittedTargets?: string[]
        }
        testState.composAToastSubmittedTargets = [...request.targets]
        event.sender.send('app:captivate-progress', {
          stage: 'TRIAL_REMINDER_REQUIRES_USER_ACTION',
          message:
            'In the verified Adobe Captivate trial window, single-click Continue Trial once (or Continue Offline if that is the label Adobe shows). Then do not use the mouse or keyboard—Compos-a-toast will continue automatically. Do not choose Try Again or close either app.',
          requiresUserAction: true
        })
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 750))
        return {
          artifacts: request.targets.map((target) => ({
            target,
            status: 'created',
            message: `Created ${target}.`
          })),
          diagnostics: []
        }
      })
    })
    await page.reload()

    const captivateTarget = page.getByRole('button', { name: /Adobe Captivate \(\.cptx\)/ })
    await expect(captivateTarget).toBeDisabled()
    await expect(page.locator('#captivate-availability')).toHaveText(
      'Editable Captivate draft ready with native slides and editable title text. Images, interactions, detailed layout, and remaining text stay in the migration bundle for review.'
    )

    await page.getByRole('textbox', { name: 'Published course folder' }).fill(syntheticCourse)
    await page.getByRole('button', { name: 'Analyze' }).click()

    await expect(page.getByText('Recognized', { exact: true })).toBeVisible()
    await expect(captivateTarget).toBeEnabled()
    await expect(captivateTarget).not.toHaveAttribute('aria-disabled', 'true')
    await expect(captivateTarget).not.toHaveClass(/is-pending/)

    await captivateTarget.click()
    await expect(captivateTarget).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('textbox', { name: 'Export destination' }).fill(outputRoot)
    await page.getByRole('button', { name: 'Build selected outputs' }).click()
    await expect(
      page.getByRole('heading', { name: 'Action needed in Adobe Captivate' })
    ).toBeVisible()
    await expect(
      page.getByText(
        'In the verified Adobe Captivate trial window, single-click Continue Trial once (or Continue Offline if that is the label Adobe shows). Then do not use the mouse or keyboard—Compos-a-toast will continue automatically. Do not choose Try Again or close either app.'
      )
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Waiting for Continue Trial…' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Conversion finished.' })).toBeVisible()

    const submittedTargets = await electronApp.evaluate(() => {
      const testState = globalThis as typeof globalThis & {
        composAToastSubmittedTargets?: string[]
      }
      return testState.composAToastSubmittedTargets
    })
    expect(submittedTargets).toEqual(['migration-bundle', 'captivate'])
    expect(pageErrors).toEqual([])
  } finally {
    await electronApp?.close()
    await rm(outputRoot, { recursive: true, force: true })
  }
})
