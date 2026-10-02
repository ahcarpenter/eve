// Workflow world for the local run only.
//
// The span that is ended twice, workflow.stream.read.connect, is created by
// the Vercel world's streams.get(). Off Vercel eve uses the local world, which
// reads streams from disk and has no such span, so the fault cannot show.
//
// This world is eve's local world for everything except streams.get(), which
// is eve's own unmodified Vercel streams.get(). Its HTTP request goes to a
// loopback server in this process that answers with the bytes the local world
// holds for that stream. Nothing leaves the machine.
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createWorld as createLocalWorld } from "../node_modules/eve/dist/src/compiled/@workflow/world-local/index.js";
import { createStreamer } from "../node_modules/eve/dist/src/compiled/@workflow/world-vercel/index.js";

export async function createWorld() {
  const local = await createLocalWorld({
    dataDir: join(process.cwd(), ".eve", ".workflow-data"),
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/v3\/runs\/([^/]+)\/stream\/([^/]+)$/);
    if (req.method !== "GET" || !match) {
      res.writeHead(404).end();
      return;
    }
    const startIndex = url.searchParams.get("startIndex");
    try {
      const body = await local.streams.get(
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
        startIndex === null ? undefined : Number(startIndex),
      );
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const readable = Readable.fromWeb(body);
      res.on("close", () => readable.destroy());
      readable.pipe(res);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();

  // A project, a team and a token make the Vercel world send its requests to
  // WORKFLOW_VERCEL_BACKEND_URL with that token, and skip the lookup of a
  // Vercel OIDC token. All three are placeholders.
  process.env.WORKFLOW_VERCEL_BACKEND_URL = `http://127.0.0.1:${server.address().port}`;
  const vercel = createStreamer({
    token: "loopback",
    projectConfig: { projectId: "loopback", teamId: "loopback" },
  });

  const streams = new Proxy(local.streams, {
    get: (target, prop) =>
      prop === "get" ? vercel.streams.get : Reflect.get(target, prop, target),
  });
  return new Proxy(local, {
    get: (target, prop) =>
      prop === "streams" ? streams : Reflect.get(target, prop, target),
  });
}
