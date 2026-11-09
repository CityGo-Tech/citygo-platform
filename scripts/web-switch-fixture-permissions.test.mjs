import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeFixtureArchiveReadable } from "./web-switch-smoke.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "citygo-archive-permissions-"));
  chmodSync(directory, 0o700);
  const archive = join(directory, "archive");
  const nested = join(archive, "chunks", "nested");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  writeFileSync(join(nested, "asset.js"), "public synthetic chunk\n", {
    mode: 0o600,
  });
  writeFileSync(join(directory, "key.pem"), "private synthetic key\n", {
    mode: 0o600,
  });
  return { directory, archive, nested };
}

test(
  "public fixture modes preserve the private parent, TLS key and asset bytes",
  {
    skip: process.platform === "win32" && "POSIX mode contract requires Linux",
  },
  () => {
    const { directory, archive, nested } = fixture();
    try {
      makeFixtureArchiveReadable(archive);
      const mode = (path) => statSync(path).mode & 0o777;
      assert.equal(mode(directory), 0o700);
      assert.equal(mode(join(directory, "key.pem")), 0o600);
      for (const path of [archive, join(archive, "chunks"), nested])
        assert.equal(mode(path), 0o755);
      assert.equal(mode(join(nested, "asset.js")), 0o644);
      assert.equal(
        readFileSync(join(nested, "asset.js"), "utf8"),
        "public synthetic chunk\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "archive chmod cannot follow a symlink or change a hard-linked private file",
  {
    skip: process.platform === "win32" && "POSIX links contract requires Linux",
  },
  () => {
    for (const link of [symlinkSync, linkSync]) {
      const { directory, archive } = fixture();
      try {
        const key = join(directory, "key.pem");
        link(key, join(archive, "key-link"));
        assert.throws(
          () => makeFixtureArchiveReadable(archive),
          /Fixture archive.*link/,
        );
        assert.equal(statSync(key).mode & 0o777, 0o600);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "Linux unprivileged reader reaches public archive without traversing the private mount parent",
  {
    skip:
      (process.platform !== "linux" || process.getuid() !== 0) &&
      "Run as Linux root to prove uid/gid 65534 access without a permissions skip",
  },
  () => {
    const { directory, archive } = fixture();
    try {
      makeFixtureArchiveReadable(archive);
      // A direct bind mount exposes this directory inode, rather than walking the
      // host's 0700 mkdtemp ancestors. An inherited cwd models that same traversal.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      process.chdir(process.argv[1]);
      process.setgroups([]);
      process.setgid(65534);
      process.setuid(65534);
      assert.equal(process.getuid(), 65534);
      assert.equal(process.getgid(), 65534);
      assert.deepEqual(process.getgroups(), [65534]);
      assert.equal(readFileSync('chunks/nested/asset.js', 'utf8'), 'public synthetic chunk\\n');
      assert.throws(() => readFileSync(process.argv[1] + '/chunks/nested/asset.js'), { code: 'EACCES' });
      assert.throws(() => readFileSync('../key.pem'), { code: 'EACCES' });
    `,
          archive,
        ],
        {
          env: {},
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
