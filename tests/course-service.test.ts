import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportCourse } from '../src/main/course-service'

const syntheticCourse = resolve('tests/fixtures/synthetic-course')
const disposableRoots: string[] = []

afterEach(async () => {
  for (const root of disposableRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('desktop course service', () => {
  it('refuses to write generated output into the source course tree', async () => {
    await expect(
      exportCourse({
        sourcePath: syntheticCourse,
        outputPath: resolve(syntheticCourse, 'exports'),
        targets: ['migration-bundle']
      })
    ).rejects.toThrow(/outside the source course folder/i)
  })

  it('requires at least one explicit output target', async () => {
    await expect(
      exportCourse({
        sourcePath: syntheticCourse,
        outputPath: resolve('output'),
        targets: []
      })
    ).rejects.toThrow(/at least one export target/i)
  })

  it('fails a stale Captivate request honestly without creating a fake CPTX', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'compos-a-toast-course-service-'))
    disposableRoots.push(outputRoot)

    const result = await exportCourse(
      {
        sourcePath: syntheticCourse,
        outputPath: outputRoot,
        targets: ['captivate']
      },
      {
        captivate: {
          driverPath: join(outputRoot, 'missing-driver.ps1'),
          seedCptxPaths: [],
          platform: 'win32'
        }
      }
    )

    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'migration-bundle', status: 'created' }),
        expect.objectContaining({ target: 'captivate', status: 'failed' })
      ])
    )
    expect((await readdir(outputRoot)).some((name) => name.endsWith('.cptx'))).toBe(false)
  })
})
