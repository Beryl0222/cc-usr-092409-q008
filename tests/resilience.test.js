import assert from "node:assert/strict";
import test from "node:test";

import { GateBlockedError, ReplayConflictError, BaselineConflictError } from "../src/errors.js";
import { HISTORICAL_LEAD, STRUCTURAL_LEAD } from "../src/service.js";
import { makeService, seedWorld } from "./helpers.js";

// 幂等：同一命令重传返回首次结果，不产生重复事件；内容变化拒绝重放。
test("命令幂等：重传不重复落事件，内容指纹变化拒绝重放", () => {
  const harness = makeService();
  const { service } = harness;

  const first = service.submitClaim({
    claim_id: "C-x",
    kind: "historical_evidence",
    subject: "籍贯",
    statement: "人物甲出生于姑苏",
    idempotency_key: "cmd-submit-cx",
  });
  const eventsAfterFirst = harness.eventCount();
  const again = service.submitClaim({
    claim_id: "C-x",
    kind: "historical_evidence",
    subject: "籍贯",
    statement: "人物甲出生于姑苏",
    idempotency_key: "cmd-submit-cx",
  });
  assert.deepEqual(again, first);
  assert.equal(harness.eventCount(), eventsAfterFirst, "重传不得追加事件");

  // 同键但陈述被篡改：拒绝重放，原陈述不受影响。
  assert.throws(
    () =>
      service.submitClaim({
        claim_id: "C-x",
        kind: "historical_evidence",
        subject: "籍贯",
        statement: "人物甲出生于临安（被篡改）",
        idempotency_key: "cmd-submit-cx",
      }),
    ReplayConflictError,
  );
  assert.match(
    [...service.claims.values()].find((c) => c.id === "C-x").versions[0].statement,
    /姑苏/,
  );

  harness.cleanup();
});

// 并行设计提交：基于同一基线的第二次提交被乐观并发拒绝，不产生新版本。
test("并行提交：基线过期拒绝覆盖", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 1,
    citations: [{ claim_id: "C-relation", claim_version: 1 }, { claim_id: "C-mood", claim_version: 1 }],
    allowed_depiction: { permitted: ["师生并立"], prohibited: ["敌对姿态"] },
    content_text: "浮雕方案 v2：策展组 A 的修改",
    opinion_ids: [],
  });
  assert.throws(
    () =>
      service.submitDesign({
        design_id: "D-relief",
        component_id: "relief",
        expected_version: 1, // 基线已过期：当前是 2
        citations: [{ claim_id: "C-relation", claim_version: 1 }, { claim_id: "C-mood", claim_version: 1 }],
        allowed_depiction: { permitted: ["侧身立像"], prohibited: ["敌对姿态"] },
        content_text: "浮雕方案 v2：策展组 B 基于旧基线的覆盖尝试",
        opinion_ids: [],
      }),
    BaselineConflictError,
  );
  const trace = service.traceComponent("relief");
  assert.equal(trace.design.current_version, 2);
  assert.match(trace.design.current_content_text, /策展组 A 的修改/);
  assert.equal(trace.design.executed_version, 1, "工单快照仍停留在 v1，新版本尚未下发工单");

  // B 基于最新基线重新提交即成功。
  const v3 = service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 2,
    citations: [{ claim_id: "C-relation", claim_version: 1 }, { claim_id: "C-mood", claim_version: 1 }],
    allowed_depiction: { permitted: ["侧身立像"], prohibited: ["敌对姿态"] },
    content_text: "浮雕方案 v3：策展组 B 合并后的修改",
    opinion_ids: [],
  });
  assert.equal(v3.version, 3);

  harness.cleanup();
});

