import Decoder from '../decoder.js'

describe('Decoder', () => {
  const originalAudioContext = global.AudioContext
  const audioBuffer = {} as AudioBuffer
  const decodeAudioData = jest.fn()
  const close = jest.fn()
  let state: AudioContextState

  beforeEach(() => {
    state = 'running'
    decodeAudioData.mockReset().mockResolvedValue(audioBuffer)
    close.mockReset().mockResolvedValue(undefined)

    global.AudioContext = jest.fn().mockImplementation(() => ({
      decodeAudioData,
      close,
      get state() {
        return state
      },
    }))
  })

  afterAll(() => {
    global.AudioContext = originalAudioContext
  })

  test('closes an active AudioContext after decoding', async () => {
    const result = await Decoder.decode(new ArrayBuffer(0), 8_000)

    expect(result).toBe(audioBuffer)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('does not close an AudioContext that is already closed', async () => {
    state = 'closed'

    await expect(Decoder.decode(new ArrayBuffer(0), 8_000)).resolves.toBe(audioBuffer)
    expect(close).not.toHaveBeenCalled()
  })

  test('decodes at the device rate when no sample rate is given', async () => {
    await Decoder.decode(new ArrayBuffer(0))

    expect(global.AudioContext).toHaveBeenCalledWith(undefined)
  })

  describe('resample', () => {
    const originalOfflineAudioContext = (globalThis as any).OfflineAudioContext

    afterEach(() => {
      ;(globalThis as any).OfflineAudioContext = originalOfflineAudioContext
    })

    test('reports whether an OfflineAudioContext is available', () => {
      ;(globalThis as any).OfflineAudioContext = undefined
      expect(Decoder.canResample()).toBe(false)
      ;(globalThis as any).OfflineAudioContext = jest.fn()
      expect(Decoder.canResample()).toBe(true)
    })

    test('renders the buffer at the new rate, in an offline context with the same channels', async () => {
      const destination = {}
      const node: any = { connect: jest.fn(), start: jest.fn() }
      const rendered = {} as AudioBuffer
      const OfflineContext = jest.fn().mockImplementation(() => ({
        destination,
        createBufferSource: () => node,
        startRendering: () => Promise.resolve(rendered),
      }))
      ;(globalThis as any).OfflineAudioContext = OfflineContext
      const source = { duration: 2, length: 96_000, sampleRate: 48_000, numberOfChannels: 2 } as AudioBuffer

      await expect(Decoder.resample(source, 8_000)).resolves.toBe(rendered)

      expect(OfflineContext).toHaveBeenCalledWith({ numberOfChannels: 2, length: 16_000, sampleRate: 8_000 })
      expect(node.buffer).toBe(source)
      expect(node.connect).toHaveBeenCalledWith(destination)
      expect(node.start).toHaveBeenCalled()
    })

    test('renders at least one sample, even for an empty buffer', async () => {
      const OfflineContext = jest.fn().mockImplementation(() => ({
        destination: {},
        createBufferSource: () => ({ connect: jest.fn(), start: jest.fn() }),
        startRendering: () => Promise.resolve({} as AudioBuffer),
      }))
      ;(globalThis as any).OfflineAudioContext = OfflineContext

      await Decoder.resample({ duration: 0, length: 0, sampleRate: 48_000, numberOfChannels: 1 } as AudioBuffer, 8_000)

      expect(OfflineContext).toHaveBeenCalledWith(expect.objectContaining({ length: 1 }))
    })

    test.each([
      // A fractional frame count (1396322.5) is truncated, as decodeAudioData truncates it
      [8_377_935, 1_396_322],
      // duration * rate is 2007.0000000000002 here, which rounding up from the duration turned into 2008
      [12_042, 2_007],
    ])(
      'truncates a %i-frame 48 kHz buffer to %i frames at 8 kHz, as decodeAudioData does',
      async (frames, expected) => {
        const OfflineContext = jest.fn().mockImplementation(() => ({
          destination: {},
          createBufferSource: () => ({ connect: jest.fn(), start: jest.fn() }),
          startRendering: () => Promise.resolve({} as AudioBuffer),
        }))
        ;(globalThis as any).OfflineAudioContext = OfflineContext
        const source = { duration: frames / 48_000, length: frames, sampleRate: 48_000, numberOfChannels: 1 }

        await Decoder.resample(source as AudioBuffer, 8_000)

        expect(OfflineContext).toHaveBeenCalledWith(expect.objectContaining({ length: expected }))
      },
    )
  })

  describe('createBuffer normalization', () => {
    test('normalizes all channels by the global max across channels, not channel 0 alone', () => {
      const buffer = Decoder.createBuffer(
        [
          [1, 2],
          [4, -1],
        ],
        2,
      )

      // Global max is 4 (in channel 1); scaling by channel 0's max (2) would
      // leave channel 1 outside -1..1.
      expect(Array.from(buffer.getChannelData(0))).toEqual([0.25, 0.5])
      expect(Array.from(buffer.getChannelData(1))).toEqual([1, -0.25])
    })

    test('normalizes when only a non-first channel exceeds -1..1', () => {
      const buffer = Decoder.createBuffer(
        [
          [0.5, -0.5],
          [2, 1],
        ],
        2,
      )

      // Channel 0 is within range; deciding from channel 0 alone would skip
      // normalization entirely and leave channel 1 out of range.
      expect(Array.from(buffer.getChannelData(0))).toEqual([0.25, -0.25])
      expect(Array.from(buffer.getChannelData(1))).toEqual([1, 0.5])
    })

    test('does not mutate the caller-owned peaks arrays', () => {
      const channel0 = [1, 2]
      const channel1 = Float32Array.from([4, -1])

      Decoder.createBuffer([channel0, channel1], 2)

      expect(channel0).toEqual([1, 2])
      expect(Array.from(channel1)).toEqual([4, -1])
    })

    test('leaves data already within -1..1 unscaled', () => {
      const buffer = Decoder.createBuffer([[0.5, -1, 0.25]], 3)
      expect(Array.from(buffer.getChannelData(0))).toEqual([0.5, -1, 0.25])
    })
  })

  describe('createBuffer copyFromChannel/copyToChannel', () => {
    test('copyFromChannel copies channel data into the destination', () => {
      const buffer = Decoder.createBuffer([[0, 0.25, 0.5, 0.75]], 1)
      const destination = new Float32Array(4)

      buffer.copyFromChannel(destination, 0)

      expect(Array.from(destination)).toEqual([0, 0.25, 0.5, 0.75])
    })

    test('copyFromChannel respects bufferOffset and the shorter of the two lengths', () => {
      const buffer = Decoder.createBuffer([[0, 0.25, 0.5, 0.75]], 1)

      const short = new Float32Array(2)
      buffer.copyFromChannel(short, 0, 1)
      expect(Array.from(short)).toEqual([0.25, 0.5])

      const long = new Float32Array(4)
      buffer.copyFromChannel(long, 0, 2)
      // Only the two remaining frames are copied; the rest stays untouched
      expect(Array.from(long)).toEqual([0.5, 0.75, 0, 0])
    })

    test('copyToChannel writes the source into the channel at bufferOffset', () => {
      const buffer = Decoder.createBuffer([[0, 0, 0, 0]], 1)

      buffer.copyToChannel(Float32Array.from([0.25, 0.5]), 0, 1)

      expect(Array.from(buffer.getChannelData(0))).toEqual([0, 0.25, 0.5, 0])
    })

    test('copyToChannel truncates a source longer than the remaining channel space', () => {
      const buffer = Decoder.createBuffer([[0, 0, 0]], 1)

      buffer.copyToChannel(Float32Array.from([0.25, 0.5, 0.75]), 0, 2)

      expect(Array.from(buffer.getChannelData(0))).toEqual([0, 0, 0.25])
    })

    test('copyFromChannel and copyToChannel throw for a missing channel', () => {
      const buffer = Decoder.createBuffer([[0, 0]], 1)

      expect(() => buffer.copyFromChannel(new Float32Array(2), 1)).toThrow(/Channel 1/)
      expect(() => buffer.copyToChannel(new Float32Array(2), 1)).toThrow(/Channel 1/)
    })
  })
})
