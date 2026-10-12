/**
 * shim 的单测 —— 为什么必须有：`@deepseek-ai/dsh-llm` 在 standalone 构建里被 alias 到本文件，
 * 而 src 下的测试直跑**不走 alias**（真包）。真包与 shim 契约不一致时，全部既有测试
 * 依然全绿，只有打包产物（服务）会坏 —— 0.3.7 的「模型未返回文本」正是这样逃逸的。
 * 这里直接对 shim 断言，让 alias 路径也有自己的红灯。
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from './shims/dsh-llm.ts';

describe('shim BlockAssembler —— 必须与真包 StreamChunk 契约同形', () => {
  test('流协议：block-start → text-delta × N → finish 拼出正文，finish 收到 reason', () => {
    const assembler = new BlockAssembler();
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' });
    assembler.push({ type: 'text-delta', index: 0, text: '今天' });
    assembler.push({ type: 'text-delta', index: 0, text: '也想被你摸摸头' });
    assembler.push({ type: 'finish', reason: { kind: 'stop' } });
    assert.deepEqual(assembler.blocks(), [{ type: 'text', text: '今天也想被你摸摸头' }]);
    assert.deepEqual(assembler.finish, { kind: 'stop' });
  });

  test('旧契约（完整文本块）仍兼容；空流返回空块列表、finish 为 undefined', () => {
    const assembler = new BlockAssembler();
    assembler.push({ type: 'text', text: '完整块' });
    assert.deepEqual(assembler.blocks(), [{ type: 'text', text: '完整块' }]);
    const empty = new BlockAssembler();
    assert.deepEqual(empty.blocks(), []);
    assert.equal(empty.finish, undefined);
  });

  test('非文本 chunk（工具调用/思考块/null）不产出文本、不炸', () => {
    const assembler = new BlockAssembler();
    assembler.push({ type: 'thinking', text: '思考内容' });
    assembler.push({ type: 'tool-call', name: 'x' });
    assembler.push(null);
    assembler.push('not-an-object');
    assert.deepEqual(assembler.blocks(), []);
  });
});

describe('shim 消息工厂与 reasoning 标识', () => {
  test('createUserMessage / createAssistantMessage 透传形状（role/content/source）', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } });
    assert.equal(user.role, 'user');
    assert.deepEqual(user.source, { kind: 'user' });
    const assistant = createAssistantMessage({ content: [], source: { kind: 'model' } });
    assert.equal(assistant.role, 'assistant');
  });

  test('ReasoningEffortId 原样返回（DSH 侧是枚举工厂）', () => {
    assert.equal(ReasoningEffortId('off'), 'off');
  });
});
