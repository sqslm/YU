# 语 YU · V2 150 题自动化验收测试包

**适用范围**：Windows「语 YU」右 Alt 统一入口；当前测试集依据公开给出的功能清单与历史 100 题整理，**不意味着这些功能已验证实现**。

## 文件

- `YU_V2_150_test_plan.md`：150 条完整人类可读用例，包含输入、期望动作、前提、判定证据、清理方案。
- `YU_V2_150_cases.json`：机器可读用例，推荐作为 Codex 测试执行的唯一数据源。
- `YU_V2_150_cases.csv`：UTF-8 BOM 编码，便于在 Windows Excel 中筛选；**不包含执行结果**。
- `YU_V2_results.template.json`：150 条初始 `NOT_RUN`，供实际测试填充。
- `CODEX_自动自测提示词.md`：可直接复制给 Codex 的执行指令。
- `tools/validate_suite.py`：验证 JSON 结构、数量、模块覆盖、IDs，以及记忆功能排除。
- `tools/report_results.py`：把真实运行结果生成统计及按模块的 Markdown 报告；不会代跑任何用例。

## 推荐执行

1. 将本压缩包解压到 **语 YU 项目根目录下一个独立 `tests/yu-v2/` 文件夹**，不要覆盖项目现有文件。
2. 在项目实际环境中运行：`python tests/yu-v2/tools/validate_suite.py`。
3. 将 `CODEX_自动自测提示词.md` 交给 Codex，让它检查仓库并使用 JSON 用例完成“能自动的先自动，不能自动的如实登记”。
4. Codex 将结果写成自己的 `YU_V2_results.json`（不得覆盖模板），每个 `PASS` 或 `FAIL` 必须有可核查的 evidence。
5. 运行：`python tests/yu-v2/tools/report_results.py tests/yu-v2/YU_V2_results.json`。默认在同目录生成 Markdown 报告。

## 状态

`PASS` 真正验证通过；`FAIL` 已复现失败；`NOT_IMPLEMENTED` 仓库确认未实现；`ENV_BLOCKED` 缺设备/环境/凭据；`MANUAL_REQUIRED` 需要人验证声音或 GUI；`NOT_RUN` 未执行。

**禁止**对真实用户文件执行破坏性操作，禁止未经授权截图/读取隐私或真实发信，禁止硬编码本次题目，禁止虚报成功。**长期记忆系统完全排除**。
