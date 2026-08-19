import type { SlackBlock, SlackModalView } from "../types";

const SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_REQUEST_TIMEOUT_MS = 8_000;
const SLACK_MODAL_OPEN_TIMEOUT_MS = 2_000;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 8_000;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface PostMessageOptions {
  channel: string;
  text: string;
  blocks: SlackBlock[];
  threadTs?: string;
}

interface UpdateModalOptions {
  viewId: string;
  view: SlackModalView;
  hash?: string;
}

interface SlackApiCallOptions {
  timeoutMs: number;
  retryRateLimit: boolean;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string,
    readonly status: number,
  ) {
    super(`Slack API ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
  }
}

export async function postMessage(env: Env, options: PostMessageOptions): Promise<void> {
  await callSlackApi(
    env,
    "chat.postMessage",
    {
      channel: options.channel,
      text: options.text,
      blocks: options.blocks,
      unfurl_links: false,
      unfurl_media: false,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    },
    { timeoutMs: SLACK_REQUEST_TIMEOUT_MS, retryRateLimit: true },
  );
}

export async function openModal(
  env: Env,
  triggerId: string,
  view: SlackModalView,
): Promise<void> {
  await callSlackApi(
    env,
    "views.open",
    {
      trigger_id: triggerId,
      view,
    },
    { timeoutMs: SLACK_MODAL_OPEN_TIMEOUT_MS, retryRateLimit: false },
  );
}

export async function updateModal(env: Env, options: UpdateModalOptions): Promise<void> {
  await callSlackApi(
    env,
    "views.update",
    {
      view_id: options.viewId,
      view: options.view,
      ...(options.hash ? { hash: options.hash } : {}),
    },
    { timeoutMs: SLACK_REQUEST_TIMEOUT_MS, retryRateLimit: true },
  );
}

async function callSlackApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
  options: SlackApiCallOptions,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(
      `${SLACK_API_BASE_URL}/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
      },
      options.timeoutMs,
      method,
    );
    const result = await parseSlackApiResponse(response);

    if (response.status === 429 && options.retryRateLimit && attempt === 0) {
      const retryDelayMs = parseRetryAfter(response.headers.get("Retry-After"));
      if (retryDelayMs !== null && retryDelayMs <= MAX_RATE_LIMIT_RETRY_DELAY_MS) {
        await delay(retryDelayMs);
        continue;
      }
    }

    if (!result || !response.ok || !result.ok) {
      const slackError = result?.error ??
        (result ? `http_${response.status}` : "invalid_response");
      throw new SlackApiError(method, slackError, response.status);
    }
    return;
  }

  throw new SlackApiError(method, "rate_limited", 429);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  method: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new SlackApiError(method, "request_timeout", 0);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseSlackApiResponse(response: Response): Promise<SlackApiResponse | null> {
  try {
    const result: unknown = await response.json();
    return isSlackApiResponse(result) ? result : null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isSlackApiResponse(value: unknown): value is SlackApiResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    (!("error" in value) || value.error === undefined || typeof value.error === "string")
  );
}
