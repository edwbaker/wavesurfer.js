import Renderer from '../renderer.js'

declare global {
  interface Window {
    HTMLCanvasElement: typeof HTMLCanvasElement
  }
}

const createAudioBuffer = (channels: number[][], duration = 1): AudioBuffer => {
  return {
    duration,
    length: channels[0].length,
    sampleRate: channels[0].length / duration,
    numberOfChannels: channels.length,
    getChannelData: (i: number) => Float32Array.from(channels[i]),
    copyFromChannel: jest.fn(),
    copyToChannel: jest.fn(),
  } as unknown as AudioBuffer
}

describe('Renderer', () => {
  let container: HTMLDivElement
  let renderer: Renderer
  const originalGetContext = window.HTMLCanvasElement.prototype.getContext
  const originalToDataURL = window.HTMLCanvasElement.prototype.toDataURL
  const originalToBlob = window.HTMLCanvasElement.prototype.toBlob

  beforeAll(() => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, writable: true })

    window.HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      beginPath: jest.fn(),
      rect: jest.fn(),
      roundRect: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      fill: jest.fn(),
      drawImage: jest.fn(),
      fillRect: jest.fn(),
      createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
      globalCompositeOperation: '',
      canvas: { width: 100, height: 100 },
    })) as any

    window.HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:mock')
    window.HTMLCanvasElement.prototype.toBlob = jest.fn((cb) => cb(new Blob([''])))
  })

  afterAll(() => {
    window.HTMLCanvasElement.prototype.getContext = originalGetContext
    window.HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    window.HTMLCanvasElement.prototype.toBlob = originalToBlob
  })

  beforeEach(() => {
    container = document.createElement('div')
    container.id = 'root'
    document.body.appendChild(container)
    renderer = new Renderer({ container })
  })

  afterEach(() => {
    renderer.destroy()
    container.remove()
    jest.clearAllMocks()
  })

  test('parentFromOptionsContainer accepts an element from another realm (e.g. an iframe)', () => {
    const foreign = {
      nodeType: 1,
      nodeName: 'DIV',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      style: {},
      appendChild: () => undefined,
    } as unknown as HTMLElement
    expect((renderer as any).parentFromOptionsContainer(foreign)).toBe(foreign)
  })

  test('parentFromOptionsContainer returns element and throws', () => {
    expect((renderer as any).parentFromOptionsContainer(container)).toBe(container)
    expect((renderer as any).parentFromOptionsContainer('#root')).toBe(container)
    expect(() => (renderer as any).parentFromOptionsContainer('#missing')).toThrow()
  })

  test('initHtml creates shadow root', () => {
    const [el, shadow] = (renderer as any).initHtml()
    expect(el.shadowRoot).toBe(shadow)
    expect(shadow.querySelector('.scroll')).not.toBeNull()
  })

  test('getHeight calculates values', () => {
    ;(renderer as any).audioData = { numberOfChannels: 2 }
    expect((renderer as any).getHeight(undefined, undefined)).toBe(128)
    expect((renderer as any).getHeight(50, undefined)).toBe(50)
    container.style.height = '200px'
    expect((renderer as any).getHeight('auto', [{ overlay: false }])).toBe(64)
  })

  test('createDelay resolves after time', async () => {
    jest.useFakeTimers()
    const delay = (renderer as any).createDelay(10)
    const spy = jest.fn()
    const p = delay().then(spy)
    jest.advanceTimersByTime(10)
    await p
    expect(spy).toHaveBeenCalled()
    jest.useRealTimers()
  })

  test('convertColorValues supports gradients', () => {
    const result = (renderer as any).convertColorValues(['red', 'blue'])
    expect(typeof result).toBe('object')
    expect((renderer as any).convertColorValues('red')).toBe('red')
  })

  test('getPixelRatio returns positive', () => {
    window.devicePixelRatio = 2
    expect((renderer as any).getPixelRatio()).toBe(2)
  })

  test('renderBarWaveform and renderLineWaveform draw on context', () => {
    const ctx = (renderer as any).canvasWrapper.ownerDocument.createElement('canvas').getContext('2d') as any
    const data = [new Float32Array([0, 0.5, -0.5]), new Float32Array([0, -0.5, 0.5])]
    ;(renderer as any).renderBarWaveform(data, {}, ctx, 1)
    expect(ctx.beginPath).toHaveBeenCalled()
    ;(renderer as any).renderLineWaveform(data, {}, ctx, 1)
    expect(ctx.lineTo).toHaveBeenCalled()
  })

  test('renderWaveform chooses rendering path', () => {
    const ctx = document.createElement('canvas').getContext('2d') as any
    const data = [new Float32Array([0, 1])]
    const spyBar = jest.spyOn(renderer as any, 'renderBarWaveform')
    const spyLine = jest.spyOn(renderer as any, 'renderLineWaveform')
    ;(renderer as any).renderWaveform(data, { barWidth: 1 }, ctx)
    expect(spyBar).toHaveBeenCalled()
    ;(renderer as any).renderWaveform(data, {}, ctx)
    expect(spyLine).toHaveBeenCalled()
  })

  test('renderSingleCanvas appends canvases', () => {
    const canvasContainer = document.createElement('div')
    const progressContainer = document.createElement('div')
    const data = [new Float32Array([0, 1])]
    ;(renderer as any).renderSingleCanvas(data, {}, 10, 10, 0, canvasContainer, progressContainer)
    expect(canvasContainer.querySelector('canvas')).not.toBeNull()
    expect(progressContainer.querySelector('canvas')).not.toBeNull()
  })

  test('renderMultiCanvas draws and subscribes', () => {
    const canvasContainer = document.createElement('div')
    const progressContainer = document.createElement('div')
    const data = [new Float32Array([0, 1])] as any
    Object.defineProperty((renderer as any).scrollContainer, 'clientWidth', { configurable: true, value: 200 })
    ;(renderer as any).renderMultiCanvas(data, { barWidth: 1 }, 200, 10, canvasContainer, progressContainer)
    expect(canvasContainer.querySelector('canvas')).not.toBeNull()
  })

  test('renderChannel creates containers', () => {
    const data = [new Float32Array([0, 1])]
    ;(renderer as any).renderChannel(data, {}, 10, 0)
    expect((renderer as any).canvasWrapper.children.length).toBeGreaterThan(0)
  })

  test('render processes audio buffer', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]])
    const spy = jest.fn()
    renderer.renderEpoch.subscribe(spy)
    await renderer.render(buffer)
    expect(spy).toHaveBeenCalled()
  })

  it('exposes visibleRange derived from scroll position and duration', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 60)
    await renderer.render(buffer)
    const range = renderer.getVisibleRange()
    expect(range.value.startTime).toBe(0)
    expect(range.value.endTime).toBeGreaterThan(0)
  })

  it('reports full duration as visibleRange when not scrollable', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 10)
    renderer.zoom(0) // fillParent, not scrollable
    await renderer.render(buffer)
    expect((renderer as any).isScrollable.value).toBe(false)
    expect(renderer.getVisibleRange().value).toEqual({ startTime: 0, endTime: 10 })
  })

  it('recomputes visibleRange when the underlying scroll position changes', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 100)
    renderer.zoom(1000) // force isScrollable
    await renderer.render(buffer)
    // jsdom performs no layout, so scrollWidth/clientWidth are both 0 by
    // default -- calculateScrollPercentages special-cases scrollWidth===0 to
    // {startX: 0, endX: 1}, which is exactly what render() sees. Stub in
    // sizes to exercise a real scroll delta.
    const scrollContainer = (renderer as any).scrollContainer as HTMLElement
    Object.defineProperty(scrollContainer, 'scrollWidth', { configurable: true, value: 1000 })
    Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 100 })

    expect((renderer as any).isScrollable.value).toBe(true)

    scrollContainer.scrollLeft = 500
    scrollContainer.dispatchEvent(new Event('scroll'))

    const range = renderer.getVisibleRange().value
    expect(range.startTime).toBeCloseTo(50)
    expect(range.endTime).toBeCloseTo(60)
  })

  it('keeps visibleRange reactive after a not-scrollable -> scrollable transition (zoom in from fit-to-width)', async () => {
    // Regression test: the first render is NOT scrollable (default
    // minPxPerSec: 0), so visibleRange's auto-tracked computed takes the
    // early-return branch and collects no dependency on the scroll stream.
    // isScrollable must be a tracked signal for the later zoom-in (same
    // audio, so audioDuration.set is an Object.is no-op, and streamEpoch
    // doesn't bump) to wake the computed up again -- with a plain field,
    // visibleRange froze at {0, duration} and scrolling showed blank lazy
    // canvases.
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 100)
    await renderer.render(buffer)
    expect((renderer as any).isScrollable.value).toBe(false)
    expect(renderer.getVisibleRange().value).toEqual({ startTime: 0, endTime: 100 })

    const scrollContainer = (renderer as any).scrollContainer as HTMLElement
    Object.defineProperty(scrollContainer, 'scrollWidth', { configurable: true, value: 1000 })
    Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 100 })

    renderer.zoom(1000) // same duration, now scrollable
    expect((renderer as any).isScrollable.value).toBe(true)

    scrollContainer.scrollLeft = 500
    scrollContainer.dispatchEvent(new Event('scroll'))

    const range = renderer.getVisibleRange().value
    expect(range.startTime).toBeCloseTo(50)
    expect(range.endTime).toBeCloseTo(60)
  })

  test('reRender keeps scroll position', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]])
    renderer.zoom(20)
    await renderer.render(buffer)
    renderer.setScroll(10)
    renderer.reRender()
    expect(renderer.getScroll()).toBe(10)
  })

  test('reRender keeps non-scroll position', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]])
    renderer.zoom(0)
    await renderer.render(buffer)
    renderer.setScroll(10)
    renderer.reRender()
    expect(renderer.getScroll()).toBe(0)
  })

  test('zoom updates option', () => {
    renderer.zoom(20)
    expect((renderer as any).options.minPxPerSec).toBe(20)
  })

  test('setOptions with an explicit undefined width reverts to fill behavior', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]])
    renderer.setOptions({ ...(renderer as any).options, width: 250 })
    await renderer.render(buffer)
    const scrollContainer = (renderer as any).scrollContainer as HTMLElement
    expect(scrollContainer.style.width).toBe('250px')

    // WaveSurfer.setOptions merges, so an absent key keeps the fixed width;
    // an explicit `width: undefined` reaches the renderer as undefined and
    // must clear the fixed width again.
    renderer.setOptions({ ...(renderer as any).options, width: undefined })
    expect(scrollContainer.style.width).toBe('')
  })

  // #4055: a fill-parent waveform that overflows its container must not also widen it, or a
  // shrinkable container (e.g. a `flex: 1` item) grows to fit it and the resize observer
  // re-renders in a loop. jsdom does no layout, so the container's width is simulated.
  describe('containing the scroll area of a fill-parent waveform', () => {
    type Layout = { waveformWidth: number | null; contained: boolean }

    // `containerWidth` is the width of the scroll area's content as a function of the waveform's width and of
    // whether the scroll area is contained. `ownWidth` is what the container is wide without the scroll area,
    // the only time the renderer looks at the host (any other time it would count the waveform too, so the
    // simulation answers with a wrong width). `padding` is added to the `clientWidth` the renderer reads, as a
    // page that pads the `scroll` part would; a function gives the padding of wherever the waveform is now.
    // `displayed` says whether the container has a box at all: not when an ancestor is `display: none`.
    const setUp = (
      containerWidth: (layout: Layout) => number,
      {
        ownWidth = 600,
        padding = 0,
        displayed = () => true,
        ...options
      }: {
        ownWidth?: number | (() => number)
        padding?: number | (() => number)
        displayed?: () => boolean
        [key: string]: unknown
      } = {},
    ) => {
      const scrollContainer = (renderer as any).scrollContainer as HTMLElement
      const wrapper = (renderer as any).wrapper as HTMLElement
      const host = (renderer as any).container as HTMLElement
      const paddingNow = () => (typeof padding === 'function' ? padding() : padding)
      ;(renderer as any).containerInlinePadding = paddingNow()
      Object.defineProperty(scrollContainer, 'clientWidth', {
        configurable: true,
        // a whole number, as the browser reports it
        get: () =>
          Math.round(
            paddingNow() +
              containerWidth({
                // null until the wrapper is given a pixel width (it is '100%' or unset otherwise)
                waveformWidth: wrapper.style.width.endsWith('px') ? parseFloat(wrapper.style.width) : null,
                contained: scrollContainer.style.contain === 'inline-size',
              }),
          ),
      })
      Object.defineProperty(host, 'offsetWidth', {
        configurable: true,
        get: () => {
          if (!displayed()) return 0
          if (scrollContainer.style.display !== 'none') return 99999
          return typeof ownWidth === 'function' ? ownWidth() : ownWidth
        },
      })
      // jsdom has no boxes: an element has none unless it is told so
      Object.defineProperty(host, 'getClientRects', {
        configurable: true,
        value: () => (displayed() ? [{}] : []),
      })
      renderer.setOptions({ ...(renderer as any).options, fillParent: true, minPxPerSec: 100, ...options })
      return scrollContainer
    }
    // 100 seconds at 100px/s is 10000px: much wider than any container below
    const overflowing = createAudioBuffer([[0, 0.5, -0.5]], 100)

    describe('when the waveform widens the container', () => {
      test('contains a container that is widened by the waveform, such as a flex item', async () => {
        // Has a share of 600px by itself, but grows to fit the waveform unless it is contained
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')
        expect(scrollContainer.clientWidth).toBe(600)
        // Hidden only while its container was measured
        expect(scrollContainer.style.display).toBe('')
      })

      test('keeps it contained on later renders, and lets go once the waveform fits', async () => {
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        await renderer.render(overflowing)
        renderer.reRender()
        expect(scrollContainer.style.contain).toBe('inline-size')

        renderer.zoom(0) // fills the container now
        expect(scrollContainer.style.contain).toBe('')
      })

      test('contains a container that an earlier render left stretched', async () => {
        // The width measured before rendering is the stretched one (10000px), not the container's own
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 10000)), {
          minPxPerSec: 200, // 100 seconds at 200px/s is 20000px: wider than the stretched container
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')
        expect(scrollContainer.clientWidth).toBe(600)
      })

      test('contains a container that the waveform has widened when the padding is not a whole number of pixels', async () => {
        // The browser rounds clientWidth: 10000.4px of scroll area is reported as 10000, which less the 0.4px of padding
        // is a little under the waveform's width
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)), {
          padding: 0.4,
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')
      })
    })

    describe('what it leaves alone', () => {
      test('leaves a container with a definite width alone', async () => {
        const scrollContainer = setUp(() => 600)
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('leaves a container that has no width without the waveform alone', async () => {
        // It is as wide as the waveform makes it, e.g. a content-sized flex item
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 1 : (waveformWidth ?? 400)), {
          ownWidth: 1,
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
        expect(scrollContainer.style.display).toBe('')
      })

      test('leaves a container that only shrinks to fit the waveform alone', async () => {
        // A content-sized flex item with a `min-width` of 100px: it is as wide as its row allows (600px),
        // and containing the waveform would squeeze it to that 100px floor
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => (contained ? 100 : Math.min(waveformWidth ?? 100, 600)),
          { ownWidth: 100 },
        )
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
        expect(scrollContainer.clientWidth).toBe(600)
      })

      test('leaves a container that is capped below the waveform alone', async () => {
        // e.g. `max-width: 900px`: it grows with the waveform, but never to hold all of it
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => (contained ? 400 : Math.min(waveformWidth ?? 400, 900)),
          { ownWidth: 400 },
        )
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('does nothing when the waveform fits its container', async () => {
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)), {
          minPxPerSec: 0,
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('does nothing when the waveform is not asked to fill its parent', async () => {
        // It has a width of its own and is meant to size its container
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)), {
          fillParent: false,
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('does not take padding on the scroll area for a width of the container', async () => {
        // A page can pad the scroll area through its `scroll` part. A container sized by its content is as wide as
        // that padding before the waveform renders, and with the waveform contained it is still as wide as the
        // padding: more than the 1px floor, but not a width of its own
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 0 : (waveformWidth ?? 0)), {
          ownWidth: 1,
          padding: 32,
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('leaves a container alone that is narrower than the waveform by less than the padding of the scroll area', async () => {
        // A content-sized flex item with a `min-width`, given 9990px by its row: the padding makes the scroll area
        // as wide as the waveform (10022px against 10000px), but the waveform has not widened the container
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => (contained ? 100 : Math.min(waveformWidth ?? 100, 9990)),
          { ownWidth: 100, padding: 32 },
        )
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })
    })

    describe('how the container is measured', () => {
      test('hides the scroll area with an important declaration, which a rule on its part cannot override', async () => {
        // A page rule such as `::part(scroll) { display: block }` wins over a normal inline declaration
        let priority: string | undefined
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)), {
          ownWidth: () => {
            priority = ((renderer as any).scrollContainer as HTMLElement).style.getPropertyPriority('display')
            return 600
          },
        })
        await renderer.render(overflowing)
        expect(priority).toBe('important')
        expect(scrollContainer.style.display).toBe('')
      })

      test('puts back an inline display that custom code gave the scroll area, with its priority', async () => {
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        scrollContainer.style.setProperty('display', 'flex', 'important')
        await renderer.render(overflowing)
        expect(scrollContainer.style.getPropertyValue('display')).toBe('flex')
        expect(scrollContainer.style.getPropertyPriority('display')).toBe('important')
      })
    })

    describe('a contain that custom code set on the scroll area', () => {
      test('leaves a contain that custom code set on the scroll area alone', async () => {
        // Where the waveform would be contained, and where it fits and any containment would be taken off
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        scrollContainer.style.contain = 'paint'
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('paint')

        renderer.zoom(0)
        expect(scrollContainer.style.contain).toBe('paint')
      })

      test('leaves an inline-size that custom code set on the scroll area alone, as it did not come from here', async () => {
        // The same value as the renderer's own, so only knowing who set it tells them apart
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        scrollContainer.style.contain = 'inline-size'
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')

        renderer.zoom(0) // fits now, so a containment of the renderer's would be taken off
        expect(scrollContainer.style.contain).toBe('inline-size')
      })

      test('leaves an important inline-size that custom code put in its place alone', async () => {
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size') // the renderer's own

        scrollContainer.style.setProperty('contain', 'inline-size', 'important')
        renderer.zoom(0) // fits now, so a containment of the renderer's would be taken off
        expect(scrollContainer.style.getPropertyValue('contain')).toBe('inline-size')
        expect(scrollContainer.style.getPropertyPriority('contain')).toBe('important')
      })
    })

    describe('a scroll area that follows the waveform', () => {
      test('lets go of a scroll area that collapses once contained, as one sized by its content does', async () => {
        // e.g. a `width` of `max-content`, however it is written: asked for, so not an accident to contain
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 0 : (waveformWidth ?? 600)))
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('lets go of a scroll area that is already contained once it is asked to follow the waveform', async () => {
        // The width is changed while it is contained: contained, `max-content` leaves it no width at all
        const scrollContainer = setUp(({ waveformWidth, contained }) => {
          if (!contained) return waveformWidth ?? 600
          return (renderer as any).options.width === 'max-content' ? 0 : 600
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')

        renderer.setOptions({ ...(renderer as any).options, width: 'max-content' })
        expect(scrollContainer.style.contain).toBe('')
      })

      test('lets go of a contained scroll area that collapses on its own, without the container being resized', async () => {
        // e.g. a rule on the part gives it `width: max-content` after it was contained
        let collapsed = false
        const scrollContainer = setUp(({ waveformWidth, contained }) =>
          contained ? (collapsed ? 0 : 600) : (waveformWidth ?? 600),
        )
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')

        collapsed = true
        // What the resize observer calls when the scroll area changes size: the parent is as wide as before
        ;(renderer as any).onContainerResize()
        expect(scrollContainer.style.contain).toBe('')
      })

      test('does not look at how the width is written, only at what it does', async () => {
        // Written with a custom property that happens to hold the word `content`, it still fills the container
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)), {
          width: 'var(--content-width)',
        })
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')
      })
    })

    describe('when the waveform is moved to another container', () => {
      test('decides again when the waveform is moved to another container', async () => {
        // First in a flex item that has a width of its own, then in a container that is sized by its content
        let contentSized = false
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => {
            if (contentSized) return contained ? 1 : (waveformWidth ?? 400)
            return contained ? 600 : (waveformWidth ?? 600)
          },
          { ownWidth: () => (contentSized ? 1 : 600) },
        )
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')

        contentSized = true
        const elsewhere = document.createElement('div')
        document.body.appendChild(elsewhere)
        renderer.setOptions({ ...(renderer as any).options, container: elsewhere })
        // Not held on to from the old container: the new one has no width without the waveform
        expect(scrollContainer.style.contain).toBe('')
        elsewhere.remove()
      })

      test('measures the container it is moved to without the old width of the waveform in it', async () => {
        // Both are flex items with a share of 600px of their own. Measured with the waveform's old width still in the
        // scroll area, the new one would be stretched to hold it, and the waveform would count as fitting
        const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)))
        await renderer.render(overflowing)

        const elsewhere = document.createElement('div')
        document.body.appendChild(elsewhere)
        renderer.setOptions({ ...(renderer as any).options, container: elsewhere })
        expect(scrollContainer.style.contain).toBe('inline-size')
        expect(((renderer as any).wrapper as HTMLElement).style.width).toBe('10000px')
        elsewhere.remove()
      })

      // Two containers as wide as each other leave the resize observer nothing to report, so nothing but the move
      // itself can refresh what the renderer knows of the scroll area. jsdom has no layout and no `::part()`, so the
      // padding that a page rule would give the scroll area of each container is answered from the one it is in.
      describe('when the scroll area is padded differently there', () => {
        let paddings: Map<Element, number>
        let getComputedStyleSpy: jest.SpyInstance
        let elsewhere: HTMLDivElement
        const paddingHere = () => paddings.get(((renderer as any).container as HTMLElement).parentElement!) ?? 0

        beforeEach(() => {
          elsewhere = document.createElement('div')
          document.body.appendChild(elsewhere)
          paddings = new Map()
          const getComputedStyle = window.getComputedStyle.bind(window)
          getComputedStyleSpy = jest.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
            if (el !== (renderer as any).scrollContainer) return getComputedStyle(el, pseudo)
            const side = `${paddingHere() / 2}px`
            return { paddingLeft: side, paddingRight: side } as CSSStyleDeclaration
          })
        })

        afterEach(() => {
          getComputedStyleSpy.mockRestore()
          elsewhere.remove()
        })

        test('decides about containment with the padding of the container it is moved to', async () => {
          // Both are flex items with a share of 600px of their own. The padding the waveform left (40px) is taken off
          // the width of the scroll area it has widened (10000px of waveform and none of padding): that is a little
          // under the waveform, and the container would be taken for one the waveform has not widened
          paddings.set(container, 40)
          paddings.set(elsewhere, 0)
          const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 600 : (waveformWidth ?? 600)), {
            padding: paddingHere,
          })
          await renderer.render(overflowing)
          expect(scrollContainer.style.contain).toBe('inline-size')

          renderer.setOptions({ ...(renderer as any).options, container: elsewhere })
          expect(scrollContainer.style.contain).toBe('inline-size')
          expect(scrollContainer.clientWidth).toBe(600)
        })

        test('measures the waveform against the padding of the container it is moved to', async () => {
          // 620px of waveform overflows the 600px of room the new container leaves inside its padding. Taken off the
          // old padding (none), the room would be 640px and the waveform would be taken for one that fits
          paddings.set(container, 0)
          paddings.set(elsewhere, 40)
          const scrollContainer = setUp(() => 600, { padding: paddingHere, minPxPerSec: 6.2 })
          await renderer.render(overflowing)
          expect(renderer.getWidth()).toBe(600)
          expect(((renderer as any).wrapper as HTMLElement).style.width).toBe('620px')

          renderer.setOptions({ ...(renderer as any).options, container: elsewhere })
          expect(scrollContainer.clientWidth).toBe(640)
          expect(renderer.getWidth()).toBe(600)
          expect(((renderer as any).wrapper as HTMLElement).style.width).toBe('620px')
          expect(scrollContainer.style.overflowX).toBe('auto')
        })

        test('recognises a scroll area that collapses to its padding once contained in the container it is moved to', async () => {
          // One that follows the waveform (e.g. `width: max-content`) has nothing left but its 40px of padding once
          // contained. Against the old padding (none) that would not look like a collapse, and it would stay contained
          paddings.set(container, 0)
          paddings.set(elsewhere, 40)
          const scrollContainer = setUp(({ waveformWidth, contained }) => (contained ? 0 : (waveformWidth ?? 600)), {
            padding: paddingHere,
          })
          await renderer.render(overflowing)
          expect(scrollContainer.style.contain).toBe('')

          renderer.setOptions({ ...(renderer as any).options, container: elsewhere })
          expect(scrollContainer.style.contain).toBe('')
        })
      })
    })

    describe('when the container is resized', () => {
      // What the resize observer ends up calling, once the parent's width has changed
      let parentWidth = 600
      const resize = (width: number) => {
        parentWidth = width
        ;(renderer as any).onContainerResize()
      }
      beforeEach(() => {
        parentWidth = 600
        Object.defineProperty((renderer as any).parent, 'clientWidth', { configurable: true, get: () => parentWidth })
      })

      test('lets go of the containment once the container no longer has a width of its own', async () => {
        // e.g. a media query turns a flex item into one that is sized by its content
        let contentSized = false
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => {
            if (contentSized) return contained ? 1 : (waveformWidth ?? 400)
            return contained ? 600 : (waveformWidth ?? 600)
          },
          { ownWidth: () => (contentSized ? 1 : 600) },
        )
        await renderer.render(overflowing)
        expect(scrollContainer.style.contain).toBe('inline-size')

        contentSized = true
        resize(1)
        expect(scrollContainer.style.contain).toBe('')
      })

      test('keeps the containment while the container still has a width of its own', async () => {
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => (contained ? parentWidth : (waveformWidth ?? parentWidth)),
          { ownWidth: () => parentWidth },
        )
        await renderer.render(overflowing)

        resize(500)
        expect(scrollContainer.style.contain).toBe('inline-size')
      })

      test('only looks for it on a resize, not on every render', async () => {
        let looks = 0
        const scrollContainer = setUp(
          ({ waveformWidth, contained }) => (contained ? parentWidth : (waveformWidth ?? parentWidth)),
          {
            ownWidth: () => {
              looks++
              return parentWidth
            },
          },
        )
        await renderer.render(overflowing)
        expect(looks).toBe(1) // when it started being contained

        renderer.zoom(150)
        renderer.reRender()
        expect(scrollContainer.style.contain).toBe('inline-size')
        expect(looks).toBe(1)

        resize(550)
        expect(looks).toBe(2)
      })

      describe('when an ancestor of the container is hidden', () => {
        // `display: none` on an ancestor leaves everything in it without a size: the container, the host and the
        // scroll area are all 0 wide, which says nothing about whether the container has a width of its own
        let hidden = false
        const setUpFlexItem = () =>
          setUp(
            ({ waveformWidth, contained }) => {
              if (hidden) return 0
              return contained ? parentWidth : (waveformWidth ?? parentWidth)
            },
            { ownWidth: () => parentWidth, displayed: () => !hidden },
          )

        beforeEach(() => {
          hidden = false
        })

        test('keeps the containment while the container is hidden', async () => {
          const scrollContainer = setUpFlexItem()
          await renderer.render(overflowing)
          resize(600) // the resize observer reports the container once it is observed
          expect(scrollContainer.style.contain).toBe('inline-size')

          hidden = true
          resize(0)
          expect(scrollContainer.style.contain).toBe('inline-size')
        })

        test('does not widen the container when it is shown again', async () => {
          const scrollContainer = setUpFlexItem()
          await renderer.render(overflowing)
          resize(600)
          hidden = true
          resize(0)

          // Laid out as soon as it is shown, before the resize observer reports it: a waveform that is no longer
          // contained is as wide as it renders, 10000px, and stretches the container to hold it
          hidden = false
          parentWidth = 600
          expect(scrollContainer.clientWidth).toBe(600)

          resize(600)
          expect(scrollContainer.style.contain).toBe('inline-size')
          expect(scrollContainer.clientWidth).toBe(600)
        })

        test('still lets go of a container that is displayed but has no width of its own', async () => {
          // e.g. a content-sized flex item whose page took away the host's 1px floor: 0 wide, but not hidden
          let contentSized = false
          const scrollContainer = setUp(
            ({ waveformWidth, contained }) => {
              if (contentSized) return contained ? 1 : (waveformWidth ?? 400)
              return contained ? 600 : (waveformWidth ?? 600)
            },
            { ownWidth: () => (contentSized ? 0 : 600) },
          )
          await renderer.render(overflowing)
          resize(600)
          expect(scrollContainer.style.contain).toBe('inline-size')

          contentSized = true
          resize(1)
          expect(scrollContainer.style.contain).toBe('')
        })
      })
    })
  })

  test('scrollIntoView updates scroll', () => {
    Object.defineProperty((renderer as any).scrollContainer, 'scrollWidth', { configurable: true, value: 100 })
    Object.defineProperty((renderer as any).scrollContainer, 'clientWidth', { configurable: true, value: 50 })
    renderer.renderProgress(0)
    ;(renderer as any).scrollIntoView(0.8)
    expect(renderer.getScroll()).toBeGreaterThanOrEqual(0)
  })

  test('renderProgress clamps only at low zoom when auto-centering', () => {
    ;(renderer as any).options.autoScroll = true
    ;(renderer as any).options.autoCenter = true
    ;(renderer as any).isScrollable.set(true)

    const viewportWidth = 100
    const lowZoomDuration = 2
    const lowZoomScrollWidth = 200
    const highZoomDuration = 1
    const highZoomScrollWidth = 800

    Object.defineProperty((renderer as any).scrollContainer, 'clientWidth', {
      configurable: true,
      value: viewportWidth,
    })
    ;(renderer as any).audioData = { duration: lowZoomDuration }
    Object.defineProperty((renderer as any).scrollContainer, 'scrollWidth', {
      configurable: true,
      value: lowZoomScrollWidth,
    })
    renderer.setScroll(0)
    renderer.renderProgress(0.35, true)
    // 200 / 2 = 100 px/s, so low zoom keeps Math.min(20, 10) = 10
    expect(renderer.getScroll()).toBe(10)
    ;(renderer as any).audioData = { duration: highZoomDuration }
    Object.defineProperty((renderer as any).scrollContainer, 'scrollWidth', {
      configurable: true,
      value: highZoomScrollWidth,
    })
    renderer.setScroll(0)
    renderer.renderProgress(0.0875, true)
    // 800 / 1 = 800 px/s, so high zoom applies no clamp and scrolls by the full center offset
    expect(renderer.getScroll()).toBe(20)
  })

  test('renderProgress updates styles', () => {
    renderer.renderProgress(0.5)
    expect((renderer as any).progressWrapper.style.width).toBe('50%')
  })

  test('exportImage returns data', async () => {
    const canvas = document.createElement('canvas')
    ;(renderer as any).canvasWrapper.appendChild(canvas)
    const urls = await renderer.exportImage('image/png', 1, 'dataURL')
    expect(urls).toHaveLength(1)
    const blobs = await renderer.exportImage('image/png', 1, 'blob')
    expect(blobs).toHaveLength(1)
  })

  test('destroy cleans up', () => {
    renderer.destroy()
    expect(container.contains(renderer.getWrapper())).toBe(false)
  })

  test('destroy is terminal: scope stays disposed, decoded audio released, visibleRange safe to read', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 100)
    renderer.zoom(1000)
    await renderer.render(buffer)

    renderer.destroy()

    // The scope is disposed and NOT recreated -- a late registration runs
    // (and is released) immediately, so nothing can leak past destroy.
    expect((renderer as any).scope.disposed).toBe(true)
    const late = jest.fn()
    ;(renderer as any).scope.add(late)
    expect(late).toHaveBeenCalledTimes(1)

    // The decoded audio reference is released (a destroyed-but-referenced
    // renderer must not pin a multi-megabyte AudioBuffer).
    expect((renderer as any).audioData).toBeNull()

    // scrollStream is torn down, but reading visibleRange must not throw.
    expect((renderer as any).scrollStream).toBeNull()
    expect(() => renderer.getVisibleRange().value).not.toThrow()
  })

  test('input listeners are dead after destroy', async () => {
    const localContainer = document.createElement('div')
    document.body.appendChild(localContainer)
    const localRenderer = new Renderer({ container: localContainer })
    const clickSpy = jest.fn()
    localRenderer.clickSignal.subscribe(clickSpy)

    const wrapper = (localRenderer as any).wrapper as HTMLElement
    wrapper.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }) as DOMRect
    wrapper.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10 }))
    expect(clickSpy).toHaveBeenCalledTimes(1)

    localRenderer.destroy()
    wrapper.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10 }))
    expect(clickSpy).toHaveBeenCalledTimes(1) // no further delivery post-destroy
    localContainer.remove()
  })

  it('cancels a pending resize debounce on destroy even after a render', async () => {
    // The debounce delay() is created once in initEvents(), but render()
    // replaces delayScope; its cancellation must re-register per call or
    // destroy() cannot cancel a debounce scheduled after the first render.
    jest.useFakeTimers()
    let roCallback: (() => void) | undefined
    const OriginalRO = (global as any).ResizeObserver
    ;(global as any).ResizeObserver = class {
      constructor(cb: () => void) {
        roCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const resizeSpy = jest.spyOn(Renderer.prototype as any, 'onContainerResize')
    const localContainer = document.createElement('div')
    document.body.appendChild(localContainer)
    const localRenderer = new Renderer({ container: localContainer })
    try {
      await localRenderer.render(createAudioBuffer([[0, 0.5, -0.5]]))
      roCallback?.() // schedules the 100ms resize debounce
      localRenderer.destroy()
      jest.advanceTimersByTime(1000)
      await Promise.resolve()
      await Promise.resolve()
      expect(resizeSpy).not.toHaveBeenCalled()
    } finally {
      resizeSpy.mockRestore()
      ;(global as any).ResizeObserver = OriginalRO
      jest.useRealTimers()
      localContainer.remove()
    }
  })

  it('visibleRange is truthful right after render, with no scroll event dispatched', async () => {
    // Stub the scrollable metrics BEFORE render(), as real layout would
    // produce them -- unlike 'recomputes visibleRange...' above, which stubs
    // AFTER render() and dispatches a 'scroll' event. This exercises the
    // render()-internal scrollStream.refresh() call directly: without it,
    // scrollStream was only ever updated by a DOM 'scroll' event, so
    // visibleRange stayed pinned to the construction-time {startX:0, endX:1}
    // shape (full duration) until the user scrolled.
    const scrollContainer = (renderer as any).scrollContainer as HTMLElement
    Object.defineProperty(scrollContainer, 'scrollWidth', { configurable: true, value: 1000 })
    Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 100 })

    renderer.zoom(1000) // force isScrollable (no-op before first render, see zoom())
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 100)
    await renderer.render(buffer)

    expect((renderer as any).isScrollable.value).toBe(true)
    const range = renderer.getVisibleRange().value
    expect(range.endTime).toBeLessThan(100)
    expect(range.endTime).toBeCloseTo(10) // (0 + 100) / 1000 * 100
  })

  it('zoom() updates visibleRange via the same refresh path', async () => {
    const buffer = createAudioBuffer([[0, 0.5, -0.5]], 100)
    renderer.zoom(1000)
    await renderer.render(buffer)

    const scrollContainer = (renderer as any).scrollContainer as HTMLElement
    // Layout changes between renders without a 'scroll' event ever firing --
    // zoom()'s reRender() -> render() must refresh scrollStream itself.
    Object.defineProperty(scrollContainer, 'scrollWidth', { configurable: true, value: 2000 })
    Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 200 })

    renderer.zoom(2000)

    const range = renderer.getVisibleRange().value
    expect(range.endTime).toBeCloseTo(10) // (0 + 200) / 2000 * 100
  })

  describe('dragToSeek object-form toggling', () => {
    beforeAll(() => {
      // Polyfill matchMedia and PointerEvent for jsdom, same shims as
      // reactive/drag-stream.test.ts -- createDragStream() reads matchMedia
      // synchronously to detect touch devices.
      if (typeof window.matchMedia === 'undefined') {
        Object.defineProperty(window, 'matchMedia', {
          writable: true,
          value: jest.fn().mockReturnValue({
            matches: false,
            addListener: jest.fn(),
            removeListener: jest.fn(),
          }),
        })
      }
      if (typeof window.PointerEvent === 'undefined') {
        class FakePointerEvent extends MouseEvent {
          constructor(type: string, props: any) {
            super(type, props)
          }
        }
        // @ts-expect-error - Polyfill PointerEvent for jsdom test environment
        window.PointerEvent = FakePointerEvent
        // @ts-expect-error - Polyfill PointerEvent for jsdom test environment
        global.PointerEvent = FakePointerEvent
      }
    })

    const stubRect = (wrapper: HTMLElement) => {
      wrapper.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    }

    // Full pointerdown -> pointermove -> pointerup cycle (past the default
    // threshold of 3px) so createDragStream's internal document listeners are
    // torn down again at the end of each simulated drag, same as
    // reactive/drag-stream.test.ts's pattern.
    const simulateDrag = (wrapper: HTMLElement) => {
      wrapper.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, button: 0 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 0 }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, clientY: 0 }))
    }

    test('enabling dragToSeek with the object form via setOptions makes drag work', () => {
      const wrapper = renderer.getWrapper()
      stubRect(wrapper)
      const dragStartSpy = jest.fn()
      renderer.dragEventsSignal.subscribe((e) => {
        if (e?.type === 'start') dragStartSpy(e.relativeX)
      })

      expect((renderer as any).dragStream).toBeNull()

      renderer.setOptions({ ...(renderer as any).options, dragToSeek: { debounceTime: 100 } })

      simulateDrag(wrapper)
      expect(dragStartSpy).toHaveBeenCalled()
    })

    test('auto-scrolls continuously while the pointer rests in the edge zone during a drag', () => {
      jest.useFakeTimers()
      const wrapper = renderer.getWrapper()
      stubRect(wrapper)
      const scrollContainer = (renderer as any).scrollContainer as HTMLElement
      scrollContainer.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
      scrollContainer.scrollLeft = 500
      renderer.setOptions({ ...(renderer as any).options, dragToSeek: true, autoScroll: true })

      wrapper.dispatchEvent(new PointerEvent('pointerdown', { clientX: 50, clientY: 0, button: 0 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 60, clientY: 0 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 0 }))
      const before = scrollContainer.scrollLeft
      jest.advanceTimersByTime(100)
      expect(scrollContainer.scrollLeft).toBeLessThan(before)

      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0 }))
      const after = scrollContainer.scrollLeft
      jest.advanceTimersByTime(100)
      expect(scrollContainer.scrollLeft).toBe(after)
      jest.useRealTimers()
    })

    test('drag move events report the current pointer position', () => {
      const wrapper = renderer.getWrapper()
      wrapper.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 1000,
          bottom: 50,
          width: 1000,
          height: 50,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
      renderer.setOptions({ ...(renderer as any).options, dragToSeek: true })
      const moves: number[] = []
      renderer.dragEventsSignal.subscribe((e) => {
        if (e?.type === 'move') moves.push(e.relativeX)
      })

      wrapper.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 0, button: 0 }))
      for (const x of [200, 400, 600]) window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: 0 }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 600, clientY: 0 }))
      expect(moves).toEqual([0.2, 0.4, 0.6])
    })

    test('does not auto-scroll during a drag when autoScroll is false', () => {
      jest.useFakeTimers()
      const wrapper = renderer.getWrapper()
      stubRect(wrapper)
      const scrollContainer = (renderer as any).scrollContainer as HTMLElement
      scrollContainer.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
      scrollContainer.scrollLeft = 500
      renderer.setOptions({ ...(renderer as any).options, dragToSeek: true, autoScroll: false })

      wrapper.dispatchEvent(new PointerEvent('pointerdown', { clientX: 50, clientY: 0, button: 0 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 0 }))
      jest.advanceTimersByTime(100)
      expect(scrollContainer.scrollLeft).toBe(500)

      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0 }))
      jest.useRealTimers()
    })

    test('disabling dragToSeek via setOptions (object -> false) kills drag', () => {
      const wrapper = renderer.getWrapper()
      stubRect(wrapper)

      renderer.setOptions({ ...(renderer as any).options, dragToSeek: { debounceTime: 100 } })
      expect((renderer as any).dragStream).not.toBeNull()

      const dragStartSpy = jest.fn()
      renderer.dragEventsSignal.subscribe((e) => {
        if (e?.type === 'start') dragStartSpy(e.relativeX)
      })

      renderer.setOptions({ ...(renderer as any).options, dragToSeek: false })
      expect((renderer as any).dragStream).toBeNull()

      simulateDrag(wrapper)
      expect(dragStartSpy).not.toHaveBeenCalled()
    })

    test('repeated setOptions toggles do not accumulate disposers on this.scope', () => {
      const scope = (renderer as any).scope as { disposers: unknown[] }
      const baseline = scope.disposers.length

      for (let i = 0; i < 5; i++) {
        renderer.setOptions({ ...(renderer as any).options, dragToSeek: { debounceTime: 100 } })
        renderer.setOptions({ ...(renderer as any).options, dragToSeek: false })
      }

      expect(scope.disposers.length).toBe(baseline)
      expect((renderer as any).dragScope).toBeNull()
    })

    test('repeated setOptions toggles balance pointerdown listener add/remove on the wrapper', () => {
      const wrapper = renderer.getWrapper()
      const addSpy = jest.spyOn(wrapper, 'addEventListener')
      const removeSpy = jest.spyOn(wrapper, 'removeEventListener')

      for (let i = 0; i < 5; i++) {
        renderer.setOptions({ ...(renderer as any).options, dragToSeek: { debounceTime: 100 } })
        renderer.setOptions({ ...(renderer as any).options, dragToSeek: false })
      }

      const adds = addSpy.mock.calls.filter(([type]) => type === 'pointerdown').length
      const removes = removeSpy.mock.calls.filter(([type]) => type === 'pointerdown').length
      expect(adds).toBe(5)
      expect(removes).toBe(5)

      addSpy.mockRestore()
      removeSpy.mockRestore()
    })
  })
})
