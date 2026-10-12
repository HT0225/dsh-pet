/**
 * 独立模式 HTTP 服务的契约测试。
 *
 * 这一层**不碰插件**（路由注入假 handler）：它钉的是独立模式自己写的那部分 ——
 * 前缀转交、运维端点（`/`、`/health`、`/shutdown`）、异常收口、端口顺延与关闭释放。
 * 插件路由表本身的契约由 integration.test.ts 覆盖（那份是真实 apply 注册出来的）。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { RegisteredRoute, StandaloneLogger } from './context.ts';
import { createRequestListener, listenStandaloneServer } from './server.ts';

/** 静默日志器（测试只断言行为） */
const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 最小响应桩：记状态码/响应头/正文，并支持断言"已断连" */
class FakeRes {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyed = false;
  private readonly chunks: string[] = [];

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    // 与真实 ServerResponse 一致：writeHead 只覆盖同名头，先前 setHeader 设的（如 Cookie）保留
    this.headers = { ...this.headers, ...(headers ?? {}) };
    this.headersSent = true;
    return this;
  }

  /** 令牌路径会经 setHeader 下发 Cookie（writeHead 之外单独设头，与真实 ServerResponse 一致） */
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  end(chunk?: string): void {
    if (typeof chunk === 'string') this.chunks.push(chunk);
  }

  destroy(): void {
    this.destroyed = true;
  }

  body(): string {
    return this.chunks.join('');
  }
}

/** 用假 req/res 驱动监听器（不必真的起 socket）；headers 供令牌用例传 Cookie */
function call(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
): FakeRes {
  const res = new FakeRes();
  // 只给监听器真正会读的字段（method/url/headers）；其余成员本测试不触碰
  listener({ method, url, headers } as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

/** 浏览器页形态的静态目录（真实包内路径：runtime/electron-helper） */
const HELPER_WEB_ROOT = fileURLToPath(new URL('../../runtime/electron-helper/', import.meta.url));

/** 静态页读取是异步的（readFile）：等响应落定再断言，避免抢跑 */
async function settled(res: FakeRes, ms = 500): Promise<FakeRes> {
  const start = Date.now();
  while (res.status === 0 && Date.now() - start < ms) await new Promise((accept) => setTimeout(accept, 5));
  return res;
}

/** 一个"插件式"路由：handler 自己写头与 body（与 DSH WebServer 的契约一致） */
function pluginLikeRoute(onCall?: (url: string) => void): RegisteredRoute {
  return {
    kind: 'prefix',
    path: '/dsh-pet-7340',
    handler: (req, res) => {
      onCall?.(req.url ?? '');
      const payload = JSON.stringify({ ok: true, seen: req.url });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(payload);
    },
  };
}

/** 占住一个端口，返回端口号与关闭函数 */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => res.end('busy'));
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', () => accept()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((accept) => server.close(() => accept())) };
}

