import FFT from '../fft.js'
import { createSparseFilterBankForScale, applySparseFilterBank } from '../spectrogram-render-utils.js'

const SCALES = ['mel', 'logarithmic', 'bark', 'erb'] as const

function makeSine(length: number, frequency: number, sampleRate: number): Float32Array {
  const signal = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    signal[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  }
  return signal
}

describe('FFT zero-padding (windowLength)', () => {
  const SAMPLE_RATE = 16000

  it('defaults windowLength to the buffer size with unchanged output', () => {
    const signal = makeSine(512, 1000, SAMPLE_RATE)
    const spectrum = new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined).calculateSpectrum(signal)
    const spectrumExplicit = new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 512).calculateSpectrum(signal)

    expect(Array.from(spectrumExplicit)).toEqual(Array.from(spectrum))
  })

  it('keeps bin magnitudes calibrated when the window is zero-padded', () => {
    // Sine on bin 8 of a 64-sample transform = bin 64 of a 512-sample transform
    const frequency = (8 * SAMPLE_RATE) / 64
    const signal = makeSine(64, frequency, SAMPLE_RATE)

    const unpadded = new (FFT as any)(64, SAMPLE_RATE, 'hann', undefined).calculateSpectrum(signal)

    const frame = new Float32Array(512)
    frame.set(signal)
    const padded = new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 64).calculateSpectrum(frame)

    // Without the bufferSize / windowLength window scaling this would be 8x (-18 dB) off
    expect(padded.length).toBe(256)
    expect(padded[64]).toBeCloseTo(unpadded[8], 5)
  })

  it('produces finite, correctly sized output for non-linear scales with a padded FFT', () => {
    const fftSamples = 64
    const fftSize = 512
    const frame = new Float32Array(fftSize)
    frame.set(makeSine(fftSamples, 1000, SAMPLE_RATE))
    const spectrum = new (FFT as any)(fftSize, SAMPLE_RATE, 'hann', undefined, fftSamples).calculateSpectrum(frame)

    for (const scale of SCALES) {
      const filterBank = createSparseFilterBankForScale(scale, fftSize / 2, fftSize, SAMPLE_RATE)!
      const mapped = applySparseFilterBank(spectrum, filterBank)
      expect(mapped.length).toBe(fftSize / 2)
      expect(Array.from(mapped).every(Number.isFinite)).toBe(true)
    }
  })

  it('masks stale samples beyond the window with the zeroed window tail', () => {
    const signal = makeSine(64, 1000, SAMPLE_RATE)
    const fft = new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 64)

    const cleanFrame = new Float32Array(512)
    cleanFrame.set(signal)
    const staleFrame = new Float32Array(512).fill(0.5)
    staleFrame.set(signal)

    expect(Array.from(fft.calculateSpectrum(staleFrame))).toEqual(Array.from(fft.calculateSpectrum(cleanFrame)))
  })

  it('throws when windowLength exceeds the buffer size', () => {
    expect(() => new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 1024)).toThrow()
  })

  it('throws when windowLength is shorter than two samples', () => {
    // Window formulas divide by (windowLength - 1): a one-sample window would yield NaN spectra
    expect(() => new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 1)).toThrow()
  })

  it('rejects explicit invalid windowLength values instead of coercing them', () => {
    expect(() => new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 0)).toThrow()
    expect(() => new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, NaN)).toThrow()
    expect(() => new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, 80.5)).toThrow()
    expect(() => new (FFT as any)(512, SAMPLE_RATE, 'hann', undefined, -64)).toThrow()
  })
})

describe('FFT window construction', () => {
  it('honors an explicit blackman alpha of 0 instead of coercing it to the default', () => {
    const explicitZero = new (FFT as any)(64, 8000, 'blackman', 0)
    const defaulted = new (FFT as any)(64, 8000, 'blackman', undefined)
    expect(explicitZero.windowValues[10]).not.toBe(defaulted.windowValues[10])
  })
})

