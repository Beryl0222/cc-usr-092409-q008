# 主题雕塑创作会审：主张到构件变更传播服务

纪念性雕塑进入构件加工后，史料委员会仍可能修正人物关系。本服务在统一的事件语义上建立
**史实主张 → 设计版本 → 材料批次 → 安装/铭牌放行** 的变更传播链：更正一处主张时，
只有实际引用该主张的浮雕、铭牌等构件停工待决，底座等不引用主张的结构构件不被冻结。

## 核心规则

- **史实证据与艺术推断分开版本化**：主张以 `kind` 区分 `historical_evidence` 与
  `artistic_inference`，各自独立版本化。更正支持两种模式：
  - `revise`：新版取代旧版，引用旧版的在制构件自动收到处置单并局部停工；
  - `fork`：旧版作为并行解释分支仍然有效，引用它的构件照常施工。
  - 撤回（withdraw）不可按原方案继续，必须返工或替换。
- **设计版本显式引用**：每个设计版本记录所引用的主张版本、允许的表现范围
  （`permitted` / `prohibited`）、内容指纹与采纳的专家意见。工单下发时快照执行版本，
  后续设计改版不影响在制依据。
- **专家意见版本隔离**：意见绑定单一主张版本；设计采纳的意见必须与其引用的主张版本
  严格一致，越版本引用直接拒绝。
- **受影响构件计算与按职责处置**：主张更正产生的处置单须**史实负责人与结构负责人双签**
  （处置须一致），材料批次失效只需**结构负责人**签认；处置选项为继续 / 返工 / 替换。
  - 继续（continue）仅适用于修订取代且负责人接受旧版依据的情形；撤回与批次失效不可继续。
  - 返工（rework）主张类必须指定引用更正后主张版本的新设计版本；批次类必须先改绑合格批次。
- **已制造/安装构件不可回改**：原检验记录永不变更，只能追加隔离记录与纠正记录；
  替换时原件置为 `replaced`，替换件作为新构件登记。
- **材料试验失效沿批次传播**：失效批次立即隔离，批次关联的全部在用构件收到处置单，
  隔离批次禁止再绑定与下发工单。
- **并行设计提交**：必须携带 `expected_version` 基线，基线过期抛 `BASELINE_CONFLICT`，
  防止并行提交互相覆盖。
- **审批重传幂等、内容变化拒绝重放**：命令携带 `idempotency_key`，同键同内容返回首次
  结果（含被门禁拒绝的结论），同键不同内容抛 `REPLAY_REJECTED`。
- **服务恢复**：状态全部来自仅追加事件日志，重启后待决处置、冻结状态、幂等存根与
  放行门禁自动重放恢复。
- **放行门禁**：安装放行与铭牌放行前校验冻结/待决处置、主张版本状态、意见作用域、
  表现范围、批次隔离与成品检验（返工后须重新检验）。每次放行留存门禁快照。
- **全链反查**：`traceComponent` 可从任一构件回溯采用的主张（含证据/推断性质与版本
  状态）、设计版本与决策、材料批次与试验、历次检验/隔离/纠正记录及放行版本快照。

## 目录结构

- `contracts/domain.schema.json`：领域事件信封、聚合类型与全部事件名称。
- `src/domain.ts`：读模型与命令的 TypeScript 类型。
- `src/service.js`：`PropagationService`——传播计算、处置签认、门禁与反查。
- `src/event-store.js`：仅追加 JSONL 事件日志，重放恢复。
- `src/errors.js` / `src/hashing.js`：稳定错误码；规范化 JSON 与内容指纹。
- `tests/`：场景测试（局部停工、主张分叉、批次失效、更正后重新放行）与
  并发/幂等/恢复/反查/不可变性测试；`tests/helpers.js` 提供可复现场景。
- `data/sample.json`：基础事件信封样例。

## 最小用法

```js
import { EventStore } from "./src/event-store.js";
import { PropagationService } from "./src/service.js";

const svc = new PropagationService(new EventStore("./data/events.jsonl"));

svc.submitClaim({ claim_id: "C-1", kind: "historical_evidence", subject: "人物关系",
                  statement: "甲为乙之师" });
svc.registerComponent({ component_id: "relief", name: "浮雕", discipline: "art" });
svc.submitDesign({ design_id: "D-1", component_id: "relief",
                   citations: [{ claim_id: "C-1", claim_version: 1 }],
                   allowed_depiction: { permitted: ["师生并立"], prohibited: ["戎装像"] },
                   content_text: "浮雕方案 v1" });
svc.issueWorkOrder({ component_id: "relief" });

// 史料委员会更正：引用该主张的浮雕自动停工并开出双签处置单
svc.correctClaim({ claim_id: "C-1", new_statement: "甲乙实为同僚", reason: "新见信函",
                   mode: "revise" });
svc.listOpenHolds(); // 待决处置单与待签角色
```

## 本地检查

```bash
npm test     # node:test，14 个用例
npm run build # 全部源文件语法检查
```

均在单个 Linux 应用容器内执行，不需要外部服务。

## 领域边界

事件一经接收，其标识、发生时间和版本不被原地改写；业务更正一律产生后继事件。
涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段。
