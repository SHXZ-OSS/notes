/**
 * 分层（矢量）PDF 导出 —— 与截图式导出的区别：
 *   1. 背景花纹（网格/横线/田字格/拼音格/点阵）用 PDF 矢量线条绘制，可无损缩放；
 *   2. 页面背景位图 / 板书衬底 / 插入照片 以原始 JPEG/PNG 字节作为独立图像对象嵌入（非整页截图）；
 *   3. 手写笔迹逐段写入为 PDF 矢量路径（保留逐点变宽、虚线、颜色），
 *      橡皮没有像素擦除对应物，按几何裁剪切开被擦的段。
 * 几何逻辑与 pageRender.ts / shapes.ts 的 Canvas 渲染一一对应。
 */
import type { jsPDF } from "jspdf";
import { isImageBytes } from "./jser";
import {
  matApply,
  matMul,
  imageSize,
  stripJpegExif,
  type Affine,
} from "./pageSvg";
import { bgTypeOf, type PageRec } from "./notes";
import {
  imgBasename,
  isDeletedShape,
  parseShapes,
  SHAPE_IMG,
  type ShapePt,
  type ShapeRec,
} from "./shapes";
import {
  applyErasers,
  parseStrokes,
  strokesBBox,
  type Stroke,
} from "./strokes";

export type PdfRawFetcher = (name: string) => Promise<Uint8Array | null>;
export type PdfProgress = (done: number, total: number, msg: string) => void;

type RGB = [number, number, number];

/** 半透明色预混到白底（背景花纹专用；笔迹为独立图层，无需混合） */
function blendOnWhite(a: number, [r, g, b]: RGB): RGB {
  return [
    Math.round(a * r + (1 - a) * 255),
    Math.round(a * g + (1 - a) * 255),
    Math.round(a * b + (1 - a) * 255),
  ];
}

function argbRgb(c: number): { rgb: RGB; alpha: number } {
  return {
    rgb: [(c >>> 16) & 255, (c >>> 8) & 255, c & 255],
    alpha: ((c >>> 24) & 255) / 255,
  };
}

function imageFormat(b: Uint8Array): "JPEG" | "PNG" | null {
  if (b.length > 1 && b[0] === 0xff && b[1] === 0xd8) return "JPEG";
  if (b.length > 1 && b[0] === 0x89 && b[1] === 0x50) return "PNG";
  return null;
}

async function bitmapSize(
  bytes: Uint8Array,
): Promise<{ w: number; h: number } | null> {
  // 字节解析（JPEG SOF/PNG IHDR，不含 EXIF 旋转）——设备 BitmapFactory 口径；
  // 浏览器解码器默认按 EXIF 摆正，尺寸不能取自它
  const direct = imageSize(bytes);
  if (direct) return direct;
  if (!isImageBytes(bytes)) return null;
  try {
    const bmp = await createImageBitmap(
      new Blob([bytes.slice().buffer as ArrayBuffer]),
      { imageOrientation: "none" },
    );
    const s = { w: bmp.width, h: bmp.height };
    bmp.close();
    return s;
  } catch {
    return null;
  }
}

