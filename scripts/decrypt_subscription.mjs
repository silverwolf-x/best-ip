import crypto from "node:crypto";
import fs from "node:fs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error("argument");
  return process.argv[index + 1];
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("encoding");
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4), "base64");
}

function fail() {
  process.stderr.write("订阅密文校验失败\n");
  process.exitCode = 1;
}

try {
  const privateKeyPath = argument("--private-key");
  const outputPath = argument("--output");
  const expectedRequestId = argument("--request-id");
  const expectedKeyId = argument("--key-id");
  const rawEnvelope = process.env.BEST_IP_ENVELOPE;
  if (!rawEnvelope || rawEnvelope.length > 65_535) throw new Error("input");
  const envelope = JSON.parse(rawEnvelope);
  const now = Math.floor(Date.now() / 1000);
  if (
    envelope?.v !== 1 ||
    envelope?.kid !== expectedKeyId ||
    envelope?.request_id !== expectedRequestId ||
    envelope?.alg !== "RSA-OAEP-3072-SHA256+AES-256-GCM" ||
    !Number.isInteger(envelope?.issued_at) ||
    !Number.isInteger(envelope?.expires_at) ||
    envelope.expires_at <= envelope.issued_at ||
    envelope.issued_at > now + 60 ||
    envelope.expires_at < now ||
    envelope.expires_at > now + 900 ||
    envelope.expires_at - envelope.issued_at > 900
  ) throw new Error("envelope");

  const wrappedKey = decodeBase64Url(envelope.ek);
  const iv = decodeBase64Url(envelope.iv);
  const aad = decodeBase64Url(envelope.aad);
  const ciphertext = decodeBase64Url(envelope.ct);
  const expectedAad = Buffer.from(
    `${expectedRequestId}:${expectedKeyId}:${envelope.expires_at}`,
    "utf8",
  );
  if (
    wrappedKey.length < 128 ||
    iv.length !== 12 ||
    aad.length > 512 ||
    !aad.equals(expectedAad) ||
    ciphertext.length < 17
  ) throw new Error("size");
  const aesKey = crypto.privateDecrypt(
    {
      key: fs.readFileSync(privateKeyPath, "utf8"),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    wrappedKey,
  );
  if (aesKey.length !== 32) throw new Error("key");
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, -16)),
    decipher.final(),
  ]).toString("utf8");
  const url = new URL(plaintext);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || plaintext.length > 4096 || /[\r\n]/.test(plaintext)) {
    throw new Error("url");
  }
  fs.writeFileSync(outputPath, `${plaintext}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
} catch {
  fail();
}
