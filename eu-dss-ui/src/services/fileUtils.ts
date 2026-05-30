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

export function downloadBase64(base64: string, filename: string, mediaType = 'application/octet-stream'): void {
  triggerDownload(new Blob([base64ToBytes(base64)], { type: mediaType }), filename);
}

export function downloadZip(entries: { name: string; base64: string }[], zipName: string): void {
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) files[e.name] = base64ToBytes(e.base64);
  triggerDownload(new Blob([zipSync(files)], { type: 'application/zip' }), zipName);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
