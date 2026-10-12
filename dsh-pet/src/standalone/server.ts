/**
 * 独立模式的 HTTP 监听器：接管 DSH WebServer 原本扮演的角色。
 *
 * 这里**没有路由表** —— 路由表属于插件自己的宿主半边（`apply` 注册在 `ctx.webServer` 上的
 * prefix handler，见 `./context`）。本模块只做几件事：
 *   1. 绑定监听地址（默认 127.0.0.1，端口被占用则顺延；浏览器页形态用 0.0.0.0）；
 *   2. 把落在插件路由前缀上的请求原样交给那份 handler（它自己写响应头与 body）；
 *   3. 提供 `/` 与 `/health`（运维信息）和 `/shutdown`（脚本化停机）；
 *   4. 浏览器页形态下托管 `/pet`（runtime/electron-helper 的 index.html 与 4 个脚本）；
 *   5. 对外监听时可按令牌（`?token=` / Cookie）做兜底鉴权；
 *   6. 兜住 handler 的异常，按插件自身的口径回 500 JSON。
 *
 * 为什么这里不补 `Access-Control-Allow-Origin`：独立模式的桌面渲染端经 bridge 管道
 * 取数据（不是 HTTP 跨源请求），CORS 对它无意义；而由本服务直接写的响应（`/`、`/shutdown`、
 * 未匹配路由）都带上了跨源头，供浏览器/第三方工具直接消费。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RegisteredRoute, StandaloneLogger } from './context';

/** 独立模式默认端口（与插件 helper 的内置默认一致） */
export const DEFAULT_STANDALONE_PORT = 3080;
/** 端口被占用时向后顺延的个数上限 */
export const PORT_SCAN_LIMIT = 25;

export interface StandaloneServerOptions {
  /** 插件注册的路由（与 `createStandaloneContext` 共用同一个数组） */
  routes: RegisteredRoute[];
  logger: StandaloneLogger;
  /** 首选端口，默认 {@link DEFAULT_STANDALONE_PORT} */
  port?: number;
  /** 监听地址，默认 `127.0.0.1`（只对本机开放）；浏览器页形态用 `0.0.0.0` */
  host?: string;
  /** 访问令牌：非 null 时所有请求须带 `?token=` 或同名 Cookie（对外监听的兜底鉴权） */
  token?: string | null;
  /** 浏览器页形态：桌面渲染端静态资源目录（runtime/electron-helper）；null = 不提供 /pet 页 */
  webRoot?: string | null;
  /** `/` 与 `/health` 的运维信息提供者 */
  status?: () => unknown;
  /** `/shutdown` 被请求时通知调用方收尾（独立模式的脚本化停机） */
  onShutdown?: () => void;
}

export interface StandaloneServer {
  /** 实际监听的端口（首选端口被占用时会大于请求值） */
  port: number;
  /** 实际绑定的地址（回显给用户拼访问 URL） */
  host: string;
  close(): Promise<void>;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

/** 只取 pathname（不解码，避免 %2F 一类输入在校验之前被改写）；非法 URL 落回 '/' */
function pathnameOf(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
    ...headers,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

/** handler 抛错时的收口：头已发出就断连（与插件 sendFile 的错误口径一致），否则 500 JSON */
function fail(res: ServerResponse, error: unknown, logger: StandaloneLogger): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`路由处理异常：${message}`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, 500, { error: message });
}

/** 浏览器页形态可托管的桌面渲染端文件白名单（固定名单，杜绝路径穿越） */
const WEB_FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'shared-core.js': 'text/javascript; charset=utf-8',
  'constants.js': 'text/javascript; charset=utf-8',
  'sprite.js': 'text/javascript; charset=utf-8',
  'events.js': 'text/javascript; charset=utf-8',
  'renderer.js': 'text/javascript; charset=utf-8',
};

/** 从 Cookie 头里取指定名（无则 null） */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * 建一个请求监听器（导出以便单测直接驱动，不必真的起 socket）。
 *
 * 浏览器页形态（`webRoot` 非空）下额外挂两条：
 *   - `/pet` / `/pet/<白名单文件>`：托管桌面渲染端页面（index.html 与它的 4 个脚本），
 *     使同一份渲染代码在普通浏览器里跑（无 petBridge → 渲染端按「整页 = 视口」摆位）；
 *   - 令牌鉴定（`token` 非空时）：`?token=` 命中则下发 Cookie（后续静态资源与 API 请求
 *     都不带 query，只能靠 Cookie 通行），Cookie 命中即放行；两者都不中 → 401。
 */
