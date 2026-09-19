<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";
  import { getAppdataBytes } from "../api/client";
  import {
    buildPageSvg,
    bytesDataUrl,
    imageSize,
    type BuiltPageSvg,
  } from "../lib/pageSvg";
  import type { PageRec } from "../lib/notes";

  const imgCache = new Map<
    string,
    Promise<{ href: string; w: number; h: number } | null>
  >();
  const fetcher = (
    name: string,
  ): Promise<{ href: string; w: number; h: number } | null> => {
    if (!imgCache.has(name)) {
      imgCache.set(
        name,
        (async () => {
          try {
            const { bytes } = await getAppdataBytes(`images/${name}`);
            const u8 = new Uint8Array(bytes);
            // 尺寸取自文件头字节（设备 BitmapFactory 口径）：浏览器解码器会按
            // EXIF 摆正（竖版），不认 imageOrientation 的内核更会直接转 90°
            const sz = imageSize(u8);
            if (!sz) return null;
            // data URL：SVG 自包含，光栅化与导出的 .svg 均可直接使用；
            // bytesDataUrl 会剥掉 JPEG 的 EXIF，保证各解码器像素口径一致
            return { href: bytesDataUrl(u8), w: sz.w, h: sz.h };
          } catch {
            return null;
          }
        })(),
      );
    }
    return imgCache.get(name)!;
  };

  let {
    page,
    maxWidth,
    displayWidth,
    onSize,
  }: {
    page: PageRec;
    maxWidth?: number;
    displayWidth?: number;
    onSize?: (w: number, h: number) => void;
  } = $props();

  let built = $state<BuiltPageSvg | null>(null);
  let stage: "loading" | "ok" | "error" = $state("loading");

  $effect(() => {
    const p = page;
    let alive = true;
    stage = "loading";
    void (async () => {
      try {
        const b = await buildPageSvg(p, fetcher);
        if (!alive) return;
        built = b;
        onSize?.(b.width, b.height);
        stage = "ok";
      } catch (e) {
        console.error("页面渲染失败", e);
        if (alive) stage = "error";
      }
    })();
    return () => {
      alive = false;
    };
  });
</script>

<div
  class="relative"
  style:max-width={displayWidth ? undefined : (maxWidth ? `${maxWidth}px` : undefined)}
  style:width={displayWidth ? `${displayWidth}px` : undefined}
>
  {#if stage === "ok" && built}
    {@html built.svg}
  {:else}
    <div
      class="grid w-full place-items-center rounded bg-gray-100 {displayWidth
        ? ''
        : 'aspect-[3/4]'}"
      style:height={displayWidth ? `${Math.round((displayWidth * 4) / 3)}px` : undefined}
    >
      {#if stage === "loading"}
        <LoaderCircle size={24} class="animate-spin text-gray-400" />
      {:else}
        <span class="text-xs text-red-600">渲染失败</span>
      {/if}
    </div>
  {/if}
</div>
