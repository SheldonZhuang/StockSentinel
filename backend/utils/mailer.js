import { Resend } from 'resend';

const SIGNAL_LABELS = {
  attack: '🟢 进攻 Attack',
  neutral: '🟡 观望 Watch',
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
 *   details: { monetary, fiscal, admin, aiSupply, fiscalDeficitChangePct, epuTradePercentile,
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
    }
  }

  const fmt = (v, suffix = '%') => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}${suffix}`);
  const statusRows = [
    ['货币政策 Monetary', details.monetary],
    ['财政政策 Fiscal', details.fiscal, details.fiscalDeficitChangePct !== undefined ? `赤字TTM同比 Deficit YoY ${fmt(details.fiscalDeficitChangePct)}` : ''],
    ['行政政策 Administrative', details.admin, details.epuTradePercentile !== undefined && details.epuTradePercentile !== null ? `贸易不确定性 EPU P${Number(details.epuTradePercentile).toFixed(0)}` : ''],
    ['AI供需 AI Supply/Demand', details.aiSupply, details.semiIpYoy !== undefined ? `半导体产出 Semi IP ${fmt(details.semiIpYoy)}` : ''],
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
  if (dim === 'fiscal') s = fmt(d.fiscalDeficitChangePct) && `赤字TTM同比 ${fmt(d.fiscalDeficitChangePct)}`;
  if (dim === 'admin') s = d.epuTradePercentile != null ? `贸易不确定性10年 P${Number(d.epuTradePercentile).toFixed(0)}` : null;
  if (dim === 'monetary') s = d.rateChangeBp != null ? `利率变动 ${d.rateChangeBp}bp` : null;
  if (dim === 'aiSupply') s = fmt(d.smhSpyRelReturnPct) && `SMH−SPY ${fmt(d.smhSpyRelReturnPct)}`;
  return s ? `（${s}）` : '';
}

/**
 * 向所有订阅用户发送示警邮件
 * @param {Array<{email: string}>} subscribers
 * @param {object} payload - 见 buildAlertEmail
 */
export async function sendSignalAlert(subscribers, payload) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('re_placeholder')) {
    console.warn('[mailer] RESEND_API_KEY not configured, skipping email alerts');
    return;
  }

  const resend = new Resend(apiKey);
  const { subject, html } = buildAlertEmail(payload);
  // 未在 Resend 验证自有域名前，只能用其测试域发件（且只能发给账号注册邮箱）；
  // 验证域名后改回自有域，如 alerts@stocksentinel.app
  const from = process.env.RESEND_FROM || 'Stock Sentinel <onboarding@resend.dev>';

  const results = await Promise.allSettled(
    subscribers.map(sub =>
      resend.emails.send({ from, to: sub.email, subject, html })
    )
  );

  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`[mailer] ${failed}/${subscribers.length} emails failed to send`);
  }
}
