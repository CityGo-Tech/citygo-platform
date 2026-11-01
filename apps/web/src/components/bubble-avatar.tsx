import Image from "next/image";
import styles from "./bubble-avatar.module.css";

/** Exact three-layer Bubble avatar exported in Figma node 55:4985. */
export function BubbleAvatar({
  className = "",
  label = "Логотип Bubble",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={styles.avatar + " " + className}
      role="img"
      aria-label={label}
    >
      <Image
        className={styles.gradient}
        src="/figma/bubble-gradient.png"
        width={64}
        height={64}
        alt=""
      />
      <span className={styles.topFrame}>
        <span className={styles.topRotation}>
          {/* Keep the SVG's exact intrinsic dimensions, including its filter. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.topHighlight}
            src="/figma/bubble-highlight.svg"
            alt=""
          />
        </span>
      </span>
      <span className={styles.smallFrame}>
        {/* Keep the SVG's exact intrinsic dimensions, including its filter. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.smallHighlight}
          src="/figma/bubble-small-highlight.svg"
          alt=""
        />
      </span>
    </span>
  );
}
