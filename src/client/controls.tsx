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
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
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
      {options.map(option => (
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
      ))}
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
