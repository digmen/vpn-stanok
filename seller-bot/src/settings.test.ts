import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Настройки читают config, а он требует токен бота и папку данных. Подставляем их ДО импорта
// (динамического, иначе ESM поднимет модуль раньше) и уводим запись в временную папку,
// чтобы тест не трогал настоящие настройки владельца.
process.env.SELLER_BOT_TOKEN ??= '1:test';
process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'seller-test-'));

const { defaultPackages, isValidDays, isValidStars, normalize, packageLabel } = await import('./settings.js');
const { isNewer } = await import('./update.js');

// Тесты без зависимостей: `npm test` = tsx --test. Проверяем то, на чём легко потерять
// деньги владельца: миграцию его цены, валидацию ввода и сравнение версий при самообновлении.

test('старая цена владельца становится первым тарифом, а не теряется', () => {
  const pkgs = defaultPackages(50, 30);
  assert.equal(pkgs[0].days, 30);
  assert.equal(pkgs[0].stars, 50);
  assert.equal(pkgs.length, 3);
  assert.ok(pkgs[1].stars > pkgs[0].stars && pkgs[2].stars > pkgs[1].stars);
  assert.deepEqual(
    pkgs.map((p) => p.days),
    [30, 60, 90],
  );
});

test('битые настройки не роняют бота и не обнуляют тарифы', () => {
  assert.equal(normalize(null).packages.length, 3);
  assert.equal(normalize({ packages: [] }).packages.length, 3);
  assert.equal(normalize({ packages: [{ id: 'x', days: 0, stars: 5 }] }).packages.length, 3);

  const ok = normalize({ packages: [{ id: 'a', days: 7, stars: 25 }], trial: { enabled: true, days: 5 } });
  assert.equal(ok.packages.length, 1);
  assert.equal(ok.trial.enabled, true);
  assert.equal(ok.trial.days, 5);
});

test('приветствие обрезается, мусорные типы отбрасываются', () => {
  const s = normalize({ welcome: { text: 'x'.repeat(5000), photo: 42 } });
  assert.equal(s.welcome.text!.length, 800);
  assert.equal(s.welcome.photo, null);
});

test('валидация ввода владельца', () => {
  assert.ok(isValidStars(1) && isValidStars(100_000));
  assert.ok(!isValidStars(0) && !isValidStars(1.5) && !isValidStars(100_001) && !isValidStars(NaN));
  assert.ok(isValidDays(1) && isValidDays(3650));
  assert.ok(!isValidDays(0) && !isValidDays(4000));
});

test('склонение дней в подписи тарифа', () => {
  assert.equal(packageLabel({ id: 'a', days: 1, stars: 5 }), '1 день — 5 ⭐');
  assert.equal(packageLabel({ id: 'a', days: 3, stars: 5 }), '3 дня — 5 ⭐');
  assert.equal(packageLabel({ id: 'a', days: 30, stars: 5 }), '30 дней — 5 ⭐');
  assert.equal(packageLabel({ id: 'a', days: 11, stars: 5 }), '11 дней — 5 ⭐');
});

test('версии сравниваются по числам, а не по строкам', () => {
  assert.ok(isNewer('0.10.0', '0.9.0'));
  assert.ok(isNewer('0.2.0', '0.1.9'));
  assert.ok(!isNewer('0.2.0', '0.2.0'));
  assert.ok(!isNewer('0.1.0', '0.2.0'));
});
