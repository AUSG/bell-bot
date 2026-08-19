import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openModal,
  postMessage,
} from "../src/slack/client";
import type { SlackApiError } from "../src/slack/client";
import type { SlackModalView } from "../src/types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Slack Web API client", () => {
  it("retries chat.postMessage once after a bounded 429 response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "Retry-After": "0" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await postMessage(env, {
      channel: "C123ABC",
      text: "hello",
      blocks: [],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://slack.com/api/chat.postMessage",
    );
  });

  it("does not wait and retry views.open because trigger IDs expire quickly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "0" } },
      ),
    );

    await expect(openModal(env, "trigger-id", emptyModal())).rejects.toMatchObject({
      method: "views.open",
      slackError: "ratelimited",
      status: 429,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled views.open request before the trigger ID expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );

    const request = openModal(env, "trigger-id", emptyModal());
    const assertion = expect(request).rejects.toEqual(
      expect.objectContaining<Partial<SlackApiError>>({
        method: "views.open",
        slackError: "request_timeout",
        status: 0,
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(init?.headers)),
    },
  });
}

function emptyModal(): SlackModalView {
  return {
    type: "modal",
    callback_id: "test",
    private_metadata: "{}",
    title: { type: "plain_text", text: "Bell" },
    submit: { type: "plain_text", text: "저장" },
    close: { type: "plain_text", text: "취소" },
    blocks: [],
  };
}
