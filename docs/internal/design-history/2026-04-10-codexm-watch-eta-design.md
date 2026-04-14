# codexm watch ETA 设计说明

## 1. 背景

当前 `codexm watch` 能持续监听受管 Codex Desktop 的 quota 信号，并在账号耗尽时触发自动切换；`codexm list` 能显示每个账号的当前 quota 状态、重置时间和现有 score。

但现有输出仍然缺少一个更直接的判断维度：

- 按当前真实使用节奏，某个账号大概还能撑多久

用户希望把 `watch` 期间观测到的真实消耗沉淀下来，形成一条全局消耗速率；`list` 在展示每个账号时，用这条全局速率结合账号自身当前剩余额度，直接给出 ETA。

这里的 ETA 不是“账号专属历史预测”，而是：

- 先从当前正在使用的账号上观测全局消耗速率
- 再把这条速率投影到所有账号当前 quota 上
- 最终得到“如果后续仍按当前全局节奏继续跑，这个账号预计多久会不可用”

## 2. 目标

新增一套基于 `watch` 历史的 ETA 预测能力：

- `codexm watch` 持久化当前活跃账号的 quota 快照历史
- 基于 `watch` 历史计算一条全局消耗速率
- `codexm list` 为每个账号显示 ETA
- ETA 以账号变为 `unavailable` 的最早时间为准
- ETA 同时考虑 `5 小时窗口` 和 `7 天窗口`
- 默认输出保持简洁，详细拆解放到 `list --verbose`

## 3. 非目标

本次不做以下能力：

- 不为每个账号分别训练独立消耗速率
- 不让 `current`、`list` 或其他命令写入 ETA 历史
- 不引入复杂的多模型预测、季节性预测或成本优化策略
- 不改变现有 auto-switch 的决策逻辑
- 不把 ETA 作为切换前置条件；本次只做观测与展示

## 4. 核心设计

### 4.1 预测口径

系统内部只维护一条全局消耗速率：

- `global_rate_in_1w_units_per_hour`

这条速率只从 `codexm watch` 持续记录的历史中学习，不采纳 `current` 或 `list` 的手动刷新结果。

该设计与现有 `score` 模型保持一致：

- `5H` 和 `1W` 被视为同一消耗量的不同窗口约束
- `5H` 和 `1W` 都会先按 plan 容量 profile 归一化到统一的 `plus 1W` 单位
- 再取更早耗尽的那个瓶颈

设计原因：

- `watch` 的语义最接近“真实运行时消耗”
- 数据来源单一，便于解释和调试
- 可以避免手动刷新带来的稀疏采样污染预测

### 4.2 ETA 定义

对于 `list` 中的每个账号，先计算：

- `remaining_5h = 100 - five_hour.used_percent`
- `remaining_1w = 100 - one_week.used_percent`
- `remaining_5h_eq_1w = normalize_5h_to_plus_weekly_units(remaining_5h, plan_type)`
- `remaining_1w_eq = normalize_1w_to_plus_weekly_units(remaining_1w, plan_type)`
- `remaining_budget = min(remaining_5h_eq_1w, remaining_1w_eq)`

再计算：

```text
eta = remaining_budget / global_rate_in_1w_units_per_hour
```

也就是说，`ETA` 仍然是由更早耗尽的窗口决定，只是先把不同窗口、不同 plan 的剩余额度换算到统一单位后再计算。

如果只存在一个窗口数据，则直接使用该窗口对应的剩余量；两个窗口都无法计算时，ETA 显示为空。

## 5. 数据持久化

### 5.1 存储位置

在 `~/.codex-team/` 下新增一份轻量历史文件，例如：

```text
~/.codex-team/watch-quota-history.jsonl
```

使用 `jsonl` 追加写入，便于：

- 顺序追加
- 诊断和人工排查
- 未来做压缩或裁剪时保持简单

### 5.2 记录字段

每条记录至少包含：

- `recorded_at`
- `account_name`
- `account_id`
- `identity`
- `plan_type`
- `available`
- `five_hour.used_percent`
- `five_hour.reset_at`
- `one_week.used_percent`
- `one_week.reset_at`
- `source`

其中：

- `source` 固定为 `watch`
- `recorded_at` 是本地写入时刻
- quota 字段使用 `watch` 当次读到的最新值

### 5.3 写入规则

只有 `codexm watch` 写入这份历史。

为避免无意义刷盘，满足以下任一条件才追加一条新记录：

- quota 百分比发生变化
- `reset_at` 发生变化
- `available` 状态发生变化
- 距离上次写入已超过最小保底间隔

建议最小保底间隔为 `60 秒`。这样即便长期空闲，也能保留稀疏但连续的时间轴。

### 5.4 历史保留

为控制文件体积，历史只需要支撑 ETA 所需的回看窗口。

