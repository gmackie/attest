/** Bounded body reads: a byte counter over the stream, aborting as soon as the limit is passed. */
export class BodyLimitError extends Error {
  constructor(readonly code: "payload_too_large" | "length_required" | "invalid_body", readonly status: number) {
    super(code);
  }
}

export async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyLimitError("payload_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Content-Length is required and must be within the limit; the stream is then counted too. */
export async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^[0-9]{1,10}$/.test(declared)) throw new BodyLimitError("length_required", 411);
  if (Number(declared) > maxBytes) throw new BodyLimitError("payload_too_large", 413);
  const bytes = await readLimited(request.body, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BodyLimitError("invalid_body", 400);
  }
}
