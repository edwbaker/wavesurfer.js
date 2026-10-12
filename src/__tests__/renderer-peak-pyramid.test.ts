/**
 * With `peakPyramid` on, a waveform zoomed out far enough is drawn from a summary of the audio (the largest
 * sample in each run of samples) in place of every sample. These check that it draws what it draws from the
 * samples where the runs line up with the columns, and a peak within half a column of where it was where they
 * do not, that nothing changes when the option is off or the waveform is zoomed in, and that the summary is made
 * only when it is needed.
 */

jest.mock('../peak-pyramid.js', () => {
  const actual = jest.requireActual('../peak-pyramid.js')
  return { ...actual, PeakPyramid: jest.fn((...args: unknown[]) => new actual.PeakPyramid(...args)) }
})

import Renderer from '../renderer.js'
import { MIN_SAMPLES_PER_COLUMN, PeakPyramid } from '../peak-pyramid.js'
import type { ChannelData } from '../renderer-utils.js'
import type { WaveSurferOptions } from '../wavesurfer.js'

const pyramidSpy = PeakPyramid as unknown as jest.Mock
const levelForSpy = jest.spyOn(jest.requireActual('../peak-pyramid.js').PeakPyramid.prototype, 'levelFor')

// A channel of its own amplitude and pitch, so that mixing two channels up shows
// (made once, as it is slow to make and none of the tests writes to it)
const made = new Map<string, Float32Array>()
const audio = (channelCount: number, length: number): Float32Array[] =>
  Array.from({ length: channelCount }, (_, c) => {
    const key = `${c}:${length}`
    let channel = made.get(key)
    if (!channel) {
      channel = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        channel[i] =
          Math.sin(i / (7 + c)) * (0.2 + 0.1 * c) * (1 - (i % 97) / 200) * (0.3 + Math.abs(Math.sin(i / 90001)))
      }
      made.set(key, channel)
    }
    return channel
  })

// Like a real AudioBuffer, it hands out the same array for a channel each time
const createAudioBuffer = (channels: Float32Array[], duration = 1): AudioBuffer =>
  ({
    duration,
    length: channels[0].length,
    sampleRate: channels[0].length / duration,
    numberOfChannels: channels.length,
    getChannelData: (i: number) => channels[i],
    copyFromChannel: jest.fn(),
    copyToChannel: jest.fn(),
  }) as unknown as AudioBuffer

