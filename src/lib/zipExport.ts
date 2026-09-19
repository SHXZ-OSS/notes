/**
 * 笔记本批量导出：把一本笔记本里的每篇笔记各导出一个分层 PDF，
 * 再用 JSZip 打成一个 zip（文件名形如 笔记-学生姓名-20260916.zip）。
 * PDF 生成逻辑与单篇导出一致（pdfExport.exportPagesToPdf）。
 */
import JSZip from "jszip";
import { exportPagesToPdf, type PdfRawFetcher } from "./pdfExport";
import type { NoteRec, PageRec } from "./notes";

/** 文件名安全化：去掉 Windows/Unix 非法字符与首尾空白 */
export function safeFileName(s: string, fallback = "未命名"): string {
  const t = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return t.length ? t.replace(/\.+$/, "") || fallback : fallback;
}

/** YYYYMMDD（本地时区） */
export function ymd(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export interface ZipExportResult {
  blob: Blob;
  /** 成功写入的笔记篇数 */
  notes: number;
  /** 没有页面的笔记名（跳过） */
  skipped: string[];
}

/**
 * 导出多条笔记为一个 zip。
 * @param notes 要导出的笔记（调用方按显示顺序传入）
 * @param pagesOf 取某篇笔记的页面（按页码排序）
 * @param fetchRaw 原始图片字节加载器（images/{name}）
 * @param onProgress 进度文案回调
 * @param meta.author PDF 文档属性作者（学生姓名）
 */
export async function exportNotesToZip(
  notes: NoteRec[],
  pagesOf: (noteid: number) => PageRec[],
  fetchRaw: PdfRawFetcher,
  onProgress?: (msg: string) => void,
  meta?: { author?: string },
): Promise<ZipExportResult> {
  const zip = new JSZip();
  const used = new Set<string>();
  const skipped: string[] = [];
  let done = 0;

  for (const [i, note] of notes.entries()) {
    const pages = pagesOf(note.noteid);
    if (pages.length === 0) {
      skipped.push(note.name);
      continue;
    }
    onProgress?.(
      `导出中 ${i + 1}/${notes.length}：${note.name}（${pages.length} 页）`,
    );
    const blob = await exportPagesToPdf(pages, fetchRaw, undefined, {
      title: note.name,
      author: meta?.author,
    });
    if (blob.size === 0) {
      skipped.push(note.name);
      continue;
    }
    // 同名笔记加序号，避免覆盖
    let name = safeFileName(note.name || `笔记${note.noteid}`);
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}(${n})`)) n++;
      name = `${name}(${n})`;
    }
    used.add(name);
    zip.file(`${name}.pdf`, await blob.arrayBuffer());
    done++;
  }

  onProgress?.("正在打包 zip…");
  const out = await zip.generateAsync({
    type: "blob",
    // PDF 内部已是 Flate 压缩，再压收益极低、耗时明显
    compression: "STORE",
  });
  return { blob: out, notes: done, skipped };
}