建议保留最近 `14 天` 数据；更早记录在新写入时顺手裁剪，或在读取时忽略。

本次实现优先保证“读取时忽略过旧记录”，是否同时做文件物理裁剪可以作为实现细节决定，不额外暴露用户选项。

## 6. 速率计算

### 6.1 总原则

速率使用统一的 `plus 1W` 等价单位，表示为“每小时消耗多少 plus 周额度等价量”。

也就是说：

- `1W` 先按 plan 的周额度 profile 归一化
- `5H` 先按 plan 的 `5H` 容量 profile 归一化，再换算成 `plus 1W` 单位

实现上集中维护一张 plan profile 表：

| plan | `5H` 容量（plus=1） | `1W` 容量（plus=1） |
| --- | ---: | ---: |
| `plus` | 1 | 1 |
| `prolite` | 5 | 4.165 |
| `pro` | 10 | 8.33 |
| `team` | 1 | 1 |
| `unknown` | 1 | 1 |

换算规则：

```text
five_hour_equivalent_in_plus_weekly_units =
  five_hour_percent * plan.five_hour_capacity_in_plus_units / 8

one_week_equivalent_in_plus_weekly_units =
  one_week_percent * plan.one_week_capacity_in_plus_units
```

全局速率定义为：

```text
rate_per_hour = delta_used_percent_in_1w_units / delta_hours
```

### 6.2 样本过滤

只使用满足以下条件的记录：

- `source = watch`
- 至少有一个窗口的 `used_percent` 和 `reset_at` 完整
- 时间戳有效

速率计算不再直接对每一对相邻样本分别求增量，而是先按“连续 burn 段”分段。

一段连续样本需要同时满足：

- 属于同一账号
- `plan_type` 不变
- `five_hour.used_percent` 不下降
- `one_week.used_percent` 不下降

`reset_at` 只作为辅助信号，不再要求严格字符串相等。

- `reset_at` 在 `±1 分钟` 内波动，视为同一窗口的时间戳抖动
- 如果 `used_percent` 回落，说明观察到了 reset，必须开始新的连续段
- 如果账号或 `plan_type` 变化，也必须开始新的连续段

对每个连续段，只看该段首尾两点，分别得到：

- `delta_5h_eq_1w`
- `delta_1w`

其中：

- `5H` 增量来自该连续段首尾 `five_hour.used_percent` 的差值
- `1W` 增量来自该连续段首尾 `one_week.used_percent` 的差值

之所以可以直接取首尾差值，是因为分段阶段已经保证这一段内没有观察到 reset。

对于同一连续段，最终增量采用更保守的瓶颈语义：

```text
delta_in_1w_units = max(delta_5h_eq_1w, delta_1w)
```

理由是：

- 两个窗口都在反映同一份真实消耗
- `1W` 更新粒度通常比 `5H` 更粗，逐对相邻样本会被离散跳变放大或低估
- 观测数据存在量化误差、刷新时序差和不同窗口的离散化差异
- 先按连续段累计，再取更大的那个增量，更接近“这一整段真实至少消耗了多少”
- `reset_at` 抖动不会再把同一段连续 burn 错切成许多碎片

### 6.3 回看窗口

默认使用单一回看窗口：

- 回看最近 `60 分钟`

原因：

- 该速率服务的是“当前正在运行时”的全局使用强度
- 更短的窗口能更快反映近期压力变化
- 现有 `watch` 的用途也是围绕短期运行时调度

### 6.4 计算方式

对回看区间内所有有效连续段，计算：

- 每段的总消耗增量（统一到 `1W` 等价单位）
- 每段的总经过时长

然后按总量法得到全局速率：

```text
global_rate_in_1w_units_per_hour =
  sum(segment_delta_in_1w_units) / sum(segment_delta_hours)
```

如果总经过时长为 `0`，或没有可用连续段，则该全局速率为空。

### 6.5 低活跃与空闲

如果全局速率计算结果为 `0`，说明在回看窗口内几乎没有发生消耗。

此时不应显示“无限久”，而应显示为：

- 默认列：`idle`
- 详细字段：保留速率为 `0`

这样既能表达“当前空闲”，又不会误导为真正无限配额。

## 7. ETA 计算与展示

### 7.1 剩余额度

每个账号的剩余额度仍按当前 quota 直接计算：

- `remaining_5h = 100 - five_hour.used_percent`
- `remaining_1w = 100 - one_week.used_percent`
- `remaining_5h_eq_1w = normalize_5h_to_plus_weekly_units(remaining_5h, plan_type)`
- `remaining_1w_eq = normalize_1w_to_plus_weekly_units(remaining_1w, plan_type)`

最终用于 ETA 的剩余额度是：

```text
remaining_budget = min(remaining_5h_eq_1w, remaining_1w_eq)
```