/** Android Matrix 行主序 [sx,kx,tx, ky,sy,ty, …] 作用到点（与 canvas setTransform 一致） */
function isIdentity(m: number[]): boolean {
  if (m.length !== 9) return false;
  return (
    m[0] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 1 &&
    m[5] === 0
  );
}
/** 页面尺寸：cover 截图 → bg 位图 → 内容包围盒（与 renderPage 一致） */
async function pageSize(
  page: PageRec,
): Promise<{ width: number; height: number }> {
  const cover = await bitmapSize(page.cover ?? new Uint8Array());
  if (cover) return { width: cover.w, height: cover.h };
  const bg = await bitmapSize(page.bg ?? new Uint8Array());
  if (bg) return { width: bg.w, height: bg.h };
  const strokes = parseStrokes(page.drawpath);
  const shapes = parseShapes(page.drawShapes);
  const bbox = strokesBBox(strokes);
  let minX = 0,
    minY = 0,
    maxX = 1000,
    maxY = 1400;
  for (const s of shapes) {
    if (s.start) {
      minX = Math.min(minX, s.start.x);
      minY = Math.min(minY, s.start.y);
      maxX = Math.max(maxX, s.start.x);
      maxY = Math.max(maxY, s.start.y);
    }
    if (s.end) {
      minX = Math.min(minX, s.end.x);
      minY = Math.min(minY, s.end.y);
      maxX = Math.max(maxX, s.end.x);
      maxY = Math.max(maxY, s.end.y);
    }
  }
  if (bbox) {
    minX = Math.min(minX, bbox.minX);
    minY = Math.min(minY, bbox.minY);
    maxX = Math.max(maxX, bbox.maxX);
    maxY = Math.max(maxY, bbox.maxY);
  }
  let width = Math.ceil(maxX + 60);
  let height = Math.ceil(maxY + 60);
  // 无 cover/bg 的页面（墨水屏）画布尺寸不在数据里，但插入图片以画布中心
  // 对称放置（ShapeDrawingProxy.addImgShape）→ start+end 即画布宽高
  for (const s of shapes) {
    if (s.type === SHAPE_IMG && s.start && s.end) {
      width = Math.max(width, Math.ceil(s.start.x + s.end.x));
      height = Math.max(height, Math.ceil(s.start.y + s.end.y));
    }
  }
  return { width, height };
}

