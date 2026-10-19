#!/bin/bash
# Trusted provisioning only: never run this as a PR/runner job.
# Public verification inputs are separately reviewed and preseeded by the owner.
# Sources: https://github.com/nodejs/node#verifying-binaries
# https://github.com/nodejs/release-keys https://pnpm.io/10.x/installation
# https://packages.ubuntu.com/noble/docker.io https://playwright.dev/docs/browsers
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly NODE_VERSION=24.22.0 PNPM_VERSION=10.15.0 PLAYWRIGHT_VERSION=1.63.0
readonly METADATA=/var/lib/citygo-bootstrap/public-metadata.json
readonly NODE_KEYRING=/usr/local/share/citygo-bootstrap/node-release-keys.kbx
readonly WORK=/var/lib/citygo-bootstrap/toolchain-work
readonly TOOLS=/opt/citygo-toolchain
readonly REPORT=/var/lib/citygo-bootstrap/toolchain-report.json
stage=inputs
fail() { printf '{"ok":false,"stage":"%s","code":"%s"}\n' "$stage" "$1" >&2; exit 1; }
trap 'fail command_failed' ERR
[[ $# == 1 && ( $1 == --plan || $1 == --apply ) ]] || fail arguments_invalid
mode=$1

# This block is pure validation in --plan; --apply also checks the root-owned
# ordinary local file. No URLs, executable content, credentials or extra keys.
metadata_lines=$(python3 - "$METADATA" "$mode" <<'PY_METADATA'
import json, os, re, stat, sys
def reject():
    raise SystemExit("public_metadata_invalid")
try:
    path, mode = sys.argv[1:]
    if mode == "--apply":
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != 0 or st.st_mode & 0o022:
            reject()
    with open(path, "rb") as stream:
        raw = stream.read(8193)
    if len(raw) > 8192:
        reject()
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                reject()
            result[key] = value
        return result
    item = json.loads(raw, object_pairs_hook=unique)
    expected = {"version", "node", "pnpm", "playwright"}
    if not isinstance(item, dict) or set(item) != expected or type(item["version"]) is not int or item["version"] != 1:
        reject()
    node, pnpm, pw = item["node"], item["pnpm"], item["playwright"]
    if not isinstance(node, dict) or set(node) != {"version", "archiveSha256", "manifestSha256", "signatureSha256", "keyringSha256", "keyringCommit", "signerFingerprint"} or node["version"] != "24.22.0":
        reject()
    if not isinstance(pnpm, dict) or set(pnpm) != {"version", "integrity"} or pnpm["version"] != "10.15.0":
        reject()
    if not isinstance(pw, dict) or set(pw) != {"version", "coreIntegrity"} or pw["version"] != "1.63.0":
        reject()
    values = [node[key] for key in ("archiveSha256", "manifestSha256", "signatureSha256", "keyringSha256")]
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in values):
        reject()
    if not isinstance(node["keyringCommit"], str) or not re.fullmatch(r"[a-f0-9]{40}", node["keyringCommit"]):
        reject()
    if not isinstance(node["signerFingerprint"], str) or not re.fullmatch(r"[A-F0-9]{40}", node["signerFingerprint"]):
        reject()
    for value in (pnpm["integrity"], pw["coreIntegrity"]):
        if not isinstance(value, str) or not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", value):
            reject()
    print("\n".join(values + [node["keyringCommit"], pnpm["integrity"], pw["coreIntegrity"], node["signerFingerprint"]]))
except (OSError, ValueError, TypeError, KeyError):
    reject()
PY_METADATA
) || fail public_metadata_invalid
mapfile -t pins <<< "$metadata_lines"
[[ ${#pins[@]} == 8 ]] || fail public_metadata_invalid
if [[ $mode == --plan ]]; then
  printf '{"ok":true,"mode":"plan","node":"%s","pnpm":"%s","playwright":"%s","guestIsolationVerified":false,"githubRunnerRegistered":false}\n' "$NODE_VERSION" "$PNPM_VERSION" "$PLAYWRIGHT_VERSION"
  exit 0
fi

stage=host_canary
[[ $(id -u) == 0 && $(uname -m) == x86_64 ]] || fail ubuntu_amd64_root_required
[[ -f /etc/os-release ]] || fail os_release_invalid
grep -qx 'ID=ubuntu' /etc/os-release || fail ubuntu_required
grep -qx 'VERSION_ID="24.04"' /etc/os-release || fail ubuntu_2404_required
[[ $(python3 -c 'import sys; print("%s.%s" % sys.version_info[:2])') == 3.12 ]] || fail python_312_required
[[ ! -e $WORK && ! -e $TOOLS && ! -e $REPORT ]] || fail previous_attempt_preserved
[[ -f $NODE_KEYRING && ! -L $NODE_KEYRING ]] || fail node_keyring_invalid
python3 - "$NODE_KEYRING" <<'PY_KEYRING'
import os, stat, sys
st = os.lstat(sys.argv[1])
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != 0 or st.st_mode & 0o022 or not 1 <= st.st_size <= 1048576:
    raise SystemExit("node_keyring_invalid")
PY_KEYRING
printf '%s  %s\n' "${pins[3]}" "$NODE_KEYRING" | sha256sum --check --status || fail node_keyring_hash_mismatch
mkdir -m 0700 "$WORK"
mkdir -m 0755 "$TOOLS"
mkdir -m 0700 "$WORK/gpgv"

stage=ubuntu_packages
# APT verifies Ubuntu's signed repository metadata. Record all exact installed
# versions below; do not use a convenience shell installer or external PPA.
apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 update
DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 install -y --no-install-recommends \
  ca-certificates curl gnupg gpgv xz-utils git age jq unzip build-essential \
  python3 python3-venv python3-pip docker.io docker-compose-v2 docker-buildx
[[ $(python3 -c 'import sys; print("%s.%s" % sys.version_info[:2])') == 3.12 ]] || fail python_312_required

download_public() {
  local url=$1 destination=$2 maximum=$3
  [[ ! -e $destination ]] || fail download_destination_exists
  # curl's own config is disabled. Retries are bounded; partial files are retained.
  local status
  status=$(curl --disable --silent --show-error --fail --proto '=https' --noproxy '*' \
    --connect-timeout 20 --max-time 600 --retry 2 --retry-delay 3 --retry-max-time 1200 \
    --max-filesize "$maximum" --no-clobber --output "$destination" --write-out '%{http_code}' "$url") || fail public_download_failed
  [[ $status == 200 && -f $destination && ! -L $destination ]] || fail public_download_http_invalid
  [[ $(stat -c %s "$destination") -gt 0 && $(stat -c %s "$destination") -le $maximum ]] || fail public_download_size_invalid
}
verify_sri() {
  python3 - "$1" "$2" <<'PY_SRI'
import base64, hashlib, hmac, sys
actual = "sha512-" + base64.b64encode(hashlib.file_digest(open(sys.argv[1], "rb"), "sha512").digest()).decode("ascii")
if not hmac.compare_digest(actual, sys.argv[2]):
    raise SystemExit("package_integrity_mismatch")
PY_SRI
}

stage=node_verify
readonly NODE_ARCHIVE=node-v${NODE_VERSION}-linux-x64.tar.xz
download_public "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$WORK/SHASUMS256.txt" 65536
download_public "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt.sig" "$WORK/SHASUMS256.txt.sig" 16384
printf '%s  %s\n' "${pins[1]}" "$WORK/SHASUMS256.txt" "${pins[2]}" "$WORK/SHASUMS256.txt.sig" | sha256sum --check --status || fail node_manifest_hash_mismatch
gpgv --homedir "$WORK/gpgv" --keyring "$NODE_KEYRING" --status-fd 3 "$WORK/SHASUMS256.txt.sig" "$WORK/SHASUMS256.txt" 3> "$WORK/node-gpgv-status.txt" || fail node_signature_invalid
python3 - "$WORK/node-gpgv-status.txt" "${pins[7]}" <<'PY_SIGNER'
import re, sys
records = [line.split() for line in open(sys.argv[1], encoding="ascii") if line.startswith("[GNUPG:] VALIDSIG ")]
if len(records) != 1 or len(records[0]) not in (11, 12):
    raise SystemExit("node_signer_invalid")
record = records[0]
fingerprints = [record[2]] + ([record[11]] if len(record) == 12 else [])
if any(not re.fullmatch(r"[A-F0-9]{40}", item) for item in fingerprints) or sys.argv[2] not in fingerprints:
    raise SystemExit("node_signer_mismatch")
PY_SIGNER
python3 - "$WORK/SHASUMS256.txt" "$NODE_ARCHIVE" "${pins[0]}" <<'PY_MANIFEST'
import re, sys
lines = open(sys.argv[1], encoding="ascii").read().splitlines()
matches = [re.fullmatch(r"([a-f0-9]{64}) [ *](\S+)", line) for line in lines]
matches = [item for item in matches if item and item[2] == sys.argv[2]]
if len(matches) != 1 or matches[0][1] != sys.argv[3]:
    raise SystemExit("node_signed_archive_hash_mismatch")
PY_MANIFEST
download_public "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" "$WORK/$NODE_ARCHIVE" 134217728
printf '%s  %s\n' "${pins[0]}" "$WORK/$NODE_ARCHIVE" | sha256sum --check --status || fail node_archive_hash_mismatch
tar --extract --xz --file "$WORK/$NODE_ARCHIVE" --directory "$TOOLS" --no-same-owner
[[ $("$TOOLS/node-v${NODE_VERSION}-linux-x64/bin/node" --version) == v${NODE_VERSION} ]] || fail node_version_mismatch
for binary in node npm npx; do
  [[ ! -e /usr/local/bin/$binary && ! -L /usr/local/bin/$binary ]] || fail existing_toolchain_preserved
  ln -s "$TOOLS/node-v${NODE_VERSION}-linux-x64/bin/$binary" "/usr/local/bin/$binary"
done

stage=pnpm_verify
download_public "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" "$WORK/pnpm.tgz" 33554432
verify_sri "$WORK/pnpm.tgz" "${pins[5]}" || fail pnpm_integrity_mismatch
# Separate empty config files avoid npm's duplicate-config-path error and do not
# read any personal/registry credentials. WORK is a new root-only directory.
install -m 0600 /dev/null "$WORK/npm-user.rc"
install -m 0600 /dev/null "$WORK/npm-global.rc"
npm --userconfig="$WORK/npm-user.rc" --globalconfig="$WORK/npm-global.rc" --registry=https://registry.npmjs.org/ install --global --prefix="$TOOLS/pnpm" --ignore-scripts --no-audit --no-fund --offline "$WORK/pnpm.tgz"
[[ ! -e /usr/local/bin/pnpm && ! -L /usr/local/bin/pnpm ]] || fail existing_toolchain_preserved
ln -s "$TOOLS/pnpm/bin/pnpm" /usr/local/bin/pnpm
[[ $(pnpm --version) == "$PNPM_VERSION" ]] || fail pnpm_version_mismatch

stage=playwright_verify
download_public "https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_VERSION}.tgz" "$WORK/playwright-core.tgz" 33554432
verify_sri "$WORK/playwright-core.tgz" "${pins[6]}" || fail playwright_integrity_mismatch
mkdir -m 0755 "$TOOLS/playwright-core"
tar --extract --gzip --file "$WORK/playwright-core.tgz" --directory "$TOOLS/playwright-core" --strip-components=1 --no-same-owner
[[ $(node -p 'require(process.argv[1]).version' "$TOOLS/playwright-core/package.json") == "$PLAYWRIGHT_VERSION" ]] || fail playwright_version_mismatch
# Exact verified public CLI only; no checkout or npm application lifecycle scripts.
node "$TOOLS/playwright-core/cli.js" install-deps chromium
PLAYWRIGHT_BROWSERS_PATH="$TOOLS/playwright-browsers" node "$TOOLS/playwright-core/cli.js" install chromium

stage=native_docker_canary
systemctl enable --now docker
[[ -S /var/run/docker.sock ]] || fail native_docker_socket_missing
[[ $(docker --host unix:///var/run/docker.sock info --format '{{.OSType}}') == linux ]] || fail native_linux_docker_required
docker --host unix:///var/run/docker.sock compose version --short
docker --host unix:///var/run/docker.sock buildx version

stage=public_report
python3 - "$REPORT" "${pins[@]}" <<'PY_REPORT'
import json, os, subprocess, sys
packages = ["docker.io", "docker-compose-v2", "docker-buildx", "containerd", "runc", "python3", "git", "age"]
lines = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}\t${Version}\n", *packages], text=True).splitlines()
item = {"version": 1, "toolchainInstalled": True, "guestIsolationVerified": False, "githubRunnerRegistered": False, "goldenImageSealed": False,
        "node": "24.22.0", "pnpm": "10.15.0", "playwright": "1.63.0", "packages": dict(line.split("\t", 1) for line in lines)}
# Only the already validated public values, not a later re-read of a mutable file.
archive, manifest, signature, keyring, commit, pnpm, playwright, signer = sys.argv[2:]
item["publicPins"] = {"version": 1, "node": {"version": "24.22.0", "archiveSha256": archive, "manifestSha256": manifest, "signatureSha256": signature, "keyringSha256": keyring, "keyringCommit": commit, "signerFingerprint": signer},
                      "pnpm": {"version": "10.15.0", "integrity": pnpm}, "playwright": {"version": "1.63.0", "coreIntegrity": playwright}}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
with os.fdopen(fd, "w", encoding="utf-8") as target:
    json.dump(item, target, sort_keys=True)
    target.write("\n")
    target.flush()
    os.fsync(target.fileno())
print(json.dumps({"ok": True, "toolchainInstalled": True, "guestIsolationVerified": False, "githubRunnerRegistered": False, "goldenImageSealed": False}))
PY_REPORT
