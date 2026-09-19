/**
 * 笔记数据模型与全局索引。
 *
 * epadnote 同步到 appdata 的结构：
 *   manifest.json                          全量清单 {version, items[{path,updatetime}], deleted[]}
 *   notes/{noteid}.obj   NoteInfo          笔记元数据 + JPEG 封面
 *   pages/{pageid}.obj   PageInfo          页面（bg/board/cover 位图 + drawpath 笔迹 + drawShapes 图形）
 *   books/{bookid}.obj   BookNoteBean      笔记本
 *   tags/…                                   标签
 *   images/{name}                          页内图片（原始 JPEG/PNG）
 */
import {
  asArray,
  asBytes,
  asNum,
  asStr,
  bytesToInt,
  isImageBytes,
  parseJavaSerialized,
  type JserObject,
} from "./jser";
import { getAppdataBytes, getJson } from "../api/client";

export interface ManifestItem {
  path: string;
  updatetime: string;
}

export interface Manifest {
  version: number;
  items: ManifestItem[];
  deleted: string[];
}

export interface BookRec {
  bookid: number;
  name: string;
  gradename: string | null;
  subjectname: string | null;
  volume: string | null;
  notenum: number | null;
  cover: Uint8Array | null;
  createtime: string | null;
  updatetime: string | null;
}

export interface NoteRec {
  noteid: number;
  name: string;
  bookid: number;
  subject: string | null;
  chapter: string | null;
  pagenum: number | null;
  cover: Uint8Array | null;
  createtime: string | null;
  updatetime: string | null;
}

export interface PageRec {
  pageid: number;
  noteid: number;
  site: number;
  name: string | null;
  cover: Uint8Array | null;
  bg: Uint8Array | null;
  board: Uint8Array | null;
  drawpath: Uint8Array | null;
  drawShapes: Uint8Array | null;
  createtime: string | null;
  updatetime: string | null;
}

export interface TagRec {
  tagname: string;
  noteids: number[];
  pageids: number[];
  bookids: number[];
  createtime: string | null;
  updatetime: string | null;
}

function toBook(o: JserObject): BookRec {
  return {
    bookid: asNum(o.bookid) ?? 0,
    name: asStr(o.name) ?? "(未命名笔记本)",
    gradename: asStr(o.gradename),
    subjectname: asStr(o.subjectname),
    volume: asStr(o.volume),
    notenum: asNum(o.notenum),
    cover: asBytes(o.cover),
    createtime: asStr(o.createtime),
    updatetime: asStr(o.updatetime),
  };
}

function toNote(o: JserObject): NoteRec {
  return {
    noteid: asNum(o.noteid) ?? 0,
    name: asStr(o.name) ?? "(未命名笔记)",
    bookid: asNum(o.bookid) ?? 0,
    subject: asStr(o.subject),
    chapter: asStr(o.chapter),
    pagenum: asNum(o.pagenum),
    cover: asBytes(o.cover),
    createtime: asStr(o.createtime),
    updatetime: asStr(o.updatetime),
  };
}

function toPage(o: JserObject): PageRec {
  return {
    pageid: asNum(o.pageid) ?? 0,
    noteid: asNum(o.noteid) ?? 0,
    site: asNum(o.site) ?? 0,
    name: asStr(o.name),
    cover: asBytes(o.cover),
    bg: asBytes(o.bg),
    board: asBytes(o.board),
    drawpath: asBytes(o.drawpath),
    drawShapes: asBytes(o.drawShapes),
    createtime: asStr(o.createtime),
    updatetime: asStr(o.updatetime),
  };
}

function toTag(o: JserObject): TagRec {
  const ids = (v: unknown): number[] =>
    asArray(v)
      .map((x) => asNum(x))
      .filter((x): x is number => x != null);
  const splitIds = (s: string | null): number[] =>
    s
      ? s
          .split(",")
          .map((x) => parseInt(x, 10))
          .filter((x) => Number.isFinite(x))
      : [];
  let noteids = ids(o.noteids);
  if (!noteids.length) noteids = splitIds(asStr(o.noteids));
  let pageids = ids(o.pageids);
  if (!pageids.length) pageids = splitIds(asStr(o.pageids));
  let bookids = ids(o.bookids);
  if (!bookids.length) bookids = splitIds(asStr(o.bookids));
  return {
    tagname: asStr(o.tagname) ?? "(未命名标签)",
    noteids,
    pageids,
    bookids,
    createtime: asStr(o.createtime),
    updatetime: asStr(o.updatetime),
  };
}

export type AnyRec =
  | { kind: "book"; rec: BookRec }
  | { kind: "note"; rec: NoteRec }
  | { kind: "page"; rec: PageRec }
  | { kind: "tag"; rec: TagRec };

export function parseRecord(path: string, bytes: ArrayBuffer): AnyRec | null {
  const obj = parseJavaSerialized(bytes) as JserObject;
  const cls = String(obj?.__class ?? "");
  if (cls.endsWith("BookNoteBean")) return { kind: "book", rec: toBook(obj) };
  if (cls.endsWith("NoteInfo")) return { kind: "note", rec: toNote(obj) };
  if (cls.endsWith("PageInfo")) return { kind: "page", rec: toPage(obj) };
  if (cls.endsWith("TagInfo")) return { kind: "tag", rec: toTag(obj) };
  console.warn("未知记录类型", path, cls);
  return null;
}

// ---------- 全局索引 Store ----------

export type IndexStatus = "idle" | "loading" | "ready" | "error";

export interface IndexSnapshot {
  status: IndexStatus;
  error: string | null;
  counts: { books: number; notes: number; pages: number; tags: number };
  found: { books: number; notes: number; pages: number; tags: number };
  version: number;
}

