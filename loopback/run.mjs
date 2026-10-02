// Local run: builds the agent with the loopback world, starts it, creates one
// session, reads its stream three times and prints what the server logged.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const SPAN = "workflow.stream.read.connect";
const MESSAGE = "You can only call end() on a span once.";
const STREAM_REQUESTS = 3;

// REPRO_LOOPBACK=0 keeps eve's own local world, as a control.
const env = { REPRO_LOOPBACK: "1", ...process.env };

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilHealthy(base) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${base}/eve/v1/health`)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("the server did not become healthy within 30 seconds");
}

// Reads the session's stream until the turn is over, then hangs up.
async function readStream(base, sessionId) {
  const response = await fetch(`${base}/eve/v1/session/${sessionId}/stream`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`stream answered ${response.status}`);
  const types = [];
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines.filter(Boolean)) types.push(JSON.parse(line).type);
    if (types.includes("session.waiting")) break;
  }
  return types;
}

// The sandbox is not used: the model never calls a tool.
const build = spawnSync("npx", ["eve", "build", "--skip-sandbox-prewarm"], {
  env,
  encoding: "utf8",
});
if (build.status !== 0) {
  process.stderr.write(`${build.stdout}${build.stderr}`);
  process.exit(1);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  "npx",
  ["eve", "start", "--host", "127.0.0.1", "--port", String(port)],
  { env, detached: true },
);
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));

try {
  await waitUntilHealthy(base);

  const created = await fetch(`${base}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  const { sessionId } = await created.json();
  console.log(`POST /eve/v1/session -> ${created.status} ${sessionId}`);

  for (let request = 1; request <= STREAM_REQUESTS; request++) {
    const types = await readStream(base, sessionId);
    console.log(
      `GET /eve/v1/session/${sessionId}/stream -> ${types.length} events, ${types[0]} to ${types.at(-1)}`,
    );
  }
  await sleep(1000);
} finally {
  process.kill(-server.pid, "SIGTERM");
}

const lines = serverLog.split("\n").filter((line) => line.includes(MESSAGE));
const streamLines = lines.filter((line) => line.startsWith(SPAN));
console.log(`\n--- server log lines with "${MESSAGE}"`);
console.log(lines.join("\n") || "(none)");
console.log(
  `\nworld: ${env.REPRO_LOOPBACK === "1" ? "loopback (Vercel stream reader)" : "eve local world"}`,
);
console.log(
  `traceChannelRequests: ${env.REPRO_TRACE_CHANNEL_REQUESTS !== "false"}`,
);
console.log(`stream requests: ${STREAM_REQUESTS}`);
console.log(`"${SPAN} ... ${MESSAGE}" lines: ${streamLines.length}`);
