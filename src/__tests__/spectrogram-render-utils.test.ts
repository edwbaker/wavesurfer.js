import FFT from '../fft.js'
import {
  applySparseFilterBank,
  createSparseFilterBankForScale,
  magnitudesToColorIndices,
  magnitudesToDb,
  dbToColorIndices,
  dbToCompressedColorIndices,
  createPreEmphasisTilt,
  getBinFrequencies,
  SILENCE_FLOOR_DB,
  hzToBark,
  barkToHz,
  hzToScale,
  scaleToHz,
  setupColorMap,
  createColorLookup,
  paintSpectrogramRows,
  createSpectrogramBitmap,
} from '../spectrogram-render-utils.js'

const SCALES = ['mel', 'logarithmic', 'bark', 'erb'] as const

function makeSine(length: number, frequency: number, sampleRate: number): Float32Array {
  const signal = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    signal[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return signal
}

describe('sparse filter bank', () => {
  it('returns null for linear scale', () => {
    expect(createSparseFilterBankForScale('linear', 256, 512, 44100)).toBeNull()
  })

  it.each(SCALES)('stores exactly one two-tap entry per output row for %s scale', (scale) => {
    const numFilters = 256
    const sparse = createSparseFilterBankForScale(scale, numFilters, 512, 44100)!

    expect(sparse.length).toBe(numFilters)
    for (const { lo, weightLo, weightHi, centerHz } of sparse) {
      expect(Number.isInteger(lo)).toBe(true)
      expect(Number.isFinite(weightLo)).toBe(true)
      expect(Number.isFinite(weightHi)).toBe(true)
      expect(Number.isFinite(centerHz)).toBe(true)
    }
  })

  it.each(SCALES)('stores monotonically increasing center frequencies up to Nyquist for %s scale', (scale) => {
    const sampleRate = 44100
    const sparse = createSparseFilterBankForScale(scale, 256, 512, sampleRate)!

    for (let i = 1; i < sparse.length; i++) {
      expect(sparse[i].centerHz).toBeGreaterThan(sparse[i - 1].centerHz)
    }
    expect(sparse[0].centerHz).toBeGreaterThanOrEqual(0)
    expect(sparse[sparse.length - 1].centerHz).toBeLessThanOrEqual(sampleRate / 2)
  })

  /**
   * Independent analytic oracle for the sparse filter bank's own construction math (lo/
   * weightLo/weightHi/centerHz), replacing the deleted dense-vs-sparse byte-identical
   * comparison test. That test's only remaining value was catching a regression in
   * createSparseFilterBank's per-row math (bin index, interpolation weights) - these two
   * invariants target exactly that, independently of the production formula:
   *
   * 1. weightLo + weightHi === 1: by construction weightLo = 1 - r, weightHi = r, so this is
   *    what a triangular filter's two taps must sum to (a single unit of energy split across
   *    the two adjacent bins) - a weight-formula regression (e.g. swapped lo/hi, or `r`
   *    computed from the wrong endpoint) breaks this.
   * 2. Linear interpolation reconstructs centerHz: hzLow*weightLo + hzHigh*weightHi === hz,
   *    where hzLow/hzHigh are recomputed here from `lo` and an independently-derived `scale`
   *    (sampleRate / fftSamples, the same public quantity the implementation is documented to
   *    use, but computed fresh in this test rather than read off any internal). This is the
   *    algebraic identity the whole "sparse" representation depends on (see the module's own
   *    SparseFilter doc comment): if it does not hold, applySparseFilterBank's two-tap
   *    reconstruction of any row is wrong regardless of what centerHz itself claims - a bug in
   *    the bin index `j`, the `scale` divisor, or the interpolation fraction `r` all break this
   *    even though centerHz is taken as given. This does NOT independently verify hzToScale/
   *    scaleToHz's own formulas (e.g. hzToMel/melToHz) are mathematically correct in isolation -
   *    only that createSparseFilterBank's row construction is internally consistent with
   *    whatever scale/inverse-scale pair it's handed. The golden-value block below covers the
   *    end-to-end output (scale functions included) for a few frozen configurations instead.
   */
  it.each(SCALES)(
    'interpolation-reconstructs centerHz from lo/weightLo/weightHi for %s scale (analytic oracle)',
    (scale) => {
      const fftSamples = 512
      const sampleRate = 44100
      const binHz = sampleRate / fftSamples // independently derived, not read from the implementation
      const sparse = createSparseFilterBankForScale(scale, 64, fftSamples, sampleRate)!

      for (const { lo, weightLo, weightHi, centerHz } of sparse) {
        expect(weightLo + weightHi).toBeCloseTo(1, 10)
        const hzLow = lo * binHz
        const hzHigh = (lo + 1) * binHz
        expect(hzLow * weightLo + hzHigh * weightHi).toBeCloseTo(centerHz, 6)
        // Both taps must land within the FFT's valid bin range (0..fftSamples/2)
        expect(lo).toBeGreaterThanOrEqual(0)
        expect(lo + 1).toBeLessThanOrEqual(fftSamples / 2 + 1)
      }
    },
  )
})

describe('magnitudesToColorIndices', () => {
  /** The exact inline loop this helper replaced in all three plugins */
  function legacyLoop(spectrum: Float32Array, gainDB: number, rangeDB: number): Uint8Array {
    const freqBins = new Uint8Array(spectrum.length)
    const gainPlusRange = gainDB + rangeDB
    for (let j = 0; j < spectrum.length; j++) {
      const magnitude = spectrum[j] > 1e-12 ? spectrum[j] : 1e-12
      const valueDB = 20 * Math.log10(magnitude)
      if (valueDB <= -gainPlusRange) {
        freqBins[j] = 0
      } else if (valueDB >= -gainDB) {
        freqBins[j] = 255
      } else {
        freqBins[j] = Math.round(((valueDB + gainPlusRange) / rangeDB) * 255)
      }
    }
    return freqBins
  }

  const dbToMagnitude = (db: number) => Math.pow(10, db / 20)

  it('is byte-identical to the reference loop, including boundary values', () => {
    const gainDB = 20
    const rangeDB = 80
    // Magnitudes spanning silence, the 1e-12 floor, the full ramp, both clip branches, and
    // values just around the -gainDB white point
    const values: number[] = [0, 1e-15, 1e-12, 2e-12, 1]
    for (let db = -140; db <= 20; db += 0.37) {
      values.push(dbToMagnitude(db))
    }
    for (const db of [-100.001, -100, -99.999, -20.2, -20.157, -20.1, -20.001, -20, -19.999]) {
      values.push(dbToMagnitude(db))
    }
    const spectrum = Float32Array.from(values)

    expect(Array.from(magnitudesToColorIndices(spectrum, -gainDB, rangeDB))).toEqual(
      Array.from(legacyLoop(spectrum, gainDB, rangeDB)),
    )
  })

  it('is byte-identical to the reference loop across gain/range combinations on a real spectrum', () => {
    const signal = makeSine(512, 1000, 16000)
    const spectrum = new (FFT as any)(512, 16000, 'hann', undefined).calculateSpectrum(signal)

    for (const [gainDB, rangeDB] of [
      [20, 80],
      [0, 40],
      [40, 120],
      [-10, 60],
    ]) {
      expect(Array.from(magnitudesToColorIndices(spectrum, -gainDB, rangeDB))).toEqual(
        Array.from(legacyLoop(spectrum, gainDB, rangeDB)),
      )
    }
  })

  it('rejects invalid whiteDb and rangeDB values', () => {
    const spectrum = new Float32Array(4)
    expect(() => magnitudesToColorIndices(spectrum, NaN, 80)).toThrow(TypeError)
    expect(() => magnitudesToColorIndices(spectrum, -20, 0)).toThrow(TypeError)
    expect(() => magnitudesToColorIndices(spectrum, -20, -80)).toThrow(TypeError)
    expect(() => magnitudesToColorIndices(spectrum, -20, NaN)).toThrow(TypeError)
    expect(() => magnitudesToColorIndices(spectrum, Infinity, 80)).toThrow(TypeError)
  })
})

describe('preEmphasis tilt and autoGain helpers', () => {
  it('computes the Praat tilt: -6/0/+6 dB at 500/1000/2000 Hz for preEmphasis 6', () => {
    const tilt = createPreEmphasisTilt(6, [500, 1000, 2000])
    expect(tilt[0]).toBeCloseTo(-6, 10)
    expect(tilt[1]).toBeCloseTo(0, 10)
    expect(tilt[2]).toBeCloseTo(6, 10)
  })

  it('sends the DC bin toward -infinity instead of NaN (the 1e-308 guard)', () => {
    const tilt = createPreEmphasisTilt(6, [0, 1000])
    expect(Number.isFinite(tilt[0])).toBe(true)
    expect(tilt[0]).toBeLessThan(-6000)
  })

  it('attenuates the 0 Hz row for negative pre-emphasis too', () => {
    const tilt = createPreEmphasisTilt(-3, [0, 500, 2000])
    expect(Number.isFinite(tilt[0])).toBe(true)
    expect(tilt[0]).toBeLessThan(-3000)
    expect(tilt[1]).toBeCloseTo(3, 10)
    expect(tilt[2]).toBeCloseTo(-3, 10)
  })

  it('rejects non-finite preEmphasis', () => {
    expect(() => createPreEmphasisTilt(NaN, [1000])).toThrow(TypeError)
    expect(() => createPreEmphasisTilt(Infinity, [1000])).toThrow(TypeError)
  })

  it('derives bin frequencies from linear bins or the sparse scale rows', () => {
    const linear = getBinFrequencies(null, 512, 16000)
    expect(linear.length).toBe(256)
    expect(linear[0]).toBe(0)
    expect(linear[64]).toBe((64 * 16000) / 512)

    const bank = createSparseFilterBankForScale('mel', 256, 512, 16000)!
    const scaled = getBinFrequencies(bank, 512, 16000)
    expect(Array.from(scaled)).toEqual(bank.map((filter) => filter.centerHz))
  })

  it('rejects a tilt whose length does not match the spectrum', () => {
    const spectrum = new Float32Array(8)
    const tilt = createPreEmphasisTilt(6, [1000])
    expect(() => magnitudesToColorIndices(spectrum, -20, 80, tilt)).toThrow(TypeError)
    expect(() => magnitudesToDb(spectrum, tilt)).toThrow(TypeError)
  })

  it('reuses the out buffer in magnitudesToDb when shapes match', () => {
    const spectrum = Float32Array.from([1, 0.1, 0.01])
    const out = new Float32Array(3)
    expect(magnitudesToDb(spectrum, null, out)).toBe(out)
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[1]).toBeCloseTo(-20, 4)
  })

  it('maps the exact white point to 255 in dbToColorIndices (autoGain semantics)', () => {
    const db = Float32Array.from([-10, -30, -90, -200])
    const indices = dbToColorIndices(db, -10, 80)
    expect(indices[0]).toBe(255) // valueDB === whiteDb -> 255, not the wrapped 0
    expect(indices[3]).toBe(0) // below whiteDb - rangeDB
    expect(indices[1]).toBeGreaterThan(0)
    expect(indices[1]).toBeLessThan(255)
    expect(indices[1]).toBeGreaterThan(indices[2])
  })

  it('rejects invalid whiteDb/rangeDB in dbToColorIndices', () => {
    const db = new Float32Array(4)
    expect(() => dbToColorIndices(db, NaN, 80)).toThrow(TypeError)
    expect(() => dbToColorIndices(db, -20, 0)).toThrow(TypeError)
    expect(() => dbToColorIndices(db, -20, -1)).toThrow(TypeError)
  })

  it('exports a silence floor far below real signal levels', () => {
    expect(SILENCE_FLOOR_DB).toBe(-180)
  })
})

