/**
 * epadnote 手写笔迹的 Canvas 渲染。
 *
 * ControllerStroke（两个包两套同构类）：
 *   color:int(ARGB), penType:int, penWidth:float,
 *   points:List<ControllerPoint{x:float,y:float,width:float}>,
 *   mergedStrokes:List<ControllerStroke>（仅 handwriting.canvas 版）
 * penType：1/5=橡皮 2=铅笔 7=直线 8=虚线
 */
import { asArray, asNum, parseJavaSerialized, type JserObject } from "./jser";

export interface Pt {
  x: number;
  y: number;
  width: number;
}

export interface Stroke {
  color: number;
  penType: number;
  penWidth: number;
  points: Pt[];
}

function parsePoint(o: unknown): Pt {
  const p = o as JserObject;
  return {
    x: asNum(p?.x) ?? 0,
    y: asNum(p?.y) ?? 0,
    width: asNum(p?.width) ?? 0,
  };
}

function parseStroke(o: unknown, out: Stroke[]): void {
  const s = o as JserObject;
  if (!s || typeof s !== "object" || s.points === undefined) return;
  const stroke: Stroke = {
    color: asNum(s.color) ?? 0xff000000,
    penType: asNum(s.penType) ?? 2,
    penWidth: asNum(s.penWidth) ?? 2,
    points: asArray(s.points).map(parsePoint),
  };
  out.push(stroke);
  // 合并笔（擦除拼接产物）递归展开
  for (const m of asArray(s.mergedStrokes)) parseStroke(m, out);
}

/** 解析 PageInfo.drawpath / savepath（二次序列化的 ArrayList<ControllerStroke>） */
export function parseStrokes(bytes: Uint8Array | null): Stroke[] {
  if (!bytes) return [];
  try {
    const top = parseJavaSerialized(bytes);
    const strokes: Stroke[] = [];
    for (const s of asArray(top)) parseStroke(s, strokes);
    return strokes;
  } catch (e) {
    console.warn("drawpath 解析失败", e);
    return [];
  }
}

/** ARGB int → CSS 颜色 */
export function argbCss(c: number): string {
  const a = ((c >>> 24) & 255) / 255;
  const r = (c >>> 16) & 255;
  const g = (c >>> 8) & 255;
  const b = c & 255;
  return `rgba(${r},${g},${b},${a})`;
}

export function strokesBBox(
  strokes: Stroke[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    if (s.penType === 1 || s.penType === 5) continue; // 橡皮不影响包围盒
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** 设备端（DrawCanvasView）回放时橡皮宽度固定为 40 */
export const ERASER_WIDTH = 40;

export function isEraserStroke(s: Stroke): boolean {
  return s.penType === 1 || s.penType === 5;
}

/**
 * 按设备端 handwriting.canvas 的方式绘制一笔：
 *   铅笔(2)：恒定 penWidth + 中点二次贝塞尔平滑（<0.5px 去重），圆头；
 *   橡皮(1/5)：固定 40 宽的 destination-out 折线；
 *   直线(7)/虚线(8)：首尾点连线，虚线破折为 [10,20,10,20]。
 * 单点笔迹设备端不绘制，此处同样跳过。
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  scale: number,
): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    const pts = s.points;
    if (pts.length < 2) continue;
    ctx.save();
    if (isEraserStroke(s)) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = (s.penType === 5 ? 2 : ERASER_WIDTH) * scale;
    } else if (s.penType === 7 || s.penType === 8) {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = Math.max(0.6, s.penWidth) * scale;
      ctx.strokeStyle = argbCss(s.color);
      if (s.penType === 8) ctx.setLineDash([10, 20, 10, 20]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
      ctx.lineTo(pts[pts.length - 1].x * scale, pts[pts.length - 1].y * scale);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      continue;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = s.penWidth * scale;
      ctx.strokeStyle = argbCss(s.color);
    }
    // 中点二次贝塞尔平滑路径（与设备 Pencil/Eraser 的 quadTo 逻辑一致）
    const path = new Path2D();
    path.moveTo(pts[0].x * scale, pts[0].y * scale);
    let px = pts[0].x;
    let py = pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      const cur = pts[i];
      const dup =
        i !== pts.length - 1 &&
        Math.abs(cur.x - px) < 0.5 &&
        Math.abs(cur.y - py) < 0.5;
      if (!dup) {
        path.quadraticCurveTo(
          px * scale,
          py * scale,
          ((px + cur.x) / 2) * scale,
          ((py + cur.y) / 2) * scale,
        );
      }
      px = cur.x;
      py = cur.y;
    }
    ctx.stroke(path);
    ctx.restore();
  }
}

/**
 * 把笔迹渲染到独立透明图层：橡皮（destination-out）只影响本层，
 * 不会擦到页面背景和插入照片——与 App 端的橡皮表现一致。
 */
export function renderStrokeLayer(
  strokes: Stroke[],
  width: number,
  height: number,
  scale = 1,
): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.ceil(width * scale));
  cv.height = Math.max(1, Math.ceil(height * scale));
  const ctx = cv.getContext("2d")!;
  drawStrokes(ctx, strokes, scale);
  return cv;
}

function isEraser(s: Stroke): boolean {
  return s.penType === 1 || s.penType === 5;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

interface EraserPath {
  pts: Pt[];
  width: number;
}

/** 点是否落在橡皮扫过的区域内：橡皮半宽 + 笔迹半宽 */
function erasedBy(
  p: Pt,
  strokeHalfWidth: number,
  erasers: EraserPath[],
): boolean {
  for (const e of erasers) {
    const w = e.width / 2 + strokeHalfWidth;
    const eps = e.pts;
    for (let i = 0; i < eps.length; i++) {
      if (Math.hypot(p.x - eps[i].x, p.y - eps[i].y) < w) return true;
      if (i > 0) {
        const q = eps[i - 1];
        if (distToSegment(p.x, p.y, q.x, q.y, eps[i].x, eps[i].y) < w)
          return true;
      }
    }
  }
  return false;
}

/**
 * 几何橡皮：把被橡皮扫过的笔迹段切开，只返回仍需绘制的笔迹。
 * PDF 没有 destination-out 这类像素擦除，矢量导出用它实现与设备一致的擦除效果。
 */
export function applyErasers(strokes: Stroke[]): Stroke[] {
  if (!strokes.some(isEraser)) return strokes.filter((s) => !isEraser(s));
  const out: Stroke[] = [];
  strokes.forEach((s, i) => {
    if (isEraser(s)) return;
    // 设备顺序回放：橡皮只清除它之前绘制的像素；
    // 因此对 stroke i 生效的是它之后（index > i）的橡皮
    const before: EraserPath[] = strokes
      .slice(i + 1)
      .filter(isEraser)
      .map((e) => ({
        pts: e.points,
        width: e.penType === 5 ? 2 : ERASER_WIDTH,
      }));
    const half = Math.max(0.6, s.penWidth) / 2;
    if (!before.length) {
      out.push(s);
      return;
    }
    let run: Pt[] = [];
    const flush = (): void => {
      if (run.length) {
        out.push({ ...s, points: run });
        run = [];
      }
    };
    for (const p of s.points) {
      if (erasedBy(p, half, before)) flush();
      else run.push(p);
    }
    flush();
  });
  return out;
}
