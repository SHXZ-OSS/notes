<script lang="ts">
  import { Archive, FileText, LoaderCircle } from '@lucide/svelte';
  import { Button, SearchInput } from 'kampsy-ui';
  import { notesStore } from '../lib/notes';
  import { navigate } from '../lib/router';
  import { getAppdataBytes } from '../api/client';
  import { auth, userName } from '../api/auth';
  import { downloadBlob } from '../lib/download';
  import BytesImg from '../components/BytesImg.svelte';
  import Link from '../components/Link.svelte';

  let { query }: { query: URLSearchParams } = $props();

  const idx = $derived($notesStore);
  let q = $state('');
  let zipBusy = $state(false);
  let zipMsg = $state<string | null>(null);

  const bookid = $derived(query.get('book') ? parseInt(query.get('book')!, 10) : null);
  const loose = $derived(query.get('loose') === '1');
  const book = $derived(bookid != null ? (notesStore.books.get(bookid) ?? null) : null);

  /** 当前视图范围的笔记（不含搜索过滤）：全部笔记 / 未分类 / 某本笔记本 */
  const scoped = $derived.by(() => {
    void idx.version;
    let list = [...notesStore.notes.values()];
    if (bookid != null) list = list.filter((n) => n.bookid === bookid);
    else if (loose) {
      const known = new Set(notesStore.books.keys());
      list = list.filter((n) => !known.has(n.bookid));
    }
    return list.sort((a, b) =>
      (b.updatetime ?? b.createtime ?? '').localeCompare(a.updatetime ?? a.createtime ?? ''),
    );
  });

  const notes = $derived.by(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return scoped;
    return scoped.filter((n) => n.name.toLowerCase().includes(kw));
  });

  const title = $derived(book ? book.name : loose ? '未分类笔记' : '全部笔记');

  /** 导出当前视图范围内的全部笔记 PDF，打包成 zip：笔记-学生姓名-YYYYMMDD.zip */
  async function exportBookZip(): Promise<void> {
    if (scoped.length === 0 || zipBusy) return;
    zipBusy = true;
    zipMsg = '准备中…';
    try {
      const { exportNotesToZip, safeFileName, ymd } = await import(
        '../lib/zipExport'
      );
      const { blob, notes: n, skipped } = await exportNotesToZip(
        scoped,
        (noteid) => notesStore.pagesOf(noteid),
        async (name) => {
          const { bytes } = await getAppdataBytes(`images/${name}`);
          return new Uint8Array(bytes);
        },
        (m) => {
          zipMsg = m;
        },
        { author: userName($auth.user) || '学生' },
      );
      if (n === 0) {
        zipMsg = '没有可导出的页面';
        return;
      }
      const who = safeFileName(userName($auth.user) || '学生');
      downloadBlob(blob, `笔记-${who}-${ymd()}.zip`);
      zipMsg = skipped.length
        ? `已导出 ${n} 篇（${skipped.length} 篇无页面已跳过）`
        : null;
    } catch (e) {
      zipMsg = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      zipBusy = false;
    }
  }
</script>

<div class="space-y-4">
  {#if book || loose}
    <div class="flex items-center gap-1.5 text-sm">
      <Link to="/" class="text-gray-500 hover:text-gray-900">笔记本</Link>
      <span class="text-gray-300">/</span>
      <span class="text-gray-900">{title}</span>
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <h2 class="text-base font-semibold">{title}</h2>
    <span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
      {notes.length} 篇
    </span>
    <div class="flex-1"></div>
    <Button
      size="small"
      variant="secondary"
      loading={zipBusy}
      disabled={zipBusy || scoped.length === 0}
      title="把{title}的全部笔记各导出一个 PDF，打包成 zip"
      onclick={() => void exportBookZip()}
    >
      {#snippet prefix()}
        {#if zipBusy}
          <LoaderCircle size={13} class="animate-spin" />
        {:else}
          <Archive size={13} />
        {/if}
      {/snippet}
      导出全部 PDF
    </Button>
    <div class="w-full sm:w-[240px]">
      <SearchInput placeholder="搜索笔记名" bind:value={q} />
    </div>
  </div>

  {#if zipMsg}
    <div
      class="rounded-md px-3 py-1.5 text-sm {zipMsg.startsWith('导出失败')
        ? 'border border-red-200 bg-red-50 text-red-600'
        : 'bg-gray-100 text-gray-600'}"
    >
      {zipMsg}
    </div>
  {/if}

  {#if idx.status === 'error'}
    <div class="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
      <span>索引失败：{idx.error}</span>
      <Button size="small" variant="secondary" onclick={() => void notesStore.load()}>重试</Button>
    </div>
  {/if}

  {#if notes.length === 0}
    <div class="py-8 text-center text-sm text-gray-500">
      {idx.status === 'loading' ? '加载中…' : '没有符合条件的笔记。'}
    </div>
  {:else}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {#each notes as n (n.noteid)}
        <button
          type="button"
          class="overflow-hidden rounded-lg border border-gray-200 bg-white text-left transition-shadow hover:shadow-md"
          onclick={() => navigate(`/notes/${n.noteid}`)}
        >
          <div class="aspect-[4/3] overflow-hidden bg-[#f4f1ea]">
            <BytesImg bytes={n.cover} alt={n.name} class="size-full object-cover">
              <div class="grid size-full place-items-center text-[#cfc7b2]">
                <FileText size={44} />
              </div>
            </BytesImg>
          </div>
          <div class="p-2.5">
            <div class="truncate text-sm font-medium" title={n.name}>{n.name}</div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
              {#if n.chapter}
                <span class="max-w-[90px] truncate rounded-full bg-gray-100 px-1.5 py-0.5">
                  {n.chapter}
                </span>
              {/if}
              {#if n.pagenum != null}<span class="shrink-0">{n.pagenum} 页</span>{/if}
            </div>
            <div class="mt-0.5 truncate text-xs text-gray-400">
              {n.updatetime ?? n.createtime ?? ''}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>
