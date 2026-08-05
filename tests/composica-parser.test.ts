import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  analyzeComposicaCourse,
  decodeLegacyBuffer,
  locateComposicaProject,
  parseInlineStyle,
  parseProjectXml
} from '../src/core/composica'

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/synthetic-course', import.meta.url)
)

describe('Composica project location', () => {
  it('accepts the course, Content, Projects, Res, and project.xml paths', async () => {
    const content = path.join(fixtureRoot, 'Content')
    const projects = path.join(content, 'Projects')
    const res = path.join(projects, 'Res')
    const projectFile = path.join(res, 'project.xml')

    for (const source of [fixtureRoot, content, projects, res, projectFile]) {
      const located = await locateComposicaProject(source)
      expect(located.projectFile).toBe(projectFile)
      expect(located.projectRoot).toBe(res)
      expect(located.contentRoot).toBe(content)
      expect(located.courseRoot).toBe(fixtureRoot)
    }
  })
})

describe('legacy parsing helpers', () => {
  it('decodes Windows-1252 source bytes without corrupting punctuation', () => {
    const decoded = decodeLegacyBuffer(
      Buffer.concat([
        Buffer.from('<?xml version="1.0" encoding="windows-1252"?><x>'),
        Buffer.from([0x93]),
        Buffer.from('legacy'),
        Buffer.from([0x94]),
        Buffer.from('</x>')
      ])
    )

    expect(decoded.encoding).toBe('windows-1252')
    expect(decoded.text).toContain('“legacy”')
  })

  it('keeps semicolons inside CSS url values while extracting declarations', () => {
    expect(
      parseInlineStyle(
        "LEFT: 12px; background-image: url('data:image/svg+xml;a=b'); WIDTH: 20px"
      )
    ).toEqual({
      left: '12px',
      'background-image': "url('data:image/svg+xml;a=b')",
      width: '20px'
    })
  })

  it('preserves duplicate page references and recursive outline context', () => {
    const parsed = parseProjectXml(`
      <project title="Example">
        <structure>
          <chapter title="Unit" id="chapter/unit.html">
            <test title="Test" id="test/test.html">
              <section title="Bank" id="section/bank.html">
                <page title="First occurrence" id="page/shared.html" />
                <page title="Second occurrence" id="page/shared.html" />
              </section>
            </test>
          </chapter>
        </structure>
      </project>
    `)

    expect(parsed.pages).toHaveLength(2)
    expect(parsed.pages.map((page) => page.id)).toEqual([
      'page/shared.html',
      'page/shared.html'
    ])
    expect(parsed.pages[1].outlinePath).toEqual([
      'Unit',
      'Test',
      'Bank',
      'Second occurrence'
    ])
    expect(parsed.outline[0].children[0].children[0].children).toHaveLength(2)
  })
})

describe('analyzeComposicaCourse', () => {
  it('creates a passive, ordered model with objects, interactions, assets, and diagnostics', async () => {
    const model = await analyzeComposicaCourse(fixtureRoot)

    expect(model.settings).toMatchObject({
      id: 'SyntheticRes',
      title: 'Synthetic Migration Course',
      version: '1.2.3',
      width: 960,
      height: 540,
      persist: true,
      courseMode: 'exe'
    })
    expect(model.slides).toHaveLength(4)
    expect(new Set(model.slides.map((slide) => slide.id)).size).toBe(4)
    expect(model.slides.map((slide) => slide.index)).toEqual([0, 1, 2, 3])

    const sharedSlides = model.slides.filter(
      (slide) => slide.sourceRelativePath === 'page/shared.html'
    )
    expect(sharedSlides).toHaveLength(2)
    expect(sharedSlides[0].id).not.toBe(sharedSlides[1].id)
    expect(sharedSlides[1].outlinePath).toEqual([
      'Practice',
      'Synthetic Game',
      'Question bank',
      'Shared activity again'
    ])

    const intro = model.slides[0]
    const headline = intro.objects.find((object) => object.attributes.id === 'headline')
    expect(headline).toMatchObject({
      role: 'text',
      text: 'Welcome & learn',
      geometry: { left: 12, top: 18, width: 300, height: 44 },
      zIndex: 3
    })
    expect(intro.sourceHtml).toContain("Legacy scripts must never execute")

    const multipleChoice = intro.interactions.find(
      (interaction) => interaction.type === 'multiple-choice'
    )
    expect(multipleChoice?.prompt).toBe('Which answer is invented for this fixture?')
    expect(multipleChoice?.options.map((option) => option.correct)).toEqual([false, true])
    expect(multipleChoice?.answers).toEqual(['mcanswer-2-2'])
    expect(multipleChoice?.feedback).toMatchObject({
      correct: 'That is correct.',
      incorrect: 'Try a different answer.',
      retry: 'Try again'
    })
    expect(multipleChoice?.feedback.custom[0]).toMatchObject({
      condition: 'second attempt',
      text: 'A custom hint'
    })

    expect(sharedSlides[0].interactions.map((interaction) => interaction.type)).toEqual([
      'fill-blank',
      'drag-drop',
      'hotspot'
    ])
    expect(
      sharedSlides[0].interactions.find((interaction) => interaction.type === 'fill-blank')
        ?.answers
    ).toEqual(['Mercury'])
    expect(sharedSlides[0].kind).toBe('question')
    expect(sharedSlides[1].interactions.some((interaction) => interaction.type === 'game')).toBe(
      true
    )
    expect(sharedSlides[1].kind).toBe('game')

    const pictureAsset = model.assets.find(
      (asset) => asset.relativePath === 'Projects/Res/library/picture.svg'
    )
    expect(pictureAsset).toMatchObject({ kind: 'image', exists: true })
    expect(pictureAsset?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(pictureAsset?.usedBySlides).toContain(intro.id)
    expect(model.assets.some((asset) => asset.kind === 'flash')).toBe(true)

    expect(model.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FLASH_ASSETS_DETECTED' }),
        expect.objectContaining({ code: 'ASSET_REFERENCE_MISSING' }),
        expect.objectContaining({ code: 'PAGE_FILE_MISSING' })
      ])
    )
    expect(model.slides[3]).toMatchObject({ kind: 'unknown', sourceHtml: '' })
  })
})