/** 背景花纹 → 矢量线条（几何取自 pageRender.drawPatternBg） */
function patternBg(doc: jsPDF, type: number, w: number, h: number): void {
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, w, h, "F");
  if (type === 100) return;
  const unit = Math.max(28, Math.round(Math.min(w, h) / 16));
  const lineC = blendOnWhite(0.35, [100, 140, 190]);
  const fillC = blendOnWhite(0.5, [100, 140, 190]);
  const diagC = blendOnWhite(0.6, [100, 140, 190]);
  doc.setLineWidth(1);

  switch (type) {
    case 0: {
      // 网格
      doc.setDrawColor(...lineC);
      for (let x = unit; x < w; x += unit) doc.line(x, 0, x, h);
      for (let y = unit; y < h; y += unit) doc.line(0, y, w, y);
      break;
    }
    case 1: {
      // 横线
      doc.setDrawColor(...lineC);
      for (let y = Math.round(unit * 1.5); y < h; y += unit)
        doc.line(0, y, w, y);
      break;
    }
    case 4: {
      // 正楷田字格：虚线网格 + 实色对角线
      doc.setDrawColor(...lineC);
      doc.setLineDashPattern([6, 5], 0);
      for (let x = unit; x < w; x += unit) doc.line(x, 0, x, h);
      for (let y = unit; y < h; y += unit) doc.line(0, y, w, y);
      doc.setLineDashPattern([], 0);
      doc.setDrawColor(...diagC);
      for (let x = 0; x < w; x += unit) {
        for (let y = 0; y < h; y += unit) {
          doc.line(x, y, x + unit, y + unit);
          doc.line(x + unit, y, x, y + unit);
        }
      }
      break;
    }
    case 5: {
      // 拼音四线格
      doc.setDrawColor(...lineC);
      const gh = unit * 1.2;
      for (let top = gh; top < h; top += gh * 2) {
        for (let i = 0; i < 4; i++) {
          const y = top + (gh / 3) * i;
          doc.line(0, y, w, y);
        }
      }
      break;
    }
    case 6: {
      // 点阵
      doc.setFillColor(...fillC);
      for (let x = unit; x < w; x += unit) {
        for (let y = unit; y < h; y += unit) doc.circle(x, y, 1.6, "F");
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 笔迹 → 矢量路径，与设备端 handwriting.canvas 渲染一致：
 *   铅笔为恒定 penWidth 的中点二次贝塞尔平滑曲线（<0.5px 去重），
 *   二次贝塞尔精确转换为三次贝塞尔，直接写入 PDF m/c 算子（与 SVG
 *   pencilPathD 逐点一致；jsPDF lines() 的增量语义与其文档不符，勿用）；
 *   橡皮已按几何裁剪切开被擦的段。
 */
function strokesLayer(
  doc: jsPDF,
  GStateCtor: new (o: { opacity: number }) => object,
  strokes: Stroke[],
): void {
  doc.setLineCap("round");
  doc.setLineJoin("round");
  const k = doc.internal.scaleFactor;
  const pageH = doc.internal.pageSize.getHeight();
  const write = (doc.internal as unknown as { write: (s: string) => void })
    .write;
  const fx = (v: number): string => String(Math.round(v * k * 1000) / 1000);
  const fy = (v: number): string =>
    String(Math.round((pageH - v) * k * 1000) / 1000);
  for (const s of applyErasers(strokes)) {
    const pts = s.points;
    if (pts.length < 2) continue;
    const { rgb, alpha } = argbRgb(s.color);
    doc.setGState(new GStateCtor({ opacity: alpha }));
    doc.setDrawColor(rgb[0], rgb[1], rgb[2]);

    if (s.penType === 7 || s.penType === 8) {
      // 直线 / 虚线：首尾点连线
      doc.setLineWidth(Math.max(0.6, s.penWidth));
      if (s.penType === 8) doc.setLineDashPattern([10, 20, 10, 20], 1);
      doc.line(
        pts[0].x,
        pts[0].y,
        pts[pts.length - 1].x,
        pts[pts.length - 1].y,
      );
      if (s.penType === 8) doc.setLineDashPattern([], 0);
      continue;
    }

    // 铅笔：二次贝塞尔(控制点=上一原始点, 终点=中点) → 三次贝塞尔精确转换
    doc.setLineWidth(s.penWidth);
    let sx = pts[0].x;
    let sy = pts[0].y; // 当前路径点（上一段曲线终点）
    let px = pts[0].x;
    let py = pts[0].y; // 上一原始点
    let segs = 0;
    for (let i = 1; i < pts.length; i++) {
      const cur = pts[i];
      const dup =
        i !== pts.length - 1 &&
        Math.abs(cur.x - px) < 0.5 &&
        Math.abs(cur.y - py) < 0.5;
      if (!dup) {
        const ex = (px + cur.x) / 2;
        const ey = (py + cur.y) / 2;
        const c1x = sx + ((px - sx) * 2) / 3;
        const c1y = sy + ((py - sy) * 2) / 3;
        const c2x = ex + ((px - ex) * 2) / 3;
        const c2y = ey + ((py - ey) * 2) / 3;
        if (segs === 0) write(`${fx(pts[0].x)} ${fy(pts[0].y)} m`);
        write(
          `${fx(c1x)} ${fy(c1y)} ${fx(c2x)} ${fy(c2y)} ${fx(ex)} ${fy(ey)} c`,
        );
        segs++;
        sx = ex;
        sy = ey;
      }
      px = cur.x;
      py = cur.y;
    }
    if (segs) write("S");
  }
  doc.setGState(new GStateCtor({ opacity: 1 }));
  doc.setLineCap("butt");
  doc.setLineJoin("miter");
}

/**
 * 图形层，几何与设备端 board.Shape.a() 一致；IMG 以原始图像按矩阵变换嵌入。
 * 非单位矩阵通过 PDF 原生 cm 算子应用（jsPDF 坐标系为 y 翻转 + k 缩放，已标定）。
 */
async function shapesLayer(
  doc: jsPDF,
  GStateCtor: new (o: { opacity: number }) => object,
  shapes: ShapeRec[],
  fetchRaw: PdfRawFetcher,
  cache: Map<
    string,
    Promise<{ bytes: Uint8Array; w: number; h: number } | null>
  >,
  pageHeightPx: number,
): Promise<void> {
  const k = doc.internal.scaleFactor;
  for (const s of shapes) {
    if (isDeletedShape(s)) continue; // 对象橡皮删除：设备不绘制
    try {
      const { rgb, alpha } = argbRgb(s.strokeColor);
      doc.setGState(new GStateCtor({ opacity: alpha }));
      doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
      doc.setLineWidth(Math.max(1, s.strokeWidth));

      if (s.type === SHAPE_IMG && s.imgPath) {
        const name = imgBasename(s.imgPath);
        if (!cache.has(name))
          cache.set(
            name,
            fetchRaw(name).then(async (bytes) => {
              if (bytes === null) return null;
              const size = await bitmapSize(bytes);
              if (size === null) return null;
              // 剥 EXIF：设备按原始像素绘制，PDF 观看器对 EXIF 行为不一
              return { bytes: stripJpegExif(bytes), w: size.w, h: size.h };
            }),
          );
        const img = await cache.get(name)!;
        if (img !== null && imageFormat(img.bytes)) {
          // 图片定位（与设备渲染实测一致）：位图平移到 start，经 p 变换，
          // 再绕 p·rect 左上角缩放 imgInitScale
          const m = affineOf(s.matrix);
          let f = matMul(m, [
            1,
            0,
            s.start ? s.start.x : 0,
            0,
            1,
            s.start ? s.start.y : 0,
          ]);
          const scale = s.imgInitScale > 0 ? s.imgInitScale : 1;
          const rect =
            s.start && s.end ? rectOf(s.start, s.end) : { x: 0, y: 0 };
          const c = matApply(m, rect.x, rect.y);
          f = matMul(
            [scale, 0, c.x * (1 - scale), 0, scale, c.y * (1 - scale)],
            f,
          );
          // 两级复合：jsPDF 图框把像素 (x,y) 放到 (k·x, k·(H−y))，本 cm 再映射
          // 到 f 的目标位置。逻辑矩阵 [[f0,−f1],[−f3,f4]]，但 PDF cm 操作数是
          // 列主序（x'=a·x+c·y+e, y'=b·x+d·y+f）→ [f0, −f3, −f1, f4, …]，
          // b/c 勿按行主序写，否则旋转图片会镜像转置
          const cm = [
            f[0],
            -f[3],
            -f[1],
            f[4],
            k * (f[1] * pageHeightPx + f[2]),
            k * (pageHeightPx * (1 - f[4]) - f[5]),
          ];
          const write = (
            doc.internal as unknown as { write: (s: string) => void }
          ).write;
          write("q");
          write(`${cm[0]} ${cm[1]} ${cm[2]} ${cm[3]} ${cm[4]} ${cm[5]} cm`);
          try {
            doc.addImage(
              img.bytes,
              imageFormat(img.bytes)!,
              0,
              0,
              img.w,
              img.h,
            );
          } finally {
            write("Q");
          }
        } else {
          placeholder(doc, s);
        }
        continue;
      }

      const segs = shapeStrokeSegs(s);
      if (segs === null) {
        placeholder(doc, s);
        continue;
      }
      // shapeStrokeSegs 已把点经 matrix 映射（与 SVG 的 transform 属性等价），
      // 不能再包一层 cm，否则矩阵形状被双重变换
      doc.setLineDashPattern(s.type === 4 ? [8, 8] : [], 0);
      for (const seg of segs) {
        for (let i = 1; i < seg.length; i++) {
          doc.line(seg[i - 1].x, seg[i - 1].y, seg[i].x, seg[i].y);
        }
      }
      doc.setLineDashPattern([], 0);
    } catch (e) {
      console.warn("图形写入 PDF 失败", e);
    }
  }
  doc.setGState(new GStateCtor({ opacity: 1 }));
}

/**
 * 各 type 形状的描边折线段（几何取自 board.Shape.a() 反编译结果）。
 * 返回 null = 未知类型或图片。
 */
function shapeStrokeSegs(s: ShapeRec): ShapePt[][] | null {
  if (s.type === SHAPE_IMG) return null;
  const k = s.start;
  const l = s.end;
  if (!k || !l) return s.dots.length > 1 ? [s.dots] : null;
  const dx = Math.abs(k.x - l.x);
  const dy = Math.abs(k.y - l.y);
  const minX = Math.min(k.x, l.x);
  const minY = Math.min(k.y, l.y);
  const midX = (k.x + l.x) / 2;
  const midY = (k.y + l.y) / 2;
  let segs: ShapePt[][];
  switch (s.type) {
    case 1:
      segs = [[k, ...s.dots]];
      break;
    case 3: {
      const q = dx / 4;
      segs = [[k, { x: l.x - q, y: k.y }, l, { x: k.x - q, y: l.y }, k]];
      break;
    }
    case 4:
    case 5: {
      segs = [[k, l]];
      if (s.type === 5) {
        const rad30 = Math.PI / 6;
        const theta = Math.atan2(l.y - k.y, l.x - k.x);
        const len = Math.abs(20 / Math.cos(rad30));
        const flip = l.x < k.x ? -1 : 1;
        const a1 = flip >= 0 ? Math.PI + theta - rad30 : theta - rad30;
        const a2 = flip >= 0 ? Math.PI + theta + rad30 : theta + rad30;
        segs.push([
          { x: l.x + len * Math.cos(a1), y: l.y + len * Math.sin(a1) },
          l,
        ]);
        segs.push([
          { x: l.x + len * Math.cos(a2), y: l.y + len * Math.sin(a2) },
          l,
        ]);
      }
      break;
    }
    case 6: {
      segs = [s.dots.length >= 1 ? [k, s.dots[0], l] : [k, l]];
      break;
    }
    case 7:
    case 102: {
      segs = [
        [
          { x: minX, y: minY },
          { x: minX + dx, y: minY },
          { x: minX + dx, y: minY + dy },
          { x: minX, y: minY + dy },
          { x: minX, y: minY },
        ],
      ];
      break;
    }
    case 8: {
      const side = Math.min(dx, dy);
      segs = [
        [
          { x: minX, y: minY },
          { x: minX + side, y: minY },
          { x: minX + side, y: minY + side },
          { x: minX, y: minY + side },
          { x: minX, y: minY },
        ],
      ];
      break;
    }
    case 9: {
      segs = [
        [
          { x: midX, y: minY },
          { x: minX + dx, y: midY },
          { x: midX, y: minY + dy },
          { x: minX, y: midY },
          { x: midX, y: minY },
        ],
      ];
      break;
    }
    case 10: {
      const q = dx / 3;
      segs =
        k.x < l.x
          ? [[k, { x: l.x - q, y: k.y }, l, { x: k.x + q, y: l.y }, k]]
          : [[k, { x: l.x + q, y: k.y }, l, { x: k.x - q, y: l.y }, k]];
      break;
    }
    case 16: {
      // 圆：圆心 = k，半径 = |k − l|，用 32 段折线逼近
      const r = Math.hypot(k.x - l.x, k.y - l.y);
      const pts: ShapePt[] = [];
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * 2 * Math.PI;
        pts.push({ x: k.x + r * Math.cos(a), y: k.y + r * Math.sin(a) });
      }
      segs = [pts];
      break;
    }
    case 17: {
      // 椭圆：k/l 外接矩形，64 段逼近
      const r = rectOf(k, l);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const pts: ShapePt[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * 2 * Math.PI;
        pts.push({
          x: cx + (r.w / 2) * Math.cos(a),
          y: cy + (r.h / 2) * Math.sin(a),
        });
      }
      segs = [pts];
      break;
    }
    case 2: {
      const sides = s.sides > 2 ? s.sides : 3;
      const radius = Math.min(dx, dy) / 2;
      const cx = midX;
      const cy = Math.min(k.y, l.y) + radius;
      const pts: ShapePt[] = [];
      for (let i = 0; i <= sides; i++) {
        const a = (i % sides) * ((2 * Math.PI) / sides) + Math.PI / 2;
        pts.push({
          x: cx + radius * Math.cos(a),
          y: cy - radius * Math.sin(a),
        });
      }
      segs = [pts];
      break;
    }
    default:
      return null;
  }
  const hasMatrix = s.matrix.length === 9 && !isIdentity(s.matrix);
  return hasMatrix
    ? segs.map((seg) => seg.map((p) => matApply(affineOf(s.matrix), p.x, p.y)))
    : segs;
}

function affineOf(m: number[]): Affine {
  return m.length === 9
    ? [m[0], m[1], m[2], m[3], m[4], m[5]]
    : [1, 0, 0, 0, 1, 0];
}

function rectOf(
  a: ShapePt,
  b: ShapePt,
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function placeholder(doc: jsPDF, s: ShapeRec): void {
  if (!(s.start && s.end)) return;
  const r = rectOf(s.start, s.end);
  doc.setLineDashPattern([6, 4], 0);
  doc.rect(r.x, r.y, r.w, r.h, "S");
  doc.setLineDashPattern([], 0);
}

/**
 * 导出整本笔记为分层 PDF。
 * @param fetchRaw 原始图像字节加载器（images/{name}）
 * @param meta 文档属性（title / author，author 传学生姓名）
 */
export async function exportPagesToPdf(
  pages: PageRec[],
  fetchRaw: PdfRawFetcher,
  onProgress?: PdfProgress,
  meta?: { title?: string; author?: string },
): Promise<Blob> {
  const { jsPDF: JsPDF, GState } = await import("jspdf");
  const GStateCtor = GState as unknown as new (o: {
    opacity: number;
  }) => object;
  const cache = new Map<
    string,
    Promise<{ bytes: Uint8Array; w: number; h: number } | null>
  >();
  let doc: jsPDF | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    onProgress?.(i, pages.length, `写入第 ${i + 1}/${pages.length} 页…`);
    try {
      const { width, height } = await pageSize(page);
      const orient = width > height ? "landscape" : "portrait";
      if (!doc) {
        doc = new JsPDF({
          unit: "px",
          format: [width, height],
          compress: true,
          orientation: orient,
        });
        doc.setProperties({
          title: meta?.title,
          author: meta?.author,
          creator: "行知·慧云_笔记",
        });
      } else {
        doc.addPage([width, height], orient);
      }

      // 1) 背景层：位图原图 或 矢量花纹
      const bg = page.bg;
      if (bg && isImageBytes(bg)) {
        const fmt = imageFormat(bg);
        doc.setFillColor(255, 255, 255);
        doc.rect(0, 0, width, height, "F");
        if (fmt) doc.addImage(bg, fmt, 0, 0, width, height);
      } else {
        const t = bgTypeOf(page);
        patternBg(doc, typeof t === "number" ? t : 100, width, height);
      }

      // 2) 板书衬底位图
      if (page.board && isImageBytes(page.board)) {
        const fmt = imageFormat(page.board);
        if (fmt) doc.addImage(page.board, fmt, 0, 0, width, height);
      }

      // 3) 矢量图形层（含插入照片原图）
      await shapesLayer(
        doc,
        GStateCtor,
        parseShapes(page.drawShapes),
        fetchRaw,
        cache,
        height,
      );

      // 4) 手写笔迹矢量层（最上层；橡皮已按几何裁剪）
      strokesLayer(doc, GStateCtor, parseStrokes(page.drawpath));
    } catch (e) {
      console.error("页面导出失败", page.pageid, e);
      if (doc) {
        doc.setFillColor(255, 255, 255);
        doc.rect(
          0,
          0,
          doc.internal.pageSize.getWidth(),
          doc.internal.pageSize.getHeight(),
          "F",
        );
      }
    }
  }
  onProgress?.(pages.length, pages.length, "生成文件…");
  return doc ? doc.output("blob") : new Blob([], { type: "application/pdf" });
}
