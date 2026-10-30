export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      headers:
        body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-Requested-With": "efiemipeg",
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ApiError(
      0,
      "We couldn’t reach the server. Check your connection and try again.",
    );
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof data?.message === "string" && response.status < 500
        ? data.message
        : "The service is temporarily unavailable. Please try again.",
      data?.errors ?? {},
    );
  }
  if (!data)
    throw new ApiError(
      0,
      "The server returned an unexpected response. Please try again.",
    );
  return data as T;
}