class NotesStore {
  books = new Map<number, BookRec>();
  notes = new Map<number, NoteRec>();
  pages = new Map<number, PageRec>();
  tags = new Map<string, TagRec>();
  /** 页面是否已从服务端加载（含内容字节） */
  loadedPages = new Set<number>();
  status: IndexStatus = "idle";
  error: string | null = null;
  found = { books: 0, notes: 0, pages: 0, tags: 0 };

  private version = 0;
  private listeners = new Set<(v: IndexSnapshot) => void>();
  private loadSeq = 0;

  /** Svelte store 契约：subscribe 后须同步回调当前值 */
  subscribe = (l: (v: IndexSnapshot) => void): (() => void) => {
    this.listeners.add(l);
    l(this.getSnapshot());
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): IndexSnapshot => ({
    status: this.status,
    error: this.error,
    counts: {
      books: this.books.size,
      notes: this.notes.size,
      pages: this.pages.size,
      tags: this.tags.size,
    },
    found: { ...this.found },
    version: this.version,
  });

  private notify(): void {
    this.version++;
    const snap = this.getSnapshot();
    this.listeners.forEach((l) => l(snap));
  }

  reset(): void {
    this.loadSeq++;
    this.books.clear();
    this.notes.clear();
    this.pages.clear();
    this.tags.clear();
    this.loadedPages.clear();
    this.found = { books: 0, notes: 0, pages: 0, tags: 0 };
    this.status = "idle";
    this.error = null;
    this.notify();
  }

  /** 拉取 manifest 并全量索引（notes/books/tags 先行，pages 并发补齐） */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.status = "loading";
    this.error = null;
    this.notify();
    try {
      const manifest = await getJson<Manifest>("manifest.json");
      if (seq !== this.loadSeq) return;

      const groups: Array<["books" | "notes" | "pages" | "tags", string]> = [
        ["books", "books/"],
        ["notes", "notes/"],
        ["pages", "pages/"],
        ["tags", "tags/"],
      ];
      for (const [key, prefix] of groups) {
        this.found[key] = manifest.items.filter((i) =>
          i.path.startsWith(prefix),
        ).length;
      }
      this.notify();

      // 索引只下载记录类文件。manifest 里还列着 images/ 等资源，
      // 那些要等真正打开页面或导出时才按需取，不能在这里全量拉下来
      const records = manifest.items.filter((i) =>
        groups.some(([, prefix]) => i.path.startsWith(prefix)),
      );

      // 先加载元数据（小），再并发加载页面（大）
      const meta = records.filter((i) => !i.path.startsWith("pages/"));
      await this.pool(meta, 4, async (item) => {
        if (seq !== this.loadSeq) return;
        await this.loadItem(item.path);
      });
      if (seq !== this.loadSeq) return;
      this.notify();

      const pages = records.filter((i) => i.path.startsWith("pages/"));
      await this.pool(pages, 3, async (item) => {
        if (seq !== this.loadSeq) return;
        await this.loadItem(item.path);
      });
      if (seq !== this.loadSeq) return;

      this.status = "ready";
      this.notify();
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.status = "error";
      this.error = e instanceof Error ? e.message : String(e);
      this.notify();
    }
  }

  /** 单条记录下载 + 解析（索引与按需加载共用） */
  async loadItem(path: string): Promise<void> {
    try {
      const { bytes } = await getAppdataBytes(path);
      const parsed = parseRecord(path, bytes);
      if (parsed == null) return;
      switch (parsed.kind) {
        case "note":
          this.notes.set(parsed.rec.noteid, parsed.rec);
          break;
        case "page":
          this.pages.set(parsed.rec.pageid, parsed.rec);
          this.loadedPages.add(parsed.rec.pageid);
          break;
        case "book":
          this.books.set(parsed.rec.bookid, parsed.rec);
          break;
        case "tag":
          this.tags.set(parsed.rec.tagname, parsed.rec);
          break;
      }
    } catch (e) {
      // 单条失败不中断整体索引（如已删除/并发 404）
      console.warn("加载失败", path, e);
    }
  }

  private async pool<T>(
    items: T[],
    n: number,
    fn: (t: T) => Promise<void>,
  ): Promise<void> {
    let i = 0;
    const workers = Array.from(
      { length: Math.min(n, items.length) },
      async () => {
        while (i < items.length) {
          const idx = i++;
          await fn(items[idx]);
          this.notify();
        }
      },
    );
    await Promise.all(workers);
  }

  /** 某笔记的页面（按 site 排序） */
  pagesOf(noteid: number): PageRec[] {
    return [...this.pages.values()]
      .filter((p) => p.noteid === noteid)
      .sort((a, b) => a.site - b.site || a.pageid - b.pageid);
  }

  notesOfBook(bookid: number): NoteRec[] {
    return [...this.notes.values()].filter((n) => n.bookid === bookid);
  }

  bookOf(noteid: number): BookRec | null {
    const n = this.notes.get(noteid);
    return n ? (this.books.get(n.bookid) ?? null) : null;
  }
}

export const notesStore = new NotesStore();

/** 背景类型 int 语义（FastDrawActivity） */
export const BG_TYPES: Record<number, string> = {
  0: "网格",
  1: "横线",
  3: "图片",
  4: "正楷田字格",
  5: "拼音格",
  6: "点阵",
  100: "白纸",
};

export function bgTypeOf(page: PageRec): number | "image" | null {
  const bg = page.bg;
  if (!bg) return null;
  if (isImageBytes(bg)) return "image";
  return bytesToInt(bg);
}
