"""`make eval-live`: run the eval cases against the real model within OPS_AGENT_BUDGET_USD.

Never runs in CI. The API key is read by the Anthropic SDK from ANTHROPIC_API_KEY; this script
never reads, prints or forwards it. Exit status is non-zero when any case fails or the budget
stops the run early.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import anthropic
from meridian_ops_agent.budget import Budget, BudgetExhausted
from meridian_ops_agent.evalkit import EvalOutcome, load_cases, outcome_summary, run_case
from meridian_ops_agent.live import AnthropicLLM

CASES_DIR = Path(__file__).resolve().parent / "cases"


def main() -> int:
    if os.environ.get("CI"):
        print("eval-live never runs in CI (tests use the scripted fake)", file=sys.stderr)
        return 2
    budget = Budget.from_env()
    llm = AnthropicLLM.from_env(anthropic.Anthropic(), budget)
    cases = load_cases(CASES_DIR)
    print(f"model={llm.model} budget_usd={budget.limit_usd} spent_usd={budget.spent_usd}")

    outcomes: list[EvalOutcome] = []
    stopped_early = False
    for case in cases:
        try:
            outcomes.append(run_case(case, llm, scripted=False))
        except BudgetExhausted as exc:
            print(f"budget stop before {case.id}: {exc}", file=sys.stderr)
            stopped_early = True
            break
    print(outcome_summary(outcomes))
    failed = [o.case_id for o in outcomes if not o.passed]
    print(
        f"passed={len(outcomes) - len(failed)} failed={len(failed)} "
        f"ran={len(outcomes)}/{len(cases)} spent_usd={budget.spent_usd}"
    )
    return 1 if failed or stopped_early else 0


if __name__ == "__main__":
    sys.exit(main())
