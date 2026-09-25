import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ConflictError } from "./errors.js";

/**
 * 仅追加的 JSONL 事件日志。
 * 事件一经写入不可原地修改；更正业务状态只能追加后继事件。
 * 重新打开服务时通过 load() 重放全部事件以恢复投影与待决处置。
 */
export class EventStore {
  constructor(file) {
    this.file = file;
  }

  append(event) {
    if (!existsSync(this.file)) mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
  }

  load() {
    if (!existsSync(this.file)) return [];
    const events = [];
    const seenEventIds = new Set();
    const lines = readFileSync(this.file, "utf8").split("\n");
    for (const [idx, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (cause) {
        throw new Error(`事件日志第 ${idx + 1} 行无法解析`, { cause });
      }
      if (seenEventIds.has(event.event_id)) {
        throw new ConflictError("事件标识重复，日志可能被篡改", { event_id: event.event_id });
      }
      seenEventIds.add(event.event_id);
      events.push(event);
    }
    return events;
  }
}
