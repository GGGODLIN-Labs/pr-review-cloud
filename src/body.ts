export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(limit) || limit < 0) return null;
  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null) {
    const declared = Number(rawLength.trim());
    if (Number.isFinite(declared) && declared > limit) return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      }
      if (!value || value.byteLength === 0) continue;
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
