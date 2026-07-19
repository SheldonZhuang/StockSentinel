import { Resend } from 'resend';

const SIGNAL_LABELS = {
  attack: '🟢 进攻 Attack',
  neutral: '🟡 观望 Watch',
  reduce: '🟠 减仓观望 Reduce',
  defense: '🔴 防守 Defense',
  loose: '宽松 Loose',
  tight: '收紧 Tight',
};

const DIM_LABELS = {
  monetary: '货币政策 Monetary',
  fiscal: '财政政策 Fiscal',
  admin: '行政政策 Administrative',
  aiSupply: 'AI供需 AI Supply/Demand',
};

const BUBBLE_REASON_LABELS = {
  modelUsage: '模型调用量下滑 Model usage declining',
  capex: '云厂商资本开支同比转负 Hyperscaler capex YoY negative',
};

/**
 * 生成示警邮件的主题与正文（导出供单测）
 * @param {object} payload - { finalSignal, changes, details }
 *   changes: detectSignalChanges() 的输出
 *   details: { monetary, fiscal, admin, aiSupply, fiscalOutlaysChangePct, epuTradePercentile,
 *              smhSpyRelReturnPct, semiIpYoy, modelUsageTrendPct, capexYoY }
 */
export function buildAlertEmail(payload) {
  const { finalSignal, changes, details = {} } = payload;

  const lines = [];
  for (const c of changes) {
    if (c.kind === 'final') {
      lines.push(`⚡ 最终信号变更 Signal changed: <strong>${SIGNAL_LABELS[c.from]}</strong> → <strong>${SIGNAL_LABELS[c.to]}</strong>`);
    } else if (c.kind === 'dimTight') {
      lines.push(`🔴 ${DIM_LABELS[c.dim]} 转为收紧 turned TIGHT${dimDetail(c.dim, details)}`);
    } else if (c.kind === 'bubble') {
      const reasons = (c.reasons || []).map(r => BUBBLE_REASON_LABELS[r] || r).join('；');
      lines.push(`⚠️ AI泡沫预警触发 Bubble warning triggered：${reasons}`);
    } else if (c.kind === 'sahmLockOn') {
      const sahmStr = details.sahmValue != null ? `（当前值 ${Number(details.sahmValue).toFixed(2)}）` : '';
      lines.push(`🔴 萨姆规则触发，进入衰退防守锁定 Sahm Rule triggered, recession defense lock activated${sahmStr}`);
    } else if (c.kind === 'sahmLockOff') {
      lines.push(`🟢 萨姆规则衰退防守锁定已解除 Sahm Rule recession defense lock released`);
    } else if (c.kind === 'reactiveAdjustmentLockOn') {
      const bpStr = c.bp != null ? `（单次调整 ${c.bp}bp）` : '';
      lines.push(`🔴 应对式利率调整触发，进入衰退防守锁定 Reactive rate adjustment triggered, recession defense lock activated${bpStr}`);
    } else if (c.kind === 'reactiveAdjustmentLockOff') {
      lines.push(`🟢 应对式利率调整防守锁定已解除 Reactive rate adjustment defense lock released`);
    }
  }

  const fmt = (v, suffix = '%') => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}${suffix}`);
  // 顺序遵循策略主线：长线看供需（AI供需），短线看政策（货币/财政/行政）
  const statusRows = [
    ['AI供需 AI Supply/Demand', details.aiSupply, details.semiIpYoy !== undefined ? `半导体产出 Semi IP ${fmt(details.semiIpYoy)}` : ''],
    ['货币政策 Monetary', details.monetary],
    ['财政政策 Fiscal', details.fiscal, details.fiscalOutlaysChangePct != null ? `联邦支出TTM同比 Outlays YoY ${fmt(details.fiscalOutlaysChangePct)}` : ''],
    ['行政政策 Administrative', details.admin, [
      details.oilChange30dPct != null && Math.abs(details.oilChange30dPct) >= 20 ? `WTI 30D ${fmt(details.oilChange30dPct)}` : null,
      details.epuTradePercentile != null ? `贸易不确定性 EPU P${Number(details.epuTradePercentile).toFixed(0)}` : null,
    ].filter(Boolean).join(' · ')],
  ];

  const subject = `股哨兵示警 Stock Sentinel Alert：当前 ${SIGNAL_LABELS[finalSignal] || finalSignal}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">📡 股哨兵示警 Stock Sentinel Alert</h2>
      <p style="font-size: 18px; color: #222;">当前信号 Current signal：<strong>${SIGNAL_LABELS[finalSignal] || finalSignal}</strong></p>
      <h3 style="color: #333; font-size: 14px;">变化原因 What changed</h3>
      <ul style="font-size: 14px; color: #444; line-height: 1.8;">
        ${lines.map(l => `<li>${l}</li>`).join('')}
      </ul>
      <h3 style="color: #333; font-size: 14px;">四维现状 Current positions</h3>
      <table style="font-size: 13px; color: #444; border-collapse: collapse;">
        ${statusRows.map(([label, sig, extra]) => `
          <tr>
            <td style="padding: 4px 12px 4px 0;">${label}</td>
            <td style="padding: 4px 12px 4px 0;"><strong>${SIGNAL_LABELS[sig] || sig || '—'}</strong></td>
            <td style="padding: 4px 0; color: #888;">${extra || ''}</td>
          </tr>`).join('')}
      </table>
      <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 20px 0;" />
      <p style="font-size: 12px; color: #888;">
        本邮件由股哨兵自动发送，登录后可在导航栏关闭提醒。<br/>
        Sent automatically by Stock Sentinel. Log in to toggle alerts in the navbar.
      </p>
    </div>
  `;
  return { subject, html };
}

function dimDetail(dim, d) {
  const fmt = v => (v === null || v === undefined ? null : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
  let s = null;
  if (dim === 'fiscal') s = fmt(d.fiscalOutlaysChangePct) && `联邦支出TTM同比 ${fmt(d.fiscalOutlaysChangePct)}`;
  if (dim === 'admin') {
    // 油价事件层触发时优先展示触发源，否则展示EPU百分位（与前端维度卡同语义）
    if (d.oilChange30dPct != null && Math.abs(d.oilChange30dPct) >= 20) {
      s = `WTI 30D ${fmt(d.oilChange30dPct)}`;
    } else {
      s = d.epuTradePercentile != null ? `贸易不确定性10年 P${Number(d.epuTradePercentile).toFixed(0)}` : null;
    }
  }
  if (dim === 'monetary') s = d.rateChangeBp != null ? `利率变动 ${d.rateChangeBp}bp` : null;
  if (dim === 'aiSupply') s = fmt(d.smhSpyRelReturnPct) && `SMH−SPY ${fmt(d.smhSpyRelReturnPct)}`;
  return s ? `（${s}）` : '';
}

/**
 * 向所有订阅用户发送示警邮件。失败重试：转防守/转收紧是产品最贵的一类通知，
 * Resend 瞬时抖动不应导致永久漏报（快照已落库，次日 detectSignalChanges 不会再报同一变化）。
 * 对失败的收件人做有限次退避重试；全部失败时以 error 级别记录（可被日志告警捕获）。
 * @param {Array<{email: string}>} subscribers
 * @param {object} payload - 见 buildAlertEmail
 * @returns {Promise<{sent:number, failed:number}>}
 */
export async function sendSignalAlert(subscribers, payload) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('re_placeholder')) {
    console.warn('[mailer] RESEND_API_KEY not configured, skipping email alerts');
    return { sent: 0, failed: 0 };
  }

  const resend = new Resend(apiKey);
  const { subject, html } = buildAlertEmail(payload);
  // 未在 Resend 验证自有域名前，只能用其测试域发件（且只能发给账号注册邮箱）；
  // 验证域名后改回自有域，如 alerts@stocksentinel.app
  const from = process.env.RESEND_FROM || 'Stock Sentinel <onboarding@resend.dev>';

  let pending = subscribers.slice();
  let sent = 0;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length; attempt++) {
    const results = await Promise.allSettled(
      pending.map(sub => resend.emails.send({ from, to: sub.email, subject, html }))
    );
    const stillFailing = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') sent++;
      else stillFailing.push(pending[i]);
    });
    pending = stillFailing;
    if (pending.length && attempt < MAX_ATTEMPTS) {
      const backoffMs = 1000 * attempt; // 1s, 2s 退避，跨过 Resend 短时抖动
      await new Promise(res => setTimeout(res, backoffMs));
    }
  }

  const failed = pending.length;
  if (failed === subscribers.length && subscribers.length > 0) {
    console.error(`[mailer] ALL ${subscribers.length} alert emails failed after ${MAX_ATTEMPTS} attempts — signal change may go unnotified`);
  } else if (failed > 0) {
    console.warn(`[mailer] ${failed}/${subscribers.length} emails still failed after retries`);
  }
  return { sent, failed };
}

/**
 * S5 执行指令邮件（仅发管理员）：进攻/防守边界变化时的具体操作指令。
 * S5策略（docs/s5-execution-playbook.md）：进入defense=存量TQQQ全部卖出；
 * 退出defense（含到reduce）=立即全额买回。命门是"退出即买回"，故独立成一封高优邮件。
 * @param {object} p - { kind: 'enterDefense'|'exitDefense', from, to, dataDate }
 */
export function buildS5ActionEmail(p) {
  const isEnter = p.kind === 'enterDefense';
  const subject = isEnter
    ? '🔴【S5执行】进入全面防守——存量TQQQ应全部卖出'
    : '🟢【S5执行】防守解除——应立即全额买回TQQQ';
  const action = isEnter
    ? '按 S5 规则：<strong>今日卖出全部 TQQQ 存量转入现金</strong>；本月起新定投资金进入现金储备。'
    : `按 S5 规则：<strong>今日立即一次性全额买回 TQQQ</strong>（即使当前档位只是恢复到"${SIGNAL_LABELS[p.to] || p.to}"也要买回——等待恢复观望是被回测否决的做法，XIRR 37.0%→18.2%）。历史提示：买回发生在V型反弹中，分批只会越买越贵。<br/><span style="color:#b45309">CAPE估值层已启用：买回前查看S5执行台的当前目标仓位（CAPE&gt;90分位时为55%而非100%）。</span>`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">${isEnter ? '🔴' : '🟢'} S5 执行指令 · ${p.dataDate || ''}</h2>
      <p style="font-size: 15px; color: #222;">档位变化：<strong>${SIGNAL_LABELS[p.from] || p.from}</strong> → <strong>${SIGNAL_LABELS[p.to] || p.to}</strong></p>
      <p style="font-size: 15px; color: #222; line-height: 1.7;">${action}</p>
      <p style="font-size: 12px; color: #888; margin-top: 20px;">
        26年日度回测：仅9次此类操作，假信号4次（小额踏空）、真信号5次（躲掉-87%/-50%/-33%/-20%/-19%）——
        "高频小输、低频巨赢"，机械执行是本方案的全部前提。详见 docs/s5-execution-playbook.md。<br/>
        本邮件仅发送给管理员。仅供研究参考，不构成投资建议。
      </p>
    </div>`;
  return { subject, html };
}

/** 发送 S5 执行指令给管理员（单收件人，复用重试语义） */
export async function sendS5ActionAlert(adminEmail, payload) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('re_placeholder') || !adminEmail) {
    console.warn('[mailer] S5 action alert skipped (no RESEND_API_KEY or admin email)');
    return { sent: 0, failed: 0 };
  }
  const resend = new Resend(apiKey);
  const { subject, html } = buildS5ActionEmail(payload);
  const from = process.env.RESEND_FROM || 'Stock Sentinel <onboarding@resend.dev>';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await resend.emails.send({ from, to: adminEmail, subject, html });
      return { sent: 1, failed: 0 };
    } catch (err) {
      if (attempt === 3) {
        console.error('[mailer] S5 action email failed after 3 attempts:', err.message);
        return { sent: 0, failed: 1 };
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}
