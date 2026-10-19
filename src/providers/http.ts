export interface ProviderHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Optional hard deadline for a provider call; no change for existing callers. */
  readonly timeoutMs?: number;
}

export interface ProviderHttpResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

export interface ProviderHttpClient {
  request<T = unknown>(
    request: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<T>>;
}

export class FetchProviderHttpClient implements ProviderHttpClient {
  async request<T = unknown>(
    request: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<T>> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(request.timeoutMs),
      body: request.body === undefined
        ? undefined
        : JSON.stringify(request.body)
    });

    const text = await response.text();
    let body: unknown = undefined;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return {
      status: response.status,
      body: body as T
    };
  }
}