describe('dbToCompressedColorIndices', () => {
  const frame = () => Float32Array.from([-40, -60, -100, -140])

  it('matches dbToColorIndices without compression', () => {
    const expected = Array.from(dbToColorIndices(frame(), 0, 80))
    expect(Array.from(dbToCompressedColorIndices(frame(), 0, 80))).toEqual(expected)
    expect(Array.from(dbToCompressedColorIndices(frame(), 0, 80, 0))).toEqual(expected)
  })

  it('lifts every non-silent frame peak to 255 at full compression', () => {
    expect(dbToCompressedColorIndices(frame(), 0, 80, 1)[0]).toBe(255)
    expect(dbToCompressedColorIndices(Float32Array.from([-120, -150]), 0, 80, 1)[0]).toBe(255)
  })

  it('lifts the frame by C * (whiteDb - framePeak)', () => {
    // Peak -40 dB, C = 0.5: a 20 dB lift, so -40 maps like -20 and -60 like -40 do uncompressed
    expect(Array.from(dbToCompressedColorIndices(frame(), 0, 80, 0.5))).toEqual([191, 128, 0, 0])
  })

  it('keeps a frame below the silence floor blank', () => {
    expect(Array.from(dbToCompressedColorIndices(new Float32Array(4).fill(-240), 0, 80, 1))).toEqual([0, 0, 0, 0])
  })

  it('judges silence before the tilt, so a steep tilt cannot lift the numeric floor', () => {
    // The -240 dB clamp plus tilts up to +82 dB, as 18 dB/oct gives near 24 kHz
    const tilt = Float64Array.from([0, 60, 82])
    const floor = Float32Array.from(tilt, (t) => -240 + t)
    expect(Array.from(dbToCompressedColorIndices(floor, 0, 80, 1, tilt))).toEqual([0, 0, 0])
  })

  it('still compresses a non-silent frame against its tilted peak', () => {
    // The untilted peak (-50 dB) would shift the white point further and give [207, 143]
    const withTilt = dbToCompressedColorIndices(Float32Array.from([-40, -60]), 0, 80, 0.5, Float64Array.from([10, 0]))
    expect(Array.from(withTilt)).toEqual([191, 128])
  })

  it('darkens a frame louder than the white point but still clamps its peak at 255', () => {
    // Fixed gain: peak -6 dB against a -20 dB white point, C = 0.5 -> a -7 dB offset
    const indices = dbToCompressedColorIndices(Float32Array.from([-6, -40]), -20, 80, 0.5)
    expect(indices[0]).toBe(255)
    expect(indices[1]).toBe(dbToColorIndices(Float32Array.from([-47]), -20, 80)[0])
  })

  it('does not modify the input frame', () => {
    const db = frame()
    dbToCompressedColorIndices(db, 0, 80, 0.7)
    expect(Array.from(db)).toEqual(Array.from(frame()))
  })
})

