/**
 * 填表资料语种（Fill Locale）——与「切网站 UI 语言」严格分离。
 *
 * 用户说「用希伯来语填写 / 使用英文随机资料」= 生成该语种/地区的表单值，
 * 不是去点语言菜单把界面切成希伯来语/英文。
 *
 * 举一反三：he / en / zh / ar / ja / ko … 同一套语义，禁止再为单语种加旁路。
 */

export type FillLocaleKind = "he" | "en" | "zh" | "ar" | "ja" | "ko";

export interface FillLocaleSpec {
  kind: FillLocaleKind;
  /** 给人看的短标签 */
  label: string;
  /** 国家/地区提示（造手机号、地址） */
  regionHint: string;
}

/** 语种名提及（ alone ≠ 切语言） */
export const LANGUAGE_NAME_RE =
  /hebrew|希伯来|希伯來|עברית|english|英语|英文|中文|简体|繁體|繁体|chinese|arabic|阿拉伯|العرب|日本語|日语|日文|japanese|한국어|韩语|韩文|korean|法语|法文|french|德语|德文|german|西班牙语|spanish|俄语|俄文|russian|泰语|thai|越南语|vietnamese|葡萄牙|portuguese|意大利语|italian/i;

/**
 * 明确「切换网站/界面语言」的动词框架。
 * 只有命中这类才走切语言脚本；「使用X语填写」不得命中。
 */
export const LANGUAGE_SWITCH_VERB_RE =
  /(?:切换|改换|更换).{0,6}(?:语言|語|语种|locale|language)|(?:语言|語|语种|locale|language).{0,8}(?:切换|改成|换成|调成|设置|设成|设为|改为)|设成|设置成|设为|改成.{0,6}(?:语|文|hebrew|english|中文|arabic)|换成.{0,6}(?:语|文|hebrew|english|中文)|调成.{0,6}(?:语|文)|切到.{0,6}(?:语|文)|界面.{0,10}(?:英|中|希伯来|hebrew|arabic|日|韩)|网站.{0,10}(?:改成|换成|设成|设为).{0,8}(?:语|文|hebrew|english)|网页.{0,10}(?:改成|换成|设成)|switch\s+(?:the\s+)?(?:site\s+)?language|change\s+(?:the\s+)?language|set\s+(?:the\s+)?language\s+to|language\s+to\s+/i;

/** 「用某语种写资料」框架（填资料，不切 UI） */
export const FILL_LOCALE_FRAME_RE =
  /(?:使用|用|以|按|用上).{0,10}(?:希伯来|希伯來|hebrew|עברית|英文|英语|english|中文|简体|繁體|阿拉伯|arabic|日语|日文|韩语|韩文).{0,16}(?:填|写|资料|信息|姓名|地址|电话|随机|表单|注册)|(?:希伯来|希伯來|hebrew|עברית|英文|英语|english|中文|阿拉伯|arabic).{0,8}(?:资料|姓名|地址|随机填|填写)|(?:in|with)\s+(?:hebrew|english|chinese|arabic|japanese|korean).{0,12}(?:fill|name|address|data|form|random)|(?:hebrew|english|chinese|arabic)\s+(?:name|address|data|fill|form)/i;

const FILL_INTENT_RE =
  /填|写|资料|信息|表单|注册|登录|随机|结账|checkout|register|login|sign\s*up|sign\s*in|姓名|地址|电话|手机|email|邮箱/i;

function pickOne<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** 目标是否在要求「按某语种生成填表资料」（而非切 UI） */
export function isFillLocaleGoal(goal: string): boolean {
  const g = String(goal ?? "");
  if (!g.trim()) {
    return false;
  }
  if (FILL_LOCALE_FRAME_RE.test(g)) {
    return true;
  }
  // 有填表意图 + 语种名 + 没有切语言动词 → 视为填资料语种
  if (FILL_INTENT_RE.test(g) && LANGUAGE_NAME_RE.test(g) && !LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return true;
  }
  return false;
}

