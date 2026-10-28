import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard } from "@citygo/api-client";
import {
  CustomerReadDenied,
  readCustomerAsCurrentAdmin,
} from "./customer-explorer-read.js";

test("private explorer refuses a switched owner, downgraded role or required password change before reading", async () => {
  for (const user of [
    { id: "2", role: "super_admin" },
    { id: "1", role: "admin" },
    { id: "1", role: "user" },
    { id: "1" },
    { id: "1", role: "super_admin", mustChangePassword: true },
  ]) {
    let reads = 0;
    await assert.rejects(
      readCustomerAsCurrentAdmin({
        viewerId: "1",
        ticket: createSessionGuard().capture(),
        dashboard: async () => ({ user }),
        read: async () => {
          reads++;
          return "private";
        },
      }),
      CustomerReadDenied,
    );
    assert.equal(reads, 0);
  }
});

test("session reset while a private request is pending prevents its response from reaching the view", async () => {
  const guard = createSessionGuard();
  let finish!: (value: string) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const output = readCustomerAsCurrentAdmin({
    viewerId: "1",
    ticket: guard.capture(),
    dashboard: async () => ({ user: { id: "1", role: "super_admin" } }),
    read: () => {
      started();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  });
  await reading;
  guard.reset();
  finish("private response from old session");
  await assert.rejects(output);
});

test("current super admin receives the successful read without issuing a mutation", async () => {
  const value = { userId: "9", messages: [] };
  assert.equal(
    await readCustomerAsCurrentAdmin({
      viewerId: "1",
      ticket: createSessionGuard().capture(),
      dashboard: async () => ({ user: { id: "1", role: "super_admin" } }),
      read: async () => value,
    }),
    value,
  );
});