describe('applySparseFilterBank', () => {
  it('produces finite, correctly sized output from a real FFT spectrum, for every scale', () => {
    const sampleRate = 16000
    const fftSize = 512
    const signal = makeSine(fftSize, 1000, sampleRate)
    const spectrum = new (FFT as any)(fftSize, sampleRate, 'hann', undefined).calculateSpectrum(signal)

    for (const scale of SCALES) {
      const filterBank = createSparseFilterBankForScale(scale, fftSize / 2, fftSize, sampleRate)!
      const mapped = applySparseFilterBank(spectrum, filterBank)
      expect(mapped.length).toBe(fftSize / 2)
      expect(Array.from(mapped).every(Number.isFinite)).toBe(true)
    }
  })
})

/**
 * Golden-value oracle for createSparseFilterBank, restoring the independent-of-the-
 * implementation-under-test correctness check the deleted dense-vs-sparse comparison test used
 * to provide (see the "sparse filter bank" describe block above for the complementary analytic
 * invariants, which don't cover the scale/inverse-scale formulas themselves - hzToMel/melToHz
 * etc). These arrays are literal values captured from the CURRENT implementation while its math
 * is known-good (frozen 2026-07-29, via `createSparseFilterBankForScale(scale, numFilters,
 * fftSamples, sampleRate)` for each config below) and hardcoded here as the expected output -
 * not re-derived from any production formula at test time. A regression in the bin index, the
 * interpolation weights, OR the underlying hzToMel/hzToBark/hzToErb formulas would change these
 * numbers and fail this test, which the finite/monotonic/interpolation-consistency checks above
 * cannot catch on their own (they're satisfied by any internally-consistent - even if wrong in
 * absolute terms - scale formula).
 */
