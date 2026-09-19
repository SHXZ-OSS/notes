<script lang="ts">
  import { LogIn, PenLine } from '@lucide/svelte';
  import { Button } from 'kampsy-ui';
  import { auth, login } from '../api/auth';

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function doLogin(): Promise<void> {
    error = null;
    busy = true;
    try {
      await login();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      busy = false;
    }
  }
</script>

<div class="grid min-h-screen place-items-center p-4">
  <div class="w-full max-w-[420px] rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
    <div class="mb-6 flex flex-col items-center gap-2 text-center">
      <span class="grid size-12 place-items-center rounded-xl bg-gray-900 text-white">
        <PenLine size={26} />
      </span>
      <h1 class="text-xl font-semibold">笔记</h1>
      <p class="text-sm text-gray-500">在浏览器中浏览与预览同步的笔记</p>
    </div>

    {#if error}
      <div class="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
        {error}
      </div>
    {/if}

    <Button
      class="w-full"
      size="large"
      loading={busy}
      disabled={busy || !$auth.ready}
      onclick={() => void doLogin()}
    >
      {#snippet prefix()}<LogIn size={16} />{/snippet}
      使用上海市行知中学统一认证登录
    </Button>
  </div>
</div>
