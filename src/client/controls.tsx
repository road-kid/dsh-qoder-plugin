/**
 * The plugin's small in-house control set.
 *
 * Why not import `@deepseek-ai/dsh-client-ui-primitives`? That package renders
 * inside the host shell, where its dependencies are bundled; its published
 * `package.json` lists no runtime `dependencies` (only devDependencies and a
 * cordis peer), so importing it from an out-of-tree bundle works only in the
 * host, and fails in the plugin's own vitest run (`Cannot find package 'clsx'
 * imported from .../dsh-client-ui-primitives/lib/index.js`). A plugin that
 * cannot test what it ships is worse than one that owns three small controls.
 *
 * These controls reproduce the official geometry from ui-primitives
 * (docs/ui-radius.md, docs/web-styling.md): Button md 36px/R12 and sm
 * 28px/R8; a 36x20 switch with a 16px thumb; SegmentedControl with a 4px inset
 * track, R12 outer and R8 segments; 8px state dots; 20px tags; 32px/R12 text
 * inputs. Appearance lives in quota-styles.ts; semantics (roles, aria state,
 * keyboard) live here, so every surface answers the same way.
 */
import {
  useCallback,
  useMemo,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

/** Join class names, dropping falsey entries. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
}

/* ------------------------------------------------------------------ button */

export type QdpButtonVariant = 'outline' | 'ghost' | 'primary' | 'danger' | 'dangerQuiet'

export interface QdpButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual role; defaults to a neutral hairline button. */
  variant?: QdpButtonVariant
  /** `sm` (28px, settings rows) or `md` (36px, a leading CTA). */
  size?: 'sm' | 'md'
}

/** Hairline/secondary button; never styled with literal colours. */
export function QdpButton({
  variant = 'outline',
  size = 'sm',
  className,
  type = 'button',
  ...rest
}: QdpButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type}
      className={cx(
        'qdp-btn',
        size === 'md' && 'qdp-btnMd',
        variant === 'primary' && 'qdp-btnPrimary',
        variant === 'danger' && 'qdp-btnDanger',
        variant === 'dangerQuiet' && 'qdp-btnDangerQuiet',
        variant === 'ghost' && 'qdp-btnGhost',
        className,
      )}
    />
  )
}

/* ------------------------------------------------------------------ switch */

export interface QdpSwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name; the visible label is owned by the surrounding row. */
  label: string
  disabled?: boolean
  id?: string
}

/** 36x20 capsule switch; `role="switch"` so assistive tech reads on/off. */
export function QdpSwitch({ checked, onChange, label, disabled, id }: QdpSwitchProps): ReactNode {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="qdp-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="qdp-switchThumb" />
    </button>
  )
}

/* --------------------------------------------------------------- segmented */

export interface QdpSegmentedOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  /**
   * A control rendered BESIDE the tab (not inside it): the variant enable
   * checkbox. Interactive content cannot nest inside a `role="tab"` button,
   * so when this is present the tab and the control are wrapped in one cell
   * span; clicking the control must not actuate the tab (stopPropagation).
   */
  trailing?: ReactNode
}

export interface QdpSegmentedProps<T extends string> {
  /** Accessible name of the group. */
  label: string
  value: T
  options: ReadonlyArray<QdpSegmentedOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
}

/**
 * Segmented control on the official track geometry. Arrow/Home/End move the
 * selection (roving `tabIndex` keeps a single tab stop), and each option is a
 * real `role="tab"` so the existing tests' `aria-selected` assertions keep
 * meaning what they say.
 */
