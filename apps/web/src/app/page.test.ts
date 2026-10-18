import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { ApiError, createSessionGuard } from "@citygo/api-client";
import {
  createOwnerReceiptsResource,
  type OwnerReceiptsState,
} from "../components/owner-receipts-state.js";

const source = ts.createSourceFile(
  "page.tsx",
  readFileSync(new URL("./page.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function findAll(node: ts.Node, predicate: (node: ts.Node) => boolean) {
  const found: ts.Node[] = [];
  function visit(current: ts.Node) {
    if (predicate(current)) found.push(current);
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}
function isReceipts(node: ts.Node) {
  return (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(source) === "OwnerReceiptsPanel"
  );
}

test("home mounts owner receipts only after the password-change guard and an explicit opening, with the current owner lifetime", () => {
  const guard = findAll(
    source,
    (node) =>
      ts.isConditionalExpression(node) &&
      node.condition.getText(source) ===
        "board.user.mustChangePassword || passwordOpen",
  )[0];
  assert.ok(guard && ts.isConditionalExpression(guard));
  assert.equal(findAll(guard.whenTrue, isReceipts).length, 0);
  assert.equal(findAll(source, isReceipts).length, 1);
  const panel = findAll(guard.whenFalse, isReceipts)[0];
  assert.ok(panel && ts.isJsxSelfClosingElement(panel));
  const explicit = findAll(
    guard.whenFalse,
    (node) =>
      ts.isConditionalExpression(node) &&
      node.condition.getText(source) === "receiptsOpen",
  )[0];
  assert.ok(explicit && ts.isConditionalExpression(explicit));
  assert.equal(findAll(explicit.whenTrue, isReceipts).length, 1);
  assert.equal(findAll(explicit.whenFalse, isReceipts).length, 0);
  const attributes = Object.fromEntries(
    panel.attributes.properties.map((attribute) => {
      assert.ok(ts.isJsxAttribute(attribute));
      return [
        attribute.name.getText(source),
        attribute.initializer?.getText(source),
      ];
    }),
  );
  assert.equal(attributes.userId, "{board.user.id}");
  assert.equal(attributes.sessionSignal, "{session.capture().signal}");
  assert.equal(attributes.onAccessDenied, "{requireLogin}");
  assert.equal(attributes.key, '{board.user.id + ":receipts:" + formVersion}');
  const clear = findAll(
    source,
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "clearUserState",
  )[0];
  assert.ok(clear);
  const clearText = clear.getText(source);
  assert.ok(
    clearText.indexOf("session.reset(owner)") <
      clearText.indexOf("setBoard(null)"),
  );
  assert.match(clearText, /setFormVersion\(\(value\) => value \+ 1\)/);
  assert.match(clearText, /setReceiptsOpen\(false\)/);
});

test("same-owner relogin rotates the receipt lifetime; late denial cannot clear the new session", async () => {
  const session = createSessionGuard();
  session.reset("1");
  const firstTicket = session.capture();
  const oldStates: OwnerReceiptsState[] = [];
  let rejectOld!: (reason: unknown) => void;
  const oldRead = new Promise<unknown>((_resolve, reject) => {
    rejectOld = reject;
  });
  let denied = 0;
  const first = createOwnerReceiptsResource({
    userId: "1",
    sessionSignal: firstTicket.signal,
    load: () => oldRead,
    publish: (state) => oldStates.push(state),
    onAccessDenied: () => {
      denied++;
      session.reset();
    },
  });
  const pending = first.refresh();
  // clearUserState rotates the generation even when the next login has the
  // same user ID. The old request cannot revoke that new generation.
  session.reset("1");
  assert.equal(firstTicket.active(), false);
  assert.deepEqual(oldStates.at(-1), { phase: "closed", tasks: [] });
  const currentTicket = session.capture();
  const currentStates: OwnerReceiptsState[] = [];
  const current = createOwnerReceiptsResource({
    userId: "1",
    sessionSignal: currentTicket.signal,
    load: async () => ({ tasks: [] }),
    publish: (state) => currentStates.push(state),
  });
  await current.refresh();
  rejectOld(new ApiError(401, "SYNTHETIC_OLD_DENIAL"));
  await pending;
  assert.equal(denied, 0);
  assert.equal(currentTicket.active(), true);
  assert.deepEqual(currentStates.at(-1), { phase: "ready", tasks: [] });
  session.reset();
  assert.deepEqual(currentStates.at(-1), { phase: "closed", tasks: [] });
  first.dispose();
  current.dispose();
});
