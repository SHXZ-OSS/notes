/**
 * 页面 → 矢量 SVG（与设备端 handwriting.canvas / board.Shape 渲染一致），任意缩放不失真。
 * 图层顺序：背景（位图/花纹）→ 照片/图形 → 笔迹（最上层）。
 * 橡皮用 SVG mask 实现：只抠掉笔迹图层中被擦的部分，不影响照片与背景。
 */
import { isImageBytes } from "./jser";
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
  type Pt,
  type Stroke,
} from "./strokes";

export type SvgImageFetcher = (
  name: string,
) => Promise<{ href: string; w: number; h: number } | null>;

export interface BuiltPageSvg {
  width: number;
  height: number;
  svg: string;
}

function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * 变换矩阵专用格式化：矩阵元素量级通常只有 0.1~2，2 位小数的舍入会把
 * 旋转角改掉（如 46.6° → 45°，照片角点偏 26px），必须用高精度。
 */
function nm(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}

function rgba(c: number): { color: string; opacity: number } {
  return {
    color: `#${((c >>> 16) & 255).toString(16).padStart(2, "0")}${(
      (c >>> 8) &
      255
    )
      .toString(16)
      .padStart(2, "0")}${(c & 255).toString(16).padStart(2, "0")}`,
    opacity: ((c >>> 24) & 255) / 255,
  };
}

/**
 * 从图片文件头解析像素尺寸（JPEG SOF / PNG IHDR）。
 * 设备端用 BitmapFactory.inJustDecodeBounds 读的就是这个值——**不含 EXIF 旋转**；
 * 浏览器 createImageBitmap 默认按 EXIF 摆正（竖版），部分内核即使传
 * imageOrientation:"none" 也不生效，会让照片整体转 90°。故尺寸不走解码器。
 */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (b.length > 8 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m === 0xda || m === 0xd9) break; // SOS/EOI 之后没有尺寸段
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) break;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return w > 0 && h > 0 ? { w, h } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

async function bitmapSize(
  bytes: Uint8Array,
): Promise<{ w: number; h: number } | null> {
  // 优先字节解析（与设备口径一致）；非 JPEG/PNG 才退回解码器
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

export function bytesDataUrl(bytes: Uint8Array): string {
  const b = stripJpegExif(bytes);
  const chunks: string[] = [];
  for (let i = 0; i < b.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...b.subarray(i, i + 0x8000)));
  }
  const mime = b[0] === 0x89 ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${btoa(chunks.join(""))}`;
}

/**
 * 剥掉 JPEG 的 EXIF APP1 段（纯字节手术，不重编码）。设备端 BitmapFactory
 * 不应用 EXIF、按原始像素绘制；浏览器对 <img> 自动摆正、对 SVG <image> 又
 * 不摆正（Chromium 怪癖）——剥掉后所有解码器行为统一为原始朝向。
 */
export function stripJpegExif(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  let changed = false;
  let done = false;
  while (i < b.length - 1) {
    if (b[i] !== 0xff) break; // 段结构破坏，放弃处理
    let m = b[i + 1];
    while (m === 0xff) {
      i++;
      m = b[i + 1];
    } // 填充字节
    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(b[i], b[i + 1]);
      i += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) {
      // SOS（其后为压缩数据）/ EOI：余下字节原样拷贝
      while (i < b.length) out.push(b[i++]);
      done = true;
      break;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;
    const isExif =
      m === 0xe1 &&
      len > 10 &&
      b[i + 4] === 0x45 &&
      b[i + 5] === 0x78 &&
      b[i + 6] === 0x69 &&
      b[i + 7] === 0x66 &&
      b[i + 8] === 0 &&
      b[i + 9] === 0;
    if (isExif) changed = true;
    else for (let k = 0; k < 2 + len; k++) out.push(b[i + k]);
    i += 2 + len;
  }
  if (!done || (!changed && out.length === b.length)) return b;
  return new Uint8Array(out);
}

// ---- 仿射矩阵（[m0,m1,m2, m3,m4,m5]，点变换 x'=m0x+m1y+m2, y'=m3x+m4y+m5）----

export type Affine = [number, number, number, number, number, number];

export function matMul(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

export function matApply(m: Affine, x: number, y: number): ShapePt {
  return { x: m[0] * x + m[1] * y + m[2], y: m[3] * x + m[4] * y + m[5] };
}

function isIdentity(m: number[]): boolean {
  return (
    m.length === 9 &&
    m[0] === 1 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[3] === 0 &&
    m[4] === 1 &&
    m[5] === 0
  );
}

/** 二次贝塞尔平滑路径（<0.5px 去重，与设备 Pencil.quadTo 一致） */
function pencilPathD(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M ${n(pts[0].x)} ${n(pts[0].y)}`;
  let px = pts[0].x;
  let py = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    const dup =
      i !== pts.length - 1 &&
      Math.abs(cur.x - px) < 0.5 &&
      Math.abs(cur.y - py) < 0.5;
    if (!dup) {
      d += ` Q ${n(px)} ${n(py)} ${n((px + cur.x) / 2)} ${n((py + cur.y) / 2)}`;
    }
    px = cur.x;
    py = cur.y;
  }
  return d;
}

