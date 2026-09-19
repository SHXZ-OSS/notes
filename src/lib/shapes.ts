/**
 * ShapeSerializable（矢量图形）解析与渲染。
 *
 * 字段：type:byte, strokeColor:int, strokeWidth:int, matrixData:float[9]（Android Matrix）,
 *       startPoint/endPoint/centerPoint/coordinateOriginPoint:PointSerializable{x,y},
 *       dots:ArrayList<PointSerializable>, imgPath:String（type=IMG 时对应 images/{文件名}）
 * type 常量（com.whty.eschoolbag.board.Shape）：
 *   1 POLYGON 3 SOLIDLINE 4 DASHLINE 5 ARROW 7 RECTANGLE 16 CIRCLE … 101 IMG 102 COORDINATE
 */
import {
  asArray,
  asNum,
  asStr,
  parseJavaSerialized,
  type JserObject,
} from "./jser";
import { argbCss } from "./strokes";

export const SHAPE_IMG = 101;

export interface ShapePt {
  x: number;
  y: number;
}

export interface ShapeRec {
  type: number;
  strokeColor: number;
  strokeWidth: number;
  matrix: number[]; // 9 个 float
  start: ShapePt | null;
  end: ShapePt | null;
  dots: ShapePt[];
  imgPath: string | null;
  imgInitScale: number;
  sides: number;
  delflag: number;
}

function pt(o: unknown): ShapePt | null {
  const p = o as JserObject | null;
  if (!p || typeof p !== "object") return null;
  const x = asNum(p.x);
  const y = asNum(p.y);
  if (x == null || y == null) return null;
  return { x, y };
}

export function parseShapes(bytes: Uint8Array | null): ShapeRec[] {
  if (!bytes) return [];
  try {
    const top = parseJavaSerialized(bytes);
    return asArray(top).map((o) => {
      const s = o as JserObject;
      return {
        type: asNum(s.type) ?? 0,
        strokeColor: asNum(s.strokeColor) ?? 0xff000000,
        strokeWidth: asNum(s.strokeWidth) ?? 2,
        matrix: asArray(s.matrixData).map((v) => Number(v)),
        start: pt(s.startPoint),
        end: pt(s.endPoint),
        dots: asArray(s.dots)
          .map(pt)
          .filter((p): p is ShapePt => p != null),
        imgPath: asStr(s.imgPath),
        imgInitScale: asNum(s.imgInitScale) ?? 1,
        sides: asNum(s.sides) ?? 0,
        delflag: asNum(s.delflag) ?? 0,
      };
    });
  } catch (e) {
    console.warn("drawShapes 解析失败", e);
    return [];
  }
}

/**
 * 对象橡皮删除的图形（delflag=1）：设备 drawShapes 循环里直接 continue 跳过。
 * 绘制前必须过滤，否则被删掉的照片仍会出现在预览与导出里；
 * 但页面尺寸估算仍可用其 start/end（插入时以画布中心对称放置）。
 */
export function isDeletedShape(s: ShapeRec): boolean {
  return s.delflag === 1;
}

export function imgBasename(imgPath: string): string {
  const i = Math.max(imgPath.lastIndexOf("/"), imgPath.lastIndexOf("\\"));
  return i >= 0 ? imgPath.slice(i + 1) : imgPath;
}

/** 渲染图形（图像由 fetchImage 提供，避免渲染器耦合网络层） */
export async function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: ShapeRec[],
  scale: number,
  fetchImage: (name: string) => Promise<ImageBitmap | null>,
): Promise<void> {
  for (const s of shapes) {
    if (isDeletedShape(s)) continue;
    ctx.save();
    // Android Matrix 行主序 [sx,kx,tx, ky,sy,ty, p0,p1,p2]
    if (
      s.matrix.length === 9 &&
      s.matrix.some((v, i) => (i === 0 ? v !== 1 : i < 6 ? v !== 0 : v !== 0))
    ) {
      ctx.setTransform(
        s.matrix[0] * scale,
        s.matrix[3] * scale,
        s.matrix[1] * scale,
        s.matrix[4] * scale,
        s.matrix[2] * scale,
        s.matrix[5] * scale,
      );
    } else {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }
    ctx.strokeStyle = ctx.fillStyle = argbCss(s.strokeColor);
    ctx.lineWidth = Math.max(1, s.strokeWidth);

    try {
      if (s.type === SHAPE_IMG && s.imgPath) {
        const bmp = await fetchImage(imgBasename(s.imgPath));
        if (bmp) {
          if (s.start && s.end) {
            const x = Math.min(s.start.x, s.end.x);
            const y = Math.min(s.start.y, s.end.y);
            const w = Math.abs(s.end.x - s.start.x);
            const h = Math.abs(s.end.y - s.start.y);
            ctx.drawImage(bmp, x, y, w, h);
          } else {
            ctx.drawImage(bmp, 0, 0);
          }
        } else {
          drawPlaceholder(ctx, s);
        }
      } else if (s.dots.length > 1) {
        ctx.beginPath();
        ctx.moveTo(s.dots[0].x, s.dots[0].y);
        for (let i = 1; i < s.dots.length; i++)
          ctx.lineTo(s.dots[i].x, s.dots[i].y);
        ctx.closePath();
        ctx.stroke();
      } else if (s.start && s.end) {
        ctx.beginPath();
        ctx.moveTo(s.start.x, s.start.y);
        ctx.lineTo(s.end.x, s.end.y);
        ctx.stroke();
        // 箭头头部
        if (s.type === 5) {
          const ang = Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x);
          const len = 14;
          ctx.beginPath();
          ctx.moveTo(s.end.x, s.end.y);
          ctx.lineTo(
            s.end.x - len * Math.cos(ang - 0.4),
            s.end.y - len * Math.sin(ang - 0.4),
          );
          ctx.moveTo(s.end.x, s.end.y);
          ctx.lineTo(
            s.end.x - len * Math.cos(ang + 0.4),
            s.end.y - len * Math.sin(ang + 0.4),
          );
          ctx.stroke();
        }
      }
    } catch (e) {
      console.warn("图形渲染失败", e);
    }
    ctx.restore();
  }
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, s: ShapeRec): void {
  if (s.start && s.end) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      Math.min(s.start.x, s.end.x),
      Math.min(s.start.y, s.end.y),
      Math.abs(s.end.x - s.start.x),
      Math.abs(s.end.y - s.start.y),
    );
    ctx.restore();
  }
}
