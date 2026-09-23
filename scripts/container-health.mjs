const paths = {
  api: "http://127.0.0.1:4000/ready",
  web: "http://127.0.0.1:3000/api/ready",
};
try {
  const url = paths[process.argv[2]];
  if (!url) throw new Error("Invalid mode");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!response.ok || (await response.json()).status !== "ok")
    throw new Error("Not ready");
} catch {
  process.exitCode = 1;
}