describe('createRequestListener —— 转交给插件路由', () => {
  test('前缀下的请求原样交给插件 handler（URL 含前缀，由插件自己切）', () => {
    let seen = '';
    const listener = createRequestListener({ routes: [pluginLikeRoute((url) => (seen = url))], logger: silent });
    const res = call(listener, '/dsh-pet-7340/config?force=1');
    assert.equal(res.status, 200);
    assert.equal(seen, '/dsh-pet-7340/config?force=1', '插件 handler 拿到的必须是完整 URL（它自己 slice 前缀）');
    assert.equal(res.body(), JSON.stringify({ ok: true, seen: '/dsh-pet-7340/config?force=1' }));
  });

  test('前缀之外 → 404，并把已注册路由列出来（"插件没注册"要能一眼看出）', () => {
    const listener = createRequestListener({ routes: [pluginLikeRoute()], logger: silent });
    const res = call(listener, '/nope');
    assert.equal(res.status, 404);
    assert.match(res.body(), /\/dsh-pet-7340/, '404 正文应带上已注册前缀');
    assert.equal(res.headers['access-control-allow-origin'], '*', '独立模式自己写的响应带跨源头');
  });

  test('kind=exact 的路由按全等匹配，不吃子路径', () => {
    const exact: RegisteredRoute = {
      kind: 'exact',
      path: '/dsh-pet-7340/state',
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('exact');
      },
    };
    const listener = createRequestListener({ routes: [exact], logger: silent });
    assert.equal(call(listener, '/dsh-pet-7340/state').body(), 'exact');
    assert.equal(call(listener, '/dsh-pet-7340/state/extra').status, 404);
  });

  test('/ 与 /health → 运维 JSON（自定义 status 提供者）', () => {
    const listener = createRequestListener({
      routes: [],
      logger: silent,
      status: () => ({ name: 'dsh-pet-standalone', port: 3080 }),
    });
    for (const path of ['/', '/health']) {
      const res = call(listener, path);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body()), { name: 'dsh-pet-standalone', port: 3080 });
      assert.equal(res.headers['access-control-allow-origin'], '*');
    }
  });

  test('OPTIONS → 204 + 跨源头，且不落到插件 handler', () => {
    let calls = 0;
    const listener = createRequestListener({
      routes: [pluginLikeRoute(() => (calls += 1))],
      logger: silent,
    });
    const res = call(listener, '/dsh-pet-7340/config', 'OPTIONS');
    assert.equal(res.status, 204);
    assert.equal(calls, 0, '预检不该进插件路由');
    assert.equal(res.headers['access-control-allow-headers'], 'content-type');
  });

  test('/shutdown → 先回 200，再触发收尾回调（调用方要能拿到响应）', async () => {
    const reasons: string[] = [];
    const listener = createRequestListener({
      routes: [pluginLikeRoute()],
      logger: silent,
      onShutdown: () => reasons.push('shutdown'),
    });
    const res = call(listener, '/shutdown', 'POST');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body()), { ok: true, stopping: true });
    assert.deepEqual(reasons, [], '回调必须排在响应之后（否则调用方可能等不到 200）');
    await new Promise((accept) => setImmediate(accept));
    assert.deepEqual(reasons, ['shutdown']);
  });
});

describe('createRequestListener —— 异常收口', () => {
  test('handler 抛错且未写头 → 500 JSON（与插件自身的 500 口径一致）', () => {
    const exploding: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: () => {
        throw new Error('读盘失败');
      },
    };
    const res = call(createRequestListener({ routes: [exploding], logger: silent }), '/dsh-pet-7340/config');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body()), { error: '读盘失败' });
  });

  test('handler 异步拒绝同样收口为 500', async () => {
    const exploding: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: async () => {
        throw new Error('异步失败');
      },
    };
    const res = call(createRequestListener({ routes: [exploding], logger: silent }), '/dsh-pet-7340/config');
    await new Promise((accept) => setImmediate(accept));
    assert.equal(res.status, 500);
    assert.match(res.body(), /异步失败/);
  });

  test('头已发出的失败：断连而不是写坏响应（与插件 sendFile 的错误口径一致）', () => {
    const partial: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('前半段');
        throw new Error('写一半炸了');
      },
    };
    const res = call(createRequestListener({ routes: [partial], logger: silent }), '/dsh-pet-7340/x');
    assert.equal(res.status, 200, '已经写出的头不改写');
    assert.equal(res.destroyed, true, '已写头之后必须断连');
  });
});

describe('listenStandaloneServer —— 端口与关闭', () => {
  const closers: Array<() => Promise<void>> = [];

  after(async () => {
    for (const close of closers.splice(0)) await close().catch(() => {});
  });

  test('首选端口被占用时向后顺延，关闭后端口真正释放', async () => {
    const blocker = await occupyPort();
    closers.push(blocker.close);
    const server = await listenStandaloneServer({ routes: [pluginLikeRoute()], logger: silent, port: blocker.port });
    closers.push(server.close);
    assert.ok(server.port > blocker.port, `期望顺延，实际 ${server.port}（被占 ${blocker.port}）`);

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { name?: string };
    assert.equal(body.name, 'dsh-pet-standalone');

    const port = server.port;
    await server.close();
    // 关闭必须释放端口：再用同一个端口起一个服务应成功（keep-alive 连接没被断掉的话这里会 EADDRINUSE）
    const reuse = createServer((_req, res) => res.end('reused'));
    await new Promise<void>((accept, reject) => {
      reuse.once('error', reject);
      reuse.listen(port, '127.0.0.1', () => accept());
    });
    await new Promise<void>((accept) => reuse.close(() => accept()));
  });

  test('插件路由经真实 HTTP 可用（前缀下 200，前缀外 404）', async () => {
    const server = await listenStandaloneServer({ routes: [pluginLikeRoute()], logger: silent, port: 0 });
    closers.push(server.close);
    const inside = await fetch(`http://127.0.0.1:${server.port}/dsh-pet-7340/state`);
    assert.equal(inside.status, 200);
    const outside = await fetch(`http://127.0.0.1:${server.port}/whatever`);
    assert.equal(outside.status, 404);
  });
});