describe('lanczoz window', () => {
  const SAMPLE_RATE = 16000

  it('produces finite values (sinc(0) = 1) for odd window lengths', () => {
    // Odd lengths are reachable via the fftSize decoupling (fftSamples may be any integer from
    // 2 to fftSize). At the center sample of an odd window the raw sin(pi*x)/(pi*x) formula
    // hits x = 0, i.e. 0/0 = NaN, which propagates through every frame into a blank spectrogram.
    const windowLength = 65
    const fft = new (FFT as any)(512, SAMPLE_RATE, 'lanczoz', undefined, windowLength)

    const live = Array.from(fft.windowValues.slice(0, windowLength)) as number[]
    expect(live.every(Number.isFinite)).toBe(true)
    // The center sample is sinc(0) = 1, times the bufferSize / windowLength zero-pad
    // calibration (Float32 storage, hence the reduced precision)
    expect(fft.windowValues[(windowLength - 1) / 2]).toBeCloseTo(512 / windowLength, 6)
  })

  it('yields a finite spectrum (not NaN-blank) for an odd-length lanczoz window', () => {
    const fft = new (FFT as any)(64, SAMPLE_RATE, 'lanczoz', undefined, 63)
    const frame = new Float32Array(64)
    frame.set(makeSine(63, 1000, SAMPLE_RATE))

    const spectrum = fft.calculateSpectrum(frame)

    expect(Array.from(spectrum).every(Number.isFinite)).toBe(true)
  })

  it('keeps even-length lanczoz windows on the raw sinc formula (Float32 precision)', () => {
    const windowLength = 64
    const fft = new (FFT as any)(windowLength, SAMPLE_RATE, 'lanczoz', undefined)
    for (let i = 0; i < windowLength; i++) {
      const x = (2 * i) / (windowLength - 1) - 1
      expect(fft.windowValues[i]).toBeCloseTo(Math.sin(Math.PI * x) / (Math.PI * x), 6)
    }
  })
})

describe('FFT accuracy', () => {
  // Direct O(N^2) DFT of the windowed frame, scaled like calculateSpectrum()
  function directSpectrum(frame: Float32Array, windowValues: Float32Array): number[] {
    const n = frame.length
    const magnitudes: number[] = []
    for (let k = 0; k < n / 2; k++) {
      let re = 0
      let im = 0
      for (let t = 0; t < n; t++) {
        const angle = (-2 * Math.PI * k * t) / n
        const x = frame[t] * windowValues[t]
        re += x * Math.cos(angle)
        im += x * Math.sin(angle)
      }
      magnitudes.push((2 / n) * Math.hypot(re, im))
    }
    return magnitudes
  }

  function pseudoRandomFrame(length: number): Float32Array {
    const frame = new Float32Array(length)
    let state = 7
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      frame[i] = (state / 4294967296) * 2 - 1
    }
    return frame
  }

  for (const size of [2, 4, 8, 64, 256]) {
    it(`matches a direct DFT for a ${size}-point transform`, () => {
      const frame = pseudoRandomFrame(size)
      const fft = new (FFT as any)(size, 16000, 'hann', undefined)
      const spectrum = fft.calculateSpectrum(frame)
      const expected = directSpectrum(frame, fft.windowValues)

      expect(spectrum.length).toBe(size / 2)
      for (let k = 0; k < size / 2; k++) {
        expect(Math.abs(spectrum[k] - expected[k])).toBeLessThan(1e-5)
      }
    })
  }

  it('matches a direct DFT for a zero-padded window', () => {
    const frame = pseudoRandomFrame(64)
    const fft = new (FFT as any)(64, 16000, 'blackman', undefined, 40)
    const spectrum = fft.calculateSpectrum(frame)
    const expected = directSpectrum(frame, fft.windowValues)

    for (let k = 0; k < 32; k++) {
      expect(Math.abs(spectrum[k] - expected[k])).toBeLessThan(1e-5)
    }
  })
})

describe('FFT output buffers', () => {
  function makeFrame(length: number, seed: number): Float32Array {
    const frame = new Float32Array(length)
    let state = seed
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      frame[i] = (state / 4294967296) * 2 - 1
    }
    return frame
  }

  it('writes into a supplied buffer and returns that buffer', () => {
    const fft = new (FFT as any)(64, 16000, 'hann', undefined)
    const frame = makeFrame(64, 3)
    const fresh = Array.from(fft.calculateSpectrum(frame))

    const out = new Float32Array(32)
    const result = fft.calculateSpectrum(frame, out)

    expect(result).toBe(out)
    expect(Array.from(result)).toEqual(fresh)
  })

  it('does not carry values from an earlier frame into a reused buffer', () => {
    const fft = new (FFT as any)(64, 16000, 'hann', undefined)
    const out = new Float32Array(32)
    fft.calculateSpectrum(makeFrame(64, 1), out)

    const second = makeFrame(64, 2)
    const expected = Array.from(new (FFT as any)(64, 16000, 'hann', undefined).calculateSpectrum(second))

    expect(Array.from(fft.calculateSpectrum(second, out))).toEqual(expected)
  })

  it('ignores a supplied buffer of the wrong length', () => {
    const fft = new (FFT as any)(64, 16000, 'hann', undefined)
    const wrong = new Float32Array(7)

    const result = fft.calculateSpectrum(makeFrame(64, 4), wrong)

    expect(result).not.toBe(wrong)
    expect(result.length).toBe(32)
  })
})
