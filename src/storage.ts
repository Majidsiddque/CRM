import { createHash, createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import type { Router } from 'express';
import type pg from 'pg';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();

function config() {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION ?? 'ap-south-1';
  const access = process.env.S3_ACCESS_KEY_ID;
  const secret = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !access || !secret) throw new Error('object storage is not configured');
  return { endpoint: new URL(endpoint), bucket, region, access, secret };
}

function signedUrl(method: 'GET', key: string, expires: number): string {
  const c = config();
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const host = c.endpoint.host;
  const path = `${c.endpoint.pathname.replace(/\/$/, '')}/${c.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${c.access}/${scope}`,
    'X-Amz-Date': date, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
  const kDate = hmac(`AWS4${c.secret}`, day);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `${c.endpoint.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function videoRoutes(pool: pg.Pool): Router {
  const r = express.Router();
  const requireOps = (req: express.Request, res: express.Response): boolean => {
    const token = process.env.OPS_TOKEN;
    if (!token || req.header('x-ops-token') !== token) {
      res.status(401).json({ error: 'valid x-ops-token required' });
      return false;
    }
    return true;
  };
  r.post('/api/videos', (req, res, next) => requireOps(req, res) ? next() : undefined,
    express.raw({ type: () => true, limit: '50mb', inflate: false }), async (req, res) => {
    let c: pg.PoolClient | undefined;
    try {
      const mime = req.header('content-type') ?? '';
      if (!mime.startsWith('video/')) { res.status(415).json({ error: 'content-type must be video/*' }); return; }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) { res.status(400).json({ error: 'video body is required' }); return; }
      const max = Number(process.env.STORAGE_LIMIT_BYTES ?? 524288000);
      c = await pool.connect();
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(804211)');
      const usage = await c.query('select used_bytes from storage_usage where id = 1 for update');
      const used = Number(usage.rows[0]?.used_bytes ?? 0);
      if (used + body.length > max) {
        await c.query('rollback'); c.release(); c = undefined;
        res.status(413).json({ error: 'storage limit reached', usedBytes: used, limitBytes: max }); return;
      }
      const key = `videos/${randomUUID()}`;
      const cfg = config();
      const path = `${cfg.endpoint.pathname.replace(/\/$/, '')}/${cfg.bucket}/${key}`;
      const put = new URL(path, cfg.endpoint.origin);
      const payloadHash = sha(body);
      const now = new Date();
      const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const day = date.slice(0, 8);
      const scope = `${day}/${cfg.region}/s3/aws4_request`;
      const host = put.host;
      const headers = `content-type:${mime}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
      const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
      const canonical = ['PUT', put.pathname, '', headers, signedHeaders, payloadHash].join('\n');
      const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
      const kd = hmac(`AWS4${cfg.secret}`, day), kr = hmac(kd, cfg.region), ks = hmac(kr, 's3'), signing = hmac(ks, 'aws4_request');
      const signature = createHmac('sha256', signing).update(stringToSign).digest('hex');
      const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      const response = await fetch(put, { method: 'PUT', body: new Uint8Array(body), headers: {
        'content-type': mime, 'x-amz-date': date, 'x-amz-content-sha256': payloadHash, authorization,
      } });
      if (!response.ok) throw new Error(`storage upload returned HTTP ${response.status}`);
      const saved = await c.query('insert into video_objects (object_key, size_bytes, content_type) values ($1,$2,$3) returning id', [key, body.length, mime]);
      await c.query('update storage_usage set used_bytes = used_bytes + $1 where id = 1', [body.length]);
      await c.query('commit');
      c.release(); c = undefined;
      res.status(201).json({ id: saved.rows[0]?.id, key, sizeBytes: body.length, playUrl: signedUrl('GET', key, 300), expiresInSeconds: 300 });
    } catch (e) {
      await c?.query('rollback').catch(() => undefined);
      c?.release();
      res.status(500).json({ error: (e as Error).message });
    }
  });
  r.get('/api/videos/:id/play', (req, res, next) => requireOps(req, res) ? next() : undefined, async (req, res) => {
    const result = await pool.query('select object_key from video_objects where id = $1', [req.params.id]).catch(() => ({ rows: [] }));
    if (!result.rows[0]) { res.status(404).json({ error: 'video not found' }); return; }
    try { res.json({ url: signedUrl('GET', String(result.rows[0].object_key), 300), expiresInSeconds: 300 }); }
    catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });
  return r;
}
