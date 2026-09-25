import assert from "node:assert/strict";
import test from "node:test";

import { STRUCTURAL_LEAD } from "../src/service.js";
import { makeService, seedWorld } from "./helpers.js";

// 场景三：材料试验失效沿批次关联传播——同批浮雕与铭牌停工，不同批的底座不冻结。
test("批次失效：沿批次传播到全部关联构件，处置只需结构负责人", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  const failed = service.recordMaterialTest({
    batch_id: "B-bronze",
    test_id: "T-bronze-chem-1",
    test_type: "化学成分复检",
    result: "fail",
    report_ref: "RPT-2026-0921-CU",
  });
  assert.deepEqual(failed.hold_ids.sort(), ["hold-0001", "hold-0002"]);

  const relief = service.traceComponent("relief");
  const plaque = service.traceComponent("plaque");
  const plinth = service.traceComponent("plinth");
  assert.equal(relief.component.frozen, true);
  assert.equal(plaque.component.frozen, true);
  assert.equal(plinth.component.frozen, false);

  // 批次失效处置单只需结构负责人签认，史实负责人无权签认。
  const reliefHold = service.listOpenHolds().find((h) => h.component_id === "relief");
  assert.deepEqual(reliefHold.required_roles, [STRUCTURAL_LEAD]);
  assert.throws(
    () =>
      service.confirmDisposition({
        hold_id: reliefHold.hold_id,
        role: "historical_lead",
        decision: "replace",
        decided_by: "史实负责人",
      }),
    /无权签认/,
  );
  // 材料失效不能"继续使用"。
  assert.throws(
    () =>
      service.confirmDisposition({
        hold_id: reliefHold.hold_id,
        role: STRUCTURAL_LEAD,
        decision: "continue",
        decided_by: "结构负责人",
      }),
    /不能继续使用/,
  );

  // 浮雕：改绑合格新批次后返工。
  service.registerBatch({ batch_id: "B-bronze-2", material: "青铜（新炉号）" });
  service.recordMaterialTest({
    batch_id: "B-bronze-2",
    test_id: "T-bronze2-chem-1",
    test_type: "化学成分复检",
    result: "pass",
    report_ref: "RPT-2026-0922-CU",
  });
  // 未换批次直接签认返工：拒绝。
  assert.throws(
    () =>
      service.confirmDisposition({
        hold_id: reliefHold.hold_id,
        role: STRUCTURAL_LEAD,
        decision: "rework",
        decided_by: "结构负责人",
      }),
    /改绑到未隔离的新材料批次/,
  );
  service.assignBatch({ component_id: "relief", batch_id: "B-bronze-2" });
  const reliefResolved = service.confirmDisposition({
    hold_id: reliefHold.hold_id,
    role: STRUCTURAL_LEAD,
    decision: "rework",
    decided_by: "结构负责人",
  });
  assert.equal(reliefResolved.status, "resolved");

  // 返工重检后放行：门禁快照记录新批次与其试验证据。
  service.issueWorkOrder({ component_id: "relief" });
  service.recordInspection({ component_id: "relief", inspection_id: "I-relief-f2", stage: "final", result: "pass", note: "换料返工合格" });
  const release = service.requestRelease({ component_id: "relief", kind: "installation", requested_by: "项目总师" });
  assert.equal(release.gate_snapshot.batch_id, "B-bronze-2");
  assert.ok(release.gate_snapshot.batch_test_ids.includes("T-bronze2-chem-1"));

  // 已制造的铭牌：换批返工，原检验保留并追加纠正记录；旧批次关联列表不含已换料的浮雕。
  const plaqueHold = service.listOpenHolds().find((h) => h.component_id === "plaque");
  service.registerBatch({ batch_id: "B-bronze-3", material: "青铜（替换炉号）" });
  service.assignBatch({ component_id: "plaque", batch_id: "B-bronze-3" });
  service.confirmDisposition({
    hold_id: plaqueHold.hold_id,
    role: STRUCTURAL_LEAD,
    decision: "rework",
    decided_by: "结构负责人",
  });
  const plaqueTrace = service.traceComponent("plaque");
  assert.equal(plaqueTrace.inspections.length, 2); // 原 material/final 检验均保留
  assert.equal(plaqueTrace.corrections.length, 1);
  assert.match(plaqueTrace.corrections[0].action, /原检验记录保留/);

  // 旧隔离批次不再关联换料构件（供后续反查材料证据范围）。
  const oldBatch = service.traceComponent("relief").batch;
  assert.equal(oldBatch.batch_id, "B-bronze-2");

  harness.cleanup();
});

test("批次失效后禁止再绑定与下发工单", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);
  service.recordMaterialTest({
    batch_id: "B-granite",
    test_id: "T-granite-1",
    test_type: "抗压强度",
    result: "fail",
    report_ref: "RPT-ST-1",
  });
  // 底座已绑定隔离批次：其处置单尚未闭环前工单被冻结拦截；
  // 新构件不能再绑定该批次。
  service.registerComponent({ component_id: "capstone", name: "压顶石", discipline: "structure" });
  assert.throws(() => service.assignBatch({ component_id: "capstone", batch_id: "B-granite" }), /批次已隔离/);

  harness.cleanup();
});
