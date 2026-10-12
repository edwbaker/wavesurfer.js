/**
 * The largest absolute sample in each run of samples of one channel, and in each run of those, and so on: the
 * waveform draws only the largest absolute sample in each pixel column, and the largest of several largest
 * samples is the largest of all of them, so a zoomed-out waveform can be drawn from a level of the pyramid in
 * the place of the samples. A fit to the width of an hour of audio then reads thousands of values, not millions.
 *
 * A level is a `Float32Array` that can be drawn as if it were the channel. A value stands for the whole run of
 * samples it summarises, at the position of the first of them, so a peak can be drawn up to one bucket from where
 * its sample is, and a level is only used for a column that holds at least `BUCKETS_PER_COLUMN` of its buckets:
 * a peak is then drawn within a quarter of a column of where drawing the samples puts it. Where the edges of the
 * buckets are the edges of the columns, nothing differs.
 */

/** The number of samples summarised by one value of the finest level. */
export const FINEST_BUCKET = 256

/**
 * How many buckets of a level a column must hold for the level to be drawn in the place of the samples. A bucket
 * is drawn whole in one column, so the more of them a column holds, the closer to the sample a peak is drawn.
 */
export const BUCKETS_PER_COLUMN = 4

/**
 * Fewer samples than this in a column and no level is used: the samples are drawn. A column reads at most this
 * many of them, so the cost of drawing what is in view stays small however far in it is zoomed.
 */
export const MIN_SAMPLES_PER_COLUMN = FINEST_BUCKET * BUCKETS_PER_COLUMN

export type PeakPyramidSizes = {
  /** Samples in a bucket of the finest level. */
  finestBucket?: number
  /** Buckets a column must hold for a level to be drawn. */
  bucketsPerColumn?: number
}

export class PeakPyramid {
  /** The number of samples of the channel the pyramid was made from. */
  readonly length: number
  /** The largest absolute sample of the channel. */
  readonly peak: number

  private readonly levels: Float32Array[] = []
  private readonly finestBucket: number
  private readonly bucketsPerColumn: number

  constructor(channel: Float32Array, { finestBucket = FINEST_BUCKET, bucketsPerColumn = BUCKETS_PER_COLUMN } = {}) {
    this.length = channel.length
    this.finestBucket = finestBucket
    this.bucketsPerColumn = bucketsPerColumn

    const finest = new Float32Array(Math.ceil(channel.length / finestBucket))
    let peak = 0
    for (let bucket = 0; bucket < finest.length; bucket++) {
      const end = Math.min((bucket + 1) * finestBucket, channel.length)
      let max = 0
      for (let i = bucket * finestBucket; i < end; i++) {
        const magnitude = Math.abs(channel[i])
        if (magnitude > max) max = magnitude
      }
      finest[bucket] = max
      if (max > peak) peak = max
    }
    this.peak = peak

    // Each further level holds the larger of every pair of values of the one before it, the last of an odd number
    // standing alone, until a single value summarises the channel
    let level = finest
    while (level.length > 0) {
      this.levels.push(level)
      if (level.length === 1) break
      const next = new Float32Array(Math.ceil(level.length / 2))
      for (let i = 0; i < next.length; i++) {
        const a = level[2 * i]
        const b = level[2 * i + 1] ?? 0
        next[i] = a > b ? a : b
      }
      level = next
    }
  }

  /**
   * The level to draw for columns of this many samples: the coarsest one with at least `bucketsPerColumn` of its
   * buckets in a column. null when even the finest has fewer, which is when the samples themselves are drawn.
   */
  levelFor(samplesPerColumn: number): Float32Array | null {
    let chosen: Float32Array | null = null
    let bucket = this.finestBucket
    for (const level of this.levels) {
      // written so that NaN, which compares false with everything, chooses no level
      if (!(bucket * this.bucketsPerColumn <= samplesPerColumn)) break
      chosen = level
      bucket *= 2
    }
    return chosen
  }
}
