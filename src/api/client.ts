/** appdata API 客户端：Bearer 鉴权 + 401 自动刷新（单飞） */
import { loadSettings, normBase } from "../config";
import { loadTokens, refreshTokens, clearTokens, type Tokens } from "./oauth";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let refreshing: Promise<Tokens | null> | null = null;

export async function tryRefresh(): Promise<Tokens | null> {
  const t = loadTokens();
  if (!t?.refresh_token) return null;
  if (!refreshing) {
    refreshing = refreshTokens(loadSettings(), t.refresh_token).catch(() => {
      clearTokens();
      return null;
    });
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }
  return refreshing;
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
  retry = true,
): Promise<Response> {
  const base = normBase(loadSettings().serverBase);
  const t = loadTokens();
  const headers = new Headers(init?.headers);
  if (t?.access_token) headers.set("Authorization", `Bearer ${t.access_token}`);
  const resp = await fetch(`${base}${path}`, { ...init, headers });
  if (resp.status === 401 && retry && t?.refresh_token) {
    const nt = await tryRefresh();
    if (nt) return apiFetch(path, init, false);
  }
  return resp;
}

async function errorFrom(resp: Response, fallback: string): Promise<ApiError> {
  let msg = fallback;
  try {
    const text = await resp.text();
    if (text) {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        msg = String(
          j.error_description ?? j.error ?? j.message ?? text.slice(0, 200),
        );
      } catch {
        msg = text.slice(0, 200);
      }
    }
  } catch {
    /* ignore */
  }
  return new ApiError(resp.status, `${msg} (HTTP ${resp.status})`);
}

/** 下载 appdata 文件原始字节 */
export async function getAppdataBytes(
  path: string,
): Promise<{ bytes: ArrayBuffer; contentType: string; filename: string }> {
  const resp = await apiFetch(`/api/appdata/files/${encodeURI(path)}`);
  if (!resp.ok) throw await errorFrom(resp, "下载失败");
  const cd = resp.headers.get("Content-Disposition") ?? "";
  const m =
    /filename\*=UTF-8''([^;]+)/.exec(cd) ?? /filename="?([^";]+)"?/.exec(cd);
  const filename = m
    ? decodeURIComponent(m[1])
    : (path.split("/").pop() ?? "file");
  return {
    bytes: await resp.arrayBuffer(),
    contentType: resp.headers.get("Content-Type") ?? "application/octet-stream",
    filename,
  };
}

export interface DirEntry {
  name: string;
  size: number;
  is_dir: boolean;
  mod_time: string;
}

export interface DirListing {
  content: DirEntry[];
  total: number;
}

/** 列 appdata 目录（GET 目录路径返回 JSON 清单） */
export async function listAppdata(dir: string): Promise<DirListing> {
  const p = dir.replace(/^\/+|\/+$/g, "");
  const resp = await apiFetch(`/api/appdata/files/${encodeURI(p)}`);
  if (!resp.ok) throw await errorFrom(resp, "读取目录失败");
  const ct = resp.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) {
    throw new ApiError(resp.status, "目标不是目录");
  }
  const j = (await resp.json()) as { content?: DirEntry[]; total?: number };
  return { content: j.content ?? [], total: j.total ?? j.content?.length ?? 0 };
}

export async function getJson<T>(path: string): Promise<T> {
  const resp = await apiFetch(`/api/appdata/files/${encodeURI(path)}`);
  if (!resp.ok) throw await errorFrom(resp, "读取失败");
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(resp.status, "响应不是合法 JSON");
  }
}
