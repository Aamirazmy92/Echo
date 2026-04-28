export type LanguageOption = {
  id: string;
  label: string;
  nativeLabel?: string;
  flag: string;
  description?: string;
};

export type LanguageSelectionSettings = {
  language?: string;
  selectedLanguages?: string[];
  autoDetectLanguage?: boolean;
};

export const DEFAULT_LANGUAGE = 'en';

export const CLOUD_LANGUAGE_ALIASES: Record<string, string> = {
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  yue: 'zh',
};

export function resolveCloudLanguage(language: string): string {
  const normalized = (language || 'auto').toLowerCase();
  return CLOUD_LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function normalizeSelectedLanguages(languages?: string[] | string | null): string[] {
  const values = Array.isArray(languages) ? languages : [languages];
  const unique = Array.from(new Set(
    values
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .filter((value) => value.toLowerCase() !== 'auto')
  ));

  return unique.length ? unique : [DEFAULT_LANGUAGE];
}

export function getEffectiveLanguageSelection(settings: LanguageSelectionSettings) {
  const autoDetectLanguage = typeof settings.autoDetectLanguage === 'boolean'
    ? settings.autoDetectLanguage
    : String(settings.language ?? '').trim().toLowerCase() === 'auto';

  const selectedLanguages = normalizeSelectedLanguages(
    settings.selectedLanguages?.length ? settings.selectedLanguages : settings.language
  );

  return {
    autoDetectLanguage,
    selectedLanguages,
  };
}

export function getPrimarySelectedLanguage(settings: LanguageSelectionSettings): string {
  return getEffectiveLanguageSelection(settings).selectedLanguages[0] ?? DEFAULT_LANGUAGE;
}

export function resolveRecognitionLanguage(settings: LanguageSelectionSettings): string {
  const { autoDetectLanguage, selectedLanguages } = getEffectiveLanguageSelection(settings);
  if (autoDetectLanguage || selectedLanguages.length !== 1) {
    return 'auto';
  }

  return selectedLanguages[0];
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: 'auto', label: 'Auto detect', flag: '🌐', description: 'Best when you switch languages naturally.' },
  // ── Major / Tier 1 ──
  { id: 'en', label: 'English', nativeLabel: 'English', flag: '🇺🇸' },
  { id: 'zh', label: 'Chinese', nativeLabel: '中文', flag: '��' },
  { id: 'zh-CN', label: 'Chinese (Simplified)', nativeLabel: '简体中文', flag: '🇨🇳' },
  { id: 'zh-TW', label: 'Chinese (Traditional)', nativeLabel: '繁體中文', flag: '��' },
  { id: 'yue', label: 'Cantonese', nativeLabel: '廣東話', flag: '🇭🇰' },
  { id: 'de', label: 'German', nativeLabel: 'Deutsch', flag: '🇩🇪' },
  { id: 'es', label: 'Spanish', nativeLabel: 'Español', flag: '🇪🇸' },
  { id: 'ru', label: 'Russian', nativeLabel: 'Русский', flag: '🇷🇺' },
  { id: 'ko', label: 'Korean', nativeLabel: '한국어', flag: '��' },
  { id: 'fr', label: 'French', nativeLabel: 'Français', flag: '🇫🇷' },
  { id: 'ja', label: 'Japanese', nativeLabel: '日本語', flag: '🇯🇵' },
  { id: 'pt', label: 'Portuguese', nativeLabel: 'Português', flag: '🇵🇹' },
  { id: 'tr', label: 'Turkish', nativeLabel: 'Türkçe', flag: '🇹🇷' },
  { id: 'pl', label: 'Polish', nativeLabel: 'Polski', flag: '🇵🇱' },
  { id: 'ca', label: 'Catalan', nativeLabel: 'Català', flag: '🇪🇸' },
  { id: 'nl', label: 'Dutch', nativeLabel: 'Nederlands', flag: '🇳🇱' },
  { id: 'ar', label: 'Arabic', nativeLabel: 'العربية', flag: '🇸🇦' },
  { id: 'sv', label: 'Swedish', nativeLabel: 'Svenska', flag: '🇸🇪' },
  { id: 'it', label: 'Italian', nativeLabel: 'Italiano', flag: '��' },
  { id: 'id', label: 'Indonesian', nativeLabel: 'Bahasa Indonesia', flag: '🇮🇩' },
  { id: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी', flag: '��' },
  { id: 'fi', label: 'Finnish', nativeLabel: 'Suomi', flag: '🇫🇮' },
  { id: 'vi', label: 'Vietnamese', nativeLabel: 'Tiếng Việt', flag: '��' },
  { id: 'he', label: 'Hebrew', nativeLabel: 'עברית', flag: '🇮🇱' },
  { id: 'uk', label: 'Ukrainian', nativeLabel: 'Українська', flag: '🇺🇦' },
  { id: 'el', label: 'Greek', nativeLabel: 'Ελληνικά', flag: '🇬🇷' },
  { id: 'ms', label: 'Malay', nativeLabel: 'Bahasa Melayu', flag: '��' },
  { id: 'cs', label: 'Czech', nativeLabel: 'Čeština', flag: '🇨🇿' },
  { id: 'ro', label: 'Romanian', nativeLabel: 'Română', flag: '🇷🇴' },
  { id: 'da', label: 'Danish', nativeLabel: 'Dansk', flag: '🇩🇰' },
  { id: 'hu', label: 'Hungarian', nativeLabel: 'Magyar', flag: '🇭🇺' },
  { id: 'ta', label: 'Tamil', nativeLabel: 'தமிழ்', flag: '🇮🇳' },
  { id: 'no', label: 'Norwegian', nativeLabel: 'Norsk', flag: '��' },
  { id: 'th', label: 'Thai', nativeLabel: 'ไทย', flag: '🇹🇭' },
  { id: 'ur', label: 'Urdu', nativeLabel: 'اردو', flag: '��' },
  { id: 'hr', label: 'Croatian', nativeLabel: 'Hrvatski', flag: '🇭🇷' },
  { id: 'bg', label: 'Bulgarian', nativeLabel: 'Български', flag: '��' },
  { id: 'lt', label: 'Lithuanian', nativeLabel: 'Lietuvių', flag: '🇱🇹' },
  { id: 'la', label: 'Latin', nativeLabel: 'Latina', flag: '��' },
  { id: 'mi', label: 'Maori', nativeLabel: 'Te Reo Māori', flag: '🇳🇿' },
  { id: 'ml', label: 'Malayalam', nativeLabel: 'മലയാളം', flag: '��' },
  { id: 'cy', label: 'Welsh', nativeLabel: 'Cymraeg', flag: '🏴' },
  { id: 'sk', label: 'Slovak', nativeLabel: 'Slovenčina', flag: '🇸🇰' },
  { id: 'te', label: 'Telugu', nativeLabel: 'తెలుగు', flag: '��' },
  { id: 'fa', label: 'Persian', nativeLabel: 'فارسی', flag: '🇮🇷' },
  { id: 'lv', label: 'Latvian', nativeLabel: 'Latviešu', flag: '��' },
  { id: 'bn', label: 'Bengali', nativeLabel: 'বাংলা', flag: '🇧🇩' },
  { id: 'sr', label: 'Serbian', nativeLabel: 'Српски', flag: '🇷🇸' },
  { id: 'az', label: 'Azerbaijani', nativeLabel: 'Azərbaycan', flag: '🇦🇿' },
  { id: 'sl', label: 'Slovenian', nativeLabel: 'Slovenščina', flag: '🇸🇮' },
  { id: 'kn', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ', flag: '🇮🇳' },
  { id: 'et', label: 'Estonian', nativeLabel: 'Eesti', flag: '🇪🇪' },
  { id: 'mk', label: 'Macedonian', nativeLabel: 'Македонски', flag: '🇲🇰' },
  { id: 'br', label: 'Breton', nativeLabel: 'Brezhoneg', flag: '��' },
  { id: 'eu', label: 'Basque', nativeLabel: 'Euskara', flag: '🇪🇸' },
  { id: 'is', label: 'Icelandic', nativeLabel: 'Íslenska', flag: '��' },
  { id: 'hy', label: 'Armenian', nativeLabel: 'Հայերեն', flag: '🇦🇲' },
  { id: 'ne', label: 'Nepali', nativeLabel: 'नेपाली', flag: '�🇵' },
  { id: 'mn', label: 'Mongolian', nativeLabel: 'Монгол', flag: '🇲🇳' },
  { id: 'bs', label: 'Bosnian', nativeLabel: 'Bosanski', flag: '��' },
  { id: 'kk', label: 'Kazakh', nativeLabel: 'Қазақ', flag: '🇰🇿' },
  { id: 'sq', label: 'Albanian', nativeLabel: 'Shqip', flag: '��' },
  { id: 'sw', label: 'Swahili', nativeLabel: 'Kiswahili', flag: '🇰🇪' },
  { id: 'gl', label: 'Galician', nativeLabel: 'Galego', flag: '��' },
  { id: 'mr', label: 'Marathi', nativeLabel: 'मराठी', flag: '🇮🇳' },
  { id: 'pa', label: 'Punjabi', nativeLabel: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  { id: 'si', label: 'Sinhala', nativeLabel: 'සිංහල', flag: '��' },
  { id: 'km', label: 'Khmer', nativeLabel: 'ខ្មែរ', flag: '🇰🇭' },
  { id: 'sn', label: 'Shona', nativeLabel: 'ChiShona', flag: '🇿🇼' },
  { id: 'yo', label: 'Yoruba', nativeLabel: 'Yorùbá', flag: '��' },
  { id: 'so', label: 'Somali', nativeLabel: 'Soomaali', flag: '🇸🇴' },
  { id: 'af', label: 'Afrikaans', nativeLabel: 'Afrikaans', flag: '��' },
  { id: 'oc', label: 'Occitan', nativeLabel: 'Occitan', flag: '🇫🇷' },
  { id: 'ka', label: 'Georgian', nativeLabel: 'ქართული', flag: '��' },
  { id: 'be', label: 'Belarusian', nativeLabel: 'Беларуская', flag: '🇧🇾' },
  { id: 'tg', label: 'Tajik', nativeLabel: 'Тоҷикӣ', flag: '��' },
  { id: 'sd', label: 'Sindhi', nativeLabel: 'سنڌي', flag: '🇵🇰' },
  { id: 'gu', label: 'Gujarati', nativeLabel: 'ગુજરાતી', flag: '🇮🇳' },
  { id: 'am', label: 'Amharic', nativeLabel: 'አማርኛ', flag: '🇪🇹' },
  { id: 'yi', label: 'Yiddish', nativeLabel: 'ייִדיש', flag: '🇮�' },
  { id: 'lo', label: 'Lao', nativeLabel: 'ລາວ', flag: '🇱🇦' },
  { id: 'uz', label: 'Uzbek', nativeLabel: 'Oʻzbek', flag: '��' },
  { id: 'fo', label: 'Faroese', nativeLabel: 'Føroyskt', flag: '🇫🇴' },
  { id: 'ht', label: 'Haitian Creole', nativeLabel: 'Kreyòl Ayisyen', flag: '🇭🇹' },
  { id: 'ps', label: 'Pashto', nativeLabel: 'پښتو', flag: '��' },
  { id: 'tk', label: 'Turkmen', nativeLabel: 'Türkmen', flag: '🇹🇲' },
  { id: 'nn', label: 'Nynorsk', nativeLabel: 'Nynorsk', flag: '��' },
  { id: 'mt', label: 'Maltese', nativeLabel: 'Malti', flag: '🇲🇹' },
  { id: 'sa', label: 'Sanskrit', nativeLabel: 'संस्कृतम्', flag: '��' },
  { id: 'lb', label: 'Luxembourgish', nativeLabel: 'Lëtzebuergesch', flag: '🇱🇺' },
  { id: 'my', label: 'Myanmar', nativeLabel: 'ဗမာ', flag: '��' },
  { id: 'bo', label: 'Tibetan', nativeLabel: 'བོད་སྐད', flag: '🇨🇳' },
  { id: 'tl', label: 'Tagalog', nativeLabel: 'Tagalog', flag: '��' },
  { id: 'mg', label: 'Malagasy', nativeLabel: 'Malagasy', flag: '🇲🇬' },
  { id: 'as', label: 'Assamese', nativeLabel: 'অসমীয়া', flag: '🇮�' },
  { id: 'tt', label: 'Tatar', nativeLabel: 'Татар', flag: '🇷🇺' },
  { id: 'haw', label: 'Hawaiian', nativeLabel: 'ʻŌlelo Hawaiʻi', flag: '��' },
  { id: 'ln', label: 'Lingala', nativeLabel: 'Lingála', flag: '🇨🇩' },
  { id: 'ha', label: 'Hausa', nativeLabel: 'Hausa', flag: '��' },
  { id: 'ba', label: 'Bashkir', nativeLabel: 'Башҡорт', flag: '🇷🇺' },
  { id: 'jw', label: 'Javanese', nativeLabel: 'Basa Jawa', flag: '��' },
  { id: 'su', label: 'Sundanese', nativeLabel: 'Basa Sunda', flag: '🇮🇩' },
];
