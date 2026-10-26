"""
假设 23：纳指微型期货（MNQ）按波动调仓位（用户 2026-10-26 确认）。由 moomoo_paper.py 在每天的 run 里调用。

规则（与 backtest/lab/hypo22-23.mjs 一致，按实盘口径：整张合约、保证金现金不计息）：
  目标杠杆 L = min(4, 60% ÷ QQQ 近 20 日年化波动)；目标张数 = round(L × 子账本权益 ÷ (MNQ 价格 × 2))
  张数和目标不同就调仓（步长 1 张）；每月首个交易日先入账 3000 HKD
  主力合约到期前 7 个自然日换到下一季合约（先平旧、再开新）
  权益不足以覆盖持仓的初始保证金时，按权益能撑的张数强制减仓
安全约束：只用 TrdEnv.SIMULATE、只交易 US.MNQ 合约、不调用 unlock_trade
报价：账号没有美国期货行情权限，限价单按 Yahoo MNQ=F 最新价 ± 小幅偏移挂单（用户 2026-10-26 同意）
"""
import json
import math
import time
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from moomoo import (RET_OK, OpenFutureTradeContext, OpenQuoteContext, OrderStatus, OrderType, ModifyOrderOp,
                    TrdEnv, TrdSide, KLType, AuType, Market, SecurityType)

ENV = TrdEnv.SIMULATE
MULT = 2.0               # MNQ 每点 $2
TICK = 0.25
TARGET_VOL = 0.60
CAP = 4.0
ROLL_DAYS = 7
ET = ZoneInfo('America/New_York')
STALE_SEC = 1800         # Yahoo 期货报价本身延迟约 10 分钟；超过 30 分钟视为休市/停盘，不下单


def cme_open(now=None):
    """CME 股指期货时段（美东）：周日 18:00 → 周五 17:00，每天 17:00–18:00 停盘。
    节假日不在这里判断：休市时 Yahoo 报价不更新，由 STALE_SEC 兜底"""
    n = now or datetime.now(ET)
    wd, hm = n.weekday(), n.hour * 60 + n.minute
    if wd == 5 or (wd == 4 and hm >= 17 * 60) or (wd == 6 and hm < 18 * 60):
        return False
    return not (17 * 60 <= hm < 18 * 60)


def third_friday(y, m):
    d = datetime(y, m, 1)
    return (d + timedelta(days=(4 - d.weekday()) % 7 + 14)).strftime('%Y-%m-%d')


def expiry_of(code):
    yymm = code[-4:]
    return third_friday(2000 + int(yymm[:2]), int(yymm[2:]))


def yahoo_mnq():
    req = urllib.request.Request('https://query1.finance.yahoo.com/v8/finance/chart/MNQ=F?range=1d&interval=1m',
                                 headers={'User-Agent': 'Mozilla/5.0'})
    m = json.load(urllib.request.urlopen(req, timeout=20))['chart']['result'][0]['meta']
    t = m['regularMarketTime']
    return float(m['regularMarketPrice']), datetime.utcfromtimestamp(t).strftime('%Y-%m-%d %H:%M UTC'), time.time() - t


