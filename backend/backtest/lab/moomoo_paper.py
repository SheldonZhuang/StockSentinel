"""
Moomoo 模拟盘执行器：假设 19（滚动 TQQQ 远月 LEAPS Call + 定投）与假设 20（TQQQ 买持 + 定投，只买整股）。

安全约束（硬编码，不可通过参数改）：
  - 只用 TrdEnv.SIMULATE，只用美股模拟账户 ACC_ID；代码里没有 REAL 分支，也不调用 unlock_trade
  - 只交易 US.TQQQ 与 TQQQ 期权；每笔下单前再核对一次标的前缀

账本：模拟账户有 1000 万虚拟资金，但两个策略各自只按"$10,000 本金 + 每月 3000 HKD"的预算运作。
  预算记在 out/moomoo_paper_state.json（每个策略一个子账本：已投入、可用现金、持仓），券商账户只是执行通道。
  两个策略的持仓在券商端互不重叠（一个只持 TQQQ 股票，一个只持 TQQQ Call），可直接对账。

规则（与回测 hypo19-20.mjs 一致）：
  H20：每月首个交易日，把子账本可用现金全部按整股买 TQQQ（限价 = 卖一价 ×1.001）
  H19：建仓/换仓选"当前能买到的最远到期日（须 >2 年）"、行权价最接近现价×1.02 的 Call；
       每月首个交易日现金够 1 张就加买同一张；到期前 91 天卖出旧合约、同日买新合约；
       期权限价从中间价起，每 10 秒向卖价（买单）/买价（卖单）挪 25% 价差，最多 4 次，仍未成交则撤单、下次再试
  月度定投：每个自然月第一次运行时给两个子账本各加 3000/7.8 美元（回测口径；实盘应按实际换汇记录）

用法（backend/ 下）：
  python -I backtest/lab/moomoo_paper.py status            只读：账户、持仓、子账本、今天要做什么
  python -I backtest/lab/moomoo_paper.py plan              只读：生成今天的下单计划（不下单）
  python -I backtest/lab/moomoo_paper.py run --submit      执行今天的计划（模拟盘下单）
建议用 Windows 计划任务在美股开盘后 15 分钟每天跑一次 run --submit；非月初、非换仓日会直接退出不下单。
"""
import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from moomoo import (RET_OK, OpenQuoteContext, OpenSecTradeContext, OrderStatus, OrderType, ModifyOrderOp,
                    TrdEnv, TrdMarket, TrdSide, OptionType, TradeDateMarket)

ENV = TrdEnv.SIMULATE          # 硬编码：只用模拟盘
ACC_ID = None                  # 启动时自动选：唯一一个美股 SIMULATE 账户（重置模拟盘后账号会变，2026-10-24 为 2926355）；有多个时用 --acc-id 指定
UNDERLYING = 'US.TQQQ'
INIT_USD = 10000.0
MONTHLY_USD = 3000 / 7.8
STRIKE_RATIO = 1.02
MIN_YEARS = 2.0                # 到期日须 >2 年
ROLL_DAYS = 91                 # 到期前 3 个月换仓
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_F = os.path.join(HERE, 'out', 'moomoo_paper_state.json')
LOG_F = os.path.join(HERE, 'out', 'moomoo_paper_orders.jsonl')
ET = ZoneInfo('America/New_York')


if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')  # Windows 控制台默认 GBK，中文日志会乱码


def log(msg):
    print(f"[{datetime.now(ET).strftime('%Y-%m-%d %H:%M:%S')} ET] {msg}", flush=True)


def append_log(rec):
    os.makedirs(os.path.dirname(LOG_F), exist_ok=True)
    with open(LOG_F, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'at': datetime.now(timezone.utc).isoformat(), **rec}, ensure_ascii=False) + '\n')


def load_state():
    if os.path.exists(STATE_F):
        with open(STATE_F, encoding='utf-8') as f:
            return json.load(f)
    return None


