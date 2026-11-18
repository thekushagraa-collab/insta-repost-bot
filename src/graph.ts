// Small client for Meta's Graph API. Two kinds of token work:
//   IG... tokens (Instagram Login)            -> graph.instagram.com, account = "me"
//   EAA... tokens (Unified / Facebook Login)  -> graph.facebook.com,  account = the Instagram user id
// The access token travels in the Authorization header, never in a URL, so it
// cannot leak into logs or error messages.

export const INSTAGRAM_HOST = "https://graph.instagram.com";
export const FACEBOOK_HOST = "https://graph.facebook.com";
export const GRAPH_HOST = INSTAGRAM_HOST;

/** Instagram Login tokens start with "IG". Anything else (EAA...) is a Facebook-issued token. */
export function isInstagramToken(token: string): boolean {
  return token.startsWith("IG");
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2_000;

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly isTransient = false,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  params?: QueryParams;
  body?: Record<string, unknown>;
  /** false for endpoints that live outside the version prefix, such as refresh_access_token. */
  versioned?: boolean;
  /** true only for endpoints that refuse the Authorization header (refresh_access_token). */
  tokenInQuery?: boolean;
  /** false for calls that must never be sent twice (media_publish). */
  retry?: boolean;
}

export interface GraphClient {
  /** Sends a video file to the rupload.facebook.com address Instagram returned for a resumable container. */
  upload(uploadUri: string, data: Uint8Array): Promise<void>;
  /** The account node calls are made for: "me" on graph.instagram.com, the Instagram user id on graph.facebook.com. */
  readonly accountNode?: string;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Never retried: a lost reply may hide a successful delete. */
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

export interface GraphClientOptions {
  token: string;
  apiVersion: string;
  host?: string;
  accountNode?: string;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  maxRetries?: number;
}

interface ErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    error_user_msg?: string;
  };
}

export function createGraphClient(options: GraphClientOptions): GraphClient {
  const host = options.host ?? GRAPH_HOST;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  function buildUrl(path: string, requestOptions: RequestOptions): string {
    const prefix = requestOptions.versioned === false ? "" : `/${options.apiVersion}`;
    const url = new URL(`${host}${prefix}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(requestOptions.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (requestOptions.tokenInQuery) url.searchParams.set("access_token", options.token);
    return url.toString();
  }

  async function requestOnce<T>(method: "GET" | "POST" | "DELETE", path: string, requestOptions: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {};
    if (!requestOptions.tokenInQuery) headers.Authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (method === "POST" && requestOptions.body) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(requestOptions.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(path, requestOptions), { method, headers, body });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new GraphApiError(`Network error calling ${method} ${path}: ${reason}`, 0, undefined, undefined, true);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }

    if (!response.ok || parsed === undefined || (parsed as ErrorBody).error) {
      throw toGraphError(method, path, response.status, parsed as ErrorBody | undefined);
    }
    return parsed as T;
  }

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, requestOptions: RequestOptions = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await requestOnce<T>(method, path, requestOptions);
      } catch (error) {
        const retryable = requestOptions.retry !== false && error instanceof GraphApiError && error.isTransient;
        if (!retryable || attempt >= maxRetries) throw error;
        attempt += 1;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }

  async function uploadOnce(target: URL, data: Uint8Array): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(target.toString(), {
        method: "POST",
        headers: { Authorization: `OAuth ${options.token}`, offset: "0", file_size: String(data.byteLength) },
        body: data as unknown as NonNullable<RequestInit["body"]>,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new GraphApiError(`Network error uploading the video: ${reason}`, 0, undefined, undefined, true);
    }
    const text = await response.text();
    let parsed: (ErrorBody & { debug_info?: { message?: string } }) | undefined;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    if (!response.ok || parsed === undefined || parsed.error || parsed.debug_info?.message) {
      const detail = parsed?.debug_info?.message ?? parsed?.error?.error_user_msg ?? parsed?.error?.message ?? `HTTP ${response.status}`;
      throw new GraphApiError(`Video upload failed: ${detail}`, response.status, parsed?.error?.code, undefined, response.status >= 500);
    }
  }

  async function upload(uploadUri: string, data: Uint8Array): Promise<void> {
    const target = new URL(uploadUri);
    // The token is sent to this address, so refuse anything that is not Meta's upload host.
    if (target.protocol !== "https:" || target.hostname !== "rupload.facebook.com" || !target.pathname.startsWith("/ig-api-upload/")) {
      throw new GraphApiError("Instagram returned an unexpected upload address. Not sending the video there.", 0);
    }
    let attempt = 0;
    for (;;) {
      try {
        return await uploadOnce(target, data);
      } catch (error) {
        const retryable = error instanceof GraphApiError && error.isTransient;
        if (!retryable || attempt >= maxRetries) throw error;
        attempt += 1;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }

  return {
    upload,
    accountNode: options.accountNode,
    get: (path, requestOptions) => request("GET", path, requestOptions),
    post: (path, requestOptions) => request("POST", path, requestOptions),
    delete: (path, requestOptions) => request("DELETE", path, { ...requestOptions, retry: false }),
  };
}

function toGraphError(method: string, path: string, status: number, body: ErrorBody | undefined): GraphApiError {
  const info = body?.error;
  const detail = info?.error_user_msg || info?.message || `HTTP ${status}`;
  const transient = status >= 500 || status === 0 || info?.is_transient === true;
  return new GraphApiError(`${method} ${path} failed: ${detail}`, status, info?.code, info?.error_subcode, transient);
}
