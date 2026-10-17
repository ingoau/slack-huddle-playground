import type { ServerWebSocket } from "bun";
import { NativeCall } from "./src/native/native-call.ts";
import { ReactionLoop } from "./src/native/reaction-loop.ts";
import { reactionTypes, type ReactionType } from "./src/peer-message.ts";
import { RingBuffer } from "./src/ring-buffer.ts";
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
const recentEvents = new RingBuffer<UiMessage>(300);
// Huddles joined natively live here, not in the page, so they outlast it.
const nativeCalls = new Map<string, NativeCall>();
let nextNativeId = 1;
const reactionLoops = new Map<string, ReactionLoop>();
let nextLoopId = 1;

// Messages to the page go out together every 50 ms, so a flood of reactions
// or presence changes is a few frames a second rather than one each.
let outbox: UiMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function broadcast(message: UiMessage) {
  if (message.kind === "rtm") recentEvents.push(message);
  if (!sockets.size) return;
  outbox.push(message);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    const data = JSON.stringify({ kind: "batch", messages: outbox });
    outbox = [];
    for (const socket of sockets) socket.send(data);
  }, 50);
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
  for (const loop of reactionLoops.values()) loop.stop("disconnected");
  for (const call of nativeCalls.values()) void leaveNative(call);
  realtime?.stop();
  realtime = undefined;
  slack = undefined;
  identity = undefined;
  realtimeStatus = "offline";
  recentEvents.clear();
  broadcast({ kind: "state", ...state() });
}

async function joinNative(join: Awaited<ReturnType<SlackClient["join"]>>) {
  const id = `n${nextNativeId++}`;
  const call = new NativeCall(
    id,
    join.channelId,
    join.callId,
    join.meeting,
    join.attendee,
    (event) => broadcast({ kind: "native", id, event }),
    (message) => console.log(`[native ${id}] ${message}`),
  );
  nativeCalls.set(id, call);
  // The page hears how it goes through status events.
  call.start().catch(() => {});
  return call.info();
}

async function leaveNative(call: NativeCall) {
  if (!nativeCalls.delete(call.id)) return;
  await call.leave().catch(() => {});
  broadcast({ kind: "native-left", id: call.id });
  await slack
    ?.leave(call.channelId, call.callId, call.attendeeId)
    .catch(() => {});
}

function startReactionLoop(body: Record<string, unknown>) {
  const callIds = body.callIds;
  if (!Array.isArray(callIds) || !callIds.every((id) => nativeCalls.has(id)))
    throw new HttpError(400, "callIds must list native huddles");
  const type = body.type as ReactionType | undefined;
  if (type !== undefined && !reactionTypes.includes(type))
    throw new HttpError(400, `type must be one of ${reactionTypes.join(", ")}`);
  const count = body.count === undefined ? undefined : Number(body.count);
  const id = `loop${nextLoopId++}`;
  const loop = new ReactionLoop(
    id,
    {
      callIds,
      emoji: string(body, "emoji"),
      type,
      emojiUrl:
        typeof body.emojiUrl === "string" && body.emojiUrl
          ? body.emojiUrl
          : undefined,
      intervalMs: Math.max(0, Number(body.intervalMs) || 0),
      burst: Math.max(1, Math.floor(Number(body.burst) || 1)),
      count: count !== undefined && count > 0 ? Math.floor(count) : undefined,
    },
    nativeCalls,
    (state) => {
      if (!state.running) reactionLoops.delete(id);
      broadcast({ kind: "reaction-loop", state });
    },
  );
  reactionLoops.set(id, loop);
  loop.start();
  return loop.state();
}

function requireNative(body: Record<string, unknown>) {
  const call = nativeCalls.get(string(body, "id"));
  if (!call) throw new HttpError(404, "No such native huddle");
  return call;
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
    "/api/native/join": {
      POST: api(async (body) =>
        joinNative(
          await requireSlack().join(
            string(body, "channelId"),
            typeof body.region === "string" && body.region
              ? body.region
              : "us-east-1",
          ),
        ),
      ),
    },
    "/api/native/join-invite": {
      POST: api(async (body) =>
        joinNative(
          await requireSlack().joinInvite(
            string(body, "channelId"),
            string(body, "callId"),
            body.freeWilly,
          ),
        ),
      ),
    },
    "/api/native/leave": {
      POST: api(async (body) => {
        await leaveNative(requireNative(body));
        return { ok: true };
      }),
    },
    "/api/native/send": {
      POST: api((body) => {
        const call = requireNative(body);
        call.send([
          {
            topic: string(body, "topic"),
            data: Buffer.from(String(body.data ?? ""), "base64"),
            lifetimeMs: Number(body.lifetimeMs) || 0,
          },
        ]);
        return { ok: true };
      }),
    },
    "/api/native/reaction-loop": {
      POST: api((body) => startReactionLoop(body)),
    },
    "/api/native/reaction-loop/stop": {
      POST: api((body) => {
        reactionLoops.get(string(body, "id"))?.stop();
        return { ok: true };
      }),
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
      socket.send(
        JSON.stringify({
          kind: "native-calls",
          calls: [...nativeCalls.values()].map((call) => call.info()),
        }),
      );
      for (const loop of reactionLoops.values())
        socket.send(
          JSON.stringify({ kind: "reaction-loop", state: loop.state() }),
        );
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
