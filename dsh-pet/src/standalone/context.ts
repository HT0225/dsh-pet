/**
 * 独立模式的伪 Cordis 上下文 —— 让插件的**宿主半边**在 DSH 之外跑起来。
 *
 * 为什么不重写一份路由表：宿主半边（`src/host/index.ts` 的 `apply`）已经把路由表、
 * 配置聚合、状态仓、桌面 Helper 与 bridge 管道全写好了，它对外只要求一个 Cordis `ctx`。
 * 仓库自己的 `src/host/routes.test.ts` 早就用同一个手法（最小 ctx + `apply`）在 DSH 之外
 * 跑这份路由；独立模式把那套手法产品化：DSH 的服务换成"明确降级"的替身，
 * `apply` 注册的 prefix handler 接到一个真正的 `node:http` 服务器上（见 `./server`）。
 *
 * 收益：插件以后新增或修改任何端点，独立模式自动跟着变 —— 只有一份路由表，
 * 不存在"第二套实现对不上"的漂移（这正是 `routes.test.ts` 开头记的那类事故）。
 *
 * 模型后端（0.3.7+）：独立模式直接接 DeepSeek 官方 Chat Completions 流式 API，
 * provider = `deepseek-official`（余额注册表用它匹配）、model = `deepseek-flash`。
 * `agentDefaultModel.currentSelection()` 返回这一组 → 余额路由命中 deepseekOfficial（查真实余额）；
 * 碎碎念/对话的 modelCandidates 取到它 → llm.stream 翻译成 DeepSeek SSE 流（BlockAssembler 兼容）。
 * credentials.resolve 直接从环境变量 DEEPSEEK_API_KEY 给 key（与 Hermes 同一份）。
 * 仍不接入的：工作状态联动（依赖 DSH 会话事件，独立模式没有会话，状态保持空闲）。
 * 系统通知已按需求移除呈现（独立模式本无会话事件可订阅，notify 分支永远不会触发）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 独立模式下余额路由报出的服务商 id（未登记 → `unsupported`，气泡里能看到它） */
export const STANDALONE_PROVIDER = 'standalone';

/**
 * 独立模式接入的 DeepSeek 模型（余额查的就是这一家的 API Key 余额）。
 * provider id = `deepseek-official`（余额 provider 注册表用它匹配 queryBalance）；
 * model = `deepseek-flash`（官方在产模型，1M 上下文、原生视觉、思考默认开）。
 * 碎碎念 / 对话的 modelCandidates 从 currentSelection 取到这一组 → 候选链只有一条，
 * 不切换。whisperModel / chatModel 配了别的会走它的回落逻辑（配 deepseek-official
 * 就等价；配别的会因为 key 不匹配而失败回落到 currentSelection）。
 */
export const STANDALONE_MODEL = { provider: 'deepseek-official', model: 'deepseek-flash' } as const;
/** DeepSeek API base（官方在产端点；经 mihomo 代理可达） */
const DEEPSEEK_BASE = 'https://api.deepseek.com';
/** DeepSeek API key 的环境变量名（与 Hermes 的 .env 同名 = 同一份 key） */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';

/** 独立模式的日志接口（与插件对 `ctx.logger` 的使用面一致） */
export interface StandaloneLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** 插件注册到 `ctx.webServer` 的一条路由（字段原样保留，独立模式只做前缀匹配） */
export interface RegisteredRoute {
  /** `prefix`（插件当前只用这一种）或 `exact`，原样透传 */
  kind: string;
  /** 路由路径，例如 `/dsh-pet-7340`；独立模式按它做前缀匹配，不自己硬编码前缀 */
  path: string;
  /** 真实 Node HTTP handler：自己写响应头与 body（与 DSH WebServer 的契约一致） */
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

export interface StandaloneContextOptions {
  /** 插件用它拼桌面 Helper 的 `DSH_PET_CONFIG_URL`；传函数可拿到"监听后才确定"的端口 */
  port: number | (() => number);
  logger: StandaloneLogger;
  /** 注入路由收集数组（独立模式先起服务拿到端口，再 `apply`，两者共用同一个数组） */
  routes?: RegisteredRoute[];
}

export interface StandaloneContext {
  /** 交给 `apply()` 的伪 ctx */
  ctx: Record<string, unknown>;
  /** `apply()` 期间注册的路由（按注册顺序） */
  routes: RegisteredRoute[];
  /** 初始化期间被记录下来的异常（每项都已按 DSH 的 effect 隔离口径打了日志） */
  failures: string[];
  /** 释放全部 effect：停桌面 Helper、清掉周期定时器 */
  dispose(): Promise<void>;
}

/** 默认日志器：直接写控制台，格式与插件自身的 `[dsh-pet]` 前缀区分开 */
export function createStandaloneLogger(): StandaloneLogger {
  const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const write = (level: string, message: string): void => {
    console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
  };
  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === '1') write('DEBUG', message);
    },
  };
}

