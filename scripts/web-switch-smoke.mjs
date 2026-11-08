// Physical, disposable Web transport rehearsal. Never an operator/deploy command.
// Uses two copies of ONE cached production Next image and an HTTP-only fixture.
// It does not prove CityGo API, DB persistence, leases or real postpay semantics.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { root, serviceEnv } from "./env.mjs";
import { fixtureCertificate } from "../deploy/fixtures/web-switch-tls.mjs";
import { renderWebSwitchNginx } from "../deploy/render-web-switch.mjs";
import { classifyProbeFailures } from "./web-switch-transport.mjs";

const images = {
  web: "sha256:751786e8bd0e5733fb77921167837cdad109ab4d21c09fc43f6dc8b5e844ea23",
  nginx:
    "sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94",
  node: "sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
};
const source = "42ecf835ea8c7f1488d70453e203c1c3149e2f92";
const host = "web-switch.example.test";
const origin = `https://${host}`;
const cookie = "__Host-citygo=synthetic-web-switch-session";
const plan = {
  kind: "citygo-disposable-web-switch-rehearsal",
  images,
  source,
  builds: false,
  pulls: false,
  realApi: false,
  realPostpay: false,
  networks:
    "API/Web internal-only; Nginx also has a disposable edge bridge for loopback TLS publication",
  silentStreamMinimumMs: 35000,
  probeIntervalMs: 100,
  phases: [
    "Validate cached images and prepare isolated TLS/network fixture",
    "Start synthetic API and two copies of the same production Next image",
    "Reject bad candidate/readiness and immutable-asset collision",
    "Probe fresh/keep-alive sessions while silent SSE and buffered POST are active",
    "Validate Nginx config, HUP, confirm green on fresh TLS connection",
    "Complete old requests, await old worker PID/starttime drain, SIGTERM old Web",
    "Read archived production Next chunks, verify session and synthetic once counters",
    "Delete only exact fixture container IDs, network and temporary directory",
  ],
};
export const rehearsalPlan = (selection = {}) =>
  structuredClone({ ...plan, ...selection });

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    assert.equal(
      entry.isSymbolicLink(),
      false,
      "Fixture archive must not contain links",
    );
    if (entry.isDirectory())
      return files(join(directory, entry.name), relative + "/");
    assert.equal(entry.isFile(), true);
    return [
      {
        path: relative,
        hash: digest(readFileSync(join(directory, entry.name))),
      },
    ];
  });
}
function archiveMerge(input, destination) {
  for (const item of files(input)) {
    const target = join(destination, item.path);
    if (existsSync(target)) {
      assert.equal(lstatSync(target).isFile(), true);
      assert.equal(
        digest(readFileSync(target)),
        item.hash,
        "Immutable asset collision",
      );
    } else {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(input, item.path), target);
    }
  }
}
function candidate(metadata, selectedImages, expectedSource) {
  assert.equal(metadata.Id, selectedImages.web, "Unexpected cached Web image");
  assert.equal(
    metadata.Config.Labels["org.opencontainers.image.revision"],
    expectedSource,
  );
}
function nginxConfig(slot, minimumKeepaliveSeconds = 0) {
  assert.ok(["blue", "green"].includes(slot));
  assert.ok([0, 5].includes(minimumKeepaliveSeconds));
  return `worker_processes 2;
pid /tmp/nginx.pid;
error_log /dev/stderr notice;
events { worker_connections 256; }
http {
  include /etc/nginx/mime.types;
  access_log off;
  sendfile on;
  server {
    listen 443 ssl;
    server_name ${host};
    ssl_certificate /fixture/cert.pem;
    ssl_certificate_key /fixture/key.pem;
    keepalive_timeout 30s;
    keepalive_min_timeout ${minimumKeepaliveSeconds}s;
    client_body_timeout 15s;
    send_timeout 300s;
    location ^~ /_next/static/ {
      alias /fixture/archive/;
      add_header X-Rehearsal-Archived true always;
      add_header Cache-Control "public, max-age=31536000, immutable" always;
    }
    location = /__citygo_web_slot {
      rewrite ^ /api/ready? break;
      proxy_pass http://${slot}:3000;
      proxy_set_header Host ${host};
      proxy_set_header Connection "";
      add_header X-CityGo-Web-Slot $upstream_addr always;
      proxy_next_upstream off;
    }
    location / {
      proxy_pass http://${slot}:3000;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host ${host};
      proxy_set_header X-Forwarded-Host ${host};
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header Forwarded "";
      proxy_buffering off;
      proxy_request_buffering on;
      proxy_cache off;
      proxy_next_upstream off;
      proxy_read_timeout 300s;
      proxy_send_timeout 300s;
      add_header X-CityGo-Web-Slot $upstream_addr always;
    }
  }
}
`;
}

