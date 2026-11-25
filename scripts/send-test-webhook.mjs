// Razorpay experiment demo: sends the SAME signed "payment_link.paid"
// confirmation twice and shows that only one payment is recorded.
//
//   RAZORPAY_WEBHOOK_SECRET=... node scripts/send-test-webhook.mjs [baseUrl]
//
// The secret must match the one the server was started with.
import { createHmac, randomUUID } from 'node:crypto';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const institute = process.env.INSTITUTE_ID ?? '11111111-1111-1111-1111-111111111111';
if (!secret) {
  console.error('Set RAZORPAY_WEBHOOK_SECRET (same value the server uses).');
  process.exit(1);
}

const paymentId = 'pay_demo_' + randomUUID().slice(0, 8);
const raw = JSON.stringify({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: 'plink_demo', notes: { institute_id: institute } } },
    payment: { entity: { id: paymentId, amount: 50000, currency: 'INR', status: 'captured' } },
  },
});
const headers = {
  'Content-Type': 'application/json',
  'X-Razorpay-Signature': createHmac('sha256', secret).update(raw).digest('hex'),
  'X-Razorpay-Event-Id': 'evt_demo_' + randomUUID().slice(0, 8),
};

for (const attempt of [1, 2]) {
  const res = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers, body: raw });
  console.log(`delivery ${attempt}: HTTP ${res.status}`, await res.json());
}

const list = await (await fetch(`${base}/api/payments?institute=${institute}`)).json();
const n = list.rows.filter((r) => r.razorpay_payment_id === paymentId).length;
console.log(`payments recorded for ${paymentId}: ${n}  ${n === 1 ? 'OK (exactly one)' : 'PROBLEM'}`);
process.exit(n === 1 ? 0 : 1);