/** 背景花纹 → 矢量线条（几何与配色为设备内置背景的近似） */
function patternSvg(type: number, w: number, h: number): string {
  if (type === 100) return "";
  const unit = Math.max(28, Math.round(Math.min(w, h) / 16));
  const parts: string[] = [];
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    extra = "",
  ): string =>
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#648cbe" stroke-width="1"${extra}/>`;

  switch (type) {
    case 0: {
      for (let x = unit; x < w; x += unit)
        parts.push(line(x, 0, x, h, ' stroke-opacity="0.35"'));
      for (let y = unit; y < h; y += unit)
        parts.push(line(0, y, w, y, ' stroke-opacity="0.35"'));
      break;
    }
    case 1: {
      for (let y = Math.round(unit * 1.5); y < h; y += unit)
        parts.push(line(0, y, w, y, ' stroke-opacity="0.35"'));
      break;
    }
    case 4: {
      for (let x = unit; x < w; x += unit)
        parts.push(
          line(x, 0, x, h, ' stroke-opacity="0.35" stroke-dasharray="6 5"'),
        );
      for (let y = unit; y < h; y += unit)
        parts.push(
          line(0, y, w, y, ' stroke-opacity="0.35" stroke-dasharray="6 5"'),
        );
      for (let x = 0; x < w; x += unit) {
        for (let y = 0; y < h; y += unit) {
          parts.push(line(x, y, x + unit, y + unit, ' stroke-opacity="0.6"'));
          parts.push(line(x + unit, y, x, y + unit, ' stroke-opacity="0.6"'));
        }
      }
      break;
    }
    case 5: {
      const gh = unit * 1.2;
      for (let top = gh; top < h; top += gh * 2) {
        for (let i = 0; i < 4; i++) {
          const y = top + (gh / 3) * i;
          parts.push(line(0, y, w, y, ' stroke-opacity="0.35"'));
        }
      }
      break;
    }
    case 6: {
      for (let x = unit; x < w; x += unit) {
        for (let y = unit; y < h; y += unit) {
          parts.push(
            `<circle cx="${n(x)}" cy="${n(y)}" r="1.6" fill="#648cbe" fill-opacity="0.5"/>`,
          );
        }
      }
      break;
    }
    default:
      break;
  }
  return parts.join("");
}

/**
 * 形状几何 → SVG 元素。
 * 各 type 的几何来自设备端 board.Shape.a() 的反编译结果：
 *   3 平行四边形 4/5 直线(4 虚线[8,8]/5 箭头) 6 角(k→dots[0]→l)
 *   7/102 矩形 8 正方形(min 边) 9 菱形 10 三角形 16 圆(圆心=k 半径=|k−l|)
 *   17 椭圆 1 多边形(dots) 101 图片(matrix+start+imgInitScale 定位)
 */
