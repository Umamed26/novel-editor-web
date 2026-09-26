/**
 * 墨匣 · Service Worker（手写实现，零依赖，不使用 workbox）
 *
 * ── 职责边界（重要）──────────────────────────────────────────────
 * 本应用是「本地优先」的写作编辑器：所有稿件数据（书籍、卷章正文、
 * 大纲、人物、设定、时间线……）全部存放在浏览器 IndexedDB 中，读写
 * 全程不经过网络请求。
 *
 * 因此本 Service Worker 只负责一件事：让「应用外壳」（HTML / JS /
 * CSS / 图标等静态资源）在离线时依然能打开。
 * 它不缓存、不读取、不改写、也从不触碰任何稿件数据；所有非 GET 请求
 * 与跨源请求一律直接放行，交给浏览器按默认行为处理。
 * ────────────────────────────────────────────────────────────────
 */

/** 缓存版本号：改动外壳资源或缓存策略时递增，旧缓存会在 activate 阶段被清理 */
const CACHE_VERSION = 'mohe-shell-v1';

/** 缓存名前缀：只清理自己创建的缓存，不误删同源下其它应用的缓存 */
const CACHE_PREFIX = 'mohe-shell-';

/**
 * 部署基路径：**从注册作用域推**（`self.registration.scope`），不写死 '/'。
 * 同一份 sw.js 因此既能服务根路径部署（scope = '/'），也能服务子路径部署
 * （例如 GitHub Pages 的 '/novel-editor/'）—— 写死会让预缓存列表里的
 * `/index.html` 全部 404，离线能力静默失效。
 */
const BASE = (() => {
  try {
    return new URL(self.registration.scope).pathname;
  } catch {
    return '/';
  }
})();

/** 把站内绝对路径拼成"带基路径"的 URL；已经是完整 URL 的原样返回 */
function withBase(path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${BASE.replace(/\/$/, '')}${path}`;
}

/** Service Worker 脚本自身的路径：它必须始终走网络，否则无法自我更新 */
const SW_PATH = self.location.pathname;

/** 应用外壳基础资源：安装时预缓存 */
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon.svg',
].map(withBase);

/** 可走 cache-first + 后台回填（stale-while-revalidate）的静态资源后缀 */
const STATIC_EXTENSIONS = [
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.woff2',
  '.woff',
  '.ttf',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
  '.avif',
];

/**
 * 缓存查找选项：忽略 Vary。
 * 静态服务器（含 `vite preview`）常给响应加上 `Vary: Origin`，而入口 HTML、
 * 模块脚本等请求是否携带 Origin 头各不相同（`<script crossorigin>` 就带），
 * 严格按 Vary 比对会导致明明缓存过却匹配失败、离线时白白回退到 504。
 * 这里始终按 URL 精确匹配，不参与 Vary 协商。
 */
const MATCH_OPTIONS = { ignoreVary: true };

/** 离线且缓存里连外壳都没有时的兜底页面（正常情况不会出现） */
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>墨匣 · 离线</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #131922; color: #41a7a5;
         font-family: Songti SC, Noto Serif SC, serif; }
  p { opacity: .85; }
</style></head>
<body><div><h1>墨匣</h1><p>应用外壳尚未缓存完成，请联网后重新打开一次。</p></div></body></html>`;

/* ────────────────────────────── 安装 ────────────────────────────── */

self.addEventListener('install', (event) => {
  event.waitUntil(installCache());
});

/** 安装阶段：预缓存应用外壳，并立刻激活新版本 */
async function installCache() {
  const cache = await caches.open(CACHE_VERSION);

  // 先用 addAll 批量预缓存。addAll 是「全有或全无」的：任何一个资源失败都会
  // 整体 reject，所以失败后退化为逐个 add，保证单个资源失败不会让 install 失败。
  try {
    await cache.addAll(CORE_ASSETS);
  } catch (error) {
    console.warn('[SW] 外壳资源批量预缓存失败，改为逐个缓存：', error);
    await Promise.all(CORE_ASSETS.map((url) => addOne(cache, url)));
  }

  // 生产构建的 JS / CSS 带内容哈希文件名，无法写死在上面的列表里，
  // 因此安装时从 index.html 中解析出 /assets/ 下的资源一并预缓存，
  // 这样首次打开后即使马上断网，刷新也能完整加载出界面。
  await precacheBuildAssets(cache);

  // 新版本立即进入 waiting → activating，不阻塞在旧版本后面
  await self.skipWaiting();
}

/** 逐个缓存单个资源，失败只告警、不抛出（install 不因单个 404 而失败） */
async function addOne(cache, url) {
  try {
    // cache: 'reload' 绕过 HTTP 缓存，确保拿到构建后的最新副本
    await cache.add(new Request(url, { cache: 'reload' }));
  } catch (error) {
    console.warn('[SW] 资源预缓存失败（已跳过）：', url, error);
  }
}

/** 从 index.html 里解析出构建产物（/assets/**）并预缓存 */
async function precacheBuildAssets(cache) {
  let html = '';
  try {
    const response = await fetch(withBase('/index.html'), { cache: 'reload' });
    if (!response.ok) return;
    html = await response.text();
  } catch (error) {
    console.warn('[SW] 读取 index.html 失败，跳过构建产物预缓存：', error);
    return;
  }

  const assetUrls = new Set();
  const attributePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let match = attributePattern.exec(html);
  while (match !== null) {
    const value = match[1];
    if (value.includes('/assets/')) assetUrls.add(value);
    match = attributePattern.exec(html);
  }

  await Promise.all([...assetUrls].map((url) => addOne(cache, url)));
}

/* ────────────────────────────── 激活 ────────────────────────────── */

self.addEventListener('activate', (event) => {
  event.waitUntil(activateCleanup());
});

/** 激活阶段：清理旧版本缓存，并立刻接管所有已打开的页面 */
async function activateCleanup() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
      .map((key) => caches.delete(key)),
  );

  // 让当前已打开的页面立即受本 SW 控制，无需等下一次刷新
  await self.clients.claim();
}

