const SIGNATURE_VERSION = "v0";
const MAX_REQUEST_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

interface VerifySlackRequestOptions {
  body: string;
  signature: string | null;
  timestamp: string | null;
  signingSecret: string;
  now?: number;
}

export async function verifySlackRequest({
  body,
  signature,
  timestamp,
  signingSecret,
  now = Date.now(),
}: VerifySlackRequestOptions): Promise<boolean> {
  if (!signature?.startsWith(`${SIGNATURE_VERSION}=`) || !timestamp || !signingSecret) {
    return false;
  }

  const requestTimestamp = Number(timestamp);
  if (!Number.isInteger(requestTimestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(nowSeconds - requestTimestamp) > MAX_REQUEST_AGE_SECONDS) {
    return false;
  }

  const signatureBytes = hexToBytes(signature.slice(`${SIGNATURE_VERSION}=`.length));
  if (!signatureBytes) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const baseString = `${SIGNATURE_VERSION}:${timestamp}:${body}`;

  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(baseString));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}
