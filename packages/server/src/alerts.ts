import type { AlertRule, Comparator, MetricsSample } from "@rmm/shared";
import type { Store } from "./store.js";

function compare(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

const COMPARATOR_TEXT: Record<Comparator, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * Evaluates a fresh metrics sample against all enabled alert rules and raises
 * alerts for any that cross their threshold. De-duplicates so a sustained
 * breach produces one open alert rather than one per heartbeat.
 *
 * Returns the number of new alerts raised.
 */
export function evaluateRules(
  store: Store,
  deviceId: string,
  hostname: string,
  sample: MetricsSample
): number {
  let raised = 0;
  for (const rule of store.listAlertRules()) {
    if (!rule.enabled) continue;
    if (rule.deviceId !== null && rule.deviceId !== deviceId) continue;

    const value = sample[rule.metric];
    if (typeof value !== "number") continue;
    if (!compare(value, rule.comparator, rule.threshold)) continue;

    // Suppress duplicates while an alert for this rule+device is still open.
    if (store.hasOpenAlert(rule.id, deviceId)) continue;

    store.createAlert({
      ruleId: rule.id,
      deviceId,
      severity: rule.severity,
      message: formatMessage(rule, hostname, value),
      value,
    });
    raised += 1;
  }
  return raised;
}

function formatMessage(rule: AlertRule, hostname: string, value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${hostname}: ${rule.metric} is ${rounded} (${COMPARATOR_TEXT[rule.comparator]} ${rule.threshold})`;
}