describe('sparse filter bank golden values (frozen baseline)', () => {
  it('matches the frozen mel-scale baseline (numFilters=6, fftSamples=512, sampleRate=16000)', () => {
    const sparse = createSparseFilterBankForScale('mel', 6, 512, 16000)!
    expect(sparse).toEqual([
      { lo: 0, weightLo: 1, weightHi: 0, centerHz: 0 },
      { lo: 11, weightLo: closeTo(0.3080726909), weightHi: closeTo(0.6919273091), centerHz: closeTo(365.372728) },
      { lo: 29, weightLo: closeTo(0.513414837), weightHi: closeTo(0.486585163), centerHz: closeTo(921.455786) },
      { lo: 56, weightLo: closeTo(0.4306388528), weightHi: closeTo(0.5693611472), centerHz: closeTo(1767.792536) },
      { lo: 97, weightLo: closeTo(0.2117089339), weightHi: closeTo(0.7882910661), centerHz: closeTo(3055.884096) },
      { lo: 160, weightLo: closeTo(0.4781034627), weightHi: closeTo(0.5218965373), centerHz: closeTo(5016.309267) },
    ])
  })

  it('matches the frozen bark-scale baseline (numFilters=5, fftSamples=256, sampleRate=8000)', () => {
    const sparse = createSparseFilterBankForScale('bark', 5, 256, 8000)!
    expect(sparse).toEqual([
      { lo: 0, weightLo: 1, weightHi: 0, centerHz: 0 },
      { lo: 10, weightLo: closeTo(0.3158565751), weightHi: closeTo(0.6841434249), centerHz: closeTo(333.879482) },
      { lo: 24, weightLo: closeTo(0.9764075834), weightHi: closeTo(0.0235924166), centerHz: closeTo(750.737263) },
      { lo: 43, weightLo: closeTo(0.7119838265), weightHi: closeTo(0.2880161735), centerHz: closeTo(1352.750505) },
      { lo: 73, weightLo: closeTo(0.4480759307), weightHi: closeTo(0.5519240693), centerHz: closeTo(2298.497627) },
    ])
  })

  it('matches the frozen erb-scale baseline (numFilters=4, fftSamples=1024, sampleRate=44100)', () => {
    const sparse = createSparseFilterBankForScale('erb', 4, 1024, 44100)!
    expect(sparse).toEqual([
      { lo: 0, weightLo: 1, weightHi: 0, centerHz: 0 },
      { lo: 11, weightLo: closeTo(0.6228350563), weightHi: closeTo(0.3771649437), centerHz: closeTo(489.973607) },
      { lo: 47, weightLo: closeTo(0.8850590098), weightHi: closeTo(0.1149409902), centerHz: closeTo(2029.071189) },
      { lo: 159, weightLo: closeTo(0.6261049489), weightHi: closeTo(0.3738950511), centerHz: closeTo(6863.66091) },
    ])
  })
})

