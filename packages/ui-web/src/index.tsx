import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { useId } from "react";
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
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const hintId = useId();
  return (
    <label className="cg-field">
      <span>{label}</span>
      <input
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        {...props}
      />
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}
export function Badge({ children }: { children: ReactNode }) {
  return <span className="cg-badge">{children}</span>;
}
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="cg-progress">
      <span>{label}</span>
      <progress
        aria-label={label}
        max={100}
        value={Math.max(0, Math.min(100, value))}
      />
    </div>
  );
}
