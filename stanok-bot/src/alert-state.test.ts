import { describe, expect, it } from '@jest/globals';
import { emptyAlertState, isPermanent, planBackupAlert, WEEK_MS, type BackupFailure } from './alert-state.js';

const T0 = 1_800_000_000_000;
const D = 24 * 3_600_000;
const auth = (id: number): BackupFailure => ({ id, who: `1.1.1.${id}, @u${id}`, detail: 'All configured authentication methods failed' });
const timeout = (id: number): BackupFailure => ({ id, who: `2.2.2.${id}, @t${id}`, detail: 'Timed out while waiting for handshake' });

describe('planBackupAlert', () => {
  it('никаких мгновенных сообщений: ни про новый сбой, ни про починку', () => {
    const a = planBackupAlert(emptyAlertState(), [auth(1)], T0);
    expect(a.text).toBeNull();
    const b = planBackupAlert(a.next, [], T0 + D);
    expect(b.text).toBeNull();
  });

  it('раз в неделю — одна короткая сводка про то, что всё ещё лежит', () => {
    let s = planBackupAlert(emptyAlertState(), [auth(1), auth(2)], T0).next;
    for (let d = 1; d < 7; d++) {
      const r = planBackupAlert(s, [auth(1), auth(2)], T0 + d * D);
      expect(r.text).toBeNull();
      s = r.next;
    }
    const w = planBackupAlert(s, [auth(1), auth(2)], T0 + WEEK_MS + 1);
    expect(w.text).toContain('2 узлов');
    expect(w.text).toContain('#1');
    expect(w.text).toContain('не авария');
    expect(w.text!.split('\n').length).toBe(1);
    // и сразу после сводки снова тишина
    expect(planBackupAlert(w.next, [auth(1), auth(2)], T0 + WEEK_MS + D).text).toBeNull();
  });

  it('сводка не приходит, если за неделю всё починилось', () => {
    const s = planBackupAlert(emptyAlertState(), [auth(1)], T0).next;
    const r = planBackupAlert(s, [], T0 + WEEK_MS + 1);
    expect(r.text).toBeNull();
  });

  it('разовый таймаут в сводку не попадает, повторный — попадает', () => {
    let s = planBackupAlert(emptyAlertState(), [timeout(3)], T0).next;
    expect(planBackupAlert(s, [], T0 + WEEK_MS + 1).text).toBeNull(); // прошёл
    s = planBackupAlert(emptyAlertState(), [timeout(3)], T0).next;
    s = planBackupAlert(s, [timeout(3)], T0 + D).next; // второй раз подряд
    expect(planBackupAlert(s, [timeout(3)], T0 + WEEK_MS + 1).text).toContain('#3');
  });

  it('первая сводка после выката не приходит сразу', () => {
    const r = planBackupAlert(emptyAlertState(), [auth(1)], T0 + 100 * D);
    expect(r.text).toBeNull();
    expect(r.next.lastDigest).toBe(T0 + 100 * D);
  });
});

describe('isPermanent', () => {
  it('различает неверный пароль и сетевой таймаут', () => {
    expect(isPermanent('All configured authentication methods failed')).toBe(true);
    expect(isPermanent('Timed out while waiting for handshake')).toBe(false);
    expect(isPermanent('connect EHOSTUNREACH 1.2.3.4:22')).toBe(false);
  });
});
