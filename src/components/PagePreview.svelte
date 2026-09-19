<script lang="ts">
  import {
    Brush,
    Download,
    Image as ImageIcon,
    X,
    ZoomIn,
    ZoomOut,
  } from "@lucide/svelte";
  import { Button, Tooltip } from "kampsy-ui";
  import PageCanvas from "./PageCanvas.svelte";
  import BytesImg from "./BytesImg.svelte";
  import { downloadBlob } from "../lib/download";
  import type { PageRec } from "../lib/notes";

  let { page, onClose }: { page: PageRec; onClose: () => void } = $props();

  let mode = $state<"draw" | "cover">("draw");
  let vw = $state(window.innerWidth);
  let pageW = $state(0);
  /** null = 适应宽度，否则为相对页面原始尺寸的倍率 */
  let zoom = $state<number | null>(null);
  let zoomMenuOpen = $state(false);
  let dlMenuOpen = $state(false);

  function onResize(): void {
    vw = window.innerWidth;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (zoomMenuOpen) {
        zoomMenuOpen = false;
        return;
      }
      if (dlMenuOpen) {
        dlMenuOpen = false;
        return;
      }
      onClose();
    }
  }

  const fitWidth = $derived(Math.min(1100, Math.max(320, vw - 120)));
  const displayWidth = $derived(zoom == null ? fitWidth : Math.round(pageW * zoom));
  const curZoom = $derived(pageW > 0 ? (zoom ?? fitWidth / pageW) : 1);
  const zoomLabel = $derived(zoom == null ? "适应宽度" : `${Math.round(curZoom * 100)}%`);

  const ZOOM_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3];

  function zoomIn(): void {
    zoom = Math.min(4, curZoom * 1.25);
  }
  function zoomOut(): void {
    zoom = Math.max(0.1, curZoom / 1.25);
  }
  function pickZoom(v: number | null): void {
    zoom = v;
    zoomMenuOpen = false;
  }

  function downloadPng(): void {
    const el = document.querySelector<SVGSVGElement>("svg[data-page-svg]");
    if (!el) return;
    const xml = new XMLSerializer().serializeToString(el);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const vw = el.viewBox.baseVal.width;
      const vh = el.viewBox.baseVal.height;
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(vw * scale));
      cv.height = Math.max(1, Math.round(vh * scale));
      const c = cv.getContext("2d")!;
      c.fillStyle = "#fff";
      c.fillRect(0, 0, cv.width, cv.height);
      c.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => {
        if (b) downloadBlob(b, `page_${page.pageid}.png`);
      }, "image/png");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  function downloadSvg(): void {
    const el = document.querySelector<SVGSVGElement>("svg[data-page-svg]");
    if (!el) return;
    const xml = new XMLSerializer().serializeToString(el);
    downloadBlob(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }), `page_${page.pageid}.svg`);
  }

  function iconBtnCls(): string {
    return "grid size-8 place-items-center rounded-md text-gray-600 transition-colors hover:bg-gray-100";
  }
</script>

<svelte:window onresize={onResize} onkeydown={onKey} />

<div class="fixed inset-0 z-50 flex flex-col bg-white">
  <div class="flex h-12 shrink-0 items-center gap-1.5 border-b border-gray-200 px-3">
    <div class="truncate text-sm font-medium">
      {page.name || "页面"}
      <span class="ml-1 text-xs font-normal text-gray-500">
        第 {page.site} 页 · id {page.pageid}
      </span>
    </div>
    <div class="flex-1"></div>

    <div class="flex items-center overflow-hidden rounded-md border border-gray-200">
      <Tooltip text="按笔迹数据矢量重绘" position="bottom" class="flex items-center">
        <button
          type="button"
          class="grid size-8 place-items-center {mode === 'draw'
            ? 'bg-gray-100 text-gray-900'
            : 'text-gray-500 hover:bg-gray-50'}"
          onclick={() => (mode = "draw")}
        >
          <Brush size={15} />
        </button>
      </Tooltip>
      <Tooltip text="笔记 App 保存的整页截图" position="bottom" class="flex items-center">
        <button
          type="button"
          disabled={!page.cover}
          class="grid size-8 place-items-center border-l border-gray-200 {mode === 'cover'
            ? 'bg-gray-100 text-gray-900'
            : 'text-gray-500 hover:bg-gray-50'} disabled:opacity-40"
          onclick={() => (mode = "cover")}
        >
          <ImageIcon size={15} />
        </button>
      </Tooltip>
    </div>

    {#if mode === "draw"}
      <div class="relative ml-1 flex items-center gap-0.5">
        <button type="button" title="缩小" class={iconBtnCls()} onclick={zoomOut}>
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          class="min-w-[72px] rounded-md px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
          title="选择缩放倍率"
          onclick={() => (zoomMenuOpen = !zoomMenuOpen)}
        >
          {zoomLabel}
        </button>
        <button type="button" title="放大" class={iconBtnCls()} onclick={zoomIn}>
          <ZoomIn size={15} />
        </button>
        {#if zoomMenuOpen}
          <button
            type="button"
            class="fixed inset-0 z-40 cursor-default"
            title=""
            onclick={() => (zoomMenuOpen = false)}
          ></button>
          <div
            class="absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          >
            <button
              type="button"
              class="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 {zoom ==
              null
                ? "font-medium"
                : ""}"
              onclick={() => pickZoom(null)}
            >
              适应宽度
            </button>
            {#each ZOOM_OPTIONS as z (z)}
              <button
                type="button"
                class="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 {zoom ===
                z
                  ? "font-medium"
                  : ""}"
                onclick={() => pickZoom(z)}
              >
                {Math.round(z * 100)}%
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="relative ml-1">
      <Button
        size="small"
        variant="secondary"
        disabled={mode !== "draw"}
        onclick={() => (dlMenuOpen = !dlMenuOpen)}
      >
        {#snippet prefix()}<Download size={13} />{/snippet}
        下载
      </Button>
      {#if dlMenuOpen}
        <button
          type="button"
          class="fixed inset-0 z-40 cursor-default"
          title=""
          onclick={() => (dlMenuOpen = false)}
        ></button>
        <div
          class="absolute top-full right-0 z-50 mt-1 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            class="block w-full px-4 py-1.5 text-left text-xs whitespace-nowrap text-gray-700 hover:bg-gray-100"
            onclick={() => {
              dlMenuOpen = false;
              downloadPng();
            }}
          >
            PNG 位图（2x）
          </button>
          <button
            type="button"
            class="block w-full px-4 py-1.5 text-left text-xs whitespace-nowrap text-gray-700 hover:bg-gray-100"
            onclick={() => {
              dlMenuOpen = false;
              downloadSvg();
            }}
          >
            SVG 矢量
          </button>
        </div>
      {/if}
    </div>
    <button type="button" title="关闭" class="{iconBtnCls()} ml-0.5" onclick={onClose}>
      <X size={17} />
    </button>
  </div>

  <div class="grid flex-1 place-items-start justify-center overflow-auto bg-[#525659] py-5">
    <div class="m-auto">
      {#if mode === "draw"}
        <PageCanvas
          {page}
          displayWidth={displayWidth}
          onSize={(w) => {
            pageW = w;
          }}
        />
      {:else if page.cover}
        <BytesImg bytes={page.cover} class="max-w-full shadow-2xl" />
      {:else}
        <div class="rounded-md bg-white/90 px-4 py-2 text-sm text-gray-600">
          此页面没有封面截图，请使用矢量重绘模式
        </div>
      {/if}
    </div>
  </div>
</div>
