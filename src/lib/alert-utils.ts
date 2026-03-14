/** Due-date alert system utilities */

export type AlertLevel = "none" | "warning" | "critical";

export interface AlertConfig {
  enabled: boolean;
  warningDays: number;
  criticalDays: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: true,
  warningDays: 7,
  criticalDays: 3,
};

/** Extract alert configuration from project settings JSON */
export function getAlertConfig(settings: Record<string, unknown> | null | undefined): AlertConfig {
  if (!settings) return DEFAULT_ALERT_CONFIG;
  return {
    enabled: settings.dueDateAlertsEnabled !== false,
    warningDays:
      typeof settings.dueDateWarningDays === "number" ? settings.dueDateWarningDays : DEFAULT_ALERT_CONFIG.warningDays,
    criticalDays:
      typeof settings.dueDateCriticalDays === "number" ? settings.dueDateCriticalDays : DEFAULT_ALERT_CONFIG.criticalDays,
  };
}

/** Compute the alert level for a task based on its due date and status */
export function getAlertLevel(
  dueDate: Date | string,
  statusCategory: string | undefined,
  alertAcknowledged: boolean,
  config: AlertConfig
): AlertLevel {
  if (!config.enabled) return "none";
  if (alertAcknowledged) return "none";
  if (statusCategory === "done" || statusCategory === "cancelled") return "none";

  const now = new Date();
  const due = new Date(dueDate);
  const daysLeft = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysLeft <= config.criticalDays) return "critical";
  if (daysLeft <= config.warningDays) return "warning";
  return "none";
}
