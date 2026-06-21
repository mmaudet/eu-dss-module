import { zipSync } from 'fflate';

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return arrayBufferToBase64(buf);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build a Blob from base64 and trigger a browser download.
 * Throws on empty/invalid base64 or any failure during blob creation / click,
 * so callers can catch and surface an error to the user.
 */
export function downloadBase64(base64: string, filename: string, mediaType = 'application/octet-stream'): void {
  if (!base64) throw new Error(`Aucune donnée à télécharger pour "${filename}".`);
  triggerDownload(new Blob([base64ToBytes(base64)], { type: mediaType }), filename);
}

/**
 * Zip the given entries and trigger a browser download.
 * Throws if there is nothing to zip, an entry is empty/invalid, or the download fails.
 */
export function downloadZip(entries: { name: string; base64: string }[], zipName: string): void {
  if (entries.length === 0) throw new Error('Aucun document à archiver.');
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) {
    if (!e.base64) throw new Error(`Document vide dans l'archive : "${e.name}".`);
    files[e.name] = base64ToBytes(e.base64);
  }
  triggerDownload(new Blob([zipSync(files)], { type: 'application/zip' }), zipName);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
