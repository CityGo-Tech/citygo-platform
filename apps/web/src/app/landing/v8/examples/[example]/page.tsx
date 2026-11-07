import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LandingExample } from "../../../../../components/landing/landing-example";
import {
  landingExampleKeys,
  landingExamples,
  type LandingExampleKey,
} from "../../../../../components/landing/landing-example-data";
import { LandingExampleCapture } from "../../../../../components/landing/landing-example-capture";

export const dynamicParams = false;
export function generateStaticParams() {
  return landingExampleKeys.map((example) => ({ example }));
}
function isExample(value: string): value is LandingExampleKey {
  return landingExampleKeys.some((key) => key === value);
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ example: string }>;
}): Promise<Metadata> {
  const { example } = await params;
  if (!isExample(example)) notFound();
  return {
    title: `${landingExamples[example].title} — пример CityGo`,
    robots: { index: false, follow: true },
    referrer: "origin",
  };
}
export default async function LandingExamplePage({
  params,
}: {
  params: Promise<{ example: string }>;
}) {
  const { example } = await params;
  if (!isExample(example)) notFound();
  return (
    <>
      <LandingExample example={example} />
      <LandingExampleCapture />
    </>
  );
}
