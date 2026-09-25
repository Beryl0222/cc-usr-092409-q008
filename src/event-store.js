/**
 * 事件存储：追加式事件日志 + 指令幂等登记。
 *
 * - 事件只追加，不原地改写；业务更正一律产生后继事件。
 * - 每条指令携带 command_id 与内容指纹：同标识同内容重传返回首次结果（幂等）；
 *   同标识内容变化拒绝重放。登记表随快照一起持久化，服务恢复后仍然有效。
 */

/** 领域错误：携带稳定错误码，便于调用方与测试断言。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** 生成稳定的内容指纹：对象键序无关，用于指令重放校验。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export class EventStore {
  #events;
  #commands;

  constructor(events = [], commands = []) {
    this.#events = [...events];
    this.#commands = new Map(commands);
  }

  get events() {
    return [...this.#events];
  }

  append(event) {
    this.#events.push(event);
  }

  commandRecord(commandId) {
    return this.#commands.get(commandId);
  }

  recordCommand(commandId, record) {
    this.#commands.set(commandId, record);
  }

  /** 序列化事件日志与指令登记表，供服务恢复使用。 */
  snapshot() {
    return JSON.stringify({ events: this.#events, commands: [...this.#commands.entries()] });
  }

  static restore(snapshot) {
    const data = JSON.parse(snapshot);
    return new EventStore(data.events, data.commands);
  }
}