/**
 * 建一个独立模式的伪 ctx。
 * @param options 端口（或端口取值函数）、日志器与可选的路由收集数组
 * @returns 伪 ctx、路由列表、初始化失败记录与释放函数
 */
export function createStandaloneContext(options: StandaloneContextOptions): StandaloneContext {
  const { logger } = options;
  const routes = options.routes ?? [];
  const failures: string[] = [];
  /** effect 释放函数（后注册先释放，与 Cordis 的逆序释放一致） */
  const disposers: Array<() => unknown> = [];
  let disposed = false;

  const portOf = (): number => (typeof options.port === 'function' ? options.port() : options.port);

  const webServer = {
    /** 读取时取值：服务先监听、端口确定后才 apply，插件在 launchHelper 里读到的就是真端口 */
    get port(): number {
      return portOf();
    },
    register(spec: RegisteredRoute): () => void {
      routes.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const context: Record<string, unknown> = {
    /**
     * 与 Cordis 同语义：跑一次注册函数并收集它返回的释放函数。
     * 单项失败按 DSH 的 effect 隔离口径处理：记录 + 打日志，不让整个插件起不来
     * （源码形态下包内 assets 不可达时，正是这里会抛）。
     */
    effect(fn: () => unknown): unknown {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => unknown);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger.error(`初始化某项失败（已跳过）：${message}`);
        return undefined;
      }
    },
    /** 独立模式没有 DSH 会话事件：不订阅，工作状态保持空闲 */
    on(): () => void {
      return () => {};
    },
    logger,
    webServer,
    /**
     * 独立模式没有 DSH 的浏览器会话闸门（`./server` 只按前缀匹配路由，裸地址本来就可达），
     * 所以没有令牌可加，原样返回 baseUrl —— 与 DSH 侧 `ctx.connection.authenticatedUrl(baseUrl)`
     * （附加本进程启动令牌，供桌面 Helper 的「打开网站」用）语义对应，只是这一步在独立模式下恒等。
     */
    connection: { authenticatedUrl: (baseUrl: string): string => baseUrl },
    commands: { register: (): (() => void) => () => {} },
    agentDefaultModel: {
      // 指向 DeepSeek 官方 flash：余额 provider 注册表用 'deepseek-official' 匹配到
      // deepseekOfficial（查 https://api.deepseek.com/user/balance）；碎碎念/对话的
      // modelCandidates 用 model='deepseek-flash' 走 llm.stream 生成。
      currentSelection: (): { provider: string; model: string } => ({ ...STANDALONE_MODEL }),
    },
    credentials: {
      // 余额路由会经 credentialRef('DEEPSEEK_API_KEY') 来解析 key——DSH 里它读 .credentials.yaml，
      // 独立模式直接从环境变量给（与 Hermes 同一份 key，无需另配）。
      /**
       * DSH 凭证服务的契约：`resolve(ref) → Promise<ResolvedCredential | undefined>`，
       * 其中 `ResolvedCredential = { value: string; source: string }`——调用方（余额路由）
       * 取 `rc?.value`，返回裸字符串会被判成 undefined → credential-missing（0.3.7 踩过）。
       *
       * **读法用计算属性** `process.env[KEY]`：点号形式 `process.env.KEY` 在打包产物 / 受保护的
       * node 环境里实测返回 undefined，而计算读在 systemd 服务、sudo 脚本、测试进程三种环境
       * 都拿到真值——碎碎念的 fetch 走的正是计算读，已由真实生成实证可用。
       */
      resolve: async (ref: string): Promise<{ value: string; source: string } | undefined> => {
        if (String(ref) === DEEPSEEK_KEY_ENV) {
          const value = process.env[DEEPSEEK_KEY_ENV] ?? process.env.DEPSEEK_API_KEY;
          if (value) return { value, source: 'env' };
        }
        return undefined;
      },
    },
    llm: {
      listProviders: (): unknown[] => [{ id: STANDALONE_MODEL.provider, name: 'DeepSeek 官方' }],
      listModels: async (): Promise<unknown[]> => [{ id: STANDALONE_MODEL.model, name: 'DeepSeek Flash' }],
      /**
       * 模型元数据查询：返回 reasoningEfforts: false（独立模式不传 reasoningEffort: 'off'，
       * DeepSeek flash 走默认思考即可；省掉 supportsReasoningOff 的探测往返）。
       */
      resolveModelInfo: async (): Promise<{ reasoningEfforts: false } | undefined> => ({ reasoningEfforts: false }),
      /**
       * 生成入口：把 DSH 的 llm.stream(options) 翻译成 DeepSeek 官方 Chat Completions 流式 API。
       *
       * options 里的 messages 是 dsh-llm 的 ModelMessage[]（user/assistant 各带 content blocks）；
       * 这里拍平成 OpenAI 兼容的 [{role, content}]。system 单独传（DeepSeek 支持 system role）。
       * signal 由调用方设了超时（30s），这里尊重它（AbortController 转发）。
       *
       * yield 的 StreamChunk 形状对齐 BlockAssembler.push 的契约：
       *   block-start(text) → text-delta × N → block-end → finish(stop)
       */
      stream: (options: Record<string, unknown>): AsyncIterable<Record<string, unknown>> => {
        const opts = options as {
          model?: string;
          messages?: Array<{ role: string; content?: unknown }>;
          system?: string;
          temperature?: number;
          signal?: AbortSignal;
        };
        const messages = Array.isArray(opts.messages) ? opts.messages : [];
        // dsh-llm 的 content 是 ContentBlock[]（每块 { type: 'text', text }），拍平成纯文本
        const flat = (content: unknown): string => {
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: string }).text) : ''))
              .join('');
          }
          return '';
        };
        const chatMessages = [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          ...messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: flat(m.content),
          })),
        ];
        const body = JSON.stringify({
          model: opts.model || STANDALONE_MODEL.model,
          messages: chatMessages,
          temperature: opts.temperature ?? 1,
          stream: true,
        });
        // AsyncIterable：首次 next() 才发请求（与 DSH 的 stream 形状一致——错误落在调用方的 for-await 里）
        let started = false;
        let buffer = '';
        let done = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        return {
          [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
            return {
              async next(): Promise<IteratorResult<Record<string, unknown>>> {
                if (done) return { value: undefined, done: true };
                if (!started) {
                  started = true;
                  // DeepSeek API 经 mihomo 代理（127.0.0.1:7897）可达；环境变量 HTTPS_PROXY
                  // 由 Hermes 的 profile.d 注入，fetch 会自动读取
                  const response = await fetch(DEEPSEEK_BASE + '/chat/completions', {
                    method: 'POST',
                    headers: {
                      'content-type': 'application/json',
                      authorization: 'Bearer ' + (process.env[DEEPSEEK_KEY_ENV] ?? ''),
                    },
                    body,
                    signal: opts.signal ?? undefined,
                  });
                  if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(`DeepSeek API HTTP ${response.status}: ${errText.slice(0, 200)}`);
                  }
                  reader = response.body?.getReader() ?? null;
                  if (!reader) throw new Error('DeepSeek API 返回了空响应体');
                  // 首块前发 block-start（text 类型，index 0）
                  return {
                    value: { type: 'block-start', index: 0, blockType: 'text' },
                    done: false,
                  };
                }
                // 读 SSE 流。协议走 delta-only（BlockAssembler 明确容忍 no block-start/end）：
                //   block-start(首块) → text-delta × N → finish([DONE]/流结束)
                // **不能**在流结束时补 block-end：它带的 block 会覆盖累积的 delta（正文清空）。
                // **逐行消费**：每次只处理 buffer 里第一行，命中就返回——批量 split 后 return
                // 会把本轮未处理的行连同 buffer 一起丢掉（尾部 delta / [DONE] 丢失）。
                const nextLine = (): string | null => {
                  const nl = buffer.indexOf('\n');
                  if (nl < 0) return null;
                  const line = buffer.slice(0, nl);
                  buffer = buffer.slice(nl + 1);
                  return line;
                };
                const readChunk = async (): Promise<IteratorResult<Record<string, unknown>>> => {
                  for (;;) {
                    const line = nextLine();
                    if (line === null) {
                      // buffer 没有完整行：读新数据；流结束按 finish 收尾
                      if (!reader) {
                        done = true;
                        return { value: { type: 'finish', reason: { kind: 'stop' } }, done: false };
                      }
                      const { value: bytes, done: streamDone } = await reader.read();
                      if (streamDone) {
                        done = true;
                        return { value: { type: 'finish', reason: { kind: 'stop' } }, done: false };
                      }
                      buffer += new TextDecoder().decode(bytes);
                      continue;
                    }
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') {
                      done = true;
                      return { value: { type: 'finish', reason: { kind: 'stop' } }, done: false };
                    }
                    try {
                      const json = JSON.parse(data);
                      const delta = json?.choices?.[0]?.delta?.content;
                      // reasoning_content（思考块）/空 delta：只取真文本
                      if (typeof delta === 'string' && delta) {
                        return { value: { type: 'text-delta', index: 0, text: delta }, done: false };
                      }
                    } catch {
                      /* 单行解析失败跳过，等下一行 */
                    }
                  }
                };
                return readChunk();
              },
              async return(): Promise<IteratorResult<Record<string, unknown>>> {
                done = true;
                try {
                  await reader?.cancel();
                } catch {
                  /* 忽略取消失败 */
                }
                return { value: undefined, done: true };
              },
            };
          },
        };
      },
    },
  };

  return {
    ctx: context,
    routes,
    failures,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
