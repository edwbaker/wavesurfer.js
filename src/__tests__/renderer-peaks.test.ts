import {
  calculateBarHeights,
  calculateBarSegments,
  calculateLinePaths,
  forEachColumnRun,
  resolveBarYPosition,
} from '../renderer-utils.js'
import type { BarSegment, ChannelData, LinePath } from '../renderer-utils.js'

/*
 * The drawing loops used to visit every sample, working out its column with
 * Math.round(i * scale) and closing the run of samples when the column moved
 * on. They now work out where each run ends. The copies below are the loops as
 * they were, to be compared with the current ones.
 */

type BarArgs = Parameters<typeof calculateBarSegments>[0]

function referenceBarSegments({
  channelData,
  barIndexScale,
  barSpacing,
  barWidth,
  halfHeight,
  vScale,
  canvasHeight,
  barAlign,
  barMinHeight,
}: BarArgs): BarSegment[] {
  const topChannel = channelData[0] || []
  const bottomChannel = channelData[1] || topChannel
  const length = topChannel.length
  const segments: BarSegment[] = []
  let prevX = 0
  let maxTop = 0
  let maxBottom = 0
  for (let i = 0; i <= length; i++) {
    const x = Math.round(i * barIndexScale)
    if (x > prevX) {
      const { topHeight, totalHeight } = calculateBarHeights({
        maxTop,
        maxBottom,
        halfHeight,
        vScale,
        barMinHeight,
        barAlign,
      })
      const y = resolveBarYPosition({ barAlign, halfHeight, topHeight, totalHeight, canvasHeight })
      segments.push({ x: prevX * barSpacing, y, width: barWidth, height: totalHeight })
      prevX = x
      maxTop = 0
      maxBottom = 0
    }
    const magnitudeTop = Math.abs(topChannel[i] || 0)
    const magnitudeBottom = Math.abs(bottomChannel[i] || 0)
    if (magnitudeTop > maxTop) maxTop = magnitudeTop
    if (magnitudeBottom > maxBottom) maxBottom = magnitudeBottom
  }
  return segments
}

function referenceLinePaths({
  channelData,
  width,
  height,
  vScale,
}: {
  channelData: ChannelData
  width: number
  height: number
  vScale: number
}): LinePath[] {
  const halfHeight = height / 2
  const primaryChannel = channelData[0] || []
  const secondaryChannel = channelData[1] || primaryChannel
  return [primaryChannel, secondaryChannel].map((channel, index) => {
    const length = channel.length
    const hScale = length ? width / length : 0
    const baseY = halfHeight
    const direction = index === 0 ? -1 : 1
    const path: LinePath = [{ x: 0, y: baseY }]
    let prevX = 0
    let max = 0
    for (let i = 0; i <= length; i++) {
      const x = Math.round(i * hScale)
      if (x > prevX) {
        const heightDelta = Math.round(max * halfHeight * vScale) || 1
        path.push({ x: prevX, y: baseY + heightDelta * direction })
        prevX = x
        max = 0
      }
      const value = Math.abs(channel[i] || 0)
      if (value > max) max = value
    }
    path.push({ x: prevX, y: baseY })
    return path
  })
}

function referenceRuns(length: number, scale: number) {
  const runs: Array<[number, number, number]> = []
  let column = 0
  let start = 0
  for (let i = 0; i <= length; i++) {
    const x = Math.round(i * scale)
    if (x > column) {
      runs.push([column, start, i])
      column = x
      start = i
    }
  }
  return { runs, last: column }
}

// A small seeded generator, so a failing layout can be reproduced
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Samples as decoded audio has them, with now and then a value the drawing code has to cope with
function samples(next: () => number, length: number, plain: boolean): Float32Array | number[] {
  const values = Array.from({ length }, () => {
    const roll = next()
    if (roll < 0.01) return NaN
    if (roll < 0.02) return -0
    return (next() * 2 - 1) * (0.2 + next() * 0.8)
  })
  return plain ? values : Float32Array.from(values)
}

