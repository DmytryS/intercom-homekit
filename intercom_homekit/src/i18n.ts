/**
 * Texts users see outside the logs: Home Assistant entity names, HomeKit tile names and the
 * pairing page. The Configuration tab is translated by Home Assistant (translations/*.yaml) and
 * logs stay in English, so they can be searched and shared in issues.
 *
 * To add a language: add it to LANGUAGES and give it a table with every key of `en` (the compiler
 * checks), add it to `system.language` in config.yaml, and add translations/<code>.yaml.
 */

export type Language = 'en' | 'uk';
export const LANGUAGES: Language[] = ['en', 'uk'];

const en = {
  // Home Assistant entities
  'entity.call_state': 'Call state',
  'entity.open_door': 'Open door',
  'entity.open_door_n': 'Open door {n}',
  'entity.hang_up': 'Hang up',
  'entity.reject_call': 'Reject call',
  'entity.take_snapshot': 'Take snapshot',
  'entity.snapshot': 'Snapshot',
  'entity.speaker_volume': 'Speaker volume',
  'entity.talk_volume': 'Talk volume',
  'entity.microphone_volume': 'Microphone volume',
  'entity.restart': 'Restart',
  'entity.test_ring': 'Test ring',
  'entity.connection': 'Connection',
  'entity.video_streams': 'Video streams',
  'entity.logged_in_clients': 'Logged-in clients',
  'entity.talk_back': 'Talk-back',
  'entity.live_views': 'HomeKit live views',
  'entity.homekit_paired': 'HomeKit paired',
  // HomeKit lock tiles
  'homekit.door': 'Door',
  'homekit.door_n': 'Door {n}',
  // Pairing page ("Open Web UI")
  'page.title': '{name} – HomeKit pairing',
  'page.doorbells': 'Doorbells',
  'page.starting': 'Starting… no doorbell is running yet. Check the add-on log if this stays.',
  'page.paired': '✓ Paired with Apple Home',
  'page.paired_hint':
    'To pair it with another home, remove “{name}” in the Home app (or turn on its <code>reset_homekit_pairing</code> and restart the add-on); this page then shows the code again.',
  'page.step_open': 'On your iPhone or iPad open <b>Home</b> → <b>+</b> → <b>Add Accessory</b>.',
  'page.step_scan': 'Scan this code with the camera, or tap <b>More options…</b>, pick “{name}” and enter <b>{code}</b>.',
  'page.open_home': 'Open in the Home app',
  'page.open_home_hint': '(when viewing this page on the iPhone or iPad itself)',
} as const;

export type TextKey = keyof typeof en;

const uk: Record<TextKey, string> = {
  'entity.call_state': 'Стан виклику',
  'entity.open_door': 'Відчинити двері',
  'entity.open_door_n': 'Відчинити двері {n}',
  'entity.hang_up': 'Завершити виклик',
  'entity.reject_call': 'Відхилити виклик',
  'entity.take_snapshot': 'Зробити знімок',
  'entity.snapshot': 'Знімок',
  'entity.speaker_volume': 'Гучність динаміка',
  'entity.talk_volume': 'Гучність розмови',
  'entity.microphone_volume': 'Гучність мікрофона',
  'entity.restart': 'Перезапустити',
  'entity.test_ring': 'Тестовий дзвінок',
  'entity.connection': 'Підключення',
  'entity.video_streams': 'Відеопотоки',
  'entity.logged_in_clients': 'Підключені клієнти',
  'entity.talk_back': 'Голосовий зв’язок',
  'entity.live_views': 'Трансляції HomeKit',
  'entity.homekit_paired': 'Додано в HomeKit',
  'homekit.door': 'Двері',
  'homekit.door_n': 'Двері {n}',
  'page.title': '{name} – підключення до HomeKit',
  'page.doorbells': 'Дверні дзвінки',
  'page.starting': 'Запуск… жоден дверний дзвінок ще не працює. Якщо це повідомлення не зникає, перегляньте журнал додатка.',
  'page.paired': '✓ Додано до програми «Дім»',
  'page.paired_hint':
    'Щоб додати його до іншого дому, видаліть «{name}» у програмі «Дім» (або ввімкніть <code>reset_homekit_pairing</code> і перезапустіть додаток); тоді тут знову з’явиться код.',
  'page.step_open': 'На iPhone або iPad відкрийте <b>Дім</b> → <b>+</b> → <b>Додати аксесуар</b>.',
  'page.step_scan': 'Відскануйте цей код камерою або торкніться <b>Інші параметри…</b>, виберіть «{name}» і введіть <b>{code}</b>.',
  'page.open_home': 'Відкрити в програмі «Дім»',
  'page.open_home_hint': '(якщо ця сторінка відкрита на самому iPhone чи iPad)',
};

const TABLES: Record<Language, Record<TextKey, string>> = { en, uk };

/** The text in `lang`, with `{placeholders}` filled in. Values are inserted as they are: escape HTML first. */
export function t(lang: Language, key: TextKey, vars: Record<string, string | number> = {}): string {
  return TABLES[lang][key].replace(/\{(\w+)\}/g, (m, v: string) => (v in vars ? String(vars[v]) : m));
}

export function isLanguage(v: unknown): v is Language {
  return LANGUAGES.includes(v as Language);
}

/** First supported language in an Accept-Language header (by preference), else `fallback`. */
export function pickLanguage(acceptLanguage: string | undefined, fallback: Language): Language {
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().toLowerCase().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.trim().slice(2) ?? 1);
      return { lang: tag.split('-')[0], q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked.map((x) => x.lang).find(isLanguage) ?? fallback;
}
