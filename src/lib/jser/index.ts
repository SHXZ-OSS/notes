/** JSER 解析结果的常用取值/转换辅助 */
import { parseJavaSerialized, type JserObject, type JserValue } from "./reader";

export type { JserObject, JserValue };
export { parseJavaSerialized };

/** ArrayList 等 {size,__extra} 对象 / 数组 → JS 数组 */
export function asArray(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") {
    const o = v as JserObject;
    if (Array.isArray(o.__extra)) return o.__extra as unknown[];
  }
  return [];
}

export function asNum(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export function asStr(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return String(v);
  return null;
}

export function asBytes(v: unknown): Uint8Array | null {
  return v instanceof Uint8Array ? v : null;
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function isPng(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  );
}

export function isImageBytes(b: Uint8Array): boolean {
  return isJpeg(b) || isPng(b);
}

/** 大端 int32（OCB.intToByteArray 编码，用于 bg 背景类型） */
export function bytesToInt(b: Uint8Array): number | null {
  if (b.length !== 4) return null;
  return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3] | 0;
}