/** `expect.closeTo` shorthand for use inside `toEqual`'s nested object literals above. */
function closeTo(value: number, precision = 6) {
  return expect.closeTo(value, precision)
}

describe('bark scale zero normalization', () => {
  // The vertical-mapping code (renderChannelToCanvas / drawSpectrogramSegment) assumes
  // hzToScale(0, scale) === 0 when computing rMin/rMax ratios; the raw Traunmüller-corrected
  // bark formula maps 0 Hz to about -0.1505 instead, producing a slightly negative rMin and
  // out-of-range bitmap source rows (~0.6% offset). The mapping must be offset-corrected so
  // 0 Hz lands on exactly 0, consistently in both directions so the pair stays inverse.
  it('maps 0 Hz to exactly 0', () => {
    expect(hzToBark(0)).toBe(0)
    expect(hzToScale(0, 'bark')).toBe(0)
  })

  it('keeps every other scale mapping 0 Hz to 0 too (the shared zero assumption)', () => {
    for (const scale of ['linear', 'logarithmic', 'mel', 'erb'] as const) {
      expect(hzToScale(0, scale)).toBe(0)
    }
  })

  it('keeps barkToHz the exact inverse of hzToBark across the audible range', () => {
    // Values straddle both piecewise corrections (bark < 2 and bark > 20.1)
    for (const hz of [0, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000, 22050]) {
      expect(barkToHz(hzToBark(hz))).toBeCloseTo(hz, 6)
      expect(scaleToHz(hzToScale(hz, 'bark'), 'bark')).toBeCloseTo(hz, 6)
    }
  })

  it('stays monotonically increasing after the offset correction', () => {
    let previous = -Infinity
    for (let hz = 0; hz <= 22050; hz += 50) {
      const bark = hzToBark(hz)
      expect(bark).toBeGreaterThan(previous)
      previous = bark
    }
  })
})

