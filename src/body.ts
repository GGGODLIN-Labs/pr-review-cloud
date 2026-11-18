export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("Content-Length")) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, size);
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
