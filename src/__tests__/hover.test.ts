import HoverPlugin from '../plugins/hover.js'
import { signal } from '../reactive/store.js'
import { createEmitter } from './helpers/create-emitter.js'

// Pass a `bbox` and change its `left` to scroll the waveform under the pointer
const createWaveSurfer = (container: HTMLElement, durationValue: number, bbox = { left: 0, width: 100 }) => {
  const duration = signal(durationValue)

  Object.defineProperty(container, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...bbox }),
  })

  document.body.appendChild(container)

  return {
    duration,
    wavesurfer: {
      ...createEmitter(),
      options: { progressColor: '#555' },
      getDuration: jest.fn(() => duration.value),
      getState: jest.fn(() => ({ duration })),
      getWrapper: jest.fn(() => container),
    },
  }
}

describe('HoverPlugin', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  test('flips the label at the same positions as before, on pointer move and on scroll', () => {
    jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(30)
    // The flip rule the plugin has always applied, here for a 30px label and
    // the default 1px line in a 100px wide waveform
    const expectedTransform = (posX: number, labelPreferLeft: boolean) =>
      (labelPreferLeft ? posX - 30 > 0 : posX + 30 > 100) ? 'translateX(-31px)' : ''

    for (const labelPreferLeft of [false, true]) {
      const container = document.createElement('div')
      const bbox = { left: 0, width: 100 }
      const { wavesurfer } = createWaveSurfer(container, 10, bbox)
      const plugin = HoverPlugin.create({ labelPreferLeft })
      plugin._init(wavesurfer as any)
      const label = container.querySelector<HTMLElement>('[part="hover-label"]')!

      // posX is capped at width - lineWidth - 1 = 98
      for (let clientX = 0; clientX <= 100; clientX++) {
        container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX }))
        expect(label.style.transform).toBe(expectedTransform(Math.min(98, clientX), labelPreferLeft))
      }

      // Rest the pointer, then scroll the waveform under it
      container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20 }))
      for (let scrolled = 0; scrolled <= 100; scrolled++) {
        bbox.left = -scrolled
        wavesurfer.emit('scroll')
        expect(label.style.transform).toBe(expectedTransform(Math.min(98, 20 + scrolled), labelPreferLeft))
      }

      plugin.destroy()
    }
  })

  test('measures the label on pointer move and when its text changes length, not on every scroll', () => {
    const offsetWidth = jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(30)
    const container = document.createElement('div')
    const bbox = { left: 0, width: 100 }
    const { wavesurfer } = createWaveSurfer(container, 20, bbox)

    const plugin = HoverPlugin.create({ formatTimeCallback: (seconds: number) => seconds.toFixed(2) })
    plugin._init(wavesurfer as any)
    const label = container.querySelector<HTMLElement>('[part="hover-label"]')!

    container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 25 }))
    expect(label.textContent).toBe('5.00')
    expect(offsetWidth).toHaveBeenCalledTimes(1)

    // The text follows the scroll but keeps its length, so the width is reused
    bbox.left = -10
    wavesurfer.emit('scroll')
    expect(label.textContent).toBe('7.00')
    bbox.left = -20
    wavesurfer.emit('zoom')
    expect(label.textContent).toBe('9.00')
    expect(offsetWidth).toHaveBeenCalledTimes(1)

    // A longer text is measured again
    bbox.left = -30
    wavesurfer.emit('scroll')
    expect(label.textContent).toBe('11.00')
    expect(offsetWidth).toHaveBeenCalledTimes(2)

    // And so is every pointer move
    container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 26 }))
    expect(label.textContent).toBe('11.20')
    expect(offsetWidth).toHaveBeenCalledTimes(3)
  })

  test('passes the current wavesurfer duration to formatTimeCallback', () => {
    const container = document.createElement('div')
    const formatTimeCallback = jest.fn((seconds: number) => `${seconds}`)
    const { wavesurfer } = createWaveSurfer(container, 0)

    const plugin = HoverPlugin.create({ formatTimeCallback })
    plugin._init(wavesurfer as any)

    wavesurfer.getDuration.mockReturnValue(12)

    container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50 }))

    expect(formatTimeCallback).toHaveBeenCalledWith(6)
    expect(container.querySelector('[part="hover-label"]')?.textContent).toBe('6')
  })

  test('keeps the hover line hidden after pointerleave when duration updates', () => {
    const container = document.createElement('div')
    const formatTimeCallback = jest.fn((seconds: number) => `${seconds}`)
    const { duration, wavesurfer } = createWaveSurfer(container, 10)

    const plugin = HoverPlugin.create({ formatTimeCallback })
    plugin._init(wavesurfer as any)

    container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50 }))

    const hover = container.querySelector<HTMLElement>('[part="hover"]')

    expect(hover?.style.opacity).toBe('1')
    expect(formatTimeCallback).toHaveBeenCalledTimes(1)

    container.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))

    expect(hover?.style.opacity).toBe('0')
    // transform is cleared after the opacity transition ends, not immediately
    hover?.dispatchEvent(new Event('transitionend'))
    expect(hover?.style.transform).toBe('')

    duration.set(12)

    expect(hover?.style.opacity).toBe('0')
    expect(hover?.style.transform).toBe('')
    expect(formatTimeCallback).toHaveBeenCalledTimes(1)
  })

  test('positions the hover line with a string lineWidth instead of producing NaN math', () => {
    const container = document.createElement('div')
    const { wavesurfer } = createWaveSurfer(container, 10)

    const plugin = HoverPlugin.create({ lineWidth: '2px' })
    plugin._init(wavesurfer as any)

    // width is 100 (see createWaveSurfer); posX = min(100 - 2 - 1, 99) = 97.
    // With the documented string form, `100 - '2px' - 1` is NaN and the line
    // was positioned at translateX(NaNpx).
    container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 99 }))

    const hover = container.querySelector<HTMLElement>('[part="hover"]')
    expect(hover?.style.transform).toBe('translateX(97px)')
    // The CSS border still uses the string verbatim
    expect(hover?.style.borderLeft).toContain('2px')
  })

  test('does not accumulate transitionend listeners across pointerleave events', () => {
    const container = document.createElement('div')
    const { wavesurfer } = createWaveSurfer(container, 10)

    const plugin = HoverPlugin.create()
    plugin._init(wavesurfer as any)

    const hover = container.querySelector<HTMLElement>('[part="hover"]')!
    const addSpy = jest.spyOn(hover, 'addEventListener')
    const removeSpy = jest.spyOn(hover, 'removeEventListener')

    for (let i = 0; i < 5; i++) {
      container.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    }

    const added = addSpy.mock.calls.filter(([type]) => type === 'transitionend').length
    const removed = removeSpy.mock.calls.filter(([type]) => type === 'transitionend').length
    expect(added - removed).toBeLessThanOrEqual(1)
  })
})