def save_state(s):
    os.makedirs(os.path.dirname(STATE_F), exist_ok=True)
    tmp = STATE_F + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_F)


def new_state(today):
    sleeve = lambda: {'invested': INIT_USD, 'cash': INIT_USD, 'contributions': [{'d': today, 'usd': INIT_USD}]}
    return {'created': today, 'last_month_funded': today[:7],
            'H20': {**sleeve(), 'shares': 0},
            'H19': {**sleeve(), 'option': None}}  # option: {code, strike, expiry, qty}


class Broker:
    """moomoo 连接封装；所有交易调用固定 trd_env=SIMULATE、acc_id=ACC_ID"""

    def __init__(self, acc_id=None):
        host = os.environ.get('MOOMOO_OPEND_HOST', '127.0.0.1')
        port = int(os.environ.get('MOOMOO_OPEND_PORT', '11111'))
        self.q = OpenQuoteContext(host=host, port=port)
        self.t = OpenSecTradeContext(filter_trdmarket=TrdMarket.US, host=host, port=port)
        try:
            self._pick_account(acc_id)
        except BaseException:
            self.close()  # 不关连接进程会挂住
            raise

    def close(self):
        self.q.close(); self.t.close()

    def _pick_account(self, acc_id):
        global ACC_ID
        r, acc = self.t.get_acc_list()
        if r != RET_OK:
            raise SystemExit(f'get_acc_list 失败：{acc}')
        sim = acc[(acc['trd_env'] == ENV) & acc['trdmarket_auth'].apply(lambda m: 'US' in m)]
        if acc_id is not None:
            sim = sim[sim['acc_id'] == acc_id]
        if len(sim) != 1:
            raise SystemExit(f'需要恰好一个美股模拟账户，找到 {len(sim)} 个：{sim["acc_id"].tolist()}（用 --acc-id 指定；只允许 SIMULATE）')
        ACC_ID = int(sim.iloc[0]['acc_id'])

    # ---------- 行情 ----------
    def snapshot(self, codes):
        r, d = self.q.get_market_snapshot(codes)
        if r != RET_OK:
            raise RuntimeError(f'snapshot 失败：{d}')
        return {row['code']: row for _, row in d.iterrows()}

    def market_open(self):
        """常规交易时段内才下单：美东 9:40–15:50，且当天是 moomoo 美股交易日（含假期判断）。
        不用 get_global_state 的市场状态名：美股各时段对应哪个枚举文档没写清，时钟+交易日历更可靠"""
        now = datetime.now(ET)
        if not (now.replace(hour=9, minute=40, second=0) <= now <= now.replace(hour=15, minute=50, second=0)):
            return False
        d = now.strftime('%Y-%m-%d')
        r, days = self.q.request_trading_days(market=TradeDateMarket.US, start=d, end=d)
        return r == RET_OK and any(x.get('time') == d for x in days)

    def far_call(self, spot, today):
        """最远到期日（须 >2 年）上最接近 spot×1.02 的 Call"""
        r, exps = self.q.get_option_expiration_date(UNDERLYING)
        if r != RET_OK:
            raise RuntimeError(f'到期日查询失败：{exps}')
        far = sorted(exps['strike_time'].tolist())[-1]
        yrs = (datetime.fromisoformat(far) - datetime.fromisoformat(today)).days / 365
        if yrs <= MIN_YEARS:
            raise RuntimeError(f'最远到期 {far} 只有 {yrs:.2f} 年，不满足 >2 年，今天不建仓')
        r, ch = self.q.get_option_chain(UNDERLYING, start=far, end=far, option_type=OptionType.CALL)
        if r != RET_OK or ch.empty:
            raise RuntimeError(f'期权链查询失败：{ch}')
        target = spot * STRIKE_RATIO
        ch = ch.assign(dist=(ch['strike_price'] - target).abs()).sort_values('dist')
        best = ch.iloc[0]
        return {'code': best['code'], 'strike': float(best['strike_price']), 'expiry': far}

    # ---------- 账户 ----------
    def positions(self):
        r, d = self.t.position_list_query(trd_env=ENV, acc_id=ACC_ID, refresh_cache=True)
        if r != RET_OK:
            raise RuntimeError(f'持仓查询失败：{d}')
        return {row['code']: float(row['qty']) for _, row in d.iterrows() if float(row['qty']) != 0}

    def funds(self):
        r, d = self.t.accinfo_query(trd_env=ENV, acc_id=ACC_ID, refresh_cache=True, currency='USD')
        if r != RET_OK:
            raise RuntimeError(f'资金查询失败：{d}')
        x = d.iloc[0]
        return {'total_assets': float(x['total_assets']), 'cash': float(x['cash']), 'power': float(x['power'])}

    # ---------- 下单（只允许 TQQQ 及其期权） ----------
    def _guard(self, code):
        if not (code == UNDERLYING or code.startswith('US.TQQQ') and code[7:8].isdigit()):
            raise SystemExit(f'拒绝下单：{code} 不在白名单（只允许 US.TQQQ 与 TQQQ 期权）')

    def order(self, code, side, qty, price, remark):
        self._guard(code)
        r, d = self.t.place_order(price=round(price, 2), qty=qty, code=code, trd_side=side, order_type=OrderType.NORMAL,
                                  trd_env=ENV, acc_id=ACC_ID, remark=remark[:60], time_in_force='DAY', fill_outside_rth=False)
        if r != RET_OK:
            raise RuntimeError(f'下单失败 {code} {side} {qty}@{price}：{d}')
        return str(d['order_id'][0])

    def order_status(self, oid):
        r, d = self.t.order_list_query(order_id=oid, trd_env=ENV, acc_id=ACC_ID, refresh_cache=True)
        if r != RET_OK or d.empty:
            return None
        x = d.iloc[0]
        return {'status': x['order_status'], 'filled': float(x['dealt_qty']), 'avg': float(x['dealt_avg_price'] or 0), 'qty': float(x['qty'])}

    def modify(self, oid, qty, price):
        r, d = self.t.modify_order(ModifyOrderOp.NORMAL, oid, qty, round(price, 2), trd_env=ENV, acc_id=ACC_ID)
        if r != RET_OK:
            log(f'改单失败 {oid}：{d}')

    def cancel(self, oid):
        r, d = self.t.modify_order(ModifyOrderOp.CANCEL, oid, 0, 0, trd_env=ENV, acc_id=ACC_ID)
        if r != RET_OK:
            log(f'撤单失败 {oid}：{d}')

    def fee(self, oid):
        try:
            r, d = self.t.order_fee_query(order_id_list=[oid], trd_env=ENV, acc_id=ACC_ID)
            return float(d.iloc[0]['fee_amount']) if r == RET_OK and not d.empty else None
        except Exception:
            return None


