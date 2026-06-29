// 纯函数,只用 Web 全局(CompressionStream/Blob/Response),无 chrome 依赖 → 可单测。
// 超过此字符数的 body 才压(只压数据级 payload,跳过 claim/heartbeat 等控制消息)。
export const GZIP_MIN_CHARS = 64 * 1024;

/** 把 JSON 字符串 gzip 成 Uint8Array(配合 Content-Encoding: gzip 上报)。 */
export async function gzipJson(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