export function QdpSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: QdpSegmentedProps<T>): ReactNode {
  const index = options.findIndex(option => option.value === value)
  const active = index === -1 ? 0 : index
  const enabled = options.filter(option => option.disabled !== true)
  const select = useCallback(
    (next: QdpSegmentedOption<T> | undefined) => {
      if (next !== undefined && next.value !== value) onChange(next.value)
    },
    [onChange, value],
  )
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (enabled.length === 0) return
    const current = options[active]
    const at = current === undefined ? -1 : enabled.indexOf(current)
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      select(enabled[(at + 1) % enabled.length])
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      select(enabled[(at - 1 + enabled.length) % enabled.length])
    } else if (event.key === 'Home') {
      event.preventDefault()
      select(enabled[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      select(enabled[enabled.length - 1])
    }
  }
  return (
    <div role="tablist" aria-label={label} className="qdp-seg">
      {options.map(option => {
        const tab = (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={option.value === value}
            tabIndex={option.value === value ? 0 : -1}
            disabled={disabled === true || option.disabled === true}
            className={cx('qdp-segItem', option.value === value && 'qdp-segItemActive')}
            onClick={() => onChange(option.value)}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        )
        if (option.trailing === undefined) return tab
        return (
          <span key={option.value} className="qdp-segCell">
            {tab}
            {option.trailing}
          </span>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------- dots */

export type QdpDotState = 'idle' | 'ongoing' | 'done' | 'warn' | 'error'

/** 8px state dot; `label` makes it announced, otherwise it is decorative. */
export function QdpStateDot({ state, label }: { state: QdpDotState; label?: string }): ReactNode {
  const tone =
    state === 'done'
      ? 'qdp-dotDone'
      : state === 'ongoing'
        ? 'qdp-dotOngoing'
        : state === 'warn'
          ? 'qdp-dotWarn'
          : state === 'error'
            ? 'qdp-dotError'
            : undefined
  return <span className={cx('qdp-dot', tone)} aria-hidden={label === undefined ? true : undefined} aria-label={label} />
}

/* -------------------------------------------------------------------- tags */

export type QdpTagTone = 'neutral' | 'success' | 'warn' | 'error'

/** 20px read-only capsule for plan/status words. */
export function QdpTag({ tone = 'neutral', children }: { tone?: QdpTagTone; children: ReactNode }): ReactNode {
  return (
    <span
      className={cx(
        'qdp-tag',
        tone === 'success' && 'qdp-tagSuccess',
        tone === 'warn' && 'qdp-tagWarn',
        tone === 'error' && 'qdp-tagError',
      )}
    >
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------- input */

export interface QdpInputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** Single-line text field on the official 32px/R12 geometry. */
export function QdpInput({ className, ...rest }: QdpInputProps): ReactNode {
  return <input {...rest} className={cx('qdp-input', className)} />
}

/* -------------------------------------------------------------- icon button */

export interface QdpIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name of the icon-only action. */
  label: string
}

/** 28x28 icon-only button; the icon is the consumer's child. */
export function QdpIconButton({ label, className, type = 'button', ...rest }: QdpIconButtonProps): ReactNode {
  return <button {...rest} type={type} aria-label={label} title={label} className={cx('qdp-iconButton', className)} />
}

/* ------------------------------------------------------------------- slider */

export interface QdpSliderProps {
  /** Accessible name; the visible label is owned by the row. */
  label: string
  value: number
  min: number
  max: number
  /** Value granularity for pointer drags and arrow keys (default 1000). */
  step?: number
  disabled?: boolean
  /** Fires on every drag tick — consumers keep a local draft, never a write. */
  onChange: (value: number) => void
  /** Human-readable value for `aria-valuetext` (e.g. "200K"). */
  valueText?: string
  /** Marks drawn under the track (e.g. the catalog's supported windows). */
  ticks?: readonly number[]
  /** Tick/value formatter; defaults to `valueText` for the current value. */
  format?: (value: number) => string
  /**
   * Values a drag settles on when the pointer is released (the catalog's
   * declared context windows).
   *
   * While dragging the handle follows the pointer freely (quantized to `step`,
   * so the number on screen stays readable) — the "stepless" feel the model
   * slider had before. Only on release does the value snap to the NEAREST of
   * these offers, so the saved window is always one the upstream declares.
   * Arrow keys keep stepping through the offers directly.
   */
  snapTo?: readonly number[]
  /** Root `data-testid`, for tests that need to find the control. */
  testId?: string
}

/**
 * Context-window slider: a thick filled rail with a narrow vertical grab handle
 * at the fill's edge (the Qoder model-settings look). Pointer drags anywhere on
 * the surface jump and follow the pointer CONTINUOUSLY; arrows,
 * PageUp/PageDown and Home/End keep it keyboard operable. With `snapTo` the
 * value is snapped to the nearest offered window when the drag ENDS, so a
 * moving handle is a free position while a saved one is always an offer. The
 * component is fully controlled — it never writes anything by itself.
 */
export function QdpSlider({
  label,
  value,
  min,
  max,
  step = 1000,
  disabled,
  onChange,
  valueText,
  ticks,
  format,
  snapTo,
  testId,
}: QdpSliderProps): ReactNode {
  const formatValue = (raw: number): string => (
    format !== undefined ? format(raw) : (raw === value && valueText !== undefined ? valueText : String(raw))
  )
  const percentOf = (raw: number): number => (span > 0 ? Math.min(100, Math.max(0, ((raw - min) / span) * 100)) : 0)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const span = max > min ? max - min : 0
  const ratio = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0
  /** The offered values that actually fit the shared axis, ascending. */
  const anchors = useMemo(() => {
    if (snapTo === undefined || snapTo.length === 0) return undefined
    const inRange = snapTo
      .filter(candidate => Number.isFinite(candidate) && candidate >= min && candidate <= max)
      .slice()
      .sort((a, b) => a - b)
    return inRange.length > 0 ? inRange : undefined
  }, [max, min, snapTo])
  const snap = useCallback(
    (raw: number): number => {
      const clamped = Math.min(max, Math.max(min, raw))
      if (anchors !== undefined) {
        let best: number = anchors[0] ?? clamped
        for (const candidate of anchors) {
          if (Math.abs(candidate - clamped) < Math.abs(best - clamped)) best = candidate
        }
        return best
      }
      if (step <= 0) return clamped
      const stepped = min + Math.round((clamped - min) / step) * step
      return Math.min(max, Math.max(min, stepped))
    },
    [anchors, max, min, step],
  )
  /**
   * The value a live drag reports: clamped, then quantized to `step` only.
   *
   * Deliberately NOT `snap`: dragging must not jump between the offered
   * windows, or the handle feels ratcheted. `step` (1 000 tokens by default) is
   * fine enough that the movement reads as continuous, while keeping the
   * displayed number free of round-off noise.
   */
  const free = useCallback(
    (raw: number): number => {
      const clamped = Math.min(max, Math.max(min, raw))
      if (step <= 0) return clamped
      const stepped = min + Math.round((clamped - min) / step) * step
      return Math.min(max, Math.max(min, stepped))
    },
    [max, min, step],
  )
  /** Continuous position of the drag in flight; the release handler snaps it. */
  const lastRaw = useRef<number | undefined>(undefined)
  const fromClientX = useCallback(
    (clientX: number): void => {
      const element = trackRef.current
      if (element === null) return
      const rect = element.getBoundingClientRect()
      const share = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
      const raw = min + Math.min(1, Math.max(0, share)) * span
      // Remember the free position: the RELEASE handler is what snaps it.
      lastRaw.current = raw
      onChange(free(raw))
    },
    [free, min, onChange, span],
  )
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled === true) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    fromClientX(event.clientX)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled === true || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    fromClientX(event.clientX)
  }
  /**
   * End of drag: snap to the nearest offer.
   *
   * `lastRaw` is the continuous position the drag ended at, not `value` — the
   * controlled parent may still be rendering the previous tick when the release
   * lands, so reading the raw pointer position is what makes the snap land
   * where the user let go.
   */
  const release = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const raw = lastRaw.current
    lastRaw.current = undefined
    if (raw === undefined) return
    const snapped = snap(raw)
    if (snapped !== value) onChange(snapped)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled === true) return
    const big = step * 10
    /** The offer after (direction 1) or before (-1) the current value. */
    const neighbour = (direction: 1 | -1): number | undefined => {
      if (anchors === undefined) return snap(value + direction * step)
      const index = anchors.findIndex(candidate => candidate === value)
      if (index === -1) return snap(value)
      const nextIndex = Math.min(anchors.length - 1, Math.max(0, index + direction))
      return anchors[nextIndex] ?? snap(value)
    }
    let next: number | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = neighbour(1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = neighbour(-1)
    else if (event.key === 'PageUp') next = snap(value + big)
    else if (event.key === 'PageDown') next = snap(value - big)
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    if (next === undefined) return
    event.preventDefault()
    if (next !== value) onChange(next)
  }
  return (
    <div className="qdp-sliderField" data-testid={testId}>
      <div
        className="qdp-slider"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText ?? formatValue(value)}
        aria-disabled={disabled === true || undefined}
        tabIndex={disabled === true ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={onKeyDown}
      >
        <div className="qdp-sliderTrack" ref={trackRef}>
          <div className="qdp-sliderFill" style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
          <span className="qdp-sliderThumb" style={{ left: `${(ratio * 100).toFixed(2)}%` }} />
        </div>
      </div>
      {ticks !== undefined && ticks.length > 0 && (
        <div className="qdp-windowTicks">
          {ticks.map(tick => (
            <span key={tick} className="qdp-windowTick" style={{ left: `${percentOf(tick).toFixed(2)}%` }}>
              {formatValue(tick)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
