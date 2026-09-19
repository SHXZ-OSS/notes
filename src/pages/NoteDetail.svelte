<script lang="ts">
  import { ArrowLeft, FileDown, LoaderCircle } from '@lucide/svelte';
  import { Button } from 'kampsy-ui';
  import { notesStore } from '../lib/notes';
  import Link from '../components/Link.svelte';
  import PageCanvas from '../components/PageCanvas.svelte';
  import PagePreview from '../components/PagePreview.svelte';
  import { getAppdataBytes } from '../api/client';
  import { auth, userName } from '../api/auth';
  import { downloadBlob } from '../lib/download';
  import type { PageRec } from '../lib/notes';

  let { noteid }: { noteid: string } = $props();

  const idx = $derived($notesStore);
  const id = $derived(parseInt(noteid, 10));
  const note = $derived.by(() => {
    void idx.version;
    return notesStore.notes.get(id) ?? null;
  });
  const pages = $derived.by(() => {
    void idx.version;
    return notesStore.pagesOf(id);
  });
  const book = $derived.by(() => {
    void idx.version;
    return notesStore.bookOf(id);
  });

  let preview = $state<PageRec | null>(null);
  let pdfBusy = $state(false);
  let pdfMsg = $state<string | null>(null);

  async function exportPdf(): Promise<void> {
    if (!note || pages.length === 0) return;
    pdfBusy = true;
    pdfMsg = '准备中…';
    try {
      const { exportPagesToPdf } = await import('../lib/pdfExport');
      const blob = await exportPagesToPdf(
        pages,
        async (name) => {
          const { bytes } = await getAppdataBytes(`images/${name}`);
          return new Uint8Array(bytes);
        },
        (_d, _t, m) => {
          pdfMsg = m;
        },
        { title: note.name, author: userName($auth.user) || '学生' },
      );
      if (blob.size === 0) {
        pdfMsg = '没有可导出的页面';
        return;
      }
      const safe = (note.name || '笔记').replace(/[\\/:*?"<>|]/g, '_');
      downloadBlob(blob, `${safe}_${note.noteid}.pdf`);
      pdfMsg = null;
    } catch (e) {
      pdfMsg = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      pdfBusy = false;
    }
  }
</script>

<div class="space-y-4">
  {#if !note}
    <div class="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600">
      {Number.isNaN(id)
        ? '无效的笔记 ID'
        : idx.status === 'loading'
          ? '索引中，请稍候…'
          : '找不到该笔记（可能尚未同步或已删除）'}
    </div>
  {:else}
    <div class="flex items-center gap-1.5 text-sm">
      <Link to="/" class="text-gray-500 hover:text-gray-900">笔记本</Link>
      {#if book}
        <span class="text-gray-300">/</span>
        <Link to={`/notes?book=${book.bookid}`} class="text-gray-500 hover:text-gray-900">
          {book.name}
        </Link>
      {/if}
      <span class="text-gray-300">/</span>
      <span class="text-gray-900">{note.name}</span>
    </div>

    <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <button
        type="button"
        title="返回"
        class="grid size-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100"
        onclick={() => history.back()}
      >
        <ArrowLeft size={15} />
      </button>
      <h2 class="text-base font-semibold">{note.name}</h2>
      {#if note.subject}
        <span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
          {note.subject}
        </span>
      {/if}
      {#if note.chapter}
        <span class="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600">
          {note.chapter}
        </span>
      {/if}
      <div class="flex-1"></div>
      <Button
        loading={pdfBusy}
        disabled={pdfBusy || pages.length === 0}
        title="背景为矢量线条、照片原图嵌入、笔迹为矢量路径（非截图）"
        onclick={() => void exportPdf()}
      >
        {#snippet prefix()}
          {#if pdfBusy}
            <LoaderCircle size={14} class="animate-spin" />
          {:else}
            <FileDown size={14} />
          {/if}
        {/snippet}
        导出 PDF
      </Button>
    </div>

    {#if pdfMsg}
      <div
        class="rounded-md px-3 py-1.5 text-sm {pdfMsg.startsWith('导出失败')
          ? 'border border-red-200 bg-red-50 text-red-600'
          : 'bg-gray-100 text-gray-600'}"
      >
        {pdfMsg}
      </div>
    {/if}

    <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500">
      <span>创建：{note.createtime ?? '-'}</span>
      <span>更新：{note.updatetime ?? '-'}</span>
      <span>ID：{note.noteid}</span>
    </div>

    <div class="h-px bg-gray-200"></div>

    <h3 class="text-sm font-medium">
      页面
      <span class="ml-1 text-xs font-normal text-gray-400">
        （{pages.length} 页{idx.status === 'loading' ? '，后台索引中…' : ''}）
      </span>
    </h3>

    {#if pages.length === 0}
      <div class="py-6 text-sm text-gray-500">
        {idx.status === 'loading' ? '页面加载中…' : '此笔记还没有同步页面。'}
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each pages as p (p.pageid)}
          <button type="button" class="group text-left" onclick={() => (preview = p)}>
            <div class="transition-transform group-hover:-translate-y-0.5">
              <PageCanvas page={p} maxWidth={240} />
            </div>
            <div class="mt-1.5 flex items-center gap-1.5 text-xs">
              <span class="rounded-full bg-gray-100 px-1.5 py-0.5 text-gray-600">
                第 {p.site} 页
              </span>
              <span class="text-gray-400">{(p.updatetime ?? p.createtime ?? '').slice(5)}</span>
            </div>
          </button>
        {/each}
      </div>
    {/if}

    {#if preview}
      <PagePreview page={preview} onClose={() => (preview = null)} />
    {/if}
  {/if}
</div>
