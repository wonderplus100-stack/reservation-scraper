import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import { lookupReadings, pickReading } from "./jinmeiDictionary.mjs";

// whitekey受付登録の「氏名(カナ)」欄用に、予約者名を ひらがなの姓・名 に変換する。
// ユーザー指定のルール: ひらがなで入力 / 名前が分からなければ苗字だけ /
// 名の欄には「1」「2」など、同じ苗字の人と区別できる番号を入れる。
// 漢字の読みは辞書による機械的な推定のため、人名では誤ることがある
// (読みの精度は割り切って機械的に当てる、というユーザー判断)。
let kuroshiroPromise = null;
function getKuroshiro() {
  if (!kuroshiroPromise) {
    kuroshiroPromise = (async () => {
      const kuroshiro = new (Kuroshiro.default ?? Kuroshiro)();
      await kuroshiro.init(new (KuromojiAnalyzer.default ?? KuromojiAnalyzer)());
      return kuroshiro;
    })();
  }
  return kuroshiroPromise;
}

// ローマ字(ヘボン式を基本に、よくある入力ゆれを吸収)→ひらがな。
const ROMAJI = [
  ["kya", "きゃ"], ["kyu", "きゅ"], ["kyo", "きょ"], ["sha", "しゃ"], ["shu", "しゅ"], ["sho", "しょ"],
  ["cha", "ちゃ"], ["chu", "ちゅ"], ["cho", "ちょ"], ["nya", "にゃ"], ["nyu", "にゅ"], ["nyo", "にょ"],
  ["hya", "ひゃ"], ["hyu", "ひゅ"], ["hyo", "ひょ"], ["mya", "みゃ"], ["myu", "みゅ"], ["myo", "みょ"],
  ["rya", "りゃ"], ["ryu", "りゅ"], ["ryo", "りょ"], ["gya", "ぎゃ"], ["gyu", "ぎゅ"], ["gyo", "ぎょ"],
  ["ja", "じゃ"], ["ju", "じゅ"], ["jo", "じょ"], ["bya", "びゃ"], ["byu", "びゅ"], ["byo", "びょ"],
  ["pya", "ぴゃ"], ["pyu", "ぴゅ"], ["pyo", "ぴょ"],
  ["shi", "し"], ["chi", "ち"], ["tsu", "つ"], ["fu", "ふ"], ["ji", "じ"],
  ["ka", "か"], ["ki", "き"], ["ku", "く"], ["ke", "け"], ["ko", "こ"],
  ["sa", "さ"], ["si", "し"], ["su", "す"], ["se", "せ"], ["so", "そ"],
  ["ta", "た"], ["ti", "ち"], ["tu", "つ"], ["te", "て"], ["to", "と"],
  ["na", "な"], ["ni", "に"], ["nu", "ぬ"], ["ne", "ね"], ["no", "の"],
  ["ha", "は"], ["hi", "ひ"], ["hu", "ふ"], ["he", "へ"], ["ho", "ほ"],
  ["ma", "ま"], ["mi", "み"], ["mu", "む"], ["me", "め"], ["mo", "も"],
  ["ya", "や"], ["yu", "ゆ"], ["yo", "よ"],
  ["ra", "ら"], ["ri", "り"], ["ru", "る"], ["re", "れ"], ["ro", "ろ"],
  ["wa", "わ"], ["wo", "を"],
  ["ga", "が"], ["gi", "ぎ"], ["gu", "ぐ"], ["ge", "げ"], ["go", "ご"],
  ["za", "ざ"], ["zi", "じ"], ["zu", "ず"], ["ze", "ぜ"], ["zo", "ぞ"],
  ["da", "だ"], ["di", "ぢ"], ["du", "づ"], ["de", "で"], ["do", "ど"],
  ["ba", "ば"], ["bi", "び"], ["bu", "ぶ"], ["be", "べ"], ["bo", "ぼ"],
  ["pa", "ぱ"], ["pi", "ぴ"], ["pu", "ぷ"], ["pe", "ぺ"], ["po", "ぽ"],
  ["a", "あ"], ["i", "い"], ["u", "う"], ["e", "え"], ["o", "お"]
];

export function romajiToHiragana(text) {
  let rest = String(text || "").toLowerCase().replace(/[^a-z]/g, "");
  let out = "";
  while (rest) {
    if (rest[0] === "n" && !/^n[aiueoy]/.test(rest)) {
      out += "ん";
      rest = rest.slice(1);
      continue;
    }
    if (rest.length > 1 && rest[0] === rest[1] && !"aiueon".includes(rest[0])) {
      out += "っ"; // 促音(tt, kk, ss …)
      rest = rest.slice(1);
      continue;
    }
    const hit = ROMAJI.find(([key]) => rest.startsWith(key));
    if (!hit) {
      rest = rest.slice(1); // 変換できない文字は捨てる
      continue;
    }
    out += hit[1];
    rest = rest.slice(hit[0].length);
  }
  return out;
}

function katakanaToHiragana(text) {
  return text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/ヽ/g, "ゝ");
}

