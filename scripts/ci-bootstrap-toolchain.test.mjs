import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = readFileSync(
  new URL("../deploy/ci/bootstrap-toolchain.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const template = readFileSync(
  new URL("../deploy/ci/bootstrap-user-data.template.yml", import.meta.url),
  "utf8",
);
const lock = readFileSync(
  new URL("../pnpm-lock.yaml", import.meta.url),
  "utf8",
);
const python = process.platform === "win32" ? "python" : "python3";
const bash =
  process.platform === "win32"
    ? [
        "D:/Program Files/Git/bin/bash.exe",
        "C:/Program Files/Git/bin/bash.exe",
      ].find(existsSync)
    : "/bin/bash";
const pythonAvailable =
  spawnSync(python, ["-I", "-B", "--version"], {
    encoding: "utf8",
  }).status === 0;
const pwVersion = "1.63.0";
const pwIntegrity =
  "sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==";
const syntheticSri = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
function metadata() {
  return {
    version: 1,
    node: {
      version: "24.22.0",
      archiveSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      signatureSha256: "c".repeat(64),
      keyringSha256: "d".repeat(64),
      keyringCommit: "e".repeat(40),
      signerFingerprint: "A".repeat(40),
    },
    pnpm: { version: "10.15.0", integrity: syntheticSri },
    playwright: { version: pwVersion, coreIntegrity: pwIntegrity },
  };
}
function block(name) {
  const match = script.match(
    new RegExp(`<<'${name}'\n([\\s\\S]*?)\n${name}(?:\n|$)`),
  );
  assert(match, name);
  return match[1];
}
function runPython(code, args = []) {
  return spawnSync(python, ["-I", "-B", "-c", code, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
}
async function withPublicFile(bytes, run) {
  const directory = await mkdtemp(
    join(tmpdir(), "citygo-bootstrap-public-test-"),
  );
  const file = join(directory, "synthetic-public-metadata.txt");
  try {
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    return await run(file);
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
}

test("template has only placeholders for per-VM keys, strict SSH and separate early-network contract", () => {
  assert.match(template, /^#cloud-config/);
  for (const name of [
    "CITYGO_BOOTSTRAP_HOST_IPV4",
    "CITYGO_BOOTSTRAP_AUTHORIZED_PUBLIC_KEY",
    "CITYGO_VM_UNIQUE_ED25519_HOST_PRIVATE_KEY",
    "CITYGO_VM_UNIQUE_ED25519_HOST_PUBLIC_KEY",
    "CITYGO_BOOTSTRAP_TOOLCHAIN_BASE64",
    "CITYGO_PUBLIC_TOOLCHAIN_METADATA_BASE64",
    "CITYGO_OFFICIAL_NODE_RELEASE_KEYRING_BASE64",
  ])
    assert(template.includes(`__${name}__`), name);
  assert.match(template, /from="__CITYGO_BOOTSTRAP_HOST_IPV4__",restrict/);
  assert.match(template, /ssh_deletekeys: true/);
  assert.match(template, /ssh_pwauth: false/);
  assert.match(template, /PermitRootLogin no/);
  assert.match(template, /AllowTcpForwarding no/);
  assert.match(template, /separate network-config/);
  assert.doesNotMatch(template, /^network:/m);
  assert.doesNotMatch(template, /-----BEGIN [^-]*PRIVATE KEY-----/);
  assert.doesNotMatch(template, /^power_state:/m);
  assert.match(
    template,
    /runcmd:\s*\n[^\n]*\n\s*- \[\/usr\/local\/sbin\/citygo-bootstrap-toolchain, --apply\]/,
  );
});

test("toolchain versions and Playwright core integrity match committed public lock metadata", () => {
  assert.match(
    script,
    /NODE_VERSION=24\.22\.0 PNPM_VERSION=10\.15\.0 PLAYWRIGHT_VERSION=1\.63\.0/,
  );
  assert.match(
    lock,
    /playwright-core@1\.63\.0:\s*\r?\n\s*resolution: \{integrity: sha512-rYCsBF\/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC\/bxgspzkjSfU\+MweEMmPM8KJebG6nnyxo5mCg==\}/,
  );
  assert.match(lock, /'@playwright\/test@1\.63\.0'/);
  assert.match(script, /playwright-core\/cli\.js" install-deps chromium/);
  assert.match(
    script,
    /PLAYWRIGHT_BROWSERS_PATH="\$TOOLS\/playwright-browsers"/,
  );
});

test(
  "public metadata validator admits only exact public pins",
  { skip: !pythonAvailable },
  async () => {
    await withPublicFile(JSON.stringify(metadata()), (file) => {
      const result = runPython(block("PY_METADATA"), [file, "--plan"]);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.equal(lines.length, 8);
      assert.equal(lines[6], pwIntegrity);
      assert.equal(lines[7], "A".repeat(40));
    });
  },
);

test(
  "metadata rejects wrong versions, unknown secrets, malformed pins, duplicate keys and oversized input",
  { skip: !pythonAvailable },
  async () => {
    const changes = [
      (item) => (item.version = true),
      (item) => (item.node.version = "24.23.0"),
      (item) => (item.pnpm.version = "latest"),
      (item) => (item.playwright.version = "1.64.0"),
      (item) => (item.node.archiveSha256 = "__UNRESOLVED__"),
      (item) => (item.node.signerFingerprint = "a".repeat(40)),
      (item) => (item.node.signerFingerprint = "A".repeat(16)),
      (item) => (item.node.keyringCommit = "HEAD"),
      (item) => (item.pnpm.integrity = "sha1-unsafe"),
      (item) => (item.playwright.coreIntegrity += "\ncommand"),
      (item) => (item.apiKey = "synthetic-unwanted-field"),
    ];
    const inputs = changes.map((change) => {
      const item = metadata();
      change(item);
      return JSON.stringify(item);
    });
    inputs.push(
      JSON.stringify(metadata()).replace(
        '"version":1',
        '"version":1,"version":1',
      ),
    );
    inputs.push(" ".repeat(8193));
    for (const input of inputs)
      await withPublicFile(input, (file) => {
        const result = runPython(block("PY_METADATA"), [file, "--plan"]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^public_metadata_invalid\s*$/);
      });
  },
);

test(
  "GPG status must bind one full signing/primary fingerprint, never a short ID or GOODSIG only",
  { skip: !pythonAvailable },
  async () => {
    const signer = "A".repeat(40),
      primary = "B".repeat(40);
    const valid = `[GNUPG:] VALIDSIG ${signer} 2026-10-14 1791979200 0 4 0 1 10 00 ${primary}\n`;
    for (const fingerprint of [signer, primary])
      await withPublicFile(valid, (file) => {
        assert.equal(
          runPython(block("PY_SIGNER"), [file, fingerprint]).status,
          0,
        );
      });
    for (const input of [
      valid + valid,
      valid.replace(signer, "A".repeat(16)),
      "[GNUPG:] GOODSIG 0123456789ABCDEF synthetic\n",
      "[GNUPG:] VALIDSIG truncated\n",
    ])
      await withPublicFile(input, (file) => {
        assert.notEqual(
          runPython(block("PY_SIGNER"), [file, signer]).status,
          0,
        );
      });
    await withPublicFile(valid, (file) => {
      assert.notEqual(
        runPython(block("PY_SIGNER"), [file, "C".repeat(40)]).status,
        0,
      );
    });
  },
);

test(
  "signed manifest must contain exactly the pinned Node archive/hash",
  { skip: !pythonAvailable },
  async () => {
    const filename = "node-v24.22.0-linux-x64.tar.xz",
      digest = "a".repeat(64);
    for (const [input, expected] of [
      [`${digest}  ${filename}\n`, 0],
      [`${digest} *${filename}\n`, 0],
      [`${digest}  ${filename}\n${digest}  ${filename}\n`, 1],
      [`${"b".repeat(64)}  ${filename}\n`, 1],
      [`${digest}  node-v24.22.0-linux-arm64.tar.xz\n`, 1],
    ])
      await withPublicFile(input, (file) => {
        assert.equal(
          runPython(block("PY_MANIFEST"), [file, filename, digest]).status ===
            0,
          expected === 0,
        );
      });
  },
);

test(
  "npm tarballs are verified with SHA512 SRI before any package execution",
  { skip: !pythonAvailable },
  async () => {
    const bytes = Buffer.from("synthetic public package, not executable");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    await withPublicFile(bytes, (file) => {
      assert.equal(runPython(block("PY_SRI"), [file, integrity]).status, 0);
      assert.notEqual(
        runPython(block("PY_SRI"), [file, syntheticSri]).status,
        0,
      );
    });
    assert(
      script.indexOf('verify_sri "$WORK/pnpm.tgz"') <
        script.indexOf("install --global"),
    );
    assert(
      script.indexOf('verify_sri "$WORK/playwright-core.tgz"') <
        script.indexOf("tar --extract --gzip"),
    );
    assert.match(
      script,
      /install --global[^\n]*--ignore-scripts[^\n]*--offline/,
    );
  },
);

test("bootstrap is bounded trusted-only provisioning, preserves attempts and does not claim isolation or sealing", () => {
  assert.match(
    script,
    /\[\[ ! -e \$WORK && ! -e \$TOOLS && ! -e \$REPORT \]\]/,
  );
  assert.match(script, /--max-time 600 --retry 2/);
  assert.match(script, /gpgv[^\n]*--status-fd 3/);
  assert.match(script, /sha256sum --check --status/);
  assert.match(script, /docker --host unix:\/\/\/var\/run\/docker\.sock info/);
  assert.match(script, /docker\.io docker-compose-v2 docker-buildx/);
  assert.match(script, /dpkg-query/);
  assert.match(script, /os\.O_EXCL/);
  assert.match(script, /"guestIsolationVerified": False/);
  assert.match(script, /"goldenImageSealed": False/);
  assert.doesNotMatch(
    script,
    /git\s+clone|actions-runner|config\.sh|run\.sh|curl[^\n]*\|\s*(?:ba)?sh|--network[ =]host|docker\.sock:/,
  );
  assert.doesNotMatch(
    script,
    /\brm\s|\breboot\b|\bpoweroff\b|\bshutdown\b|ssh-keygen/,
  );
});

test(
  "Bash and embedded Python syntax parse without running provisioning",
  { skip: !bash || !pythonAvailable },
  () => {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-n"], {
      input: script,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of [
      "PY_METADATA",
      "PY_KEYRING",
      "PY_SRI",
      "PY_SIGNER",
      "PY_MANIFEST",
      "PY_REPORT",
    ])
      assert.equal(
        runPython(
          "import sys; compile(sys.argv[1], 'synthetic-public-block', 'exec')",
          [block(name)],
        ).status,
        0,
        name,
      );
  },
);