describe('forEachColumnRun', () => {
  const collect = (length: number, scale: number) => {
    const runs: Array<[number, number, number]> = []
    const last = forEachColumnRun(length, scale, (column, start, end) => runs.push([column, start, end]))
    return { runs, last }
  }

  test('reports the runs of samples that share a column, but not the last one', () => {
    // 10 samples over 4 columns: columns are Math.round(i * 0.4) = 0 0 1 1 2 2 2 3 3 4 | 4 at i = 10
    expect(collect(10, 0.4)).toEqual({
      runs: [
        [0, 0, 2],
        [1, 2, 4],
        [2, 4, 7],
        [3, 7, 9],
      ],
      last: 4,
    })
  })

  test('has nothing to report for no samples, or for no width', () => {
    expect(collect(0, 0)).toEqual({ runs: [], last: 0 })
    expect(collect(1000, 0)).toEqual({ runs: [], last: 0 })
  })

  test('skips the columns that fall between two samples when there are more columns than samples', () => {
    // Math.round(i * 2.5) is 0 3 5 8 10 for i = 0 to 4: the columns in between are never reached
    expect(collect(4, 2.5)).toEqual({
      runs: [
        [0, 0, 1],
        [3, 1, 2],
        [5, 2, 3],
        [8, 3, 4],
      ],
      last: 10,
    })
  })

  test('finds the same runs as visiting every sample, including where the rounding lands on a half', () => {
    const scales = [0.5, 0.25, 0.125, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 0.7, 1, 1.5, 2, 2.5, 3.7, 1e-6, 0.999999, 1.000001]
    for (const scale of scales) {
      for (const length of [0, 1, 2, 3, 4, 5, 7, 10, 99, 100, 101, 1000, 4097]) {
        const expected = referenceRuns(length, scale)
        expect(collect(length, scale)).toEqual({ runs: expected.runs, last: expected.last })
      }
    }
  })

  test('finds the same runs as visiting every sample for the scales drawing really uses', () => {
    const next = random(42)
    for (let n = 0; n < 400; n++) {
      const length = 1 + Math.floor(next() * 20000)
      const columns = 1 + Math.floor(next() * 9000) + next()
      const spacing = [1, 1.5, 2, 3, 4.5][Math.floor(next() * 5)]
      const scale = columns / spacing / length
      const expected = referenceRuns(length, scale)
      expect(collect(length, scale)).toEqual({ runs: expected.runs, last: expected.last })
    }
  })

  test.each([0, -1, NaN, Infinity, -Infinity])('finds the runs the sample walk finds for a scale of %p', (scale) => {
    const expected = referenceRuns(20, scale)
    expect(collect(20, scale)).toEqual({ runs: expected.runs, last: expected.last })
  })

  // The estimate this once used, a division, ended in an endless loop for these: past 2^53 a
  // column plus one is the column, and dividing by a scale this small overflows
  test.each([Number.MAX_VALUE, 1e300, 2 ** 60, 2 ** 53, 2 ** 51, Number.MIN_VALUE, 1e-300, 1e-13])(
    'ends with the runs the sample walk finds for the extreme scale %p',
    (scale) => {
      for (const length of [0, 1, 2, 3, 10]) {
        const expected = referenceRuns(length, scale)
        expect(collect(length, scale)).toEqual({ runs: expected.runs, last: expected.last })
      }
    },
  )

  test('finds the runs the sample walk finds across nearly every scale a number can be', () => {
    const next = random(7)
    for (let n = 0; n < 600; n++) {
      const scale = Math.pow(10, -320 + next() * 640)
      const length = Math.floor(next() * 12)
      const expected = referenceRuns(length, scale)
      expect(collect(length, scale)).toEqual({ runs: expected.runs, last: expected.last })
    }
  })

  test('finds the runs the sample walk finds for long recordings and every kind of run length', () => {
    const next = random(11)
    for (let n = 0; n < 300; n++) {
      const length = 1 + Math.floor(next() * 60000)
      // From many samples to a column down to many columns to a sample
      const scale = Math.pow(10, -6 + next() * 9)
      const expected = referenceRuns(length, scale)
      expect(collect(length, scale)).toEqual({ runs: expected.runs, last: expected.last })
    }
  })
})

describe('calculateBarSegments and calculateLinePaths', () => {
  test('give exactly what the sample-by-sample loops gave, for random audio and layouts', () => {
    const next = random(2026)
    for (let n = 0; n < 250; n++) {
      const topLength = [0, 1, 2, 3, 7, 50, 333, 1000, 4096, 9999][Math.floor(next() * 10)]
      const stereo = next() < 0.6
      // The second channel may be shorter or longer than the first
      const bottomLength = Math.max(0, topLength + Math.floor((next() - 0.5) * 20))
      const plain = next() < 0.2
      const channelData: ChannelData = [samples(next, topLength, plain)]
      if (stereo) channelData.push(samples(next, bottomLength, plain))

      const width = [1, 10, 100, 300, 800, 2000, 8000, 12000][Math.floor(next() * 8)] * (next() < 0.3 ? 1.5 : 1)
      const barWidth = [1, 2, 3, 4][Math.floor(next() * 4)]
      const barGap = [0, 1, 2, 0.5][Math.floor(next() * 4)]
      const barSpacing = barWidth + barGap || 1
      const barArgs: BarArgs = {
        channelData,
        barIndexScale: topLength > 0 ? width / barSpacing / topLength : 0,
        barSpacing,
        barWidth,
        halfHeight: 64,
        vScale: next() < 0.5 ? 1 : 0.5 + next() * 2,
        canvasHeight: 128,
        barAlign: [undefined, 'top', 'bottom'][Math.floor(next() * 3)] as BarArgs['barAlign'],
        barMinHeight: next() < 0.3 ? 2 : 0,
      }
      expect(calculateBarSegments(barArgs)).toEqual(referenceBarSegments(barArgs))

      const lineArgs = { channelData, width, height: 128, vScale: barArgs.vScale }
      expect(calculateLinePaths(lineArgs)).toEqual(referenceLinePaths(lineArgs))
    }
  })

  test('draw nothing for audio with no samples', () => {
    const barArgs: BarArgs = {
      channelData: [new Float32Array(0)],
      barIndexScale: 0,
      barSpacing: 1,
      barWidth: 1,
      halfHeight: 64,
      vScale: 1,
      canvasHeight: 128,
      barAlign: undefined,
      barMinHeight: 0,
    }
    expect(calculateBarSegments(barArgs)).toEqual([])
    expect(calculateLinePaths({ channelData: [new Float32Array(0)], width: 100, height: 128, vScale: 1 })).toEqual(
      referenceLinePaths({ channelData: [new Float32Array(0)], width: 100, height: 128, vScale: 1 }),
    )
  })

  test('ignore NaN and missing samples, as drawing always has', () => {
    const channelData: ChannelData = [
      [0.2, NaN, 0.1, 0.9, NaN, -0.4],
      [0.5, -0.5],
    ]
    const barArgs: BarArgs = {
      channelData,
      barIndexScale: 3 / 6,
      barSpacing: 1,
      barWidth: 1,
      halfHeight: 50,
      vScale: 1,
      canvasHeight: 100,
      barAlign: undefined,
      barMinHeight: 0,
    }
    expect(calculateBarSegments(barArgs)).toEqual(referenceBarSegments(barArgs))
  })
})
