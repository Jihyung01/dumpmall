// Keep the v1 vocabulary and order stable: persisted alias slots depend on it.
export const aliasAdjectives = [
  "성실한", "든든한", "정직한", "친절한", "따뜻한",
  "밝은", "활기찬", "다정한", "꼼꼼한", "부지런한",
  "슬기로운", "지혜로운", "유쾌한", "행복한", "건실한",
  "당당한", "튼튼한", "한결같은", "믿음직한", "여유로운",
] as const;

const provinces: Record<string, [string, string]> = {
  서울: ["서울", "서울"], 서울특별시: ["서울", "서울"],
  부산: ["부산", "경상"], 부산광역시: ["부산", "경상"],
  대구: ["대구", "경상"], 대구광역시: ["대구", "경상"],
  인천: ["인천", "인천"], 인천광역시: ["인천", "인천"],
  광주: ["광주", "전라"], 광주광역시: ["광주", "전라"],
  대전: ["대전", "충청"], 대전광역시: ["대전", "충청"],
  울산: ["울산", "경상"], 울산광역시: ["울산", "경상"],
  세종: ["세종", "충청"], 세종특별자치시: ["세종", "충청"],
  경기: ["경기", "경기"], 경기도: ["경기", "경기"],
  강원: ["강원", "강원"], 강원도: ["강원", "강원"], 강원특별자치도: ["강원", "강원"],
  충북: ["충북", "충청"], 충청북도: ["충북", "충청"],
  충남: ["충남", "충청"], 충청남도: ["충남", "충청"],
  전북: ["전북", "전라"], 전라북도: ["전북", "전라"], 전북특별자치도: ["전북", "전라"],
  전남: ["전남", "전라"], 전라남도: ["전남", "전라"],
  경북: ["경북", "경상"], 경상북도: ["경북", "경상"],
  경남: ["경남", "경상"], 경상남도: ["경남", "경상"],
  제주: ["제주", "제주"], 제주도: ["제주", "제주"], 제주특별자치도: ["제주", "제주"],
};

// Parses a self-reported Korean road/lot address; does not verify business ownership.
export function businessRegion(address: string) {
  const parts = address.trim().split(/\s+/);
  const province = provinces[parts[0]];
  if (!province) return null;
  let offset = 1;
  const district = [province[0]];
  if (province[0] !== "세종") {
    if (!/^[가-힣]{1,12}[시군구]$/.test(parts[1] || "")) return null;
    district.push(parts[1]);
    offset = 2;
    if (parts[1].endsWith("시") && /^[가-힣]{1,10}구$/.test(parts[2] || "")) {
      district.push(parts[2]);
      offset = 3;
    }
  }
  if (!/[가-힣].*\d/.test(parts.slice(offset).join(" "))) return null;
  return { districtKey: district.join(" "), region: province[1] };
}
