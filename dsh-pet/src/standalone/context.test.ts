/**
 * 伪 ctx 的语义契约测试。
 *
 * 为什么值得单独测：独立模式把插件的宿主半边（`apply`）跑在这个 ctx 上，
 * 而 `apply` 里有 9 个 effect、两条自我续期的轮询定时器，以及"最后一行才拉起桌面 Helper"
 * 的顺序依赖。这里逐条钉住 ctx 必须满足的语义（与 Cordis 对齐）与服务替身的降级口径 ——
 * 任何一条不成立，独立模式要么起不来，要么悄悄变成"能跑但没宠物"。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { modelCandidates } from '../host/model-selection.ts';
import { generateWhisper } from '../host/whisper.ts';
import { STANDALONE_MODEL, createStandaloneContext } from './context.ts';
import type { RegisteredRoute, StandaloneLogger } from './context.ts';

/** 静默日志器：测试只断言行为，不刷控制台 */
function silentLogger(): StandaloneLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => {},
    warn: () => {},
    error: (message: string) => errors.push(message),
    debug: () => {},
  };
}

type Standalone = ReturnType<typeof createStandaloneContext>;

// 伪 ctx 的成员形状各不相同（`effect`/`on` 本身是函数，其余是对象），逐个取，
// 不写笼统的索引访问 —— 形状错了希望在这里就报出来，而不是在插件里。
const effectOf = (context: Standalone): ((fn: () => unknown, label?: string) => unknown) =>
  context.ctx.effect as (fn: () => unknown, label?: string) => unknown;
const onOf = (context: Standalone): (() => unknown) => context.ctx.on as () => unknown;
const commandsOf = (context: Standalone): { register(): unknown } => context.ctx.commands as { register(): unknown };
const webServerOf = (context: Standalone): { port: number; register(spec: RegisteredRoute): unknown } =>
  context.ctx.webServer as { port: number; register(spec: RegisteredRoute): unknown };
const agentOf = (context: Standalone): { currentSelection(): { provider: string; model: string } } =>
  context.ctx.agentDefaultModel as { currentSelection(): { provider: string; model: string } };
const credentialsOf = (context: Standalone): { resolve(ref: unknown): Promise<unknown> } =>
  context.ctx.credentials as { resolve(ref: unknown): Promise<unknown> };
const llmOf = (
  context: Standalone,
): {
  listProviders(): unknown[];
  listModels(provider: string): Promise<unknown[]>;
  // 形状必须是 AsyncIterable（DSH 的 llm.stream 签名）。这里若写成 Promise，
  // 就与替身实现犯了同一个错 —— 也正是这个断言让 0.3.4 的类型检查与真实契约脱节。
  stream(options: unknown): AsyncIterable<unknown>;
} =>
  context.ctx.llm as {
    listProviders(): unknown[];
    listModels(provider: string): Promise<unknown[]>;
    stream(options: unknown): AsyncIterable<unknown>;
  };

describe('createStandaloneContext —— 与 Cordis 对齐的语义', () => {
  test('effect 同步执行、收集释放函数；dispose 逆序释放且等待异步释放', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const order: string[] = [];
    const effect = effectOf(context);
    // 同步执行：apply() 返回后路由必须已经在册（仓库自己的 routes.test.ts 也依赖这一点）
    effect(() => {
      order.push('first');
      return () => {
        order.push('dispose-first');
      };
    });
    effect(() => {
      order.push('second');
      return async () => {
        await Promise.resolve();
        order.push('dispose-second');
      };
    });
    assert.deepEqual(order, ['first', 'second'], 'effect 必须在调用时就跑');
    await context.dispose();
    assert.deepEqual(order, ['first', 'second', 'dispose-second', 'dispose-first'], '释放顺序：后注册先释放');
  });

  test('effect 内抛错只记录不中断（源码形态读不到包内 assets 时正是这里抛）', () => {
    const logger = silentLogger();
    const context = createStandaloneContext({ port: 1, logger });
    const effect = effectOf(context);
    effect(() => {
      throw new Error('内置默认配置缺失');
    });
    effect(() => 'not-a-disposer');
    assert.equal(context.failures.length, 1);
    assert.match(context.failures[0] ?? '', /内置默认配置缺失/);
    assert.match(logger.errors.join('\n'), /内置默认配置缺失/, '失败必须留日志，不能吞掉');
  });

  test('webServer.register 收下路由并返回可调用对象（插件把它当 effect 释放函数）', () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const webServer = webServerOf(context);
    const handler = (): void => {};
    const dispose = webServer.register({ kind: 'prefix', path: '/dsh-pet-7340', handler });
    assert.equal(typeof dispose, 'function');
    assert.equal(context.routes.length, 1);
    assert.equal(context.routes[0]?.path, '/dsh-pet-7340');
    assert.equal(context.routes[0]?.handler, handler);
    (dispose as () => void)();
    assert.equal(context.routes.length, 0, '释放后路由应移除');
  });

  test('webServer.port 惰性读取：先起服务、后 apply 时插件读到的是真端口', () => {
    const portRef = { value: 0 };
    const context = createStandaloneContext({ port: () => portRef.value, logger: silentLogger() });
    const webServer = webServerOf(context);
    assert.equal(webServer.port, 0, '未监听时端口就是 0（插件据此延迟重试，不会误拉窗口）');
    portRef.value = 31234;
    assert.equal(webServer.port, 31234, '监听完成后插件必须读到真实端口');
  });

  test('on() / commands.register() 必须返回可调用对象（插件把它们当释放函数用）', () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    assert.equal(typeof onOf(context)(), 'function');
    assert.equal(typeof commandsOf(context).register(), 'function');
  });
});