function shapeSvg(
  s: ShapeRec,
  img: { href: string; w: number; h: number } | null,
): string {
  const { color, opacity } = rgba(s.strokeColor);
  const opacityAttr = opacity < 1 ? ` stroke-opacity="${opacity}"` : "";
  const strokeAttrs = `stroke="${color}"${opacityAttr} stroke-width="${n(
    Math.max(1, s.strokeWidth),
  )}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  const tAttr = transformAttr(s.matrix);

  if (s.type === SHAPE_IMG && s.imgPath) {
    if (img === null) {
      if (s.start && s.end) {
        const x = Math.min(s.start.x, s.end.x);
        const y = Math.min(s.start.y, s.end.y);
        const p = matApply(affineOf(s.matrix), x, y);
        const w = Math.abs(s.end.x - s.start.x);
        const h = Math.abs(s.end.y - s.start.y);
        return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(w)}" height="${n(h)}" ${strokeAttrs} stroke-dasharray="6 4"${tAttr}/>`;
      }
      return "";
    }
    // 图片定位（与设备渲染实测一致）：位图平移到 start，经 p 变换，
    // 再绕 p·rect 左上角缩放 imgInitScale。照片字节已剥 EXIF（原始朝向），
    // 与设备端 BitmapFactory 的口径一致
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
    const rect = s.start && s.end ? rectOf(s.start, s.end) : { x: 0, y: 0 };
    const c = matApply(m, rect.x, rect.y);
    f = matMul([scale, 0, c.x * (1 - scale), 0, scale, c.y * (1 - scale)], f);
    return `<image href="${img.href}" x="0" y="0" width="${n(img.w)}" height="${n(
      img.h,
    )}" preserveAspectRatio="none" transform="matrix(${nm(f[0])} ${nm(f[3])} ${nm(f[1])} ${nm(
      f[4],
    )} ${nm(f[2])} ${nm(f[5])})"/>`;
  }

  if (s.type === SHAPE_IMG || s.type === 13 || s.type === 14 || s.type === 15)
    return "";
  const geo = shapeGeometry(s);
  if (geo === null) {
    if (s.start && s.end) {
      const r = rectOf(s.start, s.end);
      const p = matApply(affineOf(s.matrix), r.x, r.y);
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(s.end.x - s.start.x)}" height="${n(
        s.end.y - s.start.y,
      )}" ${strokeAttrs}${tAttr}/>`;
    }
    return "";
  }
  return `<path d="${geo}" ${strokeAttrs}${tAttr}/>`;
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

const poly = (pts: ShapePt[], close: boolean): string | null => {
  if (pts.length < 2) return null;
  return `M ${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join(" L ")}${close ? " Z" : ""}`;
};