/* ───────────────────────────── 请求拦截 ───────────────────────────── */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 1) 非 GET 请求一律放行：稿件数据的写入只发生在 IndexedDB，与网络无关
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 2) 跨源请求（字体 CDN、外链图片等）一律放行，不拦截也不缓存
  if (url.origin !== self.location.origin) return;

  // 3) Service Worker 自身放行，避免被自己缓存导致无法更新
  if (url.pathname === SW_PATH) return;

  // 4) 导航请求：network-first，离线回退缓存中的应用外壳（保证离线可打开）
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // 5) 同源静态资源：cache-first + 后台回填（stale-while-revalidate）
  if (isStaticAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, event));
    return;
  }

  // 6) 其余同源请求（未知路径、未来的数据接口等）直接放行，不缓存
});

/** 判断是否为需要缓存的静态资源 */
function isStaticAsset(pathname) {
  if (pathname.includes('/assets/')) return true;
  return STATIC_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

/**
 * 导航请求：网络优先。
 * 在线时用最新外壳并顺带更新缓存副本；离线/请求失败时回退到缓存里的
 * /index.html，这样断网刷新也能正常进入应用界面。
 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      // 后台刷新外壳副本，失败不影响本次响应
      cache.put(withBase('/index.html'), response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    // 离线：回退到缓存里的应用外壳（匹配时忽略 Vary，见 MATCH_OPTIONS）
    const cached =
      (await cache.match(withBase('/index.html'), MATCH_OPTIONS)) ??
      (await cache.match(withBase('/'), MATCH_OPTIONS));
    if (cached) return cached;
    return new Response(OFFLINE_FALLBACK_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/**
 * 静态资源：cache-first + 后台回填。
 * 命中缓存即刻返回（快、且离线可用），同时发起网络请求更新缓存副本。
 */
function staleWhileRevalidate(request, event) {
  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  // 用 waitUntil 声明「后台回填」这份工作，避免响应返回后 SW 被提前回收
  event.waitUntil(networkPromise);

  return (async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request, MATCH_OPTIONS);
    if (cached) return cached;

    const fresh = await networkPromise;
    if (fresh) return fresh;

    // 既无缓存又无网络
    return new Response('', { status: 504, statusText: 'Offline' });
  })();
}
