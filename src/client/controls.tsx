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
  /** Labelled tiers under the rail (e.g. the catalog's supported windows). */
  ticks?: readonly number[]
  /** Tick/value formatter; defaults to `valueText` for the current value. */
  format?: (value: number) => string
  /**
   * Values a drag settles on (the catalog's declared context windows).
   *
   * With offers the pointer moves tier by tier: every drag tick reports the
   * NEAREST offer, so the handle snaps between declared windows instead of
   * sliding through interpolated sizes (one slide, one context size). Arrow
   * keys step through the offers directly. Without offers the drag falls back
   * to `step` granularity.
   */
  snapTo?: readonly number[]
  /** Root `data-testid`, for tests that need to find the control. */
  testId?: string
}

/** Hairline marks under the rail — 33 marks, one every 3.125 % of the field. */
const SLIDER_RULER_MARKS = 33

/**
 * Context-window slider, replicating the Qoder model-settings control.
 *
 * Geometry follows the upstream component: a 56 px field whose 18 px rail sits
 * on the vertical centre and whose 12 px label row hangs 40 px below the field's
 * top, 33 hairlines along the rail (every eighth one taller and darker) and a
 * 2×12 px grab tick at the fill's edge. The scale starts at zero — a window's
 * position is `value / max`, so 200K sits at 20 % of a 1M axis exactly as in the
 * official table — and the rail itself stops at the widest offered window. Only
 * the offered windows carry a label (9 px, sitting on the field colour so the
 * hairlines pass behind); the one in force is the dark, medium-weight label.
 *
 * With `snapTo` a pointer drag moves the grab tick one tier at a time (it lands
 * only on the offered windows); without offers it follows the pointer quantized
 * to `step`. Arrows, PageUp/PageDown and Home/End keep it keyboard operable,
 * with arrows walking the offers one by one. The component is fully controlled —
 * it never writes anything by itself.
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
  /**
   * Position of a window on the field, in percent.
   *
   * The official control's axis starts at zero (`value / maxValue`), not at the
   * smallest window, so a 200K window covers the first fifth of a 1M axis on
   * every row and equal windows line up across rows.
   */
  const percentOf = (raw: number): number => (max > 0 ? Math.min(100, Math.max(0, (raw / max) * 100)) : 0)
  /** Label/tick transforms that keep the end marks inside the field. */
  const edgeTransform = (percent: number): string => (
    percent >= 99.5 ? 'translate(-100%, -50%)' : percent <= 0.5 ? 'translate(0, -50%)' : 'translate(-50%, -50%)'
  )
  const trackRef = useRef<HTMLDivElement | null>(null)
  const span = max > min ? max - min : 0
  /** The offered values that actually fit the shared axis, ascending. */
  const anchors = useMemo(() => {
    if (snapTo === undefined || snapTo.length === 0) return undefined
    const inRange = snapTo
      .filter(candidate => Number.isFinite(candidate) && candidate >= min && candidate <= max)
      .slice()
      .sort((a, b) => a - b)
    return inRange.length > 0 ? inRange : undefined
  }, [max, min, snapTo])
  /** Where the grab tick and the filled rail end. */
  const fillPercent = percentOf(value)
  /**
   * The rail stops at the widest offered window, not at the axis end: a row that
   * offers only 200K / 400K draws a shorter rail instead of empty track beyond
   * its last tier (the official control behaves the same way).
   */
  const railPercent = percentOf(anchors === undefined ? max : anchors[anchors.length - 1] ?? max)
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
   * The value a live drag reports.
   *
   * With `snapTo` the drag advances tier by tier: every pointer move reports the
   * nearest offered window, so the handle is never parked between two tiers
   * (one slide, one context size) and the number under it is always a window the
   * upstream declares. Without offers the drag is quantized to `step`, keeping
   * the displayed number free of round-off noise.
   */
  const free = useCallback(
    (raw: number): number => {
      if (anchors !== undefined) return snap(raw)
      const clamped = Math.min(max, Math.max(min, raw))
      if (step <= 0) return clamped
      const stepped = min + Math.round((clamped - min) / step) * step
      return Math.min(max, Math.max(min, stepped))
    },
    [anchors, max, min, snap, step],
  )
  /** Pointer position of the drag in flight, kept for the release settle. */
  const lastRaw = useRef<number | undefined>(undefined)
  const fromClientX = useCallback(
    (clientX: number): void => {
      const element = trackRef.current
      if (element === null) return
      const rect = element.getBoundingClientRect()
      const share = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
      const raw = min + Math.min(1, Math.max(0, share)) * span
      // Remember the pointer position, not the reported one: the release uses
      // it to settle on the offer the pointer ended nearest to.
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
   * End of drag: settle on the offer nearest the pointer.
   *
   * A drag that has offers already reports one on every move, so this only
   * matters for the last finger position: `lastRaw` is the pointer position the
   * drag ended at, not `value` — the controlled parent may still be rendering
   * the previous tick when the release lands.
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
        {/* The rail sits on the field's vertical centre; the label row hangs
            below it, both inside the focusable field like the upstream control. */}
        <div className="qdp-sliderTrack" ref={trackRef}>
          <div className="qdp-sliderRail" style={{ width: `${railPercent.toFixed(2)}%` }} />
          <div className="qdp-sliderFill" style={{ width: `${fillPercent.toFixed(2)}%` }} />
          <span className="qdp-sliderThumb" style={{ left: `calc(${fillPercent.toFixed(2)}% - 5px)` }} />
        </div>
        <div className="qdp-windowTicks">
          {/* Hairline ruler: 33 marks along the rail, every eighth one taller and
              darker, dropping off past the last offered window. */}
          {Array.from({ length: SLIDER_RULER_MARKS }, (_, index) => {
            const percent = (index / (SLIDER_RULER_MARKS - 1)) * 100
            if (percent > railPercent + 0.01) return null
            return (
              <span
                key={`mark-${index}`}
                aria-hidden="true"
                className={cx('qdp-windowTickMark', index % 8 === 0 && 'qdp-windowTickMarkMajor')}
                style={{ left: `${percent.toFixed(2)}%` }}
              />
            )
          })}
          {(ticks ?? []).map(tick => {
            const percent = percentOf(tick)
            return (
              <span
                key={tick}
                className={cx('qdp-windowTick', tick === value && 'qdp-windowTickActive')}
                style={{ left: `${percent.toFixed(2)}%`, transform: edgeTransform(percent) }}
              >
                {formatValue(tick)}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
