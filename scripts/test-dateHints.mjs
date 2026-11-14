// Quick sanity harness for lib/dateHints.ts (node --experimental-strip-types)
import { dateFromName, dateFromPath } from '../lib/dateHints.ts';

const cases = [
  ['2013-08-21-1651.jpg', '2013-08-21T16:51:00'],
  ['IMG_20170122_164939.jpg', '2017-01-22T16:49:00'],
  ['IMG20230708155116.jpg', '2023-07-08T15:51:00'],
  ['22 марта 2018 г. (1) (Часть 1).mp4', '2018-03-22T00:00:00'],
  ['IMG_2017-08-05_165738.jpg', '2017-08-05T16:57:00'],
  ['1627670003732.jpg', null],
  ['IMG_4510.HEIC', null],
  ['1_6.jpg', null],
  ['13.JPG', null],
  ['IMG_2022_0730_1545.jpg', '2022-07-30T15:45:00'],
  ['DSC_0001.JPG', null],
  ['2025_final.png', null],
];

let fail = 0;
for (const [name, expected] of cases) {
  const got = dateFromName(name);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(got).padEnd(10)} want ${String(expected).padEnd(10)} <- ${name}`);
}

const pathCases = [
  ['26.12.2020/IMG_4510.HEIC', '2020-12-26T00:00:00'],
  ['21.03.2022+женя/photo.jpg', '2022-03-21T00:00:00'],
  ['2025/IMG_4510.HEIC', '2025-01-01T00:00:00'],
  ['2017-2023/IMG_4510.HEIC', null],
  ['Есения/IMG_4510.HEIC', null],
];
for (const [p, expected] of pathCases) {
  const got = dateFromPath(p);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(got).padEnd(10)} want ${String(expected).padEnd(10)} <- ${p}`);
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
