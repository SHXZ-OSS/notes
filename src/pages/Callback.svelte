<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Spinner } from 'kampsy-ui';
  import { finishCallback } from '../api/auth';
  import { SS_FROM } from '../config';
  import { navigate } from '../lib/router';

  let error = $state<string | null>(null);
  let ran = false;

  onMount(() => {
    if (ran) return;
    ran = true;
    const from = sessionStorage.getItem(SS_FROM) ?? '/';
    sessionStorage.removeItem(SS_FROM);
    finishCallback(window.location.search)
      .then(() => navigate(from, true))
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
      });
  });
</script>

<div class="grid min-h-[80vh] place-items-center p-4">
  {#if error}
    <div class="max-w-md text-center">
      <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
        登录失败：{error}
      </div>
      <p class="mt-3 text-sm text-gray-500">
        如果反复失败，请联系管理员。
      </p>
      <Button variant="secondary" class="mt-4" onclick={() => navigate('/login')}>
        返回登录
      </Button>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-3">
      <Spinner size={28} />
      <div class="text-sm text-gray-500">正在完成登录…</div>
    </div>
  {/if}
</div>
