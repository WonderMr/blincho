export interface SyncEnvelope {
  v: 1;
  iv: string;
  ciphertext: string;
}

export const MAX_SYNC_PAYLOAD_BYTES = 512 * 1024;
const encodeText = (value: string) => new TextEncoder().encode(value);
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error('Secure synchronization is unavailable.');
  return globalThis.crypto;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Avoid spreading a payload-sized array onto the JavaScript call stack.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !BASE64URL.test(value)) {
    throw new Error('Invalid encrypted synchronization data.');
  }
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new Error('Invalid encrypted synchronization data.');
  }
  if (binary.length < minimum || binary.length > maximum) throw new Error('Invalid encrypted synchronization data.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error('Invalid encrypted synchronization data.');
  return bytes;
}

function accountContext(accountId: string): string {
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) {
    throw new Error('Invalid synchronization account.');
  }
  return `blincho-sync:v1:${accountId}`;
}

function authenticatedContext(accountId: string, kind: string): Uint8Array<ArrayBuffer> {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) throw new Error('Invalid synchronization kind.');
  return encodeText(`${accountContext(accountId)}:${kind}`);
}

export function generateRecoveryKey(): string {
  return encodeBase64Url(webCrypto().getRandomValues(new Uint8Array(32)));
}

export async function deriveSyncKey(secret: string, accountId: string): Promise<CryptoKey> {
  const context = accountContext(accountId);
  const material = decodeBase64Url(secret, 32, 32);
  const crypto = webCrypto();
  try {
    const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: encodeText(context), info: encodeText('blincho-sync:v1:encryption'),
    }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    material.fill(0);
  }
}

export async function encryptSync(key: CryptoKey, accountId: string, kind: string, payload: unknown): Promise<SyncEnvelope> {
  const additionalData = authenticatedContext(accountId, kind);
  const json = JSON.stringify(payload);
  if (typeof json !== 'string') throw new Error('Invalid synchronization payload.');
  const plaintext = encodeText(json);
  if (plaintext.byteLength > MAX_SYNC_PAYLOAD_BYTES) throw new Error('Synchronization payload is too large.');
  const crypto = webCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, plaintext);
  return { v: 1, iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) };
}

export async function decryptSync(key: CryptoKey, accountId: string, kind: string, envelope: unknown): Promise<unknown> {
  const additionalData = authenticatedContext(accountId, kind);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      !('v' in envelope) || !('iv' in envelope) || !('ciphertext' in envelope) || envelope.v !== 1 ||
      Object.keys(envelope).length !== 3 ||
      !Object.hasOwn(envelope, 'v') || !Object.hasOwn(envelope, 'iv') || !Object.hasOwn(envelope, 'ciphertext')) {
    throw new Error('Invalid encrypted synchronization data.');
  }
  const iv = decodeBase64Url(envelope.iv, 12, 12);
  const ciphertext = decodeBase64Url(envelope.ciphertext, 16, MAX_SYNC_PAYLOAD_BYTES + 16);
  const plaintext = await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, ciphertext);
  if (plaintext.byteLength > MAX_SYNC_PAYLOAD_BYTES) throw new Error('Synchronization payload is too large.');
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  return parsed;
}
