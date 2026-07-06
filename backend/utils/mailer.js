import { Resend } from 'resend';

const SIGNAL_LABELS = {
  attack: '🟢 进攻 Attack',
  neutral: '🟡 中性 Neutral',
  defense: '🔴 防守 Defense',
};

/**
 * 向所有订阅用户发送信号变更提醒
 * @param {Array<{email: string}>} subscribers
 * @param {string} oldSignal
 * @param {string} newSignal
 */
export async function sendSignalAlert(subscribers, oldSignal, newSignal) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('re_placeholder')) {
    console.warn('[mailer] RESEND_API_KEY not configured, skipping email alerts');
    return;
  }

  const resend = new Resend(apiKey);
  const subject = `股哨兵信号变更：${SIGNAL_LABELS[oldSignal]} → ${SIGNAL_LABELS[newSignal]}`;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a;">📡 股哨兵信号变更</h2>
      <p style="font-size: 16px; color: #444;">
        美股信号档位已从 <strong>${SIGNAL_LABELS[oldSignal]}</strong>
        切换至 <strong style="font-size: 20px;">${SIGNAL_LABELS[newSignal]}</strong>
      </p>
      <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 20px 0;" />
      <p style="font-size: 13px; color: #888;">
        本邮件由股哨兵自动发送。如需关闭提醒，请登录后在设置中关闭。
      </p>
    </div>
  `;

  const results = await Promise.allSettled(
    subscribers.map(sub =>
      resend.emails.send({
        from: 'Stock Sentinel <alerts@noreply.stocksentinel.app>',
        to: sub.email,
        subject,
        html,
      })
    )
  );

  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`[mailer] ${failed}/${subscribers.length} emails failed to send`);
  }
}