describe('浏览器页形态 —— /pet 托管（同一份 runtime/electron-helper）', () => {
  test('/pet 无尾斜杠 → 302 到 /pet/（保留 query；否则页面里的 ./xxx.js 会解析到根目录）', () => {
    const listener = createRequestListener({ routes: [], logger: silent, webRoot: HELPER_WEB_ROOT });
    const res = call(listener, '/pet');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/pet/');
    const withToken = call(listener, '/pet?token=abc');
    assert.equal(withToken.status, 302);
    assert.equal(withToken.headers.location, '/pet/?token=abc', '重定向后 ?token= 仍要有效');
  });

  test('/pet/ → index.html；/pet/<名字> → 脚本（内容类型按白名单）', async () => {
    const listener = createRequestListener({ routes: [], logger: silent, webRoot: HELPER_WEB_ROOT });
    const page = await settled(call(listener, '/pet/'));
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    const script = await settled(call(listener, '/pet/sprite.js'));
    assert.equal(script.status, 200);
    assert.match(String(script.headers['content-type']), /javascript/);
  });

  test('白名单之外一律 404（目录穿越与任意文件都不放行）', () => {
    const listener = createRequestListener({ routes: [], logger: silent, webRoot: HELPER_WEB_ROOT });
    for (const path of [
      '/pet/main.js',
      '/pet/preload.js',
      '/pet/%2e%2e%2fpackage.json',
      '/pet/../package.json',
      '/dsh-pet-7340/config',
    ]) {
      const res = call(listener, path);
      assert.equal(res.status, 404, path);
    }
  });

  test('未启用浏览器页（webRoot 缺省）时 /pet 不额外挂载 → 落回 404', () => {
    const listener = createRequestListener({ routes: [], logger: silent });
    assert.equal(call(listener, '/pet/').status, 404);
  });
});

describe('访问令牌 —— 对外监听的兜底鉴权', () => {
  const guarded = (token: string, calls?: { n: number }) =>
    createRequestListener({
      routes: [pluginLikeRoute(() => (calls ? (calls.n += 1) : undefined))],
      logger: silent,
      token,
    });

  test('既无 query 也无 Cookie → 401，且不进插件 handler', () => {
    const calls = { n: 0 };
    const res = call(guarded('sek', calls), '/dsh-pet-7340/config');
    assert.equal(res.status, 401);
    assert.equal(calls.n, 0, '未通过鉴权不得进业务路由');
  });

  test('?token= 命中 → 放行并下发 Cookie（页面内后续请求靠它通行）', () => {
    const res = call(guarded('sek'), '/dsh-pet-7340/config?token=sek');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['set-cookie']), /dsh_pet_token=sek/);
  });

  test('Cookie 命中 → 放行（静态资源与 API 请求都不带 query）', () => {
    const res = call(guarded('sek'), '/dsh-pet-7340/config', 'GET', { cookie: 'a=1; dsh_pet_token=sek; b=2' });
    assert.equal(res.status, 200);
  });

  test('令牌错误 → 401（query 与 Cookie 都错时不得放行）', () => {
    assert.equal(call(guarded('sek'), '/dsh-pet-7340/config?token=bad').status, 401);
    assert.equal(call(guarded('sek'), '/dsh-pet-7340/config', 'GET', { cookie: 'dsh_pet_token=bad' }).status, 401);
  });

  test('令牌同样罩住运维端点与 /shutdown（否则等于留了后门）', () => {
    assert.equal(call(guarded('sek'), '/health').status, 401);
    assert.equal(call(guarded('sek'), '/shutdown', 'POST').status, 401);
  });

  test('token=null（默认回环自用）不鉴权——既有行为零变化', () => {
    const listener = createRequestListener({ routes: [pluginLikeRoute()], logger: silent });
    assert.equal(call(listener, '/dsh-pet-7340/config').status, 200);
  });
});
