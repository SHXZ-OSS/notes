<script lang="ts">
  import type { Snippet } from 'svelte';
  import { isImageBytes } from '../lib/jser';

  let {
    bytes,
    alt = '',
    class: cls = '',
    children,
  }: { bytes?: Uint8Array | null; alt?: string; class?: string; children?: Snippet } = $props();

  let url = $derived.by(() => {
    if (!bytes || !isImageBytes(bytes)) return null;
    // 拷贝避免 detached buffer
    return URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer as ArrayBuffer]));
  });

  $effect(() => {
    if (url) return () => URL.revokeObjectURL(url);
  });
</script>

{#if url}
  <img src={url} {alt} loading="lazy" class={cls} />
{:else}
  {@render children?.()}
{/if}
