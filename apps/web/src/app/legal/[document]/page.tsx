import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { serviceConsentPolicy } from "@citygo/contracts";
import styles from "../legal.module.css";

const documents = {
  "personal-data-consent": {
    title: "Согласие на обработку персональных данных",
    document: serviceConsentPolicy.personalData,
  },
  "marketing-consent": {
    title: "Согласие на рекламную рассылку",
    document: serviceConsentPolicy.marketing,
  },
};

function documentFor(slug: string) {
  if (!Object.hasOwn(documents, slug)) notFound();
  const entry = documents[slug as keyof typeof documents];
  return entry;
}

export function generateStaticParams() {
  return Object.keys(documents).map((document) => ({ document }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ document: string }>;
}): Promise<Metadata> {
  const entry = documentFor((await params).document);
  return { title: `${entry.title} — CityGo` };
}

export default async function ConsentDocument({
  params,
}: {
  params: Promise<{ document: string }>;
}) {
  const entry = documentFor((await params).document);
  return (
    <main className={styles.document}>
      <Link className={styles.brand} href="/">
        CityGo
      </Link>
      <article className={styles.paper}>
        <h1>{entry.title}</h1>
        <p className={styles.version}>
          Редакция {serviceConsentPolicy.version}
        </p>
        {entry.document.text.split("\n\n").map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </article>
      <Link className={styles.back} href="/">
        Вернуться в CityGo
      </Link>
    </main>
  );
}
