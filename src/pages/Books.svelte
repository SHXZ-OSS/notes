<script lang="ts">
  import { BookText, FileText } from '@lucide/svelte';
  import { Button } from 'kampsy-ui';
  import { notesStore } from '../lib/notes';
  import { navigate } from '../lib/router';
  import BytesImg from '../components/BytesImg.svelte';

  const idx = $derived($notesStore);

  const books = $derived.by(() => {
    void idx.version;
    return [...notesStore.books.values()].sort((a, b) =>
      (b.updatetime ?? '').localeCompare(a.updatetime ?? ''),
    );
  });

  const loose = $derived.by(() => {
    void idx.version;
    const known = new Set(notesStore.books.keys());
    return [...notesStore.notes.values()].filter((n) => !known.has(n.bookid));
  });
</script>

<div class="space-y-4">
  <h2 class="text-base font-semibold">笔记</h2>

  {#if idx.status === 'error'}
    <div class="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
      <span>索引失败：{idx.error}</span>
      <Button size="small" variant="secondary" onclick={() => void notesStore.load()}>重试</Button>
    </div>
  {/if}

  {#if books.length === 0 && loose.length === 0}
    <div class="py-8 text-center text-sm text-gray-500">
      {idx.status === 'loading' ? '加载中…' : '还没有同步的笔记本。'}
    </div>
  {:else}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      <button
        type="button"
        class="overflow-hidden rounded-lg border border-gray-200 bg-white text-left transition-shadow hover:shadow-md"
        onclick={() => navigate('/notes')}
      >
        <div class="aspect-[4/3] bg-gray-50">
          <div class="grid size-full place-items-center text-gray-300">
            <FileText size={48} />
          </div>
        </div>
        <div class="p-2.5">
          <div class="text-sm font-medium">所有笔记</div>
          <div class="mt-1 text-xs text-gray-500">
            {idx.counts.notes} 篇
          </div>
        </div>
      </button>
      {#each books as b (b.bookid)}
        <button
          type="button"
          class="overflow-hidden rounded-lg border border-gray-200 bg-white text-left transition-shadow hover:shadow-md"
          onclick={() => navigate(`/notes?book=${b.bookid}`)}
        >
          <div class="aspect-[4/3] overflow-hidden bg-gray-100">
            <BytesImg bytes={b.cover} alt={b.name} class="size-full object-cover">
              <div class="grid size-full place-items-center text-gray-300">
                <BookText size={48} />
              </div>
            </BytesImg>
          </div>
          <div class="p-2.5">
            <div class="truncate text-sm font-medium" title={b.name}>{b.name}</div>
            <div class="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
              <span class="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5">
                {b.notenum ?? notesStore.notesOfBook(b.bookid).length} 篇
              </span>
              <span class="truncate">{b.updatetime ?? b.createtime ?? ''}</span>
            </div>
          </div>
        </button>
      {/each}
      {#if loose.length > 0}
        <button
          type="button"
          class="overflow-hidden rounded-lg border border-gray-200 bg-white text-left transition-shadow hover:shadow-md"
          onclick={() => navigate('/notes?loose=1')}
        >
          <div class="aspect-[4/3] bg-gray-100">
            <div class="grid size-full place-items-center text-gray-300"><BookText size={48} /></div>
          </div>
          <div class="p-2.5">
            <div class="text-sm font-medium">未分类</div>
            <div class="mt-1 text-xs text-gray-500">{loose.length} 篇</div>
          </div>
        </button>
      {/if}
    </div>
  {/if}
</div>
