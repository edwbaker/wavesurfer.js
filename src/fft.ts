/**
 * FFT (Fast Fourier Transform) implementation
 * Based on https://github.com/corbanbrook/dsp.js
 *
 * The legacy ES5 constructor-function FFT class. Everything else that used to live in this file
 * (frequency-scale math, autoGain/color-mapping helpers, colormap/UI helpers) is fully typed and
 * has moved to spectrogram-render-utils.ts - this file's blanket @ts-nocheck below is now
 * truthfully scoped to just the untyped ES5 `this.x =` constructor pattern below, which doesn't
 * type-check as a class under strict mode.
 */

// eslint-disable-next-line
// @ts-nocheck

/**
 * Calculate FFT - Based on https://github.com/corbanbrook/dsp.js
 */
function FFT(bufferSize: number, sampleRate: number, windowFunc: string, alpha: number, windowLength?: number) {
  // Absent values default to the full buffer; explicit values are validated, not coerced
  windowLength = windowLength ?? bufferSize
  if (!Number.isInteger(windowLength) || windowLength < 2 || windowLength > bufferSize) {
    // Every window formula divides by (windowLength - 1) and the table has bufferSize entries
    throw Error('windowLength must be an integer between 2 and bufferSize')
  }
  this.bufferSize = bufferSize
  this.windowLength = windowLength
  this.sampleRate = sampleRate
  this.bandwidth = (2 / bufferSize) * (sampleRate / 2)

  // A real input of bufferSize samples is packed into a complex sequence half as long, so the
  // bit-reversal and twiddle tables and the work buffers are sized for that half length
  const halfLength = bufferSize / 2
  this.windowValues = new Float32Array(bufferSize)
  this.reverseTable = new Uint32Array(halfLength)
  this.fftCos = new Float64Array(halfLength)
  this.fftSin = new Float64Array(halfLength)
  this.unpackCos = new Float64Array(halfLength)
  this.unpackSin = new Float64Array(halfLength)
  this.real = new Float64Array(halfLength)
  this.imag = new Float64Array(halfLength)

  this.peakBand = 0
  this.peak = 0

  switch (windowFunc) {
    case 'bartlett':
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] =
          (2 / (windowLength - 1)) * ((windowLength - 1) / 2 - Math.abs(i - (windowLength - 1) / 2))
      }
      break
    case 'bartlettHann':
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] =
          0.62 - 0.48 * Math.abs(i / (windowLength - 1) - 0.5) - 0.38 * Math.cos((Math.PI * 2 * i) / (windowLength - 1))
      }
      break
    case 'blackman':
      alpha = alpha ?? 0.16
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] =
          (1 - alpha) / 2 -
          0.5 * Math.cos((Math.PI * 2 * i) / (windowLength - 1)) +
          (alpha / 2) * Math.cos((4 * Math.PI * i) / (windowLength - 1))
      }
      break
    case 'cosine':
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] = Math.cos((Math.PI * i) / (windowLength - 1) - Math.PI / 2)
      }
      break
    case 'gauss':
      alpha = alpha || 0.25
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] = Math.pow(
          Math.E,
          -0.5 * Math.pow((i - (windowLength - 1) / 2) / ((alpha * (windowLength - 1)) / 2), 2),
        )
      }
      break
    case 'hamming':
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] = 0.54 - 0.46 * Math.cos((Math.PI * 2 * i) / (windowLength - 1))
      }
      break
    case 'hann':
    case undefined:
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] = 0.5 * (1 - Math.cos((Math.PI * 2 * i) / (windowLength - 1)))
      }
      break
    case 'lanczoz':
      for (let i = 0; i < windowLength; i++) {
        // sinc(x) with sinc(0) = 1: the raw division is 0/0 = NaN at the center sample of odd
        // window lengths (reachable via the fftSize decoupling, where windowLength may be any
        // integer >= 2), which would propagate NaN through every frame into a blank spectrogram
        const x = (2 * i) / (windowLength - 1) - 1
        this.windowValues[i] = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      }
      break
    case 'rectangular':
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] = 1
      }
      break
    case 'triangular':
      for (let i = 0; i < windowLength; i++) {
        this.windowValues[i] = (2 / windowLength) * (windowLength / 2 - Math.abs(i - (windowLength - 1) / 2))
      }
      break
    default:
      throw Error("No such window function '" + windowFunc + "'")
  }

  // When the window is shorter than the FFT, the remaining table entries stay zero (zero
  // padding) and the live samples are scaled up so the 2 / bufferSize magnitude
  // normalization in calculateSpectrum() remains calibrated
  if (windowLength < bufferSize) {
    const windowScale = bufferSize / windowLength
    for (let i = 0; i < windowLength; i++) {
      this.windowValues[i] *= windowScale
    }
  }

  // Bit-reversal order for the half-length complex FFT
  let limit = 1
  let bit = halfLength >> 1

  while (limit < halfLength) {
    for (let i = 0; i < limit; i++) {
      this.reverseTable[i + limit] = this.reverseTable[i] + bit
    }

    limit = limit << 1
    bit = bit >> 1
  }

  // fftCos/fftSin are the twiddles of the half-length FFT; unpackCos/unpackSin rotate the even
  // and odd spectra into the bufferSize-point spectrum
  for (let i = 0; i < halfLength; i++) {
    this.fftCos[i] = Math.cos((-2 * Math.PI * i) / halfLength)
    this.fftSin[i] = Math.sin((-2 * Math.PI * i) / halfLength)
    this.unpackCos[i] = Math.cos((-2 * Math.PI * i) / bufferSize)
    this.unpackSin[i] = Math.sin((-2 * Math.PI * i) / bufferSize)
  }

  this.calculateSpectrum = function (buffer: Float32Array): Float32Array {
    const bufferSize = this.bufferSize,
      halfLength = bufferSize / 2,
      reverseTable = this.reverseTable,
      windowValues = this.windowValues,
      fftCos = this.fftCos,
      fftSin = this.fftSin,
      unpackCos = this.unpackCos,
      unpackSin = this.unpackSin,
      real = this.real,
      imag = this.imag,
      bSi = 2 / this.bufferSize,
      sqrt = Math.sqrt,
      spectrum = new Float32Array(halfLength)

    let rval, ival, mag

    const k = Math.floor(Math.log(bufferSize) / Math.LN2)

    if (Math.pow(2, k) !== bufferSize) {
      throw 'Invalid buffer size, must be a power of 2.'
    }
    if (bufferSize !== buffer.length) {
      throw (
        'Supplied buffer is not the same size as defined FFT. FFT Size: ' +
        bufferSize +
        ' Buffer Size: ' +
        buffer.length
      )
    }

    // Pack the windowed samples as z[m] = x[2m] + i x[2m + 1], stored in bit-reversed order
    for (let i = 0; i < halfLength; i++) {
      const src = 2 * reverseTable[i]
      real[i] = buffer[src] * windowValues[src]
      imag[i] = buffer[src + 1] * windowValues[src + 1]
    }

    // In-place radix-2 FFT of z; within a stage each butterfly touches a disjoint pair
    for (let size = 2; size <= halfLength; size <<= 1) {
      const half = size >> 1
      const step = halfLength / size
      for (let start = 0; start < halfLength; start += size) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const a = start + j
          const b = a + half
          const tr = fftCos[t] * real[b] - fftSin[t] * imag[b]
          const ti = fftCos[t] * imag[b] + fftSin[t] * real[b]

          real[b] = real[a] - tr
          imag[b] = imag[a] - ti
          real[a] += tr
          imag[a] += ti
        }
      }
    }

    // Split z into the spectra E of the even samples and O of the odd samples, then combine
    // them into X[i] = E[i] + exp(-2 pi j i / bufferSize) O[i]. Both come from conj(z[j]) with
    // j = (halfLength - i) mod halfLength
    for (let i = 0; i < halfLength; i++) {
      const j = (halfLength - i) % halfLength
      const evenR = (real[i] + real[j]) / 2
      const evenI = (imag[i] - imag[j]) / 2
      const oddR = (imag[i] + imag[j]) / 2
      const oddI = (real[j] - real[i]) / 2
      const wr = unpackCos[i]
      const wi = unpackSin[i]
      rval = evenR + wr * oddR - wi * oddI
      ival = evenI + wr * oddI + wi * oddR
      mag = bSi * sqrt(rval * rval + ival * ival)

      if (mag > this.peak) {
        this.peakBand = i
        this.peak = mag
      }
      spectrum[i] = mag
    }
    return spectrum
  }
}

// TypeScript declaration for FFT class
export declare class FFT {
  constructor(bufferSize: number, sampleRate: number, windowFunc: string, alpha: number, windowLength?: number)
  bufferSize: number
  windowLength: number
  calculateSpectrum(buffer: Float32Array): Float32Array
}

// Export the FFT constructor function
export { FFT }
export default FFT