/** 按 board.Shape.a() 解码的各 type 路径几何；null = 未知类型（回退矩形） */
function shapeGeometry(s: ShapeRec): string | null {
  const k = s.start;
  const l = s.end;
  if (!k || !l) return s.dots.length > 1 ? poly(s.dots, true) : null;
  const dx = Math.abs(k.x - l.x);
  const dy = Math.abs(k.y - l.y);
  const minX = Math.min(k.x, l.x);
  const minY = Math.min(k.y, l.y);
  const midX = (k.x + l.x) / 2;
  const midY = (k.y + l.y) / 2;

  switch (s.type) {
    case 1:
      return poly([k, ...s.dots], false);
    case 3: {
      // 平行四边形（设备 type 3 的 path 构建）
      const q = dx / 4;
      return poly([k, { x: l.x - q, y: k.y }, l, { x: k.x - q, y: l.y }], true);
    }
    case 4:
    case 5: {
      // 直线；type 4 由绘制层加 [8,8] 虚线，type 5 追加箭头
      let d = `M ${n(k.x)} ${n(k.y)} L ${n(l.x)} ${n(l.y)}`;
      if (s.type === 5) {
        const theta = Math.atan2(l.y - k.y, l.x - k.x);
        const len = Math.abs(20 / Math.cos(RAD30));
        const flip = l.x < k.x ? -1 : 1;
        const a1 = flip >= 0 ? Math.PI + theta - RAD30 : theta - RAD30;
        const a2 = flip >= 0 ? Math.PI + theta + RAD30 : theta + RAD30;
        d += ` M ${n(l.x + len * Math.cos(a1))} ${n(l.y + len * Math.sin(a1))} L ${n(l.x)} ${n(l.y)}`;
        d += ` M ${n(l.x + len * Math.cos(a2))} ${n(l.y + len * Math.sin(a2))} L ${n(l.x)} ${n(l.y)}`;
      }
      return d;
    }
    case 6: {
      // 角：k → dots[0] → l
      if (s.dots.length < 1) return poly([k, l], false);
      return poly([k, s.dots[0], l], false);
    }
    case 7:
    case 102:
      return poly(
        [
          { x: minX, y: minY },
          { x: minX + dx, y: minY },
          { x: minX + dx, y: minY + dy },
          { x: minX, y: minY + dy },
        ],
        true,
      );
    case 8: {
      // 正方形：min 边
      const side = Math.min(dx, dy);
      return poly(
        [
          { x: minX, y: minY },
          { x: minX + side, y: minY },
          { x: minX + side, y: minY + side },
          { x: minX, y: minY + side },
        ],
        true,
      );
    }
    case 9:
      // 菱形
      return poly(
        [
          { x: midX, y: minY },
          { x: minX + dx, y: midY },
          { x: midX, y: minY + dy },
          { x: minX, y: midY },
        ],
        true,
      );
    case 10: {
      // 三角形（朝向随 k/l 相对位置翻转）
      const q = dx / 3;
      if (k.x < l.x) {
        return poly(
          [k, { x: l.x - q, y: k.y }, l, { x: k.x + q, y: l.y }],
          true,
        );
      }
      return poly([k, { x: l.x + q, y: k.y }, l, { x: k.x - q, y: l.y }], true);
    }
    case 16: {
      // 圆：圆心 = k，半径 = |k − l|
      const r = Math.hypot(k.x - l.x, k.y - l.y);
      return `M ${n(k.x + 0.1)} ${n(k.y + 0.1)} A ${n(r)} ${n(r)} 0 1 1 ${n(k.x)} ${n(
        k.y + 0.1,
      )}`;
    }
    case 17: {
      // 椭圆：k/l 外接矩形
      const r = rectOf(k, l);
      return `M ${n(r.x + r.w / 2)} ${n(r.y)} A ${n(r.w / 2)} ${n(r.h / 2)} 0 1 1 ${n(
        r.x + r.w / 2,
      )} ${n(r.y + r.h)} A ${n(r.w / 2)} ${n(r.h / 2)} 0 1 1 ${n(r.x + r.w / 2)} ${n(r.y)} Z`;
    }
    case 2: {
      // 正多边形（sides 边）
      const sides = s.sides > 2 ? s.sides : 3;
      const radius = Math.min(dx, dy) / 2;
      const cx = midX;
      const cy = Math.min(k.y, l.y) + radius;
      const pts: ShapePt[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i * 2 * Math.PI) / sides + Math.PI / 2;
        pts.push({
          x: cx + radius * Math.cos(a),
          y: cy - radius * Math.sin(a),
        });
      }
      if (sides === 3) {
        // 设备对三角形在中点处补点
        pts.splice(1, 0, {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        });
      }
      return poly(pts, true);
    }
    default:
      return null;
  }
}

