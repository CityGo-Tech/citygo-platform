"use client";
import { useEffect, useState } from "react";
import { createClient } from "@citygo/api-client";
import type { ServiceConsentPolicy } from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import styles from "./legal.module.css";

/** Public current snapshot, including the server's current processing policy. */
export function CurrentConsentDocument({
  purpose,
  title,
}: {
  purpose: "personalData" | "marketing";
  title: string;
}) {
  const [policy, setPolicy] = useState<ServiceConsentPolicy | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPolicy(null);
    setError("");
    void createClient("/api", { signal: () => controller.signal })
      .legalConsentPolicy()
      .then((value) => {
        if (!controller.signal.aborted) setPolicy(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Не удалось загрузить актуальный документ. Проверьте связь и повторите.",
          );
      });
    return () => controller.abort();
  }, [purpose, revision]);
  return (
    <article className={styles.paper}>
      <h1>{title}</h1>
      {policy ? (
        <>
          <p className={styles.version}>Редакция {policy.version}</p>
          {policy[purpose].text.split("\n\n").map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </>
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          <Button onClick={() => setRevision((value) => value + 1)}>
            Обновить документ
          </Button>
        </>
      ) : (
        <p role="status">Загружаем актуальный документ…</p>
      )}
    </article>
  );
}
