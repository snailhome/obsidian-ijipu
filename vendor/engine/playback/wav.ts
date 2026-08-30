/**
 * engine/playback/wav.ts — WAV（PCM16）编码，纯函数可单测（adj290）
 *
 * 输入各声道 Float32Array（-1 ~ 1），输出标准 RIFF/WAVE 文件字节。
 * 零 DOM/浏览器依赖，供音频导出（离线渲染 → WAV/MP3）共用。
 */

/** 多声道 PCM → WAV（PCM16 小端）字节 */
export function pcmToWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numCh = Math.max(1, channels.length)
  const numFrames = channels[0]?.length ?? 0
  const dataSize = numFrames * numCh * 2
  const buf = new Uint8Array(44 + dataSize)
  const v = new DataView(buf.buffer)
  // RIFF 头
  v.setUint32(0, 0x52494646, false) // "RIFF"
  v.setUint32(4, 36 + dataSize, true)
  v.setUint32(8, 0x57415645, false) // "WAVE"
  // fmt 块（PCM，16bit）
  v.setUint32(12, 0x666d7420, false) // "fmt "
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, numCh, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * numCh * 2, true) // byte rate
  v.setUint16(32, numCh * 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  // data 块
  v.setUint32(36, 0x64617461, false) // "data"
  v.setUint32(40, dataSize, true)
  let off = 44
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0))
      v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
      off += 2
    }
  }
  return buf
}
