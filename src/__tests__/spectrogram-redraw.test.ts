import SpectrogramPlugin from '../plugins/spectrogram.js'
import { createFakeWaveSurfer } from './helpers/fake-wavesurfer.js'
import { createFakeAudioBuffer } from './helpers/audio-buffer.js'
import { createEmitter } from './helpers/create-emitter.js'

// Full rendering mode paints each canvas from ImageBitmaps, which createImageBitmap delivers
// asynchronously: the HTML spec resolves its promise from a queued task, so a frame can be painted
// before the bitmap is drawn. These tests hold every bitmap until the test delivers it, to see what
// is on screen while a redraw is in flight. jsdom has no 2D context, ImageData or createImageBitmap,
// so all three are stubbed.

type HeldBitmap = { close: jest.Mock; resolve: () => void; reject: () => void }

/** Bitmaps requested and not yet delivered, oldest first */
let held: HeldBitmap[]
const contexts = new Map<HTMLCanvasElement, Record<string, any>>()
const originalImageData = (globalThis as any).ImageData
const originalCreateImageBitmap = (globalThis as any).createImageBitmap
const plugins: any[] = []

beforeEach(() => {
  held = []
  contexts.clear()
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) {
      contexts.set(this, { canvas: this, fillStyle: '', fillRect: jest.fn(), drawImage: jest.fn(), scale: jest.fn() })
    }
    return contexts.get(this)
  } as any)
  ;(globalThis as any).ImageData = class {
    data: Uint8ClampedArray
    constructor(
      public width: number,
      public height: number,
    ) {
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  }
  ;(globalThis as any).createImageBitmap = jest.fn(
    () =>
      new Promise((resolve, reject) => {
        const bitmap = { close: jest.fn() }
        held.push({
          close: bitmap.close,
          resolve: () => resolve(bitmap),
          reject: () => reject(new Error('createImageBitmap failed')),
        })
      }),
  )
})

afterEach(() => {
  plugins.splice(0).forEach((plugin) => plugin.destroy())
  jest.useRealTimers()
  jest.restoreAllMocks()
  ;(globalThis as any).ImageData = originalImageData
  ;(globalThis as any).createImageBitmap = originalCreateImageBitmap
})

function createPlugin(
  options: Record<string, unknown> = {},
  { width = 600, clientWidth = 600, decoded = null as AudioBuffer | null } = {},
) {
  const emitter = createEmitter()
  const wrapper = document.createElement('div')
  const size = { width }
  Object.defineProperty(wrapper, 'offsetWidth', { get: () => size.width })
  Object.defineProperty(wrapper, 'clientWidth', { value: clientWidth })
  // The waveform's view, which full rendering's lazy path draws around
  const view = { scrollLeft: 0 }

  const plugin: any = SpectrogramPlugin.create({ scale: 'linear', ...options })
  plugin._init(
    createFakeWaveSurfer({
      on: emitter.on,
      getWrapper: () => wrapper,
      getDecodedData: () => decoded,
      getScroll: () => view.scrollLeft,
      getWidth: () => clientWidth,
    }),
  )
  plugins.push(plugin)
  const internals = plugin.__spectrogramInternalsForTests()
  // The sample rate the drawn frequency range is scaled against
  internals.buffer = createFakeAudioBuffer(new Float32Array(8000))

  return { plugin, internals, emitter, wrapper, size, view }
}

type Harness = ReturnType<typeof createPlugin>

/** [channel][frame][bin] frequency data */
function makeFrames(channels = 1): Uint8Array[][] {
  return Array.from({ length: channels }, () =>
    Array.from({ length: 4 }, (_, frame) => Uint8Array.from({ length: 8 }, (_, bin) => frame * 8 + bin)),
  )
}

/** Runs pending promise continuations without advancing any timer */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** Delivers the given bitmaps (by default every held one) and lets the draws waiting for them finish */
async function deliver(bitmaps: HeldBitmap[] = held.splice(0)): Promise<void> {
  bitmaps.forEach((bitmap) => bitmap.resolve())
  await flush()
}

function drawImageOf(canvas: HTMLCanvasElement): jest.Mock {
  return contexts.get(canvas)?.drawImage
}