DONE = {OrderStatus.FILLED_ALL}
DEAD = {OrderStatus.CANCELLED_ALL, OrderStatus.CANCELLED_PART, OrderStatus.FAILED, OrderStatus.DISABLED, OrderStatus.DELETED}


def chase(b, code, side, qty, is_option, remark):
    """限价追单。股票：买单从卖一×1.001 起，最多 3 档；期权：从中间价起，每 10 秒向对手价挪 1/4 价差，最多到对手价。
    仍未全部成交则撤单，返回实际成交（部分成交也记账）。"""
    s = b.snapshot([code])[code]
    bid, ask = float(s['bid_price'] or 0), float(s['ask_price'] or 0)
    if bid <= 0 or ask <= 0:
        raise RuntimeError(f'{code} 无有效买卖价（bid {bid} ask {ask}），可能休市或无报价')
    mid = (bid + ask) / 2
    buy = side == TrdSide.BUY
    if is_option:
        far = ask if buy else bid
        steps = [mid + (far - mid) * k / 4 for k in range(5)]
        wait = 10
    else:
        steps = [ask * f for f in (1.001, 1.002, 1.004)] if buy else [bid * f for f in (0.999, 0.998, 0.996)]
        wait = 20
    oid = b.order(code, side, qty, steps[0], remark)
    log(f"下单 {code} {'买' if buy else '卖'} {qty} @ {steps[0]:.2f}（买一 {bid} 卖一 {ask} 中间 {mid:.3f}）→ 订单 {oid}")
    st = None
    for p in steps[1:] + [None]:
        time.sleep(wait)
        st = b.order_status(oid)
        if st and (st['status'] in DONE or st['status'] in DEAD):
            break
        if p is None:
            b.cancel(oid)
            time.sleep(3)
            st = b.order_status(oid)
            log(f'追单结束仍未全部成交，已撤单：{st}')
            break
        b.modify(oid, qty, p)
        log(f'  未成交，改价 → {p:.2f}')
    filled = (st or {}).get('filled', 0) or 0
    avg = (st or {}).get('avg', 0) or 0
    slip = (avg / mid - 1) if avg and mid else None
    rec = {'order_id': oid, 'code': code, 'side': 'BUY' if buy else 'SELL', 'qty': qty, 'filled': filled, 'avg': avg,
           'bid': bid, 'ask': ask, 'mid': mid, 'slip_vs_mid': slip, 'fee': b.fee(oid), 'remark': remark}
    append_log(rec)
    slip_s = '—' if slip is None else f'{slip * 100:+.2f}%'
    log(f"  结果：成交 {filled}/{qty}，均价 {avg}，相对中间价 {slip_s}，费用 {rec['fee']}")
    return rec


