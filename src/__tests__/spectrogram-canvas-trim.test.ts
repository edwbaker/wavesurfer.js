import Spectrogram from '../plugins/spectrogram.js'
import { createFakeWaveSurfer } from './helpers/fake-wavesurfer.js'

// Full rendering draws a long spectrogram lazily: the canvases in view plus half a view on either
// side. Once more than MAX_NODES canvases would be kept, the ones farthest out of view are removed.
// jsdom does no layout, so the wavesurfer wrapper's widths and scroll position are stubbed
const MAX_NODES = 10
const VIEW_WIDTH = 800
const CANVAS_WIDTH = 1000
// 24 canvases, the last one only 50px wide
const TOTAL_WIDTH = 23 * CANVAS_WIDTH + 50

function makeFrequencies(): Uint8Array[][] {
  return [Array.from({ length: 8 }, () => new Uint8Array(16).fill(100))]
}

/** Runs pending promise continuations without advancing any timer */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// The canvases a bitmap was drawn on
const painted = new Set<HTMLCanvasElement>()
let createImageBitmapMock: jest.Mock
const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalImageData = (globalThis as any).ImageData
const originalCreateImageBitmap = (globalThis as any).createImageBitmap
const plugins: any[] = []

beforeEach(() => {
  jest.useFakeTimers()
  painted.clear()

  // jsdom has no 2D context, ImageData or createImageBitmap: stub enough for real draws. Each
  // canvas gets its own context, with the canvas it belongs to, as in a browser
  const contexts = new WeakMap<HTMLCanvasElement, Record<string, unknown>>()
  HTMLCanvasElement.prototype.getContext = jest.fn(function (this: HTMLCanvasElement) {
    const canvas = this
    if (!contexts.has(canvas)) {
      contexts.set(canvas, {
        canvas,
        fillStyle: '',
        fillRect: jest.fn(),
        scale: jest.fn(),
        drawImage: () => painted.add(canvas),
      })
    }
    return contexts.get(canvas)
  }) as any
  ;(globalThis as any).ImageData = class {
    data: Uint8ClampedArray
    constructor(
      public width: number,
      public height: number,
    ) {
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  }
  createImageBitmapMock = jest.fn(() => Promise.resolve({ close: jest.fn() }))
  ;(globalThis as any).createImageBitmap = createImageBitmapMock
})

afterEach(() => {
  plugins.splice(0).forEach((plugin) => plugin.destroy())
  jest.useRealTimers()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  ;(globalThis as any).ImageData = originalImageData
  ;(globalThis as any).createImageBitmap = originalCreateImageBitmap
})

function createPlugin({ totalWidth = TOTAL_WIDTH, canvasWidth = CANVAS_WIDTH } = {}) {
  // The wrapper the plugin reads its sizes, scroll position and scroll events from
  const wrapper = document.createElement('div')
  let scrollLeft = 0
  Object.defineProperty(wrapper, 'offsetWidth', { value: totalWidth })
  Object.defineProperty(wrapper, 'clientWidth', { value: VIEW_WIDTH })
  Object.defineProperty(wrapper, 'scrollLeft', { get: () => scrollLeft })

  const plugin: any = Spectrogram.create({ maxCanvasWidth: canvasWidth, sampleRate: 8000 })
  plugin._init(createFakeWaveSurfer({ getWrapper: () => wrapper }))
  plugins.push(plugin)
  const internals = plugin.__spectrogramInternalsForTests()
  const numCanvases = Math.ceil(totalWidth / canvasWidth)
  const indexOf = (canvas: HTMLCanvasElement) => Math.round(parseFloat(canvas.style.left) / canvasWidth)

  return {
    internals,
    numCanvases,
    indexOf,
    async draw() {
      internals.drawSpectrogram(makeFrequencies())
      await flush()
    },
    /** Scrolls to x, then lets the plugin's 16 ms scroll timer draw */
    async scrollTo(x: number) {
      scrollLeft = x
      wrapper.dispatchEvent(new Event('scroll'))
      jest.advanceTimersByTime(16)
      await flush()
    },
    /** The canvases on screen, by the index each was drawn for */
    onScreen(): Map<number, HTMLCanvasElement> {
      const canvases = Array.from(internals.canvasContainer.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const byIndex = new Map(canvases.map((canvas) => [indexOf(canvas), canvas]))
      // One canvas per index
      expect(byIndex.size).toBe(canvases.length)
      return byIndex
    },
    /** Indexes of the canvases overlapping [from, to) */
    indexesIn(from: number, to: number): number[] {
      const first = Math.max(0, Math.floor(from / canvasWidth))
      const last = Math.min(numCanvases - 1, Math.ceil(to / canvasWidth) - 1)
      return Array.from({ length: last - first + 1 }, (_, i) => first + i)
    },
  }
}

type Harness = ReturnType<typeof createPlugin>

/** canvases, drawnCanvases and the DOM all hold the same canvases */
function expectConsistent(h: Harness): void {
  const kept = (h.internals.canvases as HTMLCanvasElement[]).map(h.indexOf).sort((a, b) => a - b)
  const drawn = Object.keys(h.internals.drawnCanvases)
    .map(Number)
    .sort((a, b) => a - b)
  expect(drawn).toEqual(kept)
  expect([...h.onScreen().keys()].sort((a, b) => a - b)).toEqual(kept)
}

/**
 * Scrolls to each position in turn and checks that the canvases in view are on screen, that a
 * canvas already on screen there is not replaced, that every canvas removed was outside the range
 * drawn around the view, and that at most `limit` canvases are kept. Returns how many were removed
 */
async function scrollThrough(h: Harness, positions: number[], limit = MAX_NODES): Promise<number> {
  let removed = 0
  for (const x of positions) {
    const before = h.onScreen()
    await h.scrollTo(x)
    const after = h.onScreen()

    for (const index of h.indexesIn(x, x + VIEW_WIDTH)) {
      expect(after.get(index)).toBeDefined()
      if (before.has(index)) expect(after.get(index)).toBe(before.get(index))
    }

    const drawnRange = h.indexesIn(x - VIEW_WIDTH / 2, x + VIEW_WIDTH * 1.5)
    before.forEach((canvas, index) => {
      if (after.get(index) === canvas) return
      removed++
      expect(canvas.parentNode).toBeNull()
      expect(drawnRange).not.toContain(index)
    })

    expect(after.size).toBeLessThanOrEqual(limit)
    expectConsistent(h)
  }
  return removed
}

/** Scroll positions from `from` to `to`, `step` px apart, both ends included */
function positions(from: number, to: number, step: number): number[] {
  const result: number[] = []
  const direction = Math.sign(to - from)
  for (let x = from; direction * (to - x) > 0; x += direction * step) result.push(x)
  result.push(to)
  return result
}

const END = TOTAL_WIDTH - VIEW_WIDTH

describe('full-mode spectrogram canvas trimming', () => {
  it('draws the start lazily, as a scrollable spectrogram with more than 10 canvases', async () => {
    const h = createPlugin()
    await h.draw()

    expect(h.numCanvases).toBe(24)
    expect([...h.onScreen().keys()].sort((a, b) => a - b)).toEqual([0, 1, 2])
    expectConsistent(h)
  })

  it('keeps the canvases in view on screen while scrolling, removing only canvases out of view', async () => {
    const h = createPlugin()
    await h.draw()

    const removed = await scrollThrough(h, positions(0, END, 200))

    // 24 canvases were drawn on the way and at most 10 kept
    expect(removed).toBe(14)
  })

  it('removes the canvases farthest from view first', async () => {
    const h = createPlugin()
    await h.draw()

    await scrollThrough(h, positions(0, END, 200))

    // The range drawn at the end (canvases 21 to 23) and the 7 canvases nearest to it
    expect([...h.onScreen().keys()].sort((a, b) => a - b)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
  })

  it('draws removed canvases again when scrolling back', async () => {
    const h = createPlugin()
    await h.draw()
    const first = h.onScreen().get(0) as HTMLCanvasElement

    await scrollThrough(h, positions(0, END, 400))
    expect(first.parentNode).toBeNull()

    await scrollThrough(h, positions(END, 0, 400))

    const again = h.onScreen().get(0)
    expect(again).toBeDefined()
    expect(again).not.toBe(first)
  })

  it('keeps the canvases in view after a jump, including one next to a narrow last canvas', async () => {
    const h = createPlugin()
    await h.draw()

    // The view starts 800px into canvas 20, whose last 200px are in view
    await scrollThrough(h, [20800, 0, 12345, 22250, 20800])

    expect(h.onScreen().has(20)).toBe(true)
  })

  it('keeps the whole range drawn around the view when it alone needs more than 10 canvases', async () => {
    // 100px canvases: the view and half a view on either side span 16 of them, and the range
    // drawn around that up to 18
    const h = createPlugin({ totalWidth: 30000, canvasWidth: 100 })
    await h.draw()

    const removed = await scrollThrough(h, positions(0, 6000, 50), 18)

    expect(removed).toBeGreaterThan(0)
  })

  it('never puts back a canvas removed before its bitmap was drawn', async () => {
    // Bitmaps resolve only when the test says so
    const pending: Array<() => void> = []
    createImageBitmapMock.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve({ close: jest.fn() }))),
    )
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrequencies())
    const created = new Set<HTMLCanvasElement>(h.internals.canvases)

    for (const x of positions(0, END, 400)) {
      await h.scrollTo(x)
      ;(h.internals.canvases as HTMLCanvasElement[]).forEach((canvas) => created.add(canvas))
    }
    const kept = new Set<HTMLCanvasElement>(h.internals.canvases)
    expect(created.size).toBe(24)
    expect(kept.size).toBe(MAX_NODES)

    pending.splice(0).forEach((resolve) => resolve())
    await flush()

    // Only the kept canvases are painted and on screen
    expect(painted).toEqual(kept)
    expect(new Set(h.onScreen().values())).toEqual(kept)
    expectConsistent(h)
  })
})