class FutBroker:
    def __init__(self, log, acc_id=None):
        self.log = log
        self.t = OpenFutureTradeContext(host='127.0.0.1', port=11111)
        self.q = OpenQuoteContext(host='127.0.0.1', port=11111)
        try:
            r, acc = self.t.get_acc_list()
            if r != RET_OK:
                raise SystemExit(f'期货 get_acc_list 失败：{acc}')
            sim = acc[(acc['trd_env'] == ENV) & (acc['acc_status'] == 'ACTIVE')]
            if acc_id:
                sim = sim[sim['acc_id'] == acc_id]
            if len(sim) != 1:
                raise SystemExit(f'需要恰好一个可用的期货模拟账户，找到 {sim["acc_id"].tolist()}')
            self.acc = int(sim.iloc[0]['acc_id'])
        except BaseException:
            self.close(); raise

    def close(self):
        self.t.close(); self.q.close()

    def contracts(self):
        """(当期合约, 下期合约) 代码，如 US.MNQ2612 / US.MNQ2703"""
        r, d = self.q.get_stock_basicinfo(Market.US, SecurityType.FUTURE)
        if r != RET_OK:
            raise RuntimeError(f'期货列表查询失败：{d}')
        m = sorted(c for c in d['code'] if c.startswith('US.MNQ') and c[-4:].isdigit())
        return m[0], m[1]

    def qqq_vol20(self, today):
        start = (datetime.fromisoformat(today) - timedelta(days=45)).strftime('%Y-%m-%d')
        r, k, _ = self.q.request_history_kline('US.QQQ', start=start, end=today, ktype=KLType.K_DAY, autype=AuType.QFQ, max_count=60)
        if r != RET_OK:
            raise RuntimeError(f'QQQ 日线查询失败：{k}')
        closes = [float(c) for d, c in zip(k['time_key'], k['close']) if str(d)[:10] < today][-21:]
        rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
        mu = sum(rets) / len(rets)
        return math.sqrt(sum((x - mu) ** 2 for x in rets) / (len(rets) - 1) * 252)

    def position(self, code):
        r, p = self.t.position_list_query(trd_env=ENV, acc_id=self.acc, refresh_cache=True)
        if r != RET_OK:
            raise RuntimeError(f'期货持仓查询失败：{p}')
        row = p[p['code'] == code]
        return float(row['qty'].sum()) if len(row) else 0.0

    def margin_per(self, code, px):
        r, d = self.t.acctradinginfo_query(order_type=OrderType.NORMAL, code=code, price=px, trd_env=ENV, acc_id=self.acc)
        return float(d.iloc[0]['long_required_im']) if r == RET_OK else px * MULT * 0.08

    def trade(self, code, qty, side, remark):
        """限价追单：Yahoo 价 ± 1 / 3 / 6 个 tick，每 15 秒一档；仍未全成交则撤单。返回 (成交张数, 均价, 费用, 参考价)"""
        if not (code.startswith('US.MNQ') and code[-4:].isdigit()):
            raise SystemExit(f'拒绝下单：{code} 不在白名单')
        ref, at, _ = yahoo_mnq()
        sgn = 1 if side == TrdSide.BUY else -1
        steps = [round((ref + sgn * k * TICK) / TICK) * TICK for k in (1, 3, 6)]
        r, d = self.t.place_order(price=steps[0], qty=qty, code=code, trd_side=side, order_type=OrderType.NORMAL,
                                  trd_env=ENV, acc_id=self.acc, remark=remark[:60])
        if r != RET_OK:
            raise RuntimeError(f'期货下单失败 {code} {qty}@{steps[0]}：{d}')
        oid = str(d['order_id'][0])
        self.log(f"期货下单 {code} {'买' if sgn > 0 else '卖'} {qty} 张 @ {steps[0]}（Yahoo 参考 {ref}，{at}）→ 订单 {oid}")
        st = None
        for p in steps[1:] + [None]:
            time.sleep(15)
            r, o = self.t.order_list_query(order_id=oid, trd_env=ENV, acc_id=self.acc, refresh_cache=True)
            st = o.iloc[0] if r == RET_OK and len(o) else None
            if st is not None and st['order_status'] in (OrderStatus.FILLED_ALL, OrderStatus.CANCELLED_ALL, OrderStatus.FAILED):
                break
            if p is None:
                self.t.modify_order(ModifyOrderOp.CANCEL, oid, 0, 0, trd_env=ENV, acc_id=self.acc); time.sleep(3)
                r, o = self.t.order_list_query(order_id=oid, trd_env=ENV, acc_id=self.acc, refresh_cache=True)
                st = o.iloc[0] if r == RET_OK and len(o) else None
                self.log(f'  期货追单结束未全成交，已撤单')
                break
            self.t.modify_order(ModifyOrderOp.NORMAL, oid, qty, p, trd_env=ENV, acc_id=self.acc)
            self.log(f'  未成交，改价 → {p}')
        filled = float(st['dealt_qty']) if st is not None else 0
        avg = float(st['dealt_avg_price'] or 0) if st is not None else 0
        fee = None
        try:
            r, fd = self.t.order_fee_query(order_id_list=[oid], trd_env=ENV, acc_id=self.acc)
            fee = float(fd.iloc[0]['fee_amount']) if r == RET_OK and len(fd) else None
        except Exception:
            pass
        return {'order_id': oid, 'code': code, 'side': 'BUY' if sgn > 0 else 'SELL', 'qty': qty, 'filled': filled, 'avg': avg,
                'bid': ref, 'ask': ref, 'mid': ref, 'slip_vs_mid': (avg / ref - 1) if avg else None, 'fee': fee, 'remark': remark}


def new_h23(today, init):
    return {'invested': init, 'cash': init, 'contributions': [{'d': today, 'usd': init}], 'started': False,
            'code': None, 'qty': 0, 'avg': 0.0, 'funded_month': today[:7], 'target': None, 'fees': 0.0}


def equity(h, px):
    return h['cash'] + h['qty'] * (px - h['avg']) * MULT