/** The plugin's attached canvases are exactly `expected`: the same elements, in order */
function expectShown(h: Harness, expected: HTMLCanvasElement[]): void {
  const shown = Array.from(h.internals.canvasContainer.querySelectorAll('canvas'))
  expect(shown).toHaveLength(expected.length)
  shown.forEach((canvas, i) => expect(canvas).toBe(expected[i]))
}

describe('SpectrogramPlugin full rendering mode redraws', () => {
  it('keeps the previous canvas on screen until the new bitmap is drawn', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    const [previous] = h.internals.canvases
    expectShown(h, [previous])

    h.internals.drawSpectrogram(makeFrames())
    const [next] = h.internals.canvases
    await flush()

    // Pre-fix the previous canvas was removed at once and the new, still blank one attached
    expectShown(h, [previous])
    expect(drawImageOf(next)).not.toHaveBeenCalled()

    await deliver()

    expect(drawImageOf(next)).toHaveBeenCalledTimes(1)
    expectShown(h, [next])
  })

  it('replaces all canvases of a draw in one step, once each has its bitmap', async () => {
    // 600px in canvases of at most 250px: three canvases, all drawn up front
    const h = createPlugin({ maxCanvasWidth: 250 })
    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    const previous = h.internals.canvases.slice()
    expect(previous).toHaveLength(3)
    expectShown(h, previous)

    h.internals.drawSpectrogram(makeFrames())
    const next = h.internals.canvases.slice()
    const bitmaps = held.splice(0)
    expect(bitmaps).toHaveLength(3)

    await deliver(bitmaps.slice(0, 2))
    expectShown(h, previous)

    await deliver(bitmaps.slice(2))
    expectShown(h, next)
  })

  it('waits for the bitmap of every channel when channels are split', async () => {
    const h = createPlugin({ splitChannels: true })
    h.internals.drawSpectrogram(makeFrames(2))
    await deliver()
    const [previous] = h.internals.canvases

    h.internals.drawSpectrogram(makeFrames(2))
    const [next] = h.internals.canvases
    const [firstChannel, secondChannel] = held.splice(0)

    await deliver([firstChannel])
    expectShown(h, [previous])

    await deliver([secondChannel])
    expectShown(h, [next])
    expect(drawImageOf(next)).toHaveBeenCalledTimes(2)
  })

  it('never shows the canvases of a superseded redraw, and closes their bitmaps', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    const [shown] = h.internals.canvases

    h.internals.drawSpectrogram(makeFrames())
    const [superseded] = h.internals.canvases
    const [supersededBitmap] = held.splice(0)
    h.internals.drawSpectrogram(makeFrames())
    const [latest] = h.internals.canvases

    // The superseded draw's bitmap arrives first: the picture on screen stays
    await deliver([supersededBitmap])
    expectShown(h, [shown])
    expect(drawImageOf(superseded)).not.toHaveBeenCalled()
    expect(supersededBitmap.close).toHaveBeenCalled()

    await deliver()
    expectShown(h, [latest])
  })

  it('ignores a superseded bitmap that arrives after the latest draw is shown', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    const [superseded] = h.internals.canvases
    const [supersededBitmap] = held.splice(0)
    h.internals.drawSpectrogram(makeFrames())
    const [latest] = h.internals.canvases

    await deliver()
    expectShown(h, [latest])

    await deliver([supersededBitmap])
    expectShown(h, [latest])
    expect(superseded.parentNode).toBeNull()
    expect(drawImageOf(superseded)).not.toHaveBeenCalled()
    expect(supersededBitmap.close).toHaveBeenCalled()
  })

  it('still replaces the picture when a bitmap fails, without that channel', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    await deliver()

    h.internals.drawSpectrogram(makeFrames())
    const [next] = h.internals.canvases
    held.splice(0).forEach((bitmap) => bitmap.reject())
    await flush()

    expectShown(h, [next])
    expect(drawImageOf(next)).not.toHaveBeenCalled()
  })

  it('removes the shown and the pending canvases at once when a redraw has nothing to draw', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    h.internals.drawSpectrogram(makeFrames())
    const [pending] = h.internals.canvases

    h.internals.drawSpectrogram([])
    expectShown(h, [])

    await deliver()
    expectShown(h, [])
    expect(pending.parentNode).toBeNull()
  })

  it('leaves no canvas behind when destroyed during a redraw, and closes the pending bitmaps', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    h.internals.drawSpectrogram(makeFrames())
    const [pending] = h.internals.canvases
    const bitmaps = held.splice(0)

    h.plugin.destroy()
    expectShown(h, [])

    await deliver(bitmaps)
    expectShown(h, [])
    expect(pending.parentNode).toBeNull()
    expect(drawImageOf(pending)).not.toHaveBeenCalled()
    bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalled())
  })

  it('leaves no canvas behind when destroyed before the first draw is painted', async () => {
    const h = createPlugin()
    h.internals.drawSpectrogram(makeFrames())
    const [pending] = h.internals.canvases
    const bitmaps = held.splice(0)

    h.plugin.destroy()
    await deliver(bitmaps)

    expectShown(h, [])
    expect(pending.parentNode).toBeNull()
    bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalled())
  })

  it('adds canvases drawn on scroll to a pending replacement, and shows later ones once painted', async () => {
    jest.useFakeTimers()
    // 6000px wide in a 600px viewport: six 1000px canvases, each drawn once near the viewport
    const h = createPlugin({ maxCanvasWidth: 1000 }, { width: 6000, clientWidth: 600 })
    const scrollTo = (x: number) => {
      h.view.scrollLeft = x
      h.emitter.emit('scroll')
      jest.advanceTimersByTime(16)
    }

    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    // The viewport and half its width on either side, 0 to 900px: canvas 0
    const previous = h.internals.canvases.slice()
    expect(previous).toHaveLength(1)
    expectShown(h, previous)

    h.internals.drawSpectrogram(makeFrames())
    // Scrolled before the new bitmaps arrive, to 1200 to 2400px: canvases 1 and 2 join the replacement
    scrollTo(1500)
    const next = h.internals.canvases.slice()
    expect(next).toHaveLength(3)
    const bitmaps = held.splice(0)

    await deliver(bitmaps.slice(0, 2))
    expectShown(h, previous)

    await deliver(bitmaps.slice(2))
    expectShown(h, next)

    // Nothing is left to replace: a canvas drawn on scroll is shown as soon as it is painted.
    // 3200 to 4400px: canvases 3 and 4
    scrollTo(3500)
    const [fourth, fifth] = h.internals.canvases.slice(3)
    const [fourthBitmap, fifthBitmap] = held.splice(0)

    await deliver([fourthBitmap])
    expectShown(h, [...next, fourth])

    await deliver([fifthBitmap])
    expectShown(h, [...next, fourth, fifth])
  })

  it('keeps the picture on screen through the redraw that follows a resize', async () => {
    jest.useFakeTimers()
    const decoded = createFakeAudioBuffer(Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i)))
    const h = createPlugin({}, { decoded })

    // The initial render: the 0 ms init tick, then the 50 ms render throttle
    jest.advanceTimersByTime(50)
    await flush()
    await deliver()
    const [previous] = h.internals.canvases
    expectShown(h, [previous])

    // A wider container redraws from the retained frequency data
    h.size.width = 800
    h.emitter.emit('redraw')
    jest.advanceTimersByTime(50)
    const [next] = h.internals.canvases
    expect(next.style.width).toBe('800px')
    expectShown(h, [previous])

    await deliver()
    expectShown(h, [next])
  })

  it('puts a redraw on screen when trimming removes the only canvas still painting', async () => {
    jest.useFakeTimers()
    // 100px canvases and an 800px view: at 400px the view and half its width either side need
    // canvases 0 to 15
    const h = createPlugin({ maxCanvasWidth: 100 }, { width: 3000, clientWidth: 800 })
    h.view.scrollLeft = 400
    h.internals.drawSpectrogram(makeFrames())
    await deliver()
    const previous = h.internals.canvases.slice()
    expect(previous).toHaveLength(16)

    h.internals.drawSpectrogram(makeFrames())
    const next = h.internals.canvases.slice()
    // Every new canvas but the last is painted: the earlier picture stays on screen
    await deliver(held.splice(0).slice(0, -1))
    expectShown(h, previous)

    // Back at the start only canvases 0 to 11 are needed. Trimming removes 12 to 15, the one still
    // painting among them, which leaves nothing to wait for
    h.view.scrollLeft = 0
    h.emitter.emit('scroll')
    jest.advanceTimersByTime(16)
    expectShown(h, next.slice(0, 12))
  })

  it.each([
    ['nothing to draw', (h: Harness) => h.internals.drawSpectrogram([])],
    [
      'a zero width',
      (h: Harness) => {
        h.size.width = 0
        h.internals.drawSpectrogram(makeFrames())
      },
    ],
  ])('draws nothing on scroll after a redraw with %s clears the picture', async (_, clear) => {
    jest.useFakeTimers()
    const h = createPlugin({ maxCanvasWidth: 1000 }, { width: 6000, clientWidth: 600 })
    h.internals.drawSpectrogram(makeFrames())
    await deliver()

    // A draw is due in 16 ms when the picture is cleared
    h.view.scrollLeft = 3000
    h.emitter.emit('scroll')
    clear(h)
    expectShown(h, [])
    const createImageBitmap = (globalThis as any).createImageBitmap as jest.Mock
    const requested = createImageBitmap.mock.calls.length

    jest.advanceTimersByTime(16)
    h.emitter.emit('scroll')
    jest.advanceTimersByTime(16)
    await deliver()

    expect(createImageBitmap.mock.calls.length).toBe(requested)
    expectShown(h, [])
  })

  it('reports ready once the canvases of a draw are painted and on screen', async () => {
    const h = createPlugin()
    const shownAtReady: number[] = []
    h.plugin.on('ready', () => shownAtReady.push(h.internals.canvasContainer.querySelectorAll('canvas').length))
    const beforeReady = jest.fn()

    h.internals.drawSpectrogram(makeFrames(), beforeReady)
    await flush()
    expect(beforeReady).not.toHaveBeenCalled()
    expect(shownAtReady).toEqual([])

    await deliver()
    expect(beforeReady).toHaveBeenCalledTimes(1)
    expect(shownAtReady).toEqual([1])
  })

  it('reports ready only for the latest of overlapping draws', async () => {
    const h = createPlugin()
    const ready = jest.fn()
    h.plugin.on('ready', ready)
    const first = jest.fn()
    const second = jest.fn()

    h.internals.drawSpectrogram(makeFrames(), first)
    h.internals.drawSpectrogram(makeFrames(), second)
    await deliver()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('settles setOptions() once the redraw it asked for is on screen', async () => {
    jest.useFakeTimers()
    const decoded = createFakeAudioBuffer(Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i)))
    const h = createPlugin({}, { decoded })
    jest.advanceTimersByTime(50)
    await flush()
    await deliver()
    const [previous] = h.internals.canvases

    let settled = false
    const done = h.plugin.setOptions({ height: 300 }).then(() => (settled = true))
    // If an expectation fails first, destroying the plugin rejects this: keep that from going unhandled
    done.catch(() => undefined)
    // A display change redraws from the retained data on the next frame
    jest.advanceTimersByTime(20)
    await flush()
    const [next] = h.internals.canvases
    expect(next).not.toBe(previous)
    expect(settled).toBe(false)
    expectShown(h, [previous])

    await deliver()
    await done
    expectShown(h, [next])
  })

  it('draws a display change made while the first draw is still being painted', async () => {
    jest.useFakeTimers()
    const decoded = createFakeAudioBuffer(Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i)))
    const h = createPlugin({}, { decoded })
    // The initial render has finished; its bitmaps are still being drawn
    jest.advanceTimersByTime(50)
    await flush()
    expect(held.length).toBeGreaterThan(0)
    const [first] = h.internals.canvases

    let settled = false
    const done = h.plugin.setOptions({ height: 300 }).then(() => (settled = true))
    // If an expectation fails first, destroying the plugin rejects this: keep that from going unhandled
    done.catch(() => undefined)
    await deliver()
    expectShown(h, [first])

    // Once the first picture is on screen, the change is drawn on the next frame
    jest.advanceTimersByTime(20)
    await flush()
    const [next] = h.internals.canvases
    expect(next).not.toBe(first)
    expect(next.style.height).toBe('300px')
    expect(settled).toBe(false)

    await deliver()
    await done
    expectShown(h, [next])
  })
})
