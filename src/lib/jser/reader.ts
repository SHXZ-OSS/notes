/**
 * Java 对象序列化流（JSER）解析器（TypeScript 实现）。
 *
 * epadnote 笔记 App 通过 OCB（ObjectOutputStream 封装）把
 * NoteInfo / PageInfo / BookNoteBean / TagInfo / ControllerStroke / ShapeSerializable
 * 序列化成 .obj 上传到 xzzx-sis 的 appdata。本解析器按
 * 《Java Object Serialization Specification》直接读流中的类描述符，
 * 因此无需硬编码类结构即可解析任意 Serializable 对象。
 *
 * 输出模型：
 *   对象    → { __class: "com.foo.Bar", field: value, ... }
 *   byte[]  → Uint8Array
 *   其他数组→ JS 数组
 *   ArrayList 等带 writeObject 的集合 → JS 数组（元素取自注解内容）
 */

export interface JserObject {
  __class: string;
  [field: string]: unknown;
}

export type JserValue =
  | JserObject
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | JserValue[]
  | null;

const TC_NULL = 0x70;
const TC_REFERENCE = 0x71;
const TC_CLASSDESC = 0x72;
const TC_OBJECT = 0x73;
const TC_STRING = 0x74;
const TC_ARRAY = 0x75;
const TC_CLASS = 0x76;
const TC_BLOCKDATA = 0x77;
const TC_ENDBLOCKDATA = 0x78;
const TC_RESET = 0x79;
const TC_BLOCKDATALONG = 0x7a;
const TC_LONGSTRING = 0x7b;
const TC_ENUM = 0x7e;

const SC_WRITE_METHOD = 0x01;
const SC_SERIALIZABLE = 0x02;
const SC_ENUM = 0x10;

const BASE_WIRE_HANDLE = 0x7e0000;

interface ClassDesc {
  name: string;
  flags: number;
  fields: FieldDesc[];
  serializable: boolean;
  hasWriteMethod: boolean;
  isEnum: boolean;
  superDesc: ClassDesc | null;
}

interface FieldDesc {
  typecode: string; // B C D F I J S Z L [
  name: string;
  className?: string; // L / [ 字段的类型名（如 "Ljava/lang/String;" / "[B"）
}

export class JavaSerializationError extends Error {}

export class JavaSerializationReader {
  private view: DataView;
  private bytes: Uint8Array;
  private pos = 0;
  private handles: unknown[] = [];

