import assert from "node:assert/strict";
import test from "node:test";

import { GateBlockedError } from "../src/errors.js";
import { HISTORICAL_LEAD, STRUCTURAL_LEAD } from "../src/service.js";
import { makeService, seedWorld } from "./helpers.js";

// 场景一：史料委员会修正人物关系——只有引用该主张的浮雕与铭牌停工，底座结构不冻结。
test("局部停工：主张更正只冻结引用构件，底座照常放行", () => {
  const harness = makeService();
  const { service } = harness;
  const ids = seedWorld(service);

  // 更正前：三类构件均可正常通过安装/铭牌门禁（浮雕尚未成品，仅验证无主张类违例）。
  assert.deepEqual(
    service.evaluateGate("plinth", "installation").map((v) => v.code),
    [],
  );

  const result = service.correctClaim({
    claim_id: "C-relation",
    new_statement: "经新见往来信函考证，人物甲实为人物乙的同僚而非师长",
    reason: "史料委员会据新档案修正人物关系",
    mode: "revise",
  });
  assert.equal(result.from_version, 1);
  assert.equal(result.new_version, 2);
  assert.deepEqual(result.hold_ids.sort(), ["hold-0001", "hold-0002"]);

  // 浮雕、铭牌冻结；底座结构未引用该主张，不被一并冻结。
  const traceRelief = service.traceComponent("relief");
  const tracePlaque = service.traceComponent("plaque");
  const tracePlinth = service.traceComponent("plinth");
  assert.equal(traceRelief.component.frozen, true);
  assert.equal(tracePlaque.component.frozen, true);
  assert.equal(tracePlinth.component.frozen, false);

  // 已制造的铭牌：只追加隔离记录，原成品检验原封不动。
  assert.equal(tracePlaque.component.status, "manufactured");
  assert.equal(tracePlaque.quarantines.length, 1);
  assert.match(tracePlaque.quarantines[0].reason, /C-relation/);
  assert.equal(tracePlaque.inspections.length, 2);
  assert.equal(tracePlaque.inspections.find((i) => i.inspection_id === "I-plaque-f").result, "pass");
  assert.equal(tracePlaque.corrections.length, 0);

  // 底座安装放行不受影响。
  const plinthRelease = service.requestRelease({
    component_id: "plinth",
    kind: "installation",
    requested_by: "项目总师",
  });
  assert.equal(plinthRelease.version, 1);

  // 浮雕门禁被阻断，违例包含冻结与主张被取代；尝试放行被拒绝并留痕。
  let blocked;
  try {
    service.requestRelease({ component_id: "relief", kind: "installation", requested_by: "项目总师" });
    assert.fail("应当被门禁阻断");
  } catch (e) {
    blocked = e;
  }
  assert.ok(blocked instanceof GateBlockedError);
  const codes = blocked.details.violations.map((v) => v.code);
  assert.ok(codes.includes("COMPONENT_FROZEN"));
  assert.ok(codes.includes("CLAIM_SUPERSEDED"));

  // 停工期间浮雕不能下发返工工单。
  assert.throws(() => service.issueWorkOrder({ component_id: "relief" }), /停工/);

  harness.cleanup();
});

