"""
Moomoo 模拟盘执行器：假设 19（滚动 TQQQ 远月 LEAPS Call + 定投）、假设 20（TQQQ 买持 + 定投，只买整股）、
假设 21（80% TQQQ + 20% 平值远月 LEAPS，定投按 80/20 拆分，换仓日再平衡回 80/20）。

安全约束（硬编码，不可通过参数改）：
  - 只用 TrdEnv.SIMULATE，只用美股模拟账户 ACC_ID；代码里没有 REAL 分支，也不调用 unlock_trade
  - 只交易 US.TQQQ 与 TQQQ 期权；每笔下单前再核对一次标的前缀

账本：模拟账户有 1000 万虚拟资金，但三个策略各自只按"$51,000 本金 + 每月 3000 HKD"的预算运作。
  预算记在 out/moomoo_paper_state.json（每个策略一个子账本：已投入、可用现金、持仓），券商账户只是执行通道。
  本金：用户 2026-10-25 统一改为 $51,000（原 $10,000）。
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
                    TrdEnv, TrdMarket, TrdSide, OptionType, TradeDateMarket, KLType, AuType)

ENV = TrdEnv.SIMULATE          # 硬编码：只用模拟盘
ACC_ID = None                  # 启动时自动选：唯一一个美股 SIMULATE 账户（重置模拟盘后账号会变，2026-10-24 为 2926355）；有多个时用 --acc-id 指定
UNDERLYING = 'US.TQQQ'
INIT_USD = 51000.0             # 用户 2026-10-25：三个策略统一 $5.1 万本金（20% 期权额度够买 4 张平值远月 Call）
MONTHLY_USD = 3000 / 7.8
STRIKE_RATIO = 1.02
STRIKE_BAND = 0.05              # 行权价在目标 ±5% 内按价差最小挑
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


H21_STOCK = 0.8                # 假设 21：80% TQQQ + 20% 平值 LEAPS，换仓时再平衡


def new_h21(today):
    """假设 21 子账本：股票池与期权池分开记现金（定投按 80/20 拆分），持股与合约各自记"""
    return {'invested': INIT_USD, 'cash_stock': INIT_USD * H21_STOCK, 'cash_opt': INIT_USD * (1 - H21_STOCK),
            'contributions': [{'d': today, 'usd': INIT_USD}], 'shares': 0, 'option': None, 'started': False}


def new_state(today):
    sleeve = lambda: {'invested': INIT_USD, 'cash': INIT_USD, 'contributions': [{'d': today, 'usd': INIT_USD}], 'started': False}
    return {'created': today, 'last_month_funded': today[:7],
            'H20': {**sleeve(), 'shares': 0},
            'H19': {**sleeve(), 'option': None},  # option: {code, strike, expiry, qty}
            'H21': new_h21(today),
            'H22': new_h22(today)}


# 假设 22：TQQQ 按波动调仓位。目标仓位 = min(上限, 80% ÷ TQQQ 近 20 日年化波动)，按 0.1 倍取整，
# 偏离目标 ≥ 0.1 倍才调仓。上限 1.2 倍：按实盘 3 倍 ETF 常见 75% 维持保证金（最多 1.33 倍）留缓冲（用户 2026-10-26：按实盘限制跑）
H22_TARGET_VOL = 0.80
H22_CAP = 1.2
H22_STEP = 0.1
H22_MAINT = 0.75               # 权益/持仓市值 低于它 → 当天强制降到 1 倍（模拟追保）


def new_h22(today):
    return {'invested': INIT_USD, 'cash': INIT_USD, 'shares': 0, 'contributions': [{'d': today, 'usd': INIT_USD}],
            'started': False, 'target': None, 'borrowed_interest': 0.0}


def migrate(s, today):
    """旧状态文件（只有 H19/H20）补上假设 21；各子账本改用自己的 started 标记决定是否建仓"""
    if 'H21' not in s:
        s['H21'] = new_h21(today)
        log(f'新增子账本：H21（${INIT_USD:,.0f}，股票池 ${INIT_USD * H21_STOCK:,.0f} + 期权池 ${INIT_USD * (1 - H21_STOCK):,.0f}）')
    if 'H22' not in s:
        s['H22'] = new_h22(today)
        log(f'新增子账本：H22（${INIT_USD:,.0f}，TQQQ 按波动调仓位，最多 {H22_CAP} 倍）')
    for k in ('H19', 'H20'):
        s[k].setdefault('started', bool(s.get('last_run')))
    return s


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
        """最远到期日（须 >2 年）的 Call。行权价：在 spot×1.02 的 ±5% 范围内选买卖价差（占中间价比例）最小、且有报价和未平仓的那张；
        范围内都没有有效报价时，退回最接近 spot×1.02 的那张（用户 2026-10-25 确认：实测 C68 未平仓 87、价差约 10%，C70 未平仓 563、约 6%）"""
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
        near = ch[ch['dist'] <= target * STRIKE_BAND]
        pick = None
        if not near.empty:
            snap = self.snapshot(near['code'].tolist())
            cands = []
            for code in near['code']:
                x = snap[code]
                bid, ask, oi = float(x['bid_price'] or 0), float(x['ask_price'] or 0), float(x.get('option_open_interest') or 0)
                if bid > 0 and ask > bid and oi > 0:
                    cands.append(((ask - bid) / ((ask + bid) / 2), -oi, code))
            if cands:
                cands.sort()
                pick = cands[0][2]
                log(f"选合约：目标行权价 {target:.2f}，±{STRIKE_BAND:.0%} 内价差最小 → {pick}（价差 {cands[0][0]:.1%}，未平仓 {-cands[0][1]:.0f}）")
        best = ch[ch['code'] == pick].iloc[0] if pick else ch.iloc[0]
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


def plan_h21(b, s, today, spot, ask, funding, may_buy):
    """假设 21：股票池买整股；期权池攒够 1 张就买（建仓或加买同一张）；换仓日卖 Call → 再平衡回 80/20 → 买新 Call"""
    h = s['H21']
    add_s = MONTHLY_USD * H21_STOCK if funding else 0
    add_o = MONTHLY_USD * (1 - H21_STOCK) if funding else 0
    opt = h['option']
    if opt and today >= roll_date(opt['expiry']):
        nxt = b.far_call(spot, today)
        if nxt['expiry'] <= opt['expiry']:
            raise RuntimeError(f"H21 到了换仓日但最远到期 {nxt['expiry']} 不晚于现持 {opt['expiry']}，不换仓，需人工检查期权链")
        return [('H21_ROLL', f"H21 换仓：卖出 {opt['qty']} 张 {opt['code']} → 再平衡回 80/20 → 买 {nxt['code']}（到期 {nxt['expiry']}）")]
    if not may_buy:
        return [('H21_WAIT', f"H21 今天不是建仓/定投/换仓日，不动（股票池 ${h['cash_stock']:,.2f}，期权池 ${h['cash_opt']:,.2f}）")]
    acts = []
    cs, co = h['cash_stock'] + add_s, h['cash_opt'] + add_o
    k = math.floor(cs / (ask * 1.004))
    acts.append(('H21_STOCK', f'H21 股票池买 {k} 股 TQQQ（可用 ${cs:,.2f}）', k) if k > 0 else ('H21_WAIT', f'H21 股票池 ${cs:,.2f} 不够 1 股'))
    tgt = b.far_call(spot, today) if not opt else {k2: opt[k2] for k2 in ('code', 'strike', 'expiry')}
    oask = float(b.snapshot([tgt['code']])[tgt['code']]['ask_price'] or 0)
    n = math.floor(co / (oask * 100 + 1)) if oask > 0 else 0
    acts.append(('H21_OPT', f"H21 期权池{'加买' if opt else '建仓'} {n} 张 {tgt['code']}（卖价 {oask}，可用 ${co:,.2f}）", n, tgt) if n > 0
                else ('H21_WAIT', f'H21 期权池 ${co:,.2f} 不够 1 张（约 ${oask * 100:,.0f}），继续攒'))
    return acts


def h21_rebalance_and_buy(b, s, today):
    """换仓日：Call 已卖完、钱在期权池 → 按当前价把总资产调回 80/20（卖或买 TQQQ 整股）→ 期权池买新的最远 Call"""
    h = s['H21']
    snap = b.snapshot([UNDERLYING])[UNDERLYING]
    bid, ask = float(snap['bid_price'] or 0), float(snap['ask_price'] or 0)
    total = h['cash_stock'] + h['cash_opt'] + h['shares'] * bid
    want = total * H21_STOCK
    have = h['shares'] * bid + h['cash_stock']
    log(f"H21 再平衡：总资产 ${total:,.2f}，目标股票 ${want:,.2f}，当前股票+股票池 ${have:,.2f}")
    if have > want:  # 股票多了：先用股票池现金补期权池，不够再卖股
        move = min(h['cash_stock'], have - want); h['cash_stock'] -= move; h['cash_opt'] += move
        sell = math.floor((have - want - move) / bid) if bid > 0 else 0
        if sell > 0:
            r = chase(b, UNDERLYING, TrdSide.SELL, sell, False, 'H21 rebalance sell')
            h['shares'] -= r['filled']; h['cash_opt'] += r['filled'] * r['avg'] - (r['fee'] or 0)
    else:            # 股票少了：从期权池拨钱到股票池再买整股
        move = min(h['cash_opt'], want - have); h['cash_opt'] -= move; h['cash_stock'] += move
        k = math.floor(h['cash_stock'] / (ask * 1.004)) if ask > 0 else 0
        if k > 0:
            r = chase(b, UNDERLYING, TrdSide.BUY, k, False, 'H21 rebalance buy')
            h['shares'] += r['filled']; h['cash_stock'] -= r['filled'] * r['avg'] + (r['fee'] or 0)
    save_state(s)
    spot = float(snap['last_price'])
    tgt = b.far_call(spot, today)
    oask = float(b.snapshot([tgt['code']])[tgt['code']]['ask_price'] or 0)
    n = math.floor(h['cash_opt'] / (oask * 100 + 1)) if oask > 0 else 0
    if n > 0:
        h21_buy_opt(b, s, n, tgt)


def h21_buy_opt(b, s, n, tgt):
    h = s['H21']
    r = chase(b, tgt['code'], TrdSide.BUY, n, True, 'H21 LEAPS buy')
    if r['filled'] > 0:
        o = h['option'] or {'code': tgt['code'], 'strike': tgt['strike'], 'expiry': tgt['expiry'], 'qty': 0}
        o['qty'] += r['filled']; h['option'] = o
        h['cash_opt'] -= r['filled'] * r['avg'] * 100 + (r['fee'] or 0)
    save_state(s)


def tqqq_vol20(b, today):
    """TQQQ 近 20 个交易日年化波动（用截至昨天的复权日收盘，今天盘中的价格不进入计算，与回测"收盘出信号"一致）"""
    start = (datetime.fromisoformat(today) - timedelta(days=45)).strftime('%Y-%m-%d')
    r, k, _ = b.q.request_history_kline(UNDERLYING, start=start, end=today, ktype=KLType.K_DAY, autype=AuType.QFQ, max_count=60)
    if r != RET_OK or len(k) < 22:
        raise RuntimeError(f'TQQQ 日线不足，无法算波动：{k if r != RET_OK else len(k)}')
    closes = [float(c) for d, c in zip(k['time_key'], k['close']) if str(d)[:10] < today][-21:]
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    m = sum(rets) / len(rets)
    return math.sqrt(sum((x - m) ** 2 for x in rets) / (len(rets) - 1) * 252)


def plan_h22(b, s, today, spot, bid, ask, funding):
    """假设 22：每天算目标仓位；偏离 ≥ 0.1 倍、或新月份定投、或第一次建仓时调仓到目标（整股）；
    权益/持仓 < 75% 时当天强制降到 1 倍。负现金 = 融资借款，按 3 个月国库券 + 2.5% 在状态里计利息（回测口径）"""
    h = s['H22']
    vol = tqqq_vol20(b, today)
    target = min(H22_CAP, round(H22_TARGET_VOL / vol / H22_STEP) * H22_STEP)
    cash = h['cash'] + (MONTHLY_USD if funding else 0)
    pos_v = h['shares'] * spot
    equity = cash + pos_v
    cur = pos_v / equity if equity > 0 else 0
    margin_call = h['shares'] > 0 and cur > 1 and (equity / pos_v) < H22_MAINT
    if margin_call:
        target = 1.0
    drift = abs(cur - target) >= H22_STEP - 1e-9
    if not (drift or funding or not h.get('started') or margin_call):
        return [('H22_WAIT', f'H22 不调仓：TQQQ 20 日波动 {vol:.0%} → 目标 {target:.1f} 倍，当前 {cur:.2f} 倍（偏离 < {H22_STEP} 倍）')]
    want = math.floor(equity * target / (ask if target * equity > pos_v else bid))
    d = want - int(h['shares'])
    why = '追保强平' if margin_call else ('建仓' if not h.get('started') else ('定投' if funding else '偏离目标'))
    if d == 0:
        return [('H22_WAIT', f'H22 {why}：目标 {target:.1f} 倍，股数已对上')]
    return [('H22_TRADE', f"H22 {why}：TQQQ 20 日波动 {vol:.0%} → 目标 {target:.1f} 倍（当前 {cur:.2f} 倍），{'买' if d > 0 else '卖'} {abs(d)} 股", d, target, vol)]


def plan(b, s, today, force_buy=False):
    """根据子账本与实时行情给出今天要做的动作（只读，不下单）。返回 (动作列表, 是否本月首次入账)"""
    acts = []
    snap = b.snapshot([UNDERLYING])[UNDERLYING]
    spot = float(snap['last_price'])
    ask = float(snap['ask_price'] or 0) or spot
    funding = s['last_month_funded'] != today[:7]
    add = MONTHLY_USD if funding else 0
    if funding:
        acts.append(('FUND', f'新月份：四个子账本各入账定投 ${MONTHLY_USD:.2f}（H21 按 80/20 分进股票池/期权池）'))
    # 只在三种日子买入：该子账本第一次运行（建仓）、每月首个交易日（定投）、换仓日。其他日子即使有零头现金也不买
    may = lambda k: funding or force_buy or not s[k].get('started')
    acts += plan_h21(b, s, today, spot, ask, funding, may('H21'))
    acts += plan_h22(b, s, today, spot, float(snap['bid_price'] or 0) or spot, ask, funding)
    may_buy = may('H20')
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
    may_buy = may('H19')
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


# ---------- 邮件汇报（Resend REST API，复用 backend/.env 的 RESEND_API_KEY 与 ADMIN_EMAIL；用户 2026-10-26 确认 7 个节点）----------
def _env(key):
    v = os.environ.get(key)
    if v:
        return v
    f = os.path.join(HERE, '..', '..', '.env')
    if os.path.exists(f):
        for line in open(f, encoding='utf-8-sig'):
            if line.startswith(key + '='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    return None


def notify(subject, lines):
    """发一封管理员邮件；失败只记日志不抛出（汇报失败不能阻断交易）。返回是否发出"""
    import html as _h
    import urllib.request
    import urllib.error
    key, to = _env('RESEND_API_KEY'), _env('ADMIN_EMAIL')
    if not key or not to:
        log(f'邮件未发（缺 RESEND_API_KEY 或 ADMIN_EMAIL）：{subject}')
        return False
    body = ''.join(f'<p style="font-size:13px;line-height:1.7;margin:4px 0;font-family:monospace">{_h.escape(l)}</p>' for l in lines)
    payload = {'from': _env('RESEND_FROM') or 'Stock Sentinel <onboarding@resend.dev>', 'to': to,
               'subject': f'【股哨兵模拟盘】{subject}', 'html': f'<div style="max-width:720px">{body}<p style="color:#888;font-size:12px">模拟盘（SIMULATE）自动汇报，非投资建议。</p></div>'}
    req = urllib.request.Request('https://api.resend.com/emails', data=json.dumps(payload).encode(), method='POST',
                                 headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
                                          'User-Agent': 'stock-sentinel-paper/1.0'})  # 默认 Python-urllib UA 会被 Resend 前置防火墙 403
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ok = 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        log(f'邮件发送失败：HTTP {e.code} {e.read().decode("utf-8", "replace")[:200]}'); ok = False
    except Exception as e:
        log(f'邮件发送失败：{e}'); ok = False
    append_log({'email': subject, 'ok': ok})
    log(('已发邮件：' if ok else '邮件失败：') + subject)
    return ok


def summary_lines(b, s):
    """五个子账本（目前四个）按总资产降序的一页摘要"""
    o19, o21 = s['H19']['option'], s['H21']['option']
    codes = list({UNDERLYING, *(o['code'] for o in (o19, o21) if o)})
    snap = b.snapshot(codes)
    px = float(snap[UNDERLYING]['last_price'])
    ov = lambda o: float(snap[o['code']]['last_price']) * 100 * o['qty'] if o else 0
    h21, h22 = s['H21'], s['H22']
    rows = [
        ('假设19 远月Call 100%', s['H19']['invested'], s['H19']['cash'] + ov(o19)),
        ('假设20 TQQQ 买持', s['H20']['invested'], s['H20']['cash'] + s['H20']['shares'] * px),
        ('假设21 TQQQ80%+Call20%', h21['invested'], h21['cash_stock'] + h21['cash_opt'] + h21['shares'] * px + ov(o21)),
        ('假设22 TQQQ 按波动调仓位', h22['invested'], h22['cash'] + h22['shares'] * px),
    ]
    if s.get('H23'):
        h23 = s['H23']; mp = h23.get('_px') or 0
        rows.append(('假设23 MNQ期货 按波动调仓位', h23['invested'], h23['cash'] + h23['qty'] * (mp - h23['avg']) * 2.0 if mp else h23['cash']))
    rows.sort(key=lambda r: -r[2])
    out = [f'TQQQ 现价 ${px:.2f}', '排名 | 策略 | 已投入 | 总资产 | 收益率']
    out += [f'{i + 1} | {n} | ${inv:,.0f} | ${v:,.0f} | {v / inv - 1:+.2%}' for i, (n, inv, v) in enumerate(rows)]
    out.append(f"假设22 当前杠杆 {h22['shares'] * px / max(h22['cash'] + h22['shares'] * px, 1e-9):.2f} 倍，累计融资利息 ${h22.get('borrowed_interest', 0):,.2f}")
    return out, rows


def h22_accrue(s, today):
    """H22 子账本现金为负 = 融资借款：从上次计息日到今天，按 (3 个月国库券约 4% + 2.5%) 年化计息扣在子账本里。
    模拟盘券商对整个账户计不计利息与子账本无关；这里按实盘口径自己记，评估时和回测可比"""
    h = s['H22']
    last = h.get('interest_to') or today
    days = (datetime.fromisoformat(today) - datetime.fromisoformat(last)).days
    if days > 0 and h['cash'] < 0:
        i = -h['cash'] * (0.04 + 0.025) * days / 365
        h['cash'] -= i
        h['borrowed_interest'] = h.get('borrowed_interest', 0) + i
    h['interest_to'] = today


def execute(b, s, today, acts, funding):
    if funding:
        for k in ('H20', 'H19'):
            s[k]['cash'] += MONTHLY_USD
            s[k]['invested'] += MONTHLY_USD
            s[k]['contributions'].append({'d': today, 'usd': MONTHLY_USD})
        h = s['H21']
        h['cash_stock'] += MONTHLY_USD * H21_STOCK; h['cash_opt'] += MONTHLY_USD * (1 - H21_STOCK)
        h['invested'] += MONTHLY_USD; h['contributions'].append({'d': today, 'usd': MONTHLY_USD})
        h2 = s['H22']; h2['cash'] += MONTHLY_USD; h2['invested'] += MONTHLY_USD; h2['contributions'].append({'d': today, 'usd': MONTHLY_USD})
        s['last_month_funded'] = today[:7]
        save_state(s)
    h22_accrue(s, today)
    for a in acts:
        if a[0] == 'H22_TRADE':
            d = a[2]
            r = chase(b, UNDERLYING, TrdSide.BUY if d > 0 else TrdSide.SELL, abs(d), False, f'H22 vol-target {a[3]:.1f}x')
            q = r['filled'] if d > 0 else -r['filled']
            s['H22']['shares'] += q
            s['H22']['cash'] -= q * r['avg'] + (r['fee'] or 0)
            s['H22']['target'] = a[3]
            save_state(s)
        elif a[0] == 'H21_STOCK':
            r = chase(b, UNDERLYING, TrdSide.BUY, a[2], False, 'H21 TQQQ 80%')
            s['H21']['shares'] += r['filled']
            s['H21']['cash_stock'] -= r['filled'] * r['avg'] + (r['fee'] or 0)
            save_state(s)
        elif a[0] == 'H21_OPT':
            h21_buy_opt(b, s, a[2], a[3])
        elif a[0] == 'H21_ROLL':
            o = s['H21']['option']
            r = chase(b, o['code'], TrdSide.SELL, int(o['qty']), True, 'H21 roll sell')
            s['H21']['cash_opt'] += r['filled'] * r['avg'] * 100 - (r['fee'] or 0)
            o['qty'] -= r['filled']
            if o['qty'] <= 0:
                s['H21']['option'] = None
            save_state(s)
            if s['H21']['option'] is None:  # 旧合约卖完才再平衡、买新的
                h21_rebalance_and_buy(b, s, today)
    for k in ('H19', 'H20', 'H21', 'H22'):
        s[k]['started'] = True
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
                spot = float(b.snapshot([UNDERLYING])[UNDERLYING]['last_price'])
                tgt = b.far_call(spot, today)
                oask = float(b.snapshot([tgt['code']])[tgt['code']]['ask_price'] or 0)
                n = math.floor(s['H19']['cash'] / (oask * 100 + 1)) if oask > 0 else 0
                if n > 0:
                    execute(b, s, today, [('H19_BUY', 'H19 换仓买入', n, tgt)], False)
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
        log(f'子账本：尚未初始化（第一次 run 时建立，三个策略各 ${INIT_USD:,.0f}）')
        return
    s = migrate(s, today_et())
    o19, o21 = s['H19']['option'], s['H21']['option']
    codes = list({UNDERLYING, *(o['code'] for o in (o19, o21) if o)})
    snap = b.snapshot(codes)
    px = float(snap[UNDERLYING]['last_price'])
    ov = lambda o: float(snap[o['code']]['last_price']) * 100 * o['qty'] if o else 0
    h21 = s['H21']
    rows = [
        ('H19 远月 Call+定投', s['H19'], s['H19']['cash'] + ov(o19), f"合约 {o19['qty']} 张 {o19['code']}（换仓日 {roll_date(o19['expiry'])}）" if o19 else '尚无合约'),
        ('H20 TQQQ 买持+定投', s['H20'], s['H20']['cash'] + s['H20']['shares'] * px, f"持股 {s['H20']['shares']}"),
        ('H21 TQQQ 80%+Call 20%', h21, h21['cash_stock'] + h21['cash_opt'] + h21['shares'] * px + ov(o21),
         f"持股 {h21['shares']}，" + (f"合约 {o21['qty']} 张 {o21['code']}（换仓日 {roll_date(o21['expiry'])}）" if o21 else '尚无合约')
         + f"，股票池 ${h21['cash_stock']:,.2f} 期权池 ${h21['cash_opt']:,.2f}"),
        ('H22 TQQQ 按波动调仓位', s['H22'], s['H22']['cash'] + s['H22']['shares'] * px,
         f"持股 {s['H22']['shares']}，当前 {(s['H22']['shares'] * px) / max(s['H22']['cash'] + s['H22']['shares'] * px, 1e-9):.2f} 倍（目标 {s['H22'].get('target') or '-'}），现金 ${s['H22']['cash']:,.2f}" + (f"（融资中，累计利息 ${s['H22'].get('borrowed_interest', 0):,.2f}）" if s['H22']['cash'] < 0 else '')),
    ]
    for name, sl, v, detail in rows:
        log(f"{name}：已投入 ${sl['invested']:,.2f}  市值 ${v:,.2f}  收益 {v / sl['invested'] - 1:+.2%}  | {detail}")
    if h21['shares'] or o21:
        stock_v = h21['shares'] * px + h21['cash_stock']
        tot = stock_v + h21['cash_opt'] + ov(o21)
        log(f"  H21 当前比例：股票 {stock_v / tot:.1%} / 期权 {(tot - stock_v) / tot:.1%}（目标 80/20，只在换仓日调整）")
    # 对账：H20 与 H21 都持 TQQQ，H19 与 H21 可能持同一张 Call → 按代码汇总后与券商比
    need = {UNDERLYING: s['H20']['shares'] + h21['shares'] + s['H22']['shares']}
    for o in (o19, o21):
        if o:
            need[o['code']] = need.get(o['code'], 0) + o['qty']
    bad = [f"{c} 券商 {pos.get(c, 0)} < 账本合计 {q}" for c, q in need.items() if q and pos.get(c, 0) < q]
    log('对账：' + ('一致' if not bad else '不一致 → ' + '；'.join(bad)))
    return bad


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


def run_h23_safe(s, today, submit, force=False):
    """假设 23（期货账户）单独执行：出错只发失败邮件、不影响另外四个策略；反过来股票侧失败也不拦它。返回对账问题列表"""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)  # python -I 不把脚本目录放进 sys.path
    from moomoo_paper_fut import run_h23
    try:
        acts, fills = run_h23(s, today, MONTHLY_USD, INIT_USD, log, append_log, save_state, submit=submit, force=force)
        for x in acts:
            log(('' if submit else '计划：') + x)
        return [x for x in acts if '对账不一致' in x]
    except Exception as e:
        log(f'H23 执行失败：{e}')
        if submit:
            notify('假设23（期货）执行失败', [f'日期 {today}', f'错误：{e}', '另外四个策略不受影响，照常执行。'])
        return []


def report(b, s, today, acts, funding, prev, n_orders0, bad):
    """按用户 2026-10-26 确认的节点发邮件：首次成交 / 月度定投 / 期权换仓 / 风险预警 / 执行异常 / 假设22 调仓"""
    new = []
    if os.path.exists(LOG_F):
        with open(LOG_F, encoding='utf-8') as f:
            new = [json.loads(l) for i, l in enumerate(f) if i >= n_orders0]
    fills = [r for r in new if r.get('order_id') and r.get('filled')]
    lines, rows = summary_lines(b, s)
    fill_lines = [f"{r['remark']} | {r['side']} {r['filled']:g}/{r['qty']:g} {r['code']} @ {r['avg']} | 中间价 {r['mid']:.3f} 偏离 "
                  + ('—' if r.get('slip_vs_mid') is None else f"{r['slip_vs_mid'] * 100:+.2f}%") + f" | 费用 {r.get('fee')}" for r in fills]
    unfilled = [r for r in new if r.get('order_id') and r.get('filled', 0) < r.get('qty', 0)]
    first = [k for k, was in prev['firsts'].items() if not was and s.get(k, {}).get('started')]
    if first and fills:
        notify(f"首次建仓完成（{'、'.join(first)}）", [f'日期 {today}'] + lines + ['— 成交明细 —'] + fill_lines)
    elif funding and fills:
        notify(f'{today[:7]} 月度定投完成', [f'日期 {today}'] + lines + ['— 成交明细 —'] + fill_lines)
    elif any(a[0] in ('H19_ROLL', 'H21_ROLL') for a in acts):
        notify('期权换仓完成', [f'日期 {today}'] + [a[1] for a in acts if a[0].endswith('ROLL')] + lines + ['— 成交明细 —'] + fill_lines)
    elif any(a[0] == 'H22_TRADE' for a in acts):
        notify('假设22 调仓', [f'日期 {today}'] + [a[1] for a in acts if a[0] == 'H22_TRADE'] + fill_lines + lines)
    # 风险预警：单日（相对上次运行）总资产跌超 15%；假设22 权益/持仓 低于维持线 + 10 个百分点
    warn = []
    last = s.get('last_values') or {}
    for n, inv, v in rows:
        if last.get(n) and v < last[n] * 0.85:
            warn.append(f'{n} 总资产 ${v:,.0f}，较上次 ${last[n]:,.0f} 下跌 {v / last[n] - 1:.1%}')
    h22 = s['H22']; px = float(b.snapshot([UNDERLYING])[UNDERLYING]['last_price']); pv = h22['shares'] * px
    # 1.2 倍时权益/持仓≈83% 属正常；低于 78%（≈1.28 倍，再跌约 4% 就到 75% 维持线）才预警
    if pv > 0 and h22['cash'] < 0 and (h22['cash'] + pv) / pv < H22_MAINT + 0.03:
        warn.append(f"假设22 保证金缓冲不足：权益/持仓 {(h22['cash'] + pv) / pv:.1%}（维持线 {H22_MAINT:.0%}）")
    if any('追保强平' in a[1] for a in acts if a[0] == 'H22_TRADE'):
        warn.append('假设22 今天触发了追保强平（降到 1 倍）')
    if warn:
        notify('风险预警', [f'日期 {today}'] + warn + lines)
    if bad or unfilled:
        notify('对账不一致或订单未全部成交', [f'日期 {today}'] + bad + [f"未全成交：{r['code']} {r['filled']:g}/{r['qty']:g}" for r in unfilled])
    s['last_values'] = {n: v for n, inv, v in rows}
    save_state(s)


def h23_only_report(s, today, prev, n_orders0, bad):
    """股票侧没跑（休市/已执行/失败）时，单独汇报假设 23 的成交与对账"""
    new = []
    if os.path.exists(LOG_F):
        with open(LOG_F, encoding='utf-8') as f:
            new = [json.loads(l) for i, l in enumerate(f) if i >= n_orders0]
    fills = [f"{r['remark']} | {r['side']} {r['filled']:g}/{r['qty']:g} {r['code']} @ {r['avg']} | 费用 {r.get('fee')}"
             for r in new if r.get('order_id') and r.get('filled')]
    unfilled = [f"未全成交：{r['code']} {r['filled']:g}/{r['qty']:g}" for r in new if r.get('order_id') and r.get('filled', 0) < r.get('qty', 0)]
    if fills:
        first = not prev['firsts'].get('H23') and s.get('H23', {}).get('started')
        notify('首次建仓完成（H23）' if first else '假设23 调仓', [f'日期 {today}'] + fills)
    if bad or unfilled:
        notify('对账不一致或订单未全部成交', [f'日期 {today}'] + bad + unfilled)


def main():
    ap = argparse.ArgumentParser(description='Moomoo 模拟盘：假设 19 / 20 / 21 / 22（只用 SIMULATE）')
    ap.add_argument('cmd', choices=['status', 'plan', 'run', 'smoke'])
    ap.add_argument('--submit', action='store_true', help='run 时真正向模拟盘下单；不带则只打印计划')
    ap.add_argument('--force', action='store_true', help='休市时也尝试（只用于调试；休市挂单会排到下个交易日）')
    ap.add_argument('--acc-id', type=int, help='模拟账户号（默认自动选唯一的美股模拟账户）')
    a = ap.parse_args()
    b = Broker(a.acc_id)
    log(f'使用模拟账户 {ACC_ID}（SIMULATE）')
    stock_err = None
    try:
        today = today_et()
        s = load_state()
        if s is not None:
            s = migrate(s, today)
        if a.cmd == 'status':
            status(b, s)
            if HERE not in sys.path:
                sys.path.insert(0, HERE)
            from moomoo_paper_fut import status_h23
            status_h23(s, log); return
        if a.cmd == 'smoke':
            smoke(b); return
        if s is None:
            s = new_state(today)
            log(f'初始化子账本：H19、H20、H21、H22 各 ${INIT_USD:,.0f}')
            if a.cmd == 'run' and a.submit:
                save_state(s)
        if a.cmd == 'plan' or not a.submit:
            acts, funding = plan(b, s, today)
            for x in acts:
                log('计划：' + x[1])
            run_h23_safe(s, today, submit=False)
            log('（未下单；加 run --submit 执行）'); return
        prev = {'firsts': {k: s.get(k, {}).get('started') for k in ('H19', 'H20', 'H21', 'H22', 'H23')}}
        n_orders0 = sum(1 for _ in open(LOG_F, encoding='utf-8')) if os.path.exists(LOG_F) else 0
        # 股票/期权（H19–H22）按美股常规时段；期货（H23）按 CME 时段（在 run_h23 里判断）。两边互不阻断
        stock_done = False
        try:
            if s.get('last_run') == today and not a.force:
                log(f'今天（{today}）已经执行过，不重复下单')
            elif not b.market_open() and not a.force:
                log('美股当前不在常规交易时段，股票/期权今天不下单（计划任务应设在美东 9:45 之后）')
            else:
                acts, funding = plan(b, s, today)
                for x in acts:
                    log('计划：' + x[1])
                execute(b, s, today, acts, funding)
                stock_done = True
        except Exception as e:
            # 节点 5：执行失败（OpenD 掉线、下单失败、期权链异常……）当天发邮件
            stock_err = e
            log(f'执行失败：{e}')
            notify('执行失败，需要人工检查', [f'日期 {today}', f'错误：{e}',
                   '股票/期权部分已停止，今天未完成的动作明天会重新判断；假设23（期货）照常单独判断。'])
        bad = run_h23_safe(s, today, submit=True, force=a.force)
        if stock_done:
            report(b, s, today, acts, funding, prev, n_orders0, status(b, s) + bad)
        else:
            h23_only_report(s, today, prev, n_orders0, bad)
        if stock_err:
            raise stock_err
    except Exception as e:
        # 股票侧失败已在上面发过邮件；这里只管启动阶段（读账本、迁移……）的失败
        if e is not stock_err:
            log(f'执行失败：{e}')
            if a.cmd == 'run' and a.submit:
                notify('执行失败，需要人工检查', [f'日期 {today_et()}', f'错误：{e}', '脚本已停止，今天未完成的动作明天会重新判断。'])
        raise
    finally:
        b.close()


if __name__ == '__main__':
    main()