describe('paintSpectrogramRows floors fractional bin values', () => {
  // Internally computed columns are Uint8Array entries (integers 0-255), but
  // loadFrequenciesData's externally-supplied frequenciesDataUrl JSON can carry fractional
  // numbers, which index no color. Values must be floored after clamping.
  it('does not throw for fractional values, flooring after the clamp', () => {
    const colors = createColorLookup(Array.from({ length: 256 }, (_, i) => [i / 255, 0, 0, 1]))
    const data = new Uint8ClampedArray(4 * 3) // 1 column, 3 rows, RGBA
    const column = [12.7, 254.5, 300.9]

    expect(() => paintSpectrogramRows(data, [column], colors, 3, 0, 3)).not.toThrow()

    // bin 0 (12.7 -> floor 12) lands at the BOTTOM pixel row: byte (3 - 0 - 1) * 4 = 8
    expect(data[8]).toBe(12)
    // bin 1 (254.5 -> floor 254) at byte (3 - 1 - 1) * 4 = 4
    expect(data[4]).toBe(254)
    // bin 2 (300.9 -> clamps to 255 first, floor is a no-op) at byte 0
    expect(data[0]).toBe(255)
  })
})

describe('applySparseFilterBank output buffers', () => {
  const filterBank = [
    // lo = -1 has no lower tap, so that tap must contribute nothing rather than a stale value
    { lo: -1, weightLo: 0.25, weightHi: 0.75, centerHz: 0 },
    { lo: 1, weightLo: 0.5, weightHi: 0.5, centerHz: 0 },
  ]
  const points = Float32Array.from([1, 2, 3, 4])

  it('writes into a supplied buffer and returns that buffer', () => {
    const out = new Float32Array(2)
    const result = applySparseFilterBank(points, filterBank, out)

    expect(result).toBe(out)
    expect(Array.from(result)).toEqual([0.75, 2.5])
  })

  it('does not keep a value from an earlier frame in a reused buffer', () => {
    const out = new Float32Array(2).fill(99)

    expect(Array.from(applySparseFilterBank(points, filterBank, out))).toEqual([0.75, 2.5])
  })

  it('ignores a supplied buffer of the wrong length', () => {
    const wrong = new Float32Array(5)

    const result = applySparseFilterBank(points, filterBank, wrong)

    expect(result).not.toBe(wrong)
    expect(Array.from(result)).toEqual([0.75, 2.5])
  })
})

// The per-pixel painter that paintSpectrogramRows replaced, kept as the reference it must match
function paintColumnPixels(
  data: Uint8ClampedArray,
  column: ArrayLike<number>,
  colorMap: number[][],
  columnIndex: number,
  columnCount: number,
  rowCount: number,
): void {
  for (let row = 0; row < rowCount; row++) {
    const colorIndex = Math.floor(Math.min(255, Math.max(0, column[row])))
    const color = colorMap[colorIndex]
    const pixelIndex = ((rowCount - row - 1) * columnCount + columnIndex) * 4
    data[pixelIndex] = color[0] * 255
    data[pixelIndex + 1] = color[1] * 255
    data[pixelIndex + 2] = color[2] * 255
    data[pixelIndex + 3] = color[3] * 255
  }
}

/** The whole image (every bin), as the replaced painter drew it */
function paintImageBefore(columns: ArrayLike<number>[], colorMap: number[][], binCount: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(columns.length * binCount * 4)
  columns.forEach((column, i) => paintColumnPixels(data, column, colorMap, i, columns.length, binCount))
  return data
}

