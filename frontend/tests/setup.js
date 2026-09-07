// vitest environment: 'happy-dom' 已提供 window.localStorage（126号：happy-dom 20.14 起
// GlobalWindow.localStorage 为只读 getter，旧写法 globalThis.localStorage = ... 会抛错）。
// 这里只做每测试前清空，保证用例互不串状态
import { beforeEach } from 'vitest';

beforeEach(() => {
  globalThis.localStorage?.clear?.();
});
