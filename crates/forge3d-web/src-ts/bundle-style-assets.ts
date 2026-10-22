import type { SceneStateInput } from './scene-review.js';
import { StyleSpec } from './map-style.js';
import { ValidationReport } from './diagnostics.js';

/** Opaque streamed-source intent still needs a support diagnostic in plain archives. */
export function assessBundleStyle(state: SceneStateInput): void {
    if (!state.style) return;
    const previous = new ValidationReport(state.validationReport ?? {}).toJSON(), assessed = new StyleSpec(state.style).validate().toJSON();
    const diagnostics = [...new Map([...previous.diagnostics, ...assessed.diagnostics].map(d => [JSON.stringify(d), d])).values()];
    const summaries = [...new Map([...assessed.layer_summaries, ...previous.layer_summaries].map(s => [s.layer_id, s])).values()];
    const report = new ValidationReport({ ...previous, diagnostics, layer_summaries: summaries, supported_features: { ...previous.supported_features, ...assessed.supported_features }, unsupported_features: { ...previous.unsupported_features, ...assessed.unsupported_features } });
    state.validationReport = report.toJSON();
    if (report.hasErrors) state.reviewRecord = { renderable: false, render_status: 'blocked_by_diagnostics', last_render: null };
}
