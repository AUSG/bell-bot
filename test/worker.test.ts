import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createGroup } from "../src/db/groups";
import { GROUP_MANAGER_SHORTCUT_CALLBACK_ID } from "../src/slack/interactions";
import { signSlackBody } from "./helpers";

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM "groups"').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Worker routing and Slack authentication", () => {
  it("rejects unsigned Slack requests", async () => {
    const response = await SELF.fetch("https://bell.test/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "challenge" }),
    });
    expect(response.status).toBe(401);
  });

  it("answers a signed Events API URL verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "bell-challenge" });
    const response = await signedFetch("/slack/events", body, "application/json");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("bell-challenge");
  });

  it("acknowledges an Events API retry without processing it again", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C123ABC",
        user: "U123ABC",
        text: "<@U123ABC> 목록",
        ts: "1710000000.000001",
      },
    });
    const response = await signedFetch("/slack/events", body, "application/json", {
      "X-Slack-Retry-Num": "1",
    });
    expect(response.status).toBe(200);
  });

  it("returns 404 for unrelated paths", async () => {
    const response = await SELF.fetch("https://bell.test/");
    expect(response.status).toBe(404);
  });

  it("acknowledges an app mention and posts real member mentions in the background", async () => {
    await createGroup(env.DB, "행사 TF", ["U123ABC", "U456DEF"]);
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C123ABC",
        user: "U789GHI",
        text: "<@U999BOT> 행사 TF",
        ts: "1710000000.000002",
      },
    });
    const ctx = createExecutionContext();
    const request = await signedRequest("/slack/events", body, "application/json");

    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(slackFetch.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    const init = slackFetch.mock.calls[0]?.[1];
    const payload = parseRequestBody(init);
    expect(payload).toMatchObject({
      channel: "C123ABC",
      thread_ts: "1710000000.000002",
      text: "🔔 행사 TF — <@U123ABC> <@U456DEF>",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":bell: *행사 TF* — <@U123ABC> <@U456DEF>",
          },
        },
      ],
    });
  });

  it.each([
    {
      label: "same-line body",
      text: "<@U999BOT> 행사 TF 오늘 3시에 모여주세요",
    },
    {
      label: "group-only first line",
      text: "<@U999BOT> 행사 TF\n오늘 3시에 모여주세요",
    },
    {
      label: "same-line body followed by more lines",
      text: "<@U999BOT> 행사 TF 오늘 3시에 모여주세요\n장소는 회의실입니다\n늦지 않게 와주세요",
    },
    {
      label: "explicit pipe separator",
      text: "<@U999BOT> 행사 TF | 오늘 3시에 모여주세요",
    },
  ])("resolves a group before the $label", async ({ text }) => {
    await createGroup(env.DB, "행사 TF", ["U123ABC", "U456DEF"]);
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C123ABC",
        user: "U789GHI",
        text,
        ts: "1710000000.000003",
      },
    });
    const ctx = createExecutionContext();
    const request = await signedRequest("/slack/events", body, "application/json");

    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(slackFetch.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    expect(parseRequestBody(slackFetch.mock.calls[0]?.[1])).toMatchObject({
      channel: "C123ABC",
      thread_ts: "1710000000.000003",
      text: "🔔 행사 TF — <@U123ABC> <@U456DEF>",
    });
  });

  it("replies to the parent when Bell is mentioned in an existing thread", async () => {
    await createGroup(env.DB, "행사 TF", ["U123ABC"]);
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C123ABC",
        user: "U789GHI",
        text: "<@U999BOT> 행사 TF",
        ts: "1710000000.000005",
        thread_ts: "1710000000.000004",
      },
    });
    const ctx = createExecutionContext();
    const request = await signedRequest("/slack/events", body, "application/json");

    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    expect(parseRequestBody(slackFetch.mock.calls[0]?.[1])).toMatchObject({
      channel: "C123ABC",
      thread_ts: "1710000000.000004",
      text: "🔔 행사 TF — <@U123ABC>",
    });
  });

  it("shows group lists only to the member who requested them", async () => {
    await createGroup(env.DB, "행사 TF", ["U123ABC"]);
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C123ABC",
        user: "U789GHI",
        text: "<@U999BOT> 목록",
        ts: "1710000000.000006",
      },
    });
    const ctx = createExecutionContext();
    const request = await signedRequest("/slack/events", body, "application/json");

    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(slackFetch.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/chat.postEphemeral",
    );
    const payload = parseRequestBody(slackFetch.mock.calls[0]?.[1]);
    expect(payload).toMatchObject({
      channel: "C123ABC",
      user: "U789GHI",
    });
    expect(payload).not.toHaveProperty("thread_ts");
  });

  it("acknowledges /bell and opens a management modal in the background", async () => {
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const body = new URLSearchParams({
      command: "/bell",
      trigger_id: "trigger-id",
    }).toString();
    const ctx = createExecutionContext();
    const request = await signedRequest(
      "/slack/commands",
      body,
      "application/x-www-form-urlencoded",
    );

    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(slackFetch.mock.calls[0]?.[0]).toBe("https://slack.com/api/views.open");
    const init = slackFetch.mock.calls[0]?.[1];
    const payload = parseRequestBody(init);
    expect(payload).toMatchObject({ trigger_id: "trigger-id" });
  });

  it("acknowledges the global shortcut and opens the same management modal", async () => {
    const slackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: "shortcut",
        callback_id: GROUP_MANAGER_SHORTCUT_CALLBACK_ID,
        trigger_id: "shortcut-trigger-id",
        user: { id: "U123ABC" },
      }),
    }).toString();
    const ctx = createExecutionContext();
    const request = await signedRequest(
      "/slack/interactions",
      body,
      "application/x-www-form-urlencoded",
    );

    const response = await worker.fetch(
      request as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);

    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(slackFetch.mock.calls[0]?.[0]).toBe("https://slack.com/api/views.open");
    expect(parseRequestBody(slackFetch.mock.calls[0]?.[1])).toMatchObject({
      trigger_id: "shortcut-trigger-id",
      view: { callback_id: "bell_group_form" },
    });
  });
});

async function signedFetch(
  path: string,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(await signedRequest(path, body, contentType, extraHeaders));
}

async function signedRequest(
  path: string,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await signSlackBody(body, timestamp, env.SLACK_SIGNING_SECRET);
  return new Request(`https://bell.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
      ...extraHeaders,
    },
    body,
  });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a string request body");
  }
  return JSON.parse(init.body) as unknown;
}
