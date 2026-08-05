import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportCourse } from '../src/main/course-service'

const syntheticCourse = resolve('tests/fixtures/synthetic-course')

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
})
