/** Stable native diagnostics contract with strict, deterministic JSON serialization. */
export declare const SEVERITIES: readonly ["info", "warning", "error", "fatal"];
export declare const SUPPORT_LEVELS: readonly ["supported", "underdeveloped", "missing", "Pro-gated", "placeholder/fallback", "experimental", "unsupported", "non-goal"];
export type DiagnosticSeverity = typeof SEVERITIES[number];
export type SupportLevel = typeof SUPPORT_LEVELS[number];
export type ValidationStatus = 'ok' | Exclude<DiagnosticSeverity, 'info'>;
export type RenderFailurePolicyValue = 'continue_on_warning' | 'fail_on_warning';
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare class RenderFailurePolicy {
    static readonly CONTINUE_ON_WARNING = "continue_on_warning";
    static readonly FAIL_ON_WARNING = "fail_on_warning";
    static validate(policy: string): RenderFailurePolicyValue;
}
export declare class SeverityPolicy {
    static validate(value: string): DiagnosticSeverity;
    static statusFor(values: readonly string[]): ValidationStatus;
    static renderBlocked(status: string, policy?: string): boolean;
}
export declare function supportLevel(value: string): SupportLevel;
/** Reject unsupported values, cycles, non-finite numbers and prototypes instead of losing data. */
export declare function canonicalJson(value: unknown, seen?: Set<object>): JsonValue;
export declare function stableDiagnosticJson(value: unknown): string;
export interface DiagnosticInput {
    code: string;
    severity: DiagnosticSeverity;
    message: string;
    remediation: string;
    support_level?: SupportLevel | null;
    layer_id?: string | null;
    object_id?: string | null;
    details?: Record<string, unknown>;
}
export interface DiagnosticData extends Required<Omit<DiagnosticInput, 'details'>> {
    details: Record<string, JsonValue>;
}
export declare class Diagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly remediation: string;
    readonly support_level: SupportLevel | null;
    readonly layer_id: string | null;
    readonly object_id: string | null;
    readonly details: Record<string, JsonValue>;
    constructor(input: DiagnosticInput);
    toJSON(): DiagnosticData;
    static fromJSON(input: DiagnosticInput): Diagnostic;
}
export interface LayerSummaryInput {
    layer_id: string;
    layer_type: string;
    support_level: SupportLevel;
    diagnostic_codes?: readonly string[];
    object_count?: number | null;
    bounds?: readonly number[] | null;
    memory_estimate_bytes?: number | null;
    details?: Record<string, unknown>;
}
export declare class LayerSummary {
    readonly layer_id: string;
    readonly layer_type: string;
    readonly support_level: SupportLevel;
    readonly diagnostic_codes: string[];
    readonly object_count: number | null;
    readonly bounds: number[] | null;
    readonly memory_estimate_bytes: number | null;
    readonly details: Record<string, JsonValue>;
    constructor(input: LayerSummaryInput);
    toJSON(): Required<LayerSummaryInput>;
    static fromJSON(input: LayerSummaryInput): LayerSummary;
}
export interface SupportMatrixEntryInput {
    area: string;
    capability: string;
    support_level: SupportLevel;
    scope: string;
    limitations?: readonly string[];
    diagnostic_codes?: readonly string[];
    remediation?: string;
    evidence?: readonly string[];
}
export declare class SupportMatrixEntry {
    readonly area: string;
    readonly capability: string;
    readonly support_level: SupportLevel;
    readonly scope: string;
    readonly limitations: string[];
    readonly diagnostic_codes: string[];
    readonly remediation: string;
    readonly evidence: string[];
    constructor(input: SupportMatrixEntryInput);
    toJSON(): Required<SupportMatrixEntryInput>;
    static fromJSON(input: SupportMatrixEntryInput): SupportMatrixEntry;
}
export interface ValidationReportInput {
    diagnostics?: readonly (Diagnostic | DiagnosticInput)[];
    layer_summaries?: readonly (LayerSummary | LayerSummaryInput)[];
    estimated_gpu_memory_bytes?: number | null;
    supported_features?: Record<string, SupportLevel>;
    unsupported_features?: Record<string, SupportLevel>;
    status?: ValidationStatus;
}
export interface ValidationReportData {
    status: ValidationStatus;
    diagnostics: DiagnosticData[];
    layer_summaries: Required<LayerSummaryInput>[];
    estimated_gpu_memory_bytes: number | null;
    supported_features: Record<string, SupportLevel>;
    unsupported_features: Record<string, SupportLevel>;
    render_blocked: boolean;
}
export declare class ValidationReport {
    readonly diagnostics: readonly Diagnostic[];
    readonly layer_summaries: readonly LayerSummary[];
    readonly status: ValidationStatus;
    readonly estimated_gpu_memory_bytes: number | null;
    readonly supported_features: Record<string, SupportLevel>;
    readonly unsupported_features: Record<string, SupportLevel>;
    constructor(input?: ValidationReportInput);
    get hasErrors(): boolean;
    renderBlocked(policy?: RenderFailurePolicyValue): boolean;
    toJSON(): ValidationReportData;
    static fromJSON(input: ValidationReportInput | string): ValidationReport;
}