describe('DeepSeek flash 接入 —— 独立模式的模型/凭证/生成口径', () => {
  test('currentSelection 固定指向 deepseek-official/deepseek-flash，候选链只有这一条（不切换）', () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const selection = agentOf(context).currentSelection();
    assert.equal(selection.provider, STANDALONE_MODEL.provider);
    assert.equal(selection.model, STANDALONE_MODEL.model);
    const candidates = modelCandidates(context.ctx as never, undefined);
    assert.equal(candidates.length, 1, '不指定 preferred 时候选链只有一条 —— 结构上就不存在「切换」');
    assert.deepEqual(candidates[0], { provider: STANDALONE_MODEL.provider, model: STANDALONE_MODEL.model });
  });

  test('凭证：只认 DEEPSEEK_API_KEY 这一个 ref，返回 ResolvedCredential 契约对象（与环境变量同源）', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const credentials = credentialsOf(context);
    // 同进程、同读法（计算属性，与 resolve 内部一致）的同源断言。
    // 契约：`{ value, source }`——调用方余额路由取 `rc?.value`，返回裸字符串会被判成 undefined。
    const envValue = process.env['DEEPSEEK_API_KEY'];
    const got = (await credentials.resolve('DEEPSEEK_API_KEY')) as { value?: string; source?: string } | undefined;
    if (envValue) {
      assert.ok(got, '环境变量有值时必须解析出凭证');
      assert.equal(got.value, envValue, 'value 与环境变量同源（与 Hermes 共用一份 DeepSeek key）');
      assert.equal(got.source, 'env');
    } else {
      assert.equal(got, undefined, '环境变量没值时返回 undefined（余额据此报 credential-missing）');
    }
    assert.equal(await credentials.resolve('OTHER_REF'), undefined, '不认识的 ref 一律不给值');
  });

  test('llm 清单非空（设置页下拉有数据）；stream 是 AsyncIterable（DSH 的 llm.stream 签名）', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const llm = llmOf(context);
    assert.deepEqual(llm.listProviders(), [{ id: STANDALONE_MODEL.provider, name: 'DeepSeek 官方' }]);
    assert.deepEqual(await llm.listModels(STANDALONE_MODEL.provider), [
      { id: STANDALONE_MODEL.model, name: 'DeepSeek Flash' },
    ]);
    const streamed = llm.stream({});
    assert.equal(
      typeof streamed[Symbol.asyncIterator],
      'function',
      '必须是 AsyncIterable，不是 Promise（0.3.4 崩溃根因）',
    );
  });

  test('碎碎念走完整链：modelCandidates → llm.stream（SSE）→ BlockAssembler → 拿到真文本', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    // stub DeepSeek SSE：两条 delta + [DONE]；整段只验证「翻译层」对不对，不联网
    const originalFetch = globalThis.fetch;
    let seenBody = '';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      seenBody = String(init?.body ?? '');
      const sse = [
        'data: {"choices":[{"delta":{"content":"在想吃什么"}}]}\n',
        'data: {"choices":[{"delta":{"content":"呢～"}}]}\n',
        'data: [DONE]\n',
        '\n',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    try {
      const result = await generateWhisper(context.ctx as never, '你是一只桌宠');
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok) assert.equal(result.text, '在想吃什么呢～', '两条 text-delta 必须按序拼成正文');
    } finally {
      globalThis.fetch = originalFetch;
    }
    // 翻译层发出的请求体：模型 / system / 消息形状对（stream=true 走 SSE）
    const body = JSON.parse(seenBody) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.model, STANDALONE_MODEL.model);
    assert.equal(body.stream, true);
    assert.equal(body.messages[0]?.role, 'system');
    assert.equal(body.messages[0]?.content, '你是一只桌宠');
    assert.equal(body.messages[1]?.role, 'user');
    assert.ok(body.messages[1]?.content.length, 'user 指令不能空');
  });

  test('HTTP 失败（key 无效等）→ 结构化 generate-error，不伪造文案', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"bad key"}', { status: 401 })) as typeof fetch;
    try {
      const result = await generateWhisper(context.ctx as never, '你是一只桌宠');
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'generate-error');
      assert.match(result.message ?? '', /401/, '错误里要能看到 HTTP 状态，便于排查 key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