/**
 * 从目标解析填表资料语种。
 * 优先级：显式语种名 > null（交给字段标签/GeoIP）。
 */
export function resolveFillLocale(goal: string): FillLocaleSpec | null {
  const g = String(goal ?? "");
  if (!isFillLocaleGoal(g) && !LANGUAGE_NAME_RE.test(g)) {
    return null;
  }
  // 无填表意图时，不要仅因语种名就当 fill locale（那可能是切语言）
  if (!FILL_INTENT_RE.test(g) && !FILL_LOCALE_FRAME_RE.test(g)) {
    return null;
  }
  if (/希伯来|希伯來|hebrew|עברית|israel|以色列|he-?il/i.test(g)) {
    return { kind: "he", label: "希伯来语/以色列", regionHint: "IL" };
  }
  if (/阿拉伯|arabic|العرب|saudi|emirates|dubai|مصر|jordan/i.test(g)) {
    return { kind: "ar", label: "阿拉伯语", regionHint: "AE" };
  }
  if (/日语|日文|日本語|japanese|japan/i.test(g)) {
    return { kind: "ja", label: "日语/日本", regionHint: "JP" };
  }
  if (/韩语|韩文|한국어|korean|korea/i.test(g)) {
    return { kind: "ko", label: "韩语/韩国", regionHint: "KR" };
  }
  if (/中文|简体|繁體|繁体|chinese|zh[-_]?cn|zh[-_]?tw|中国/i.test(g)) {
    return { kind: "zh", label: "中文", regionHint: "CN" };
  }
  if (/英语|英文|english|新加坡|singapore|美国|英国|uk\b|usa/i.test(g)) {
    return { kind: "en", label: "英语", regionHint: "SG" };
  }
  return null;
}

/** 兼容旧名：目标是否要求希伯来资料 */
export function goalWantsHebrewLocale(goal: string): boolean {
  return resolveFillLocale(goal)?.kind === "he";
}

/** 注入 LLM / 计划的短教练 */
export function buildFillLocaleCoach(goal: string): string | null {
  const locale = resolveFillLocale(goal);
  if (!locale) {
    return null;
  }
  return [
    `【填资料语种=${locale.label}】用户要的是用该语种/地区格式生成表单值（姓名·电话·地址），`,
    "不是切换网站界面语言。禁止点语言菜单/地球仪/EN/HE/עברית 芯片。",
    "立刻 agent_batch_fill；随机授权时按该语种确定性生成。",
  ].join("");
}

// —— 各语种确定性资料池（无需 LLM） ——

const HE_FIRST = ["נועם", "יואב", "דניאל", "איתי", "אורי", "תמר", "מיכל", "יעל", "שירה", "נועה"];
const HE_LAST = ["כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אברהם", "דוד", "חדד", "אוזן", "שפירא"];
const HE_CITY = ["תל אביב", "ירושלים", "חיפה", "ראשון לציון", "פתח תקווה", "אשדוד", "נתניה", "באר שבע"];
const HE_STREET = ["הרצל", "ויצמן", "בן גוריון", "רוטשילד", "דיזנגוף", "אלנבי", "ההגנה", "יפו"];

const EN_FIRST = ["James", "Oliver", "Emma", "Sophia", "Liam", "Noah", "Ava", "Mia"];
const EN_LAST = ["Tan", "Lim", "Wong", "Ng", "Lee", "Chen", "Smith", "Brown"];
const EN_CITY = ["Singapore", "Orchard", "Tampines", "Jurong", "Bedok"];
const EN_STREET = ["Orchard Road", "Marina Boulevard", "Raffles Avenue", "Clementi Road"];

