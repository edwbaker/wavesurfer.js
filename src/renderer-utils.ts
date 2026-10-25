import type { WaveSurferOptions } from './wavesurfer.js'

export type ChannelData = Array<Float32Array | number[]>

export type BarSegment = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasSlot = {
  index: number
  offset: number
  width: number
}

export type LinePath = Array<{ x: number; y: number }>

export const DEFAULT_HEIGHT = 128

export const MAX_CANVAS_WIDTH = 8000

export const MAX_NODES = 10

export function clampToUnit(value: number): number {
  // NaN (e.g. from pointer math over a zero-size, hidden container) must not
  // escape into seek positions -- treat it as 0.
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * The effective bar width and gap, with defaults applied. This is THE single
 * definition of the bar grid: the draw site (calculateBarRenderConfig) and
 * the layout clamp (clampWidthToBarGrid) both resolve through it, so canvas
 * widths always align with the drawn bar spacing. `pixelRatio` scales the
 * configured CSS-pixel values into device pixels for drawing; layout code
 * (which works in CSS pixels) passes 1.
 */
export function resolveBarDimensions(
  options: WaveSurferOptions,
  pixelRatio: number,
): { barWidth: number; barGap: number } {
  const barWidth = options.barWidth ? options.barWidth * pixelRatio : 1
  const barGap = options.barGap ? options.barGap * pixelRatio : options.barWidth ? barWidth / 2 : 0
  return { barWidth, barGap }
}

export function calculateBarRenderConfig({
  width,
  height,
  length,
  options,
  pixelRatio,
}: {
  width: number
  height: number
  length: number
  options: WaveSurferOptions
  pixelRatio: number
}) {
  const halfHeight = height / 2
  const { barWidth, barGap } = resolveBarDimensions(options, pixelRatio)
  const barRadius = options.barRadius || 0
  const barMinHeight = options.barMinHeight ? options.barMinHeight * pixelRatio : 0
  const spacing = barWidth + barGap || 1
  const barIndexScale = length > 0 ? width / spacing / length : 0

  return {
    halfHeight,
    barWidth,
    barGap,
    barRadius,
    barMinHeight,
    barIndexScale,
    barSpacing: spacing,
  }
}

export function calculateBarHeights({
  maxTop,
  maxBottom,
  halfHeight,
  vScale,
  barMinHeight = 0,
  barAlign,
}: {
  maxTop: number
  maxBottom: number
  halfHeight: number
  vScale: number
  barMinHeight?: number
  barAlign?: WaveSurferOptions['barAlign']
}): { topHeight: number; totalHeight: number } {
  let topHeight = Math.round(maxTop * halfHeight * vScale)
  const bottomHeight = Math.round(maxBottom * halfHeight * vScale)
  let totalHeight = topHeight + bottomHeight || 1

  if (totalHeight < barMinHeight) {
    totalHeight = barMinHeight
    if (!barAlign) {
      topHeight = totalHeight / 2
    }
  }

  return { topHeight, totalHeight }
}

export function resolveBarYPosition({
  barAlign,
  halfHeight,
  topHeight,
  totalHeight,
  canvasHeight,
}: {
  barAlign: WaveSurferOptions['barAlign']
  halfHeight: number
  topHeight: number
  totalHeight: number
  canvasHeight: number
}): number {
  if (barAlign === 'top') return 0
  if (barAlign === 'bottom') return canvasHeight - totalHeight
  return halfHeight - topHeight
}

/**
 * The largest magnitude among samples `start` up to `end`. A missing or NaN
 * sample counts for nothing, as it did when drawing read `sample || 0`.
 */
function maxMagnitude(channel: Float32Array | number[], start: number, end: number): number {
  let max = 0
  for (let i = start; i < end; i++) {
    const value = channel[i]
    const magnitude = value < 0 ? -value : value
    if (magnitude > max) max = magnitude
  }
  return max
}

/**
 * The first sample from `from` up to `length` whose column, `Math.round(index * scale)`, is beyond
 * `column`; `length + 1` if there is none. Once a sample is beyond a column so is every later one:
 * a product rounded to the nearest number never decreases as the index grows, and nor does the
 * rounding of it. So the sample is found by galloping out from `from` and then halving, testing
 * the very expression the drawing loops tested one sample at a time, instead of estimating by a
 * division that can overflow, or fail to tell a column from the next. This is exact for any scale,
 * and it ends, because it only ever narrows a range of whole numbers.
 */
function firstSampleBeyondColumn(column: number, scale: number, from: number, length: number): number {
  const isBeyond = (index: number) => Math.round(index * scale) > column
  if (from > length || !isBeyond(length)) return length + 1

  // `low` is a sample known not to be beyond the column (the one before `from` is in it), `high`
  // one known to be: the last, to begin with
  let low = from - 1
  let high = from
  let step = 1
  while (high < length && !isBeyond(high)) {
    low = high
    step *= 2
    high = Math.min(length, high + step)
  }

  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2)
    if (isBeyond(middle)) high = middle
    else low = middle
  }
  return high
}

