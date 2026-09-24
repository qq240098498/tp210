# 水库调度与汛限水位管理台

水库调度班用来管水位与库容、算水量平衡、盯汛限与预警、登记调度指令的小台子。

## 运行

```
npm install
npm start
```

默认端口 5210（`PORT` 可以覆盖），数据存在 `data/db.json`，页面在 `/`。

## 页面

- **概览**：水库数、今日各库水位与限水位、超限记录数、指令按状态、偏差超限的指令数、预警等级。
- **水库**：水库台账（水位口径、曲线点数、库容对不上时的提示）、水位-库容曲线的维护与查询。
- **水位与流量**：水位记录、入库流量、出库流量的登记与查询。
- **调度指令**：指令的下达、修改、复制、撤销、删除与附件的登记。
- **水量平衡**：按水库与时段算入库/出库/损失/蓄变与残差，给出是否平衡。
- **联合调度**：上下游关系（传递时长、传递比例）的登记与维护；按日给出上游出库到下游入库的传递量、两库合计出库与合计水量；总控约束（总出库上限、下游控制断面要求）的设置，页面写清当前合计出库与离上限的余量；登记出库流量时若当日合计超限会被拦下并点名是哪一天、哪一座库。

## 口径（这一版按下列规则实现，页面上的说明与数字都要与本段一致）

1. **库容与水位**：库容在曲线的相邻两点之间线性插值；由库容反查水位也必须按**同一分段曲线反解**，两个方向要对得上（不能拿首末两点整体线性近似）。
2. **水量平衡**：入库水量 − 出库水量 − 损失 = 蓄变。流量（m³/s）换算成水量时按每天 **86400 秒**，再除以 10000 换成万 m³；损失 = 时段天数 × 每天损失（`lossPerDayWan`）。残差绝对值不超过 `balanceToleranceWan`（默认 0.5 万 m³）才算平衡。
3. **汛期**：按**日期**判断（`floodSeasonStart` 到 `floodSeasonEnd`，含两端）。汛限水位只在汛期适用，非汛期用正常蓄水位；汛期开始日之前的日子不能按汛期口径算。
4. **预警等级**：水位达到汛限/警戒要提级；**入库流量**达到 `inflowAttentionFlow`、`inflowSeriousFlow` 也要提级（两个输入都要看，不能只看水位）。
5. **指令编号**：`ZL-` 加四位，**取当前最大编号加一**；删掉指令之后新增不能重号。
6. **复制指令**：附件与说明是**各自的副本**，改一条不影响另一条。
7. **联合调度传递**：上游水库当日出库流量 × 传递比例，在**传递时长**天后计入下游水库的入库；页面上按日同时给出「当日发出」（本日上游出库 × 比例，注明到达日期）与「当日到达」（lag 天前的上游出库 × 比例）两个口径的传递量，传递水量按每天 86400 秒折算万 m³。
8. **总出库上限**：联合体（登记了上下游关系的全部水库；一条关系都没登记时按全部水库）每日合计出库流量不得超过 `jointControl.maxTotalReleaseFlow`。登记出库流量时若会使当日合计超限，接口直接拦下（409 `JOINT_LIMIT_EXCEEDED`），并在 `details` 里点名是哪一天、哪一座库、这笔流量多少。
9. **下游控制断面**：断面流量按两库合计出库流量考核，应在 `sectionMinFlow` 到 `sectionMaxFlow` 之间；不满足（低于/高于断面要求）只在页面上标出，不拦截。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/summary | 概览 |
| GET / PATCH | /api/settings | 全局设置（汛期起止、损失、容差、流量门槛等） |
| GET / POST | /api/reservoirs | 水库清单 / 新增 |
| GET / PATCH / DELETE | /api/reservoirs/:id | 水库详情（含曲线、水位、流量、指令）/ 修改 / 删除 |
| PUT | /api/reservoirs/:id/curve | 保存水位-库容曲线（校验水位与库容递增） |
| GET / POST | /api/levels | 水位记录清单（支持 reservoirId、from、to）/ 新增（同库同日同时刻覆盖） |
| DELETE | /api/levels/:id | 删除一条水位记录 |
| GET / POST | /api/flows?kind=inflow\|release | 入库或出库流量清单 / 新增 |
| DELETE | /api/flows/:kind/:id | 删除一条流量记录 |
| GET / POST | /api/orders | 调度指令清单（支持 reservoirId、status）/ 新增 |
| GET / PATCH / DELETE | /api/orders/:id | 指令详情（含实际均值与偏差）/ 修改 / 删除 |
| POST | /api/orders/:id/copy | 复制指令 |
| POST | /api/orders/:id/attachments | 给指令加附件说明 |
| GET | /api/balance?reservoirId=&from=&to= | 时段水量平衡 |
| GET | /api/curve/query?reservoirId=&level=\|capacity= | 由水位查库容、由库容反查水位 |
| GET | /api/joint/overview | 联合调度总览（关系、总控约束、当前合计出库与余量） |
| GET / POST | /api/joint/links | 上下游关系清单 / 登记（传递时长、传递比例） |
| PATCH / DELETE | /api/joint/links/:id | 修改 / 删除一条上下游关系 |
| GET / PUT | /api/joint/control | 查看 / 设置总控约束（总出库上限、断面要求） |
| GET | /api/joint/plan?from=&to= | 按日联合调度表（各库出库、传递量、合计、余量、状态） |

出错的返回统一是 `{"error":{"code":"...","message":"...","details":{...}}}`，`details` 里会点名是哪个字段没过。