// 审批重传：门禁拒绝也幂等；处置闭环后以新请求重新申请方可放行。
test("审批重传幂等，拒绝留痕不重复，状态恢复后重新申请", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  service.correctClaim({
    claim_id: "C-relation",
    new_statement: "同僚关系",
    reason: "新档案",
    mode: "revise",
  });
  const key = "gate-relief-attempt-1";
  const tryOnce = () =>
    service.requestRelease({ component_id: "relief", kind: "installation", requested_by: "项目总师", idempotency_key: key });
  assert.throws(tryOnce, GateBlockedError);
  const eventsAfterFirstRejection = harness.eventCount();
  assert.throws(tryOnce, GateBlockedError);
  assert.equal(harness.eventCount(), eventsAfterFirstRejection, "被拒审批的重传不得重复追加事件");

  // 处置闭环：浮雕返工到引用 v2 的设计。
  const hold = service.listOpenHolds().find((h) => h.component_id === "relief");
  service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 1,
    citations: [
      { claim_id: "C-relation", claim_version: 2 },
      { claim_id: "C-mood", claim_version: 1 },
    ],
    allowed_depiction: { permitted: ["同僚并立"], prohibited: ["师长称谓"] },
    content_text: "浮雕 v2：同僚",
    opinion_ids: [],
  });
  for (const [role, by] of [
    [HISTORICAL_LEAD, "史实负责人"],
    [STRUCTURAL_LEAD, "结构负责人"],
  ]) {
    service.confirmDisposition({ hold_id: hold.hold_id, role, decision: "rework", decided_by: by, new_design_version: 2 });
  }
  service.issueWorkOrder({ component_id: "relief" });
  service.recordInspection({ component_id: "relief", inspection_id: "I-relief-f2", stage: "final", result: "pass", note: "返工合格" });

  // 旧请求键的内容对应阻断时刻的意图；状态变化后以新请求键重新申请。
  const cleared = service.requestRelease({
    component_id: "relief",
    kind: "installation",
    requested_by: "项目总师",
    idempotency_key: "gate-relief-attempt-2",
  });
  assert.equal(cleared.version, 1);
  // 同键重传放行同样幂等。
  const again = service.requestRelease({
    component_id: "relief",
    kind: "installation",
    requested_by: "项目总师",
    idempotency_key: "gate-relief-attempt-2",
  });
  assert.deepEqual(again, cleared);

  harness.cleanup();
});

// 服务恢复：重启后待决处置、冻结状态、幂等存根与放行版本全部从事件日志重放。
test("服务恢复后继续待决处置与安装门禁", () => {
  const harness = makeService();
  seedWorld(harness.service);
  harness.service.correctClaim({
    claim_id: "C-relation",
    new_statement: "同僚关系",
    reason: "新档案",
    mode: "revise",
    idempotency_key: "cmd-correct-relation",
  });

  // 重启：打开待决处置单继续签认。
  const reopened = harness.reopen();
  const openHolds = reopened.listOpenHolds();
  assert.equal(openHolds.length, 2);
  assert.equal(reopened.traceComponent("relief").component.frozen, true);
  assert.equal(reopened.traceComponent("plinth").component.frozen, false);

  // 幂等存根也已恢复：同键重传不重复更正。
  const eventsBefore = harness.eventCount();
  const replay = reopened.correctClaim({
    claim_id: "C-relation",
    new_statement: "同僚关系",
    reason: "新档案",
    mode: "revise",
    idempotency_key: "cmd-correct-relation",
  });
  assert.deepEqual(replay.hold_ids, ["hold-0001", "hold-0002"]);
  assert.equal(harness.eventCount(), eventsBefore);

  const reliefHold = openHolds.find((h) => h.component_id === "relief");
  reopened.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 1,
    citations: [
      { claim_id: "C-relation", claim_version: 2 },
      { claim_id: "C-mood", claim_version: 1 },
    ],
    allowed_depiction: { permitted: ["同僚并立"], prohibited: ["师长称谓"] },
    content_text: "浮雕 v2：同僚",
    opinion_ids: [],
  });
  reopened.confirmDisposition({ hold_id: reliefHold.hold_id, role: HISTORICAL_LEAD, decision: "rework", decided_by: "史实负责人", new_design_version: 2 });
  reopened.confirmDisposition({ hold_id: reliefHold.hold_id, role: STRUCTURAL_LEAD, decision: "rework", decided_by: "结构负责人", new_design_version: 2 });
  reopened.issueWorkOrder({ component_id: "relief" });
  reopened.recordInspection({ component_id: "relief", inspection_id: "I-relief-f2", stage: "final", result: "pass", note: "返工合格" });
  const cleared = reopened.requestRelease({ component_id: "relief", kind: "installation", requested_by: "项目总师" });
  assert.equal(cleared.version, 1);

  // 再重启：放行版本与全部历史仍可反查。
  const secondOpen = harness.reopen();
  const trace = secondOpen.traceComponent("relief");
  assert.equal(trace.releases.length, 1);
  assert.equal(trace.releases[0].gate_snapshot.design_version, 2);
  assert.equal(trace.component.status, "installed");
  assert.equal(secondOpen.listOpenHolds().filter((h) => h.component_id === "relief").length, 0);

  harness.cleanup();
});

