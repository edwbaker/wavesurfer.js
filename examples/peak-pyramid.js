// Drawing a long recording from a peak pyramid
//
// A recording is made with the sample rate, length and number of channels set below, so that you can see what a
// long, high-rate recording costs to draw. Zoom it, and tick or untick "Peak pyramid" (the `peakPyramid` option)
// to compare. The first zoomed-out draw with the pyramid on makes it, with one pass over the audio. After that,
// zooming out costs about the same however long the recording is.

import WaveSurfer from 'wavesurfer.js'

/*
<html>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5em 1.5em; margin: 0 0 1em;">
    <label>
      Sample rate
      <select id="rate">
        <option value="8000">8 kHz</option>
        <option value="16000">16 kHz</option>
        <option value="22050">22.05 kHz</option>
        <option value="44100" selected>44.1 kHz</option>
        <option value="48000">48 kHz</option>
        <option value="96000">96 kHz</option>
      </select>
    </label>
    <label>
      Length
      <select id="minutes">
        <option value="1">1 minute</option>
        <option value="5">5 minutes</option>
        <option value="10" selected>10 minutes</option>
        <option value="20">20 minutes</option>
        <option value="30">30 minutes</option>
      </select>
    </label>
    <label>
      Channels
      <select id="channels">
        <option value="1">1</option>
        <option value="2" selected>2</option>
        <option value="4">4</option>
      </select>
    </label>
    <label><input type="checkbox" id="pyramid" checked /> Peak pyramid</label>
    <label><input type="checkbox" id="normalize" /> Normalize</label>
    <label><input type="checkbox" id="bars" /> Bars</label>
  </div>

  <div id="waveform"></div>

  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 1.5em; margin: 1em 0;">
    <button id="fit">Zoom to fit</button>
    <label>
      Zoom
      <input type="range" id="zoom" min="0" max="3" step="0.01" value="0" />
      <span id="zoom-label">fit</span>
    </label>
  </div>

  <p id="status" style="min-height: 3em;"></p>
</html>
*/

// The most samples the recording may have, all channels together, so that the page cannot run the browser out of
// memory: 120 million samples take 480 MB as 32-bit floats.
const MAX_SAMPLES = 120e6

// The loudness of the recording is worked out once for each run of this many samples
const BLOCK = 64

const rateSelect = document.querySelector('#rate')
const minutesSelect = document.querySelector('#minutes')
const channelsSelect = document.querySelector('#channels')
const pyramidBox = document.querySelector('#pyramid')
const normalizeBox = document.querySelector('#normalize')
const barsBox = document.querySelector('#bars')
const fitButton = document.querySelector('#fit')
const zoomSlider = document.querySelector('#zoom')
const zoomLabel = document.querySelector('#zoom-label')
const statusText = document.querySelector('#status')

const million = (n) => `${(n / 1e6).toFixed(1)} million`
const setStatus = (text) => (statusText.textContent = text)
const setBusy = (busy) => {
  for (const control of document.querySelectorAll('select, input, button')) control.disabled = busy
}

// Noise that is quiet and loud by turns, with a click now and then, so that the largest sample in a pixel
// varies along the waveform. It is made from a fixed seed, so a recording is the same every time.
const makeChannel = (length, rate, seed) => {
  const channel = new Float32Array(length)
  let state = seed
  for (let start = 0; start < length; start += BLOCK) {
    const seconds = start / rate
    const click = seconds % 1.7 < 0.004 ? 0.3 : 0
    const loudness = 0.15 + 0.5 * Math.abs(Math.sin(seconds / 9)) + click
    const end = Math.min(start + BLOCK, length)
    for (let i = start; i < end; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0
      channel[i] = (state / 2147483648 - 1) * loudness
    }
  }
  return channel
}

const drawingOptions = () => ({
  peakPyramid: pyramidBox.checked,
  normalize: normalizeBox.checked,
  barWidth: barsBox.checked ? 2 : undefined,
  barGap: barsBox.checked ? 1 : undefined,
})

let wavesurfer = null
let samples = 0 // in each channel

const describeDrawing = () => {
  const width = wavesurfer.getWrapper().clientWidth
  return `${million(samples)} samples in each channel, ${Math.round(samples / width).toLocaleString()} to a pixel`
}

// Zoom, and say how long it took to draw
const zoom = (pxPerSec) => {
  const before = performance.now()
  wavesurfer.zoom(pxPerSec)
  const took = performance.now() - before
  zoomLabel.textContent = pxPerSec ? `${Math.round(pxPerSec)} pixels a second` : 'fit'
  setStatus(`Drawn in ${took.toFixed(1)} ms: ${describeDrawing()}.`)
}

const create = async () => {
  const rate = Number(rateSelect.value)
  const seconds = Number(minutesSelect.value) * 60
  const channels = Number(channelsSelect.value)
  samples = rate * seconds

  if (samples * channels > MAX_SAMPLES) {
    setStatus(
      `That is ${million(samples * channels)} samples, and this page makes up to ${million(MAX_SAMPLES)}. ` +
        'Choose a lower sample rate, a shorter recording or fewer channels.',
    )
    return
  }

  setBusy(true)
  setStatus(`Making ${million(samples * channels)} samples...`)
  // Let the message be painted before the page is busy making them
  await new Promise((resolve) => setTimeout(resolve, 50))

  if (wavesurfer) wavesurfer.destroy()
  const peaks = Array.from({ length: channels }, (_, c) => makeChannel(samples, rate, 12345 + c))
  const before = performance.now()

  wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: 'rgb(200, 0, 200)',
    progressColor: 'rgb(100, 0, 100)',
    height: 128,
    interact: false,
    peaks,
    duration: seconds,
    ...drawingOptions(),
  })

  wavesurfer.once('redrawcomplete', () => {
    zoomSlider.value = 0
    zoomLabel.textContent = 'fit'
    setStatus(`Loaded and drawn in ${(performance.now() - before).toFixed(1)} ms: ${describeDrawing()}.`)
    setBusy(false)
  })
}

for (const select of [rateSelect, minutesSelect, channelsSelect]) {
  select.addEventListener('change', create)
}

// A different option redraws the waveform at the zoom it is at
for (const box of [pyramidBox, normalizeBox, barsBox]) {
  box.addEventListener('change', () => {
    const before = performance.now()
    wavesurfer.setOptions(drawingOptions())
    setStatus(`Redrawn in ${(performance.now() - before).toFixed(1)} ms: ${describeDrawing()}.`)
  })
}

fitButton.addEventListener('click', () => {
  zoomSlider.value = 0
  zoom(0)
})

// The slider is logarithmic, from the whole recording in the width to a thousand pixels a second
zoomSlider.addEventListener('input', () => {
  const value = zoomSlider.valueAsNumber
  zoom(value === 0 ? 0 : 10 ** value)
})

create()
