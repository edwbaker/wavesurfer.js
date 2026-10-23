// Full-mode spectrogram redraws in a real browser. A zoom, a scroll or a setOptions() call replaces
// the picture without ever showing a blank, missing or clipped one, a zoom keeps the view painted all
// across, and lazy drawing follows the view. jsdom has no layout, scrolling or canvas pixels, so the
// unit tests can't check these.

const id = '#waveform'
const TIMEOUT = 20000

// demo.wav is 21.77 s long. Wider than three 4096px canvases, from 565 px/s, the spectrogram is
// drawn lazily: only the canvases around the 600px view
const LAZY_ZOOM = 1000
const WIDE_ZOOM = 2000
const CANVAS_WIDTH = 4096

/** Resolves on the next `event` of a wavesurfer instance or plugin */
const next = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve))

/** The spectrogram as it is on screen, and the waveform's width */
const picture = (win) => {
  const { canvasContainer } = win.spectrogram.__spectrogramInternalsForTests()
  return {
    wrapper: canvasContainer.parentElement,
    canvases: Array.from(canvasContainer.querySelectorAll('canvas')),
    width: win.wavesurfer.getWrapper().offsetWidth,
  }
}

/** The [r, g, b, a] pixel in the middle of a canvas */
const middlePixel = (canvas) =>
  Array.from(canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data)

// The spectrogram is opaque: a canvas still transparent in the middle has not been painted
const isPainted = (canvas) => middlePixel(canvas)[3] > 0

/** Whether the [start, end] spans, side by side, cover from `from` to `to` without a gap */
const spansCover = (spans, from, to) => {
  let reached = from
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (start > reached + 1) break
    reached = Math.max(reached, end)
  }
  return reached >= to - 1
}

/**
 * Whether the spectrogram is painted all across the waveform's view, as it is displayed: stretched
 * to a new width, or clipped by its wrapper
 */
const coversView = (win) => {
  const { wrapper, canvases } = picture(win)
  // The waveform's scroll container
  const view = win.wavesurfer.getWrapper().parentElement.getBoundingClientRect()
  const box = wrapper.getBoundingClientRect()
  const clipped = win.getComputedStyle(wrapper).overflowX === 'hidden'
  const spans = canvases.map((canvas) => {
    const { left, right } = canvas.getBoundingClientRect()
    return clipped ? [Math.max(left, box.left), Math.min(right, box.right)] : [left, right]
  })
  return (
    box.right > view.left &&
    box.left < view.right &&
    spansCover(spans, Math.max(view.left, box.left), Math.min(view.right, box.right))
  )
}

/**
 * Checks the picture from now on, at every change to its canvases or its wrapper and at every frame,
 * and records what a viewer could have seen go wrong: no picture, a blank canvas, or a canvas of
 * another height than its wrapper, which clips it or leaves a gap. With `coverage`, also a view not
 * painted all across. That doesn't hold after a jump of the scroll position: lazy drawing paints the
 * new view a moment later.
 */
const watch = (win, { coverage = false } = {}) => {
  const problems = []
  const check = (when) => {
    const { wrapper, canvases } = picture(win)
    if (canvases.length === 0) problems.push(`${when}: no canvas on screen`)
    if (coverage && !coversView(win)) problems.push(`${when}: the view is not painted all across`)
    canvases.forEach((canvas) => {
      if (!isPainted(canvas)) problems.push(`${when}: a blank canvas at ${canvas.style.left}`)
      if (canvas.style.height !== wrapper.style.height) {
        problems.push(`${when}: a ${canvas.style.height} canvas in a ${wrapper.style.height} wrapper`)
      }
    })
  }
  const { canvasContainer } = win.spectrogram.__spectrogramInternalsForTests()
  const observer = new win.MutationObserver(() => check('change'))
  observer.observe(canvasContainer, { childList: true })
  observer.observe(canvasContainer.parentElement, { attributes: true, attributeFilter: ['style'] })
  let frame = win.requestAnimationFrame(function onFrame() {
    check('frame')
    frame = win.requestAnimationFrame(onFrame)
  })
  return {
    problems,
    stop: () => {
      observer.disconnect()
      win.cancelAnimationFrame(frame)
    },
  }
}

/** Opens a player with a full-mode spectrogram, and waits for the spectrogram's first picture */
const open = (options = {}, playerOptions = {}) =>
  cy.window().then({ timeout: TIMEOUT }, (win) => {
    win.spectrogram = win.Spectrogram.create({ height: 200, ...options })
    const drawn = next(win.spectrogram, 'ready')
    win.wavesurfer = win.WaveSurfer.create({
      container: id,
      height: 50,
      url: '../../examples/audio/demo.wav',
      plugins: [win.spectrogram],
      ...playerOptions,
    })
    return drawn
  })