// 全链反查：任一构件可回溯主张（区分证据/推断）、设计决策、材料证据与放行版本。
test("构件全链反查：主张、设计决策、材料证据、检验与放行版本一链到底", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  // 铭牌采纳绑定 C-relation@v1 的专家意见（设计未显式引用意见也能通过 trace 看检验/批次）。
  service.submitDesign({
    design_id: "D-plaque",
    component_id: "plaque",
    expected_version: 1,
    citations: [{ claim_id: "C-relation", claim_version: 1 }],
    allowed_depiction: { permitted: ["师长称谓铭文"], prohibited: ["虚构履历铭文"] },
    content_text: "铭牌 v2（文案微调，仍引用 v1）",
    opinion_ids: ["O-relation-v1"],
  });
  const release = service.requestRelease({
    component_id: "plaque",
    kind: "label",
    requested_by: "策展组",
    depictions: ["师长称谓铭文"],
  });
  assert.equal(release.version, 1);

  const trace = service.traceComponent("plaque");
  // 主张链：性质区分史实证据；引用版本与当前状态可见。
  assert.equal(trace.claims.length, 1);
  assert.equal(trace.claims[0].kind, "historical_evidence");
  assert.equal(trace.claims[0].cited_version, 1);
  // 设计链：版本、内容指纹、决策记录。
  assert.equal(trace.design.current_version, 2);
  assert.equal(trace.design.executed_version, 1, "工单快照版本不受后续设计改版影响");
  assert.ok(trace.design.content_hash);
  // 材料链：批次与全部试验证据。
  assert.equal(trace.batch.batch_id, "B-bronze");
  assert.deepEqual(trace.batch.tests, []); // 试验尚未登记时如实为空
  // 放行链：门禁快照锁定主张版本、检验与批次。
  assert.equal(trace.releases[0].kind, "label");
  assert.equal(trace.releases[0].gate_snapshot.final_inspection_id, "I-plaque-f");
  assert.deepEqual(trace.releases[0].gate_snapshot.citations, [{ claim_id: "C-relation", claim_version: 1 }]);

  // 底座的反查显示其不引用任何主张——结构独立性可被审计。
  const plinth = service.traceComponent("plinth");
  assert.deepEqual(plinth.claims, []);
  assert.equal(plinth.batch.material, "花岗岩");

  harness.cleanup();
});

// 原检验不可变：重复登记被拒；纠正只能追加。
test("检验记录不可原地修改，纠正只追加", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);
  assert.throws(
    () =>
      service.recordInspection({
        component_id: "plaque",
        inspection_id: "I-plaque-f",
        stage: "final",
        result: "fail",
        note: "试图把合格改成不合格",
      }),
    /不可修改/,
  );
  const trace = service.traceComponent("plaque");
  assert.equal(trace.inspections.find((i) => i.inspection_id === "I-plaque-f").result, "pass");

  harness.cleanup();
});