def today_et():
    return datetime.now(ET).strftime('%Y-%m-%d')


def roll_date(expiry):
    return (datetime.fromisoformat(expiry) - timedelta(days=ROLL_DAYS)).strftime('%Y-%m-%d')


def plan(b, s, today, force_buy=False):
    """根据子账本与实时行情给出今天要做的动作（只读，不下单）。返回 (动作列表, 是否本月首次入账)"""
    acts = []
    snap = b.snapshot([UNDERLYING])[UNDERLYING]
    spot = float(snap['last_price'])
    ask = float(snap['ask_price'] or 0) or spot
    funding = s['last_month_funded'] != today[:7]
    add = MONTHLY_USD if funding else 0
    if funding:
        acts.append(('FUND', f'新月份：两个子账本各入账定投 ${MONTHLY_USD:.2f}'))
    # 只在三种日子买入：第一次运行（建仓）、每月首个交易日（定投）、H19 换仓日。其他日子即使有零头现金也不买
    may_buy = funding or force_buy or not s.get('last_run')
    # H20：可用现金全部按整股买
    h20cash = s['H20']['cash'] + add
    k = math.floor(h20cash / (ask * 1.004)) if may_buy else 0
    acts.append(('H20_BUY', f'H20 买 {k} 股 TQQQ（可用 ${h20cash:,.2f}，卖一 {ask}）', k) if k > 0
                else ('H20_WAIT', f'H20 不买（现金 ${h20cash:,.2f}' + ('' if may_buy else '，今天不是建仓/定投日') + '）'))
    # H19：到换仓日先换仓；否则现金够 1 张就买（建仓或加买同一张）
    h19cash = s['H19']['cash'] + add
    opt = s['H19']['option']
    if opt and today >= roll_date(opt['expiry']):
        nxt = b.far_call(spot, today)  # 先确认有更远的合约可换，否则不卖（避免卖了又买回同一到期日）
        if nxt['expiry'] <= opt['expiry']:
            raise RuntimeError(f"到了换仓日但最远到期 {nxt['expiry']} 不晚于现持 {opt['expiry']}，不换仓，需人工检查期权链")
        acts.append(('H19_ROLL', f"H19 换仓：卖出 {opt['qty']} 张 {opt['code']}（到期 {opt['expiry']}），再买 {nxt['code']}（到期 {nxt['expiry']}）"))
        return acts, funding
    if not may_buy:
        acts.append(('H19_WAIT', f'H19 今天不是建仓/定投/换仓日，不动（现金 ${h19cash:,.2f}）'))
        return acts, funding
    tgt = b.far_call(spot, today) if not opt else {k2: opt[k2] for k2 in ('code', 'strike', 'expiry')}
    oask = float(b.snapshot([tgt['code']])[tgt['code']]['ask_price'] or 0)
    n = math.floor(h19cash / (oask * 100 + 1)) if oask > 0 else 0
    if n > 0:
        acts.append(('H19_BUY', f"H19 {'加买' if opt else '建仓'} {n} 张 {tgt['code']}（行权 {tgt['strike']}，到期 {tgt['expiry']}，卖价 {oask}，可用 ${h19cash:,.2f}）", n, tgt))
    else:
        acts.append(('H19_WAIT', f'H19 现金 ${h19cash:,.2f} 不够 1 张（约 ${oask * 100:,.0f}），继续攒'))
    return acts, funding


