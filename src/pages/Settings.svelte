<script lang="ts">
  import { LogOut } from '@lucide/svelte';
  import { Button } from 'kampsy-ui';
  import { logout } from '../api/auth';
  import { navigate } from '../lib/router';

  function logoutAndGo(): void {
    void logout().then(() => navigate('/login'));
  }
</script>

<div class="max-w-[640px] space-y-5">
  <h2 class="text-base font-semibold">设置</h2>

  <div class="rounded-lg border border-gray-200 bg-white p-4">
    <Button variant="secondary" onclick={logoutAndGo}>
      {#snippet prefix()}<LogOut size={14} />{/snippet}
      退出登录
    </Button>
  </div>
</div>
