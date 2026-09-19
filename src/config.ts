/** 应用配置：OAuth 客户端与存储键 */

export interface Settings {
  serverBase: string;
  clientId: string;
  scope: string;
}

export const DEFAULT_SETTINGS: Settings = {
  serverBase: "https://www.shxzhy.cn",
  clientId: "epadnote",
  scope: "openid profile",
};

const LS_SETTINGS = "epadnote-web.settings";
export const LS_TOKENS = "epadnote-web.tokens";
export const SS_OAUTH = "epadnote-web.oauth";
export const SS_FROM = "epadnote-web.from";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

export function normBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

/** OAuth 回调地址：{origin}{BASE_URL}callback，需在 xzzx-sis 管理端注册 */
export function currentRedirectUri(): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${window.location.origin}${base}callback`;
}