  constructor(buf: ArrayBuffer | Uint8Array) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 4 || u8[0] !== 0xac || u8[1] !== 0xed) {
      throw new JavaSerializationError("不是 Java 序列化流（缺少 AC ED 魔数）");
    }
    this.bytes = u8;
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = 2; // 跳过魔数
    const version = this.u16();
    if (version !== 0x0005) {
      throw new JavaSerializationError(`不支持的序列化流版本: ${version}`);
    }
  }

  // ---------- 基础读取 ----------

  private u8(): number {
    if (this.pos >= this.bytes.length)
      throw new JavaSerializationError("流意外结束");
    return this.bytes[this.pos++];
  }

  private peek(): number {
    return this.bytes[this.pos];
  }

  private u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  private i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  private i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  private i64(): number {
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return Number(v);
  }

  private f32(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  private f64(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  private skip(n: number): void {
    this.pos += n;
  }

  /** Java 修改版 UTF-8 解码（DataInput.readUTF 语义） */
  static decodeModifiedUTF8(b: Uint8Array): string {
    let out = "";
    for (let i = 0; i < b.length;) {
      const a = b[i++];
      if ((a & 0x80) === 0) {
        out += String.fromCharCode(a);
      } else if ((a & 0xe0) === 0xc0) {
        out += String.fromCharCode(((a & 0x1f) << 6) | (b[i++] & 0x3f));
      } else if ((a & 0xf0) === 0xe0) {
        out += String.fromCharCode(
          ((a & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f),
        );
      }
      // 修改版 UTF-8 中不存在的编码（0xF8-0xFF 前缀）不出现于合法流
    }
    return out;
  }

  private readUTF(length: number): string {
    const b = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return JavaSerializationReader.decodeModifiedUTF8(b);
  }

  private newHandle(value: unknown): number {
    this.handles.push(value);
    return BASE_WIRE_HANDLE + this.handles.length - 1;
  }

  private setHandle(handle: number, value: unknown): void {
    this.handles[handle - BASE_WIRE_HANDLE] = value;
  }

  private getHandle(handle: number): unknown {
    const idx = handle - BASE_WIRE_HANDLE;
    if (idx < 0 || idx >= this.handles.length) {
      throw new JavaSerializationError(`非法句柄引用 0x${handle.toString(16)}`);
    }
    return this.handles[idx];
  }

  // ---------- 流结构 ----------

  /** 读取顶层对象（一次 writeObject 的内容） */
  readObject(): JserValue {
    return this.readContent();
  }

  private readContent(): JserValue {
    const tag = this.u8();
    switch (tag) {
      case TC_NULL:
        return null;
      case TC_REFERENCE:
        return this.getHandle(this.i32()) as JserValue;
      case TC_STRING:
        return this.readString(this.u16());
      case TC_LONGSTRING:
        return this.readString(Number(this.i64()));
      case TC_OBJECT:
        return this.readNewObject();
      case TC_ARRAY:
        return this.readNewArray();
      case TC_CLASS:
        return this.readNewClass();
      case TC_ENUM:
        return this.readNewEnum();
      case TC_BLOCKDATA: {
        const len = this.u8();
        this.skip(len);
        return null;
      }
      case TC_BLOCKDATALONG: {
        const len = Number(this.i64());
        this.skip(len);
        return null;
      }
      case TC_RESET:
        this.handles = [];
        return null;
      default:
        throw new JavaSerializationError(
          `未支持的流标记 0x${tag.toString(16)} @${this.pos - 1}`,
        );
    }
  }

  private readString(len: number): string {
    const s = this.readUTF(len);
    this.newHandle(s);
    return s;
  }

  private readClassDesc(): ClassDesc | null {
    const tag = this.u8();
    switch (tag) {
      case TC_NULL:
        return null;
      case TC_REFERENCE:
        return this.getHandle(this.i32()) as ClassDesc;
      case TC_CLASSDESC:
        return this.readNewClassDesc();
      default:
        throw new JavaSerializationError(
          `未支持的类描述标记 0x${tag.toString(16)}`,
        );
    }
  }

  private readNewClassDesc(): ClassDesc {
    const handle = this.newHandle(null); // 占位，读完填充
    const name = this.readUTF(this.u16());
    this.skip(8); // serialVersionUID (64 位)
    const flags = this.u8();
    const fieldCount = this.u16();
    const fields: FieldDesc[] = [];
    for (let i = 0; i < fieldCount; i++) {
      const typecode = String.fromCharCode(this.u8());
      const fname = this.readUTF(this.u16());
      let className: string | undefined;
      if (typecode === "L" || typecode === "[") {
        // 类型名以字符串对象写入（TC_STRING/TC_LONGSTRING 会分配句柄，后续可被引用）
        const tag = this.u8();
        if (tag === TC_STRING || tag === TC_LONGSTRING) {
          const len = tag === TC_STRING ? this.u16() : Number(this.i64());
          className = this.readUTF(len);
          this.newHandle(className);
        } else if (tag === TC_REFERENCE) {
          className = this.getHandle(this.i32()) as string;
        } else {
          throw new JavaSerializationError(
            `字段 ${fname} 类型名标记非法 0x${tag.toString(16)}`,
          );
        }
      }
      fields.push({ typecode, name: fname, className });
    }
    // classAnnotation：读内容直到 TC_ENDBLOCKDATA（可能含句柄分配）
    while (this.peek() !== TC_ENDBLOCKDATA) {
      if (this.peek() === undefined)
        throw new JavaSerializationError("类注解区流结束");
      this.readContent();
    }
    this.skip(1); // TC_ENDBLOCKDATA
    const superDesc = this.readClassDesc();
    const desc: ClassDesc = {
      name,
      flags,
      fields,
      serializable: (flags & SC_SERIALIZABLE) !== 0,
      hasWriteMethod: (flags & SC_WRITE_METHOD) !== 0,
      isEnum: (flags & SC_ENUM) !== 0,
      superDesc,
    };
    this.setHandle(handle, desc);
    return desc;
  }

  private readNewObject(): JserObject {
    const desc = this.readClassDesc();
    if (!desc) throw new JavaSerializationError("TC_OBJECT 缺少类描述");
    const handle = this.newHandle(null); // 先占位，供自引用
    const obj: JserObject = { __class: desc.name };
    this.setHandle(handle, obj);
    // 数据从最顶层可序列化父类开始写
    const chain: ClassDesc[] = [];
    for (let d: ClassDesc | null = desc; d; d = d.superDesc) chain.unshift(d);
    for (const d of chain) {
      if (d.isEnum) continue; // TC_ENUM 单独处理
      if (!d.serializable) continue;
      for (const f of d.fields) {
        const isPrim =
          f.typecode.length === 1 && "BCDFIJSZ".includes(f.typecode);
        obj[f.name] = isPrim
          ? this.readPrimitive(f.typecode)
          : this.readContent();
      }
      if (d.hasWriteMethod) {
        // 自定义 writeObject 的附加内容（ArrayList 的元素就在这里）
        obj.__extra = this.readObjectAnnotation();
      }
    }
    obj.__class = desc.name;
    return obj;
  }

  private readObjectAnnotation(): unknown[] {
    const items: unknown[] = [];
    for (;;) {
      const tag = this.peek();
      if (tag === TC_ENDBLOCKDATA) {
        this.skip(1);
        break;
      }
      if (tag === undefined)
        throw new JavaSerializationError("对象注解区流结束");
      const v = this.readContent();
      if (tag !== TC_BLOCKDATA && tag !== TC_BLOCKDATALONG) items.push(v);
    }
    return items;
  }

  private readNewArray(): JserValue {
    const desc = this.readClassDesc();
    if (!desc) throw new JavaSerializationError("TC_ARRAY 缺少类描述");
    const handle = this.newHandle(null);
    const len = this.i32();
    const cn = desc.name;
    let result: JserValue;
    if (cn === "[B") {
      result = this.bytes.slice(this.pos, this.pos + len);
      this.skip(len);
    } else if (cn === "[C") {
      result = JavaSerializationReader.decodeModifiedUTF8(
        this.bytes.subarray(this.pos, this.pos + 2 * len),
      );
      this.skip(2 * len);
    } else if (cn === "[F") {
      const arr: number[] = [];
      for (let i = 0; i < len; i++) arr.push(this.f32());
      result = arr;
    } else if (cn === "[D") {
      const arr: number[] = [];
      for (let i = 0; i < len; i++) arr.push(this.f64());
      result = arr;
    } else if (cn === "[I") {
      const arr: number[] = [];
      for (let i = 0; i < len; i++) arr.push(this.i32());
      result = arr;
    } else if (cn === "[J") {
      const arr: number[] = [];
      for (let i = 0; i < len; i++) arr.push(this.i64());
      result = arr;
    } else if (cn === "[S") {
      const arr: number[] = [];
      for (let i = 0; i < len; i++) arr.push(this.i16());
      result = arr;
    } else if (cn === "[Z") {
      const arr: boolean[] = [];
      for (let i = 0; i < len; i++) arr.push(this.u8() !== 0);
      result = arr as unknown as JserValue[];
    } else {
      // 对象数组 [L...;
      const arr: JserValue[] = [];
      for (let i = 0; i < len; i++) arr.push(this.readContent());
      result = arr;
    }
    this.setHandle(handle, result);
    return result;
  }

  private readNewClass(): JserValue {
    const desc = this.readClassDesc();
    return {
      __class: "java.lang.Class",
      name: desc?.name ?? "?",
      type: "class",
    };
  }

  private readNewEnum(): JserValue {
    const desc = this.readClassDesc();
    if (!desc) throw new JavaSerializationError("TC_ENUM 缺少类描述");
    const handle = this.newHandle(null);
    const constant = this.readContent();
    const obj: JserObject = { __class: desc.name, __enum: constant };
    this.setHandle(handle, obj);
    return obj;
  }

  private readPrimitive(typecode: string): JserValue {
    switch (typecode) {
      case "B":
        return this.view.getInt8(this.pos++);
      case "C":
        return String.fromCharCode(this.u16());
      case "D":
        return this.f64();
      case "F":
        return this.f32();
      case "I":
        return this.i32();
      case "J":
        return this.i64();
      case "S":
        return this.i16();
      case "Z":
        return this.u8() !== 0;
      default:
        throw new JavaSerializationError(`未知基本类型 ${typecode}`);
    }
  }
}

/** 解析一段 .obj 字节，返回顶层对象 */
export function parseJavaSerialized(buf: ArrayBuffer | Uint8Array): JserValue {
  const reader = new JavaSerializationReader(buf);
  return reader.readObject();
}
