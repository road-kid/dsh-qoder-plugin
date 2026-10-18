/**
 * Unit tests for the 「模型」 pane.
 *
 * The pane is the staged half of model settings: it must never write while the
 * user toggles or drags (the page batches the network writes behind one save),
 * and it must re-base its draft when the catalogue/persisted snapshot changes.
 * react-test-renderer keeps these assertions on the component tree, so the
 * checkbox/slider host handlers are exercised directly — no DOM needed.
 */
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelsPane, type ModelsDraft, type ModelsPaneProps } from '../src/client/ModelsPane.tsx'
import { QdpSlider } from '../src/client/controls.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QoderCatalogModelSnapshot } from '../src/status-paths.ts'

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

/** Qoder catalogue model with an explicit window list; rate omitted unless given. */
function modelOf(
  id: string,
  name: string,
  windows: readonly number[],
  priceFactor?: number,
): QoderCatalogModelSnapshot {
  const baseWindow = windows[0] ?? 200_000
  return {
    id,
    name,
    contextWindow: baseWindow,
    defaultContextWindow: baseWindow,
    supportedContextWindows: windows,
    ...(priceFactor === undefined ? {} : { priceFactor }),
  }
}

const LITE = modelOf('lite', 'Qoder Lite', [200_000, 400_000])
const PERFORMANCE = modelOf('performance', 'Qoder Performance', [200_000, 1_000_000])
const AUTO = modelOf('auto', 'Qoder Auto', [200_000, 400_000, 1_000_000])