def execute(b, s, today, acts, funding):
    if funding:
        for k in ('H20', 'H19'):
            s[k]['cash'] += MONTHLY_USD
            s[k]['invested'] += MONTHLY_USD
            s[k]['contributions'].append({'d': today, 'usd': MONTHLY_USD})
        s['last_month_funded'] = today[:7]
        save_state(s)
    for a in acts:
        if a[0] == 'H20_BUY':
            r = chase(b, UNDERLYING, TrdSide.BUY, a[2], False, 'H20 TQQQ hold+DCA')
            s['H20']['shares'] += r['filled']
            s['H20']['cash'] -= r['filled'] * r['avg'] + (r['fee'] or 0)
            save_state(s)
        elif a[0] == 'H19_ROLL':
            opt = s['H19']['option']
            r = chase(b, opt['code'], TrdSide.SELL, int(opt['qty']), True, 'H19 roll sell')
            s['H19']['cash'] += r['filled'] * r['avg'] * 100 - (r['fee'] or 0)
            opt['qty'] -= r['filled']
            if opt['qty'] <= 0:
                s['H19']['option'] = None
            save_state(s)
            if s['H19']['option'] is None:  # 旧合约卖完才买新的
                acts2, _ = plan(b, s, today, force_buy=True)
                execute(b, s, today, [x for x in acts2 if x[0] == 'H19_BUY'], False)
        elif a[0] == 'H19_BUY':
            tgt = a[3]
            r = chase(b, tgt['code'], TrdSide.BUY, a[2], True, 'H19 LEAPS buy')
            if r['filled'] > 0:
                o = s['H19']['option'] or {'code': tgt['code'], 'strike': tgt['strike'], 'expiry': tgt['expiry'], 'qty': 0}
                o['qty'] += r['filled']
                s['H19']['option'] = o
                s['H19']['cash'] -= r['filled'] * r['avg'] * 100 + (r['fee'] or 0)
            save_state(s)
    s['last_run'] = today
    save_state(s)


