import { gunzipSync } from 'node:zlib';

let gzipJson, GZIP_MIN_CHARS;

// jest vm 沙箱可能不暴露 Web 全局,先从 Node 内置兜底再动态 import 被测模块
beforeAll(async () => {
  const { CompressionStream } = await import('node:stream/web');
  const { Blob } = await import('node:buffer');
  globalThis.CompressionStream ??= CompressionStream;
  globalThis.Blob ??= Blob;
  ({ gzipJson, GZIP_MIN_CHARS } = await import('../background/gzip.js'));
});

test('gzipJson 往返一致,且压缩后更小', async () => {
  const obj = { rows: Array.from({ length: 1000 }, (_, i) => ({ i, name: '订单' + i })) };
  const json = JSON.stringify(obj);
  const gz = await gzipJson(json);
  expect(gz).toBeInstanceOf(Uint8Array);
  expect(gz.byteLength).toBeLessThan(Buffer.byteLength(json, 'utf8'));
  const back = gunzipSync(Buffer.from(gz)).toString('utf8');
  expect(JSON.parse(back)).toEqual(obj);
});

test('GZIP_MIN_CHARS = 65536', () => {
  expect(GZIP_MIN_CHARS).toBe(65536);
});
