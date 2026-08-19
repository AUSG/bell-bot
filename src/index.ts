import { handleAppMention, parseEventsRequest } from "./slack/events";
import { handleInteraction, openGroupManager } from "./slack/interactions";
import { verifySlackRequest } from "./slack/verify";

const EVENTS_PATH = "/slack/events";
const COMMANDS_PATH = "/slack/commands";
const INTERACTIONS_PATH = "/slack/interactions";
const SLACK_PATHS = new Set([EVENTS_PATH, COMMANDS_PATH, INTERACTIONS_PATH]);
const MAX_SLACK_BODY_BYTES = 1_000_000;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!SLACK_PATHS.has(url.pathname)) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    try {
      const body = await readBoundedBody(request);
      const verified = await verifySlackRequest({
        body,
        signature: request.headers.get("X-Slack-Signature"),
        timestamp: request.headers.get("X-Slack-Request-Timestamp"),
        signingSecret: env.SLACK_SIGNING_SECRET,
      });
      if (!verified) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === EVENTS_PATH) {
        return handleEvents(body, request, env, ctx);
      }
      if (hasSlackRetryHeader(request)) {
        return emptyOk();
      }
      if (url.pathname === COMMANDS_PATH) {
        return handleSlashCommand(body, env, ctx);
      }
      return handleInteractionRequest(body, env, ctx);
    } catch (error: unknown) {
      if (error instanceof RequestBodyTooLargeError) {
        return new Response("Payload Too Large", { status: 413 });
      }

      logError("request", error, url.pathname);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

function handleEvents(
  body: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Response {
  const payload = parseJson(body);
  const eventRequest = parseEventsRequest(payload);
  if (!eventRequest) {
    return new Response("Invalid event payload", { status: 400 });
  }

  if (eventRequest.type === "url_verification") {
    return new Response(eventRequest.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (hasSlackRetryHeader(request) || eventRequest.type === "ignored") {
    return emptyOk();
  }

  runInBackground(ctx, handleAppMention(eventRequest.event, env), "app_mention");
  return emptyOk();
}

function handleSlashCommand(body: string, env: Env, ctx: ExecutionContext): Response {
  const form = new URLSearchParams(body);
  if (form.get("ssl_check") === "1") {
    return emptyOk();
  }
  if (form.get("command") !== "/bell") {
    return new Response("Unknown command", { status: 400 });
  }

  const triggerId = form.get("trigger_id");
  if (!triggerId) {
    return new Response("Missing trigger_id", { status: 400 });
  }

  runInBackground(ctx, openGroupManager(triggerId, env), "open_group_manager");
  return emptyOk();
}

async function handleInteractionRequest(
  body: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const encodedPayload = new URLSearchParams(body).get("payload");
  if (!encodedPayload) {
    return new Response("Missing interaction payload", { status: 400 });
  }
  return handleInteraction(parseJson(encodedPayload), env, ctx);
}

function runInBackground(
  ctx: ExecutionContext,
  promise: Promise<void>,
  operation: string,
): void {
  ctx.waitUntil(
    promise.catch((error: unknown) => {
      logError(operation, error);
    }),
  );
}

function hasSlackRetryHeader(request: Request): boolean {
  return request.headers.has("X-Slack-Retry-Num");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && Number(declaredLength) > MAX_SLACK_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    const value: unknown = result.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      throw new TypeError("Request body contained a non-byte chunk");
    }

    totalLength += value.byteLength;
    if (totalLength > MAX_SLACK_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function emptyOk(): Response {
  return new Response(null, { status: 200 });
}

function logError(operation: string, error: unknown, path?: string): void {
  console.error(
    JSON.stringify({
      message: "Bell request failed",
      operation,
      ...(path ? { path } : {}),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

class RequestBodyTooLargeError extends Error {}
