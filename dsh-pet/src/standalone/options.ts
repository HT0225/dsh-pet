/**
 * 独立模式的命令行解析与路径推导（纯逻辑，零 I/O —— 便于 node:test 直接单测）。
 *
 * 配置路径为什么在这里再写一遍：独立模式的 `--check` 要回答"DSH 会读哪份配置"，
 * 而那必须在不 `apply`（= 不拉起桌宠窗口）的前提下算出来。`src/host/index.ts` 仍是
 * 唯一事实来源，这里是它的**只读镜像**；`options.test.ts` 用插件自己的
 * `GET /config/meta`（由 `apply` 注册的真实路由）钉住两者一致，镜像一旦漂移测试就红。
 */
import { join } from 'node:path';

import type { ConfigPaths } from '../host/config';
import { DEFAULT_STANDALONE_PORT } from './server';

/** 命令行解析结果 */
export interface CliOptions {
  port: number;
  /** 监听地址（默认只听本机；对外提供浏览器页时用 0.0.0.0） */
  host: string;
  /** 访问令牌：null = 不鉴权（默认本机监听时）；对外监听缺省时由 cli 自动生成随机令牌 */
  token: string | null;
  check: boolean;
  help: boolean;
}

/** 默认监听地址（只听回环，安全默认） */
export const DEFAULT_STANDALONE_HOST = '127.0.0.1';

/** `--help` 正文 */
export const USAGE = `dsh-pet 独立模式（不需要 DSH）

用法：dsh-pet-standalone [选项]

选项：
  --port <端口>   监听端口（默认 ${DEFAULT_STANDALONE_PORT}；被占用时自动向后顺延）
  --host <地址>   监听地址（默认 ${DEFAULT_STANDALONE_HOST}；浏览器页远程访问用 0.0.0.0）
  --token <令牌>  访问令牌：所有请求须带 ?token= 或同名 Cookie；对外监听（非回环地址）
                  且未指定时自动生成随机令牌并打印带令牌的页面地址
  --check         只体检：打印配置来源、宠物清单与 Electron 状态，不启动窗口
  -h, --help      显示本帮助

说明：
  桌宠在独立模式下以「透明置顶小窗」运行；浏览器页形态访问 /pet（本机回环默认免令牌）。
  已接入 DeepSeek 官方 deepseek-flash 模型：余额 / 碎碎念 / 对话均可用。
  工作状态联动依赖 DSH 的会话事件，在独立模式下不可用。
`;

/**
 * 解析 argv。
 * @param argv `process.argv.slice(2)`
 * @returns 选项，或 `{ error }`（调用方打印用法并以 2 退出）
 */
export function parseArgs(argv: string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = {
    port: DEFAULT_STANDALONE_PORT,
    host: DEFAULT_STANDALONE_HOST,
    token: null,
    check: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? String(argv[index + 1] ?? '') : arg.slice('--port='.length);
      if (arg === '--port') index += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return { error: `--port 需要 1..65535 的整数端口，收到 ${JSON.stringify(raw)}` };
      }
      options.port = value;
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      const raw = arg === '--host' ? String(argv[index + 1] ?? '') : arg.slice('--host='.length);
      if (arg === '--host') index += 1;
      // 宽松校验：合法 IPv4/IPv6/主机名即可，不替用户猜默认值
      if (!/^[A-Za-z0-9._:-]+$/.test(raw)) {
        return { error: `--host 收到无法识别的地址 ${JSON.stringify(raw)}` };
      }
      options.host = raw;
    } else if (arg === '--token' || arg.startsWith('--token=')) {
      const raw = arg === '--token' ? String(argv[index + 1] ?? '') : arg.slice('--token='.length);
      if (arg === '--token') index += 1;
      if (raw.length === 0) return { error: '--token 需要非空令牌值' };
      options.token = raw;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  return { options };
}

/**
 * 配置路径集（`src/host/index.ts` 那份推导的只读镜像，见文件头）。
 * @param root 插件包根目录（构建产物里 = 包根；源码形态下 = `src/`）
 * @param home DSH_HOME
 */
export function configPathsFor(root: string, home: string): ConfigPaths {
  const userRoot = join(home, 'dsh-pet');
  return {
    defaultFile: join(root, 'assets', 'config.jsonc'),
    userFile: join(userRoot, 'main-config.jsonc'),
    legacyUserFile: join(userRoot, 'main-config.json'),
    petDir: join(userRoot, 'pet'),
  };
}

/** 宠物列表的展示串：`display` 原样打印，由用户确认（独立模式不替用户改配置） */
export function describePets(pets: Record<string, unknown>[]): string {
  if (pets.length === 0) return '（没有宠物：配置里 pets 为空）';
  return pets
    .map((pet) => `${String(pet.id ?? '?')}(size=${String(pet.size ?? '?')}, display=${String(pet.display ?? '?')})`)
    .join('  ');
}

/**
 * 该实例是否会出现在桌面（`display` 含 desktop/both）。
 *
 * 口径来源是 `src/host/index.ts` 的 `isDesktopVisible`（那里是模块内 const、未导出），
 * 独立模式只是为了**打印提示**才知道这条规则，不参与渲染决策（渲染由插件自己判断），
 * 因此这里保留一份最小镜像；规则若变，测试与提示文案会露出来。
 */
export function isDesktopVisible(pet: Record<string, unknown>): boolean {
  const display = pet.display;
  return display === 'desktop' || display === 'both';
}
