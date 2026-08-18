export const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;

export async function readTelegramJson(
  response: Response,
  maxBytes = MAX_TELEGRAM_RESPONSE_BYTES
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error("Telegram response too large");
    }
  }

  if (response.body === null) throw new Error("Telegram response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Telegram response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}
