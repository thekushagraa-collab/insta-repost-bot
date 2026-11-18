import { describe, expect, it, vi } from "vitest";
import { createGraphClient, GraphApiError, type FetchLike } from "../src/graph";

const TOKEN = "SECRET-TOKEN-123";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function clientWith(fetchImpl: FetchLike, sleep = vi.fn(async () => undefined)) {
  return { client: createGraphClient({ token: TOKEN, apiVersion: "v24.0", fetchImpl, sleep }), sleep };
}

describe("createGraphClient", () => {
  it("sends the token in the Authorization header and never in the URL", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { id: "1" }));
    const { client } = clientWith(fetchImpl);

    await client.get("me", { params: { fields: "user_id,username", skip: undefined } });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://graph.instagram.com/v24.0/me?fields=user_id%2Cusername");
    expect(url).not.toContain(TOKEN);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("posts a JSON body", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { id: "c1" }));
    const { client } = clientWith(fetchImpl);

    await client.post("42/media", { body: { media_type: "REELS" } });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"media_type":"REELS"}');
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("puts the token in the query only for unversioned token endpoints", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { access_token: "x", expires_in: 1 }));
    const { client } = clientWith(fetchImpl);

    await client.get("refresh_access_token", { params: { grant_type: "ig_refresh_token" }, versioned: false, tokenInQuery: true });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`);
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("turns an API error into a GraphApiError with the user-facing message and no token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse(400, { error: { message: "Invalid parameter", code: 100, error_subcode: 2207026, error_user_msg: "Video too long" } }),
    );
    const { client, sleep } = clientWith(fetchImpl);

    const error = await client.get("me").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphApiError);
    expect((error as GraphApiError).message).toBe("GET me failed: Video too long");
    expect((error as GraphApiError).code).toBe(100);
    expect((error as GraphApiError).subcode).toBe(2207026);
    expect((error as GraphApiError).message).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries server errors with backoff and then succeeds", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: "boom" } }))
      .mockResolvedValueOnce(jsonResponse(200, { error: { message: "busy", is_transient: true } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client, sleep } = clientWith(fetchImpl);

    await expect(client.get("me")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it("gives up after the retry limit on network errors", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNRESET");
    });
    const { client } = clientWith(fetchImpl);

    await expect(client.get("me")).rejects.toThrow("Network error calling GET me: ECONNRESET");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("never retries a call marked retry: false", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(503, { error: { message: "down" } }));
    const { client } = clientWith(fetchImpl);

    await expect(client.post("42/media_publish", { body: {}, retry: false })).rejects.toThrow("down");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a non-JSON body as an error", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("<html>bad gateway</html>", { status: 400 }));
    const { client } = clientWith(fetchImpl);

    await expect(client.get("me")).rejects.toThrow("GET me failed: HTTP 400");
  });
});

describe("upload", () => {
  const URI = "https://rupload.facebook.com/ig-api-upload/v24.0/c1";

  it("sends the bytes with OAuth auth, offset and file_size", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { success: true }));
    const { client } = clientWith(fetchImpl);

    await client.upload(URI, new Uint8Array([1, 2, 3]));

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URI);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `OAuth ${TOKEN}`, offset: "0", file_size: "3" });
  });

  it("never sends the token to a host other than rupload.facebook.com", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const { client } = clientWith(fetchImpl);

    await expect(client.upload("https://evil.example/ig-api-upload/x", new Uint8Array([1]))).rejects.toThrow("unexpected upload address");
    await expect(client.upload("http://rupload.facebook.com/ig-api-upload/x", new Uint8Array([1]))).rejects.toThrow("unexpected upload address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports Meta's reason without the token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(400, { debug_info: { message: "Video too long" } }));
    const { client } = clientWith(fetchImpl);

    const error = await client.upload(URI, new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphApiError);
    expect((error as Error).message).toBe("Video upload failed: Video too long");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("retries a server error and then succeeds", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const { client, sleep } = clientWith(fetchImpl);

    await client.upload(URI, new Uint8Array([1]));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("delete", () => {
  it("sends DELETE with the token in the header and never retries", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(503, {}));
    const { client, sleep } = clientWith(fetchImpl);

    await expect(client.delete("123")).rejects.toBeInstanceOf(GraphApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://graph.instagram.com/v24.0/123");
    expect(init?.method).toBe("DELETE");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
