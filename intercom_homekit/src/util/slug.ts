/**
 * Ukrainian (national system, 2010) and common Russian letters in Latin, so non-Latin doorbell
 * names still give distinct storage keys and Home Assistant entity ids. Second value: at the
 * start of a word.
 */
const CYRILLIC: Record<string, string | [string, string]> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: ['ie', 'ye'], ж: 'zh', з: 'z', и: 'y',
  і: 'i', ї: ['i', 'yi'], й: ['i', 'y'], к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ю: ['iu', 'yu'],
  я: ['ia', 'ya'], ь: '', ъ: '', ы: 'y', э: 'e', ё: 'io',
};
const APOSTROPHES = /['’ʼ`]/g;

export function transliterate(text: string): string {
  let out = '';
  let prev = '';
  for (const ch of text.normalize('NFC').toLowerCase().replace(APOSTROPHES, '')) {
    const m = CYRILLIC[ch];
    const wordStart = !/[\p{L}\p{N}]/u.test(prev);
    // "зг" is "zgh", so it isn't read as "zh".
    if (ch === 'г' && prev === 'з') out += 'gh';
    else out += m === undefined ? ch : Array.isArray(m) ? m[wordStart ? 1 : 0] : m;
    prev = ch;
  }
  return out;
}

/** Lower-case ASCII slug of a name, e.g. for storage keys. */
export function slug(name: string, separator = '-'): string {
  return (
    transliterate(name)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '') // accents: é → e
      .replace(/[^a-z0-9]+/g, separator)
      .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '') || 'doorbell'
  );
}