function transformAttr(m: number[]): string {
  if (m.length !== 9 || isIdentity(m)) return "";
  return `transform="matrix(${nm(m[0])} ${nm(m[3])} ${nm(m[1])} ${nm(m[4])} ${nm(m[2])} ${nm(m[5])})"`;
}

function strokesSvg(strokes: Stroke[]): { body: string } {
  // 橡皮用几何裁剪（applyErasers，与 PDF 导出一致）：被擦段直接移除，
  // 擦除后新写的笔迹不受影响（静态 mask 无法表达顺序语义）
  const draws = applyErasers(strokes);

  const body = draws
    .map((s) => {
      if (s.penType === 7 || s.penType === 8) {
        const pts = s.points;
        if (pts.length < 2) return "";
        const { color, opacity } = rgba(s.color);
        const dash =
          s.penType === 8
            ? ` stroke-dasharray="10 20 10 20" stroke-dashoffset="1"`
            : "";
        return `<line x1="${n(pts[0].x)}" y1="${n(pts[0].y)}" x2="${n(pts[pts.length - 1].x)}" y2="${n(pts[pts.length - 1].y)}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${n(Math.max(0.6, s.penWidth))}" stroke-linecap="round"${dash}/>`;
      }
      const d = pencilPathD(s.points);
      if (!d) return "";
      const { color, opacity } = rgba(s.color);
      return `<path d="${d}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${n(s.penWidth)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");

  return { body };
}

/** 页面尺寸：cover 截图 → bg 位图 → 内容包围盒（与 PDF 导出一致） */
export async function pageSizeOf(
  page: PageRec,
): Promise<{ width: number; height: number }> {
  const cover = await bitmapSize(page.cover ?? new Uint8Array());
  if (cover) return { width: cover.w, height: cover.h };
  const bg = await bitmapSize(page.bg ?? new Uint8Array());
  if (bg) return { width: bg.w, height: bg.h };
  const strokes = parseStrokes(page.drawpath);
  const shapes = parseShapes(page.drawShapes);
  const bbox = strokesBBox(strokes);
  let minX = 0;
  let minY = 0;
  let maxX = 1000;
  let maxY = 1400;
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

/** 构建整页矢量 SVG */
export async function buildPageSvg(
  page: PageRec,
  fetchImage: SvgImageFetcher,
): Promise<BuiltPageSvg> {
  const { width, height } = await pageSizeOf(page);
  const strokes = parseStrokes(page.drawpath);
  const shapes = parseShapes(page.drawShapes);

  const bg = page.bg;
  let bgLayer: string;
  if (bg && isImageBytes(bg)) {
    bgLayer = `<image href="${bytesDataUrl(bg)}" width="${width}" height="${height}" preserveAspectRatio="none"/>`;
  } else {
    const t = bgTypeOf(page);
    bgLayer = patternSvg(typeof t === "number" ? t : 100, width, height);
  }

  let boardLayer = "";
  if (page.board && isImageBytes(page.board)) {
    boardLayer = `<image href="${bytesDataUrl(page.board)}" width="${width}" height="${height}" preserveAspectRatio="none"/>`;
  }

  const shapeParts: string[] = [];
  for (const s of shapes) {
    if (isDeletedShape(s)) continue; // 对象橡皮删除：设备不绘制
    let img: { href: string; w: number; h: number } | null = null;
    if (s.type === SHAPE_IMG && s.imgPath) {
      img = await fetchImage(imgBasename(s.imgPath));
    }
    const svg = shapeSvg(s, img);
    if (svg) shapeParts.push(svg);
  }

  const { body } = strokesSvg(strokes);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(
    height,
  )}" data-page-svg="1" class="block h-auto w-full rounded shadow-sm"><rect width="${n(
    width,
  )}" height="${n(height)}" fill="#fff"/>${bgLayer}${boardLayer}${shapeParts.join("")}${body}</svg>`;

  return { width, height, svg };
}

const RAD30 = Math.PI / 6;
