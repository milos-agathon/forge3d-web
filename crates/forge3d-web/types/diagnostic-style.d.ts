import { ValidationReport } from './diagnostics.js';
export interface DiagnosticStyleLayer {
    id?: string;
    type?: string;
    layer_type?: string;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    unsupported_paint_fields?: readonly string[];
    unsupported_layout_fields?: readonly string[];
}
/** Native support assessment only. Style evaluation and render mapping belong to W19. */
export declare function validateStyleSupport(style: {
    layers?: readonly DiagnosticStyleLayer[];
}): ValidationReport;