/** Deterministic pseudo-random numbers in [0, 1) */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe('paintSpectrogramRows matches the per-pixel painter it replaced', () => {
  const BINS = 37
  const WIDTH = 23
  const random = makeRandom(7)

  const colorMaps: Record<string, number[][]> = {
    roseus: setupColorMap('roseus'),
    gray: setupColorMap('gray'),
    igray: setupColorMap('igray'),
    // Channels that land halfway between two bytes, outside 0-1, or on NaN, which the
    // Uint8ClampedArray stores round to even, clamp, or zero
    awkward: Array.from({ length: 256 }, (_, i) => [
      (i + 0.5) / 255,
      i % 17 === 0 ? NaN : (i * 7) % 300,
      1.2 - i / 200,
      ((i % 5) - 1) / 3,
    ]),
    // More than 256 entries: only the first 256 are reachable
    long: Array.from({ length: 300 }, () => [random(), random(), random(), random()]),
  }

  const uint8Columns = Array.from({ length: WIDTH }, () =>
    Uint8Array.from({ length: BINS }, () => Math.floor(random() * 256)),
  )
  // Plain arrays, as frequenciesDataUrl JSON delivers them: fractional, out-of-range and
  // non-number values that the old painter clamped, floored or coerced
  const odd = [0, 255, 12.7, 254.5, 254.99, 255.5, 300.9, -0.5, -5, 1e9, -1e9, Infinity, -Infinity, 0.999]
  const json = [null, true, false, '12.7', '300'] as unknown as number[]
  const plainColumns = Array.from({ length: WIDTH }, (_, x) =>
    Array.from({ length: BINS }, (_, bin) => {
      if ((bin + x) % 5 === 0) return json[(bin + x) % json.length]
      if ((bin + x) % 3 === 0) return odd[(bin + x) % odd.length]
      return random() * 400 - 70
    }),
  )

  for (const [name, colorMap] of Object.entries(colorMaps)) {
    it(`paints the same bytes with the ${name} color map`, () => {
      const colors = createColorLookup(colorMap)
      for (const columns of [uint8Columns, plainColumns]) {
        const data = new Uint8ClampedArray(WIDTH * BINS * 4)
        paintSpectrogramRows(data, columns, colors, BINS, 0, BINS)
        expect(data).toEqual(paintImageBefore(columns, colorMap, BINS))
      }
    })
  }

  it('paints a band of rows the same as those rows of the whole image', () => {
    const colorMap = colorMaps.roseus
    const colors = createColorLookup(colorMap)
    const rowBytes = WIDTH * 4
    for (const columns of [uint8Columns, plainColumns]) {
      const whole = paintImageBefore(columns, colorMap, BINS)
      for (const [firstRow, rowCount] of [
        [0, 1],
        [0, 20],
        [5, 9],
        [36, 1],
        [17, 20],
      ]) {
        const data = new Uint8ClampedArray(rowBytes * rowCount)
        paintSpectrogramRows(data, columns, colors, BINS, firstRow, rowCount)
        expect(data).toEqual(whole.slice(firstRow * rowBytes, (firstRow + rowCount) * rowBytes))
      }
    }
  })

  it('packs each color as its RGBA bytes, rounded like the per-pixel stores', () => {
    const colorMap = colorMaps.awkward
    const bytes = new Uint8Array(createColorLookup(colorMap).buffer)
    const expected = new Uint8ClampedArray(256 * 4)
    colorMap.forEach((color, i) => color.forEach((channel, k) => (expected[i * 4 + k] = channel * 255)))
    expect(Array.from(bytes)).toEqual(Array.from(expected))
  })

  it('paints a value that is not a number with color 0, where the per-pixel painter threw', () => {
    const colorMap = colorMaps.roseus
    const color0 = Array.from(new Uint8Array(createColorLookup(colorMap).buffer, 0, 4))
    const data = new Uint8ClampedArray(4 * 3)
    // NaN, a non-numeric string, and a value missing from a short column
    const column = [NaN, 'x' as unknown as number]

    paintSpectrogramRows(data, [column], createColorLookup(colorMap), 3, 0, 3)

    expect(Array.from(data)).toEqual([...color0, ...color0, ...color0])
    expect(() => paintImageBefore([column], colorMap, 3)).toThrow(TypeError)
  })
})

