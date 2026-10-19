import { describe, expect, it } from '@jest/globals';
import { emptyAlertState, isPermanent, planBackupAlert, WEEK_MS, type BackupFailure } from './alert-state.js';

const T0 = 1_800_000_000_000;
const D = 24 * 3_600_000;
const auth = (id: number): BackupFailure => ({ id, who: `1.1.1.${id}, @u${id}`, detail: 'All configured authentication methods failed' });
const timeout = (id: number): BackupFailure => ({ id, who: `2.2.2.${id}, @t${id}`, detail: 'Timed out while waiting for handshake' });

describe('planBackupAlert', () => {
  it('постоянный сбой сообщается сразу, один раз', () => {
    const a = planBackupAlert(emptyAlertState(), [auth(1)], T0 + 0);
    expect(a.text).toContain('#1');
    const b = planBackupAlert(a.next, [auth(1)], T0 + D);
    expect(b.text).toBeNull(); // на следующий день — тишина
    const c = planBackupAlert(b.next, [auth(1)], T0 + 2 * D);
    expect(c.text).toBeNull();
  });

  it('временный сбой молчит с первого раза и сообщается со второго подряд', () => {
    const a = planBackupAlert(emptyAlertState(), [timeout(2)], T0 + 0);
    expect(a.text).toBeNull();
    const b = planBackupAlert(a.next, [timeout(2)], T0 + D);
    expect(b.text).toContain('#2');
  });

  it('разовый таймаут, который прошёл, не оставляет следа', () => {
    const a = planBackupAlert(emptyAlertState(), [timeout(3)], T0 + 0);
    const b = planBackupAlert(a.next, [], T0 + D);
    expect(b.text).toBeNull();
    expect(b.next.failing).toEqual({});
  });

  it('починившийся узел, о котором сообщали, получает одно «снова работает»', () => {
    const a = planBackupAlert(emptyAlertState(), [auth(4)], T0 + 0);
    const b = planBackupAlert(a.next, [], T0 + D);
    expect(b.text).toContain('снова работает');
    expect(b.text).toContain('#4');
    expect(planBackupAlert(b.next, [], T0 + 2 * D).text).toBeNull();
  });

  it('в новом списке сообщается только новый узел, старые не повторяются', () => {
    const a = planBackupAlert(emptyAlertState(), [auth(1)], T0 + 0);
    const b = planBackupAlert(a.next, [auth(1), auth(5)], T0 + D);
    expect(b.text).toContain('#5');
    expect(b.text).not.toContain('#1 ');
  });

  it('раз в неделю — одна короткая сводка про то, что всё ещё лежит', () => {
    let s = planBackupAlert(emptyAlertState(), [auth(1), auth(2)], T0 + 0).next;
    for (let d = 1; d < 7; d++) {
      const r = planBackupAlert(s, [auth(1), auth(2)], T0 + d * D);
      expect(r.text).toBeNull();
      s = r.next;
    }
    const w = planBackupAlert(s, [auth(1), auth(2)], T0 + WEEK_MS + 1);
    expect(w.text).toContain('2 узлов');
    expect(w.text!.split('\n').length).toBe(1);
  });
});

describe('isPermanent', () => {
  it('различает неверный пароль и сетевой таймаут', () => {
    expect(isPermanent('All configured authentication methods failed')).toBe(true);
    expect(isPermanent('Timed out while waiting for handshake')).toBe(false);
    expect(isPermanent('connect EHOSTUNREACH 1.2.3.4:22')).toBe(false);
  });
});
