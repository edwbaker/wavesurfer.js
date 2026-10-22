import SpectrogramPlugin from '../plugins/spectrogram.js'
import { createEmitter } from './helpers/create-emitter.js'

// Windowed rendering draws the segments around the waveform's view when the waveform scrolls
// ('scroll') or plays ('timeupdate'). Both come every frame while scrolling continuously, or while
// playing with autoScroll: 8 ms apart on a 120 Hz display. A draw that is due must not be pushed
// back by the events after it, or nothing new is drawn until they stop
const FRAME_MS = 8

let plugin: any = null

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  plugin?.destroy()
  plugin = null
  jest.useRealTimers()
})

function setup() {
  // As in a page, the spectrogram sits in the waveform's full-width wrapper, inside the scroll
  // container whose scrollLeft is the view
  const scrollContainer = document.createElement('div')
  const wrapper = document.createElement('div')
  scrollContainer.appendChild(wrapper)
  let scrollLeft = 0
  Object.defineProperty(scrollContainer, 'scrollLeft', { get: () => scrollLeft })

  const wavesurfer = { options: {}, getWrapper: () => wrapper, getDecodedData: () => null, ...createEmitter() }
  plugin = SpectrogramPlugin.create({ rendering: 'windowed' })
  plugin._init(wavesurfer)

  // Each draw of the view: when it ran (ms since setup), and where the view was by then
  const start = Date.now()
  const draws: Array<{ time: number; scrollLeft: number }> = []
  const { segmentManager } = plugin.__spectrogramInternalsForTests().windowed
  jest.spyOn(segmentManager, 'renderVisibleWindow').mockImplementation(async () => {
    draws.push({ time: Date.now() - start, scrollLeft: scrollContainer.scrollLeft })
  })

  return {
    draws,
    /** One frame: a playback tick if playing, the view scrolled to `x`, then the frame's 8 ms */
    frame(x: number, { playing = false } = {}) {
      if (playing) wavesurfer.emit('timeupdate')
      scrollLeft = x
      wavesurfer.emit('scroll')
      jest.advanceTimersByTime(FRAME_MS)
    },
  }
}

/** Every 16 ms up to `until` */
function every16ms(until: number): number[] {
  return Array.from({ length: until / 16 }, (_, i) => (i + 1) * 16)
}

describe('windowed spectrogram drawing while the waveform scrolls', () => {
  it('keeps drawing while scroll events come every 8 ms', () => {
    const h = setup()

    // 60px every 8 ms for half a second, as when scrolling continuously on a 120 Hz display
    for (let frame = 1; frame <= 64; frame++) h.frame(frame * 60)

    // A draw every 16 ms, and no more often. Each draw reads the view when it runs, where the frame
    // before it left the view
    expect(h.draws.map((draw) => draw.time)).toEqual(every16ms(512))
    expect(h.draws.map((draw) => draw.scrollLeft)).toEqual(every16ms(512).map((time) => (time / FRAME_MS) * 60))
  })

  it('keeps drawing while playing with autoScroll', () => {
    const h = setup()

    // Each frame, a playback tick, then autoScroll moves the view
    for (let frame = 1; frame <= 64; frame++) h.frame(frame * 60, { playing: true })

    expect(h.draws.map((draw) => draw.time)).toEqual(every16ms(512))
  })

  it.each([
    ['while a draw is due', 6],
    ['just after a draw', 7],
  ])('draws the view where the scrolling stopped, when the last scroll event comes %s', (_, frames) => {
    const h = setup()
    for (let frame = 1; frame <= frames; frame++) h.frame(frame * 60)

    // Drawn within 16 ms of the last scroll event, and not again after that
    jest.advanceTimersByTime(16 - FRAME_MS)
    expect(h.draws.at(-1)?.scrollLeft).toBe(frames * 60)
    const drawCount = h.draws.length
    jest.advanceTimersByTime(1000)
    expect(h.draws.length).toBe(drawCount)
  })
})
