// wonder-plus-portal/tools/build-portal-caches.mjs の normalizeText パターンを
// 「予約者氏名」と「イベント名」の名寄せ用に流用したもの。

const KANA_MAP = (() => {
  const half = "ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ";
  const full = "ォァィゥェォャュョッァィウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワンヅﾟ";
  const map = new Map();
  for (let i = 0; i < half.length; i += 1) map.set(half[i], full[i] || half[i]);
  return map;
})();

function halfKanaToFullKana(value) {
  return value.replace(/[｡-ﾟ]/g, (ch) => KANA_MAP.get(ch) || ch);
}

// 予約者氏名の比較用キー。全角/半角・スペース有無・敬称・カナ半角/全角の揺れを吸収する。
// 実際の表示には normalizedName ではなく元の氏名(rawName)を使うこと。
export function normalizeName(value) {
  return halfKanaToFullKana(String(value || "").normalize("NFKC"))
    .toLowerCase()
    .replace(/[　\s]+/g, "")
    .replace(/様$|さん$|殿$/u, "")
    .replace(/[.。．]/g, "");
}

// イベント名の比較用キー。媒体ごとの表記ゆれ(全角/半角、記号、スペース)を吸収する。
export function normalizeEventName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/wonder\s*[＋+]/g, "wonder+")
    .replace(/w\s*[＋+]/g, "wonder+")
    .replace(/＆/g, "&")
    .replace(/&/g, "and")
    .replace(/[ーｰ−–—]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[()（）「」『』【】\[\]、，,。]/g, "");
}