describe('Renderer with a peak pyramid', () => {
  const originalGetContext = window.HTMLCanvasElement.prototype.getContext

  // Every call made on every canvas, in order, with the size each canvas was drawn at
  type Call = [canvas: number, what: string, ...args: unknown[]]
  let log: Call[] = []
  let canvasCount = 0

  beforeAll(() => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, writable: true })
    window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      const id = canvasCount++
      log.push([id, 'canvas', this.width, this.height])
      const record =
        (what: string) =>
        (...args: unknown[]) => {
          log.push([id, what, ...args])
        }
      return {
        beginPath: record('beginPath'),
        rect: record('rect'),
        roundRect: record('roundRect'),
        moveTo: record('moveTo'),
        lineTo: record('lineTo'),
        closePath: record('closePath'),
        fill: record('fill'),
        fillRect: record('fillRect'),
        drawImage: () => log.push([id, 'drawImage']),
        createLinearGradient: () => ({ addColorStop: jest.fn() }),
        globalCompositeOperation: '',
        canvas: this,
      }
    } as never
  })

  afterAll(() => {
    window.HTMLCanvasElement.prototype.getContext = originalGetContext
  })

  beforeEach(() => {
    pyramidSpy.mockClear()
    levelForSpy.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  // jsdom performs no layout, so the scroll area is given a width for the canvases to be planned against
  const create = (options: Partial<WaveSurferOptions>, clientWidth: number) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const renderer = new Renderer({ container, fillParent: true, height: 40, ...options })
    const scrollContainer = (renderer as unknown as { scrollContainer: HTMLElement }).scrollContainer
    Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: clientWidth })
    return renderer
  }

  // Set options of a renderer that is drawn, changing only those given
  const setOptions = (renderer: Renderer, patch: Partial<WaveSurferOptions>) =>
    renderer.setOptions({ ...(renderer as unknown as { options: WaveSurferOptions }).options, ...patch })

  const drawn = async (renderer: Renderer, channels: Float32Array[]) => {
    log = []
    canvasCount = 0
    await renderer.render(createAudioBuffer(channels))
    return log
  }

  const draw = async (channels: Float32Array[], options: Partial<WaveSurferOptions>, clientWidth = 128) => {
    const renderer = create(options, clientWidth)
    const result = await drawn(renderer, channels)
    renderer.destroy()
    return result
  }

  // 2^19 samples in 128 columns: a column holds 4096, and a bar of 3 and a gap of 1 holds 16384, so that
  // the runs of the levels line up with the columns
  const SAMPLES = 2 ** 19

  describe('where the runs of samples line up with the columns', () => {
    const layouts: Array<[string, number, Partial<WaveSurferOptions>]> = [
      ['mono, a line', 1, {}],
      ['stereo, a line', 2, {}],
      ['stereo, bars', 2, { barWidth: 3, barGap: 1 }],
      ['stereo, bars with a gap of their width', 2, { barWidth: 4, barGap: 4 }],
      ['stereo, normalized', 2, { normalize: true }],
      ['stereo, each channel on its own canvas', 2, { splitChannels: [] }],
      ['four channels, of which two are drawn', 4, {}],
      ['four channels, each on its own canvas, normalized', 4, { splitChannels: [], normalize: true }],
      ['stereo, with the maximum peak given', 2, { normalize: true, maxPeak: 0.9 }],
      ['stereo, wider than the screen, so scrolled', 2, { minPxPerSec: 256 }],
    ]

    test.each(layouts)('%s draws what it draws from the samples', async (_name, channelCount, options) => {
      const channels = audio(channelCount, SAMPLES)
      const fromSamples = await draw(channels, options)
      const fromPyramid = await draw(channels, { ...options, peakPyramid: true })

      expect(fromSamples.length).toBeGreaterThan(0)
      expect(fromPyramid).toEqual(fromSamples)
      expect(levelForSpy).toHaveBeenCalled()
      // and what was drawn was a level, not the samples
      expect(levelForSpy.mock.results.some((result) => result.value !== null)).toBe(true)
    })
  })

  describe('where the waveform is zoomed in', () => {
    // 156 samples in a column of a line, and 703 in a bar and its gap: both short of the 1024 a level is drawn for
    test.each([
      ['a line', {}],
      ['bars', { barWidth: 3, barGap: 1 }],
    ])('draws the samples, as %s, and makes no pyramid', async (_name, options) => {
      const channels = audio(2, 20_000)
      const fromSamples = await draw(channels, options)
      const fromPyramid = await draw(channels, { ...options, peakPyramid: true })

      expect(fromPyramid).toEqual(fromSamples)
      expect(pyramidSpy).not.toHaveBeenCalled()
    })

    test('does not draw a level of fewer samples in a column than the pyramid is for', async () => {
      // 1000 samples in each of 128 columns, short of the 1024 a level is drawn for
      const channels = audio(1, 128 * 1000)
      await draw(channels, { peakPyramid: true, normalize: false })
      expect(1000).toBeLessThan(MIN_SAMPLES_PER_COLUMN)
      expect(pyramidSpy).not.toHaveBeenCalled()
      expect(levelForSpy).not.toHaveBeenCalled()
    })

    test('normalize takes its peak from the pyramid, and draws what it did from the samples', async () => {
      const channels = audio(2, 20_000)
      const fromSamples = await draw(channels, { normalize: true })
      const fromPyramid = await draw(channels, { normalize: true, peakPyramid: true })

      expect(fromPyramid).toEqual(fromSamples)
      expect(pyramidSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('when it is off', () => {
    test.each([undefined, false])(
      'draws the samples, and makes no pyramid, for peakPyramid: %s',
      async (peakPyramid) => {
        const channels = audio(2, SAMPLES)
        const reference = await draw(channels, {})
        expect(await draw(channels, { peakPyramid })).toEqual(reference)
        expect(pyramidSpy).not.toHaveBeenCalled()
      },
    )

    test('can be turned on, and off again, for a waveform that is drawn', async () => {
      const channels = audio(2, SAMPLES)
      const renderer = create({}, 128)
      const before = await drawn(renderer, channels)
      expect(pyramidSpy).not.toHaveBeenCalled()

      log = []
      canvasCount = 0
      setOptions(renderer, { peakPyramid: true })
      expect(pyramidSpy).toHaveBeenCalledTimes(2)
      expect(levelForSpy.mock.results.some((result) => result.value !== null)).toBe(true)
      expect(log).toEqual(before)

      levelForSpy.mockClear()
      setOptions(renderer, { peakPyramid: false })
      expect(levelForSpy).not.toHaveBeenCalled()
      renderer.destroy()
    })
  })

  describe('a custom renderFunction', () => {
    test('is given the samples, never a level', async () => {
      const channels = audio(2, SAMPLES)
      const given: number[] = []
      const renderFunction = jest.fn((peaks: ChannelData) => given.push(peaks[0].length))

      await draw(channels, { renderFunction, peakPyramid: true })

      expect(renderFunction).toHaveBeenCalled()
      expect(given.reduce((total, length) => total + length, 0)).toBe(SAMPLES)
      expect(pyramidSpy).not.toHaveBeenCalled()
    })

    test('with channels split, only the channel that has one is given the samples', async () => {
      const channels = audio(2, SAMPLES)
      const given: number[] = []
      const renderFunction = jest.fn((peaks: ChannelData) => given.push(peaks[0].length))

      await draw(channels, { peakPyramid: true, splitChannels: [{ renderFunction }, {}] })

      expect(given.reduce((total, length) => total + length, 0)).toBe(SAMPLES)
      // the other channel was drawn from a level
      expect(pyramidSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('the pyramid', () => {
    test('is made once for the audio, however it is zoomed', async () => {
      const channels = audio(2, SAMPLES)
      const renderer = create({ peakPyramid: true }, 128)

      await drawn(renderer, channels)
      expect(pyramidSpy).toHaveBeenCalledTimes(2)

      // the same audio again, as bars and then at another width, each from a level of its own
      setOptions(renderer, { barWidth: 3 })
      setOptions(renderer, { barWidth: undefined, minPxPerSec: 256 })
      expect(levelForSpy.mock.results.filter((result) => result.value !== null).length).toBeGreaterThanOrEqual(4)
      expect(new Set(levelForSpy.mock.results.map((result) => result.value?.length)).size).toBeGreaterThan(1)
      expect(pyramidSpy).toHaveBeenCalledTimes(2)

      renderer.destroy()
    })

    test('is made again for new audio, which is drawn from its own levels', async () => {
      const first = audio(2, SAMPLES)
      const second = audio(2, SAMPLES).map((channel) => channel.map((sample) => sample * -0.5))
      const renderer = create({ peakPyramid: true }, 128)
      const plain = create({}, 128)

      await drawn(renderer, first)
      const fromPyramid = await drawn(renderer, second)
      const fromSamples = await drawn(plain, second)

      expect(pyramidSpy).toHaveBeenCalledTimes(4)
      expect(fromPyramid).toEqual(fromSamples)
      renderer.destroy()
      plain.destroy()
    })

    test('is made again when the channel it was made from has changed length', async () => {
      const channels = audio(1, SAMPLES)
      const renderer = create({ peakPyramid: true }, 128)
      const buffer = createAudioBuffer(channels)

      await renderer.render(buffer)
      expect(pyramidSpy).toHaveBeenCalledTimes(1)
      channels[0] = audio(1, SAMPLES / 2)[0]
      await renderer.render(buffer)
      expect(pyramidSpy).toHaveBeenCalledTimes(2)
      renderer.destroy()
    })
  })

  describe('where the runs of samples do not line up with the columns', () => {
    const LENGTH = 300_000
    const WIDTH = 80

    // One peak in silence, and which column it is drawn in
    const columnOfPeak = (calls: Call[]): number => {
      const half = 20 // the middle of a waveform 40 high
      let column = -1
      let tallest = 1 // every column is drawn at least one high, so a peak is what is taller than that
      for (const [, what, x, y] of calls) {
        if (what !== 'lineTo') continue
        const height = Math.abs((y as number) - half)
        if (height > tallest) {
          tallest = height
          column = x as number
        }
      }
      return column
    }

    // A peak is drawn at the start of its bucket, up to one bucket before where its sample is, and the last
    // bucket is drawn whole although it is short, which stretches the level by up to one bucket more. Buckets are
    // at most a quarter of a column, so a peak is drawn within half a column of where the sample is.
    describe.each([
      [LENGTH, WIDTH, 512],
      // one sample into its last bucket: the level is stretched by nearly a whole bucket
      [808 * 256 + 1, 200, 256],
    ])('%i samples in %i columns, drawn from buckets of %i', (length, width, bucket) => {
      const samplesPerColumn = length / width
      const edge = (c: number) => (c + 0.5) * samplesPerColumn // where drawing the samples starts column c + 1

      test('draws a peak in the column it is in, or the next to it, and in the same one far from an edge', async () => {
        const channel = new Float32Array(length)
        const withPyramid = create({ peakPyramid: true }, width)
        const withSamples = create({}, width)

        // beside the edges of the columns, in the last, short bucket and just before it, and on a spread of
        // places over the whole of the audio
        const places: number[] = []
        for (const c of [2, Math.floor(width / 4), Math.floor(width / 2), width - 3]) {
          for (const d of [-700, -300, -10, 0, 10, 300, 700]) places.push(Math.floor(edge(c)) + d)
        }
        for (const d of [0, 1, 50, 300, 700]) places.push(length - 1 - d)
        for (let k = 0; k < 30; k++) places.push(Math.floor(((k * 0.6180339887) % 1) * (length - 1)))

        let differing = 0
        for (const place of places) {
          channel[place] = 1
          const [onSamples, onPyramid] = [
            columnOfPeak(await drawn(withSamples, [channel])),
            columnOfPeak(await drawn(withPyramid, [channel])),
          ]
          channel[place] = 0

          if (onSamples === -1) {
            // Drawing the samples leaves out those in the last half column, as it always has; a level can draw a
            // bucket of them, in the last column
            expect(onPyramid === -1 || onPyramid === width - 1).toBe(true)
            continue
          }
          expect(Math.abs(onPyramid - onSamples)).toBeLessThanOrEqual(1)
          // two buckets is the furthest a peak is drawn from its sample, so one further than that from an edge
          // is drawn in the column the sample is in
          const distance = Math.min(...Array.from({ length: width }, (_, c) => Math.abs(place - edge(c))))
          if (distance > 2 * bucket) expect(onPyramid).toBe(onSamples)
          if (onPyramid !== onSamples) differing++
        }

        // the places beside the edges are there to show the peak can be drawn in the next column
        expect(differing).toBeGreaterThan(0)
        expect(levelForSpy.mock.results.some((result) => result.value?.length === Math.ceil(length / bucket))).toBe(
          true,
        )
        withPyramid.destroy()
        withSamples.destroy()
      })
    })

    test('draws a peak that is the largest of all at the height drawing the samples draws it', async () => {
      const channel = new Float32Array(LENGTH)
      channel[155_555] = -0.8
      channel[1234] = 0.3
      const fromSamples = await draw([channel], { normalize: true }, WIDTH)
      const fromPyramid = await draw([channel], { normalize: true, peakPyramid: true }, WIDTH)

      const heights = (calls: Call[]) => calls.filter(([, what]) => what === 'lineTo').map(([, , , y]) => y)
      expect(Math.max(...(heights(fromPyramid) as number[]).map((y) => Math.abs(y - 20)))).toBe(
        Math.max(...(heights(fromSamples) as number[]).map((y) => Math.abs(y - 20))),
      )
    })
  })
})
