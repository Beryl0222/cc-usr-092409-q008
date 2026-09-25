/** 业务可预期错误：携带稳定错误码，调用方据此区分冲突、重放与门禁阻断。 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  constructor(what, id) {
    super("NOT_FOUND", `${what}不存在：${id}`, { what, id });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message, details = {}) {
    super("CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

/** 并行提交基于过期基线：拒绝且不写任何事件。 */
export class BaselineConflictError extends DomainError {
  constructor(expected, actual) {
    super("BASELINE_CONFLICT", "设计基线已过期，请基于最新版本重新提交", {
      expected_version: expected,
      actual_version: actual,
    });
    this.name = "BaselineConflictError";
  }
}

/** 同一幂等键重传但内容哈希变化：判定为重放攻击/误传，拒绝。 */
export class ReplayConflictError extends DomainError {
  constructor(key, existingHash, incomingHash) {
    super("REPLAY_REJECTED", "幂等键对应的内容与首次提交不一致，拒绝重放", {
      idempotency_key: key,
      existing_hash: existingHash,
      incoming_hash: incomingHash,
    });
    this.name = "ReplayConflictError";
  }
}

/** 专家意见被用于其所属主张版本之外的场景。 */
export class OpinionScopeError extends DomainError {
  constructor(opinionId, boundVersion, referencedVersions) {
    super("OPINION_SCOPE_VIOLATION", "专家意见只能作用于其对应的主张版本", {
      opinion_id: opinionId,
      bound_version: boundVersion,
      referenced_versions: referencedVersions,
    });
    this.name = "OpinionScopeError";
  }
}

/** 安装/铭牌门禁未通过，返回全部违例以便逐项处置。 */
export class GateBlockedError extends DomainError {
  constructor(violations) {
    super("GATE_BLOCKED", "放行门禁未通过", { violations });
    this.name = "GateBlockedError";
  }
}