def status(b, s):
    f, pos = b.funds(), b.positions()
    log(f"模拟账户 {ACC_ID}：总资产 ${f['total_assets']:,.2f}  现金 ${f['cash']:,.2f}  购买力 ${f['power']:,.2f}")
    log(f'券商持仓：{pos or "无"}')
    if not s:
        log('子账本：尚未初始化（第一次 run 时建立，两个策略各 $10,000）')
        return
    codes = [UNDERLYING] + ([s['H19']['option']['code']] if s['H19']['option'] else [])
    snap = b.snapshot(codes)
    px = float(snap[UNDERLYING]['last_price'])
    v20 = s['H20']['cash'] + s['H20']['shares'] * px
    o = s['H19']['option']
    ov = float(snap[o['code']]['last_price']) * 100 * o['qty'] if o else 0
    v19 = s['H19']['cash'] + ov
    for k, v in (('H20 TQQQ 买持+定投', v20), ('H19 远月 Call+定投', v19)):
        sl = s['H20' if k.startswith('H20') else 'H19']
        log(f"{k}：已投入 ${sl['invested']:,.2f}  市值 ${v:,.2f}  收益 {v / sl['invested'] - 1:+.2%}  可用现金 ${sl['cash']:,.2f}")
    log(f"  H20 持股 {s['H20']['shares']}；H19 合约 {o or '无'}" + (f"，换仓日 {roll_date(o['expiry'])}" if o else ''))
    # 对账：券商持仓应 ≥ 子账本持仓（模拟账户里若有别的持仓不影响）
    bad = []
    if pos.get(UNDERLYING, 0) < s['H20']['shares']:
        bad.append(f"TQQQ 券商 {pos.get(UNDERLYING, 0)} < 账本 {s['H20']['shares']}")
    if o and pos.get(o['code'], 0) < o['qty']:
        bad.append(f"{o['code']} 券商 {pos.get(o['code'], 0)} < 账本 {o['qty']}")
    log('对账：' + ('一致' if not bad else '不一致 → ' + '；'.join(bad)))


def smoke(b):
    """连通性自测：下 1 股 TQQQ 远低于市价的限价买单（不会成交）→ 查询 → 改价 → 撤单 → 确认已撤。不改动子账本。"""
    s = b.snapshot([UNDERLYING])[UNDERLYING]
    p = round(float(s['last_price']) * 0.5, 2)
    oid = b.order(UNDERLYING, TrdSide.BUY, 1, p, 'smoke test - will cancel')
    log(f'自测下单 1 股 TQQQ @ {p}（现价一半，不会成交）→ 订单 {oid}')
    time.sleep(3); log(f'  查询：{b.order_status(oid)}')
    b.modify(oid, 1, round(p * 0.99, 2)); time.sleep(3); log(f'  改价后：{b.order_status(oid)}')
    b.cancel(oid); time.sleep(3); st = b.order_status(oid); log(f'  撤单后：{st}')
    append_log({'smoke': True, 'order_id': oid, 'final': str(st)})
    return st


def main():
    ap = argparse.ArgumentParser(description='Moomoo 模拟盘：假设 19 / 20（只用 SIMULATE）')
    ap.add_argument('cmd', choices=['status', 'plan', 'run', 'smoke'])
    ap.add_argument('--submit', action='store_true', help='run 时真正向模拟盘下单；不带则只打印计划')
    ap.add_argument('--force', action='store_true', help='休市时也尝试（只用于调试；休市挂单会排到下个交易日）')
    ap.add_argument('--acc-id', type=int, help='模拟账户号（默认自动选唯一的美股模拟账户）')
    a = ap.parse_args()
    b = Broker(a.acc_id)
    log(f'使用模拟账户 {ACC_ID}（SIMULATE）')
    try:
        today = today_et()
        s = load_state()
        if a.cmd == 'status':
            status(b, s); return
        if a.cmd == 'smoke':
            smoke(b); return
        if s is None:
            s = new_state(today)
            log('初始化子账本：H19、H20 各 $10,000')
            if a.cmd == 'run' and a.submit:
                save_state(s)
        acts, funding = plan(b, s, today)
        for x in acts:
            log('计划：' + x[1])
        if a.cmd == 'plan' or not a.submit:
            log('（未下单；加 run --submit 执行）'); return
        if s.get('last_run') == today and not a.force:
            log(f'今天（{today}）已经执行过，不重复下单'); return
        if not b.market_open() and not a.force:
            log('美股当前不在常规交易时段，今天不下单（计划任务应设在美东 9:45 之后）'); return
        execute(b, s, today, acts, funding)
        status(b, s)
    finally:
        b.close()


if __name__ == '__main__':
    main()
