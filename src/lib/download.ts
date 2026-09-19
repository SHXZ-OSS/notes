/** 文件下载与文本工具 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadBytes(
  bytes: ArrayBuffer | Uint8Array,
  filename: string,
  type = "application/octet-stream",
): void {
  const b =
    bytes instanceof Uint8Array ? (bytes.slice().buffer as ArrayBuffer) : bytes;
  downloadBlob(new Blob([b], { type }), filename);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
