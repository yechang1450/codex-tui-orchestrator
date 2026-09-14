# Plugin Eval Report: codex-tui-orchestrator

## At a Glance
- Score: 86/100
- Grade: B
- Risk: high
- Checks: 1 fail, 0 warn, 2 info
- Active budget: 1236 tokens (good)
- Observed usage: not supplied

## Why It Matters
- 1 failing error check are driving the highest-confidence problems.
- budget is the largest source of score loss at -14 points.
- Budget pressure is not the dominant issue right now.
- No observed usage is attached yet, so budget conclusions are still based on static estimates.

## Fix First
- [fail/error] deferred_cost_tokens is excessive relative to the current Codex baseline. Why: Budget pressure matters because always-loaded or frequently-loaded text can make the workflow feel expensive fast. Fix: Reduce repeated instruction text and move detail into deferred supporting files.

## Recommended Next Step
- Fix the top findings and rerun the report
- Why: A short pass on the highest-value findings will improve trust, readability, and the signal quality of future benchmarks.
- Chat request: "What should I fix first?"
- Local command: `plugin-eval start ~/.codex/plugins/codex-tui-orchestrator --request 'What should I fix first?' --format markdown`

## Details
<details>
<summary>Watch next</summary>

- No secondary findings queued.
</details>
<details>
<summary>Improvement brief</summary>

- Raise the evaluation from grade B (86/100) with a focus on the highest-signal structural and budget issues first.
- Goal: Reduce repeated instruction text and move detail into deferred supporting files.
- Measure: token-usage-observer
- Measure: task-outcome-scorecard
- Measure: tool-call-audit
- Suggested prompt: Use the skill-creator guidance to improve codex-tui-orchestrator. Keep the structure compact and move bulky details into references or scripts. Define success measures with these toolsets: token-usage-observer, task-outcome-scorecard, tool-call-audit. Address deferred_cost_tokens-budget-high: deferred_cost_tokens is excessive relative to the current Codex baseline.
</details>
<details>
<summary>Budgets and observed usage</summary>

- trigger_cost_tokens: 104 (good)
- invoke_cost_tokens: 1132 (good)
- deferred_cost_tokens: 2093251 (excessive)
- explicit_only_invoke_cost_tokens: 0 (good, unscored)
- total_tokens: 2094487 (excessive)

- No observed usage supplied.
</details>
<details>
<summary>Measurement plan</summary>

Combine cost, outcome, and trust signals so you can tell whether the skill or plugin is genuinely helping instead of only looking well-structured on paper.

- Token Usage Observer [high] Measure how many tokens the skill or plugin actually burns in representative runs. Signals: observed_usage_sample_count, observed_input_tokens_avg, observed_total_tokens_avg, estimate_vs_observed_input_ratio. Evidence: Responses API usage logs, Codex-like session exports, JSONL traces captured from local benchmarking harnesses.
- Task Outcome Scorecard [high] Measure whether the skill helps users finish the intended job with fewer retries and less cleanup. Signals: task_success_rate, first_pass_success_rate, retry_rate, human_override_rate. Evidence: Task run logs, Structured user acceptance checklist, Before/after comparison runs on the same prompts.
- Tool Call Audit [high] Check whether the agent uses the right tools, arguments, and sequencing when the skill is active. Signals: tool_call_success_rate, invalid_tool_argument_rate, recoverable_tool_failure_rate. Evidence: Tool invocation traces, Recorded sessions, Golden-path scenario replays.
- Latency And Efficiency [medium] Track whether the skill speeds users up enough to justify its cost. Signals: p50_time_to_first_acceptable_answer_seconds, p95_time_to_task_completion_seconds, tokens_per_successful_run. Evidence: Benchmark harness timings, Manual stopwatch runs on canonical tasks, Responses API timestamps combined with usage logs.
- Human Rubric Review [medium] Capture clarity, trust, and usefulness signals that automated checks will miss. Signals: clarity_score_avg, confidence_score_avg, follow_up_question_rate. Evidence: Reviewer scorecards, Team rubric sheets, Annotated transcripts.
</details>
<details>
<summary>Use From Codex Chat</summary>

Start with a natural chat request, then let plugin-eval show the exact local command sequence behind it.

Start with this chat request: "Evaluate this plugin."
Why this path: Plugin Eval recommended Evaluate Plugin from the current local state for this plugin.
Quick local entrypoint: plugin-eval start ~/.codex/plugins/codex-tui-orchestrator --request 'Evaluate this plugin.' --format markdown
Plugin Eval will run first: plugin-eval analyze ~/.codex/plugins/codex-tui-orchestrator --format markdown

Other chat requests you can use:
- Full Plugin Analysis: say "Give me a full analysis of this plugin, including benchmark setup." -> plugin-eval analyze ~/.codex/plugins/codex-tui-orchestrator --format markdown
- Evaluate Plugin: say "Evaluate this plugin." -> plugin-eval analyze ~/.codex/plugins/codex-tui-orchestrator --format markdown
- Explain Token Budget: say "Explain the token budget for this plugin." -> plugin-eval explain-budget ~/.codex/plugins/codex-tui-orchestrator --format markdown
- Measure Real Token Usage: say "Measure the real token usage of this plugin." -> plugin-eval init-benchmark ~/.codex/plugins/codex-tui-orchestrator
- Benchmark With Starter Scenarios: say "Help me benchmark this plugin." -> plugin-eval init-benchmark ~/.codex/plugins/codex-tui-orchestrator
- Start Here: say "What should I run next?" -> plugin-eval analyze ~/.codex/plugins/codex-tui-orchestrator --format markdown
</details>
<details>
<summary>Checks</summary>

- [FAIL] deferred_cost_tokens-budget-high: deferred_cost_tokens is excessive relative to the current Codex baseline. Evidence: Value: 2093251 tokens Baseline samples: skills=1, plugins=60 Remediation: Reduce repeated instruction text and move detail into deferred supporting files.
- [INFO] coverage-artifacts-unavailable: No coverage artifacts were found for this target. Evidence: . Remediation: Generate `lcov.info`, `coverage.xml`, or an Istanbul coverage JSON file if you want coverage scoring.
</details>
<details>
<summary>Metrics</summary>

- skill:codex-tui-orchestrator:skill_line_count: 44 lines (good)
- skill:codex-tui-orchestrator:description_length_chars: 237 chars (good)
- skill:codex-tui-orchestrator:relative_link_count: 2 links (good)
- skill:codex-tui-orchestrator:code_fence_count: 0 blocks (good)
- skill:codex-tui-orchestrator:support_file_count: 3 files (good)
- plugin_skill_count: 1 skills (good)
- plugin_keyword_count: 6 keywords (good)
- plugin_default_prompt_count: 2 prompts (good)
- trigger_cost_tokens: 104 tokens (good)
- invoke_cost_tokens: 1132 tokens (good)
- deferred_cost_tokens: 2093251 tokens (excessive)
- explicit_only_invoke_cost_tokens: 0 tokens (good)
- coverage_artifact_count: 0 files (info)
</details>
<details>
<summary>Score details</summary>

- Starting score: 100
- Total deductions: -14.25
- Final score: 86
- Risk: Contains 1 failing error check (deferred_cost_tokens-budget-high).

- -14 points: deferred_cost_tokens-budget-high [fail/error] deferred_cost_tokens is excessive relative to the current Codex baseline.
- -0.25 points: coverage-artifacts-unavailable [info/info] No coverage artifacts were found for this target.

- budget: -14 points across 1 check
- coverage: -0.25 points across 1 check
</details>
