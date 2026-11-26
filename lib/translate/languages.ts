/**
 * Languages Translate PDF offers: widely used world languages and all of
 * South Africa's official written languages. Plain data and code, no
 * imports: the page and the route both load it, and the route only ever
 * puts these names in a prompt, never text the page sent.
 */

/** Writing systems, for what the PDF font can draw and which way text runs. */
export type Script =
  | "Latin"
  | "Cyrillic"
  | "Greek"
  | "Devanagari"
  | "Arabic"
  | "Hebrew"
  | "Chinese"
  | "Japanese"
  | "Korean"
  | "Thai"
  | "Bengali"
  | "Tamil"
  | "Telugu"
  | "Kannada"
  | "Malayalam"
  | "Gujarati"
  | "Gurmukhi"
  | "Sinhala"
  | "Khmer"
  | "Burmese"
  | "Ethiopic"
  | "Georgian"
  | "Armenian";

export interface Language {
  /** BCP 47 tag, used in requests and set as the files' language. */
  code: string;
  /** English name, as the list shows it. */
  name: string;
  /** The language's own name for itself. */
  native: string;
  script: Script;
  /** Written right to left. */
  rtl?: boolean;
  /** Written without spaces between words, so split passages are joined without one. */
  noSpaces?: boolean;
  /** One of South Africa's official languages. */
  za?: boolean;
  /** Other names people search for it by. */
  aka?: string[];
  /** How the model is told the language when the name alone could mean another one. */
  prompt?: string;
}

