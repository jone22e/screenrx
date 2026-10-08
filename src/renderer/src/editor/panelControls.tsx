import type { ReactNode } from 'react'

/** Building blocks shared by the inspector's panels. */

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-title">
        {title}
        {aside && <span className="panel-title-aside">{aside}</span>}
      </h2>
      {children}
    </section>
  )
}

export function Slider(props: {
  label: string
  value: string
  min: number
  max: number
  step: number
  current: number
  onChange: (value: number) => void
  onCommit: () => void
}) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label} <strong>{props.value}</strong>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.current}
        onChange={(event) => props.onChange(Number(event.target.value))}
        onPointerUp={props.onCommit}
        onKeyUp={props.onCommit}
      />
    </label>
  )
}

export function Segmented<Value extends string>(props: {
  label: string
  value: Value
  options: ReadonlyArray<{ value: Value; label: string; icon?: ReactNode }>
  onChange: (value: Value) => void
}) {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((option) => (
          <button
            key={option.value}
            className="segment"
            role="radio"
            aria-checked={option.value === props.value}
            onClick={() => props.onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