/**
 * Walks the samples of a waveform drawn `scale` columns to a sample, calling
 * `onRun(column, start, end)` for each run of consecutive samples that share a
 * column, once the next column has begun, in order. `column` is
 * `Math.round(start * scale)`. This is the walk the drawing loops made, one
 * sample at a time -- close the run when `Math.round(i * scale)` passes the
 * run's column, for `i` up to and including `length` -- found without a
 * rounding and a comparison per sample: the end of each run is searched for
 * (see firstSampleBeyondColumn), in steps that grow only with the logarithm of
 * the run's length, so what is left for each sample is reading it. A caller
 * that scans the runs reads each sample of them once, so its cost still follows
 * those samples, not the columns. A run that nothing follows, the last, is not
 * reported, so a caller does not scan it; its column is returned.
 */
export function forEachColumnRun(
  length: number,
  scale: number,
  onRun: (column: number, start: number, end: number) => void,
): number {
  let column = 0
  let start = 0

  for (;;) {
    const next = firstSampleBeyondColumn(column, scale, start + 1, length)
    if (next > length) return column
    onRun(column, start, next)
    column = Math.round(next * scale)
    start = next
  }
}

export function calculateBarSegments({
  channelData,
  barIndexScale,
  barSpacing,
  barWidth,
  halfHeight,
  vScale,
  canvasHeight,
  barAlign,
  barMinHeight,
}: {
  channelData: ChannelData
  barIndexScale: number
  barSpacing: number
  barWidth: number
  halfHeight: number
  vScale: number
  canvasHeight: number
  barAlign: WaveSurferOptions['barAlign']
  barMinHeight: number
}): BarSegment[] {
  const topChannel = channelData[0] || []
  const bottomChannel = channelData[1] || topChannel
  const length = topChannel.length

  const segments: BarSegment[] = []

  forEachColumnRun(length, barIndexScale, (column, start, end) => {
    const { topHeight, totalHeight } = calculateBarHeights({
      maxTop: maxMagnitude(topChannel, start, end),
      maxBottom: maxMagnitude(bottomChannel, start, end),
      halfHeight,
      vScale,
      barMinHeight,
      barAlign,
    })

    const y = resolveBarYPosition({
      barAlign,
      halfHeight,
      topHeight,
      totalHeight,
      canvasHeight,
    })

    segments.push({
      x: column * barSpacing,
      y,
      width: barWidth,
      height: totalHeight,
    })
  })

  return segments
}

export function getRelativePointerPosition(rect: DOMRect, clientX: number, clientY: number): [number, number] {
  // A hidden or not-yet-laid-out container has a zero-size rect; dividing by
  // it would yield NaN relative coordinates (and NaN seeks downstream).
  const relativeX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
  const relativeY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0
  return [relativeX, relativeY]
}

export function resolveChannelHeight({
  optionsHeight,
  optionsSplitChannels,
  parentHeight,
  numberOfChannels,
  defaultHeight = DEFAULT_HEIGHT,
}: {
  optionsHeight?: WaveSurferOptions['height']
  optionsSplitChannels?: WaveSurferOptions['splitChannels']
  parentHeight: number
  numberOfChannels: number
  defaultHeight?: number
}): number {
  if (optionsHeight == null) return defaultHeight
  const numericHeight = Number(optionsHeight)
  if (!isNaN(numericHeight)) return numericHeight
  if (optionsHeight === 'auto') {
    const height = parentHeight || defaultHeight
    if (optionsSplitChannels?.every((channel) => !channel.overlay)) {
      return height / numberOfChannels
    }
    return height
  }
  return defaultHeight
}

export function getPixelRatio(devicePixelRatio?: number): number {
  return Math.max(1, devicePixelRatio || 1)
}

export function shouldRenderBars(options: WaveSurferOptions): boolean {
  return Boolean(options.barWidth || options.barGap || options.barAlign)
}