/** Zooms, and waits for the spectrogram's redraw to be on screen */
const zoomTo = (minPxPerSec) =>
  cy.window().then({ timeout: TIMEOUT }, (win) => {
    const drawn = next(win.spectrogram, 'ready')
    win.wavesurfer.zoom(minPxPerSec)
    return drawn
  })

const scrollTo = (pixels) => cy.window().then((win) => win.wavesurfer.setScroll(pixels))

/** Retries until painted canvases cover the waveform's view */
const shouldShowTheView = () =>
  cy.window({ timeout: TIMEOUT }).should((win) => {
    const { canvases } = picture(win)
    expect(canvases.length, 'canvases on screen').to.be.above(0)
    expect(canvases.every(isPainted), 'every canvas is painted').to.equal(true)
    expect(coversView(win), 'the canvases cover the view').to.equal(true)
  })

const startWatching = (options) =>
  cy.window().then((win) => {
    win.watcher = watch(win, options)
  })

const expectNothingWrongSeen = () =>
  cy.window().then((win) => {
    win.watcher.stop()
    expect(win.watcher.problems, win.watcher.problems.join('; ')).to.deep.equal([])
  })

describe('Spectrogram full-mode redraws', () => {
  beforeEach(() => {
    cy.visit('cypress/e2e/index.html')
    cy.window().its('WaveSurfer').should('exist')
    cy.window().its('Spectrogram').should('exist')
  })

  it('keeps a painted picture on screen through a zoom, then draws only around the view', () => {
    open()
    startWatching({ coverage: true })
    zoomTo(LAZY_ZOOM)
    expectNothingWrongSeen()

    cy.window().then((win) => {
      const { canvases, width } = picture(win)
      expect(canvases.length).to.be.above(0)
      expect(canvases.length).to.be.below(Math.ceil(width / CANVAS_WIDTH))
      expect(coversView(win)).to.equal(true)
    })
  })

  it('draws the view as it scrolls', () => {
    open()
    zoomTo(LAZY_ZOOM)
    startWatching()

    scrollTo(10000)
    shouldShowTheView()
    scrollTo(20000)
    shouldShowTheView()
    scrollTo(0)
    shouldShowTheView()

    expectNothingWrongSeen()
  })

  // With fillParent, the default, the spectrogram's wrapper clips everything past the new width, the
  // end of the picture the view was on included. Without it, that picture would hold the view past
  // the new end. Either way, it stays in view stretched to the new width until the redraw replaces it
  ;[true, false].forEach((fillParent) => {
    it(`keeps the view painted when zooming out near the end, with fillParent: ${fillParent}`, () => {
      open({}, { fillParent, minPxPerSec: WIDE_ZOOM })
      scrollTo(Number.MAX_SAFE_INTEGER)
      shouldShowTheView()

      startWatching({ coverage: true })
      zoomTo(LAZY_ZOOM)
      shouldShowTheView()
      expectNothingWrongSeen()
    })
  })

  it('settles setOptions() once the new picture is on screen, without clipping the old one', () => {
    open()
    startWatching()

    cy.window()
      .then({ timeout: TIMEOUT }, (win) => win.spectrogram.setOptions({ height: 100 }).then(() => picture(win)))
      .then(({ wrapper, canvases }) => {
        expect(wrapper.style.height).to.equal('100px')
        expect(canvases.length).to.be.above(0)
        canvases.forEach((canvas) => {
          expect(canvas.style.height).to.equal('100px')
          expect(isPainted(canvas)).to.equal(true)
        })
      })

    expectNothingWrongSeen()
  })

  it('shows a new colour map by the time setOptions() settles', () => {
    open()
    startWatching()

    cy.window()
      .then({ timeout: TIMEOUT }, (win) =>
        win.spectrogram.setOptions({ colorMap: 'gray' }).then(() => picture(win).canvases.map(middlePixel)),
      )
      .then((pixels) => {
        expect(pixels.length).to.be.above(0)
        pixels.forEach(([r, g, b]) => {
          expect(g).to.equal(r)
          expect(b).to.equal(r)
        })
      })

    expectNothingWrongSeen()
  })

  it('redraws a zoomed spectrogram for setOptions() around the view', () => {
    open()
    zoomTo(LAZY_ZOOM)
    scrollTo(10000)
    shouldShowTheView()
    startWatching()

    cy.window().then({ timeout: TIMEOUT }, (win) => win.spectrogram.setOptions({ height: 150 }))
    cy.window().then((win) => {
      const { wrapper, canvases } = picture(win)
      expect(wrapper.style.height).to.equal('150px')
      canvases.forEach((canvas) => expect(canvas.style.height).to.equal('150px'))
      expect(coversView(win)).to.equal(true)
    })

    expectNothingWrongSeen()
  })
})
