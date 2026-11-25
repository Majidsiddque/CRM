import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signs the RAW request body with HMAC-SHA256 using the webhook secret
 * and sends the hex digest in the X-Razorpay-Signature header.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on length mismatch, so check first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PaymentLink {
  id: string;
  short_url: string;
  amount: number;
  currency: string;
  status: string;
}

export interface CreateLinkInput {
  instituteId: string;
  amountPaise: number;
  description: string;
}

/**
 * Creates a payment link through the Razorpay API. Refuses to run with
 * anything but TEST keys (rzp_test_...), so this experiment can never move
 * real money.
 */
export async function createTestPaymentLink(input: CreateLinkInput): Promise<PaymentLink> {
  const keyId = process.env.RAZORPAY_KEY_ID ?? '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
  const base = process.env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com';

  if (!keyId.startsWith('rzp_test_')) {
    throw new Error('RAZORPAY_KEY_ID must be a test-mode key (rzp_test_...)');
  }
  if (!keySecret) throw new Error('RAZORPAY_KEY_SECRET is not set');

  const res = await fetch(`${base}/v1/payment_links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
    },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: 'INR',
      description: input.description,
      // Notes come back in the webhook, which is how we know whose payment it is.
      notes: { institute_id: input.instituteId },
    }),
  });
  if (!res.ok) {
    throw new Error(`Razorpay returned HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PaymentLink;
}
