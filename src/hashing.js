import { createHash } from "node:crypto";

/** 稳定的 JSON 规范化串：键按字典序排列，供内容指纹与重放比对使用。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
