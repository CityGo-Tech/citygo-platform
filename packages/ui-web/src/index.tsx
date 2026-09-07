import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useId } from "react";
export { AssistantMessage } from "./assistant-message.js";
export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button
      className={"cg-button cg-button-" + variant + " " + className}
      {...props}
    />
  );
}
export function Card({
  className = "",
  ...props
}: HTMLAttributes<HTMLElement>) {
  return <section className={"cg-card " + className} {...props} />;
}
export function Field({
  label,
  hint,
  error,
  id,
  "aria-describedby": describedBy,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = inputId + "-hint";
  const errorId = inputId + "-error";
  return (
    <label className="cg-field" htmlFor={inputId}>
      <span id={inputId + "-label"}>{label}</span>
      <input
        {...props}
        id={inputId}
        aria-labelledby={props["aria-labelledby"] ?? inputId + "-label"}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={
          [describedBy, hint && hintId, error && errorId]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {hint && <small id={hintId}>{hint}</small>}
      {error && (
        <small id={errorId} className="cg-field-error">
          {error}
        </small>
      )}
    </label>
  );
}
export function SelectField({
  label,
  hint,
  children,
  id,
  "aria-describedby": describedBy,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = inputId + "-hint";
  return (
    <label className="cg-field" htmlFor={inputId}>
      <span id={inputId + "-label"}>{label}</span>
      <select
        {...props}
        id={inputId}
        aria-labelledby={props["aria-labelledby"] ?? inputId + "-label"}
        aria-describedby={
          [describedBy, hint && hintId].filter(Boolean).join(" ") || undefined
        }
      >
        {children}
      </select>
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}
export function RadioGroup({
  label,
  name,
  options,
  value,
  defaultValue,
  onChange,
  disabled,
  tone = "primary",
  hint,
}: {
  label: string;
  name: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  tone?: "primary" | "success";
  hint?: string;
}) {
  const hintId = useId();
  return (
    <fieldset
      className={"cg-radio-group cg-radio-" + tone}
      disabled={disabled}
      aria-describedby={hint ? hintId : undefined}
    >
      <legend>{label}</legend>
      <div className="cg-radio-options">
        {options.map((option) => (
          <label className="cg-radio-option" key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === undefined ? undefined : value === option.value}
              defaultChecked={
                value === undefined ? defaultValue === option.value : undefined
              }
              onChange={() => onChange?.(option.value)}
              disabled={option.disabled}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {hint && <small id={hintId}>{hint}</small>}
    </fieldset>
  );
}
export function Badge({
  children,
  tone = "primary",
}: {
  children: ReactNode;
  tone?: "primary" | "success";
}) {
  return <span className={"cg-badge cg-badge-" + tone}>{children}</span>;
}
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="cg-progress">
      <span>{label}</span>
      <progress
        aria-label={label}
        max={100}
        value={Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0}
      />
    </div>
  );
}
