// 配樂：照分鏡的節拍與每一句的起點，用程式合成一段聲音（render.mjs --music 用）。
// 不用瀏覽器、不用音檔；雜訊用固定種子，所以同一份分鏡表每次算出一樣的聲音。
export const SAMPLE_RATE = 44100;

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * 聲音落點：每拍一個大鼓、換句時一記重拍、一段四拍的上升音。
 * 有 drop（全片最強的一刻，例如操作示範 burst 的第一拍）時：上升音接到 drop、drop 前兩拍抽掉大鼓、drop 是更重的一記；
 * accents 是 drop 之後要對齊的硬切（burst 每一張），各一記重拍。沒有 drop 時上升音接到最後一句（照舊）。
 */
export function cues({ duration, beat = 0.4, starts = [], drop = null, accents = [] }) {
  const hasDrop = drop != null && drop > 0 && drop < duration;
  const kicks = [];
  for (let k = 0; k * beat < duration - 1e-6; k++) {
    const t = r3(k * beat);
    if (hasDrop && t >= drop - 2 * beat - 1e-6 && t < drop - 1e-6) continue;
    kicks.push(t);
  }
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const hits = [...new Set([...starts, ...accents].map(r3))]
    .filter((t) => t > 0 && t < duration && !(hasDrop && near(t, drop)))
    .sort((a, b) => a - b);
  const target = hasDrop ? drop : starts.filter((t) => t > 0 && t < duration).at(-1);
  const riser = target === undefined ? null : { from: Math.max(0, r3(target - 4 * beat)), to: target };
  return { kicks, hits, riser, drop: hasDrop ? r3(drop) : null };
}

/**
 * 從分鏡表（loadStoryboard 的結果）算配樂的參數：每一句的起點；有 burst（操作示範的重拍）時，
 * 它的第一拍是 drop，burst 裡每一張截圖的硬切是 accents。
 */
export function musicPlan(board) {
  const plan = { duration: board.duration, beat: board.beat || 0.4, starts: board.rows.map((r) => r.start), drop: null, accents: [] };
  const burst = board.rows.find((r) => r.shot === "burst");
  if (!burst) return plan;
  plan.drop = burst.start;
  let t = 0;
  for (const s of board.scenes) {
    if (s.shot === "burst" && t > burst.start + 1e-6 && t < burst.start + burst.seconds - 1e-6) plan.accents.push(r3(t));
    t += s.seconds;
  }
  return plan;
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// 先快速升起、再指數衰減的音量包絡
const env = (x, attack, tau) => (x < attack ? x / attack : Math.exp(-(x - attack) / tau));

/** 回傳單聲道、-1…1 的取樣。 */
export function soundtrack({ duration, beat = 0.4, starts = [], drop = null, accents = [], sampleRate = SAMPLE_RATE }) {
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  const rand = rng(42);
  const noise = Float32Array.from({ length: sampleRate }, () => rand() * 2 - 1);
  const noiseAt = (t, i) => noise[(Math.round(t * 7919) + i) % noise.length];
  const add = (t0, seconds, fn) => {
    const s0 = Math.round(t0 * sampleRate);
    const m = Math.min(n - s0, Math.round(seconds * sampleRate));
    for (let i = 0; i < m; i++) out[s0 + i] += fn(i / sampleRate, i);
  };
  const cue = cues({ duration, beat, starts, drop, accents });
  const { kicks, hits, riser } = cue;

  for (const t of kicks) {
    // 大鼓：165 Hz 很快掉到 42 Hz 的正弦波
    let phase = 0;
    add(t, 0.45, (x) => {
      phase += (2 * Math.PI * (42 + 123 * Math.exp(-x / 0.035))) / sampleRate;
      return Math.sin(phase) * env(x, 0.004, 0.11) * 0.9;
    });
    // 拍與拍之間的高音：高通過的雜訊，很短
    const h = t + beat / 2;
    if (h < duration) {
      let lp = 0;
      add(h, 0.08, (x, i) => { const v = noiseAt(h, i); lp += (v - lp) * 0.2; return (v - lp) * env(x, 0.001, 0.018) * 0.16; });
    }
  }
  const hit = (t, gain) => {
    // 換句重拍：帶通雜訊加一個往下掉的三角波
    let a = 0, b = 0, phase = 0;
    add(t, 0.7, (x, i) => {
      const v = noiseAt(t, i);
      a += (v - a) * 0.35; b += (a - b) * 0.35;
      phase += (2 * Math.PI * (55 + 165 * Math.exp(-x / 0.08))) / sampleRate;
      const tri = (2 / Math.PI) * Math.asin(Math.sin(phase));
      return ((a - b) * env(x, 0.002, 0.09) * 1.2 + tri * env(x, 0.004, 0.18) * 0.35) * gain;
    });
  };
  for (const t of hits) hit(t, 1);
  if (cue.drop != null) {
    // drop：更重的一記，底下一個從 80 Hz 掉到 38 Hz、拖 0.9 秒的低音
    hit(cue.drop, 1.4);
    let phase = 0;
    add(cue.drop, 0.9, (x) => {
      phase += (2 * Math.PI * (38 + 42 * Math.exp(-x / 0.12))) / sampleRate;
      return Math.sin(phase) * env(x, 0.006, 0.32) * 0.8;
    });
  }
  if (riser && riser.to > riser.from) {
    // 上升音：越來越亮、越來越大聲的雜訊，加一條往上滑的鋸齒波，在下一句開頭切掉
    const len = riser.to - riser.from;
    let lp = 0, phase = 0;
    add(riser.from, len, (x, i) => {
      const p = x / len;
      const v = noiseAt(riser.from, i);
      lp += (v - lp) * (0.02 + 0.5 * p * p);
      phase += (110 * Math.pow(8, p)) / sampleRate;
      const saw = 2 * (phase % 1) - 1;
      return lp * 0.5 * p * p + saw * 0.06 * p * p;
    });
  }
  // 柔性限幅，避免疊在一起時爆音
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.1) * 0.9;
  return out;
}

/** 單聲道取樣 → 16 位元雙聲道 WAV。 */
export function toWav(samples, sampleRate = SAMPLE_RATE) {
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((v, i) => {
    const s = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
