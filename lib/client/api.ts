export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal };

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const hasJson = options.body !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? (hasJson || options.raw ? "POST" : "GET"),
      headers: { ...(hasJson ? { "content-type": "application/json" } : {}), ...options.headers },
      body: hasJson ? JSON.stringify(options.body) : options.raw,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new HttpError(0, "You seem to be offline. We'll keep trying.", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. platform error page)
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string } | null;
    throw new HttpError(res.status, err?.error ?? `Request failed (${res.status}).`, err?.code);
  }
  return data as T;
}
