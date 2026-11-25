#!/usr/bin/env node
// 只檢查分鏡表、不算圖（不開瀏覽器，一秒內）：展開鏡頭模板、對錨點、跑自動檢查。
// 用法：node check.mjs --storyboard <storyboard.json>
// 有錯誤（例如錨點找不到）時結束碼 1；只有提醒時結束碼 0，但提醒也要先修掉再交出去。
import { parseArgs, loadStoryboard, formatWarnings } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.storyboard) {
  console.error("用法：node check.mjs --storyboard <storyboard.json>");
  process.exit(2);
}
try {
  const board = await loadStoryboard(args.storyboard);
  const warn = formatWarnings(board.warnings);
  const avg = board.duration / board.rows.length;
  console.log(`分鏡表 ${board.rows.length} 幕、${board.duration} 秒（平均一個鏡頭 ${avg.toFixed(1)} 秒）`);
  console.log(warn || "自動檢查沒有提醒");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