const ALL: Language[] = [
  { code: "af", name: "Afrikaans", native: "Afrikaans", script: "Latin", za: true },
  { code: "sq", name: "Albanian", native: "Shqip", script: "Latin" },
  { code: "am", name: "Amharic", native: "አማርኛ", script: "Ethiopic" },
  { code: "ar", name: "Arabic", native: "العربية", script: "Arabic", rtl: true },
  { code: "hy", name: "Armenian", native: "Հայերեն", script: "Armenian" },
  { code: "az", name: "Azerbaijani", native: "Azərbaycanca", script: "Latin" },
  { code: "eu", name: "Basque", native: "Euskara", script: "Latin" },
  { code: "be", name: "Belarusian", native: "Беларуская", script: "Cyrillic" },
  { code: "bn", name: "Bengali", native: "বাংলা", script: "Bengali", aka: ["Bangla"] },
  { code: "bs", name: "Bosnian", native: "Bosanski", script: "Latin" },
  { code: "bg", name: "Bulgarian", native: "Български", script: "Cyrillic" },
  { code: "my", name: "Burmese", native: "မြန်မာ", script: "Burmese", noSpaces: true, aka: ["Myanmar"] },
  { code: "ca", name: "Catalan", native: "Català", script: "Latin" },
  { code: "ny", name: "Chichewa", native: "Chichewa", script: "Latin", aka: ["Nyanja", "Chewa"] },
  { code: "zh-Hans", name: "Chinese (Simplified)", native: "简体中文", script: "Chinese", noSpaces: true, aka: ["Mandarin"], prompt: "Chinese, in Simplified characters" },
  { code: "zh-Hant", name: "Chinese (Traditional)", native: "繁體中文", script: "Chinese", noSpaces: true, aka: ["Mandarin", "Cantonese", "Taiwanese"], prompt: "Chinese, in Traditional characters" },
  { code: "hr", name: "Croatian", native: "Hrvatski", script: "Latin" },
  { code: "cs", name: "Czech", native: "Čeština", script: "Latin" },
  { code: "da", name: "Danish", native: "Dansk", script: "Latin" },
  { code: "nl", name: "Dutch", native: "Nederlands", script: "Latin", aka: ["Flemish"] },
  { code: "en", name: "English", native: "English", script: "Latin", za: true },
  { code: "et", name: "Estonian", native: "Eesti", script: "Latin" },
  { code: "fil", name: "Filipino", native: "Filipino", script: "Latin", aka: ["Tagalog"] },
  { code: "fi", name: "Finnish", native: "Suomi", script: "Latin" },
  { code: "fr", name: "French", native: "Français", script: "Latin" },
  { code: "gl", name: "Galician", native: "Galego", script: "Latin" },
  { code: "ka", name: "Georgian", native: "ქართული", script: "Georgian" },
  { code: "de", name: "German", native: "Deutsch", script: "Latin" },
  { code: "el", name: "Greek", native: "Ελληνικά", script: "Greek" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", script: "Gujarati" },
  { code: "ha", name: "Hausa", native: "Hausa", script: "Latin" },
  { code: "he", name: "Hebrew", native: "עברית", script: "Hebrew", rtl: true },
  { code: "hi", name: "Hindi", native: "हिन्दी", script: "Devanagari" },
  { code: "hu", name: "Hungarian", native: "Magyar", script: "Latin" },
  { code: "is", name: "Icelandic", native: "Íslenska", script: "Latin" },
  { code: "ig", name: "Igbo", native: "Asụsụ Igbo", script: "Latin" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", script: "Latin" },
  { code: "ga", name: "Irish", native: "Gaeilge", script: "Latin", aka: ["Gaelic"] },
  { code: "it", name: "Italian", native: "Italiano", script: "Latin" },
  { code: "ja", name: "Japanese", native: "日本語", script: "Japanese", noSpaces: true },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", script: "Kannada" },
  { code: "kk", name: "Kazakh", native: "Қазақ тілі", script: "Cyrillic" },
  { code: "km", name: "Khmer", native: "ខ្មែរ", script: "Khmer", noSpaces: true, aka: ["Cambodian"] },
  { code: "rw", name: "Kinyarwanda", native: "Ikinyarwanda", script: "Latin" },
  { code: "ko", name: "Korean", native: "한국어", script: "Korean" },
  { code: "lv", name: "Latvian", native: "Latviešu", script: "Latin" },
  { code: "lt", name: "Lithuanian", native: "Lietuvių", script: "Latin" },
  { code: "mk", name: "Macedonian", native: "Македонски", script: "Cyrillic" },
  { code: "ms", name: "Malay", native: "Bahasa Melayu", script: "Latin" },
  { code: "ml", name: "Malayalam", native: "മലയാളം", script: "Malayalam" },
  { code: "mt", name: "Maltese", native: "Malti", script: "Latin" },
  { code: "mr", name: "Marathi", native: "मराठी", script: "Devanagari" },
  { code: "mn", name: "Mongolian", native: "Монгол", script: "Cyrillic" },
  { code: "ne", name: "Nepali", native: "नेपाली", script: "Devanagari" },
  { code: "nb", name: "Norwegian", native: "Norsk bokmål", script: "Latin", aka: ["Bokmål"] },
  { code: "ps", name: "Pashto", native: "پښتو", script: "Arabic", rtl: true },
  { code: "fa", name: "Persian", native: "فارسی", script: "Arabic", rtl: true, aka: ["Farsi"] },
  { code: "pl", name: "Polish", native: "Polski", script: "Latin" },
  { code: "pt-BR", name: "Portuguese (Brazil)", native: "Português (Brasil)", script: "Latin", prompt: "Brazilian Portuguese" },
  { code: "pt-PT", name: "Portuguese (Portugal)", native: "Português (Portugal)", script: "Latin", prompt: "European Portuguese" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", script: "Gurmukhi", aka: ["Panjabi"], prompt: "Punjabi, in Gurmukhi script" },
  { code: "ro", name: "Romanian", native: "Română", script: "Latin" },
  { code: "ru", name: "Russian", native: "Русский", script: "Cyrillic" },
  { code: "nso", name: "Sepedi", native: "Sepedi", script: "Latin", za: true, aka: ["Northern Sotho", "Sesotho sa Leboa", "Pedi"], prompt: "Sepedi (Northern Sotho, Sesotho sa Leboa)" },
  { code: "sr", name: "Serbian", native: "Српски", script: "Cyrillic", prompt: "Serbian, in Cyrillic script" },
  { code: "st", name: "Sesotho", native: "Sesotho", script: "Latin", za: true, aka: ["Southern Sotho", "Sotho"], prompt: "Sesotho (Southern Sotho), as written in South Africa" },
  { code: "tn", name: "Setswana", native: "Setswana", script: "Latin", za: true, aka: ["Tswana"], prompt: "Setswana (Tswana)" },
  { code: "sn", name: "Shona", native: "chiShona", script: "Latin" },
  { code: "si", name: "Sinhala", native: "සිංහල", script: "Sinhala", aka: ["Sinhalese"] },
  { code: "ss", name: "siSwati", native: "siSwati", script: "Latin", za: true, aka: ["Swati", "Swazi"], prompt: "siSwati (Swati)" },
  { code: "sk", name: "Slovak", native: "Slovenčina", script: "Latin" },
  { code: "sl", name: "Slovenian", native: "Slovenščina", script: "Latin" },
  { code: "so", name: "Somali", native: "Soomaali", script: "Latin" },
  { code: "es", name: "Spanish", native: "Español", script: "Latin" },
  { code: "sw", name: "Swahili", native: "Kiswahili", script: "Latin" },
  { code: "sv", name: "Swedish", native: "Svenska", script: "Latin" },
  { code: "ta", name: "Tamil", native: "தமிழ்", script: "Tamil" },
  { code: "te", name: "Telugu", native: "తెలుగు", script: "Telugu" },
  { code: "th", name: "Thai", native: "ไทย", script: "Thai", noSpaces: true },
  { code: "ve", name: "Tshivenda", native: "Tshivenḓa", script: "Latin", za: true, aka: ["Venda", "Tshivenḓa"], prompt: "Tshivenda (Venda)" },
  { code: "tr", name: "Turkish", native: "Türkçe", script: "Latin" },
  { code: "uk", name: "Ukrainian", native: "Українська", script: "Cyrillic" },
  { code: "ur", name: "Urdu", native: "اردو", script: "Arabic", rtl: true },
  { code: "uz", name: "Uzbek", native: "Oʻzbekcha", script: "Latin", prompt: "Uzbek, in Latin script" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", script: "Latin" },
  { code: "cy", name: "Welsh", native: "Cymraeg", script: "Latin" },
  { code: "ts", name: "Xitsonga", native: "Xitsonga", script: "Latin", za: true, aka: ["Tsonga", "Shangaan"], prompt: "Xitsonga (Tsonga)" },
  { code: "yo", name: "Yoruba", native: "Yorùbá", script: "Latin" },
  { code: "nr", name: "isiNdebele", native: "isiNdebele", script: "Latin", za: true, aka: ["Ndebele", "Southern Ndebele", "South Ndebele"], prompt: "isiNdebele (Southern Ndebele, as written in South Africa)" },
  { code: "xh", name: "isiXhosa", native: "isiXhosa", script: "Latin", za: true, aka: ["Xhosa"], prompt: "isiXhosa (Xhosa)" },
  { code: "zu", name: "isiZulu", native: "isiZulu", script: "Latin", za: true, aka: ["Zulu"], prompt: "isiZulu (Zulu)" },
];

/** By English name; isiZulu and the other isi- names sort under I, as they are written. */
export const LANGUAGES: Language[] = [...ALL].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** The language with this code, or undefined. */
export function languageByCode(code: string | null | undefined): Language | undefined {
  return code ? BY_CODE.get(code.trim().toLowerCase()) : undefined;
}

/** How the model is told the language. */
export function promptName(lang: Language): string {
  return lang.prompt ?? lang.name;
}

/** Writing systems the PDF font (Noto Sans) draws. Others come as a Word file only. */
export const PDF_SCRIPTS: Script[] = ["Latin", "Cyrillic", "Greek", "Devanagari"];

export function pdfSupported(lang: Language): boolean {
  return PDF_SCRIPTS.includes(lang.script);
}

const LETTERS: Partial<Record<Script, string>> = {
  Chinese: "Chinese characters",
  Japanese: "Japanese characters",
  Korean: "Korean letters",
};

/** Why a language comes as a Word file only, or null when it has a PDF too. */
export function docxOnlyReason(lang: Language): string | null {
  if (pdfSupported(lang)) return null;
  const letters = LETTERS[lang.script] ?? `${lang.script} letters`;
  return `${lang.name} comes as a Word file (DOCX) only: the PDF font doesn't have ${letters} yet. Word and other editors show it with your device's fonts${lang.rtl ? ", right to left" : ""}.`;
}

/** Lowercase, without accents, so "francais" finds Français and "tshivenda" Tshivenḓa. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function wordsOf(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Languages matching a search, best first: a name starting with it, then
 * any word of a name, native name or other name starting with it, then the
 * code. An empty search gives the whole list.
 */
export function searchLanguages(query: string, list: Language[] = LANGUAGES): Language[] {
  const q = fold(query.trim());
  if (!q) return list;
  const ranked: { lang: Language; rank: number }[] = [];
  for (const lang of list) {
    const names = [lang.name, lang.native, ...(lang.aka ?? [])];
    let rank = -1;
    if (names.some((n) => fold(n).startsWith(q))) rank = 0;
    else if (names.some((n) => wordsOf(n).some((w) => w.startsWith(q))) || wordsOf(names.join(" ")).join(" ").includes(q)) rank = 1;
    else if (fold(lang.code) === q || fold(lang.code).startsWith(`${q}-`)) rank = 2;
    if (rank >= 0) ranked.push({ lang, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.lang);
}