export async function runRehearsal(selection) {
  assert.ok(
    selection,
    "Explicit immutable image IDs and source SHA are required",
  );
  const { images, source } = selection;
  assert.deepEqual(Object.keys(images).sort(), ["nginx", "node", "web"]);
  for (const image of Object.values(images))
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.match(source, /^[a-f0-9]{40}$/);
  const id = `citygo-web-switch-smoke-${randomBytes(6).toString("hex")}`;
  assert.match(id, /^citygo-web-switch-smoke-[a-f0-9]{12}$/);
  const directory = mkdtempSync(join(tmpdir(), id + "-"));
  const evidence = join(root, ".local", "web-switch-smoke", id);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, "plan.json"),
    JSON.stringify(rehearsalPlan(selection), null, 2),
  );
  const env = serviceEnv("test");
  const containers = [];
  const createdNetworks = [];
  let agent;
  let probing = false;
  let probes;
  const failures = [];
  const observations = [];
  const probeStarts = [];
  let phase = "preflight";
  const timeline = [];
  const requestTraces = [];
  const markPhase = (name) => {
    phase = name;
    timeline.push({
      phase,
      wallTime: Date.now(),
      monotonic: performance.now(),
    });
  };
  const requests = new Set();
  const extraAgents = new Set();
  const docker = (args, options = {}) => {
    const result = spawnSync("docker", args, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout ?? 15000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Disposable Docker operation failed: ${args[0]} (${String(result.stderr).slice(-2000)})`,
      );
    return result.stdout.trim();
  };
  const dockerAsync = (args) =>
    new Promise((resolveCommand, reject) => {
      const child = spawn("docker", args, {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 15000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 4 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0)
          reject(
            new Error(
              `Disposable Docker operation failed: ${args[0]} (${stderr})`,
            ),
          );
        else resolveCommand(stdout.trim());
      });
    });
  const inspect = (container) => JSON.parse(docker(["inspect", container]))[0];
  const inspectAsync = async (container) =>
    JSON.parse(await dockerAsync(["inspect", container]))[0];
  const mount = (path, target, readonly = true) =>
    `type=bind,source=${resolve(path)},target=${target}${readonly ? ",readonly" : ""}`;
  function start(name, image, args = []) {
    const container = docker([
      "run",
      "--pull=never",
      "-d",
      "--name",
      `${id}-${name}`,
      "--network",
      id,
      "--network-alias",
      name,
      "--label",
      `citygo.rehearsal=${id}`,
      ...args,
      image,
    ]);
    assert.match(container, /^[a-f0-9]{64}$/);
    containers.push(container);
    return container;
  }
  async function until(check, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do {
      if (await check()) return;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(message);
  }
  try {
    // Inspect immutable local IDs first. No tag resolution, build, pull or registry IO.
    for (const image of Object.values(images))
      assert.equal(
        JSON.parse(docker(["image", "inspect", image]))[0].Id,
        image,
      );
    const metadata = JSON.parse(docker(["image", "inspect", images.web]))[0];
    candidate(metadata, images, source);
    assert.throws(() =>
      candidate(
        { ...metadata, Id: "sha256:" + "0".repeat(64) },
        images,
        source,
      ),
    );
    assert.throws(() =>
      candidate({ ...metadata, Config: { Labels: {} } }, images, source),
    );
    const certificate = fixtureCertificate(host);
    writeFileSync(join(directory, "key.pem"), certificate.key, { mode: 0o600 });
    writeFileSync(join(directory, "cert.pem"), certificate.certificate);
    mkdirSync(join(directory, "archive"));
    for (const [name, internal] of [
      [id, true],
      [id + "-edge", false],
    ]) {
      const network = docker([
        "network",
        "create",
        ...(internal ? ["--internal"] : []),
        "--label",
        `citygo.rehearsal=${id}`,
        name,
      ]);
      assert.match(network, /^[a-f0-9]{64}$/);
      createdNetworks.push(network);
    }
    const fixture = docker([
      "run",
      "--pull=never",
      "-d",
      "--name",
      `${id}-api`,
      "--network",
      id,
      "--network-alias",
      "api",
      "--label",
      `citygo.rehearsal=${id}`,
      "--mount",
      mount(
        join(root, "deploy/fixtures/web-switch-api.mjs"),
        "/fixture-api.mjs",
      ),
      "--entrypoint",
      "node",
      images.node,
      "/fixture-api.mjs",
    ]);
    assert.match(fixture, /^[a-f0-9]{64}$/);
    containers.push(fixture);
    const fixtureIdentity = inspect(fixture);
    const webArguments = [
      "--init",
      "--read-only",
      "--tmpfs",
      "/tmp:rw",
      "--tmpfs",
      "/app/apps/web/.next/cache:rw,uid=1000,gid=1000",
      "-e",
      "PORT=3000",
    ];
    const blue = start("blue", images.web, webArguments);
    const green = start("green", images.web, webArguments);
    const webIdentity = [blue, green].map((container) => inspect(container));
    for (const item of webIdentity) assert.equal(item.Image, images.web);
    const controlArgs = (body) => [
      "exec",
      fixture,
      "node",
      "-e",
      "fetch('http://127.0.0.1:4000/rehearsal/control',{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1]}).then(r=>{if(!r.ok)process.exit(1)})",
      JSON.stringify(body),
    ];
    const control = (body) => docker(controlArgs(body));
    const controlAsync = (body) => dockerAsync(controlArgs(body));
    for (const container of [blue, green])
      await until(
        () => {
          try {
            return (
              docker([
                "exec",
                container,
                "node",
                "-e",
                "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
              ]) === ""
            );
          } catch {
            return false;
          }
        },
        "Production Next Web did not become ready",
        60000,
      );
    const archived = join(directory, "blue-static");
    mkdirSync(archived);
    docker(["cp", `${blue}:/app/apps/web/.next/static/.`, archived]);
    archiveMerge(archived, join(directory, "archive"));
    const inventory = files(archived);
    assert.ok(inventory.some((item) => item.path.endsWith(".js")));
    const collision = join(directory, "collision");
    mkdirSync(collision);
    const collided = inventory[0].path;
    mkdirSync(resolve(collision, collided, ".."), { recursive: true });
    writeFileSync(
      join(collision, collided),
      "deliberately changed immutable bytes",
    );
    assert.throws(
      () => archiveMerge(collision, join(directory, "archive")),
      /collision/,
    );
    control({ ready: false });
    assert.throws(() =>
      docker([
        "exec",
        green,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1))",
      ]),
    );
    control({ ready: true });
    // Validate the ACTUAL opt-in production template against the pinned Nginx,
    // without installing it or invoking the production controller.
    const productionTls = join(directory, "production-tls");
    const productionIngress = join(directory, "production-ingress");
    mkdirSync(productionTls);
    mkdirSync(productionIngress);
    writeFileSync(
      join(productionTls, "fullchain.pem"),
      certificate.certificate,
    );
    writeFileSync(join(productionTls, "privkey.pem"), certificate.key, {
      mode: 0o600,
    });
    writeFileSync(
      join(productionIngress, "web-upstream.conf"),
      "proxy_pass http://127.0.0.1:3000;\n",
      { mode: 0o600 },
    );
    writeFileSync(join(productionIngress, "traffic-open"), "fixture-only\n");
    const productionConfig =
      "events {}\nhttp {\n" + renderWebSwitchNginx(host) + "\n}\n";
    writeFileSync(join(directory, "production-nginx.conf"), productionConfig);
    const configTest = docker([
      "create",
      "--pull=never",
      "--name",
      `${id}-production-config-test`,
      "--network",
      "none",
      "--label",
      `citygo.rehearsal=${id}`,
      "--mount",
      mount(directory, "/fixture"),
      "--mount",
      mount(productionTls, `/etc/letsencrypt/live/${host}`),
      "--mount",
      mount(productionIngress, "/var/lib/citygo/ingress"),
      "--mount",
      mount(
        join(directory, "archive"),
        "/var/lib/citygo/web-assets/_next/static",
      ),
      "--entrypoint",
      "nginx",
      images.nginx,
      "-t",
      "-c",
      "/fixture/production-nginx.conf",
    ]);
    assert.match(configTest, /^[a-f0-9]{64}$/);
    containers.push(configTest);
    docker(["start", "--attach", configTest]);
    assert.equal(inspect(configTest).State.ExitCode, 0);
    writeFileSync(join(directory, "nginx.conf"), nginxConfig("blue"));
    // Docker Desktop may suppress published ports on an internal-only network.
    // Only Nginx joins the edge bridge; API/Web retain no external network.
    const nginx = docker([
      "create",
      "--pull=never",
      "--name",
      `${id}-nginx`,
      "--network",
      id + "-edge",
      "--label",
      `citygo.rehearsal=${id}`,
      "--publish",
      "127.0.0.1::443",
      "--mount",
      mount(directory, "/fixture"),
      "--mount",
      mount(join(directory, "nginx.conf"), "/etc/nginx/nginx.conf"),
      images.nginx,
    ]);
    assert.match(nginx, /^[a-f0-9]{64}$/);
    containers.push(nginx);
    docker(["network", "connect", "--alias", "nginx", id, nginx]);
    docker(["start", nginx]);
    const port = Number(
      inspect(nginx).NetworkSettings.Ports["443/tcp"][0].HostPort,
    );
    const ca = readFileSync(join(directory, "cert.pem"));
    agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
    function request(
      path,
      {
        method = "GET",
        body,
        keepAlive = false,
        onChunk,
        slow = false,
        transportAgent,
        kind,
        traceId = randomUUID(),
      } = {},
    ) {
      let startBody;
      let finishBody;
      const trace = {
        id: traceId,
        method,
        path,
        kind: kind ?? (keepAlive ? "keepalive" : "fresh"),
        phaseAtStart: phase,
        startedAt: Date.now(),
        startedMonotonic: performance.now(),
        requestFlushedAt: null,
        responseHeadersAt: null,
        responseBytes: 0,
        finishedAt: null,
        finishedMonotonic: null,
        phaseAtFinish: null,
        reusedSocket: false,
        requestBytesWritten: 0,
      };
      requestTraces.push(trace);
      const finishTrace = () => {
        trace.finishedAt = Date.now();
        trace.finishedMonotonic = performance.now();
        trace.phaseAtFinish = phase;
      };
      const promise = new Promise((resolveRequest, reject) => {
        const bytes =
          body === undefined ? null : Buffer.from(JSON.stringify(body));
        const request = httpsRequest(
          {
            hostname: "127.0.0.1",
            port,
            servername: host,
            path,
            method,
            ca,
            agent: transportAgent ?? (keepAlive ? agent : false),
            headers: {
              host,
              cookie,
              origin,
              "x-rehearsal-request-id": traceId,
              ...(keepAlive || transportAgent ? {} : { connection: "close" }),
              ...(bytes
                ? {
                    "content-type": "application/json",
                    "content-length": bytes.length,
                  }
                : {}),
            },
            signal: AbortSignal.timeout(120000),
          },
          (response) => {
            trace.responseHeadersAt = Date.now();
            trace.status = response.statusCode;
            const chunks = [];
            response.on("data", (chunk) => {
              trace.responseBytes += chunk.length;
              chunks.push(chunk);
              onChunk?.(Buffer.concat(chunks).toString());
            });
            response.on("error", (error) => {
              finishTrace();
              error.transportTrace = trace;
              reject(error);
            });
            response.on("end", () => {
              finishTrace();
              resolveRequest({
                status: response.statusCode,
                headers: response.headers,
                bytes: Buffer.concat(chunks),
                body: Buffer.concat(chunks).toString(),
                transportTrace: trace,
              });
            });
          },
        );
        requests.add(request);
        let assignedSocket;
        let previousBytes = 0;
        request.once("socket", (socket) => {
          assignedSocket = socket;
          previousBytes = socket.bytesWritten;
          trace.reusedSocket = request.reusedSocket;
          trace.socketAssignedAt = Date.now();
          const address = () => {
            trace.localPort = socket.localPort;
            trace.remotePort = socket.remotePort;
          };
          address();
          if (socket.connecting) socket.once("secureConnect", address);
        });
        request.once("finish", () => {
          trace.requestFlushedAt = Date.now();
          trace.reusedSocket = request.reusedSocket;
          trace.requestBytesWritten = assignedSocket
            ? assignedSocket.bytesWritten - previousBytes
            : 0;
        });
        request.once("close", () => requests.delete(request));
        request.on("error", (error) => {
          finishTrace();
          error.reusedSocket = request.reusedSocket;
          trace.reusedSocket = request.reusedSocket;
          trace.error = String(error);
          trace.code = error.code;
          error.transportTrace = trace;
          reject(error);
        });
        if (slow) {
          request.flushHeaders();
          startBody = () =>
            new Promise((flushed) =>
              request.write(bytes.subarray(0, 8), flushed),
            );
          finishBody = () => request.end(bytes.subarray(8));
        } else request.end(bytes);
      });
      // Failure cleanup may destroy an in-flight stream before its later await.
      void promise.catch(() => {});
      return {
        promise,
        trace,
        startBody: () => startBody(),
        finishBody: () => finishBody(),
      };
    }
    const call = (path, options) => request(path, options).promise;
    const stats = async () =>
      JSON.parse((await call("/api/rehearsal/stats")).body);
    const workers = async () =>
      (
        await dockerAsync([
          "exec",
          nginx,
          "sh",
          "-c",
          'for p in /proc/[0-9]*; do test -r "$p/stat" || continue; read -r line < "$p/stat"; case "$line" in *nginx*) echo "$line";; esac; done',
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+) \((.*?)\) (.*)$/);
          if (!match) return null;
          const tail = match[3].split(" ");
          return {
            pid: Number(match[1]),
            parent: Number(tail[1]),
            starttime: tail[19],
          };
        })
        .filter((item) => item?.parent === 1);
    const absent = (previous, current) =>
      !previous.some((old) =>
        current.some(
          (live) => old.pid === live.pid && old.starttime === live.starttime,
        ),
      );
    await until(async () => {
      try {
        return (await call("/api/ready")).status === 200;
      } catch {
        return false;
      }
    }, "Nginx TLS did not become ready");
    const login = await call("/api/rehearsal/login", {
      method: "POST",
      body: {},
    });
    assert.equal(login.status, 200);
    assert.match(
      login.headers["set-cookie"][0],
      /__Host-citygo=.*Secure; HttpOnly; SameSite=Lax/,
    );
    if (selection.idleReuseRegression) {
      const cases = [];
      for (const minimumKeepaliveSeconds of [0, 5]) {
        markPhase(`idle-regression-${minimumKeepaliveSeconds}-configure`);
        const previous = await workers();
        writeFileSync(
          join(directory, "nginx.conf"),
          nginxConfig("blue", minimumKeepaliveSeconds),
        );
        await dockerAsync(["exec", nginx, "nginx", "-t"]);
        await dockerAsync(["kill", "--signal", "HUP", nginx]);
        await until(
          async () => absent(previous, await workers()),
          "Fixture configuration generation did not drain",
        );

        const before = await stats();
        const activeStream = request("/api/rehearsal/messages", {
          method: "POST",
          body: { requestId: randomUUID() },
          kind: "accepted-sse",
        });
        const activePost = request("/api/rehearsal/accepted-post", {
          method: "POST",
          body: { requestId: randomUUID() },
          kind: "accepted-post",
        });
        await until(async () => {
          const current = await stats();
          return (
            current.dispatches === before.dispatches + 1 &&
            current.acceptedPosts === before.acceptedPosts + 1
          );
        }, "Fixture did not admit the controlled POST/SSE before HUP");

        const idleAgent = new Agent({
          keepAlive: true,
          maxSockets: 1,
          maxFreeSockets: 1,
        });
        extraAgents.add(idleAgent);
        const prime = await call("/api/rehearsal/probe", {
          transportAgent: idleAgent,
          kind: "idle-prime",
        });
        assert.equal(prime.status, 200);
        await until(
          () => Object.values(idleAgent.freeSockets).flat().length === 1,
          "Expected one primed idle TLS socket",
        );
        const oldWorkers = await workers();

        // Deterministic client-long-task control: the independent Nginx event
        // loops process HUP while this client's FIN/close callbacks cannot run.
        // The following SINGLE GET then exercises the still-cached idle socket.
        markPhase(`idle-regression-${minimumKeepaliveSeconds}-blocked-hup`);
        const blockedStarted = performance.now();
        docker(["kill", "--signal", "HUP", nginx]);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
        const blockedClientMs = performance.now() - blockedStarted;
        if (minimumKeepaliveSeconds)
          assert.ok(
            blockedClientMs < minimumKeepaliveSeconds * 1000,
            "Client pause exceeded the compared minimum keep-alive interval",
          );
        markPhase(`idle-regression-${minimumKeepaliveSeconds}-single-reuse`);
        const reused = request("/api/rehearsal/probe", {
          transportAgent: idleAgent,
          kind: "forced-idle-reuse",
        });
        const [outcome] = await Promise.allSettled([reused.promise]);
        const current = await stats();
        const admitted = current.requestAdmissions.some(
          (entry) => entry.id === reused.trace.id,
        );
        const fresh = await call("/api/rehearsal/probe");
        assert.equal(fresh.status, 200);
        assert.equal(reused.trace.reusedSocket, true);
        if (minimumKeepaliveSeconds === 0) {
          assert.equal(
            outcome.status,
            "rejected",
            "Negative control must reproduce the stale-idle-socket reset",
          );
          assert.equal(outcome.reason.code, "ECONNRESET");
          assert.equal(reused.trace.responseHeadersAt, null);
          assert.equal(
            admitted,
            false,
            "The reset GET must never reach the fixture API",
          );
        } else {
          assert.equal(outcome.status, "fulfilled");
          assert.equal(outcome.value.status, 200);
          assert.equal(admitted, true);
        }
        assert.equal(
          current.dispatches,
          before.dispatches + 1,
          "The reused GET cannot create another generation",
        );
        assert.equal(
          current.syntheticDebits,
          before.syntheticDebits,
          "No synthetic settlement occurs before the accepted SSE completes",
        );
        await controlAsync({ release: true });
        const [stream, post] = await Promise.all([
          activeStream.promise,
          activePost.promise,
        ]);
        assert.equal(stream.status, 200);
        assert.equal((stream.body.match(/"type":"done"/g) ?? []).length, 1);
        assert.equal(post.status, 200);
        const after = await stats();
        const finalAdmission = after.requestAdmissions.find(
          (entry) => entry.id === reused.trace.id,
        );
        assert.equal(
          finalAdmission?.visits ?? 0,
          minimumKeepaliveSeconds === 0 ? 0 : 1,
          "The single reused GET cannot arrive late or be replayed",
        );
        assert.equal(after.dispatches, before.dispatches + 1);
        assert.equal(after.syntheticDebits, before.syntheticDebits + 1);
        assert.equal(after.completed, before.completed + 1);
        assert.equal(after.acceptedPosts, before.acceptedPosts + 1);
        assert.equal(
          after.completedAcceptedPosts,
          before.completedAcceptedPosts + 1,
        );
        assert.equal(after.cancelled, before.cancelled);
        cases.push({
          minimumKeepaliveSeconds,
          blockedClientMs,
          oldWorkers,
          singleAttempt: reused.trace,
          admittedToFixtureApi: admitted,
          reusedGetApiAdmissions: admitted ? 1 : 0,
          reusedGetExtraGenerations: current.dispatches - before.dispatches - 1,
          reusedGetExtraSyntheticDebits:
            current.syntheticDebits - before.syntheticDebits,
          expectedResetObserved: minimumKeepaliveSeconds === 0,
          acceptedPostCompletedOnce: true,
          acceptedSseCompletedOnce: true,
          syntheticDispatchesDelta: after.dispatches - before.dispatches,
          syntheticDebitsDelta: after.syntheticDebits - before.syntheticDebits,
          freshConnectionStatus: fresh.status,
          retryCount: 0,
        });
        idleAgent.destroy();
        extraAgents.delete(idleAgent);
        await until(
          async () => absent(oldWorkers, await workers()),
          "Controlled old Nginx generation did not drain",
        );
      }
      const result = {
        kind: "citygo-disposable-idle-reuse-regression",
        status: "passed",
        fixture: id,
        images,
        source,
        cases,
        timeline,
        retryCount: 0,
        zeroHttpRetries: true,
        actualProductionConfigurationChanged: false,
        productionMitigationSelected: false,
        comparisonProtectionIsFinite: true,
        productionControllerInvoked: false,
        realApiDatabaseAndMonetaryIntegrationTested: false,
        evidenceDirectory: evidence,
      };
      writeFileSync(
        join(evidence, "report.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    probing = true;
    markPhase("blue-active");
    const probeStarted = Date.now();
    probes = (async () => {
      const pending = new Set();
      while (probing) {
        const began = Date.now();
        probeStarts.push(began - probeStarted);
        const task = Promise.allSettled([
          call("/api/rehearsal/probe"),
          call("/api/rehearsal/probe", { keepAlive: true }),
        ]).then((results) => {
          for (const [index, result] of results.entries()) {
            if (result.status !== "fulfilled" || result.value.status !== 200)
              failures.push({
                at: began - probeStarted,
                trace:
                  result.status === "fulfilled"
                    ? result.value.transportTrace
                    : result.reason.transportTrace,
                kind: index === 0 ? "fresh" : "keepalive",
                status:
                  result.status === "fulfilled" ? result.value.status : null,
                error:
                  result.status === "fulfilled" ? null : String(result.reason),
                code: result.status === "fulfilled" ? null : result.reason.code,
                reusedSocket:
                  result.status === "fulfilled"
                    ? null
                    : result.reason.reusedSocket,
              });
            else
              observations.push({
                at: began - probeStarted,
                kind: index === 0 ? "fresh" : "keepalive",
                slot: result.value.headers["x-citygo-web-slot"],
              });
          }
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
        await delay(Math.max(0, 100 - (Date.now() - began)));
      }
      await Promise.all(pending);
    })();
    let streamBody = "";
    const requestId = randomUUID();
    const stream = call("/api/rehearsal/messages", {
      method: "POST",
      body: { requestId },
      onChunk: (body) => {
        streamBody = body;
      },
    });
    await until(
      async () => (await stats()).dispatches === 1,
      "SSE did not reach fixture",
    );
    const oldWorkers = await workers();
    assert.equal(oldWorkers.length, 2);
    // Preserve a truly silent response for >30s without shortening production timeouts.
    await delay(35000);
    assert.equal(streamBody, "");
    // Match production's 15s body timeout: this slow upload overlaps HUP,
    // while the independently established SSE has already been silent >30s.
    const buffered = request("/api/rehearsal/slow-post", {
      method: "POST",
      body: { synthetic: "buffered-before-HUP" },
      slow: true,
    });
    await buffered.startBody();
    assert.equal(
      (await stats()).slowPosts,
      0,
      "Nginx must buffer incomplete POST before upstream dispatch",
    );
    writeFileSync(join(directory, "nginx.conf"), nginxConfig("green"));
    markPhase("reload-validation");
    await dockerAsync(["exec", nginx, "nginx", "-t"]);
    markPhase("nginx-hup-requested");
    await dockerAsync(["kill", "--signal", "HUP", nginx]);
    markPhase("nginx-hup-returned");
    const greenAddress =
      (await inspectAsync(green)).NetworkSettings.Networks[id].IPAddress +
      ":3000";
    const blueAddress =
      (await inspectAsync(blue)).NetworkSettings.Networks[id].IPAddress +
      ":3000";
    await until(async () => {
      const response = await call("/__citygo_web_slot");
      return (
        response.status === 200 &&
        response.headers["x-citygo-web-slot"] === greenAddress &&
        JSON.parse(response.body).status === "ok"
      );
    }, "Fresh TLS connection did not reach green Next/API readiness");
    const freshHtml = await call("/");
    assert.equal(freshHtml.status, 200);
    assert.equal(freshHtml.headers["x-citygo-web-slot"], greenAddress);
    assert.match(freshHtml.body, /<!DOCTYPE html>/i);
    markPhase("green-confirmed-old-generation-active");
    const retainedWorkers = await workers();
    assert.ok(
      oldWorkers.some((old) =>
        retainedWorkers.some(
          (live) => live.pid === old.pid && live.starttime === old.starttime,
        ),
      ),
      "Old Nginx generation must retain in-flight requests",
    );
    assert.equal((await inspectAsync(blue)).State.Running, true);
    const duplicate = await call("/api/rehearsal/messages", {
      method: "POST",
      body: { requestId },
    });
    assert.equal(duplicate.status, 409);
    buffered.finishBody();
    const post = await buffered.promise;
    assert.equal(post.status, 200);
    assert.equal(post.headers["x-citygo-web-slot"], blueAddress);
    await controlAsync({ release: true });
    const completedStream = await stream;
    assert.equal(completedStream.status, 200);
    assert.equal(completedStream.headers["x-citygo-web-slot"], blueAddress);
    assert.match(completedStream.body, /Synthetic complete answer/);
    assert.equal(
      (completedStream.body.match(/"type":"done"/g) ?? []).length,
      1,
    );
    await until(
      async () => {
        const liveWorkers = await workers();
        return !oldWorkers.some((old) =>
          liveWorkers.some(
            (live) => live.pid === old.pid && live.starttime === old.starttime,
          ),
        );
      },
      "Old Nginx worker generation did not drain",
      45000,
    );
    markPhase("old-generation-drained");
    await dockerAsync(["kill", "--signal", "SIGTERM", blue]);
    await until(
      async () => !(await inspectAsync(blue)).State.Running,
      "Old Web did not stop after Nginx generation drained",
      45000,
    );
    markPhase("old-web-stopped");
    const stoppedBlue = await inspectAsync(blue);
    assert.equal(stoppedBlue.State.ExitCode, 0);
    assert.equal(stoppedBlue.State.OOMKilled, false);
    for (const item of inventory) {
      const response = await call("/_next/static/" + item.path);
      assert.equal(response.status, 200);
      assert.equal(response.headers["x-rehearsal-archived"], "true");
      assert.equal(digest(response.bytes), item.hash);
    }
    const final = await stats();
    assert.equal(final.dispatches, 1);
    assert.equal(final.syntheticDebits, 1);
    assert.equal(final.completed, 1);
    assert.equal(final.cancelled, 0);
    assert.equal(final.slowPosts, 1);
    assert.equal(final.messages.length, 1);
    assert.equal(final.forwarding[0].origin, origin);
    assert.equal(final.forwarding[0].forwardedProto, "https");
    assert.ok(final.forwarding[0].forwardedFor);
    const finalFixtureIdentity = await inspectAsync(fixture);
    assert.equal(
      finalFixtureIdentity.State.StartedAt,
      fixtureIdentity.State.StartedAt,
    );
    assert.equal(
      finalFixtureIdentity.RestartCount,
      fixtureIdentity.RestartCount,
    );
    assert.equal(
      (await inspectAsync(green)).State.StartedAt,
      webIdentity[1].State.StartedAt,
    );
    probing = false;
    await probes;
    const admissionSnapshot = await stats();
    for (const failure of failures) {
      failure.admittedToFixtureApi = admissionSnapshot.requestAdmissions.some(
        (entry) => entry.id === failure.trace?.id,
      );
    }
    const transport = classifyProbeFailures(failures, timeline);
    writeFileSync(
      join(evidence, "observations.json"),
      JSON.stringify(
        {
          failures,
          observations,
          probeStarts,
          blueAddress,
          greenAddress,
          syntheticCounters: admissionSnapshot,
          oldWorkers,
          timeline,
          transport,
        },
        null,
        2,
      ),
    );
    // Stop probes before logout can intentionally invalidate their session.
    assert.deepEqual(
      transport.unexpectedFailures,
      [],
      "Fresh, admitted, uncertain or non-HUP probe failures cannot pass",
    );
    assert.ok(
      admissionSnapshot.requestAdmissions.every((entry) => entry.visits === 1),
      "Each admitted HTTP trace ID must occur exactly once; no request replay",
    );
    assert.ok(observations.length >= 600);
    assert.ok(observations.some((item) => item.slot === blueAddress));
    assert.ok(observations.some((item) => item.slot === greenAddress));
    const loggedOut = await call("/api/rehearsal/logout", {
      method: "POST",
      body: {},
    });
    assert.equal(loggedOut.status, 200);
    assert.equal((await call("/api/rehearsal/probe")).status, 401);
    const result = {
      ...rehearsalPlan(selection),
      status: transport.idleReuseResets.length
        ? "passed-with-idle-connection-closure"
        : "passed",
      fixture: id,
      actualImageSource: source,
      distinctReleaseTested: false,
      probes: observations.length,
      probeAttempts: probeStarts.length * 2,
      freshProbeSuccesses: observations.filter(
        (entry) => entry.kind === "fresh",
      ).length,
      keepaliveProbeSuccesses: observations.filter(
        (entry) => entry.kind === "keepalive",
      ).length,
      freshFailures: transport.freshFailures.length,
      admittedFailures: transport.admittedFailures.length,
      otherFailures: transport.otherFailures.length,
      idleReuseResetCount: transport.idleReuseResets.length,
      idleReuseResets: transport.idleReuseResets,
      zeroHttpRetries: true,
      allHttpAttemptsSucceeded: failures.length === 0,
      archivedAssets: inventory.length,
      maximumProbeStartGapMs: probeStarts.reduce(
        (maximum, item, index) =>
          Math.max(maximum, index ? item - probeStarts[index - 1] : 0),
        0,
      ),
      transportSessionAndSyntheticOnceCounters: true,
      productionControllerInvoked: false,
      nginxConfiguration:
        "isolated transport fixture; actual production opt-in template validated with pinned nginx -t",
      productionOptInNginxConfigValidated: true,
      productionOptInNginxConfigSha256: digest(Buffer.from(productionConfig)),
      clientBodyTimeoutSeconds: 15,
      realApiDatabaseAndMonetaryIntegrationTested: false,
      evidenceDirectory: evidence,
    };
    writeFileSync(
      join(evidence, "report.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    writeFileSync(
      join(evidence, "failure.txt"),
      `${String(error.stack ?? error)}\n`,
    );
    console.error(
      `Disposable rehearsal failed; retained fixture evidence: ${evidence}`,
    );
    throw error;
  } finally {
    probing = false;
    for (const request of requests) request.destroy();
    if (probes) await probes.catch(() => {});
    agent?.destroy();
    for (const extra of extraAgents) extra.destroy();
    writeFileSync(
      join(evidence, "request-traces.json"),
      JSON.stringify({ timeline, requestTraces }, null, 2),
    );
    for (const container of containers.reverse()) {
      const state = inspect(container);
      assert.equal(state.Config.Labels["citygo.rehearsal"], id);
      const name = state.Name.replace(/^\//, "");
      writeFileSync(
        join(evidence, name + "-state.json"),
        JSON.stringify(
          {
            Id: state.Id,
            Image: state.Image,
            Name: state.Name,
            State: state.State,
            RestartCount: state.RestartCount,
            NetworkSettings: state.NetworkSettings,
            Labels: state.Config.Labels,
          },
          null,
          2,
        ),
      );
      const logs = spawnSync("docker", ["logs", "--tail", "200", container], {
        cwd: root,
        env,
        windowsHide: true,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      writeFileSync(
        join(evidence, name + ".log"),
        String(logs.stdout ?? "") + String(logs.stderr ?? ""),
      );
      docker(["rm", "-f", container]);
    }
    for (const network of createdNetworks.reverse()) {
      const metadata = JSON.parse(docker(["network", "inspect", network]))[0];
      assert.equal(metadata.Id, network);
      assert.equal(metadata.Labels["citygo.rehearsal"], id);
      docker(["network", "rm", network]);
    }
    assert.equal(
      resolve(directory).startsWith(resolve(tmpdir()) + "/") ||
        resolve(directory).startsWith(resolve(tmpdir()) + "\\"),
      true,
    );
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(
      join(evidence, "cleanup.json"),
      JSON.stringify(
        {
          ownedContainersRemoved: containers,
          ownedNetworksRemoved: createdNetworks,
          temporaryDirectoryRemoved: directory,
        },
        null,
        2,
      ),
    );
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan"))
    console.log(JSON.stringify(rehearsalPlan(), null, 2));
  else if (args.includes("--disposable")) {
    const values = {};
    for (const arg of args) {
      if (arg === "--disposable") continue;
      if (arg === "--idle-reuse-regression") {
        assert.equal(
          values.idleReuseRegression,
          undefined,
          "Duplicate regression option",
        );
        values.idleReuseRegression = true;
        continue;
      }
      const match = arg.match(
        /^--(web-image|node-image|nginx-image|source-sha)=(.+)$/,
      );
      assert.ok(match, "Only explicit fixture images/source are accepted");
      assert.equal(values[match[1]], undefined, "Duplicate fixture option");
      values[match[1]] = match[2];
    }
    await runRehearsal({
      images: {
        web: values["web-image"],
        node: values["node-image"],
        nginx: values["nginx-image"],
      },
      source: values["source-sha"],
      idleReuseRegression: values.idleReuseRegression === true,
    });
  } else
    throw new Error(
      "Use --plan or --disposable with full local image IDs and --source-sha; no production target is accepted",
    );
}
