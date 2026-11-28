import express from 'express';
import type { Request, Router } from 'express';
import type pg from 'pg';
import { processRawPunch } from './attendance.js';

// The device's serial number identifies it. ZKTeco/eSSL-style machines send it
// as ?SN=... ; our simulator and other devices may use an x-device-serial header.
function deviceSerial(req: Request): string | null {
  const q = req.query.SN ?? req.query.sn;
  const value = typeof q === 'string' ? q : req.header('x-device-serial');
  const trimmed = value?.trim().slice(0, 100);
  return trimmed ? trimmed : null;
}

export function machineRoutes(pool: pg.Pool): Router {
  const router = express.Router();

  // Handshake: the machine asks "what are my settings?" when it starts up.
  router.get('/iclock/cdata', (req, res) => {
    const sn = deviceSerial(req) ?? '';
    res
      .type('text/plain')
      .send(
        [
          `GET OPTION FROM: ${sn}`,
          'ATTLOGStamp=None',
          'OPERLOGStamp=9999',
          'ErrorDelay=30',
          'Delay=10',
          'TransTimes=00:00;14:00',
          'TransInterval=1',
          'TransFlag=TransData AttLog',
          'Realtime=1',
          'Encrypt=0',
          '',
        ].join('\n'),
      );
  });

  // The machine also polls "any commands for me?". We have none.
  router.get('/iclock/getrequest', (_req, res) => {
    res.type('text/plain').send('OK');
  });

  // Receiving route. express.raw keeps the exact bytes (inflate: false so even a
  // compressed body is stored as sent). The machine only deletes its own copy of
  // the punches when it gets "OK" back, so we answer OK only after the insert
  // has succeeded, and 500 otherwise so the machine keeps and re-sends them.
  router.post(
    ['/iclock/cdata', '/machine/punches'],
    express.raw({ type: () => true, limit: '5mb', inflate: false }),
    async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const saved = await pool.query(
          `insert into raw_punches
             (device_serial, method, url, source_ip, headers, body)
           values ($1, $2, $3, $4, $5::jsonb, $6)
           returning id`,
          [
            deviceSerial(req),
            req.method,
            req.originalUrl,
            req.socket.remoteAddress ?? null,
            JSON.stringify(req.headers),
            body,
          ],
        );
        // The raw copy is safe, so the machine gets OK even if turning it into
        // clean punches fails; `npm run machine:reprocess` retries those later.
        try {
          await processRawPunch(pool, (saved.rows[0] as { id: string }).id);
        } catch (e) {
          console.error('punch processing failed (raw is saved):', (e as Error).message);
        }
        res.type('text/plain').send('OK');
      } catch (e) {
        console.error('raw punch insert failed:', (e as Error).message);
        res.status(500).type('text/plain').send('ERROR');
      }
    },
  );

  return router;
}