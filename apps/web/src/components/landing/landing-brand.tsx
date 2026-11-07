import Image from "next/image";

export function LandingBrand({
  width = 170,
  className,
}: {
  width?: number;
  className?: string;
}) {
  return (
    <Image
      src="/landing/brand-logo.png"
      width={width}
      height={width / 4.8}
      alt="Ситиго"
      className={className}
      unoptimized
    />
  );
}