export function createRequestListener(
  options: StandaloneServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { routes, logger, status, onShutdown, token = null, webRoot = null } = options;
  return (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = pathnameOf(req.url);
    logger.debug(`${method} ${pathname}`);

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // 令牌鉴定：query 命中 → 下发 Cookie（页面内后续请求不带 query）；Cookie 命中 → 放行
    if (token !== null) {
      let queryToken: string | null = null;
      try {
        queryToken = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
      } catch {
        /* 非法 URL 落到下面的判定 */
      }
      const hit = queryToken === token || readCookie(req.headers.cookie, 'dsh_pet_token') === token;
      if (!hit) {
        sendJson(res, 401, { error: '令牌缺失或错误', hint: '访问带 ?token=… 的地址（会写入 Cookie 供后续请求使用）' });
        return;
      }
      if (queryToken === token) {
        // HttpOnly：页面脚本无需读它，只是让静态资源 / API / 素材请求自带通行证
        res.setHeader('set-cookie', `dsh_pet_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
      }
    }

    // 浏览器页形态：托管桌面渲染端（同一份 runtime/electron-helper 源码）
    if (webRoot !== null && (pathname === '/pet' || pathname.startsWith('/pet/'))) {
      // 无尾斜杠时页面里的 ./xxx.js 会解析到根目录 → 统一重定向到 /pet/（保留 query：
      // ?token= 要在重定向后仍然有效，不能只依赖 Cookie）
      if (pathname === '/pet') {
        const raw = req.url ?? '';
        const mark = raw.indexOf('?');
        const search = mark >= 0 ? raw.slice(mark) : '';
        res.writeHead(302, { location: `/pet/${search}`, ...CORS_HEADERS });
        res.end();
        return;
      }
      const name = pathname === '/pet/' ? 'index.html' : pathname.slice('/pet/'.length);
      const type = WEB_FILES[name];
      if (type === undefined) {
        sendText(res, 404, `dsh-pet: 浏览器页只托管 ${Object.keys(WEB_FILES).join(' / ')}`);
        return;
      }
      readFile(join(webRoot, name))
        .then((buf) => {
          res.writeHead(200, {
            'content-type': type,
            'content-length': buf.byteLength,
            'cache-control': 'no-store',
            ...CORS_HEADERS,
          });
          res.end(buf);
        })
        .catch((error: unknown) => fail(res, error, logger));
      return;
    }

    if (pathname === '/' || pathname === '/health') {
      sendJson(res, 200, status?.() ?? { name: 'dsh-pet-standalone' });
      return;
    }
    if (pathname === '/shutdown') {
      // 先回话再收尾：调用方要能拿到 200，而不是被自己的停机动作打断
      sendJson(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => onShutdown?.());
      return;
    }

    const route = routes.find((candidate) => matches(candidate, pathname));
    if (route === undefined) {
      sendText(
        res,
        404,
        `dsh-pet-standalone: 没有匹配的路由（已注册：${routes.map((item) => item.path).join(', ') || '无'}）`,
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, logger));
    } catch (error) {
      fail(res, error, logger);
    }
  };
}

/** 从 preferred 起找一个能绑上的端口；`preferred = 0` 表示交给系统分配 */
async function bindFirstFree(
  server: HttpServer,
  preferred: number,
  host: string,
  logger: StandaloneLogger,
): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) {
    try {
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      // 真实端口必须回读 address()：传 0 时监听端口由系统分配，不等于请求值
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}

/**
 * 起独立模式服务。
 * @param options 路由、日志器、首选端口/地址、令牌与运维回调
 * @returns 实际端口/地址与关闭函数
 */
export async function listenStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const server = createServer(createRequestListener(options));
  // 客户端半截请求（扫描器、被中断的连接）不该变成未捕获异常刷屏
  server.on('clientError', (_error, socket) => socket.destroy());
  const host = options.host ?? '127.0.0.1';
  const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, host, options.logger);
  options.logger.info(`独立模式服务已监听 http://${host}:${port}/`);
  return {
    port,
    host,
    async close(): Promise<void> {
      // keep-alive 连接会让 close() 一直等：先断开全部连接再关（脚本化停机不能挂住）
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
