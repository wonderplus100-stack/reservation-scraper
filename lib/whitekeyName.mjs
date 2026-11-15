import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import { lookupReadings, pickReading } from "./jinmeiDictionary.mjs";
import { learnedReading, knownSeiReadings } from "./nameReadings.mjs";

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
  let source = reading ? splitSeiMei(reading) : splitSeiMei(name);
  // 媒体のフリガナが姓名の区切り無しで来た場合は、氏名の区切りで切り分ける。
  if (reading && !source.mei && KANJI.test(name)) {
    const split = await splitProvidedReading(name, reading);
    if (split) source = split;
  }

  // ローマ字の氏名は「名 姓」(Seiko Ito)の並びが普通なので、最後の語を姓、その前を名とする。
  if (!reading && /^[A-Za-z][A-Za-z'.-]*(\s+[A-Za-z'.-]+)+$/.test(name.trim())) {
    const parts = name.trim().split(/\s+/);
    return { sei: romajiToHiragana(parts[parts.length - 1]), mei: romajiToHiragana(parts.slice(0, -1).join("")), hasGivenName: true, splitGuessed: true };
  }

  // 媒体のフリガナ(読み)が無く漢字の名前の場合は、学習した読み・人名読み辞典の候補を参考にする。
  if (!reading && (KANJI.test(name) || /^[ぁ-んァ-ヶー]+$/.test(source.sei))) {
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

// 姓または名の1つの部分の読みを決める。優先順: ①学習した読み(スタッフが whitekey に入れた実際のカナ)
// ②人名読み辞典の候補(形態素解析の推定に近いもの) ③形態素解析の推定。
// known: ①②のように根拠がある読みか(漢字を含まない部分は、そのまま読みなので known)。
async function readPart(kind, text) {
  if (!KANJI.test(text)) return { reading: await toHiragana(text), known: true, learned: false };
  const learned = learnedReading(kind, text);
  if (learned) return { reading: learned, known: true, learned: true };
  const guess = await toHiragana(text);
  const candidates = await lookupReadings(kind, text);
  if (candidates && candidates.length) return { reading: pickReading(candidates, guess), known: true, learned: false };
  return { reading: guess, known: false, learned: false };
}

// 姓と名に分かれている場合は、それぞれ読みを決める。空白が無く区切りが分からない場合は、姓の長さ(1〜3文字)ごとに、
// 姓・名の読みに根拠があるか(学習・辞典に載っているか)で点数を付け、いちばん点数の高い区切りを採用する。
// 姓の読みに根拠のある区切りが1つも無ければ、従来どおり全体を姓として扱う(呼び出し側で名に番号を付ける)。
// (以前は、姓・名の両方が辞典に載る区切りだけを採用していたため、名の字が珍しい人は全体が姓になり、
//  「磯崎真維」が「いそざきしん」+番号になっていた)
// かなだけで空白の無い氏名(「アンドウアキラ」)は、漢字の辞典が引けない。姓の読みとして既に知られているもの
// (学習した姓・人名読み辞典の姓の候補)で始まる区切りのうち、いちばん長いものを姓とする(名は2文字以上)。
function splitKanaName(whole) {
  const hira = String(whole).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  if (!/^[ぁ-んー]+$/.test(hira) || hira.length < 4) return null;
  const known = knownSeiReadings();
  // 姓は3文字以上(「しょうた」のような名だけの入力を、姓「しょ」+名「うた」と分けないため)
  for (let k = hira.length - 2; k >= 3; k -= 1) {
    if (known.has(hira.slice(0, k))) return { sei: hira.slice(0, k), mei: hira.slice(k), hasGivenName: true, splitGuessed: true };
  }
  return null;
}

async function withDictionary(source) {
  const kana = !source.mei && source.sei ? splitKanaName(source.sei) : null;
  if (kana) return kana;
  if (source.sei && source.mei) {
    const [sei, mei] = [await readPart("sei", source.sei), await readPart("mei", source.mei)];
    return { sei: sei.reading, mei: mei.reading, hasGivenName: true, splitGuessed: false };
  }
  const whole = source.sei;
  const chosen = await chooseSplit(whole);
  if (!chosen) return null;
  return { sei: chosen.sei.reading, mei: chosen.mei.reading, hasGivenName: true, splitGuessed: true };
}

// 空白の無い氏名(漢字)の、姓の長さと読みを決める。返り値: { k, sei, mei }(sei・mei は readPart の結果)。決められなければ null。
async function chooseSplit(whole) {
  if (!whole || whole.length < 3) return null;
  // 文字の種類が切り替わる所で分ける: 「ドロノワ真代」(カタカナ+漢字)、「田中アキラ」(漢字+カタカナ)
  const scriptSplit = whole.match(/^([ァ-ヶー]{2,})([一-龠々]{1,4})$/) || whole.match(/^([一-龠々]{1,3})([ァ-ヶー]{2,})$/);
  if (scriptSplit) {
    const k = scriptSplit[1].length;
    return { k, sei: await readPart("sei", scriptSplit[1]), mei: await readPart("mei", scriptSplit[2]) };
  }
  let best = null;
  for (let k = 1; k <= Math.min(3, whole.length - 1); k += 1) {
    const seiText = whole.slice(0, k);
    const meiText = whole.slice(k);
    if (meiText.length > 4) continue; // 名は最大4文字。それより長い名になる区切りは姓が短すぎる
    const [sei, mei] = [await readPart("sei", seiText), await readPart("mei", meiText)];
    const prior = k === 2 ? (whole.length === 4 ? 1.5 : 1) : k === 3 ? (whole.length >= 5 ? 1.5 : 0.5) : whole.length === 3 ? 0.8 : 0.2;
    const score = (sei.known ? 3 : 0) + (mei.known ? 3 : 0) + (sei.learned ? 1 : 0) + (mei.learned ? 1 : 0) + prior;
    if ((sei.known || mei.known) && (!best || score > best.score)) best = { k, sei, mei, score };
  }
  if (best) return best;
  // 学習・辞典のどちらにも根拠が無い場合も、全体を姓にして番号を付けるより、形態素解析の区切り
  // (先頭の固有名詞を姓とする)、無ければ4文字の2+2で姓・名に分ける方が、実際の入力に近い。
  const k = (await splitLengthByMorphology(whole)) || (whole.length === 4 ? 2 : 0);
  if (!k) return null;
  return { k, sei: await readPart("sei", whole.slice(0, k)), mei: await readPart("mei", whole.slice(k)) };
}

// 媒体のフリガナが「サカイシンスケ」のように姓名の区切り無しで来た時、氏名(漢字)の姓の読みの候補
// (学習・辞典・形態素解析)のうち、フリガナの先頭に当たる最も長いものを姓として切り分ける。
async function splitProvidedReading(nameKanji, readingKana) {
  const whole = String(nameKanji).replace(/[★☆※\s　]/g, "");
  const hira = katakanaToHiragana(String(readingKana).replace(/[\s　]/g, ""));
  if (!KANJI.test(whole) || whole.length < 3 || hira.length < 3) return null;
  const chosen = await chooseSplit(whole);
  if (!chosen) return null;
  const seiText = whole.slice(0, chosen.k);
  const candidates = new Set([learnedReading("sei", seiText), chosen.sei.reading, await toHiragana(seiText), ...((await lookupReadings("sei", seiText)) || [])].filter(Boolean));
  const hit = [...candidates].filter((c) => hira.startsWith(c) && hira.length - c.length >= 1).sort((a, b) => b.length - a.length)[0];
  return hit ? { sei: hit, mei: hira.slice(hit.length) } : null;
}

// 形態素解析(kuromoji)で、先頭が固有名詞(人名・地名など)の1〜3文字なら、それを姓とみなして長さを返す。
async function splitLengthByMorphology(whole) {
  try {
    const kuroshiro = await getKuroshiro();
    const tokens = await kuroshiro._analyzer.parse(whole);
    const first = tokens[0];
    if (!first || tokens.length < 2 || first.pos !== "名詞" || first.pos_detail_1 !== "固有名詞") return 0;
    const length = String(first.surface_form).length;
    return length >= 1 && length <= 3 && length < whole.length ? length : 0;
  } catch {
    return 0;
  }
}
