import { DEFAULT_RULES, RULE_ABOUT, RULE_SOURCE, type RuleKey } from "@ebo/core";

/**
 * Starting rule rows. Every value starts "unverified": the app shows where it came from next to
 * each rule, and a person marks it verified once checked.
 */
export function globalRuleRows() {
  return (Object.keys(DEFAULT_RULES) as RuleKey[]).map((key) => ({
    workspaceId: null,
    key,
    value: DEFAULT_RULES[key] as unknown,
    description: RULE_ABOUT[key],
    sourceTitle: RULE_SOURCE[key],
    status: "unverified" as const,
  }));
}