// A single reusable scratch canvas for gradient creation: resolveColorValue
// runs on every draw (including scroll-time lazy draws), and allocating a
// throwaway <canvas> per call caused needless GC churn. Lazily created so
// importing this module never touches the DOM.
let gradientScratchCanvas: HTMLCanvasElement | null = null

export function resolveColorValue(
  color: WaveSurferOptions['waveColor'],
  devicePixelRatio: number,
  canvasHeight?: number,
): string | CanvasGradient {
  if (!Array.isArray(color)) return color || ''
  if (color.length === 0) return '#999'
  if (color.length < 2) return color[0] || ''

  gradientScratchCanvas ??= document.createElement('canvas')
  const ctx = gradientScratchCanvas.getContext('2d')
  if (!ctx) return color[0] || ''
  const gradientHeight = canvasHeight || gradientScratchCanvas.height * devicePixelRatio
  const gradient = ctx.createLinearGradient(0, 0, 0, gradientHeight)

  const colorStopPercentage = 1 / (color.length - 1)
  color.forEach((value, index) => {
    gradient.addColorStop(index * colorStopPercentage, value)
  })

  return gradient
}

export function calculateWaveformLayout({
  duration,
  minPxPerSec = 0,
  parentWidth,
  fillParent,
  pixelRatio,
}: {
  duration: number
  minPxPerSec?: number
  parentWidth: number
  fillParent?: boolean
  pixelRatio: number
}) {
  const scrollWidth = Math.ceil(duration * minPxPerSec)
  const isScrollable = scrollWidth > parentWidth
  const useParentWidth = Boolean(fillParent && !isScrollable)
  const width = (useParentWidth ? parentWidth : scrollWidth) * pixelRatio

  return {
    scrollWidth,
    isScrollable,
    useParentWidth,
    width,
  }
}

export function clampWidthToBarGrid(width: number, options: WaveSurferOptions): number {
  if (!shouldRenderBars(options)) return width
  // Resolve through the same defaults the bar-drawing site uses (at
  // pixelRatio 1, since layout works in CSS pixels) -- divergent defaults
  // here produced a clipped bar / irregular gap at canvas seams at dpr=1.
  const { barWidth, barGap } = resolveBarDimensions(options, 1)
  const totalBarWidth = barWidth + barGap
  if (totalBarWidth === 0) return width
  return Math.floor(width / totalBarWidth) * totalBarWidth
}

export function calculateSingleCanvasWidth({
  clientWidth,
  totalWidth,
  options,
}: {
  clientWidth: number
  totalWidth: number
  options: WaveSurferOptions
}): number {
  const baseWidth = Math.min(MAX_CANVAS_WIDTH, clientWidth, totalWidth)
  return clampWidthToBarGrid(baseWidth, options)
}

export function computeCanvasPlan({
  totalWidth,
  clientWidth,
  options,
}: {
  totalWidth: number
  clientWidth: number
  options: WaveSurferOptions
}): { singleCanvasWidth: number; numCanvases: number; slots: CanvasSlot[] } {
  const singleCanvasWidth = calculateSingleCanvasWidth({ clientWidth, totalWidth, options })
  if (singleCanvasWidth === 0) return { singleCanvasWidth: 0, numCanvases: 0, slots: [] }
  const numCanvases = Math.ceil(totalWidth / singleCanvasWidth)
  const slots: CanvasSlot[] = []
  // Only the tail slot can ever be dropped here: every non-tail slot's width
  // is min(totalWidth - offset, singleCanvasWidth) === singleCanvasWidth,
  // which was already floor-clamped to the bar grid when it was computed
  // above, and clampWidthToBarGrid is idempotent on an already-aligned
  // value -- so it can't collapse to 0 for those. Only the final slot (where
  // totalWidth - offset < singleCanvasWidth) can floor-clamp down to 0 and
  // get skipped. That keeps `slots` dense with no gaps, so `slots[index]`
  // positional lookup stays aligned with `index`; if this clamping logic
  // ever changes such that a middle slot could also be dropped, draw() must
  // switch from positional indexing to finding a slot by its `.index` field.
  for (let index = 0; index < numCanvases; index++) {
    const offset = index * singleCanvasWidth
    const width = clampWidthToBarGrid(Math.min(totalWidth - offset, singleCanvasWidth), options)
    if (width > 0) slots.push({ index, offset, width })
  }
  return { singleCanvasWidth, numCanvases, slots }
}

