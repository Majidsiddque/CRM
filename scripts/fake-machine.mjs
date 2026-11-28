// Attendance machine simulator (ZKTeco/eSSL-style push device).
//
//   node scripts/fake-machine.mjs [baseUrl] [serial] [options]
//
// Options (all optional):
//   --clock-offset-minutes=N  machine clock is N minutes ahead (+) or behind (-)
//   --live=N                  send N separate single punches, one per second (live pushes)
//   --backlog=N               send ONE upload of N punches from ~3 hours ago (after an outage)
//   --twice                   send the same upload a second time (duplicate / re-send)
//
// With no options it sends a normal 3-punch upload.
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const base = positional[0] ?? 'http://127.0.0.1:3000';
const sn = positional[1] ?? 'FAKE-0001';
const offsetMs = flag('clock-offset-minutes', 0) * 60_000;
const live = flag('live', 0);
const backlog = flag('backlog', 0);
const twice = args.includes('--twice');
const tz = process.env.DEVICE_TIMEZONE ?? 'Asia/Kolkata';

// The machine prints its own wall-clock time, in its own timezone.
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: tz,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});
const stamp = (ms) => fmt.format(new Date(ms));
// PIN, time, status, verify, workcode, reserved1, reserved2
const line = (pin, ms) => [pin, stamp(ms), 0, 1, 0, 0, 0].join('\t');

let failed = false;
async function upload(body) {
  const res = await fetch(`${base}/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=9999`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) failed = true;
  console.log(`upload: HTTP ${res.status} body=${JSON.stringify(text)}`);
}

const hs = await fetch(`${base}/iclock/cdata?SN=${sn}&options=all&pushver=2.4.1`);
console.log(`handshake: HTTP ${hs.status}`);
console.log(`machine clock offset: ${offsetMs / 60_000} min, timezone: ${tz}`);

if (live > 0) {
  for (let i = 0; i < live; i++) {
    const body = line(101, Date.now() + offsetMs) + '\n';
    console.log('live punch:', body.trim().replaceAll('\t', ' '));
    await upload(body);
    await sleep(1100); // machine time has 1-second resolution
  }
} else {
  const now = Date.now();
  let body;
  if (backlog > 0) {
    // Punches made during an outage, sent ~3 hours later, one per minute.
    const start = now + offsetMs - 3 * 3_600_000;
    body = Array.from({ length: backlog }, (_, i) => line(100 + (i % 5), start + i * 60_000)).join('\n') + '\n';
    console.log(`backlog of ${backlog} punches, from ${stamp(start)} onwards`);
  } else {
    body = [101, 102, 103].map((pin, i) => line(pin, now + offsetMs + i * 1000)).join('\n') + '\n';
    console.log('sent:\n' + body.replaceAll('\t', ' '));
  }
  await upload(body);
  if (twice) {
    console.log('sending the exact same upload again...');
    await upload(body);
  }
}

const poll = await fetch(`${base}/iclock/getrequest?SN=${sn}`);
console.log(`getrequest: HTTP ${poll.status} body=${JSON.stringify(await poll.text())}`);
process.exit(failed ? 1 : 0);