如果某个窗口缺值，则只使用另一个窗口。

### 7.2 ETA 语义

每个账号的 ETA 都复用同一套全局速率，不做账号个性化校准。

例如：

- 当前活跃账号观测到每小时消耗 `6` 个 `plus 1W` 等价单位
- 某个 `pro` 备选账号当前还有 `80%` 的 `5H` 剩余
- 它的 `5H` 等价剩余约为 `80 * 10 / 8 = 100`
- 若它的 `1W` 剩余是 `50%`，则其周额度等价剩余约为 `50 * 8.33 = 416.5`

则瓶颈是 `100`，最终 ETA 约为 `16.7 小时`

这符合产品语义：

- 预测的是“如果接下来继续按当前这台机器上的使用节奏跑，这个账号能撑多久”

### 7.3 默认输出

`codexm list` 默认新增一列：

- `ETA`

展示规则：

- 可算出最终 ETA：显示人类可读时长，例如 `43m`、`3.8h`、`2.1d`
- 当前账号或目标账号已不可用：显示 `unavailable`
- 有 quota 但当前全局速率为 `0`：显示 `idle`
- 历史不足或字段不足：显示 `-`

### 7.4 verbose 输出

`codexm list --verbose` 额外新增以下字段：

- `ETA`
- `ETA 5H->1W`
- `ETA 1W`
- `RATE 1W UNITS`
- `5H REMAIN->1W`

这些字段用于解释最终 ETA 的来源，便于判断：

- 是 `5H` 桶先卡住
- 还是 `1W` 桶先卡住
- 当前预测是否受近期突发流量影响

## 8. 模块边界

### 8.1 watch 历史读写模块

建议新增单独模块，例如：

- `src/watch/history.ts`

职责：

- 追加历史记录
- 读取最近历史
- 过滤无效样本
- 计算全局速率
- 根据 quota 与速率计算 ETA

这样可以避免把历史读写和预测逻辑直接塞进：

- `src/main.ts`
- `src/cli/quota.ts`

### 8.2 CLI 层职责

CLI 层只负责：

- 在 `watch` 收到 quota 更新时调用历史追加接口
- 在 `list` 组装表格时调用 ETA 计算接口

CLI 层不直接处理历史文件格式，也不直接实现预测算法。

### 8.3 与现有 score 的关系

本次 ETA 设计不替换现有：

- 当前实现中的 `PLUS SCORE`
- 当前实现中的 `1H PLUS SCORE`

二者可以同时存在：

- `score` 继续服务自动切换与排序语义
- `ETA` 负责服务用户的直观时间判断

注：

- 这份文档形成于设计阶段，最终实现中的模块路径为 `src/watch/history.ts`
- list/verbose 表头后续已演进为 `PLUS SCORE` / `1H PLUS SCORE`

## 9. 失败处理与边界条件

### 9.1 历史不存在

如果机器上还没有 `watch` 历史：

- `list` 不报错
- ETA 显示为 `-`

### 9.2 历史不足

如果历史存在，但没有足够样本形成有效速率：

- ETA 显示为 `-`
- `--verbose` 中速率字段也显示为 `-`

### 9.3 当前账号已耗尽

如果某个账号当前已是 `unavailable`：

- ETA 直接显示 `unavailable`
- 不再尝试输出正向时长

### 9.4 长时间空闲

如果回看区间内没有任何消耗增长：

- ETA 显示 `idle`
- 不显示“∞”

### 9.5 窗口刚重置

当某个 quota 窗口刚刚 reset：

- 旧窗口记录自动断开
- 新窗口从新一段样本开始累计

系统不尝试跨窗口拼接出连续速率。

## 10. 测试范围

需要覆盖以下场景：

- `watch` 收到 quota 更新后正确写入历史
- quota 未变化时不会高频重复写入
- `reset_at` 变化后样本被正确分段
- `5H` 能按现有 plan 比例正确换算到 `1W` 单位
- 全局速率按统一 `1W` 单位正确计算
- 速率为 `0` 时显示 `idle`
- 没有历史或历史不足时显示 `-`
- 账号当前已不可用时显示 `unavailable`
- `list` 默认输出新增 `ETA`
- `list --verbose` 正确显示 `ETA 5H->1W`、`ETA 1W`、`RATE 1W UNITS`、`5H REMAIN->1W`
- 多账号场景下，同一全局速率被正确投影到各账号剩余额度上

## 11. 后续演进方向

本次设计刻意只做一条全局速率和单一 ETA。

未来如果需要增强，可以在不破坏本次设计的前提下扩展：

- 增加多档速率，例如 `15m / 1h / 24h`
- 在 `--verbose` 中显示高压预测与平均预测
- 把 ETA 接入 auto-switch 的提前预警逻辑
- 增加历史裁剪与导出命令

但这些都不属于本次范围。