/**
 * The part of each channel under one canvas, in proportion to where the canvas
 * is along the waveform. These are copies, which the caller may change, unless
 * `readOnly` says the caller only reads them: then a typed array is not copied
 * but viewed (`subarray`), which costs nothing however long the audio is. A
 * view shares the audio's memory, so writing to one writes to the audio.
 */
export function sliceChannelData({
  channelData,
  offset,
  clampedWidth,
  totalWidth,
  readOnly = false,
}: {
  channelData: ChannelData
  offset: number
  clampedWidth: number
  totalWidth: number
  readOnly?: boolean
}): ChannelData {
  return channelData.map((channel) => {
    const start = Math.floor((offset / totalWidth) * channel.length)
    const end = Math.floor(((offset + clampedWidth) / totalWidth) * channel.length)
    if (readOnly && channel instanceof Float32Array) return channel.subarray(start, end)
    return channel.slice(start, end)
  })
}

export function shouldClearCanvases(currentNodeCount: number): boolean {
  return currentNodeCount > MAX_NODES
}

export function getLazyRenderRange({
  scrollLeft,
  clientWidth,
  singleCanvasWidth,
  numCanvases,
}: {
  scrollLeft: number
  clientWidth: number
  singleCanvasWidth: number
  numCanvases: number
}): number[] {
  if (singleCanvasWidth <= 0 || numCanvases <= 0) return [0]
  // Canvas i occupies [i * singleCanvasWidth, (i + 1) * singleCanvasWidth)
  // (only the tail one may be narrower), so index both viewport edges against
  // the ACTUAL canvas width. The previous average-width math
  // (scrollLeft / totalWidth * numCanvases, +/- 1) could miss the canvas at a
  // viewport edge by up to a bar spacing when singleCanvasWidth was bar-grid
  // clamped below clientWidth -- an undrawn strip. One extra canvas on each
  // side is prefetch; draw() ignores out-of-range indexes.
  const startCanvas = Math.min(numCanvases - 1, Math.floor(scrollLeft / singleCanvasWidth))
  const endCanvas = Math.min(numCanvases - 1, Math.floor((scrollLeft + clientWidth) / singleCanvasWidth))
  const range: number[] = []
  for (let i = startCanvas - 1; i <= endCanvas + 1; i++) {
    range.push(i)
  }
  return range
}

/**
 * The maximum absolute sample value across ALL channels of the full channel
 * data. Computed once per render and threaded into calculateVerticalScale as
 * `maxPeak` so that every canvas slice normalizes against the same global
 * peak -- per-slice normalization would scale a quiet chunk to full height
 * and produce amplitude discontinuities at canvas seams.
 */
export function calculateGlobalPeak(channelData: ChannelData): number {
  let max = 0
  for (const channel of channelData) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i] ?? 0)
      if (magnitude > max) max = magnitude
    }
  }
  return max
}

export function calculateVerticalScale({
  channelData,
  barHeight,
  normalize,
  maxPeak,
}: {
  channelData: ChannelData
  barHeight?: WaveSurferOptions['barHeight']
  normalize?: WaveSurferOptions['normalize']
  maxPeak?: WaveSurferOptions['maxPeak']
}): number {
  const baseScale = barHeight || 1
  if (!normalize) return baseScale

  const firstChannel = channelData[0]
  if (!firstChannel || firstChannel.length === 0) return baseScale

  // Use fixed max peak if provided, otherwise calculate from data
  let max = maxPeak ?? 0
  if (!maxPeak) {
    for (let i = 0; i < firstChannel.length; i++) {
      const value = firstChannel[i] ?? 0
      const magnitude = Math.abs(value)
      if (magnitude > max) max = magnitude
    }
  }

  if (!max) return baseScale
  return baseScale / max
}

export function calculateLinePaths({
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
  const channels = [primaryChannel, secondaryChannel]

  return channels.map((channel, index) => {
    const length = channel.length
    const hScale = length ? width / length : 0
    const baseY = halfHeight
    const direction = index === 0 ? -1 : 1

    const path: LinePath = [{ x: 0, y: baseY }]

    const lastColumn = forEachColumnRun(length, hScale, (column, start, end) => {
      const heightDelta = Math.round(maxMagnitude(channel, start, end) * halfHeight * vScale) || 1
      path.push({ x: column, y: baseY + heightDelta * direction })
    })

    path.push({ x: lastColumn, y: baseY })

    return path
  })
}

/** Round to the nearest integer, with exact halves rounded away from zero. */
export function roundToHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}
