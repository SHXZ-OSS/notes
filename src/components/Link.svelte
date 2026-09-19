<script lang="ts">
  import type { Snippet } from 'svelte';
  import { navigate } from '../lib/router';

  let { to, class: cls = '', children }: { to: string; class?: string; children?: Snippet } =
    $props();
</script>

<a
  href={to}
  class={cls}
  onclick={(e) => {
    e.preventDefault();
    navigate(to);
  }}
>
  {@render children?.()}
</a>
