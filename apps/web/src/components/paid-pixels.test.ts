import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaidPixelBridge,
  paidPixelUrlAllowed,
  parsePaidPixelConfig,
} from "./paid-pixels";

const origin = "https://pilot.xn--c1ajazlh.xn--p1ai";
const url =
  origin +
  "/landing/v1?utm_source=vk&utm_medium=cpc&utm_campaign=v1_moscow_202611&utm_content=family_square";
const config = { enabled: true, vkPixelId: 3812681, avitoCounterId: 3496456 };

function fixture() {
  const sent: unknown[][] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  let attached = false;
  const child = { postMessage: (...args: unknown[]) => sent.push(args) };
  const frame = {
    contentWindow: child,
    hidden: false,
    title: "",
    referrerPolicy: "",
    src: "",
    attributes: {} as Record<string, string>,
    onload: null as (() => void) | null,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    remove() {
      attached = false;
    },
  };
  const host = {
    location: { origin },
    crypto: { randomUUID: () => "123e4567-e89b-42d3-a456-426614174001" },
    document: {
      createElement: () => frame,
      body: {
        append: () => {
          attached = true;
        },
      },
    },
    addEventListener: (_: string, fn: (event: MessageEvent) => void) =>
      listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MessageEvent) => void) =>
      listeners.delete(fn),
  } as unknown as Window;
  const dispatch = (data: unknown, source: unknown = child, from = origin) => {
    for (const listener of listeners)
      listener({ data, source, origin: from } as MessageEvent);
  };
  const ready = {
    type: "citygo-paid-ready",
    version: 1,
    channel: "123e4567-e89b-42d3-a456-426614174001",
  };
  return {
    host,
    frame,
    sent,
    dispatch,
    ready,
    listeners,
    attached: () => attached,
  };
}

test("paid counters require explicit switch and numeric public IDs", () => {
  assert.equal(parsePaidPixelConfig({ vkPixelId: "3812681" }).enabled, false);
  assert.equal(parsePaidPixelConfig({ enabled: "enabled" }).enabled, false);
  assert.deepEqual(
    parsePaidPixelConfig({
      enabled: "enabled",
      vkPixelId: "3812681",
      avitoCounterId: "3496456",
    }),
    config,
  );
  for (const bad of [
    "0",
    "https://private.invalid",
    "1.5",
    "01",
    "-1",
    "1e4",
    "99999999999",
  ])
    assert.equal(
      parsePaidPixelConfig({ enabled: "enabled", vkPixelId: bad }).enabled,
      false,
    );
});

test("only bounded, same-origin public campaign URLs enter the child", () => {
  assert.equal(paidPixelUrlAllowed(url, origin), true);
  assert.equal(paidPixelUrlAllowed(origin + "/", origin), true);
  assert.equal(
    paidPixelUrlAllowed(
      origin + "/?utm_campaign=123456&utm_content=family.v1",
      origin,
    ),
    true,
  );
  for (const value of [
    "https://other.invalid/landing/v1",
    origin + "/admin",
    origin + "/api/dashboard",
    origin + "/?email=private@example.test",
    origin + "/?utm_content=private@example.test",
    origin + "/?phone=79999999999",
    origin + "/?utm_content=family%0A",
    origin + "/?utm_content=x&utm_content=y",
    origin + "/?utm_content=" + "x".repeat(81),
    origin + "/#private",
    origin + "/?otp=123456",
    "not a URL",
  ])
    assert.equal(paidPixelUrlAllowed(value, origin), false, value);
});

test("disabled/private config creates no document and emits no commands", () => {
  for (const [settings, target] of [
    [{ ...config, enabled: false }, url],
    [config, origin + "/admin"],
  ] as const) {
    const f = fixture(),
      bridge = createPaidPixelBridge(settings, target, f.host);
    assert.equal(bridge.start(), false);
    assert.equal(f.attached(), false);
    assert.equal(bridge.registrationCompleted("receipt"), false);
    assert.equal(f.sent.length, 0);
  }
});

test("one confirmed receipt waits for exact child ready; private content never crosses", () => {
  const f = fixture(),
    bridge = createPaidPixelBridge(config, url, f.host);
  assert.equal(bridge.start(), true);
  assert.equal(bridge.start(), true);
  assert.equal(f.frame.referrerPolicy, "no-referrer");
  assert.equal(f.frame.attributes.sandbox, "allow-scripts allow-same-origin");
  assert.equal(bridge.registrationCompleted("auth:memory-only"), true);
  assert.equal(bridge.registrationCompleted("auth:memory-only"), false);
  f.frame.onload?.();
  assert.equal(f.sent.length, 1);
  f.dispatch(f.ready, {}, origin);
  f.dispatch(f.ready, undefined, "https://other.invalid");
  f.dispatch({ ...f.ready, email: "private@example.test" });
  f.dispatch({ ...f.ready, channel: "wrong" });
  assert.equal(f.sent.length, 1);
  f.dispatch(f.ready);
  f.dispatch(f.ready);
  assert.equal(f.sent.length, 2);
  const [init, goal] = f.sent.map((row) => row[0]) as Record<string, unknown>[];
  assert(init && goal);
  assert.equal(init.url, url);
  assert.deepEqual(init.config, {
    vkPixelId: 3812681,
    avitoCounterId: 3496456,
  });
  assert.deepEqual(Object.keys(goal).sort(), ["channel", "type", "version"]);
  assert(!JSON.stringify(f.sent).includes("auth:memory-only"));
  bridge.stop();
  assert.equal(f.attached(), false);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.frame.onload, null);
  f.dispatch(f.ready);
  assert.equal(bridge.registrationCompleted("late"), false);
  assert.equal(f.sent.length, 2);
});

test("departure before SDK readiness discards the goal instead of reviving it", () => {
  const f = fixture(),
    bridge = createPaidPixelBridge(config, url, f.host);
  bridge.start();
  bridge.registrationCompleted("receipt");
  const oldLoad = f.frame.onload;
  bridge.stop();
  oldLoad?.();
  f.dispatch(f.ready);
  assert.deepEqual(f.sent, []);
});
