import type { ServerWebSocket } from "bun";
import {
  normalizeWorkspaceUrl,
  RealtimeConnection,
  SlackClient,
  type Credentials,
} from "./src/slack.ts";

const port = Number(process.env.PORT ?? 4747);
const hostname = process.env.HOST ?? "127.0.0.1";

const build = await Bun.build({
  entrypoints: [new URL("./src/client.ts", import.meta.url).pathname],
  target: "browser",
  sourcemap: "inline",
  // The Chime SDK's dependencies expect Node's `global`.
  define: { global: "globalThis" },
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}
const clientJs = await build.outputs[0]!.text();

type Identity = Awaited<ReturnType<SlackClient["authTest"]>>;
type UiMessage = Record<string, unknown> & { kind: string };

let slack: SlackClient | undefined;
let identity: Identity | undefined;
let realtime: RealtimeConnection | undefined;
let realtimeStatus = "offline";
const sockets = new Set<ServerWebSocket<unknown>>();
// Replayed to a page that connects later, so a refresh keeps recent events.
const recentEvents: UiMessage[] = [];

function broadcast(message: UiMessage) {
  if (message.kind === "rtm") {
    recentEvents.push(message);
    if (recentEvents.length > 300) recentEvents.shift();
  }
  const data = JSON.stringify(message);
  for (const socket of sockets) socket.send(data);
}

function state() {
  return {
    connected: Boolean(slack),
    workspaceUrl: slack?.credentials.workspaceUrl,
    identity,
    realtimeStatus,
  };
}

async function connect(credentials: Credentials) {
  disconnect();
  let workspaceUrl: string;
  try {
    workspaceUrl = normalizeWorkspaceUrl(credentials.workspaceUrl);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const client = new SlackClient({
    workspaceUrl,
    xoxc: credentials.xoxc.trim(),
    xoxd: credentials.xoxd.trim(),
  });
  const me = await client.authTest();
  slack = client;
  identity = me;
  realtime = new RealtimeConnection(
    client,
    me.enterpriseId ?? me.teamId,
    (event) => broadcast({ kind: "rtm", at: Date.now(), event }),
    (status) => {
      realtimeStatus = status;
      broadcast({ kind: "state", ...state() });
    },
  );
  realtime.start();
  broadcast({ kind: "state", ...state() });
  return state();
}

function disconnect() {
  realtime?.stop();
  realtime = undefined;
  slack = undefined;
  identity = undefined;
  realtimeStatus = "offline";
  recentEvents.length = 0;
  broadcast({ kind: "state", ...state() });
}

function requireSlack() {
  if (!slack) throw new HttpError(409, "Not connected to Slack");
  return slack;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function string(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(400, `${key} is required`);
  return value.trim();
}

const allowedHosts = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
]);

// The server holds live Slack credentials, so only this page may use it:
// another site in the same browser could otherwise drive it, directly or
// through DNS rebinding.
function trusted(request: Request) {
  if (!allowedHosts.has(request.headers.get("host") ?? "")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return request.method === "GET";
  try {
    return allowedHosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

function api(
  handler: (body: Record<string, unknown>) => Promise<unknown> | unknown,
) {
  return async (request: Request) => {
    if (!trusted(request)) return new Response("Forbidden", { status: 403 });
    try {
      const body =
        request.method === "POST"
          ? ((await request.json()) as Record<string, unknown>)
          : {};
      return Response.json(await handler(body ?? {}));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status },
      );
    }
  };
}

function file(path: string, type: string) {
  return (request: Request) =>
    trusted(request)
      ? new Response(Bun.file(new URL(path, import.meta.url)), {
          headers: { "content-type": type },
        })
      : new Response("Forbidden", { status: 403 });
}

const server = Bun.serve({
  port,
  hostname,
  routes: {
    "/": file("./src/index.html", "text/html; charset=utf-8"),
    "/style.css": file("./src/style.css", "text/css; charset=utf-8"),
    "/client.js": (request) =>
      trusted(request)
        ? new Response(clientJs, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          })
        : new Response("Forbidden", { status: 403 }),
    "/api/state": api(() => state()),
    "/api/connect": {
      POST: api((body) =>
        connect({
          workspaceUrl: string(body, "workspaceUrl"),
          xoxc: string(body, "xoxc"),
          xoxd: string(body, "xoxd"),
        }),
      ),
    },
    "/api/disconnect": {
      POST: api(() => {
        disconnect();
        return state();
      }),
    },
    "/api/join": {
      POST: api((body) =>
        requireSlack().join(
          string(body, "channelId"),
          typeof body.region === "string" && body.region
            ? body.region
            : "us-east-1",
        ),
      ),
    },
    "/api/join-invite": {
      POST: api((body) =>
        requireSlack().joinInvite(
          string(body, "channelId"),
          string(body, "callId"),
          body.freeWilly,
        ),
      ),
    },
    "/api/leave": {
      POST: api((body) =>
        requireSlack().leave(
          string(body, "channelId"),
          string(body, "callId"),
          typeof body.attendeeId === "string" ? body.attendeeId : undefined,
        ),
      ),
    },
    "/api/decline": {
      POST: api((body) =>
        requireSlack().declineInvite(
          string(body, "channelId"),
          string(body, "callId"),
        ),
      ),
    },
    "/api/room-info": {
      POST: api((body) => requireSlack().roomInfo(string(body, "callId"))),
    },
    // Any Web API method, as the user.
    "/api/slack": {
      POST: api((body) => {
        const fields = body.fields ?? {};
        if (typeof fields !== "object" || Array.isArray(fields))
          throw new HttpError(400, "fields must be an object");
        return requireSlack().call(
          string(body, "method"),
          Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              typeof value === "string" ? value : JSON.stringify(value),
            ]),
          ),
        );
      }),
    },
  },
  fetch(request, server) {
    if (new URL(request.url).pathname === "/ws") {
      if (!trusted(request)) return new Response("Forbidden", { status: 403 });
      if (server.upgrade(request)) return;
      return new Response("Upgrade required", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      socket.send(JSON.stringify({ kind: "state", ...state() }));
      for (const message of recentEvents) socket.send(JSON.stringify(message));
    },
    close(socket) {
      sockets.delete(socket);
    },
    message() {},
  },
});

console.log(`Slack huddle playground on http://${hostname}:${server.port}`);

const { SLACK_WORKSPACE_URL, SLACK_XOXC, SLACK_XOXD } = process.env;
if (SLACK_WORKSPACE_URL && SLACK_XOXC && SLACK_XOXD) {
  connect({
    workspaceUrl: SLACK_WORKSPACE_URL,
    xoxc: SLACK_XOXC,
    xoxd: SLACK_XOXD,
  })
    .then(({ identity }) =>
      console.log(`Connected as ${identity?.user} (${identity?.userId})`),
    )
    .catch((error) => console.error(`Could not connect: ${error.message}`));
}
