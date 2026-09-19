<script lang="ts">
  import { onMount } from 'svelte';
  import {
    BookText,
    PenLine,
    RefreshCw,
    Settings as SettingsIcon,
  } from '@lucide/svelte';
  import { Button, Spinner } from 'kampsy-ui';
  import { route, navigate } from './lib/router';
  import { auth, initAuth, userName } from './api/auth';
  import { notesStore } from './lib/notes';
  import { SS_FROM } from './config';
  import Login from './pages/Login.svelte';
  import Callback from './pages/Callback.svelte';
  import Books from './pages/Books.svelte';
  import Notes from './pages/Notes.svelte';
  import NoteDetail from './pages/NoteDetail.svelte';
  import Settings from './pages/Settings.svelte';

  const noteId = $derived($route.path.match(/^\/notes\/(\d+)$/)?.[1] ?? null);
  const idx = $derived($notesStore);
  const progress = $derived(
    idx.status === 'loading' && idx.found.pages > 0 ? (idx.counts.pages / idx.found.pages) * 100 : null,
  );

  const NAV = [
    { to: '/', label: '笔记', icon: BookText },
    { to: '/settings', label: '设置', icon: SettingsIcon },
  ];

  onMount(() => {
    void initAuth();
  });

  $effect(() => {
    if ($auth.authed && idx.status === 'idle') void notesStore.load();
  });

  $effect(() => {
    if (!$auth.ready) return;
    const p = $route.path;
    if (!$auth.authed && p !== '/login' && p !== '/callback') {
      sessionStorage.setItem(SS_FROM, p + ($route.query.size ? `?${$route.query}` : ''));
      navigate('/login', true);
    } else if ($auth.authed && p === '/login') {
      navigate('/', true);
    }
  });

  function isActive(to: string, path: string): boolean {
    return to === '/' ? path === '/' : path.startsWith(to);
  }

  function navCls(active: boolean): string {
    return active ? 'bg-gray-100 font-medium text-gray-900' : 'text-gray-600 hover:bg-gray-50';
  }
</script>

{#if !$auth.ready}
  <div class="grid min-h-screen place-items-center">
    <div class="flex flex-col items-center gap-3">
      <Spinner size={26} />
      <div class="text-sm text-gray-500">加载中…</div>
    </div>
  </div>
{:else if $route.path === '/login'}
  <Login />
{:else if $route.path === '/callback'}
  <Callback />
{:else if !$auth.authed}
  <div class="grid min-h-screen place-items-center">
    <div class="text-sm text-gray-500">正在检查登录状态…</div>
  </div>
{:else}
  <div class="min-h-screen">
    <header
      class="sticky top-0 z-40 flex h-12 items-center gap-0.5 border-b border-gray-200 bg-white px-2 md:hidden"
    >
      <div class="mr-1 flex items-center gap-1.5 pl-1">
        <span class="grid size-6 place-items-center rounded-md bg-gray-900 text-white">
          <PenLine size={14} />
        </span>
        <span class="text-sm font-semibold">笔记</span>
      </div>
      <div class="flex-1"></div>
      {#each NAV as n (n.to)}
        <button
          type="button"
          title={n.label}
          class="grid size-9 place-items-center rounded-md transition-colors {isActive(n.to, $route.path)
            ? 'text-gray-900'
            : 'text-gray-500 hover:bg-gray-100'}"
          onclick={() => navigate(n.to)}
        >
          <n.icon size={18} />
        </button>
      {/each}
      <button
        type="button"
        title="重新索引"
        class="grid size-9 place-items-center rounded-md text-gray-500 hover:bg-gray-100"
        disabled={idx.status === 'loading'}
        onclick={() => void notesStore.load()}
      >
        <RefreshCw size={16} />
      </button>
    </header>

    <aside
      class="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-gray-200 bg-white md:flex"
    >
      <div class="flex h-14 shrink-0 items-center gap-2 px-4">
        <span class="grid size-7 place-items-center rounded-lg bg-gray-900 text-white">
          <PenLine size={16} />
        </span>
        <span class="text-[15px] font-semibold tracking-wide">笔记</span>
      </div>
      <div class="mx-4 h-px bg-gray-200"></div>
      <div
        class="h-0.5 shrink-0 bg-gray-900 transition-all duration-300"
        style={progress != null ? `width:${Math.max(4, progress)}%` : 'width:0'}
      ></div>
      <nav class="flex-1 space-y-0.5 overflow-y-auto p-3">
        {#each NAV as n (n.to)}
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors {navCls(
              isActive(n.to, $route.path),
            )}"
            onclick={() => navigate(n.to)}
          >
            <n.icon size={16} />
            {n.label}
          </button>
        {/each}
      </nav>
      <div class="space-y-2 border-t border-gray-200 p-3">
        <div class="flex items-center justify-between px-1 text-xs text-gray-500">
          <span>{idx.counts.notes} 笔记 / {idx.counts.pages} 页</span>
          <button
            type="button"
            title="重新索引"
            class="grid size-6 place-items-center rounded hover:bg-gray-100 disabled:opacity-40"
            disabled={idx.status === 'loading'}
            onclick={() => void notesStore.load()}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div class="flex items-center gap-2 rounded-md bg-gray-50 px-2.5 py-2">
          <span
            class="grid size-6 shrink-0 place-items-center rounded-full bg-gray-200 text-[11px] font-medium text-gray-700"
          >
            {(userName($auth.user) || '已')[0]}
          </span>
          <span class="min-w-0 truncate text-xs text-gray-600">
            {userName($auth.user) || '已登录'}
          </span>
        </div>
      </div>
    </aside>

    <div class="md:pl-60">
      <main class="mx-auto w-full max-w-[1080px] px-4 py-6 md:px-8">
        {#if $route.path === '/'}
          <Books />
        {:else if $route.path === '/notes'}
          <Notes query={$route.query} />
        {:else if noteId}
          {#key noteId}
            <NoteDetail noteid={noteId} />
          {/key}
        {:else if $route.path === '/settings'}
          <Settings />
        {:else}
          <div class="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <div class="mb-1 text-sm text-gray-500">页面不存在</div>
            <Button variant="secondary" size="small" onclick={() => navigate('/')}>
              回笔记本
            </Button>
          </div>
        {/if}
      </main>
    </div>
  </div>
{/if}