describe('createSpectrogramBitmap', () => {
  const originalImageData = (globalThis as any).ImageData
  const originalCreateImageBitmap = (globalThis as any).createImageBitmap
  let createImageBitmapMock: jest.Mock

  beforeEach(() => {
    // jsdom has neither ImageData nor createImageBitmap
    ;(globalThis as any).ImageData = class {
      data: Uint8ClampedArray
      constructor(
        public width: number,
        public height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4)
      }
    }
    createImageBitmapMock = jest.fn(() => Promise.resolve({}))
    ;(globalThis as any).createImageBitmap = createImageBitmapMock
  })

  afterEach(() => {
    ;(globalThis as any).ImageData = originalImageData
    ;(globalThis as any).createImageBitmap = originalCreateImageBitmap
  })

  type Image = { width: number; height: number; data: Uint8ClampedArray }
  /** createImageBitmap(image, sx, sy, sw, sh) */
  type BitmapCall = [Image, number, number, number, number]

  /**
   * The pixels of createImageBitmap(image, 0, y, image.width, height): the rectangle with
   * corners (0, y) and (image.width, y + height), so a negative height extends up from y, and
   * its rows outside the image transparent. null for a zero height, which rejects.
   */
  function crop(image: Image, y: number, height: number): Uint8ClampedArray | null {
    if (height === 0) return null
    const rowBytes = image.width * 4
    const top = Math.min(y, y + height)
    const out = new Uint8ClampedArray(Math.abs(height) * rowBytes)
    for (let row = 0; row < Math.abs(height); row++) {
      const source = top + row
      if (source >= 0 && source < image.height) {
        out.set(image.data.subarray(source * rowBytes, (source + 1) * rowBytes), row * rowBytes)
      }
    }
    return out
  }

  const BINS = 16
  const WIDTH = 9
  const colorMap = setupColorMap('roseus')
  const columns = Array.from({ length: WIDTH }, (_, x) =>
    Uint8Array.from({ length: BINS }, (_, bin) => (x * 31 + bin * 17) % 256),
  )
  const whole: Image = { width: WIDTH, height: BINS, data: paintImageBefore(columns, colorMap, BINS) }

  // [sourceY, sourceHeight, image rows inside the rectangle]: the whole image, narrowed
  // frequency ranges, rectangles reaching past either edge, negative heights, and rectangles
  // entirely outside the image
  const rectangles = [
    [0, 16, 16],
    [4, 8, 8],
    [0, 1, 1],
    [15, 1, 1],
    [12, 6, 4],
    [-3, 7, 4],
    [-2, 20, 16],
    [10, -4, 4],
    [3, -6, 3],
    [16, 2, 0],
    [-5, 3, 0],
    [0, -2, 0],
  ]

  for (const [sourceY, sourceHeight, rowsInside] of rectangles) {
    it(`makes the bitmap of the whole image cropped to y ${sourceY}, height ${sourceHeight}`, async () => {
      await createSpectrogramBitmap(columns, BINS, colorMap, sourceY, sourceHeight)

      const [image, x, y, width, height] = createImageBitmapMock.mock.calls[0] as BitmapCall
      expect([x, width, height]).toEqual([0, WIDTH, sourceHeight])
      expect(crop(image, y, height)).toEqual(crop(whole, sourceY, sourceHeight))
      // Only the rows inside the rectangle are painted (an ImageData has at least one row)
      expect(image.height).toBe(Math.max(1, rowsInside))
    })
  }

  it('passes a zero height on, so createImageBitmap rejects it as it did the whole image', async () => {
    // createImageBitmap reads NaN and infinite numbers as 0
    for (const [sourceY, sourceHeight] of [
      [5, 0],
      [NaN, NaN],
      [0, Infinity],
      [Infinity, -Infinity],
    ]) {
      createImageBitmapMock.mockClear()
      await createSpectrogramBitmap(columns, BINS, colorMap, sourceY, sourceHeight)
      const [, , , , height] = createImageBitmapMock.mock.calls[0] as BitmapCall
      expect(height).toBe(0)
    }
  })
})
