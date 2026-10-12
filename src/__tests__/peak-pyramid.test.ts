import { BUCKETS_PER_COLUMN, FINEST_BUCKET, MIN_SAMPLES_PER_COLUMN, PeakPyramid } from '../peak-pyramid.js'

// Not a multiple of anything the pyramid divides by, and not a flat or a repeating signal
const signal = (length: number, seed = 1): Float32Array => {
  const channel = new Float32Array(length)
  let state = seed
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648
    channel[i] = (state / 2147483648 - 0.5) * 2 * (0.2 + 0.8 * Math.abs(Math.sin(i / 311)))
  }
  return channel
}

const largestAbs = (channel: Float32Array, start: number, end: number): number => {
  let max = 0
  for (let i = start; i < Math.min(end, channel.length); i++) max = Math.max(max, Math.abs(channel[i]))
  return max
}

describe('PeakPyramid', () => {
  describe('each level', () => {
    // Buckets of 4 samples, and every bucket counted, so that level k is asked for with 4 * 2^k samples a column
    const sizes = { finestBucket: 4, bucketsPerColumn: 1 }

    test.each([1, 3, 4, 5, 8, 9, 31, 32, 33, 100, 1001])(
      'holds the largest absolute sample of every run it stands for, for %i samples',
      (length) => {
        const channel = signal(length)
        const pyramid = new PeakPyramid(channel, sizes)

        for (let k = 0; 4 * 2 ** k <= 4 * length * 2; k++) {
          const bucket = 4 * 2 ** k
          const level = pyramid.levelFor(bucket)
          expect(level).not.toBeNull()
          expect(level).toBeInstanceOf(Float32Array)
          expect(level!.length).toBe(Math.ceil(length / bucket) || 1)
          level!.forEach((value, j) => expect(value).toBe(largestAbs(channel, j * bucket, (j + 1) * bucket)))
          if (level!.length === 1) break
        }
      },
    )

    test('ends in one value, which is the largest of all', () => {
      const channel = signal(1001)
      const top = new PeakPyramid(channel, sizes).levelFor(Infinity)!
      expect(top).toHaveLength(1)
      expect(top[0]).toBe(largestAbs(channel, 0, channel.length))
    })

    test('halves, the last of an odd number standing alone', () => {
      // 5 buckets of 4, then 3, 2 and 1
      const pyramid = new PeakPyramid(signal(20), sizes)
      expect([4, 8, 16, 32, 64].map((samples) => pyramid.levelFor(samples)!.length)).toEqual([5, 3, 2, 1, 1])
    })
  })

  describe('levelFor', () => {
    const channel = signal(100_000)
    const pyramid = new PeakPyramid(channel)

    test('chooses the samples, not a level, when a column holds fewer samples than it needs', () => {
      expect(MIN_SAMPLES_PER_COLUMN).toBe(FINEST_BUCKET * BUCKETS_PER_COLUMN)
      expect(pyramid.levelFor(MIN_SAMPLES_PER_COLUMN - 1)).toBeNull()
      expect(pyramid.levelFor(1)).toBeNull()
    })

    test('chooses the finest level as soon as a column holds enough of its buckets', () => {
      const level = pyramid.levelFor(MIN_SAMPLES_PER_COLUMN)!
      expect(level).toHaveLength(Math.ceil(channel.length / FINEST_BUCKET))
    })

    test('chooses the coarsest level that still has enough buckets in a column', () => {
      for (let k = 0; k < 6; k++) {
        const bucket = FINEST_BUCKET * 2 ** k
        const expectedLength = Math.ceil(channel.length / bucket)
        expect(pyramid.levelFor(bucket * BUCKETS_PER_COLUMN)).toHaveLength(expectedLength)
        // a hair short of the next level's size, and it is not yet chosen
        expect(pyramid.levelFor(bucket * 2 * BUCKETS_PER_COLUMN - 1)).toHaveLength(expectedLength)
      }
    })

    test('chooses no level for a column that holds no samples, or a number that is none', () => {
      for (const samples of [0, -1, -Infinity, NaN]) expect(pyramid.levelFor(samples)).toBeNull()
    })

    test('chooses the last level, however many samples are in a column', () => {
      for (const samples of [1e9, Infinity]) expect(pyramid.levelFor(samples)).toHaveLength(1)
    })

    test('never chooses a finer level for more samples in a column', () => {
      let previous = Infinity
      for (let samples = 1; samples < 1e6; samples = Math.ceil(samples * 1.37)) {
        const length = pyramid.levelFor(samples)?.length ?? Infinity
        expect(length).toBeLessThanOrEqual(previous)
        previous = length
      }
    })
  })

  describe('peak', () => {
    test('is the largest absolute sample, whatever its sign', () => {
      expect(new PeakPyramid(Float32Array.from([0.1, -0.7, 0.3])).peak).toBeCloseTo(0.7)
      expect(new PeakPyramid(Float32Array.from([0.1, 0.7, -0.3])).peak).toBeCloseTo(0.7)
      const channel = signal(70_001, 7)
      expect(new PeakPyramid(channel).peak).toBe(largestAbs(channel, 0, channel.length))
    })

    test('is found in the last, partial bucket too', () => {
      const channel = new Float32Array(FINEST_BUCKET * 3 + 5)
      channel[channel.length - 1] = -0.9
      expect(new PeakPyramid(channel).peak).toBeCloseTo(0.9)
    })

    test('ignores samples that are not numbers, as drawing them does', () => {
      const channel = Float32Array.from([0.2, NaN, 0.4, NaN])
      const pyramid = new PeakPyramid(channel, { finestBucket: 2, bucketsPerColumn: 1 })
      expect(pyramid.peak).toBeCloseTo(0.4)
      expect(Array.from(pyramid.levelFor(2)!)).toEqual([Math.fround(0.2), Math.fround(0.4)])
    })
  })

  test('is made of a channel without changing it', () => {
    const channel = signal(5000)
    const before = Array.from(channel)
    const pyramid = new PeakPyramid(channel)
    expect(pyramid.length).toBe(5000)
    expect(Array.from(channel)).toEqual(before)
  })

  test('an empty channel has no level and no peak', () => {
    const pyramid = new PeakPyramid(new Float32Array(0))
    expect(pyramid.length).toBe(0)
    expect(pyramid.peak).toBe(0)
    expect(pyramid.levelFor(Infinity)).toBeNull()
  })

  test('is a small fraction of the audio', () => {
    const channel = signal(1_000_000)
    const pyramid = new PeakPyramid(channel)
    let held = 0
    for (let k = 0; ; k++) {
      const level = pyramid.levelFor(FINEST_BUCKET * BUCKETS_PER_COLUMN * 2 ** k)
      if (!level) break
      held += level.length
      if (level.length === 1) break
    }
    expect(held).toBeLessThan(channel.length / 100)
  })
})