/** Roster handed in upstream order; the pane preserves it verbatim. */
const ROSTER = [LITE, PERFORMANCE, AUTO]

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`)
  return value
}

describe('models pane', () => {
  let view: ReactTestRenderer | undefined
  let props: ModelsPaneProps
  let saves: ModelsDraft[]
  let refreshes: number

  afterEach(() => {
    act(() => view?.unmount())
    view = undefined
  })

  function makeProps(overrides: Partial<ModelsPaneProps> = {}): ModelsPaneProps {
    const base: ModelsPaneProps = {
      models: ROSTER,
      t,
      onSave: draft => { saves.push(draft) },
      onRefreshModels: () => { refreshes += 1 },
    }
    return { ...base, ...overrides }
  }

  async function mount(overrides: Partial<ModelsPaneProps> = {}): Promise<void> {
    saves = []
    refreshes = 0
    props = makeProps(overrides)
    const previous = view
    await act(async () => {
      previous?.unmount()
      view = create(createElement(ModelsPane, props))
    })
  }

  /** Re-render with the same base props plus a patch, like the page would. */
  async function setProps(patch: Partial<ModelsPaneProps>): Promise<void> {
    props = { ...props, ...patch }
    await act(async () => { mustRenderer().update(createElement(ModelsPane, props)) })
  }

  function mustRenderer(): ReactTestRenderer {
    return must(view, 'models pane mounted')
  }

  function hosts(match: (node: ReactTestInstance) => boolean): ReactTestInstance[] {
    return mustRenderer().root.findAll(node => typeof node.type === 'string' && match(node))
  }

  function text(node: ReactTestInstance): string {
    return node.children.map(child => (typeof child === 'string' ? child : text(child))).join('')
  }

  function rows(): ReactTestInstance[] {
    return hosts(node => node.props.className === 'qdp-modelRow')
  }

  function row(modelId: string): ReactTestInstance {
    return must(rows().find(node => node.props['data-model-id'] === modelId), `row for ${modelId}`)
  }

  function checkbox(modelId: string): ReactTestInstance {
    return must(
      row(modelId).findAll(node => node.type === 'input' && node.props.type === 'checkbox')[0],
      `checkbox for ${modelId}`,
    )
  }

  function slider(modelId: string): ReactTestInstance {
    return must(row(modelId).findAll(node => node.props.role === 'slider')[0], `slider for ${modelId}`)
  }

  /** Tick labels under a row's track, active class included in `className`. */
  function ticks(modelId: string): ReactTestInstance[] {
    return row(modelId).findAll(node =>
      typeof node.type === 'string'
      && typeof node.props.className === 'string'
      && node.props.className.split(' ').includes('qdp-windowTick'))
  }

  function saveBar(): ReactTestInstance | undefined {
    return hosts(node => node.props.className === 'qdp-saveBar')[0]
  }

  function button(testId: string): ReactTestInstance {
    return must(
      hosts(node => node.type === 'button' && node.props['data-testid'] === testId)[0],
      `button ${testId}`,
    )
  }

  async function toggle(modelId: string): Promise<void> {
    const input = checkbox(modelId)
    await act(async () => {
      input.props.onChange({ currentTarget: { checked: !input.props.checked } })
    })
  }

  async function pressArrowRight(modelId: string): Promise<void> {
    const input = slider(modelId)
    await act(async () => {
      input.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} })
    })
  }

  async function pressArrowLeft(modelId: string): Promise<void> {
    const input = slider(modelId)
    await act(async () => {
      input.props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} })
    })
  }

  it('renders one row per model in upstream order on one shared absolute axis', async () => {
    await mount()

    // No re-sorting: the pane displays the roster exactly as upstream ordered
    // it (the API payload already matches the official GUI).
    expect(rows().map(node => node.props['data-model-id'])).toEqual(['lite', 'performance', 'auto'])
    // The name is a second label for the same checkbox: the checkbox has a
    // stable id and the visible name targets it (clicking the name toggles).
    expect(checkbox('auto').props.id).toBe('qdp-model-auto')
    const nameLabel = must(hosts(node => node.props.htmlFor === 'qdp-model-auto')[0], 'name label')
    expect(text(nameLabel)).toBe('Qoder Auto')
    const header = text(must(hosts(node => node.props.className === 'qdp-modelColumns')[0], 'column header'))
    expect(header).toContain(en.modelNameColumn)
    expect(header).toContain(en.contextHeading)

    // The axis is global: min = narrowest declared window, max = widest.
    for (const id of ['auto', 'performance', 'lite']) {
      expect(slider(id).props['aria-valuemin']).toBe(200_000)
      expect(slider(id).props['aria-valuemax']).toBe(1_000_000)
      expect(slider(id).props['aria-valuenow']).toBe(200_000)
      expect(slider(id).props['aria-valuetext']).toBe('200K')
    }
    // Ticks are exactly the tiers the model offers — the shared axis ends are
    // not added (that extra minimum label used to sit on top of a row whose
    // narrowest offer was 272K) — and the tier in force is the dark one.
    expect(ticks('auto').map(node => text(node))).toEqual(['200K', '400K', '1M'])
    expect(ticks('auto').map(node => node.props.className.split(' ').includes('qdp-windowTickActive')))
      .toEqual([true, false, false])

    expect(saveBar()).toBeUndefined()
    expect(saves).toHaveLength(0)
  })

  it('draws only the tiers a row offers, so a 272K row stays readable', async () => {
    // The international roster's Performance model declares 272K / 400K / 1M
    // while the shared minimum is 200K: drawing the axis minimum as an extra
    // label put 「200K」 straight on top of the row's own 「272K」 label.
    const globalPerformance = modelOf('performance', 'Qoder Performance', [272_000, 400_000, 1_000_000])
    await mount({ models: [AUTO, globalPerformance] })

    expect(ticks('performance').map(node => text(node))).toEqual(['272K', '400K', '1M'])
    expect(slider('performance').props['aria-valuenow']).toBe(272_000)
    expect(ticks('performance')[0]?.props.className).toContain('qdp-windowTickActive')
    // The shared scale still spans the roster: its left end is the narrowest offer.
    expect(slider('performance').props['aria-valuemin']).toBe(200_000)
  })

  it('labels each model’s reasoning efforts and calls out the upstream default', async () => {
    await mount({
      models: [
        { ...AUTO, reasoningEfforts: ['low', 'medium', 'xhigh'], defaultReasoningEffort: 'medium' },
        LITE,
      ],
    })
    const autoText = text(row('auto'))
    expect(autoText).toContain(t('modelEfforts', {
      levels: `${t('effortLow')} · ${t('effortMedium')} · ${t('effortXhigh')}`,
    }))
    expect(autoText).toContain(t('modelEffortsDefault', { name: t('effortMedium') }))
    // The tag follows the id chip, so the tiers sit to the right of the model's
    // name; a model that advertises no efforts says so instead of drawing
    // nothing at all.
    expect(autoText.indexOf('auto')).toBeLessThan(autoText.indexOf('Efforts:'))
    expect(text(row('lite'))).toContain(en.effortsUnsupported)
    expect(text(row('lite'))).not.toContain('Efforts:')
  })

  it('keeps the effort vocabulary English in the Chinese UI', async () => {
    /** Same substitution as the pane's `t`, but reading the Chinese dictionary. */
    const tZh = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
      Object.entries(params).reduce(
        (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
        zh[key] as string,
      )
    await mount({
      models: [
        { ...AUTO, reasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'max' },
        LITE,
      ],
      t: tZh,
    })
    // Wire ids are model parameters, not translated UI words: the official
    // Qoder app lists the same levels, and a translated tag read
    // 「思考：高 · 最大（默认最大）」.
    expect(text(row('auto'))).toContain('Efforts: high · max (default max)')
    expect(text(row('auto'))).not.toMatch(/[\u4e00-\u9fff]/)
    expect(text(row('lite'))).toContain('not supported')
  })

  it('bounds the roster in a scroll region with the sticky header inside it', async () => {
    await mount()

    const scroll = must(hosts(node => node.props.className === 'qdp-modelScroll')[0], 'scroll region')
    // The sticky header must be inside the scroller: that is what keeps the
    // columns labelled while a long roster scrolls under it.
    expect(scroll.findAll(node => node.props.className === 'qdp-modelColumns')).toHaveLength(1)
    for (const id of ['auto', 'performance', 'lite']) {
      expect(scroll.findAll(node => node.props['data-model-id'] === id)).toHaveLength(1)
    }

    // No scroller for the empty state: the hint is a plain sibling of the bar.
    await mount({ models: [] })
    expect(hosts(node => node.props.className === 'qdp-modelScroll')).toHaveLength(0)
    expect(text(must(hosts(node => node.props.className === 'qdp-empty')[0], 'empty hint'))).toBe(en.modelsNoModels)

    // The save bar is outside the scroller (it must not scroll out of reach).
    await mount()
    await toggle('auto')
    expect(saveBar()).toBeDefined()
    const scroller = must(hosts(node => node.props.className === 'qdp-modelScroll')[0], 'scroll region')
    expect(scroller.findAll(node => node.props.className === 'qdp-saveBar')).toHaveLength(0)
  })

  it('reflects the persisted disabled set, the rate tag and the empty roster', async () => {
    const priced = { ...AUTO, priceFactor: 0.5 }
    await mount({ models: [LITE, priced], disabledModels: ['lite'] })

    expect(checkbox('auto').props.checked).toBe(true)
    expect(checkbox('lite').props.checked).toBe(false)
    expect(row('lite').props['aria-disabled']).toBe(true)
    expect(row('auto').props['aria-disabled']).toBeUndefined()
    expect(text(row('auto'))).toContain('0.5x')

    await mount({ models: [] })
    expect(rows()).toHaveLength(0)
    expect(text(must(hosts(node => node.props.className === 'qdp-empty')[0], 'empty hint'))).toBe(en.modelsNoModels)
    expect(saveBar()).toBeUndefined()
  })

  it('stages toggles in place: the dirty bar appears and no save happens by itself', async () => {
    await mount()

    await toggle('auto')

    expect(saves).toHaveLength(0)
    expect(refreshes).toBe(0)
    const bar = must(saveBar(), 'dirty save bar')
    expect(text(bar)).toContain(t('modelsUnsavedCount', { count: 1 }))
    expect(text(bar)).toContain(en.modelsBatchSaveHint)
    expect(text(bar)).toContain(en.cancelChanges)
    expect(text(bar)).toContain(en.saveChanges)
    expect(checkbox('auto').props.checked).toBe(false)
    expect(row('auto').props['aria-disabled']).toBe(true)
  })

  it('saves the whole disabled set plus only the window diffs', async () => {
    await mount({ disabledModels: ['lite'] })

    await toggle('auto') // now disabled = lite + auto
    await pressArrowRight('auto') // 200K -> 400K (snaps to the declared windows)

    expect(slider('auto').props['aria-valuetext']).toBe('400K')
    expect(saves).toHaveLength(0)

    await act(async () => { button('qdp-models-save').props.onClick() })

    expect(saves).toEqual([{ disabled: ['auto', 'lite'], windows: { auto: 400_000 } }])
    expect(refreshes).toBe(0)
  })

  it('snaps keyboard moves to the declared windows and falls back to the step', async () => {
    await mount({ models: [AUTO] }) // declares exactly 200K / 400K / 1M

    // The control is anchored to the windows this row offers, nothing else.
    const autoSlider = must(mustRenderer().root.findAllByType(QdpSlider)[0], 'auto slider')
    expect(autoSlider.props.snapTo).toEqual([200_000, 400_000, 1_000_000])
    expect(slider('auto').props['aria-valuenow']).toBe(200_000)

    await pressArrowRight('auto')
    expect(slider('auto').props['aria-valuenow']).toBe(400_000)
    expect(slider('auto').props['aria-valuetext']).toBe('400K')
    await pressArrowRight('auto')
    expect(slider('auto').props['aria-valuenow']).toBe(1_000_000)
    expect(slider('auto').props['aria-valuetext']).toBe('1M')
    await pressArrowLeft('auto')
    expect(slider('auto').props['aria-valuenow']).toBe(400_000)

    // Saving sends the snapped value, never an interpolated one.
    await act(async () => { button('qdp-models-save').props.onClick() })
    expect(saves).toEqual([{ disabled: [], windows: { auto: 400_000 } }])

    // A single fixed window offers no alternative: the row shows the number
    // instead of a slider, so no interpolated size can ever be staged.
    const fixedWindow: QoderCatalogModelSnapshot = { id: 'auto', name: 'Qoder Auto', contextWindow: 200_000 }
    await mount({ models: [fixedWindow, PERFORMANCE] })
    expect(row('auto').findAll(node => node.props.role === 'slider')).toHaveLength(0)
    expect(text(row('auto'))).toContain('200K')
  })

  it('returns a window dragged back to its baseline to the diff', async () => {
    await mount()

    await pressArrowRight('performance') // declares 200K / 1M, so it snaps to 1M
    expect(slider('performance').props['aria-valuetext']).toBe('1M')
    await act(async () => {
      slider('performance').props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} })
    })
    expect(slider('performance').props['aria-valuetext']).toBe('200K')

    // Back at baseline => no window change, so no dirty state and no bar.
    expect(saveBar()).toBeUndefined()
    expect(saves).toHaveLength(0)
  })

  it('cancel drops the draft and restores the props baseline', async () => {
    await mount({ disabledModels: ['lite'] })

    await toggle('auto')
    await pressArrowRight('auto')
    expect(saveBar()).toBeDefined()

    await act(async () => { button('qdp-models-cancel').props.onClick() })

    expect(saves).toHaveLength(0)
    expect(saveBar()).toBeUndefined()
    expect(checkbox('auto').props.checked).toBe(true)
    expect(slider('auto').props['aria-valuetext']).toBe('200K')
  })

  it('re-bases the draft when the props snapshot changes', async () => {
    await mount()

    await toggle('auto')
    expect(saveBar()).toBeDefined()

    // A catalogue reload that applied an override for auto: default stays 200K,
    // the effective window is now 400K. The pane must trust the props again.
    const appliedOverride: QoderCatalogModelSnapshot = {
      id: 'auto',
      name: 'Qoder Auto',
      contextWindow: 400_000,
      defaultContextWindow: 200_000,
      supportedContextWindows: [200_000, 400_000, 1_000_000],
    }
    await setProps({ models: [LITE, PERFORMANCE, appliedOverride] })

    expect(saveBar()).toBeUndefined()
    expect(checkbox('auto').props.checked).toBe(true)
    expect(slider('auto').props['aria-valuetext']).toBe('400K')
  })

  it('saving disables the controls and shows the in-flight label', async () => {
    await mount()
    await toggle('auto')

    await setProps({ saving: true })

    const save = button('qdp-models-save')
    expect(save.props.disabled).toBe(true)
    expect(text(save)).toBe(en.savingChanges)
    expect(button('qdp-models-cancel').props.disabled).toBe(true)
    expect(checkbox('auto').props.disabled).toBe(true)
    expect(slider('auto').props['aria-disabled']).toBe(true)
  })

  it('renders a save error inline in the bar', async () => {
    await mount({ saveError: 'socket died' })

    const alert = must(hosts(node => node.props.role === 'alert')[0], 'inline save error')
    expect(alert.props.className).toBe('qdp-alert qdp-alertError')
    expect(text(alert)).toBe(t('modelsSaveFailed', { message: 'socket died' }))
    expect(saveBar()).toBeDefined()
  })
})