// 场景一（续）：史实与结构双签处置后，浮雕按新版返工并重新检验放行；铭牌因已安装被替换。
test("更正后重新放行：双签处置、返工重检与已制造件只追加纠正记录", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  service.correctClaim({
    claim_id: "C-relation",
    new_statement: "人物甲为人物乙的同僚",
    reason: "新见信函",
    mode: "revise",
  });

  const reliefHold = service.listOpenHolds().find((h) => h.component_id === "relief");
  const plaqueHold = service.listOpenHolds().find((h) => h.component_id === "plaque");
  assert.deepEqual(reliefHold.required_roles.sort(), [HISTORICAL_LEAD, STRUCTURAL_LEAD].sort());
  assert.deepEqual(reliefHold.pending_roles.sort(), [HISTORICAL_LEAD, STRUCTURAL_LEAD].sort());

  // 浮雕提交引用主张 v2 的新设计，必须基于当前设计版本（基线 1）。
  const v2 = service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 1,
    citations: [
      { claim_id: "C-relation", claim_version: 2 },
      { claim_id: "C-mood", claim_version: 1 },
    ],
    allowed_depiction: {
      permitted: ["侧身立像", "同僚并立", "恭敬聆听姿态"],
      prohibited: ["正面戎装像", "敌对姿态", "师长称谓"],
    },
    content_text: "浮雕方案 v2：二人改为同僚并立",
    opinion_ids: [],
  });
  assert.equal(v2.version, 2);

  // 只有一位负责人签认时不闭环。
  let partial = service.confirmDisposition({
    hold_id: reliefHold.hold_id,
    role: HISTORICAL_LEAD,
    decision: "rework",
    decided_by: "史实负责人",
    new_design_version: 2,
  });
  assert.equal(partial.status, "awaiting_other_role");

  // 返工设计必须引用更正后的主张版本：拿旧版设计签认会被拒绝。
  assert.throws(
    () =>
      service.confirmDisposition({
        hold_id: reliefHold.hold_id,
        role: STRUCTURAL_LEAD,
        decision: "rework",
        decided_by: "结构负责人",
        new_design_version: 1,
      }),
    /更正后的主张版本/,
  );

  const reliefResolution = service.confirmDisposition({
    hold_id: reliefHold.hold_id,
    role: STRUCTURAL_LEAD,
    decision: "rework",
    decided_by: "结构负责人",
    new_design_version: 2,
  });
  assert.equal(reliefResolution.status, "resolved");
  assert.equal(reliefResolution.outcome, "rework");

  // 浮雕解冻并返工，工单快照采用设计 v2。
  const reliefTrace = service.traceComponent("relief");
  assert.equal(reliefTrace.component.frozen, false);
  assert.equal(reliefTrace.component.status, "reworking");
  assert.equal(reliefTrace.component.executed_design_version, 2);

  // 返工后的成品检验必须晚于返工：旧检验缺失时门禁阻断。
  const beforeReinspection = service.evaluateGate("relief", "installation").map((v) => v.code);
  assert.ok(beforeReinspection.includes("NO_FINAL_INSPECTION"));

  service.issueWorkOrder({ component_id: "relief" });
  service.recordInspection({ component_id: "relief", inspection_id: "I-relief-f2", stage: "final", result: "pass", note: "返工后成品合格" });

  // 越界表现（师长称谓在 v2 被明令禁止）不得放行。
  const outOfRange = service.evaluateGate("relief", "installation", ["师长称谓"]).map((v) => v.code);
  assert.ok(outOfRange.includes("DEPICTION_PROHIBITED"));

  const cleared = service.requestRelease({
    component_id: "relief",
    kind: "installation",
    requested_by: "项目总师",
    depictions: ["同僚并立"],
  });
  assert.equal(cleared.version, 1);
  assert.deepEqual(cleared.gate_snapshot.citations, [
    { claim_id: "C-relation", claim_version: 2 },
    { claim_id: "C-mood", claim_version: 1 },
  ]);

  // 铭牌已制造：双签决定替换——原检验保留，只追加纠正记录，原件进入 replaced。
  service.confirmDisposition({
    hold_id: plaqueHold.hold_id,
    role: HISTORICAL_LEAD,
    decision: "replace",
    decided_by: "史实负责人",
  });
  service.confirmDisposition({
    hold_id: plaqueHold.hold_id,
    role: STRUCTURAL_LEAD,
    decision: "replace",
    decided_by: "结构负责人",
  });
  const plaqueTrace = service.traceComponent("plaque");
  assert.equal(plaqueTrace.component.status, "replaced");
  assert.equal(plaqueTrace.inspections.find((i) => i.inspection_id === "I-plaque-f").result, "pass");
  assert.equal(plaqueTrace.corrections.length, 1);
  assert.match(plaqueTrace.corrections[0].action, /替换/);

  // 替换件作为新构件登记、引用新版主张后放行（替换件不再背负旧处置单）。
  service.registerComponent({ component_id: "plaque-2", name: "说明铭牌（替换件）", discipline: "art" });
  service.assignBatch({ component_id: "plaque-2", batch_id: "B-bronze" });
  service.submitDesign({
    design_id: "D-plaque-2",
    component_id: "plaque-2",
    citations: [{ claim_id: "C-relation", claim_version: 2 }],
    allowed_depiction: { permitted: ["同僚关系铭文"], prohibited: ["师长称谓铭文"] },
    content_text: "铭牌 v1：二人官职平行，为同僚关系",
    opinion_ids: [],
  });
  service.issueWorkOrder({ component_id: "plaque-2" });
  service.recordInspection({ component_id: "plaque-2", inspection_id: "I-plaque2-f", stage: "final", result: "pass", note: "替换铭牌合格" });
  const labelRelease = service.requestRelease({
    component_id: "plaque-2",
    kind: "label",
    requested_by: "策展组",
    depictions: ["同僚关系铭文"],
  });
  assert.equal(labelRelease.kind, "label");
  assert.equal(labelRelease.version, 1);

  harness.cleanup();
});

test("撤回主张不可继续：双签 continue 被拒，必须返工或替换", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  const withdrawn = service.withdrawClaim({
    claim_id: "C-mood",
    reason: "原推断依据的草图被证伪",
  });
  assert.equal(withdrawn.hold_ids.length, 1);
  const hold = service.listOpenHolds().find((h) => h.component_id === "relief");
  assert.throws(
    () =>
      service.confirmDisposition({
        hold_id: hold.hold_id,
        role: HISTORICAL_LEAD,
        decision: "continue",
        decided_by: "史实负责人",
      }),
    /主张已撤回/,
  );

  harness.cleanup();
});