const ZH_FIRST = ["伟", "芳", "娜", "敏", "静", "强", "磊", "洋", "艳", "勇"];
const ZH_LAST = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵"];
const ZH_CITY = ["上海", "北京", "深圳", "广州", "杭州", "成都", "南京"];
const ZH_STREET = ["中山路", "人民路", "解放路", "建设路", "和平路", "文化路"];

const AR_FIRST = ["أحمد", "محمد", "علي", "يوسف", "فاطمة", "نور", "سارة", "مريم"];
const AR_LAST = ["الأحمد", "الحسن", "الخالد", "الناصر", "العلي"];
const AR_CITY = ["دبي", "أبوظبي", "الرياض", "جدة", "الدوحة"];
const AR_STREET = ["شارع الشيخ زايد", "شارع الخليج", "طريق الملك فهد"];

const JA_FIRST = ["太郎", "健太", "翔太", "美咲", "陽菜", "結衣"];
const JA_LAST = ["佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺"];
const JA_CITY = ["東京", "大阪", "横浜", "名古屋", "札幌"];
const JA_STREET = ["本町", "中央通り", "駅前通り", "桜通り"];

const KO_FIRST = ["민수", "지훈", "서연", "하은", "도윤", "수빈"];
const KO_LAST = ["김", "이", "박", "최", "정", "강"];
const KO_CITY = ["서울", "부산", "인천", "대구", "대전"];
const KO_STREET = ["강남대로", "테헤란로", "세종대로", "을지로"];

function randDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += String(Math.floor(Math.random() * 10));
  }
  return out;
}

export function generateMobileForLocale(kind: FillLocaleKind): string {
  switch (kind) {
    case "he":
      return `05${pickOne(["0", "2", "3", "4", "5", "8"])}${randDigits(7)}`;
    case "zh":
      return `1${pickOne(["3", "5", "7", "8", "9"])}${randDigits(9)}`;
    case "ar":
      return `05${randDigits(8)}`;
    case "ja":
      return `090${randDigits(8)}`;
    case "ko":
      return `010${randDigits(8)}`;
    case "en":
    default: {
      const head = Math.random() < 0.5 ? "8" : "9";
      return `${head}${randDigits(7)}`;
    }
  }
}

function fullName(kind: FillLocaleKind): string {
  switch (kind) {
    case "he":
      return `${pickOne(HE_FIRST)} ${pickOne(HE_LAST)}`;
    case "zh":
      return `${pickOne(ZH_LAST)}${pickOne(ZH_FIRST)}`;
    case "ar":
      return `${pickOne(AR_FIRST)} ${pickOne(AR_LAST)}`;
    case "ja":
      return `${pickOne(JA_LAST)}${pickOne(JA_FIRST)}`;
    case "ko":
      return `${pickOne(KO_LAST)}${pickOne(KO_FIRST)}`;
    case "en":
    default:
      return `${pickOne(EN_FIRST)} ${pickOne(EN_LAST)}`;
  }
}

function city(kind: FillLocaleKind): string {
  switch (kind) {
    case "he":
      return pickOne(HE_CITY);
    case "zh":
      return pickOne(ZH_CITY);
    case "ar":
      return pickOne(AR_CITY);
    case "ja":
      return pickOne(JA_CITY);
    case "ko":
      return pickOne(KO_CITY);
    default:
      return pickOne(EN_CITY);
  }
}

function street(kind: FillLocaleKind): string {
  switch (kind) {
    case "he":
      return pickOne(HE_STREET);
    case "zh":
      return pickOne(ZH_STREET);
    case "ar":
      return pickOne(AR_STREET);
    case "ja":
      return pickOne(JA_STREET);
    case "ko":
      return pickOne(KO_STREET);
    default:
      return pickOne(EN_STREET);
  }
}

/**
 * 按资料语种 + 字段标签生成值。
 * 标签可用任意语种（页上希伯来标签 + 目标要求英文资料 → 仍出英文值）。
 */
