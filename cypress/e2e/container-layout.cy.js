// A waveform that fills its parent but overflows it must not widen the container it sits in. In a
// container that can shrink, such as a flex item, it used to: the container grew to fit the waveform, the
// resize observer re-rendered at the new width where the waveform no longer overflowed, the container
// shrank back, and the waveform flickered in a loop (#4055). jsdom does no layout, so this needs a browser.

const rowWidth = 600
const buttonWidth = 40
// 26 seconds at 400px per second is 10400px: far wider than the row
const duration = 26
const peaks = [Array.from({ length: 2000 }, (_, i) => Math.sin(i / 3))]

describe('Waveform in a flex container', () => {
  beforeEach(() => {
    cy.visit('cypress/e2e/index.html')
    cy.window().its('WaveSurfer').should('exist')
  })

  // A flex row with the waveform's container as an item (`flex: 1` unless told otherwise) next to a button
  const createInFlexRow = (win, options = {}, itemStyle = 'flex:1') => {
    const row = win.document.createElement('div')
    row.id = 'flexRow'
    row.style.cssText = `display:flex;width:${rowWidth}px`
    row.innerHTML = `<div id="flexWaveform" style="${itemStyle}"></div><button style="width:${buttonWidth}px">x</button>`
    win.document.body.appendChild(row)

    const wavesurfer = win.WaveSurfer.create({
      container: '#flexWaveform',
      height: 50,
      peaks,
      duration,
      minPxPerSec: 400,
      ...options,
    })
    return wavesurfer
  }

  // The scroll area inside the waveform's shadow root, and the sizes that matter
  const measure = (win) => {
    const item = win.document.querySelector('#flexWaveform')
    const scroll = item.firstElementChild.shadowRoot.querySelector('.scroll')
    return {
      itemWidth: item.offsetWidth,
      // the button can shrink too when the item does not, so its width is read, not assumed
      buttonWidth: win.document.querySelector('#flexRow button').offsetWidth,
      rowOverflows: win.document.querySelector('#flexRow').scrollWidth > rowWidth,
      scrolls: scroll.scrollWidth > scroll.clientWidth,
      contained: scroll.style.contain === 'inline-size',
    }
  }

  it('keeps the flex item at its own share of the row and scrolls the waveform inside it', () => {
    cy.window().then((win) => {
      createInFlexRow(win)

      // Retried until layout has settled
      cy.window().should((w) => {
        const { itemWidth, rowOverflows, scrolls } = measure(w)
        expect(itemWidth).to.equal(rowWidth - buttonWidth)
        expect(rowOverflows).to.equal(false)
        expect(scrolls).to.equal(true)
      })
    })
  })

  it('leaves a flex item that only shrinks to fit the waveform at the width its row gives it', () => {
    cy.window().then((win) => {
      // Not `flex: 1`: its width comes from the waveform, squeezed to fit the row, with a 100px floor
      createInFlexRow(win, {}, 'min-width:100px')

      cy.window().should((w) => {
        const { itemWidth, buttonWidth: button, rowOverflows, scrolls, contained } = measure(w)
        // The rest of the row, not the 100px floor that containing the waveform would leave it with
        expect(itemWidth).to.equal(rowWidth - button)
        expect(rowOverflows).to.equal(false)
        expect(scrolls).to.equal(true)
        expect(contained).to.equal(false)
      })
    })
  })

  it('does not keep re-rendering once it has settled', () => {
    cy.window().then((win) => {
      const wavesurfer = createInFlexRow(win)
      let redraws = 0
      wavesurfer.on('redraw', () => redraws++)

      cy.window().should((w) => expect(measure(w).scrolls).to.equal(true))
      // Let any resize-driven re-render finish, then check that nothing more happens
      cy.wait(400)
      cy.then(() => {
        const settled = redraws
        cy.wait(600).then(() => expect(redraws, 'redraws after it settled').to.equal(settled))
      })
    })
  })

  it('still lets a waveform that does not fill its parent size its container', () => {
    cy.window().then((win) => {
      createInFlexRow(win, { fillParent: false })

      // It has a width of its own, so the flex item grows to fit it
      cy.window().should((w) => expect(measure(w).itemWidth).to.be.greaterThan(rowWidth))
    })
  })
})
