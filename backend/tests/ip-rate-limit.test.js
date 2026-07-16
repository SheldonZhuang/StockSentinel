import { describe, it, expect } from 'vitest';
import { ipRateLimit } from '../utils/ip-rate-limit.js';

function mockReqRes(ip) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; },
  };
  return { req: { ip }, res };
}

describe('ipRateLimit', () => {
  it('窗口内超过 max 返回 429', () => {
    const mw = ipRateLimit({ max: 3 });
    let passed = 0;
    for (let i = 0; i < 3; i++) {
      const { req, res } = mockReqRes('1.1.1.1');
      mw(req, res, () => passed++);
      expect(res.statusCode).toBe(200);
    }
    expect(passed).toBe(3);
    // 第4次超限
    const { req, res } = mockReqRes('1.1.1.1');
    let blocked = true;
    mw(req, res, () => { blocked = false; });
    expect(blocked).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('不同 IP 独立计数', () => {
    const mw = ipRateLimit({ max: 1 });
    const a = mockReqRes('2.2.2.2');
    const b = mockReqRes('3.3.3.3');
    let passedA = false, passedB = false;
    mw(a.req, a.res, () => { passedA = true; });
    mw(b.req, b.res, () => { passedB = true; });
    expect(passedA).toBe(true);
    expect(passedB).toBe(true);
  });

  it('自定义 keyFn 生效', () => {
    const mw = ipRateLimit({ max: 1, keyFn: () => 'shared' });
    const a = mockReqRes('4.4.4.4');
    const b = mockReqRes('5.5.5.5'); // 不同 IP 但同 key
    mw(a.req, a.res, () => {});
    let blocked = true;
    mw(b.req, b.res, () => { blocked = false; });
    expect(blocked).toBe(true);
    expect(b.res.statusCode).toBe(429);
  });
});
