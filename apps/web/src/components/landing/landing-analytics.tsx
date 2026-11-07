"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import {
  createClient,
  ApiError,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import { parseProductAnalyticsConfig } from "../product-analytics";
import { useProductAnalytics } from "../use-product-analytics";
import {
  captureLandingAttribution,
  type LandingVersion,
} from "./landing-attribution";

/** Public-only adapter; the product retains its private-DOM/session checks. */
export function LandingAnalytics({ variant }: { variant: LandingVersion }) {
  const lifetime = useRef<AbortController | null>(null);
  const [idleSignal] = useState(() => new AbortController().signal);
  const [session, setSession] = useState<{
    ready: boolean;
    ownerId: string | null;
    role?: string;
    blocked: boolean;
    signal?: AbortSignal;
  }>({ ready: false, ownerId: null, blocked: true });
  const client = useMemo(
    () =>
      createClient("/api", {
        signal: () => lifetime.current?.signal ?? idleSignal,
      }),
    [idleSignal],
  );
  useEffect(() => {
    captureLandingAttribution(variant);
    // No raw query, search term, incoming URL or arbitrary fragment reaches
    // the SDK. Campaign slugs were extracted in memory before this cleanup.
    history.replaceState(history.state, "", location.pathname);
    let disposed = false;
    const probe = () => {
      if (disposed) return;
      lifetime.current?.abort();
      const current = new AbortController();
      lifetime.current = current;
      setSession({
        ready: false,
        ownerId: null,
        blocked: true,
        signal: current.signal,
      });
      const valid = () =>
        !disposed && !current.signal.aborted && lifetime.current === current;
      void client
        .dashboard()
        .then((board) => {
          if (valid())
            setSession({
              ready: true,
              ownerId: board.user.id,
              role: board.user.role,
              blocked:
                board.user.role !== "user" ||
                !!board.user.mustChangePassword ||
                !!board.user.serviceConsentRequired,
              signal: current.signal,
            });
        })
        .catch((error) => {
          if (valid() && error instanceof ApiError && error.status === 401)
            setSession({
              ready: true,
              ownerId: null,
              blocked: false,
              signal: current.signal,
            });
        });
    };
    const unsubscribe = subscribeBrowserSessionChange(probe);
    window.addEventListener("focus", probe);
    probe();
    return () => {
      disposed = true;
      lifetime.current?.abort();
      unsubscribe();
      window.removeEventListener("focus", probe);
    };
  }, [variant, client]);
  useProductAnalytics({
    config: parseProductAnalyticsConfig({
      enabled: process.env.NEXT_PUBLIC_CITYGO_METRIKA_ENABLED,
      counterId: process.env.NEXT_PUBLIC_CITYGO_METRIKA_COUNTER_ID,
      webvisor: process.env.NEXT_PUBLIC_CITYGO_METRIKA_WEBVISOR,
    }),
    ownerId: session.ownerId,
    role: session.role,
    blocked: !session.ready || session.blocked,
    surface: "landing",
    sessionSignal: session.signal ?? idleSignal,
    client,
    publicLandingVersion: variant,
  });
  return null;
}