export function generateLocaleFieldValue(
  label: string,
  locale: FillLocaleKind,
): string | null {
  const blob = String(label ?? "");
  if (!blob.trim()) {
    return null;
  }
  if (/אימייל|דוא"?ל|email|邮箱|郵件|mail|بريد/i.test(blob)) {
    return `user${Date.now().toString(36).slice(-6)}@example.com`;
  }
  if (/טלפון|נייד|mobile|phone|tel|手机|手機|電話|전화|電話番号/i.test(blob)) {
    return generateMobileForLocale(locale);
  }
  if (
    /שם\s*מלא|full\s*name|姓名|全名|お名前|성명|الاسم\s*الكامل/i.test(blob) ||
    (/^שם$|שם\b|name/i.test(blob) && !/משפחה|רחוב|עיר|user|用户/i.test(blob))
  ) {
    return fullName(locale);
  }
  if (/משפחה|last\s*name|姓|せい|성씨/i.test(blob)) {
    switch (locale) {
      case "he":
        return pickOne(HE_LAST);
      case "zh":
        return pickOne(ZH_LAST);
      case "ar":
        return pickOne(AR_LAST);
      case "ja":
        return pickOne(JA_LAST);
      case "ko":
        return pickOne(KO_LAST);
      default:
        return pickOne(EN_LAST);
    }
  }
  if (/first\s*name|名(?!字)|שם\s*פרטי|名前/i.test(blob) && !/full|אישיים/i.test(blob)) {
    switch (locale) {
      case "he":
        return pickOne(HE_FIRST);
      case "zh":
        return pickOne(ZH_FIRST);
      case "ar":
        return pickOne(AR_FIRST);
      case "ja":
        return pickOne(JA_FIRST);
      case "ko":
        return pickOne(KO_FIRST);
      default:
        return pickOne(EN_FIRST);
    }
  }
  if (/עיר|יישוב|מושב|קיבוץ|city|城市|都市|도시|مدينة/i.test(blob)) {
    return city(locale);
  }
  if (/רחוב|street|街道|通り|도로|شارع/i.test(blob)) {
    return street(locale);
  }
  if (/מספר\s*בית|house|门牌|番地|호수/i.test(blob)) {
    return String(1 + Math.floor(Math.random() * 120));
  }
  if (/דירה|apartment|公寓|部屋|호/i.test(blob)) {
    return String(1 + Math.floor(Math.random() * 40));
  }
  if (/קומה|floor|楼层|階|층/i.test(blob)) {
    return String(Math.floor(Math.random() * 12));
  }
  if (/כניסה|entrance|单元|入口/i.test(blob)) {
    return locale === "he" ? pickOne(["א", "ב", "ג", "1", "2"]) : pickOne(["A", "B", "1", "2"]);
  }
  if (/מיקוד|zip|postal|邮编|郵便|우편/i.test(blob)) {
    return locale === "he" || locale === "zh" ? randDigits(6) : randDigits(6);
  }
  if (/כתובת|address|地址|住所|주소|عنوان/i.test(blob)) {
    return `${street(locale)} ${1 + Math.floor(Math.random() * 80)}, ${city(locale)}`;
  }
  // 未识别但像身份字段 → 给全名兜底
  if (/שם|name|姓名|اسم|名前|이름/i.test(blob)) {
    return fullName(locale);
  }
  return null;
}

/** 从字段标签脚本猜测语种（目标未指定时） */
export function inferLocaleFromFieldLabel(label: string): FillLocaleKind | null {
  const t = String(label ?? "");
  if (/[\u0590-\u05FF]/.test(t)) {
    return "he";
  }
  if (/[\u0600-\u06FF]/.test(t)) {
    return "ar";
  }
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(t)) {
    return "ja";
  }
  if (/[\uac00-\ud7af]/.test(t)) {
    return "ko";
  }
  if (/[\u4e00-\u9fff]/.test(t)) {
    return "zh";
  }
  return null;
}
