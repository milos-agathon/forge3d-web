/** Stable native diagnostics contract with strict, deterministic JSON serialization. */
export const SEVERITIES = ['info', 'warning', 'error', 'fatal'] as const;
export const SUPPORT_LEVELS = ['supported', 'underdeveloped', 'missing', 'Pro-gated', 'placeholder/fallback', 'experimental', 'unsupported', 'non-goal'] as const;
export type DiagnosticSeverity = typeof SEVERITIES[number];
export type SupportLevel = typeof SUPPORT_LEVELS[number];
export type ValidationStatus = 'ok' | Exclude<DiagnosticSeverity, 'info'>;
export type RenderFailurePolicyValue = 'continue_on_warning' | 'fail_on_warning';
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
const rank = { ok: 0, info: 0, warning: 1, error: 2, fatal: 3 };
export class RenderFailurePolicy {
    static readonly CONTINUE_ON_WARNING = 'continue_on_warning';
    static readonly FAIL_ON_WARNING = 'fail_on_warning';
    static validate(policy: string): RenderFailurePolicyValue {
        if (policy !== this.CONTINUE_ON_WARNING && policy !== this.FAIL_ON_WARNING)
            throw new TypeError(`Unknown render failure policy: ${policy}`);
        return policy;
    }
}
export class SeverityPolicy {
    static validate(value: string): DiagnosticSeverity {
        if (!(SEVERITIES as readonly string[]).includes(value))
            throw new TypeError(`Unknown diagnostic severity: ${value}`);
        return value as DiagnosticSeverity;
    }
    static statusFor(values: readonly string[]): ValidationStatus {
        let status: ValidationStatus = 'ok';
        for (const value of values) {
            const severity = this.validate(value);
            if (rank[severity] > rank[status])
                status = severity as ValidationStatus;
        }
        return status;
    }
    static renderBlocked(status: string, policy: string = RenderFailurePolicy.CONTINUE_ON_WARNING): boolean {
        RenderFailurePolicy.validate(policy);
        if (!['ok', 'warning', 'error', 'fatal'].includes(status))
            throw new TypeError(`Unknown validation status: ${status}`);
        return status === 'error' || status === 'fatal' || status === 'warning' && policy === RenderFailurePolicy.FAIL_ON_WARNING;
    }
}
export function supportLevel(value: string): SupportLevel {
    if (!(SUPPORT_LEVELS as readonly string[]).includes(value))
        throw new TypeError(`Unknown support level: ${value}`);
    return value as SupportLevel;
}
/** Reject unsupported values, cycles, non-finite numbers and prototypes instead of losing data. */
export function canonicalJson(value: unknown, seen = new Set<object>()): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'object' || value === null || seen.has(value))
        throw new TypeError('Value must be finite, acyclic JSON-serializable data');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
        throw new TypeError('Value must be JSON-serializable plain data');
    seen.add(value);
    try {
        if (Array.isArray(value))
            return value.map(item => canonicalJson(item, seen));
        const result: Record<string, JsonValue> = {};
        for (const key of Object.keys(value).sort())
            Object.defineProperty(result, key, { value: canonicalJson((value as Record<string, unknown>)[key], seen), enumerable: true });
        return result;
    }
    finally {
        seen.delete(value);
    }
}
export function stableDiagnosticJson(value: unknown): string { return JSON.stringify(canonicalJson(value)); }
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
export class Diagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly remediation: string;
    readonly support_level: SupportLevel | null;
    readonly layer_id: string | null;
    readonly object_id: string | null;
    readonly details: Record<string, JsonValue>;
    constructor(input: DiagnosticInput) {
        for (const key of ['code', 'message', 'remediation'] as const)
            if (typeof input[key] !== 'string' || !input[key])
                throw new TypeError(`Diagnostic ${key} must be nonempty`);
        this.code = input.code;
        this.message = input.message;
        this.remediation = input.remediation;
        this.severity = SeverityPolicy.validate(input.severity);
        this.support_level = input.support_level == null ? null : supportLevel(input.support_level);
        this.layer_id = input.layer_id ?? null;
        this.object_id = input.object_id ?? null;
        for (const id of [this.layer_id, this.object_id])
            if (id !== null && typeof id !== 'string')
                throw new TypeError('Diagnostic IDs must be strings');
        this.details = canonicalJson(input.details ?? {}) as Record<string, JsonValue>;
    }
    toJSON(): DiagnosticData { return { ...this, details: canonicalJson(this.details) as Record<string, JsonValue> }; }
    static fromJSON(input: DiagnosticInput): Diagnostic { return new Diagnostic(input); }
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
function count(value: number | null | undefined, name: string): number | null {
    if (value == null)
        return null;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${name} must be a nonnegative safe integer`);
    return value;
}
export class LayerSummary {
    readonly layer_id: string;
    readonly layer_type: string;
    readonly support_level: SupportLevel;
    readonly diagnostic_codes: string[];
    readonly object_count: number | null;
    readonly bounds: number[] | null;
    readonly memory_estimate_bytes: number | null;
    readonly details: Record<string, JsonValue>;
    constructor(input: LayerSummaryInput) {
        this.layer_id = input.layer_id;
        this.layer_type = input.layer_type;
        this.support_level = supportLevel(input.support_level);
        this.diagnostic_codes = [...input.diagnostic_codes ?? []].sort();
        this.object_count = count(input.object_count, 'object_count');
        this.memory_estimate_bytes = count(input.memory_estimate_bytes, 'memory_estimate_bytes');
        this.bounds = input.bounds == null ? null : [...input.bounds];
        if (this.bounds?.some(v => !Number.isFinite(v)))
            throw new TypeError('Bounds must be finite');
        this.details = canonicalJson(input.details ?? {}) as Record<string, JsonValue>;
    }
    toJSON(): Required<LayerSummaryInput> { return structuredClone({ ...this }); }
    static fromJSON(input: LayerSummaryInput): LayerSummary { return new LayerSummary(input); }
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
export class SupportMatrixEntry {
    readonly area: string;
    readonly capability: string;
    readonly support_level: SupportLevel;
    readonly scope: string;
    readonly limitations: string[];
    readonly diagnostic_codes: string[];
    readonly remediation: string;
    readonly evidence: string[];
    constructor(input: SupportMatrixEntryInput) {
        this.area = input.area;
        this.capability = input.capability;
        this.support_level = supportLevel(input.support_level);
        this.scope = input.scope;
        this.limitations = [...input.limitations ?? []].sort();
        this.diagnostic_codes = [...input.diagnostic_codes ?? []].sort();
        this.evidence = [...input.evidence ?? []].sort();
        this.remediation = input.remediation ?? '';
    }
    toJSON(): Required<SupportMatrixEntryInput> { return structuredClone({ ...this }); }
    static fromJSON(input: SupportMatrixEntryInput): SupportMatrixEntry { return new SupportMatrixEntry(input); }
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
function compare(a: readonly (string | number)[], b: readonly (string | number)[]): number {
    for (let i = 0; i < a.length; i++) {
        if (a[i]! < b[i]!)
            return -1;
        if (a[i]! > b[i]!)
            return 1;
    }
    return 0;
}
function diagnosticKey(d: Diagnostic): (string | number)[] { return [-rank[d.severity], d.code, d.layer_id ?? '', d.object_id ?? '', d.message, stableDiagnosticJson(d.details)]; }
function summary(input: Record<string, SupportLevel> = {}): Record<string, SupportLevel> {
    return Object.fromEntries(Object.keys(input).sort().map(k => [k, supportLevel(input[k]!)]));
}
export class ValidationReport {
    readonly diagnostics: readonly Diagnostic[];
    readonly layer_summaries: readonly LayerSummary[];
    readonly status: ValidationStatus;
    readonly estimated_gpu_memory_bytes: number | null;
    readonly supported_features: Record<string, SupportLevel>;
    readonly unsupported_features: Record<string, SupportLevel>;
    constructor(input: ValidationReportInput = {}) {
        this.diagnostics = (input.diagnostics ?? []).map(d => new Diagnostic(d)).sort((a, b) => compare(diagnosticKey(a), diagnosticKey(b)));
        this.layer_summaries = (input.layer_summaries ?? []).map(d => new LayerSummary(d)).sort((a, b) => compare([a.layer_id, a.layer_type, a.support_level], [b.layer_id, b.layer_type, b.support_level]));
        const derived = SeverityPolicy.statusFor(this.diagnostics.map(d => d.severity));
        if (input.status !== undefined)
            SeverityPolicy.renderBlocked(input.status);
        this.status = input.status !== undefined && rank[input.status] > rank[derived] ? input.status : derived;
        this.estimated_gpu_memory_bytes = count(input.estimated_gpu_memory_bytes, 'estimated_gpu_memory_bytes');
        this.supported_features = summary(input.supported_features);
        this.unsupported_features = summary(input.unsupported_features);
    }
    get hasErrors(): boolean { return this.status === 'error' || this.status === 'fatal'; }
    renderBlocked(policy: RenderFailurePolicyValue = RenderFailurePolicy.CONTINUE_ON_WARNING): boolean { return SeverityPolicy.renderBlocked(this.status, policy); }
    toJSON(): ValidationReportData { return { status: this.status, diagnostics: this.diagnostics.map(d => d.toJSON()), layer_summaries: this.layer_summaries.map(s => s.toJSON()), estimated_gpu_memory_bytes: this.estimated_gpu_memory_bytes, supported_features: { ...this.supported_features }, unsupported_features: { ...this.unsupported_features }, render_blocked: this.renderBlocked() }; }
    static fromJSON(input: ValidationReportInput | string): ValidationReport { return new ValidationReport(typeof input === 'string' ? JSON.parse(input) as ValidationReportInput : input); }
}