export async function toHiragana(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  // ローマ字だけの名前は、辞書を通さず自前の変換表でひらがなにする。
  if (/^[A-Za-z\s'.-]+$/.test(value)) return romajiToHiragana(value);
  const kuroshiro = await getKuroshiro();
  const converted = await kuroshiro.convert(katakanaToHiragana(value), { to: "hiragana" });
  return katakanaToHiragana(converted).replace(/[^ぁ-んー]/g, "");
}

// 「平野　裕一　(ヒラノ　ユウイチ)」のように括弧内にふりがなが添えられている
// 場合はそちらを読みとして優先する。括弧の外側が氏名。
function splitReadingHint(raw) {
  const match = String(raw).match(/^(.*?)[（(]\s*([ぁ-んァ-ヶー\s　]+?)\s*[）)]\s*$/);
  return match ? { name: match[1].trim(), reading: match[2].trim() } : { name: String(raw).trim(), reading: "" };
}

function splitSeiMei(text) {
  const parts = String(text).replace(/[★☆※]/g, " ").split(/[\s　]+/).filter(Boolean);
  if (parts.length === 0) return { sei: "", mei: "" };
  if (parts.length === 1) return { sei: parts[0], mei: "" };
  return { sei: parts[0], mei: parts.slice(1).join("") };
}

// 返り値: { sei, mei, hasGivenName }
//  sei: 姓(ひらがな) / mei: 名(ひらがな。分からなければ空 → 呼び出し側で番号を付ける)
//  providedReading: 媒体が持つフリガナ(公式サイトの予約など)。あれば辞書変換より優先する。
export async function toWhitekeyName(rawName, providedReading = "") {
  const { name: rawNameOnly, reading: hinted } = splitReadingHint(rawName);
  const name = normalizeVariantKanji(rawNameOnly);
  const reading = String(providedReading || "").trim() || hinted;
  // 読みの括弧書きがあればその区切りを優先し、無ければ名前自体の空白で区切る。
  const source = reading ? splitSeiMei(reading) : splitSeiMei(name);

  // 媒体のフリガナ(読み)が無く漢字の名前の場合は、人名読み辞典の候補を参考にする。
  if (!reading && KANJI.test(name)) {
    const viaDictionary = await withDictionary(source);
    if (viaDictionary) return viaDictionary;
  }

  const sei = await toHiragana(source.sei);
  const mei = await toHiragana(source.mei);
  return { sei, mei, hasGivenName: Boolean(mei), splitGuessed: false };
}

const KANJI = /[一-龠々]/;

// 異体字(髙・﨑・邊 など)は、読み(辞書・形態素解析)が標準の字でしか引けず、そのままだと「髙橋」が
// 「きょう」になるなど読みを誤る。読みは標準の字と同じなので、先に標準の字に置き換える
// (2026-11-15 whitekeyとの突き合わせで、予約の「髙橋」「髙嶋」「河邊」が受付名とずれていて発覚)。
const VARIANT_KANJI = {
  "髙": "高", "﨑": "崎", "嵜": "崎", "邊": "辺", "邉": "辺", "惠": "恵", "凜": "凛", "德": "徳", "藥": "薬",
  "齋": "斎", "齊": "斉", "濱": "浜", "濵": "浜", "國": "国", "澤": "沢", "櫻": "桜", "嶋": "島", "眞": "真",
  "渕": "淵", "龍": "竜", "廣": "広", "榮": "栄", "曾": "曽", "與": "与", "瀨": "瀬", "﨤": "鍋", "冨": "富",
  "塚": "塚", "增": "増", "淸": "清", "靑": "青", "神": "神", "桒": "桑", "桺": "柳", "髮": "髪", "實": "実"
};
export function normalizeVariantKanji(text) {
  return String(text || "").replace(/[\u4e00-\u9fff\ufa00-\ufaff]/g, (ch) => VARIANT_KANJI[ch] || ch);
}

async function readingWithDictionary(kind, kanji) {
  const guess = await toHiragana(kanji);
  if (!KANJI.test(kanji)) return guess;
  return pickReading(await lookupReadings(kind, kanji), guess);
}

// 姓と名に分かれている場合はそれぞれ辞書で読みを決める。空白が無く区切りが分からない
// 場合は、姓2文字→1文字→3文字の順に区切りを試し、姓・名の両方が辞書に載る区切りを採用する
// (どちらも載らなければ従来どおり全体を姓として扱い、呼び出し側で名に番号を付ける)。
async function withDictionary(source) {
  if (source.sei && source.mei) {
    return {
      sei: await readingWithDictionary("sei", source.sei),
      mei: await readingWithDictionary("mei", source.mei),
      hasGivenName: true,
      splitGuessed: false
    };
  }
  const whole = source.sei;
  if (!whole || whole.length < 3) return null;
  for (const length of [2, 1, 3]) {
    if (whole.length <= length) continue;
    const seiText = whole.slice(0, length);
    const meiText = whole.slice(length);
    const [seiReadings, meiReadings] = [await lookupReadings("sei", seiText), await lookupReadings("mei", meiText)];
    if (seiReadings?.length && meiReadings?.length) {
      return {
        sei: pickReading(seiReadings, await toHiragana(seiText)),
        mei: pickReading(meiReadings, await toHiragana(meiText)),
        hasGivenName: true,
        splitGuessed: true
      };
    }
  }
  return null;
}