def _fill(h, r, sgn):
    """按成交更新子账本：加仓更新均价；减仓把已实现盈亏计入 cash"""
    q = r['filled'] * sgn
    if q == 0:
        return
    fee = r['fee'] or 0
    h['fees'] += fee; h['cash'] -= fee
    if h['qty'] == 0 or (h['qty'] > 0) == (q > 0):
        h['avg'] = (h['avg'] * abs(h['qty']) + r['avg'] * abs(q)) / (abs(h['qty']) + abs(q)); h['qty'] += q
    else:
        close = min(abs(q), abs(h['qty']))
        h['cash'] += close * (r['avg'] - h['avg']) * MULT * (1 if h['qty'] > 0 else -1)
        h['qty'] += q
        if h['qty'] == 0:
            h['avg'] = 0.0


def run_h23(s, today, monthly, init, log, append_log, save_state, submit=True, force=False):
    """返回 (动作说明列表, 成交记录列表)。失败抛出，由调用方发"执行失败"邮件。
    按 CME 时段判断能否下单，不跟美股常规时段；每天最多执行一次（信号用日线，一天调一次与回测一致）"""
    if 'H23' not in s:
        s['H23'] = new_h23(today, init); log(f'新增子账本：H23（${init:,.0f}，MNQ 期货按波动调仓位，最多 {CAP:g} 倍 QQQ）')
    h = s['H23']
    if submit and not force:
        if h.get('last_run') == today:
            return [f'H23 今天（{today}）已经执行过，不重复下单'], []
        if not cme_open():
            return ['H23 期货当前休市（CME 美东周日 18:00–周五 17:00，每天 17–18 点停盘），今天不下单'], []
    b = FutBroker(log)
    acts, fills = [], []
    try:
        px, at, age = yahoo_mnq()
        if age > STALE_SEC:
            acts.append(f'H23 MNQ 报价已 {age / 60:.0f} 分钟未更新（{at}），视为期货休市，不下单')
            if submit:
                return acts, fills
        cur, nxt = b.contracts()
        funding = h['funded_month'] != today[:7]
        if funding and submit:
            h['cash'] += monthly; h['invested'] += monthly; h['contributions'].append({'d': today, 'usd': monthly}); h['funded_month'] = today[:7]
        # 换月：持有合约离到期 ≤ 7 天 → 平掉，改用下一季
        if h['code'] and today >= (datetime.fromisoformat(expiry_of(h['code'])) - timedelta(days=ROLL_DAYS)).strftime('%Y-%m-%d') and h['qty']:
            acts.append(f"H23 换月：平掉 {h['qty']:g} 张 {h['code']}（{expiry_of(h['code'])} 到期）→ 改用 {nxt}")
            if submit:
                r = b.trade(h['code'], int(abs(h['qty'])), TrdSide.SELL if h['qty'] > 0 else TrdSide.BUY, 'H23 roll close')
                _fill(h, r, -1 if h['qty'] > 0 else 1); fills.append(r); append_log(r); save_state(s)
        code = h['code'] if h['code'] and h['qty'] else (nxt if today >= (datetime.fromisoformat(expiry_of(cur)) - timedelta(days=ROLL_DAYS)).strftime('%Y-%m-%d') else cur)
        vol = b.qqq_vol20(today)
        lev = min(CAP, TARGET_VOL / vol)
        eq = equity(h, px) + (0 if funding and submit else (monthly if funding else 0))
        want = int(round(lev * eq / (px * MULT)))
        im = b.margin_per(code, px)
        if want * im > eq:  # 权益撑不住初始保证金 → 压到能撑的张数
            want = int(eq // im); acts.append(f'H23 保证金约束：权益 ${eq:,.0f} 只够 {want} 张（每张初始保证金 ${im:,.0f}）')
        d = want - int(h['qty'])
        note = f'QQQ 20 日波动 {vol:.0%} → 目标 {lev:.2f} 倍 → {want} 张 {code}（MNQ {px}，{at}；当前 {h["qty"]:g} 张，权益 ${eq:,.0f}）'
        if d == 0:
            acts.append('H23 不调仓：' + note)
        else:
            acts.append(f"H23 {'建仓' if not h.get('started') else '调仓'}：{note}，{'买' if d > 0 else '卖'} {abs(d)} 张")
            if submit:
                r = b.trade(code, abs(d), TrdSide.BUY if d > 0 else TrdSide.SELL, f'H23 vol-target {lev:.2f}x')
                _fill(h, r, 1 if d > 0 else -1); fills.append(r); append_log(r)
                h['code'] = code if h['qty'] else None
        if submit:
            h['target'] = round(lev, 2); h['started'] = True; h['last_run'] = today; save_state(s)
        # 对账
        broker = b.position(h['code']) if h['code'] else 0
        if h['code'] and abs(broker - h['qty']) > 1e-9:
            acts.append(f"H23 对账不一致：券商 {broker:g} 张 vs 账本 {h['qty']:g} 张")
        h['_px'] = px
        return acts, fills
    finally:
        b.close()
