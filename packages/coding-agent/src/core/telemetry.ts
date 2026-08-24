import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * mcpi sends no telemetry of its own. This setting only controls whether outbound
 * model requests carry attribution headers identifying mcpi as the calling client
 * (see `provider-attribution.ts`); some providers use those headers for billing
 * origin or client identification.
 */
export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.MCPI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
